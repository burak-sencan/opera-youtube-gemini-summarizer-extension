// Background service worker

try{
  importScripts('lib/shared/video_id.js', 'lib/background/fetch_with_timeout.js');
}catch(e){}

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
  if(self.GSVideoId && typeof self.GSVideoId.getVideoIdFromUrl === 'function'){
    return self.GSVideoId.getVideoIdFromUrl(url);
  }
  try{
    const u = new URL(url);
    const direct = (u.searchParams.get('v') || '').trim();
    if(direct) return direct;

    const host = String(u.hostname || '').toLowerCase();
    if(host === 'youtu.be'){
      const parts = String(u.pathname || '').split('/').filter(Boolean);
      return parts[0] || null;
    }

    const segments = String(u.pathname || '').split('/').filter(Boolean);
    const markerIndex = segments.findIndex((seg)=> seg === 'shorts' || seg === 'live' || seg === 'embed');
    if(markerIndex >= 0 && segments[markerIndex + 1]) return segments[markerIndex + 1];

    return null;
  }catch(e){
    return null;
  }
}

function buildCanonicalWatchUrl(videoId){
  if(self.GSVideoId && typeof self.GSVideoId.buildCanonicalWatchUrl === 'function'){
    return self.GSVideoId.buildCanonicalWatchUrl(videoId);
  }
  const id = String(videoId || '').trim();
  return id ? `https://www.youtube.com/watch?v=${encodeURIComponent(id)}` : '';
}

function normalizeWatchUrl(url, videoId){
  const canonical = buildCanonicalWatchUrl(videoId || getVideoIdFromUrl(url));
  if(canonical) return canonical;
  return String(url || '').trim();
}

function sanitizeTitleHint(titleHint){
  const value = String(titleHint || '').replace(/\s+/g, ' ').trim();
  if(!value) return '';
  if(/özetle|kapat/i.test(value)) return '';
  if(/^\d{1,2}:\d{2}(?::\d{2})?$/.test(value)) return '';
  if(value.length < 8) return '';
  return value;
}

function decodeHtmlEntities(text){
  return String(text || '')
    .replace(/&#(\d+);/g, (_, dec)=> String.fromCodePoint(parseInt(dec, 10) || 0))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex)=> String.fromCodePoint(parseInt(hex, 16) || 0))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripMarkup(text){
  return decodeHtmlEntities(String(text || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function parseVttTranscript(vtt){
  return String(vtt || '')
    .replace(/^WEBVTT[^\n]*\n/i, '')
    .replace(/^\d+\s*$/gm, '')
    .replace(/\d{2}:\d{2}(?::\d{2})?\.\d{3}\s+-->\s+[^\n]+\n/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function parseTimedTextXml(xmlText){
  const lines = [];
  const re = /<text\b[^>]*>([\s\S]*?)<\/text>/gi;
  let match;
  while((match = re.exec(String(xmlText || '')))){
    const line = stripMarkup(match[1]);
    if(line) lines.push(line);
  }
  return lines.join('\n').trim();
}

function parseSrv3Transcript(xmlText){
  const lines = [];
  const re = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  let match;
  while((match = re.exec(String(xmlText || '')))){
    const line = stripMarkup(match[1]);
    if(line) lines.push(line);
  }
  return lines.join('\n').trim();
}

function parseJson3Transcript(jsonText){
  try{
    const data = JSON.parse(jsonText);
    const events = Array.isArray(data && data.events) ? data.events : [];
    const lines = [];
    for(const event of events){
      const segs = Array.isArray(event && event.segs) ? event.segs : [];
      const line = segs.map(seg=> seg && seg.utf8 ? seg.utf8 : '').join('').replace(/\s+/g, ' ').trim();
      if(line) lines.push(line);
    }
    return lines.join('\n').trim();
  }catch(e){
    return '';
  }
}

function parseTranscriptResponse(text){
  const raw = String(text || '').trim();
  if(!raw) return '';
  if(raw.startsWith('WEBVTT')) return parseVttTranscript(raw);
  if(raw.startsWith('{')) return parseJson3Transcript(raw);
  if(/<text\b/i.test(raw) || /<transcript\b/i.test(raw)) return parseTimedTextXml(raw);
  if(/<p\b/i.test(raw) || /<timedtext\b/i.test(raw)) return parseSrv3Transcript(raw);
  return '';
}

function buildCaptionCandidateUrls(baseUrl){
  const candidates = [];
  const seen = new Set();
  const add = (value)=>{
    const u = String(value || '').trim();
    if(!u || seen.has(u)) return;
    seen.add(u);
    candidates.push(u);
  };

  add(baseUrl);

  try{
    const source = new URL(baseUrl);
    const hasKind = source.searchParams.has('kind');
    const variants = [
      { fmt: 'json3', asr: false },
      { fmt: 'srv3', asr: false },
      { fmt: 'vtt', asr: false },
      { fmt: '', asr: false }
    ];
    if(!hasKind){
      variants.push(
        { fmt: 'json3', asr: true },
        { fmt: 'srv3', asr: true },
        { fmt: 'vtt', asr: true },
        { fmt: '', asr: true }
      );
    }

    for(const variant of variants){
      const next = new URL(source.toString());
      if(variant.fmt) next.searchParams.set('fmt', variant.fmt);
      else next.searchParams.delete('fmt');
      if(variant.asr) next.searchParams.set('kind', 'asr');
      add(next.toString());
    }
  }catch(e){}

  return candidates;
}

async function fetchTranscriptFromCaptionTracks(captionTracks){
  const tracks = Array.isArray(captionTracks) ? captionTracks.slice() : [];
  tracks.sort((a, b)=>{
    const aAsr = String((a && (a.kind || a.vssId)) || '').toLowerCase().includes('asr');
    const bAsr = String((b && (b.kind || b.vssId)) || '').toLowerCase().includes('asr');
    return Number(aAsr) - Number(bAsr);
  });

  for(const track of tracks){
    const baseUrl = track && track.baseUrl;
    if(!baseUrl) continue;
    const candidates = buildCaptionCandidateUrls(baseUrl);
    for(const candidateUrl of candidates){
      try{
        const res = await fetch(candidateUrl);
        if(!res.ok) continue;
        const text = await res.text();
        const parsed = parseTranscriptResponse(text);
        if(parsed.length > 80) return parsed;
      }catch(e){}
    }
  }

  return '';
}

async function fetchTranscriptByVideoId(videoId){
  const id = String(videoId || '').trim();
  if(!id) return '';

  const langs = ['tr', 'en'];
  for(const lang of langs){
    const urls = [
      `https://www.youtube.com/api/timedtext?fmt=json3&lang=${encodeURIComponent(lang)}&v=${encodeURIComponent(id)}`,
      `https://www.youtube.com/api/timedtext?fmt=srv3&lang=${encodeURIComponent(lang)}&v=${encodeURIComponent(id)}`,
      `https://www.youtube.com/api/timedtext?fmt=vtt&lang=${encodeURIComponent(lang)}&v=${encodeURIComponent(id)}`,
      `https://www.youtube.com/api/timedtext?lang=${encodeURIComponent(lang)}&v=${encodeURIComponent(id)}`,
      `https://www.youtube.com/api/timedtext?fmt=json3&lang=${encodeURIComponent(lang)}&kind=asr&v=${encodeURIComponent(id)}`,
      `https://www.youtube.com/api/timedtext?fmt=srv3&lang=${encodeURIComponent(lang)}&kind=asr&v=${encodeURIComponent(id)}`,
      `https://www.youtube.com/api/timedtext?fmt=vtt&lang=${encodeURIComponent(lang)}&kind=asr&v=${encodeURIComponent(id)}`,
      `https://www.youtube.com/api/timedtext?lang=${encodeURIComponent(lang)}&kind=asr&v=${encodeURIComponent(id)}`
    ];

    for(const url of urls){
      try{
        const res = await fetch(url);
        if(!res.ok) continue;
        const text = await res.text();
        const parsed = parseTranscriptResponse(text);
        if(parsed.length > 80) return parsed;
      }catch(e){}
    }
  }

  return '';
}

function extractBalancedJson(source, marker){
  const text = String(source || '');
  const idx = text.indexOf(marker);
  if(idx < 0) return '';
  const start = text.indexOf('{', idx + marker.length);
  if(start < 0) return '';

  let depth = 0;
  let inString = false;
  let escaped = false;
  for(let i = start; i < text.length; i++){
    const ch = text[i];
    if(inString){
      if(escaped) escaped = false;
      else if(ch === '\\') escaped = true;
      else if(ch === '"') inString = false;
      continue;
    }

    if(ch === '"'){
      inString = true;
      continue;
    }
    if(ch === '{') depth++;
    else if(ch === '}'){
      depth--;
      if(depth === 0) return text.slice(start, i + 1);
    }
  }

  return '';
}

function extractMetaContent(html, attr, value){
  const escaped = String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<meta[^>]+${attr}=["']${escaped}["'][^>]+content=["']([\\s\\S]*?)["'][^>]*>`, 'i');
  const match = String(html || '').match(re);
  return match ? decodeHtmlEntities(match[1]).trim() : '';
}

function trimPromptSection(text, maxChars){
  const value = String(text || '').trim();
  if(!value || value.length <= maxChars) return { text: value, truncated: false };
  return { text: `${value.slice(0, maxChars)}\n\n...(kısaltıldı)`, truncated: true };
}

function normalizeVideoUploadDate(value){
  const raw = String(value || '').trim();
  if(!raw) return '';
  if(/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const d = new Date(raw);
  if(Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

async function fetchYouTubeVideoContext(url, titleHint){
  const safeUrl = normalizeWatchUrl(url);
  const cleanTitleHint = sanitizeTitleHint(titleHint);
  const fallback = {
    url: safeUrl,
    videoId: getVideoIdFromUrl(safeUrl) || '',
    title: cleanTitleHint,
    channelName: '',
    uploadDate: '',
    description: '',
    transcript: ''
  };
  if(!safeUrl) return fallback;

  try{
    const res = await fetch(safeUrl);
    if(!res.ok) return fallback;
    const html = await res.text();
    const playerJson = extractBalancedJson(html, 'var ytInitialPlayerResponse =') || extractBalancedJson(html, 'ytInitialPlayerResponse =');
    const player = playerJson ? JSON.parse(playerJson) : null;
    const details = player && player.videoDetails ? player.videoDetails : {};
    const micro = player && player.microformat && player.microformat.playerMicroformatRenderer
      ? player.microformat.playerMicroformatRenderer
      : {};
    const captionTracks = player && player.captions && player.captions.playerCaptionsTracklistRenderer && Array.isArray(player.captions.playerCaptionsTracklistRenderer.captionTracks)
      ? player.captions.playerCaptionsTracklistRenderer.captionTracks
      : [];

    const title = String(
      details.title ||
      cleanTitleHint ||
      extractMetaContent(html, 'property', 'og:title') ||
      extractMetaContent(html, 'name', 'title')
    ).trim();
    const description = String(
      details.shortDescription ||
      extractMetaContent(html, 'name', 'description')
    ).trim();
    const channelName = String(details.author || micro.ownerChannelName || '').trim();
    const uploadDate = normalizeVideoUploadDate(micro.uploadDate || micro.publishDate);
    let transcript = await fetchTranscriptFromCaptionTracks(captionTracks);
    if(!transcript){
      transcript = await fetchTranscriptByVideoId(fallback.videoId || details.videoId || '');
    }

    return {
      url: safeUrl,
      videoId: fallback.videoId || String(details.videoId || '').trim(),
      title,
      channelName,
      uploadDate,
      description,
      transcript
    };
  }catch(e){
    return fallback;
  }
}

function mergeVideoContexts(primary, secondary){
  const first = primary && typeof primary === 'object' ? primary : {};
  const second = secondary && typeof secondary === 'object' ? secondary : {};
  const pick = (a, b, minLen = 1)=>{
    const aa = String(a || '').trim();
    if(aa.length >= minLen) return aa;
    return String(b || '').trim();
  };

  return {
    url: pick(first.url, second.url),
    videoId: pick(first.videoId, second.videoId),
    title: pick(first.title, second.title),
    channelName: pick(first.channelName, second.channelName),
    uploadDate: normalizeVideoUploadDate(pick(first.uploadDate, second.uploadDate)),
    description: pick(first.description, second.description, 20),
    transcript: pick(first.transcript, second.transcript, 120)
  };
}

function buildSummaryPrompt({language, summaryFormat, inputText, hasTranscript, transcriptTruncated}){
  if(summaryFormat === 'simple'){
    return [
      `Aşağıdaki video içeriğini ${language} dilinde özetle.`,
      '- Tek blok, kısa ve doğrudan özet yaz.',
      '- 2-4 cümle aralığında kal.',
      '- İlk cümlede konuşmacının ana sonucunu veya ana tezini söyle.',
      '- Sadece videoda gerçekten söylenenleri özetle.',
      '- "Bu video X hakkında" gibi genel tanım cümleleriyle başlama.',
      '- Başlık, etiket, madde imi veya bölüm adı kullanma.',
      '- Önce ana noktayı, sonra en kritik 1-2 detayı kısa biçimde anlat.',
      '- Metinde açıkça olmayan bilgi ekleme.',
      '',
      inputText
    ].join('\n');
  }

  return [
    'Aşağıdaki YouTube içeriğini, videoda konuşan kişinin gerçekten ne anlattığını merkeze alarak özetle.',
    `Yanıt dili: ${language}.`,
    'Amaç: Kullanıcı videoyu izlemeden konuşmacının ana tezini, vardığı sonucu, verdiği tavsiyeyi/uyarıyı ve bunu hangi gerekçelerle söylediğini anlayabilsin.',
    '- Video hakkında genel/meta tanım üretme; "bu video X hakkında" gibi yüzeysel cümlelerle oyalanma.',
    '- Konuşmacının ne savunduğunu, neye karşı çıktığını, hangi sonuca vardığını ve nedenini açık yaz.',
    '- Önemli verileri, sayıları, örnekleri, karşılaştırmaları ve risk/fırsat değerlendirmelerini koru.',
    '- Birden fazla görüş veya senaryo varsa bunları ayrı belirt.',
    '- Gereksiz uzatma yapma; tekrar eden ifadeleri temizle.',
    '- Metinde açıkça bulunmayan bilgiyi uydurma.',
    hasTranscript
      ? '- Önceliği transkripte ver; başlık ve açıklamayı sadece destekleyici bağlam olarak kullan.'
      : '- Transkript yoksa veya yetersizse bunu kısa biçimde belirt; yalnızca görünen başlık/açıklama bilgisinden emin olduğun kadar çıkarım yap.',
    transcriptTruncated
      ? '- Transkript kısaltıldıysa sadece görünen bölümden sonuç çıkar ve bunu kısa biçimde hissettir.'
      : '',
    buildFormatInstruction(summaryFormat),
    '',
    'İçerik:',
    inputText
  ].filter(Boolean).join('\n');
}

function buildSummaryInput(context){
  const source = context && typeof context === 'object' ? context : {};
  const title = String(source.title || '').trim();
  const descriptionInfo = trimPromptSection(source.description || '', 4000);
  const transcriptInfo = trimPromptSection(source.transcript || '', 28000);
  const parts = [];

  if(title) parts.push(`Video Başlığı:\n${title}`);
  if(descriptionInfo.text) parts.push(`Video Açıklaması:\n${descriptionInfo.text}`);
  if(transcriptInfo.text) parts.push(`Video Transkripti:\n${transcriptInfo.text}`);
  else if(source.url) parts.push(`Video URL:\n${source.url}`);

  return {
    inputText: parts.join('\n\n').trim(),
    hasTranscript: transcriptInfo.text.length >= 120,
    transcriptTruncated: transcriptInfo.truncated,
    titleLength: title.length,
    descriptionLength: descriptionInfo.text.length,
    transcriptLength: transcriptInfo.text.length
  };
}

function hasEnoughSummaryContent(summaryInputMeta){
  const meta = summaryInputMeta && typeof summaryInputMeta === 'object' ? summaryInputMeta : {};
  if((meta.transcriptLength || 0) >= 120) return true;
  if((meta.descriptionLength || 0) >= 240) return true;
  return false;
}


function buildFormatInstruction(summaryFormat){
  switch(summaryFormat){
    case 'simple':
      return '';
    case 'detailed':
      return [
        '- Detaylı ama derli toplu inceleme yaz.',
        '- Çıktı yapısı şu sırada olsun:',
        '  1) **Ana Tez** (1 kısa paragraf)',
        '  2) **Temel Noktalar** (5-10 madde)',
        '  3) **Kanıt ve Örnekler** (metindeki sayılar/örnekler)',
        '  4) **Sonuç ve Çıkarım** (1 kısa paragraf)',
        '- Adım adım süreç/akış anlatılıyorsa sıralamayı koru.',
        '- Gereksiz tekrarları çıkar; aynı bilgiyi farklı cümlelerle yineleme.',
        '- Transkript/açıklama eksik veya "...(kısaltıldı)" ise bunu açıkça belirt ve sadece verilen içeriğe dayan'
      ].join('\n');
    case 'bullets':
      return [
        '- Sadece madde işaretli liste üret; paragraf veya başlık yazma.',
        '- 6-10 kısa madde yaz.',
        '- Her madde tek bir net fikir içersin.',
        '- Varsa önemli sayı/iddia/önerileri maddelere ekle.',
        '- "Giriş", "Sonuç", "Özet" gibi etiketler kullanma.'
      ].join('\n');
    case 'paragraph':
      return [
        '- Yalnızca tek paragraf üret (madde, başlık, satır kırılımı yok).',
        '- 5-7 cümle aralığında kal.',
        '- İlk cümlede ana sonucu ver, devamında kritik gerekçeleri toparla.',
        '- Net, akıcı ve yoğun bilgi içeren bir anlatım kullan.'
      ].join('\n');
    case 'tldr_bullets':
    default:
      return [
        '- Aşağıdaki yapıyı aynen koru:',
        '  **Kısa Özet**',
        '  1 cümlelik özet',
        '  **Ana Fikirler**',
        '  6-10 madde',
        '- Maddelerde önemli sayı/iddia/uyarıları koru.',
        '- "TL;DR" etiketi kullanma; Türkçe ve doğal yaz.'
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

const pendingSummaryRequests = new Map();

function cleanupStalePendingRequests(){
  const now = Date.now();
  for(const [key, entry] of pendingSummaryRequests.entries()){
    const startedAt = entry && Number(entry.startedAt);
    if(!Number.isFinite(startedAt) || (now - startedAt) > 90_000){
      pendingSummaryRequests.delete(key);
    }
  }
}

function getSummaryRequestKey(msg, tabId){
  const action = String(msg && msg.action || '').trim();
  if(action !== 'summarize_content' && action !== 'summarize' && action !== 'summarize_url') return '';

  const ctx = msg && msg.context && typeof msg.context === 'object' ? msg.context : null;
  const rawUrl = String((ctx && ctx.url) || msg && msg.url || '').trim();
  const rawVideoId = String((ctx && ctx.videoId) || msg && msg.videoId || '').trim();
  const normalizedUrl = normalizeWatchUrl(rawUrl, rawVideoId);
  const identity = rawVideoId || getVideoIdFromUrl(normalizedUrl) || normalizedUrl;
  if(!identity) return '';

  const tabIdentity = (typeof tabId === 'number') ? String(tabId) : 'global';
  return `${tabIdentity}:${identity}`;
}

function hasPendingSummaryRequest(key){
  cleanupStalePendingRequests();
  return key ? pendingSummaryRequests.has(key) : false;
}

function beginPendingSummaryRequest(key){
  if(!key) return;
  pendingSummaryRequests.set(key, {startedAt: Date.now()});
}

function endPendingSummaryRequest(key){
  if(!key) return;
  pendingSummaryRequests.delete(key);
}

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

function addModelCandidate(candidates, modelId, apiVersion, rateLimitInfo){
  const id = cleanModelId(modelId);
  if(!id) return;
  if(candidates.some(c=>c.modelId === id && c.apiVersion === apiVersion)) return;
  if(isModelRateLimited(rateLimitInfo, id)) return;
  candidates.push({modelId: id, apiVersion});
}

async function buildModelCandidates({apiKey, userModelRaw, rateLimitInfo}){
  const candidates = [];

  // If user picked a model and it's valid + not rate-limited, try it first.
  if(userModelRaw && isValidModelId(userModelRaw) && !isModelRateLimited(rateLimitInfo, userModelRaw)){
    addModelCandidate(candidates, userModelRaw, 'v1beta', rateLimitInfo);
    addModelCandidate(candidates, userModelRaw, 'v1', rateLimitInfo);
  }

  // Auto models (newest -> oldest)
  const modelList = await getModelList(apiKey);
  const listIds = modelList.map(m=>cleanModelId(m && m.name)).filter(Boolean);

  const flashIds = listIds.filter(id=>String(id).toLowerCase().includes('flash'));
  const otherIds = listIds.filter(id=>!String(id).toLowerCase().includes('flash'));

  // Try flash models first (best fit for free tier), newest -> oldest.
  for(const id of flashIds){ addModelCandidate(candidates, id, 'v1beta', rateLimitInfo); }
  for(const id of flashIds){ addModelCandidate(candidates, id, 'v1', rateLimitInfo); }

  // Then other models.
  for(const id of otherIds){ addModelCandidate(candidates, id, 'v1beta', rateLimitInfo); }
  for(const id of otherIds){ addModelCandidate(candidates, id, 'v1', rateLimitInfo); }

  // Fallback if list is empty
  addModelCandidate(candidates, 'gemini-1.5-flash-latest', 'v1beta', rateLimitInfo);

  return candidates;
}

function createDefaultSummaryInputMeta(inputText){
  return {
    inputText: String(inputText || ''),
    hasTranscript: false,
    transcriptTruncated: false,
    titleLength: 0,
    descriptionLength: 0,
    transcriptLength: 0
  };
}

async function resolveSummaryInputFromMessage(msg){
  let title = msg.title || '';
  let summaryInputMeta = createDefaultSummaryInputMeta('');
  let inputText = '';
  let summaryContext = { url:'', videoId:'', channelName:'', uploadDate:'' };

  if(msg.action === 'summarize_content' && msg.context){
    let context = {
      url: normalizeWatchUrl((msg.context.url || '').trim(), (msg.context.videoId || '').trim()),
      videoId: (msg.context.videoId || '').trim(),
      title: (msg.context.title || '').trim(),
      channelName: (msg.context.channelName || '').trim(),
      uploadDate: normalizeVideoUploadDate(msg.context.uploadDate || ''),
      description: (msg.context.description || '').trim(),
      transcript: (msg.context.transcript || '').trim()
    };
    if(context.url && context.transcript.length < 120){
      const fetchedContext = await fetchYouTubeVideoContext(context.url, context.title || title);
      context = mergeVideoContexts(context, fetchedContext);
    }
    title = context.title || title;
    summaryInputMeta = buildSummaryInput(context);
    inputText = summaryInputMeta.inputText;
    summaryContext = {
      url: context.url || '',
      videoId: context.videoId || '',
      channelName: context.channelName || '',
      uploadDate: normalizeVideoUploadDate(context.uploadDate || '')
    };
  } else if(msg.action === 'summarize_url'){
    const context = await fetchYouTubeVideoContext(normalizeWatchUrl(msg.url || '', msg.videoId || ''), msg.title || '');
    title = context.title || title;
    summaryInputMeta = buildSummaryInput(context);
    inputText = summaryInputMeta.inputText;
    summaryContext = {
      url: context.url || '',
      videoId: context.videoId || '',
      channelName: context.channelName || '',
      uploadDate: normalizeVideoUploadDate(context.uploadDate || '')
    };
  } else {
    inputText = String(msg.text || '');
    summaryInputMeta = createDefaultSummaryInputMeta(inputText);
  }

  return {title, inputText, summaryInputMeta, summaryContext};
}

function buildSummaryRequestPayload({isGemini, language, summaryFormat, inputText, summaryInputMeta}){
  if(isGemini){
    const prompt = buildSummaryPrompt({
      language,
      summaryFormat,
      inputText,
      hasTranscript: summaryInputMeta.hasTranscript,
      transcriptTruncated: summaryInputMeta.transcriptTruncated
    });
    return { contents: [{ role: 'user', parts: [{ text: prompt }]}] };
  }
  return { input: inputText, instructions: `Kısa ve anlaşılır şekilde özetle. Dil: ${language}` };
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
      // For non-rate-limit errors, don't fan out to many models; bubble up.
      throw e;
    }
  }

  if(!summary && lastErr){
    throw lastErr;
  }

  return summary;
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
      // For Google AI Studio API keys, do NOT use Authorization: Bearer; key should be query parameter.
      const controller = new AbortController();
      const timeoutHandle = setTimeout(()=>{
        try{ controller.abort(); }catch(e){}
      }, 30_000);
      try{
        res = await fetch(endpoint, {
          method:'POST',
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal
        });
        data = await res.json().catch(()=>({}));
      } finally {
        clearTimeout(timeoutHandle);
      }
    }
  }catch(err){
    const aborted = (self.GSBackgroundFetch && typeof self.GSBackgroundFetch.isAbortError === 'function')
      ? self.GSBackgroundFetch.isAbortError(err)
      : !!(err && err.name === 'AbortError');
    if(aborted){
      throw new Error('Gemini istegi zaman asimina ugradi. Lutfen tekrar deneyin.');
    }
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

const ANALYSIS_STORAGE_KEY = 'analysisRecords';
const ANALYSIS_MAX_RECORDS = 5000;

function storageGet(keys){
  return new Promise((resolve)=>{
    try{
      chrome.storage.local.get(keys, (result)=>{
        resolve(result || {});
      });
    }catch(e){
      resolve({});
    }
  });
}

function storageSet(payload){
  return new Promise((resolve)=>{
    try{
      chrome.storage.local.set(payload || {}, ()=>resolve());
    }catch(e){
      resolve();
    }
  });
}

function cleanRecordText(value, maxLen = 20000){
  const t = String(value || '').replace(/\s+/g, ' ').trim();
  if(!t) return '';
  if(t.length <= maxLen) return t;
  return `${t.slice(0, maxLen)}...`;
}

const ANALYZE_MODE_DEFINITIONS = {
  idea_timeline: {
    label: 'Fikir Evrimi',
    defaultPrompt: 'Kayitlari kronolojik sirada incele. Konuya dair gorusun nasil degistigini donem donem acikla. Ilk donem ve son donem farkini netlestir.'
  },
  consistency_map: {
    label: 'Tutarlilik Haritasi',
    defaultPrompt: 'Secili kayitlar arasindaki tutarli ve celiskili noktalarni cikar. Celiskileri kanitlarla madde madde belirt.'
  },
  argument_shift: {
    label: 'Arguman Donusumu',
    defaultPrompt: 'Ana argumanin zaman icinde nasil degistigini incele. Her donum noktasini kayit bazinda goster.'
  },
  risk_opportunity: {
    label: 'Risk ve Firsat',
    defaultPrompt: 'Kayitlardan cikan riskleri ve firsatlari ayir. En etkili maddeler icin uygulanabilir oneriler ver.'
  },
  custom: {
    label: 'Ozel Mod',
    defaultPrompt: 'Secili kayitlari analiz et ve kanita dayali bir degerlendirme sun.'
  }
};

function normalizeAnalyzeMode(mode){
  const m = String(mode || '').trim().toLowerCase();
  if(Object.hasOwn(ANALYZE_MODE_DEFINITIONS, m)) return m;
  return 'custom';
}

function getAnalyzeModeDefinition(mode){
  const key = normalizeAnalyzeMode(mode);
  return ANALYZE_MODE_DEFINITIONS[key] || ANALYZE_MODE_DEFINITIONS.custom;
}

function buildAnalysisInputText(records, maxChars = 42000){
  const rows = Array.isArray(records) ? records : [];
  const blocks = [];
  let used = 0;
  let includedCount = 0;

  for(const source of rows){
    const row = source && typeof source === 'object' ? source : {};
    const summary = cleanRecordText(row.summary || row.content || row.summaryContent, 16000);
    if(!summary) continue;

    const title = cleanRecordText(row.title, 300) || '(basliksiz)';
    const channelName = cleanRecordText(row.channelName, 200) || '-';
    const videoUrl = cleanRecordText(row.videoUrl || row.url, 1200) || '-';
    const uploadDate = normalizeVideoUploadDate(row.uploadDate || row.publishDate || row.videoUploadDate) || '-';
    const createdAt = normalizeIsoDate(row.createdAt || row.capturedAt || new Date().toISOString());

    const block = [
      `Kayit ${includedCount + 1}`,
      `Baslik: ${title}`,
      `Kanal: ${channelName}`,
      `Video tarihi: ${uploadDate}`,
      `Kayit zamani: ${createdAt}`,
      `Video URL: ${videoUrl}`,
      `Ozet:\n${summary}`
    ].join('\n');

    const blockLen = block.length + 12;
    if((used + blockLen) > maxChars){
      const remaining = maxChars - used;
      if(remaining > 600){
        blocks.push(`${block.slice(0, remaining)}\n...(kisaltilmis kayit)`);
        includedCount++;
        used = maxChars;
      }
      break;
    }

    blocks.push(block);
    used += blockLen;
    includedCount++;

    if(includedCount >= 80) break;
  }

  return {
    text: blocks.join('\n\n-----\n\n').trim(),
    includedCount,
    totalCount: rows.length,
    truncated: includedCount < rows.length
  };
}

function buildAnalyzePrompt({language, mode, customPrompt, inputText, includedCount, totalCount, truncated}){
  const modeInfo = getAnalyzeModeDefinition(mode);
  const userPrompt = cleanRecordText(customPrompt || modeInfo.defaultPrompt, 3000) || modeInfo.defaultPrompt;

  return [
    'Asagidaki YouTube ozet kayitlarini toplu olarak analiz et.',
    `Yanit dili: ${language}.`,
    `Analiz modu: ${modeInfo.label}.`,
    `Kullanici talebi: ${userPrompt}`,
    `Gonderilen kayit: ${includedCount}/${totalCount}`,
    truncated ? '- Not: Veri boyutu siniri nedeniyle secili kayitlarin bir kismi gonderildi.' : '',
    'Cikti formati:',
    '1) Kisa Sonuc (2-4 cumle)',
    '2) Ana Bulgular (madde madde)',
    '3) Kanit Noktalari (kayit basligi/tarih referansi ile)',
    '4) Sonraki Aksiyonlar (3-5 madde)',
    '- Metinde acikca bulunmayan bilgi uydurma.',
    '',
    'Kayitlar:',
    inputText
  ].filter(Boolean).join('\n');
}

function normalizeIsoDate(value){
  const raw = String(value || '').trim();
  if(!raw) return new Date().toISOString();
  const d = new Date(raw);
  if(Number.isNaN(d.getTime())) return new Date().toISOString();
  return d.toISOString();
}

function makeRecordId(){
  return `rec_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

function normalizeAnalysisRecord(input){
  const source = input && typeof input === 'object' ? input : {};
  const createdAt = normalizeIsoDate(source.createdAt || source.capturedAt || new Date().toISOString());
  const summary = cleanRecordText(source.summary || source.content || source.summaryContent, 120000);
  const uploadDate = normalizeVideoUploadDate(source.uploadDate || source.publishDate || source.videoUploadDate);

  return {
    id: String(source.id || makeRecordId()),
    title: cleanRecordText(source.title, 300),
    channelName: cleanRecordText(source.channelName, 200),
    videoUrl: cleanRecordText(source.videoUrl || source.url, 1200),
    videoId: cleanRecordText(source.videoId, 120),
    uploadDate,
    summary,
    createdAt,
    updatedAt: new Date().toISOString()
  };
}

async function loadAnalysisRecords(){
  const cfg = await storageGet([ANALYSIS_STORAGE_KEY]);
  const rows = cfg && Array.isArray(cfg[ANALYSIS_STORAGE_KEY]) ? cfg[ANALYSIS_STORAGE_KEY] : [];
  return rows
    .filter((row)=> row && typeof row === 'object')
    .sort((a, b)=> String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

async function saveAnalysisRecords(records){
  const next = Array.isArray(records) ? records.slice(0, ANALYSIS_MAX_RECORDS) : [];
  await storageSet({[ANALYSIS_STORAGE_KEY]: next});
}

async function insertAnalysisRecord(input){
  const rec = normalizeAnalysisRecord(input);
  if(!rec.summary){
    throw new Error('Kaydedilecek ozet icerigi bos olamaz.');
  }
  const rows = await loadAnalysisRecords();
  rows.unshift(rec);
  await saveAnalysisRecords(rows);
  return rec;
}

async function updateAnalysisRecord(input){
  const payload = input && typeof input === 'object' ? input : {};
  const id = String(payload.id || '').trim();
  if(!id) throw new Error('Guncelleme icin id zorunlu.');

  const rows = await loadAnalysisRecords();
  const idx = rows.findIndex((row)=> String(row && row.id || '') === id);
  if(idx < 0) throw new Error('Kayit bulunamadi.');

  const current = rows[idx] || {};
  const next = {
    ...current,
    title: cleanRecordText(payload.title ?? current.title, 300),
    channelName: cleanRecordText(payload.channelName ?? current.channelName, 200),
    videoUrl: cleanRecordText(payload.videoUrl ?? current.videoUrl, 1200),
    videoId: cleanRecordText(payload.videoId ?? current.videoId, 120),
    uploadDate: normalizeVideoUploadDate(payload.uploadDate ?? current.uploadDate),
    summary: cleanRecordText(payload.summary ?? current.summary, 120000),
    createdAt: normalizeIsoDate(payload.createdAt ?? current.createdAt),
    updatedAt: new Date().toISOString()
  };

  if(!next.summary) throw new Error('Kaydedilecek ozet icerigi bos olamaz.');

  rows[idx] = next;
  await saveAnalysisRecords(rows);
  return next;
}

async function deleteAnalysisRecord(recordId){
  const id = String(recordId || '').trim();
  if(!id) throw new Error('Silme icin id zorunlu.');
  const rows = await loadAnalysisRecords();
  const next = rows.filter((row)=> String(row && row.id || '') !== id);
  const deleted = rows.length - next.length;
  await saveAnalysisRecords(next);
  return deleted;
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

  if(msg.action === 'save_analysis'){
    (async ()=>{
      try{
        const rec = await insertAnalysisRecord(msg.record);
        sendResponse({ok:true, record: rec});
      }catch(e){
        sendResponse({ok:false, error: (e && e.message) ? e.message : String(e)});
      }
    })();
    return true;
  }

  if(msg.action === 'list_analyses'){
    (async ()=>{
      try{
        const records = await loadAnalysisRecords();
        sendResponse({ok:true, records});
      }catch(e){
        sendResponse({ok:false, error: (e && e.message) ? e.message : String(e)});
      }
    })();
    return true;
  }

  if(msg.action === 'update_analysis'){
    (async ()=>{
      try{
        const rec = await updateAnalysisRecord(msg.record);
        sendResponse({ok:true, record: rec});
      }catch(e){
        sendResponse({ok:false, error: (e && e.message) ? e.message : String(e)});
      }
    })();
    return true;
  }

  if(msg.action === 'delete_analysis'){
    (async ()=>{
      try{
        const deleted = await deleteAnalysisRecord(msg.id);
        sendResponse({ok:true, deleted});
      }catch(e){
        sendResponse({ok:false, error: (e && e.message) ? e.message : String(e)});
      }
    })();
    return true;
  }

  if(msg.action === 'open_dashboard'){
    try{
      chrome.tabs.create({url: chrome.runtime.getURL('dashboard.html')}, ()=>{
        const runtimeError = chrome.runtime.lastError;
        if(runtimeError){
          sendResponse({ok:false, error: runtimeError.message || 'dashboard-open-failed'});
          return;
        }
        sendResponse({ok:true});
      });
    }catch(e){
      sendResponse({ok:false, error: (e && e.message) ? e.message : String(e)});
    }
    return true;
  }

  if(msg.action === 'analyze_records'){
    (async ()=>{
      try{
        const cfg = await storageGet(['apiKey','apiModel','language','modelRateLimitInfo']);
        const apiKey = String((cfg && cfg.apiKey) || '').trim();
        const userModelRaw = String((cfg && cfg.apiModel) || '').trim();
        const language = String((cfg && cfg.language) || 'Turkce');
        const rateLimitInfo = (cfg && cfg.modelRateLimitInfo && typeof cfg.modelRateLimitInfo === 'object') ? cfg.modelRateLimitInfo : {};

        if(!apiKey){
          sendResponse({ok:false, error:'API key girilmemis. Ayarlardan API key ekleyin.'});
          return;
        }

        const rows = Array.isArray(msg.records) ? msg.records : [];
        if(!rows.length){
          sendResponse({ok:false, error:'Analiz icin en az bir kayit secin.'});
          return;
        }

        const mode = normalizeAnalyzeMode(msg.mode);
        const packed = buildAnalysisInputText(rows, 42000);
        if(!packed.text){
          sendResponse({ok:false, error:'Secili kayitlarda analiz edilecek yeterli ozet icerigi yok.'});
          return;
        }

        const prompt = buildAnalyzePrompt({
          language,
          mode,
          customPrompt: String(msg.prompt || '').trim(),
          inputText: packed.text,
          includedCount: packed.includedCount,
          totalCount: packed.totalCount,
          truncated: packed.truncated
        });

        const candidates = await buildModelCandidates({apiKey, userModelRaw, rateLimitInfo});
        const payload = { contents: [{ role: 'user', parts: [{ text: prompt }]}] };

        const analysis = await summarizeWithCandidates({
          candidates,
          apiKey,
          payload,
          isGemini: true,
          maxAttempts: 3
        });

        sendResponse({
          ok:true,
          analysis,
          mode,
          modeLabel: getAnalyzeModeDefinition(mode).label,
          includedCount: packed.includedCount,
          totalCount: packed.totalCount,
          truncated: packed.truncated
        });
      }catch(e){
        sendResponse({ok:false, error: (e && e.message) ? e.message : String(e)});
      }
    })();
    return true;
  }

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
    const requestKey = getSummaryRequestKey(msg, targetTabId);
    if(requestKey && hasPendingSummaryRequest(requestKey)){
      sendResponse({ok:true, deduped:true});
      return true;
    }
    beginPendingSummaryRequest(requestKey);

    chrome.storage.local.get(['apiKey','apiModel','language','summaryFormat','modelRateLimitInfo'], async (cfg)=>{
      try{
        const apiKey = (cfg.apiKey || '').trim();
        const userModelRaw = (cfg.apiModel || '').trim();
        const language = cfg.language || 'Türkçe';
        const summaryFormat = (cfg.summaryFormat || 'simple').trim();
        const rateLimitInfo = (cfg && cfg.modelRateLimitInfo && typeof cfg.modelRateLimitInfo === 'object') ? cfg.modelRateLimitInfo : {};

        if(!apiKey){
          replyToTab({action:'summaryResult', summary:'API key girilmemiş. Uzantı seçeneklerinden API key ekleyin.', title: msg.title || ''});
          sendResponse({ok:false, error:'no-apiKey'});
          return;
        }

        let isGemini = true;

        const candidates = await buildModelCandidates({apiKey, userModelRaw, rateLimitInfo});

        // Cap total attempts to avoid hammering API when global quota is exceeded.
        const maxAttempts = 3;

        const {title, inputText, summaryInputMeta, summaryContext} = await resolveSummaryInputFromMessage(msg);

        if(!inputText || !hasEnoughSummaryContent(summaryInputMeta)){
          const noContentMessage = 'Videonun özet çıkarılabilecek içeriği alınamadı. Sadece başlık/URL ile özet üretmiyorum. Lütfen videoyu açıp tekrar deneyin veya transkript bulunan bir video kullanın.';
          replyToTab({action:'summaryResult', summary: noContentMessage, title: title || msg.title || '', requestId: msg.requestId});
          sendResponse({ok:false, error:'insufficient-content'});
          return;
        }

        const payload = buildSummaryRequestPayload({
          isGemini,
          language,
          summaryFormat,
          inputText,
          summaryInputMeta
        });

        const summary = await summarizeWithCandidates({
          candidates,
          apiKey,
          payload,
          isGemini,
          maxAttempts
        });

        replyToTab({
          action:'summaryResult',
          summary,
          title: title || msg.title || '',
          requestId: msg.requestId,
          videoUrl: summaryContext.url || '',
          videoId: summaryContext.videoId || '',
          channelName: summaryContext.channelName || '',
          uploadDate: summaryContext.uploadDate || ''
        });
        sendResponse({ok:true});
      } catch (err){
        replyToTab({action:'summaryResult', summary: 'Özetleme isteği başarısız: ' + (err && err.message ? err.message : String(err)), title: msg.title || '', requestId: msg.requestId});
        sendResponse({ok:false, error: String(err)});
      } finally {
        endPendingSummaryRequest(requestKey);
      }
    });
    return true;
  }
});
