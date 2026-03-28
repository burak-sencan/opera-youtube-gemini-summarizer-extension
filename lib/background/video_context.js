// Video / transcript helpers extracted for background.js

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

function sanitizeTitleHint(title){
  try{
    const t = String(title || '').trim();
    if(!t) return '';
    return stripMarkup(t).slice(0, 300);
  }catch(e){ return String(title || '').trim(); }
}

function normalizeWatchUrl(url, videoId){
  try{
    const raw = String(url || '').trim();
    const vid = String(videoId || '').trim();
    if(vid){
      if(typeof buildCanonicalWatchUrl === 'function') return buildCanonicalWatchUrl(vid);
      return `https://www.youtube.com/watch?v=${encodeURIComponent(vid)}`;
    }
    // try extracting id from url
    if(typeof getVideoIdFromUrl === 'function'){
      const extracted = getVideoIdFromUrl(raw);
      if(extracted) return (typeof buildCanonicalWatchUrl === 'function') ? buildCanonicalWatchUrl(extracted) : `https://www.youtube.com/watch?v=${encodeURIComponent(extracted)}`;
    }
    if(!raw) return '';
    try{ const u = new URL(raw); return u.toString(); }catch(e){ return raw; }
  }catch(e){ return String(url || '').trim(); }
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

self.GSVideoContext = {
  decodeHtmlEntities, stripMarkup, parseVttTranscript, parseTimedTextXml,
  parseSrv3Transcript, parseJson3Transcript, parseTranscriptResponse,
  buildCaptionCandidateUrls, fetchTranscriptFromCaptionTracks, fetchTranscriptByVideoId,
  extractBalancedJson, extractMetaContent, trimPromptSection, normalizeVideoUploadDate,
  fetchYouTubeVideoContext, mergeVideoContexts,
  sanitizeTitleHint, normalizeWatchUrl
};

// Expose helpers to global scope for backward compatibility.
try{
  for(const k of Object.keys(self.GSVideoContext)){
    if(typeof self.GSVideoContext[k] === 'function' && !self[k]){
      self[k] = self.GSVideoContext[k];
    }
  }
}catch(e){}
