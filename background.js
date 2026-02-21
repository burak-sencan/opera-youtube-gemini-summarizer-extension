// Background service worker

// Cache disabled: clean up any previously stored cache data.
try{ chrome.storage?.local?.remove?.(['summaryCache']); }catch(e){}

function normalizeModelName(model){
  const m = (model || '').trim();
  if(!m) return '';
  if(m.startsWith('models/')) return m;
  return `models/${m}`;
}

function cleanModelId(modelName){
  const m = String(modelName || '').trim();
  return m.startsWith('models/') ? m.slice('models/'.length) : m;
}

function parseGeminiVersion(modelId){
  // Examples: gemini-2.5-flash, gemini-1.5-flash-latest
  const id = cleanModelId(modelId);
  const m = id.match(/gemini-(\d+)(?:\.(\d+))?/i);
  if(!m) return {major:-1, minor:-1};
  return {major: parseInt(m[1],10) || 0, minor: parseInt(m[2] || '0',10) || 0};
}

function modelVariantRank(modelId){
  const id = cleanModelId(modelId).toLowerCase();
  if(id.includes('flash')) return 3;
  if(id.includes('pro')) return 2;
  return 1;
}

function compareModelIdsNewestFirst(a, b){
  const va = parseGeminiVersion(a);
  const vb = parseGeminiVersion(b);
  if(va.major !== vb.major) return vb.major - va.major;
  if(va.minor !== vb.minor) return vb.minor - va.minor;
  const ra = modelVariantRank(a);
  const rb = modelVariantRank(b);
  if(ra !== rb) return rb - ra;
  return cleanModelId(a).localeCompare(cleanModelId(b));
}

function sortModelsNewestFirst(models){
  return (models || []).slice().sort((m1, m2)=> compareModelIdsNewestFirst(m1?.name || '', m2?.name || ''));
}

function isRateLimitErrorMessage(text){
  const t = String(text || '');
  return /rate\s*limit|quota|RESOURCE_EXHAUSTED|exceeded your current quota/i.test(t);
}

function parseQuotaLimitValue(text){
  const t = String(text || '');
  const m = t.match(/\blimit\s*:\s*(\d+)\b/i);
  if(!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

function parseRetryAfterSeconds(text){
  const t = String(text || '');
  const m = t.match(/retry\s+in\s+([0-9.]+)s/i);
  if(!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
}

async function markModelRateLimited(modelId, message){
  const id = cleanModelId(modelId);
  if(!id) return;
  const now = Date.now();
  const limitVal = parseQuotaLimitValue(message);
  const retrySec = parseRetryAfterSeconds(message);
  const isUnavailable = limitVal === 0;
  // If limit=0, treat as unavailable for this key (don't keep retrying this model).
  const untilTs = isUnavailable
    ? (now + 7 * 24 * 60 * 60 * 1000) // 7 days
    : (now + (retrySec ? Math.ceil(retrySec * 1000) : 60_000) + 250);
  try{
    chrome.storage.local.get(['modelRateLimitInfo'], (cfg)=>{
      const info = (cfg && cfg.modelRateLimitInfo && typeof cfg.modelRateLimitInfo === 'object') ? cfg.modelRateLimitInfo : {};
      info[id] = {
        untilTs,
        lastAt: now,
        unavailable: !!isUnavailable,
        message: String(message || '').slice(0, 500)
      };
      chrome.storage.local.set({modelRateLimitInfo: info}, ()=>{});
    });
  }catch(e){}
}

function isModelRateLimited(rateLimitInfo, modelId){
  const id = cleanModelId(modelId);
  const entry = rateLimitInfo && rateLimitInfo[id];
  if(entry && entry.unavailable) return true;
  return !!(entry && entry.untilTs && entry.untilTs > Date.now());
}

function buildGeminiGenerateContentEndpoint(apiKey, modelName, apiVersion){
  const key = encodeURIComponent(apiKey);
  const model = normalizeModelName(modelName);
  const v = apiVersion || 'v1beta';
  return `https://generativelanguage.googleapis.com/${v}/${model}:generateContent?key=${key}`;
}

async function listGeminiModels(apiKey){
  const key = encodeURIComponent(apiKey);
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`;
  const res = await fetch(url);
  const data = await res.json().catch(()=>({}));
  if(!res.ok){
    const msg = (data && data.error && data.error.message) ? data.error.message : JSON.stringify(data);
    throw new Error(msg || `HTTP ${res.status}`);
  }
  return Array.isArray(data.models) ? data.models : [];
}

async function listGeminiModelsV1(apiKey){
  const key = encodeURIComponent(apiKey);
  const url = `https://generativelanguage.googleapis.com/v1/models?key=${key}`;
  const res = await fetch(url);
  const data = await res.json().catch(()=>({}));
  if(!res.ok){
    const msg = (data && data.error && data.error.message) ? data.error.message : JSON.stringify(data);
    throw new Error(msg || `HTTP ${res.status}`);
  }
  return Array.isArray(data.models) ? data.models : [];
}

function pickBestModel(models){
  const supported = models.filter(m=>Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'));
  const gemini = supported.filter(m=>(m.name || '').includes('gemini'));
  const prefer = (pred)=> gemini.find(pred) || supported.find(pred);
  return (
    prefer(m=>(m.name||'').includes('flash')) ||
    prefer(m=>(m.name||'').includes('pro')) ||
    gemini[0] ||
    supported[0] ||
    null
  );
}

function extractGeminiText(data){
  try{
    const c = data && data.candidates && data.candidates[0];
    const parts = c && c.content && c.content.parts;
    if(Array.isArray(parts)){
      return parts.map(p=>p.text).filter(Boolean).join('\n').trim();
    }
  }catch(e){}
  return '';
}

function getVideoIdFromUrl(url){
  try{
    const u = new URL(url);
    return u.searchParams.get('v');
  }catch(e){
    return null;
  }
}


function buildFormatInstruction(summaryFormat){
  switch(summaryFormat){
    case 'detailed':
      return [
        '- Detaylı ve kapsamlı inceleme özeti yaz (mümkün olduğunca eksiksiz)',
        '- Yapı: Kısa bağlam (1-2 cümle) + Bölüm bölüm anlatım + Sonuç/çıkarımlar',
        '- Videodaki tüm ana fikirleri, önemli örnekleri, argümanları ve karşı argümanları dahil et',
        '- Önemli isimler, terimler, tarih/sayı/ölçü gibi verileri atlama; varsa madde madde listele',
        '- Adım adım süreç/akış anlatılıyorsa sırayı koru',
        '- Transkript/açıklama eksik veya "...(kısaltıldı)" ise bunu açıkça belirt ve sadece verilen içeriğe dayan'
      ].join('\n');
    case 'bullets':
      return [
        '- 6-10 madde ana fikir',
        '- Varsa önemli sayılar / iddialar',
        '- Gereksiz giriş yok'
      ].join('\n');
    case 'paragraph':
      return [
        '- Tek paragraf',
        '- 5-8 cümle',
        '- Net ve kısa'
      ].join('\n');
    case 'tldr_bullets':
    default:
      return [
        '- 1 cümle Kısa Özet ("TL;DR" yazma)',
        '- 6-10 madde ana fikir',
        '- Varsa önemli sayılar / iddialar'
      ].join('\n');
  }
}

// Auto-selected model cache (in-memory). Keeps the code simple while avoiding ListModels on every request.
let autoModelCache = {
  apiKey: '',
  modelName: '',
  apiVersion: '',
  ts: 0
};

let modelListCache = {
  apiKey: '',
  models: [],
  ts: 0
};

async function getModelList(apiKey){
  const now = Date.now();
  const cacheTtlMs = 60 * 60 * 1000; // 1 hour
  if(modelListCache.apiKey === apiKey && Array.isArray(modelListCache.models) && modelListCache.models.length && (now - modelListCache.ts) < cacheTtlMs){
    return modelListCache.models;
  }
  let models = [];
  try{
    models = await listGeminiModels(apiKey);
  }catch(e){
    models = await listGeminiModelsV1(apiKey);
  }
  const supported = (models || []).filter(m=>Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'));
  const sorted = sortModelsNewestFirst(supported);
  modelListCache = { apiKey, models: sorted, ts: now };
  return sorted;
}

function isValidModelId(model){
  const id = String(model || '').trim();
  if(!id) return true;
  // Allow either `gemini-...` or `models/gemini-...`
  const cleaned = id.startsWith('models/') ? id.slice('models/'.length) : id;
  return /^[a-z0-9][a-z0-9.-]*$/i.test(cleaned);
}

async function getAutoModel(apiKey, rateLimitInfo){
  const now = Date.now();
  const cacheTtlMs = 6 * 60 * 60 * 1000; // 6 hours
  if(autoModelCache.apiKey === apiKey && autoModelCache.modelName && autoModelCache.apiVersion && (now - autoModelCache.ts) < cacheTtlMs){
    return { modelName: autoModelCache.modelName, apiVersion: autoModelCache.apiVersion };
  }

  let apiVersion = 'v1beta';
  let models = [];
  try{
    models = await listGeminiModels(apiKey);
    apiVersion = 'v1beta';
  }catch(e){
    models = await listGeminiModelsV1(apiKey);
    apiVersion = 'v1';
  }

  const supported = (models || []).filter(m=>Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'));
  let best = pickBestModel(supported);
  let modelName = best && best.name ? best.name : 'gemini-1.5-flash-latest';

  // If the best model is currently rate-limited, pick the newest available non-limited model.
  if(rateLimitInfo && isModelRateLimited(rateLimitInfo, modelName)){
    const sorted = sortModelsNewestFirst(supported);
    const next = sorted.find(m=>m && m.name && !isModelRateLimited(rateLimitInfo, m.name));
    if(next && next.name) modelName = next.name;
  }

  autoModelCache = { apiKey, modelName, apiVersion, ts: now };
  return { modelName, apiVersion };
}


async function callEndpoint({endpoint, apiKey, payload, isGemini}){
  const headers = {'Content-Type':'application/json'};
  // For Google AI Studio API keys, do NOT use Authorization: Bearer; key should be query parameter.
  const res = await fetch(endpoint, {method:'POST', headers, body: JSON.stringify(payload)});
  const data = await res.json().catch(()=>({}));
  if(!res.ok){
    const errMsg = (data && (data.error && (data.error.message || JSON.stringify(data.error)))) || JSON.stringify(data);
    throw new Error(errMsg || `HTTP ${res.status}`);
  }
  if(isGemini){
    const text = extractGeminiText(data);
    return text || JSON.stringify(data);
  }
  return data.summary || data.result || (data.output && (data.output[0] && (data.output[0].content || data.output[0].text))) || JSON.stringify(data);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse)=>{
  if(!msg || typeof msg !== 'object'){
    try{ sendResponse({ok:false, error:'invalid-message'}); }catch(e){}
    return;
  }
  const targetTabId = (sender && sender.tab && typeof sender.tab.id === 'number')
    ? sender.tab.id
    : (msg && typeof msg.tabId === 'number' ? msg.tabId : null);

  const replyToTab = (payload)=>{
    if(typeof targetTabId === 'number') chrome.tabs.sendMessage(targetTabId, payload);
  };

  if(msg.action === 'list_models'){
    (async ()=>{
      try{
        const apiKey = ((msg && msg.apiKey) || '').trim();
        if(!apiKey){
          sendResponse({ok:false, error:'API key boş.'});
          return;
        }
        const models = await getModelList(apiKey);
        sendResponse({ok:true, models});
      }catch(e){
        sendResponse({ok:false, error: (e && e.message) ? e.message : String(e)});
      }
    })();
    return true;
  }

  if(msg.action === 'summarize_content' || msg.action === 'summarize' || msg.action === 'summarize_url'){
    chrome.storage.local.get(['apiKey','apiModel','language','summaryFormat','modelRateLimitInfo'], async (cfg)=>{
      try{
        const apiKey = (cfg.apiKey || '').trim();
        const userModelRaw = (cfg.apiModel || '').trim();
        const language = cfg.language || 'Türkçe';
        const summaryFormat = (cfg.summaryFormat || 'tldr_bullets').trim();
        const rateLimitInfo = (cfg && cfg.modelRateLimitInfo && typeof cfg.modelRateLimitInfo === 'object') ? cfg.modelRateLimitInfo : {};

        if(!apiKey){
          replyToTab({action:'summaryResult', summary:'API key girilmemiş. Uzantı seçeneklerinden API key ekleyin.', title: msg.title || ''});
          sendResponse({ok:false, error:'no-apiKey'});
          return;
        }

        let isGemini = true;

        const candidates = [];
        const addCandidate = (modelId, apiVersion)=>{
          const id = cleanModelId(modelId);
          if(!id) return;
          if(candidates.some(c=>c.modelId === id && c.apiVersion === apiVersion)) return;
          if(isModelRateLimited(rateLimitInfo, id)) return;
          candidates.push({modelId: id, apiVersion});
        };

        // If user picked a model and it's valid + not rate-limited, try it first.
        if(userModelRaw && isValidModelId(userModelRaw) && !isModelRateLimited(rateLimitInfo, userModelRaw)){
          addCandidate(userModelRaw, 'v1beta');
          addCandidate(userModelRaw, 'v1');
        }

        // Auto models (newest -> oldest)
        const modelList = await getModelList(apiKey);
        const listIds = modelList.map(m=>cleanModelId(m && m.name)).filter(Boolean);

        const flashIds = listIds.filter(id=>String(id).toLowerCase().includes('flash'));
        const otherIds = listIds.filter(id=>!String(id).toLowerCase().includes('flash'));

        // Try flash models first (best fit for free tier), newest -> oldest.
        for(const id of flashIds){ addCandidate(id, 'v1beta'); }
        for(const id of flashIds){ addCandidate(id, 'v1'); }

        // Then other models.
        for(const id of otherIds){ addCandidate(id, 'v1beta'); }
        for(const id of otherIds){ addCandidate(id, 'v1'); }

        // Fallback if list is empty
        addCandidate('gemini-1.5-flash-latest', 'v1beta');

        // Cap total attempts to avoid hammering API when global quota is exceeded.
        const maxAttempts = 3;

        let payload;
        let title = msg.title || '';

        // Build input content
        let inputText = '';
        if(msg.action === 'summarize_content' && msg.context){
          title = msg.context.title || title;
          const t = (msg.context.transcript || '').trim();
          const d = (msg.context.description || '').trim();
          const u = (msg.context.url || '').trim();
          if(t.length > 40){
            // Trim very long transcripts (free tier)
            const maxChars = 24000;
            inputText = t.length > maxChars ? t.slice(0, maxChars) + '\n\n...(kısaltıldı)' : t;
          } else {
            inputText = [
              `Başlık: ${title}`,
              d ? `Açıklama: ${d}` : '',
              u ? `URL: ${u}` : ''
            ].filter(Boolean).join('\n');
          }
        } else if(msg.action === 'summarize_url'){
          inputText = `Başlık: ${msg.title || ''}\nURL: ${msg.url || ''}`;
        } else {
          inputText = String(msg.text || '');
        }

        if(isGemini){
          const formatInstr = buildFormatInstruction(summaryFormat);
          const prompt = [
            `Aşağıdaki içeriği özetle. Dil: ${language}.`,
            formatInstr,
            '',
            inputText
          ].join('\n');
          payload = { contents: [{ role: 'user', parts: [{ text: prompt }]}] };
        } else {
          payload = { input: inputText, instructions: `Kısa ve anlaşılır şekilde özetle. Dil: ${language}` };
        }

        let summary;
        let lastErr = null;
        for(let i=0; i<Math.min(maxAttempts, candidates.length); i++){
          const c = candidates[i];
          const endpoint = buildGeminiGenerateContentEndpoint(apiKey, c.modelId, c.apiVersion);
          try{
            summary = await callEndpoint({endpoint, apiKey, payload, isGemini});
            lastErr = null;
            break;
          }catch(e){
            lastErr = e;
            const msgText = (e && e.message) ? e.message : String(e);
            if(isRateLimitErrorMessage(msgText)){
              await markModelRateLimited(c.modelId, msgText);
              continue;
            }
            // For non-rate-limit errors, don't fan out to many models; bubble up.
            throw e;
          }
        }

        if(!summary && lastErr){
          throw lastErr;
        }
        replyToTab({action:'summaryResult', summary, title: title || msg.title || '', requestId: msg.requestId});
        sendResponse({ok:true});
      } catch (err){
        replyToTab({action:'summaryResult', summary: 'Özetleme isteği başarısız: ' + (err && err.message ? err.message : String(err)), title: msg.title || '', requestId: msg.requestId});
        sendResponse({ok:false, error: String(err)});
      }
    });
    return true;
  }
});
