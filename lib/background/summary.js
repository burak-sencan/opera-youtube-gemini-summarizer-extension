// Summary input builders and pending-request helpers

const pendingSummaryRequests = new Map()

function cleanupStalePendingRequests() {
  const now = Date.now()
  for (const [key, entry] of pendingSummaryRequests.entries()) {
    const startedAt = entry && Number(entry.startedAt)
    if (!Number.isFinite(startedAt) || now - startedAt > 90_000) {
      pendingSummaryRequests.delete(key)
    }
  }
}

function getSummaryRequestKey(msg, tabId) {
  const action = String((msg && msg.action) || '').trim()
  if (action !== 'summarize_content' && action !== 'summarize' && action !== 'summarize_url') return ''

  const ctx = msg && msg.context && typeof msg.context === 'object' ? msg.context : null
  const rawUrl = String((ctx && ctx.url) || (msg && msg.url) || '').trim()
  const rawVideoId = String((ctx && ctx.videoId) || (msg && msg.videoId) || '').trim()
  const normalizedUrl = typeof normalizeWatchUrl === 'function' ? normalizeWatchUrl(rawUrl, rawVideoId) : rawUrl
  const identity =
    rawVideoId ||
    (typeof getVideoIdFromUrl === 'function' ? getVideoIdFromUrl(normalizedUrl) : normalizedUrl) ||
    normalizedUrl
  if (!identity) return ''

  const tabIdentity = typeof tabId === 'number' ? String(tabId) : 'global'
  return `${tabIdentity}:${identity}`
}

function hasPendingSummaryRequest(key) {
  cleanupStalePendingRequests()
  return key ? pendingSummaryRequests.has(key) : false
}

function beginPendingSummaryRequest(key) {
  if (!key) return
  pendingSummaryRequests.set(key, { startedAt: Date.now() })
}

function endPendingSummaryRequest(key) {
  if (!key) return
  pendingSummaryRequests.delete(key)
}

function createDefaultSummaryInputMeta(inputText) {
  return {
    inputText: String(inputText || ''),
    hasTranscript: false,
    transcriptTruncated: false,
    titleLength: 0,
    descriptionLength: 0,
    transcriptLength: 0,
  }
}

function trimPromptSectionLocal(text, maxChars) {
  const value = String(text || '').trim()
  if (!value || value.length <= maxChars) return { text: value, truncated: false }
  return { text: `${value.slice(0, maxChars)}\n\n...(kısaltıldı)`, truncated: true }
}

function trimTranscriptForPrompt(text, maxChars) {
  const value = String(text || '').trim()
  if (!value || value.length <= maxChars) return { text: value, truncated: false }

  const splitMarker = '\n\n...(orta kisim kisaltildi)...\n\n'
  const budget = Math.max(0, maxChars - splitMarker.length)
  const headLen = Math.floor(budget * 0.62)
  const tailLen = Math.max(0, budget - headLen)

  const head = value.slice(0, headLen).trim()
  const tail = value.slice(Math.max(0, value.length - tailLen)).trim()
  if (!head || !tail) {
    return { text: `${value.slice(0, maxChars)}\n\n...(kısaltıldı)`, truncated: true }
  }

  return {
    text: `${head}${splitMarker}${tail}`,
    truncated: true,
  }
}

function buildSummaryInput(context) {
  const source = context && typeof context === 'object' ? context : {}
  const title = String(source.title || '').trim()
  const descriptionInfo =
    typeof trimPromptSection === 'function'
      ? trimPromptSection(source.description || '', 4000)
      : trimPromptSectionLocal(source.description || '', 4000)
  const transcriptInfo = trimTranscriptForPrompt(source.transcript || '', 28000)
  const parts = []

  if (title) parts.push(`Video Başlığı:\n${title}`)
  if (descriptionInfo.text) parts.push(`Video Açıklaması:\n${descriptionInfo.text}`)
  if (transcriptInfo.text) parts.push(`Video Transkripti:\n${transcriptInfo.text}`)
  else if (source.url) parts.push(`Video URL:\n${source.url}`)

  return {
    inputText: parts.join('\n\n').trim(),
    hasTranscript: transcriptInfo.text.length >= 120,
    transcriptTruncated: transcriptInfo.truncated,
    titleLength: title.length,
    descriptionLength: descriptionInfo.text.length,
    transcriptLength: transcriptInfo.text.length,
  }
}

function hasEnoughSummaryContent(summaryInputMeta) {
  const meta = summaryInputMeta && typeof summaryInputMeta === 'object' ? summaryInputMeta : {}
  if ((meta.transcriptLength || 0) >= 120) return true
  if ((meta.descriptionLength || 0) >= 240) return true
  return false
}

function normalizeSummaryFormat(value) {
  const mode = String(value || '')
    .trim()
    .toLowerCase()
  if (mode === 'detailed' || mode === 'detayli' || mode === 'detayli_ozet') return 'detailed'
  if (
    mode === 'summary' ||
    mode === 'ozet' ||
    mode === 'simple' ||
    mode === 'tldr_bullets' ||
    mode === 'bullets' ||
    mode === 'paragraph'
  )
    return 'summary'
  return 'summary'
}

function buildSummaryPromptLocal({ language, summaryFormat, inputText, hasTranscript, transcriptTruncated }) {
  const mode = normalizeSummaryFormat(summaryFormat)

  const commonRules = [
    '- Sadece verilen içerikte açıkça geçen bilgiye dayan.',
    '- Videoda geçmeyen kişi, şirket, hisse, emtia, kripto, kurum veya konu ekleme.',
    '- Belirsiz noktada tahmin üretme; emin değilsen kısa ve dürüst biçimde "veri yetersiz" de.',
    '- Konu başlığı saymakla yetinme; her başlıkta analistin yorumunu ve yönünü yaz.',
    '- "X ele alınıyor", "Y analiz ediliyor", "yorumu yapılıyor", "değerlendiriliyor" gibi boş/genel cümleler yazma.',
    '- Her varlık başlığında şu 4 unsuru ver: Görüş, Seviye, Koşul, Risk/Uyarı.',
    '- Seviye/sayı geçiyorsa aynen yaz (ör. 13.400, 12.400, 11.750).',
    '- Metne zaman damgası veya süre bilgisi ekleme; zaman/süre istemiyorum.',
    '- Düz metin yaz; gereksiz süs, jargon ve tekrar kullanma.',
  ]

  if (mode === 'summary') {
    return [
      `Aşağıdaki video içeriğini ${language} dilinde özetle.`,
      'Amaç: Kullanıcı videoyu izlemeden analistin ne düşündüğünü, hangi seviyeleri verdiğini ve hangi şartta hangi görüşe geçtiğini net görsün.',
      ...commonRules,
      '- Çıktı formatı, aşağıdaki sırayı aynen korusun:',
      '  1) 1 kısa giriş cümlesi',
      '  2) "İşte videonun ana başlıklarla özeti:" satırı',
      '  3) 4-6 numaralı ana bölüm',
      '  4) En sonda "Önemli Uyarılar" başlığı',
      '- Bölüm biçimi: "1. Başlık" satırı ve altında 2-4 satır.',
      '- Her satır biçimi: "Varlık/Konu: Görüş ... | Seviye ... | Koşul ... | Risk/Uyarı ...". Zaman veya süre eklemeyin.',
      '- Eğer bir varlık için net seviye verilmemişse "Seviye: belirtilmedi" yaz; başlığı boş bırakma.',
      '- Genel piyasa özeti yerine varlık bazlı net çıkarım ver.',
      hasTranscript
        ? '- Önceliği transkripte ver; başlık ve açıklamayı sadece bağlam desteği için kullan.'
        : '- Transkript yoksa/yetersizse bunu kısa ve dürüstçe belirt; sadece görünen metinden çıkarım yap.',
      transcriptTruncated
        ? '- Transkript kısaltıldıysa yalnızca görünen kısma dayanarak yaz ve bunu kısa biçimde hissettir.'
        : '',
      '',
      inputText,
    ].join('\n')
  }

  return [
    'Aşağıdaki YouTube içeriğini detaylı ama düzenli biçimde özetle.',
    `Yanıt dili: ${language}.`,
    'Amaç: Özet moduna göre daha derin çıktı üretmek; her varlık/konu için analistin görüşünü, verdiği seviyeyi ve koşullu senaryoyu ayrıştırmak.',
    ...commonRules,
    '- Çıktı formatı, aşağıdaki sırayı aynen korusun:',
    '  1) 1-2 cümlelik giriş',
    '  2) "İşte videonun ana başlıklarla özeti:" satırı',
    '  3) 6-9 numaralı ana bölüm (her bölümde 3-6 satır)',
    '  4) "Kanıtlar ve Örnekler" bölümü (en az 4 satır)',
    '  5) "Çıkarımlar ve Olası Senaryolar" bölümü (en az 3 satır)',
    '  6) "Aksiyon Alınabilir Notlar" bölümü (3-6 satır)',
    '- Bölüm içi satır biçimi: "Varlık/Konu: Görüş ... | Seviye ... | Koşul ... | Risk/Uyarı ...". Zaman veya süre bilgisi eklemeyin.',
    '- Videoda açıkça geçmeyen yeni başlık açma.',
    '- Uzatma veya tekrar yapma; yoğun, net ve somut kal.',
    hasTranscript
      ? '- Önceliği transkripte ver; başlık ve açıklamayı sadece destekleyici bağlam olarak kullan.'
      : '- Transkript yoksa veya yetersizse bunu kısa biçimde belirt; yalnızca görünen başlık/açıklama bilgisinden emin olduğun kadar çıkarım yap.',
    transcriptTruncated
      ? '- Transkript kısaltıldıysa sadece görünen bölümden sonuç çıkar ve bunu kısa biçimde hissettir.'
      : '',
    '',
    'İçerik:',
    inputText,
  ]
    .filter(Boolean)
    .join('\n')
}

function buildSummaryRequestPayload({ isGemini, language, summaryFormat, inputText, summaryInputMeta }) {
  const normalizedFormat = normalizeSummaryFormat(summaryFormat)
  if (isGemini) {
    const prompt =
      typeof buildSummaryPrompt === 'function'
        ? buildSummaryPrompt({
            language,
            summaryFormat: normalizedFormat,
            inputText,
            hasTranscript: summaryInputMeta.hasTranscript,
            transcriptTruncated: summaryInputMeta.transcriptTruncated,
          })
        : buildSummaryPromptLocal({
            language,
            summaryFormat: normalizedFormat,
            inputText,
            hasTranscript: summaryInputMeta.hasTranscript,
            transcriptTruncated: summaryInputMeta.transcriptTruncated,
          })
    return { contents: [{ role: 'user', parts: [{ text: prompt }] }] }
  }
  return { input: inputText, instructions: `Kısa ve anlaşılır şekilde özetle. Dil: ${language}` }
}

async function resolveSummaryInputFromMessage(msg) {
  let title = msg.title || ''
  let summaryInputMeta = createDefaultSummaryInputMeta('')
  let inputText = ''
  let summaryContext = { url: '', videoId: '', channelName: '', uploadDate: '' }

  if (msg.action === 'summarize_content' && msg.context) {
    let context = {
      url:
        typeof normalizeWatchUrl === 'function'
          ? normalizeWatchUrl((msg.context.url || '').trim(), (msg.context.videoId || '').trim())
          : (msg.context.url || '').trim(),
      videoId: (msg.context.videoId || '').trim(),
      title: (msg.context.title || '').trim(),
      channelName: (msg.context.channelName || '').trim(),
      uploadDate:
        typeof normalizeVideoUploadDate === 'function'
          ? normalizeVideoUploadDate(msg.context.uploadDate || '')
          : msg.context.uploadDate || '',
      description: (msg.context.description || '').trim(),
      transcript: (msg.context.transcript || '').trim(),
    }
    if (context.url && context.transcript.length < 120) {
      const fetchedContext = await fetchYouTubeVideoContext(context.url, context.title || title)
      context = mergeVideoContexts(context, fetchedContext)
    }
    title = context.title || title
    summaryInputMeta = buildSummaryInput(context)
    inputText = summaryInputMeta.inputText
    summaryContext = {
      url: context.url || '',
      videoId: context.videoId || '',
      channelName: context.channelName || '',
      uploadDate:
        typeof normalizeVideoUploadDate === 'function'
          ? normalizeVideoUploadDate(context.uploadDate || '')
          : context.uploadDate || '',
    }
  } else if (msg.action === 'summarize_url') {
    const context = await fetchYouTubeVideoContext(
      typeof normalizeWatchUrl === 'function' ? normalizeWatchUrl(msg.url || '', msg.videoId || '') : msg.url || '',
      msg.title || '',
    )
    title = context.title || title
    summaryInputMeta = buildSummaryInput(context)
    inputText = summaryInputMeta.inputText
    summaryContext = {
      url: context.url || '',
      videoId: context.videoId || '',
      channelName: context.channelName || '',
      uploadDate:
        typeof normalizeVideoUploadDate === 'function'
          ? normalizeVideoUploadDate(context.uploadDate || '')
          : context.uploadDate || '',
    }
  } else {
    inputText = String(msg.text || '')
    summaryInputMeta = createDefaultSummaryInputMeta(inputText)
  }

  return { title, inputText, summaryInputMeta, summaryContext }
}

// Expose globally
self.GSSummary = {
  getSummaryRequestKey,
  hasPendingSummaryRequest,
  beginPendingSummaryRequest,
  endPendingSummaryRequest,
  resolveSummaryInputFromMessage,
  buildSummaryRequestPayload,
  buildSummaryInput,
  hasEnoughSummaryContent,
  createDefaultSummaryInputMeta,
  normalizeSummaryFormat,
}

try {
  for (const k of Object.keys(self.GSSummary)) {
    if (typeof self.GSSummary[k] === 'function' && !self[k]) {
      self[k] = self.GSSummary[k]
    }
  }
} catch (e) {}
