// Background service worker (thin bootstrap)

try {
  importScripts(
    'lib/shared/video_id.js',
    'lib/background/fetch_with_timeout.js',
    'lib/background/analysis.js',
    'lib/background/gemini.js',
    'lib/background/video_context.js',
    'lib/background/summary.js',
  )
} catch (e) {
  /* ignore import errors */
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') {
    try {
      sendResponse({ ok: false, error: 'invalid-message' })
    } catch (e) {}
    return
  }

  const targetTabId =
    sender && sender.tab && typeof sender.tab.id === 'number'
      ? sender.tab.id
      : msg && typeof msg.tabId === 'number'
        ? msg.tabId
        : null

  const replyToTab = (payload) => {
    if (typeof targetTabId === 'number') chrome.tabs.sendMessage(targetTabId, payload)
  }

  // Analysis record CRUD
  if (msg.action === 'save_analysis') {
    ;(async () => {
      try {
        const rec = await insertAnalysisRecord(msg.record)
        sendResponse({ ok: true, record: rec })
      } catch (e) {
        sendResponse({ ok: false, error: e && e.message ? e.message : String(e) })
      }
    })()
    return true
  }

  if (msg.action === 'list_analyses') {
    ;(async () => {
      try {
        const records = await loadAnalysisRecords()
        sendResponse({ ok: true, records })
      } catch (e) {
        sendResponse({ ok: false, error: e && e.message ? e.message : String(e) })
      }
    })()
    return true
  }

  if (msg.action === 'update_analysis') {
    ;(async () => {
      try {
        const rec = await updateAnalysisRecord(msg.record)
        sendResponse({ ok: true, record: rec })
      } catch (e) {
        sendResponse({ ok: false, error: e && e.message ? e.message : String(e) })
      }
    })()
    return true
  }

  if (msg.action === 'delete_analysis') {
    ;(async () => {
      try {
        const deleted = await deleteAnalysisRecord(msg.id)
        sendResponse({ ok: true, deleted })
      } catch (e) {
        sendResponse({ ok: false, error: e && e.message ? e.message : String(e) })
      }
    })()
    return true
  }

  if (msg.action === 'open_dashboard') {
    try {
      chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') }, () => {
        const runtimeError = chrome.runtime.lastError
        if (runtimeError) {
          sendResponse({ ok: false, error: runtimeError.message || 'dashboard-open-failed' })
          return
        }
        sendResponse({ ok: true })
      })
    } catch (e) {
      sendResponse({ ok: false, error: e && e.message ? e.message : String(e) })
    }
    return true
  }

  // Analyze records via Gemini
  if (msg.action === 'analyze_records') {
    ;(async () => {
      try {
        const cfg = await storageGet(['apiKey', 'apiModel', 'language', 'modelRateLimitInfo'])
        const apiKey = String((cfg && cfg.apiKey) || '').trim()
        const userModelRaw = String((cfg && cfg.apiModel) || '').trim()
        const language = String((cfg && cfg.language) || 'Turkce')
        const rateLimitInfo =
          cfg && cfg.modelRateLimitInfo && typeof cfg.modelRateLimitInfo === 'object' ? cfg.modelRateLimitInfo : {}

        if (!apiKey) {
          sendResponse({ ok: false, error: 'API key girilmemis. Ayarlardan API key ekleyin.' })
          return
        }

        const rows = Array.isArray(msg.records) ? msg.records : []
        if (!rows.length) {
          sendResponse({ ok: false, error: 'Analiz icin en az bir kayit secin.' })
          return
        }

        const mode = normalizeAnalyzeMode(msg.mode)
        const packed = buildAnalysisInputText(rows, 42000)
        if (!packed.text) {
          sendResponse({ ok: false, error: 'Secili kayitlarda analiz edilecek yeterli ozet icerigi yok.' })
          return
        }

        const prompt = buildAnalyzePrompt({
          language,
          mode,
          customPrompt: String(msg.prompt || '').trim(),
          inputText: packed.text,
          includedCount: packed.includedCount,
          totalCount: packed.totalCount,
          truncated: packed.truncated,
        })

        const candidates = await buildModelCandidates({ apiKey, userModelRaw, rateLimitInfo })
        const payload = { contents: [{ role: 'user', parts: [{ text: prompt }] }] }

        const analysis = await summarizeWithCandidates({ candidates, apiKey, payload, isGemini: true, maxAttempts: 3 })

        sendResponse({
          ok: true,
          analysis,
          mode,
          modeLabel: getAnalyzeModeDefinition(mode).label,
          includedCount: packed.includedCount,
          totalCount: packed.totalCount,
          truncated: packed.truncated,
        })
      } catch (e) {
        sendResponse({ ok: false, error: e && e.message ? e.message : String(e) })
      }
    })()
    return true
  }

  if (msg.action === 'list_models') {
    ;(async () => {
      try {
        const apiKey = ((msg && msg.apiKey) || '').trim()
        if (!apiKey) {
          sendResponse({ ok: false, error: 'API key boş.' })
          return
        }
        const models = await getModelList(apiKey)
        sendResponse({ ok: true, models })
      } catch (e) {
        sendResponse({ ok: false, error: e && e.message ? e.message : String(e) })
      }
    })()
    return true
  }

  // Summarize flows
  if (msg.action === 'summarize_content' || msg.action === 'summarize' || msg.action === 'summarize_url') {
    const requestKey = getSummaryRequestKey(msg, targetTabId)
    if (requestKey && hasPendingSummaryRequest(requestKey)) {
      sendResponse({ ok: true, deduped: true })
      return true
    }
    beginPendingSummaryRequest(requestKey)

    chrome.storage.local.get(['apiKey', 'apiModel', 'language', 'summaryFormat', 'modelRateLimitInfo'], async (cfg) => {
      try {
        const apiKey = (cfg.apiKey || '').trim()
        const userModelRaw = (cfg.apiModel || '').trim()
        const language = cfg.language || 'Türkçe'
        const summaryFormatRaw = String(cfg.summaryFormat || 'summary').trim()
        const summaryFormat =
          typeof normalizeSummaryFormat === 'function'
            ? normalizeSummaryFormat(summaryFormatRaw)
            : summaryFormatRaw === 'detailed'
              ? 'detailed'
              : 'summary'
        const rateLimitInfo =
          cfg && cfg.modelRateLimitInfo && typeof cfg.modelRateLimitInfo === 'object' ? cfg.modelRateLimitInfo : {}

        if (!apiKey) {
          replyToTab({
            action: 'summaryResult',
            summary: 'API key girilmemiş. Uzantı seçeneklerinden API key ekleyin.',
            title: msg.title || '',
          })
          sendResponse({ ok: false, error: 'no-apiKey' })
          return
        }

        const candidates = await buildModelCandidates({ apiKey, userModelRaw, rateLimitInfo })
        const maxAttempts = 3

        const { title, inputText, summaryInputMeta, summaryContext } = await resolveSummaryInputFromMessage(msg)

        if (!inputText || !hasEnoughSummaryContent(summaryInputMeta)) {
          const noContentMessage =
            'Videonun özet çıkarılabilecek içeriği alınamadı. Sadece başlık/URL ile özet üretmiyorum. Lütfen videoyu açıp tekrar deneyin veya transkript bulunan bir video kullanın.'
          replyToTab({
            action: 'summaryResult',
            summary: noContentMessage,
            title: title || msg.title || '',
            requestId: msg.requestId,
          })
          sendResponse({ ok: false, error: 'insufficient-content' })
          return
        }

        const payload = buildSummaryRequestPayload({
          isGemini: true,
          language,
          summaryFormat,
          inputText,
          summaryInputMeta,
        })

        const summary = await summarizeWithCandidates({ candidates, apiKey, payload, isGemini: true, maxAttempts })

        replyToTab({
          action: 'summaryResult',
          summary,
          title: title || msg.title || '',
          requestId: msg.requestId,
          videoUrl: summaryContext.url || '',
          videoId: summaryContext.videoId || '',
          channelName: summaryContext.channelName || '',
          uploadDate: summaryContext.uploadDate || '',
        })
        sendResponse({ ok: true })
      } catch (err) {
        replyToTab({
          action: 'summaryResult',
          summary: 'Özetleme isteği başarısız: ' + (err && err.message ? err.message : String(err)),
          title: msg.title || '',
          requestId: msg.requestId,
        })
        sendResponse({ ok: false, error: String(err) })
      } finally {
        endPendingSummaryRequest(requestKey)
      }
    })
    return true
  }
})
