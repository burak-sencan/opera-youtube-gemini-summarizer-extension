// İçerik betiği: YouTube sayfalarında çalışır.
// Basit akış: aktif video sayfasından (watch) URL + başlık + açıklama + (varsa) transkript topla.
// Drawer ile sonucu sayfada göster.

(function(){
  if(window.__geminiExtLoaded){
    // Prevent duplicate observers/listeners if the content script is injected more than once.
    return;
  }
  window.__geminiExtLoaded = true;
  console.debug('[GeminiSummary] content script loaded', location.href);

  let activeRequestId = null;

  const uiDefaults = {
    drawerFontSize: 15,
    drawerWidth: 440
  };

  const uiSettings = {
    drawerFontSize: uiDefaults.drawerFontSize,
    drawerWidth: uiDefaults.drawerWidth
  };

  function loadUiSettings(){
    try{
      chrome.storage.local.get(['drawerFontSize','drawerWidth'], (cfg)=>{
        const fs = parseInt(cfg.drawerFontSize, 10);
        const w = parseInt(cfg.drawerWidth, 10);
        uiSettings.drawerFontSize = Number.isFinite(fs) ? Math.max(12, Math.min(22, fs)) : uiDefaults.drawerFontSize;
        uiSettings.drawerWidth = Number.isFinite(w) ? Math.max(320, Math.min(720, w)) : uiDefaults.drawerWidth;
        applyUiToExistingDrawer();
      });
    } catch (e) {}
  }

  function applyUiToExistingDrawer(){
    const drawer = document.getElementById('gemini-summary-drawer');
    if(!drawer) return;
    const content = drawer.querySelector('#gemini-drawer-content');
    const title = drawer.querySelector('#gemini-drawer-title');
    if(drawer) drawer.style.width = `${uiSettings.drawerWidth}px`;
    if(content) content.style.fontSize = `${uiSettings.drawerFontSize}px`;
    if(title) title.style.fontSize = `${uiSettings.drawerFontSize + 2}px`;
  }

  function newRequestId(){
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  loadUiSettings();
  try{
    chrome.storage.onChanged.addListener((changes, area)=>{
      if(area !== 'local') return;
      if(changes.drawerFontSize || changes.drawerWidth) loadUiSettings();
    });
  } catch (e) {}

  function ensureStyles(){
    if(document.getElementById('gemini-summary-styles')) return;
    const style = document.createElement('style');
    style.id = 'gemini-summary-styles';
    style.textContent = `
      .gemini-summary-btn-wrap{ position: relative !important; }
      .gemini-summary-hover-btn{
        position:absolute;
        top:8px;
        left:50%;
        right:auto;
        transform: translateX(-50%);
        z-index: 2;
        opacity: 0;
        pointer-events: none;
        transition: opacity .12s ease-in-out;
        background: rgba(15,15,16,.88);
        color: #f5f5f5;
        border: 1px solid rgba(255,255,255,.16);
        border-radius: 10px;
        padding: 6px 10px;
        font-size: 13px;
        font-weight: 600;
        line-height: 1;
        cursor: pointer;
        box-shadow: 0 6px 16px rgba(0,0,0,.35);
      }
      .gemini-summary-hover-btn:hover{ background: rgba(15,15,16,.96); border-color: rgba(255,255,255,.22); }
      .gemini-summary-btn-wrap:hover .gemini-summary-hover-btn,
      .gemini-summary-btn-wrap:focus-within .gemini-summary-hover-btn{
        opacity: 1;
        pointer-events: auto;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function isSubscriptionsPage(){
    try{
      return location.pathname === '/feed/subscriptions';
    }catch(e){
      return false;
    }
  }

  function toAbsoluteUrl(href){
    try{ return new URL(href, location.origin).toString(); }catch(e){ return ''; }
  }

  function requestSummaryByUrl(url, title){
    if(!url) return;
    const vid = (function(){
      try{ return new URL(url).searchParams.get('v'); }catch(e){ return null; }
    })();
    const requestId = newRequestId();
    activeRequestId = requestId;
    showSummaryDrawer('Özet hazırlanıyor...', title || 'Gemini ile özetle', true);
    chrome.runtime.sendMessage({action:'summarize_url', url, title, videoId: vid, requestId}, ()=>{});
  }

  function showSummaryDrawer(summary, title, isPending){
    const removeDrawer = ()=>{
      try{ document.getElementById('gemini-summary-drawer')?.remove(); }catch(e){}
      try{ document.getElementById('gemini-summary-backdrop')?.remove(); }catch(e){}
    };

    let drawer = document.getElementById('gemini-summary-drawer');
    if(!drawer){
      // Backdrop (click outside to close)
      const backdrop = document.createElement('div');
      backdrop.id = 'gemini-summary-backdrop';
      Object.assign(backdrop.style,{
        position:'fixed',
        left:'0',
        top:'0',
        width:'100vw',
        height:'100vh',
        background:'rgba(0,0,0,.35)',
        zIndex:2147483646
      });
      backdrop.addEventListener('click', (ev)=>{
        ev.preventDefault();
        ev.stopPropagation();
        removeDrawer();
      }, true);
      document.body.appendChild(backdrop);

      drawer = document.createElement('div');
      drawer.id = 'gemini-summary-drawer';
      // Dark theme drawer (always dark, independent of YouTube theme)
      Object.assign(drawer.style,{
        position:'fixed',
        right:'0',
        top:'0',
        height:'100vh',
        width:`${uiSettings.drawerWidth}px`,
        maxWidth:'92vw',
        background:'#0f0f10',
        color:'#f5f5f5',
        zIndex:2147483647,
        boxShadow:'-6px 0 22px rgba(0,0,0,.45)',
        borderLeft:'1px solid rgba(255,255,255,.10)',
        borderTopLeftRadius:'14px',
        borderBottomLeftRadius:'14px',
        padding:'14px',
        display:'flex',
        flexDirection:'column',
        overflow:'hidden',
        fontFamily:'system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif'
      });

      // Resizer handle
      const resizer = document.createElement('div');
      resizer.id = 'gemini-drawer-resizer';
      Object.assign(resizer.style,{
        position:'absolute',
        left:'0',
        top:'0',
        height:'100%',
        width:'10px',
        cursor:'ew-resize',
        background:'transparent'
      });
      // Visual cue
      const grip = document.createElement('div');
      Object.assign(grip.style,{
        position:'absolute',
        left:'3px',
        top:'50%',
        transform:'translateY(-50%)',
        width:'4px',
        height:'44px',
        borderRadius:'999px',
        background:'rgba(255,255,255,.12)'
      });
      resizer.appendChild(grip);
      drawer.appendChild(resizer);

      let dragStartX = 0;
      let dragStartWidth = uiSettings.drawerWidth;
      function onMove(ev){
        const x = ev.clientX;
        const delta = dragStartX - x; // moving left increases width
        const next = Math.max(320, Math.min(720, dragStartWidth + delta));
        uiSettings.drawerWidth = next;
        drawer.style.width = `${next}px`;
      }
      function onUp(){
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('mouseup', onUp, true);
        try{ chrome.storage.local.set({drawerWidth: uiSettings.drawerWidth}, ()=>{}); }catch(e){}
      }
      resizer.addEventListener('mousedown', (ev)=>{
        ev.preventDefault();
        ev.stopPropagation();
        dragStartX = ev.clientX;
        dragStartWidth = drawer.getBoundingClientRect().width;
        document.addEventListener('mousemove', onMove, true);
        document.addEventListener('mouseup', onUp, true);
      }, true);
      resizer.addEventListener('dblclick', ()=>{
        uiSettings.drawerWidth = uiDefaults.drawerWidth;
        drawer.style.width = `${uiSettings.drawerWidth}px`;
        try{ chrome.storage.local.set({drawerWidth: uiSettings.drawerWidth}, ()=>{}); }catch(e){}
      });

      const header = document.createElement('div');
      header.style.display = 'flex';
      header.style.alignItems = 'center';
      header.style.justifyContent = 'space-between';
      header.style.gap = '10px';
      header.style.paddingBottom = '12px';
      header.style.borderBottom = '1px solid rgba(255,255,255,.10)';
      header.style.paddingLeft = '8px';
      const hTitle = document.createElement('div');
      hTitle.id = 'gemini-drawer-title';
      hTitle.style.fontWeight = '650';
      hTitle.style.fontSize = `${uiSettings.drawerFontSize + 2}px`;
      hTitle.style.lineHeight = '1.3';
      hTitle.style.overflow = 'hidden';
      hTitle.style.textOverflow = 'ellipsis';
      hTitle.style.whiteSpace = 'nowrap';
      header.appendChild(hTitle);
      const close = document.createElement('button');
      close.textContent = 'Kapat';
      Object.assign(close.style,{
        cursor:'pointer',
        background:'rgba(255,255,255,.08)',
        color:'#f5f5f5',
        border:'1px solid rgba(255,255,255,.14)',
        borderRadius:'8px',
        padding:'8px 10px',
        fontSize:'14px'
      });
      close.addEventListener('mouseenter', ()=>{ close.style.background = 'rgba(255,255,255,.12)'; });
      close.addEventListener('mouseleave', ()=>{ close.style.background = 'rgba(255,255,255,.08)'; });
      close.addEventListener('click',()=>removeDrawer());
      header.appendChild(close);
      drawer.appendChild(header);
      const content = document.createElement('div');
      content.id = 'gemini-drawer-content';
      content.style.flex = '1';
      content.style.minHeight = '0';
      content.style.whiteSpace = 'normal';
      content.style.overflow = 'auto';
      content.style.marginTop = '12px';
      content.style.fontSize = `${uiSettings.drawerFontSize}px`;
      content.style.lineHeight = '1.6';
      content.style.padding = '12px';
      content.style.paddingRight = '12px';
      // Extra bottom padding so last lines never feel clipped
      content.style.paddingBottom = '22px';
      content.style.background = 'rgba(255,255,255,.04)';
      content.style.border = '1px solid rgba(255,255,255,.08)';
      content.style.borderRadius = '12px';
      content.style.wordBreak = 'break-word';
      drawer.appendChild(content);

      // Drawer content styles (markdown-ish rendering)
      const style = document.createElement('style');
      style.id = 'gemini-drawer-markdown-styles';
      style.textContent = `
        #gemini-drawer-content .gs-section-title{
          margin: 6px 0 10px 0;
          padding: 10px 12px;
          border: 1px solid rgba(255,255,255,.10);
          background: rgba(255,255,255,.05);
          border-radius: 12px;
          font-weight: 750;
          letter-spacing: .2px;
        }
        #gemini-drawer-content .gs-hr{ height:1px; background: rgba(255,255,255,.10); margin: 10px 0; }
        #gemini-drawer-content .gs-p{ margin: 8px 0; }
        #gemini-drawer-content .gs-ul{ margin: 8px 0 10px 18px; padding: 0; }
        #gemini-drawer-content .gs-ul li{ margin: 6px 0; }
        #gemini-drawer-content strong{ font-weight: 750; }
        #gemini-drawer-content code{
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
          font-size: .95em;
          background: rgba(255,255,255,.06);
          border: 1px solid rgba(255,255,255,.10);
          padding: 2px 6px;
          border-radius: 8px;
        }
      `;
      drawer.appendChild(style);
      document.body.appendChild(drawer);
    }

    // If drawer exists but backdrop was removed (e.g., page DOM changes), recreate it.
    if(!document.getElementById('gemini-summary-backdrop')){
      const backdrop = document.createElement('div');
      backdrop.id = 'gemini-summary-backdrop';
      Object.assign(backdrop.style,{
        position:'fixed',
        left:'0',
        top:'0',
        width:'100vw',
        height:'100vh',
        background:'rgba(0,0,0,.35)',
        zIndex:2147483646
      });
      backdrop.addEventListener('click', (ev)=>{
        ev.preventDefault();
        ev.stopPropagation();
        removeDrawer();
      }, true);
      document.body.appendChild(backdrop);
    }

    const hTitle = document.getElementById('gemini-drawer-title');
    const content = document.getElementById('gemini-drawer-content');
    hTitle.textContent = title || document.title;
    if(isPending){
      content.textContent = summary || '';
    } else {
      content.innerHTML = formatSummaryToHtml(summary || '');
    }
    content.style.opacity = isPending ? '0.75' : '1';
    if(isPending) content.scrollTop = 0;
  }

  function escapeHtml(s){
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function inlineFormat(lineEscaped){
    // **bold**
    let out = lineEscaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // `code`
    out = out.replace(/`([^`]+?)`/g, '<code>$1</code>');
    return out;
  }

  function formatSummaryToHtml(summaryRaw){
    const lines = String(summaryRaw).replace(/\r\n/g, '\n').split('\n');
    const blocks = [];

    let listItems = [];
    const flushList = ()=>{
      if(!listItems.length) return;
      const lis = listItems.map(li=>`<li>${li}</li>`).join('');
      blocks.push(`<ul class="gs-ul">${lis}</ul>`);
      listItems = [];
    };

    const normalizeHeading = (text)=>{
      const t = String(text || '').trim();
      if(!t) return '';
      if(/^TL;DR$/i.test(t) || /^TL\s*;\s*DR$/i.test(t)) return 'Kısa Özet';
      return t;
    };

    for(const rawLine of lines){
      const line = rawLine.trim();
      if(!line){
        flushList();
        continue;
      }

      const esc = escapeHtml(line);

      // Section headings like **TL;DR** or **Ana Fikirler** or plain TL;DR:
      const headingMatch = line.match(/^\*\*(.+)\*\*$/);
      const plainHeading = /^(TL;DR|Ana Fikirler|Ana Fikirler:|Özet|Özet:|Önemli Noktalar|Önemli Noktalar:)$/i.test(line);
      if(headingMatch || plainHeading){
        flushList();
        const rawText = headingMatch ? headingMatch[1].trim() : line.replace(/:$/, '');
        const text = normalizeHeading(rawText);
        blocks.push(`<div class="gs-section-title">${escapeHtml(text)}</div>`);
        blocks.push('<div class="gs-hr"></div>');
        continue;
      }

      // Bullet lines
      const bullet = line.match(/^[-*•]\s+(.+)$/);
      if(bullet){
        listItems.push(inlineFormat(escapeHtml(bullet[1].trim())));
        continue;
      }

      flushList();
      blocks.push(`<div class="gs-p">${inlineFormat(esc)}</div>`);
    }

    flushList();
    return blocks.join('');
  }

  function getAnchorTitle(a){
    const direct = (a.getAttribute('title') || a.textContent || '').trim();
    if(direct) return direct;
    const card = a.closest('.yt-lockup-metadata-view-model') || a.closest('ytd-rich-item-renderer, ytd-grid-video-renderer, ytd-video-renderer, ytd-rich-grid-media');
    const titleLink = card && card.querySelector && card.querySelector('a.yt-lockup-metadata-view-model__title, a#video-title, h3 a[title]');
    const t = titleLink && (titleLink.getAttribute('title') || titleLink.textContent);
    return (t || document.title).trim();
  }

  const processedThumbs = new WeakSet();

  function addButtonToThumbnailAnchor(a){
    try{
      if(!a || processedThumbs.has(a)) return;
      const href = a.getAttribute('href') || '';
      if(!href.includes('/watch')) return;
      const videoUrl = toAbsoluteUrl(href);
      if(!videoUrl) return;

      processedThumbs.add(a);
      ensureStyles();

      a.classList.add('gemini-summary-btn-wrap');
      // Don't clobber existing positioning if set
      const computed = getComputedStyle(a);
      if(computed.position === 'static') a.style.position = 'relative';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'gemini-summary-hover-btn';
      btn.textContent = 'Özetle';
      btn.setAttribute('aria-label', 'Gemini ile özetle');

      btn.addEventListener('click', (e)=>{
        e.preventDefault();
        e.stopPropagation();
        const title = getAnchorTitle(a);
        requestSummaryByUrl(videoUrl, title);
      }, {capture:true});

      a.appendChild(btn);
    }catch(e){
      // ignore
    }
  }

  function scanSubscriptions(){
    if(!isSubscriptionsPage()) return;

    // Prefer thumbnail anchors; fallback to title anchors.
    const anchors = document.querySelectorAll('a#thumbnail[href*="/watch"], a.yt-lockup-metadata-view-model__title[href*="/watch"], a[href^="/watch"]');
    anchors.forEach(a=>addButtonToThumbnailAnchor(a));
  }

  // Observe DOM on subscriptions page (infinite scroll)
  let scanTimer = null;
  const subsObs = new MutationObserver(()=>{
    if(!isSubscriptionsPage()) return;
    if(scanTimer) return;
    scanTimer = setTimeout(()=>{
      scanTimer = null;
      scanSubscriptions();
    }, 250);
  });
  subsObs.observe(document.documentElement || document.body, {subtree:true, childList:true});
  // initial
  scanSubscriptions();

  function parseVTT(vtt){
    return String(vtt)
      .replace(/^WEBVTT\s*\n/, '')
      .replace(/\d{2}:\d{2}:\d{2}\.\d{3} --> .*\n/g,'')
      .replace(/\n{2,}/g,'\n')
      .trim();
  }

  function decodeHtmlEntities(str){
    const txt = document.createElement('textarea');
    txt.innerHTML = str;
    return txt.value;
  }

  function parseTimedTextXml(xmlText){
    try{
      const parser = new DOMParser();
      const doc = parser.parseFromString(xmlText, 'text/xml');
      const nodes = Array.from(doc.querySelectorAll('text'));
      const lines = nodes.map(n=>decodeHtmlEntities(n.textContent || '')).filter(Boolean);
      return lines.join('\n').trim();
    }catch(e){
      return '';
    }
  }

  function getVideoIdFromUrl(url){
    try{
      const u = new URL(url, location.origin);
      return u.searchParams.get('v');
    }catch(e){
      return null;
    }
  }

  function withTimeout(promise, ms){
    return new Promise((resolve)=>{
      let done = false;
      const t = setTimeout(()=>{
        if(done) return;
        done = true;
        resolve('');
      }, ms);
      Promise.resolve(promise).then((v)=>{
        if(done) return;
        done = true;
        clearTimeout(t);
        resolve(v || '');
      }).catch(()=>{
        if(done) return;
        done = true;
        clearTimeout(t);
        resolve('');
      });
    });
  }

  async function tryFetchTranscriptFromPlayer(){
    try{
      const ipr = window.ytInitialPlayerResponse;
      const tracks = ipr && ipr.captions && ipr.captions.playerCaptionsTracklistRenderer && ipr.captions.playerCaptionsTracklistRenderer.captionTracks;
      if(!Array.isArray(tracks) || !tracks.length) return '';
      // Prefer first track (usually matches UI)
      let url = tracks[0].baseUrl;
      if(!url) return '';
      if(!url.includes('fmt=')) url += '&fmt=vtt';
      const res = await fetch(url);
      const text = await res.text();
      return text.startsWith('WEBVTT') ? parseVTT(text) : text;
    }catch(e){
      return '';
    }
  }

  async function tryFetchTranscriptTimedText(videoId){
    if(!videoId) return '';
    const langs = [];
    try{
      const nav = (navigator.language || '').toLowerCase();
      if(nav) langs.push(nav.split('-')[0]);
    }catch(e){}
    langs.push('tr','en');
    const uniqueLangs = Array.from(new Set(langs)).filter(Boolean);

    for(const lang of uniqueLangs){
      try{
        const urlVtt = `https://www.youtube.com/api/timedtext?fmt=vtt&lang=${encodeURIComponent(lang)}&v=${encodeURIComponent(videoId)}`;
        const resVtt = await fetch(urlVtt);
        const vtt = await resVtt.text();
        if(vtt && vtt.startsWith('WEBVTT')){
          const parsed = parseVTT(vtt);
          if(parsed.length > 20) return parsed;
        }

        const urlXml = `https://www.youtube.com/api/timedtext?lang=${encodeURIComponent(lang)}&v=${encodeURIComponent(videoId)}`;
        const resXml = await fetch(urlXml);
        const xml = await resXml.text();
        if(xml && xml.includes('<transcript')){
          const parsedXml = parseTimedTextXml(xml);
          if(parsedXml.length > 20) return parsedXml;
        }
      }catch(e){}
    }
    return '';
  }

  function getTitle(){
    const h1 = document.querySelector('h1 yt-formatted-string') || document.querySelector('h1');
    const t = (h1 && h1.textContent) || document.title;
    return (t || '').trim();
  }

  function getDescription(){
    const desc = document.querySelector('#description') || document.querySelector('#meta-contents');
    return (desc && desc.innerText ? desc.innerText.trim() : '');
  }

  async function getVideoContext(){
    const url = location.href;
    const videoId = getVideoIdFromUrl(url);
    if(!videoId){
      return { ok:false, error:'Bu sayfa bir YouTube video sayfası değil. Bir video açın (URL içinde ?v=...).', url };
    }

    const title = getTitle();
    const description = getDescription();

    // Transcript fetching can be slow or blocked; don't hang the UI.
    let transcript = await withTimeout(tryFetchTranscriptFromPlayer(), 1200);
    if(!transcript) transcript = await withTimeout(tryFetchTranscriptTimedText(videoId), 1200);

    return {
      ok:true,
      url,
      videoId,
      title,
      description,
      transcript
    };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse)=>{
    if(msg && msg.action === 'summaryResult'){
      if(msg.requestId && activeRequestId && msg.requestId !== activeRequestId){
        sendResponse({ok:true, ignored:true});
        return;
      }
      showSummaryDrawer(msg.summary || JSON.stringify(msg), msg.title || document.title, false);
      sendResponse({ok:true});
      return;
    }
    if(msg && msg.action === 'get_video_context'){
      showSummaryDrawer('Video bilgileri alınıyor...', 'Gemini ile özetle', true);
      // Respond quickly with basic info, then try to enrich with transcript.
      (async ()=>{
        let responded = false;
        try{
          const url = location.href;
          const videoId = getVideoIdFromUrl(url);
          if(!videoId){
            responded = true;
            sendResponse({ ok:false, error:'Bu sayfa bir YouTube video sayfası değil. Bir video açın (URL içinde ?v=...).', url });
            return;
          }
          const baseCtx = {
            ok:true,
            url,
            videoId,
            title: getTitle(),
            description: getDescription(),
            transcript: ''
          };
          // Immediately return base context so popup can proceed.
          responded = true;
          sendResponse(baseCtx);

          // Best-effort: fetch transcript and stash for manual retry flows.
          const enriched = await getVideoContext();
          window.__geminiLastVideoContext = enriched;
        } catch (e){
          if(!responded) sendResponse({ ok:false, error: String(e) });
        }
      })();
      return true;
    }

    if(msg && msg.action === 'start_summary'){
      (async ()=>{
        try{
          showSummaryDrawer('Video bilgileri alınıyor...', 'Gemini ile özetle', true);
          const ctx = await getVideoContext();
          if(!ctx.ok){
            showSummaryDrawer(ctx.error || 'Video bilgisi alınamadı.', 'Hata', false);
            sendResponse({ok:false, error: ctx.error});
            return;
          }
          const requestId = newRequestId();
          activeRequestId = requestId;
          showSummaryDrawer('Özet hazırlanıyor...', ctx.title, true);
          chrome.runtime.sendMessage({action:'summarize_content', context: ctx, requestId}, ()=>{});
          sendResponse({ok:true});
        } catch (e){
          showSummaryDrawer(String(e), 'Hata', false);
          sendResponse({ok:false, error: String(e)});
        }
      })();
      return true;
    }
  });

  window.__geminiRequestSummary = async ()=>{
    const ctx = await getVideoContext();
    if(!ctx.ok){
      showSummaryDrawer(ctx.error || 'Video bilgisi alınamadı.', 'Hata', false);
      return;
    }
    const requestId = newRequestId();
    activeRequestId = requestId;
    showSummaryDrawer('Özet hazırlanıyor...', ctx.title, true);
    chrome.runtime.sendMessage({action:'summarize_content', context: ctx, requestId}, ()=>{});
  };
})();
