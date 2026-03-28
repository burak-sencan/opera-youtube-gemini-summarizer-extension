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
  let summaryPending = false;
  let pendingSummarySource = null;
  let latestSummaryContext = null;
  let drawerSaveResetTimer = null;
  const SUMMARY_PENDING_TIMEOUT_MS = 75_000;
  let summaryPendingTimeoutHandle = null;

  function clearSummaryPendingTimeout(){
    if(!summaryPendingTimeoutHandle) return;
    clearTimeout(summaryPendingTimeoutHandle);
    summaryPendingTimeoutHandle = null;
  }

  function setSummaryPending(isPending){
    summaryPending = !!isPending;
    clearSummaryPendingTimeout();
    if(!summaryPending) return;

    summaryPendingTimeoutHandle = setTimeout(()=>{
      summaryPendingTimeoutHandle = null;
      summaryPending = false;
      showSummaryDrawer('Ozetleme istegi zaman asimina ugradi. Lutfen tekrar deneyin.', 'Hata', false);
    }, SUMMARY_PENDING_TIMEOUT_MS);
  }

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
        uiSettings.drawerWidth = Number.isFinite(w) ? Math.max(320, Math.min(1440, w)) : uiDefaults.drawerWidth;
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
      .gemini-summary-card{ position: relative !important; }
      .gemini-summary-btn-host{ position: relative !important; }
      .gemini-summary-card-btn{
        position:absolute;
        top:8px;
        right:8px;
        transform: translateY(0);
        z-index: 30;
        opacity: .94;
        pointer-events: auto;
        transition: opacity .12s ease-in-out, transform .12s ease-in-out;
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
      .gemini-summary-card-btn:hover{ background: rgba(15,15,16,.96); border-color: rgba(255,255,255,.22); }
      .gemini-summary-card-btn:focus-visible{
        outline: 2px solid rgba(255,255,255,.72);
        outline-offset: 1px;
      }
      .gemini-summary-btn-host:hover .gemini-summary-card-btn,
      .gemini-summary-btn-host:focus-within .gemini-summary-card-btn,
      .gemini-summary-card:hover .gemini-summary-card-btn,
      .gemini-summary-card:focus-within .gemini-summary-card-btn{
        opacity: 1;
        transform: translateY(-1px);
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  /* isSubscriptionsPage removed — buttons now appear on all YouTube pages */

  function toAbsoluteUrl(href){
    try{ return new URL(href, location.origin).toString(); }catch(e){ return ''; }
  }

  function normalizeVideoUrl(url){
    try{
      const u = new URL(url, location.origin);
      const videoId = getVideoIdFromUrl(u.toString());
      if(videoId) return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
      return u.toString();
    }catch(e){
      return String(url || '').trim();
    }
  }

  function normalizeUploadDate(value){
    const raw = String(value || '').trim();
    if(!raw) return '';
    if(/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    const d = new Date(raw);
    if(Number.isNaN(d.getTime())) return '';
    return d.toISOString().slice(0, 10);
  }

  function requestSummaryByUrl(url, title, channelName){
    if(summaryPending){
      showSummaryDrawer('Ozet zaten hazirlaniyor. Lutfen bekleyin.', title || 'Gemini ile ozetle', true);
      return;
    }
    const normalizedUrl = normalizeVideoUrl(url);
    if(!normalizedUrl) return;
    const vid = (function(){
      try{ return new URL(normalizedUrl).searchParams.get('v'); }catch(e){ return null; }
    })();
    const requestId = newRequestId();
    activeRequestId = requestId;
    pendingSummarySource = {
      requestId,
      source: 'card',
      url: normalizedUrl,
      videoId: vid || getVideoIdFromUrl(normalizedUrl),
      title: String(title || '').trim(),
      channelName: String(channelName || '').trim(),
      uploadDate: ''
    };
    setSummaryPending(true);
    showSummaryDrawer('Özet hazırlanıyor...', title || 'Gemini ile özetle', true);
    chrome.runtime.sendMessage({action:'summarize_url', url: normalizedUrl, title, videoId: vid, requestId}, (resp)=>{
      const runtimeError = chrome.runtime.lastError;
      if(runtimeError){
        setSummaryPending(false);
        showSummaryDrawer(runtimeError.message || 'Arka plan iletisi başarısız oldu.', 'Hata', false);
        return;
      }
      if(resp && resp.ok === false){
        setSummaryPending(false);
        showSummaryDrawer(resp.error || 'Özetleme isteği başarısız oldu.', 'Hata', false);
      }
    });
  }

  function hasSavableSummaryContext(){
    return !!(latestSummaryContext && typeof latestSummaryContext === 'object' && String(latestSummaryContext.summary || '').trim());
  }

  function getDrawerSaveButton(){
    return document.getElementById('gemini-drawer-save-btn');
  }

  function updateDrawerSaveButtonState(){
    const saveBtn = getDrawerSaveButton();
    if(!saveBtn) return;
    const canSave = !summaryPending && hasSavableSummaryContext();
    saveBtn.disabled = !canSave;
    saveBtn.style.opacity = canSave ? '1' : '0.58';
    saveBtn.style.cursor = canSave ? 'pointer' : 'not-allowed';
    saveBtn.title = canSave ? 'Son özeti kaydet' : 'Önce bir özet oluşturun';
  }

  function flashDrawerSaveButton(text, tone){
    const saveBtn = getDrawerSaveButton();
    if(!saveBtn) return;

    if(drawerSaveResetTimer){
      clearTimeout(drawerSaveResetTimer);
      drawerSaveResetTimer = null;
    }

    saveBtn.textContent = String(text || 'Kaydet');
    if(tone === 'ok'){
      saveBtn.style.borderColor = 'rgba(83,181,127,.65)';
      saveBtn.style.background = 'rgba(83,181,127,.16)';
    } else if(tone === 'error'){
      saveBtn.style.borderColor = 'rgba(230,96,96,.65)';
      saveBtn.style.background = 'rgba(230,96,96,.16)';
    } else {
      saveBtn.style.borderColor = 'rgba(255,255,255,.14)';
      saveBtn.style.background = 'rgba(255,255,255,.08)';
    }

    drawerSaveResetTimer = setTimeout(()=>{
      drawerSaveResetTimer = null;
      const btn = getDrawerSaveButton();
      if(!btn) return;
      btn.textContent = 'Kaydet';
      btn.style.borderColor = 'rgba(255,255,255,.14)';
      btn.style.background = 'rgba(255,255,255,.08)';
      updateDrawerSaveButtonState();
    }, 1500);
  }

  function saveCurrentSummaryFromDrawer(){
    if(summaryPending){
      flashDrawerSaveButton('Bekleyin', 'error');
      return;
    }

    const context = hasSavableSummaryContext() ? latestSummaryContext : null;
    if(!context){
      flashDrawerSaveButton('Önce özet', 'error');
      return;
    }

    const saveBtn = getDrawerSaveButton();
    if(saveBtn){
      saveBtn.disabled = true;
      saveBtn.style.opacity = '0.72';
      saveBtn.textContent = 'Kaydediliyor';
    }

    chrome.runtime.sendMessage({action:'save_analysis', record: context}, (resp)=>{
      const runtimeError = chrome.runtime.lastError;
      if(runtimeError){
        flashDrawerSaveButton('Hata', 'error');
        updateDrawerSaveButtonState();
        return;
      }

      if(resp && resp.ok){
        flashDrawerSaveButton('Kaydedildi', 'ok');
        updateDrawerSaveButtonState();
        return;
      }

      flashDrawerSaveButton('Hata', 'error');
      updateDrawerSaveButtonState();
    });
  }

  function openDashboardFromDrawer(){
    try{
      chrome.runtime.sendMessage({action:'open_dashboard'}, ()=>{});
    }catch(e){}
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
        const next = Math.max(320, Math.min(1440, dragStartWidth + delta));
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

      const actions = document.createElement('div');
      actions.style.display = 'flex';
      actions.style.alignItems = 'center';
      actions.style.gap = '8px';

      const save = document.createElement('button');
      save.id = 'gemini-drawer-save-btn';
      save.textContent = 'Kaydet';
      Object.assign(save.style,{
        cursor:'pointer',
        background:'rgba(255,255,255,.08)',
        color:'#f5f5f5',
        border:'1px solid rgba(255,255,255,.14)',
        borderRadius:'8px',
        padding:'8px 10px',
        fontSize:'14px',
        fontWeight:'700'
      });
      save.addEventListener('mouseenter', ()=>{ if(!save.disabled) save.style.background = 'rgba(255,255,255,.12)'; });
      save.addEventListener('mouseleave', ()=>{ if(!save.disabled) save.style.background = 'rgba(255,255,255,.08)'; });
      save.addEventListener('click', saveCurrentSummaryFromDrawer);
      actions.appendChild(save);

      const dashboard = document.createElement('button');
      dashboard.id = 'gemini-drawer-dashboard-btn';
      dashboard.textContent = 'Dashboard';
      Object.assign(dashboard.style,{
        cursor:'pointer',
        background:'rgba(255,255,255,.08)',
        color:'#f5f5f5',
        border:'1px solid rgba(255,255,255,.14)',
        borderRadius:'8px',
        padding:'8px 10px',
        fontSize:'14px'
      });
      dashboard.addEventListener('mouseenter', ()=>{ dashboard.style.background = 'rgba(255,255,255,.12)'; });
      dashboard.addEventListener('mouseleave', ()=>{ dashboard.style.background = 'rgba(255,255,255,.08)'; });
      dashboard.addEventListener('click', openDashboardFromDrawer);
      actions.appendChild(dashboard);

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
      actions.appendChild(close);
      header.appendChild(actions);
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
    updateDrawerSaveButtonState();
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

  const VIDEO_CARD_SELECTORS = [
    'ytd-rich-item-renderer',
    'ytd-video-renderer',
    'ytd-grid-video-renderer',
    'ytd-compact-video-renderer',
    'ytd-playlist-video-renderer',
    '.yt-lockup-view-model'
  ].join(', ');

  const VIDEO_LINK_SELECTORS = [
    'a#thumbnail[href*="/watch"]',
    'a#thumbnail[href*="/shorts/"]',
    'a#thumbnail[href*="/live/"]',
    'a#video-title[href*="/watch"]',
    'a#video-title[href*="/shorts/"]',
    'a#video-title-link[href*="/watch"]',
    'a#video-title-link[href*="/shorts/"]',
    'a.yt-lockup-metadata-view-model__title[href*="/watch"]',
    'a.yt-lockup-metadata-view-model__title[href*="/shorts/"]',
    'a.yt-lockup-view-model__content-image[href*="/watch"]',
    'a.yt-lockup-view-model__content-image[href*="/shorts/"]',
    'h3 a[href*="/watch"]',
    'h3 a[href*="/shorts/"]'
  ].join(', ');

  const BUTTON_HOST_SELECTORS = [
    'ytd-thumbnail',
    '.yt-lockup-view-model-wiz__content-image',
    '.yt-lockup-view-model__content-image'
  ].join(', ');

  function findVideoAnchorInCard(card){
    if(!card || !card.querySelector) return null;
    return card.querySelector(VIDEO_LINK_SELECTORS);
  }

  function getCardTitle(card){
    if(!card || !card.querySelector) return document.title.trim();
    const titleLink = card.querySelector(
      'a#video-title[title], a#video-title-link[title], a.yt-lockup-metadata-view-model__title[title], h3 a[title], #video-title, #video-title-link'
    );
    const text = titleLink && (titleLink.getAttribute('title') || titleLink.textContent || titleLink.getAttribute('aria-label'));
    return String(text || '').replace(/\s+/g, ' ').trim() || document.title.trim();
  }

  function resolveSummaryTargetFromCard(card){
    const anchor = findVideoAnchorInCard(card);
    const href = anchor && anchor.getAttribute ? (anchor.getAttribute('href') || '').trim() : '';
    const url = normalizeVideoUrl(toAbsoluteUrl(href));
    return { url: url || '', title: getCardTitle(card) };
  }

  function getButtonHostInCard(card){
    if(!card || !card.querySelector) return card;
    return card.querySelector(BUTTON_HOST_SELECTORS) || null;
  }

  function getCardChannelName(card){
    if(!card || !card.querySelector) return '';
    const channelNode = card.querySelector(
      'ytd-channel-name a, ytd-channel-name yt-formatted-string, #channel-name a, #channel-name yt-formatted-string, a.yt-lockup-metadata-view-model__metadata'
    );
    return String((channelNode && (channelNode.getAttribute?.('title') || channelNode.textContent)) || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function addButtonToVideoCard(card){
    try{
      if(!card || !card.querySelector) return;
      if(card.querySelector('.gemini-summary-card-btn')) return;

      const anchor = findVideoAnchorInCard(card);
      if(!anchor) return;
      const href = anchor.getAttribute ? (anchor.getAttribute('href') || '').trim() : '';
      const absHref = toAbsoluteUrl(href);
      if(!getVideoIdFromUrl(absHref)) return;

      ensureStyles();

      card.classList.add('gemini-summary-card');
      if(getComputedStyle(card).position === 'static') card.style.position = 'relative';

      const host = getButtonHostInCard(card);
      if(!host) return;
      if(host.querySelector('.gemini-summary-card-btn')) return;
      host.classList.add('gemini-summary-btn-host');
      if(getComputedStyle(host).position === 'static') host.style.position = 'relative';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'gemini-summary-card-btn';
      btn.textContent = 'Özetle';
      btn.setAttribute('aria-label', 'Gemini ile özetle');

      btn.addEventListener('click', (e)=>{
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        const target = resolveSummaryTargetFromCard(card);
        const targetChannel = getCardChannelName(card);
        requestSummaryByUrl(target.url, target.title, targetChannel);
      }, {capture:true});

      host.appendChild(btn);
    }catch(e){
      // ignore
    }
  }

  function scanVideoCards(){
    // Remove legacy buttons from older builds to avoid duplicate UI after extension reload.
    document.querySelectorAll('.gemini-summary-hover-btn').forEach((oldBtn)=>{
      try{ oldBtn.remove(); }catch(e){}
    });

    // Defensive cleanup: keep only one card button per valid host and remove orphaned leftovers.
    const hostToButton = new Map();
    document.querySelectorAll('.gemini-summary-card-btn').forEach((btn)=>{
      try{
        const host = btn.parentElement;
        if(!host || !host.closest(VIDEO_CARD_SELECTORS) || !host.matches(BUTTON_HOST_SELECTORS)){
          btn.remove();
          return;
        }
        if(hostToButton.has(host)){
          btn.remove();
          return;
        }
        hostToButton.set(host, btn);
      }catch(e){}
    });

    const cards = document.querySelectorAll(VIDEO_CARD_SELECTORS);
    const seenHosts = new Set();
    cards.forEach((card)=>{
      const host = getButtonHostInCard(card);
      if(!host || seenHosts.has(host)) return;
      seenHosts.add(host);
      addButtonToVideoCard(card);
    });
  }

  let scanTimer = null;
  function scheduleVideoCardScan(){
    if(scanTimer) return;
    scanTimer = setTimeout(()=>{
      scanTimer = null;
      scanVideoCards();
    }, 220);
  }

  // Observe DOM everywhere (home, subscriptions, search, channel, sidebar, etc.)
  const cardObserver = new MutationObserver(()=>{
    scheduleVideoCardScan();
  });
  cardObserver.observe(document.documentElement || document.body, {subtree:true, childList:true});

  // YouTube SPA navigations can replace content without full page reload.
  window.addEventListener('yt-navigate-finish', scheduleVideoCardScan, true);
  window.addEventListener('yt-page-data-updated', scheduleVideoCardScan, true);

  // initial scan
  scanVideoCards();

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
    if(self.GSVideoId && typeof self.GSVideoId.getVideoIdFromUrl === 'function'){
      return self.GSVideoId.getVideoIdFromUrl(url);
    }
    try{
      const u = new URL(url, location.origin);
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

  function getUploadDateFromPage(){
    try{
      const ipr = window.ytInitialPlayerResponse;
      const micro = ipr && ipr.microformat && ipr.microformat.playerMicroformatRenderer;
      const candidate = micro && (micro.uploadDate || micro.publishDate);
      const normalized = normalizeUploadDate(candidate);
      if(normalized) return normalized;
    }catch(e){}

    const meta = document.querySelector('meta[itemprop="datePublished"], meta[property="video:release_date"], meta[name="date"]');
    return normalizeUploadDate(meta && meta.getAttribute ? meta.getAttribute('content') : '');
  }

  function getChannelNameFromPage(){
    const node =
      document.querySelector('ytd-video-owner-renderer #channel-name a') ||
      document.querySelector('ytd-video-owner-renderer #channel-name yt-formatted-string') ||
      document.querySelector('ytd-channel-name a') ||
      document.querySelector('ytd-channel-name yt-formatted-string') ||
      document.querySelector('#upload-info ytd-channel-name a') ||
      null;
    return String((node && (node.getAttribute?.('title') || node.textContent)) || '').replace(/\s+/g, ' ').trim();
  }

  function isLikelyErrorSummary(text){
    const t = String(text || '').toLowerCase();
    if(!t) return true;
    return (
      t.includes('özetleme isteği başarısız') ||
      t.includes('ozetleme istegi basarisiz') ||
      t.includes('api key') ||
      t.includes('zaman asimina ugradi') ||
      t.includes('hata')
    );
  }

  async function getVideoContext(){
    const url = location.href;
    const videoId = getVideoIdFromUrl(url);
    if(!videoId){
      return { ok:false, error:'Bu sayfa bir YouTube video sayfasi degil. Bir video (watch/shorts/live) acip tekrar deneyin.', url };
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
      channelName: getChannelNameFromPage(),
      uploadDate: getUploadDateFromPage(),
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
      setSummaryPending(false);
      const resolvedUrl = String((msg && msg.videoUrl) || (pendingSummarySource && pendingSummarySource.url) || location.href || '').trim();
      const resolvedVideoId = (msg && msg.videoId) || (pendingSummarySource && pendingSummarySource.videoId) || getVideoIdFromUrl(resolvedUrl);
      const resolvedTitle = String((msg && msg.title) || (pendingSummarySource && pendingSummarySource.title) || getTitle() || document.title || '').trim();
      const resolvedChannel = String((msg && msg.channelName) || (pendingSummarySource && pendingSummarySource.channelName) || getChannelNameFromPage() || '').trim();
      const resolvedUploadDate = normalizeUploadDate((msg && msg.uploadDate) || (pendingSummarySource && pendingSummarySource.uploadDate) || getUploadDateFromPage() || '');
      const resolvedSummary = String(msg.summary || '').trim();

      if(!isLikelyErrorSummary(resolvedSummary)){
        latestSummaryContext = {
          summary: resolvedSummary,
          title: resolvedTitle,
          channelName: resolvedChannel,
          videoUrl: normalizeVideoUrl(resolvedUrl),
          videoId: resolvedVideoId || null,
          uploadDate: resolvedUploadDate || '',
          capturedAt: new Date().toISOString()
        };
      }

      showSummaryDrawer(msg.summary || JSON.stringify(msg), msg.title || document.title, false);
      pendingSummarySource = null;
      sendResponse({ok:true});
      return;
    }
    if(msg && msg.action === 'get_current_summary_context'){
      const context = latestSummaryContext && typeof latestSummaryContext === 'object' ? latestSummaryContext : null;
      if(!context){
        sendResponse({ok:false, error:'Kaydedilecek bir ozet bulunamadi. Once bir ozet olusturun.'});
        return;
      }
      sendResponse({ok:true, context});
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
            sendResponse({ok:false, error:'Bu sayfa bir YouTube video sayfasi degil. Bir video (watch/shorts/live) acip tekrar deneyin.', url});
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
          if(summaryPending){
            showSummaryDrawer('Ozet zaten hazirlaniyor. Lutfen bekleyin.', 'Gemini ile ozetle', true);
            sendResponse({ok:true, deduped:true});
            return;
          }
          setSummaryPending(true);
          showSummaryDrawer('Video bilgileri alınıyor...', 'Gemini ile özetle', true);
          const ctx = await getVideoContext();
          if(!ctx.ok){
            setSummaryPending(false);
            showSummaryDrawer(ctx.error || 'Video bilgisi alınamadı.', 'Hata', false);
            sendResponse({ok:false, error: ctx.error});
            return;
          }
          const requestId = newRequestId();
          activeRequestId = requestId;
          pendingSummarySource = {
            requestId,
            source: 'page',
            url: ctx.url,
            videoId: ctx.videoId,
            title: ctx.title,
            channelName: ctx.channelName || '',
            uploadDate: ctx.uploadDate || ''
          };
          showSummaryDrawer('Özet hazırlanıyor...', ctx.title, true);
          chrome.runtime.sendMessage({action:'summarize_content', context: ctx, requestId}, (resp)=>{
            const runtimeError = chrome.runtime.lastError;
            if(runtimeError){
              setSummaryPending(false);
              showSummaryDrawer(runtimeError.message || 'Arka plan iletisi başarısız oldu.', 'Hata', false);
              return;
            }
            if(resp && resp.ok === false){
              setSummaryPending(false);
              showSummaryDrawer(resp.error || 'Özetleme isteği başarısız oldu.', 'Hata', false);
            }
          });
          sendResponse({ok:true});
        } catch (e){
          setSummaryPending(false);
          showSummaryDrawer(String(e), 'Hata', false);
          sendResponse({ok:false, error: String(e)});
        }
      })();
      return true;
    }
  });

  window.__geminiRequestSummary = async ()=>{
    if(summaryPending){
      showSummaryDrawer('Ozet zaten hazirlaniyor. Lutfen bekleyin.', 'Gemini ile ozetle', true);
      return;
    }
    setSummaryPending(true);
    const ctx = await getVideoContext();
    if(!ctx.ok){
      setSummaryPending(false);
      showSummaryDrawer(ctx.error || 'Video bilgisi alınamadı.', 'Hata', false);
      return;
    }
    const requestId = newRequestId();
    activeRequestId = requestId;
    pendingSummarySource = {
      requestId,
      source: 'page',
      url: ctx.url,
      videoId: ctx.videoId,
      title: ctx.title,
      channelName: ctx.channelName || '',
      uploadDate: ctx.uploadDate || ''
    };
    showSummaryDrawer('Özet hazırlanıyor...', ctx.title, true);
    chrome.runtime.sendMessage({action:'summarize_content', context: ctx, requestId}, (resp)=>{
      const runtimeError = chrome.runtime.lastError;
      if(runtimeError){
        setSummaryPending(false);
        showSummaryDrawer(runtimeError.message || 'Arka plan iletisi başarısız oldu.', 'Hata', false);
        return;
      }
      if(resp && resp.ok === false){
        setSummaryPending(false);
        showSummaryDrawer(resp.error || 'Özetleme isteği başarısız oldu.', 'Hata', false);
      }
    });
  };
})();
