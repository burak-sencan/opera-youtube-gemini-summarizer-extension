// Gemini and model-selection helpers for background.js

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
  const untilTs = isUnavailable
    ? (now + 7 * 24 * 60 * 60 * 1000)
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

// Simple in-memory caches used by background.js
let autoModelCache = { apiKey: '', modelName: '', apiVersion: '', ts: 0 };
let modelListCache = { apiKey: '', models: [], ts: 0 };

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

  if(rateLimitInfo && isModelRateLimited(rateLimitInfo, modelName)){
    const sorted = sortModelsNewestFirst(supported);
    const next = sorted.find(m=>m && m.name && !isModelRateLimited(rateLimitInfo, m.name));
    if(next && next.name) modelName = next.name;
  }

  autoModelCache = { apiKey, modelName, apiVersion, ts: now };
  return { modelName, apiVersion };
}

function addModelCandidate(candidates, modelId, apiVersion, rateLimitInfo){
  const id = cleanModelId(modelId);
  if(!id) return;
  if(candidates.some(c=>c.modelId === id && c.apiVersion === apiVersion)) return;
  if(isModelRateLimited(rateLimitInfo, id)) return;
  candidates.push({modelId: id, apiVersion});
}

async function buildModelCandidates({apiKey, userModelRaw, rateLimitInfo}){
  const candidates = [];

  if(userModelRaw && isValidModelId(userModelRaw) && !isModelRateLimited(rateLimitInfo, userModelRaw)){
    addModelCandidate(candidates, userModelRaw, 'v1beta', rateLimitInfo);
    addModelCandidate(candidates, userModelRaw, 'v1', rateLimitInfo);
  }

  const modelList = await getModelList(apiKey);
  const listIds = modelList.map(m=>cleanModelId(m && m.name)).filter(Boolean);

  const flashIds = listIds.filter(id=>String(id).toLowerCase().includes('flash'));
  const otherIds = listIds.filter(id=>!String(id).toLowerCase().includes('flash'));

  for(const id of flashIds){ addModelCandidate(candidates, id, 'v1beta', rateLimitInfo); }
  for(const id of flashIds){ addModelCandidate(candidates, id, 'v1', rateLimitInfo); }
  for(const id of otherIds){ addModelCandidate(candidates, id, 'v1beta', rateLimitInfo); }
  for(const id of otherIds){ addModelCandidate(candidates, id, 'v1', rateLimitInfo); }

  addModelCandidate(candidates, 'gemini-1.5-flash-latest', 'v1beta', rateLimitInfo);

  return candidates;
}

async function callEndpoint({endpoint, apiKey, payload, isGemini}){
  const headers = {'Content-Type':'application/json'};
  let res;
  let data;
  try{
    if(self.GSBackgroundFetch && typeof self.GSBackgroundFetch.fetchJsonWithTimeout === 'function'){
      const timed = await self.GSBackgroundFetch.fetchJsonWithTimeout(endpoint, {
        method:'POST',
        headers,
        body: JSON.stringify(payload)
      }, 30_000);
      res = timed.response;
      data = timed.data;
    } else {
      const controller = new AbortController();
      const timeoutHandle = setTimeout(()=>{ try{ controller.abort(); }catch(e){} }, 30_000);
      try{
        res = await fetch(endpoint, { method:'POST', headers, body: JSON.stringify(payload), signal: controller.signal });
        data = await res.json().catch(()=>({}));
      } finally { clearTimeout(timeoutHandle); }
    }
  }catch(err){
    const aborted = (self.GSBackgroundFetch && typeof self.GSBackgroundFetch.isAbortError === 'function')
      ? self.GSBackgroundFetch.isAbortError(err)
      : !!(err && err.name === 'AbortError');
    if(aborted){ throw new Error('Gemini istegi zaman asimina ugradi. Lutfen tekrar deneyin.'); }
    throw err;
  }

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

async function summarizeWithCandidates({candidates, apiKey, payload, isGemini, maxAttempts}){
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
      throw e;
    }
  }

  if(!summary && lastErr){ throw lastErr; }
  return summary;
}

// Export to global scope for background.js (service worker importScripts environment)
self.GSGemini = {
  normalizeModelName, cleanModelId, parseGeminiVersion, modelVariantRank,
  compareModelIdsNewestFirst, sortModelsNewestFirst, isRateLimitErrorMessage,
  parseQuotaLimitValue, parseRetryAfterSeconds, markModelRateLimited,
  isModelRateLimited, buildGeminiGenerateContentEndpoint, listGeminiModels,
  listGeminiModelsV1, pickBestModel, extractGeminiText, getModelList,
  isValidModelId, getAutoModel, addModelCandidate, buildModelCandidates,
  callEndpoint, summarizeWithCandidates
};

// Also expose functions to global scope for backward compatibility with
// existing background.js code that calls them directly.
try{
  for(const k of Object.keys(self.GSGemini)){
    if(typeof self.GSGemini[k] === 'function' && !self[k]){
      self[k] = self.GSGemini[k];
    }
  }
}catch(e){}
