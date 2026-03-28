(function(){
  const tabRecordsBtn = document.getElementById('tabRecordsBtn');
  const tabAnalysisBtn = document.getElementById('tabAnalysisBtn');
  const recordsTab = document.getElementById('recordsTab');
  const analysisTab = document.getElementById('analysisTab');

  const searchInput = document.getElementById('searchInput');
  const refreshBtn = document.getElementById('refreshBtn');
  const selectVisibleBtn = document.getElementById('selectVisibleBtn');
  const clearVisibleBtn = document.getElementById('clearVisibleBtn');
  const exportSelectedBtn = document.getElementById('exportSelectedBtn');
  const exportAllBtn = document.getElementById('exportAllBtn');
  const importBtn = document.getElementById('importBtn');
  const importFileInput = document.getElementById('importFileInput');
  const deleteSelectedBtn = document.getElementById('deleteSelectedBtn');
  const recordsTbody = document.getElementById('recordsTbody');
  const recordsStatus = document.getElementById('recordsStatus');
  const recordsMeta = document.getElementById('recordsMeta');

  const editTitle = document.getElementById('editTitle');
  const editChannel = document.getElementById('editChannel');
  const editVideoUrl = document.getElementById('editVideoUrl');
  const editUploadDate = document.getElementById('editUploadDate');
  const editSummary = document.getElementById('editSummary');
  const saveEditBtn = document.getElementById('saveEditBtn');
  const deleteActiveBtn = document.getElementById('deleteActiveBtn');
  const editStatus = document.getElementById('editStatus');

  const selectedList = document.getElementById('selectedList');
  const analysisMetrics = document.getElementById('analysisMetrics');
  const analysisPrompt = document.getElementById('analysisPrompt');
  const analysisPayload = document.getElementById('analysisPayload');
  const runAnalysisBtn = document.getElementById('runAnalysisBtn');
  const copyPayloadBtn = document.getElementById('copyPayloadBtn');
  const downloadPayloadBtn = document.getElementById('downloadPayloadBtn');
  const clearSelectionBtn = document.getElementById('clearSelectionBtn');
  const analysisResult = document.getElementById('analysisResult');
  const analysisResultRendered = document.getElementById('analysisResultRendered');
  const copyResultBtn = document.getElementById('copyResultBtn');
  const clearResultBtn = document.getElementById('clearResultBtn');
  const resultViewRenderedBtn = document.getElementById('resultViewRenderedBtn');
  const resultViewRawBtn = document.getElementById('resultViewRawBtn');
  const analysisStatus = document.getElementById('analysisStatus');
  const analysisSelectionStatus = document.getElementById('analysisSelectionStatus');

  const modeButtons = Array.from(document.querySelectorAll('.mode-btn[data-mode]'));
  const collapseButtons = Array.from(document.querySelectorAll('.collapse-btn[data-body-id]'));

  const ANALYSIS_MODE_PRESETS = {
    idea_timeline: {
      title: 'Fikir Evrimi',
      prompt: [
        'Secili kayitlari tarih sirasina gore incele.',
        'Ayni konuya yaklasimin zamanla nasil degistigini ortaya koy.',
        'Ilk donem ile son donem gorusleri arasindaki farki net karsilastir.',
        'Her kritik degisim icin ilgili video basliklariyla kisa kanit ekle.'
      ].join(' ')
    },
    consistency_map: {
      title: 'Tutarlilik Haritasi',
      prompt: [
        'Secili kayitlar icinde birbirini destekleyen ve celisen ifadeleri cikar.',
        'Konu bazli tutarlilik puani ve kisa gerekce ver.',
        'Varsa belirgin celiskileri madde madde yaz ve olasi nedenleri belirt.'
      ].join(' ')
    },
    argument_shift: {
      title: 'Arguman Donusumu',
      prompt: [
        'Konusmacinin ana argumanini donemlere ayir.',
        'Hangi donemlerde hangi gerekcelere yaslandigini goster.',
        'Donusum noktalarini ve bunlarin olasi tetikleyicilerini cikar.'
      ].join(' ')
    },
    risk_opportunity: {
      title: 'Risk ve Firsat',
      prompt: [
        'Kayitlardan cikan riskleri ve firsatlari ayri basliklarda topla.',
        'Etkisi yuksek maddeleri oncelik sirasina gore ver.',
        'Her madde icin kisa uygulanabilir oneri ekle.'
      ].join(' ')
    },
    custom: {
      title: 'Ozel Mod',
      prompt: ''
    }
  };

  const state = {
    records: [],
    query: '',
    selectedIds: new Set(),
    activeId: null,
    tab: 'records',
    analysisMode: 'idea_timeline',
    analysisBusy: false,
    resultView: 'rendered',
    collapsedBodies: {
      modePromptBody: false,
      payloadBody: false
    }
  };

  function setStatus(el, text){
    if(!el) return;
    el.textContent = String(text || '');
  }

  function sendBackground(payload){
    return new Promise((resolve)=>{
      chrome.runtime.sendMessage(payload, (resp)=>{
        const lastErr = chrome.runtime.lastError;
        if(lastErr){
          resolve({ok:false, error:lastErr.message || 'Arka plan iletisim hatasi'});
          return;
        }
        resolve(resp || {ok:false, error:'Bos yanit'});
      });
    });
  }

  function normalizeVideoDate(value){
    const raw = String(value || '').trim();
    if(!raw) return '';
    if(/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    const d = new Date(raw);
    if(Number.isNaN(d.getTime())) return '';
    return d.toISOString().slice(0, 10);
  }

  function formatDateTime(iso){
    try{
      const d = new Date(String(iso || ''));
      if(Number.isNaN(d.getTime())) return '-';
      return d.toLocaleString();
    }catch(e){
      return '-';
    }
  }

  function esc(value){
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderInlineMarkdown(text){
    let v = esc(text);

    v = v.replace(/`([^`]+)`/g, '<code>$1</code>');
    v = v.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    v = v.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    v = v.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

    return v;
  }

  function renderMarkdownToHtml(markdownText){
    const input = String(markdownText || '').replace(/\r\n/g, '\n').trim();
    if(!input) return '<p class="muted">Henuz analiz sonucu yok.</p>';

    const lines = input.split('\n');
    const out = [];
    let inUl = false;
    let inOl = false;

    const closeLists = ()=>{
      if(inUl){ out.push('</ul>'); inUl = false; }
      if(inOl){ out.push('</ol>'); inOl = false; }
    };

    for(const rawLine of lines){
      const line = String(rawLine || '');
      const t = line.trim();

      if(!t){
        closeLists();
        continue;
      }

      const h = t.match(/^(#{1,4})\s+(.+)$/);
      if(h){
        closeLists();
        const level = Math.min(4, h[1].length);
        out.push(`<h${level}>${renderInlineMarkdown(h[2])}</h${level}>`);
        continue;
      }

      const ul = t.match(/^[-*]\s+(.+)$/);
      if(ul){
        if(inOl){ out.push('</ol>'); inOl = false; }
        if(!inUl){ out.push('<ul>'); inUl = true; }
        out.push(`<li>${renderInlineMarkdown(ul[1])}</li>`);
        continue;
      }

      const ol = t.match(/^\d+\.\s+(.+)$/);
      if(ol){
        if(inUl){ out.push('</ul>'); inUl = false; }
        if(!inOl){ out.push('<ol>'); inOl = true; }
        out.push(`<li>${renderInlineMarkdown(ol[1])}</li>`);
        continue;
      }

      closeLists();
      out.push(`<p>${renderInlineMarkdown(t)}</p>`);
    }

    closeLists();
    return out.join('');
  }

  function summarizeText(value, limit){
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if(!text) return '-';
    if(text.length <= limit) return text;
    return `${text.slice(0, limit)}...`;
  }

  function updateRecordsMeta(){
    const total = state.records.length;
    const filtered = getFilteredRecords().length;
    const selected = state.selectedIds.size;
    recordsMeta.textContent = `Toplam: ${total} | Secili: ${selected} | Filtre: ${filtered}`;
  }

  function getFilteredRecords(){
    const q = state.query.trim().toLowerCase();
    if(!q) return state.records;
    return state.records.filter((row)=>{
      const blob = [row.title, row.channelName, row.summary, row.videoUrl, row.uploadDate]
        .join(' ')
        .toLowerCase();
      return blob.includes(q);
    });
  }

  function getSelectedRecords(){
    return state.records.filter((row)=> state.selectedIds.has(String(row.id || '')));
  }

  function downloadJson(fileName, data){
    const blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'});
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function getModeLabel(modeId){
    const mode = ANALYSIS_MODE_PRESETS[String(modeId || '').trim()];
    return mode ? mode.title : ANALYSIS_MODE_PRESETS.custom.title;
  }

  function getEffectivePrompt(){
    const typed = String(analysisPrompt.value || '').trim();
    if(typed) return typed;
    const preset = ANALYSIS_MODE_PRESETS[state.analysisMode] || ANALYSIS_MODE_PRESETS.custom;
    return String(preset.prompt || '').trim();
  }

  function buildAnalysisPayload(){
    const selected = getSelectedRecords();
    const channels = Array.from(new Set(selected.map((row)=> String(row.channelName || '').trim()).filter(Boolean)));
    const uploadDates = selected.map((row)=> normalizeVideoDate(row.uploadDate)).filter(Boolean).sort();

    return {
      generatedAt: new Date().toISOString(),
      mode: state.analysisMode,
      modeLabel: getModeLabel(state.analysisMode),
      prompt: getEffectivePrompt(),
      stats: {
        selectedCount: selected.length,
        uniqueChannelCount: channels.length,
        channels,
        minUploadDate: uploadDates.length ? uploadDates[0] : '',
        maxUploadDate: uploadDates.length ? uploadDates[uploadDates.length - 1] : ''
      },
      records: selected.map((row)=>({
        id: row.id,
        title: String(row.title || ''),
        channelName: String(row.channelName || ''),
        videoUrl: String(row.videoUrl || ''),
        videoId: String(row.videoId || ''),
        uploadDate: normalizeVideoDate(row.uploadDate),
        createdAt: row.createdAt,
        summary: String(row.summary || '')
      }))
    };
  }

  function renderModeButtons(){
    modeButtons.forEach((btn)=>{
      const mode = String(btn.dataset.mode || '').trim();
      btn.classList.toggle('active', mode === state.analysisMode);
    });
  }

  function setResultView(view){
    const next = view === 'raw' ? 'raw' : 'rendered';
    state.resultView = next;

    const isRendered = next === 'rendered';
    analysisResultRendered.classList.toggle('hidden', !isRendered);
    analysisResult.classList.toggle('hidden', isRendered);

    resultViewRenderedBtn.classList.toggle('active', isRendered);
    resultViewRawBtn.classList.toggle('active', !isRendered);
  }

  function renderAnalysisResult(){
    const text = String(analysisResult.value || '').trim();
    analysisResultRendered.innerHTML = renderMarkdownToHtml(text);
  }

  function setSectionCollapsed(bodyId, collapsed){
    const id = String(bodyId || '').trim();
    const body = document.getElementById(id);
    if(!body) return;

    const isCollapsed = !!collapsed;
    body.classList.toggle('collapsed', isCollapsed);
    state.collapsedBodies[id] = isCollapsed;

    const btn = document.querySelector(`.collapse-btn[data-body-id="${id}"]`);
    if(btn) btn.textContent = isCollapsed ? 'Genislet' : 'Daralt';
  }

  function renderAnalysisDetails(){
    const payload = buildAnalysisPayload();
    const stats = payload.stats || {};

    if(!payload.records.length){
      analysisMetrics.textContent = 'Secili kayit yok.';
      analysisPayload.value = '';
      return;
    }

    analysisMetrics.textContent = [
      `Mod: ${payload.modeLabel}`,
      `Secili kayit: ${stats.selectedCount || 0}`,
      `Kanal sayisi: ${stats.uniqueChannelCount || 0}`,
      `Ilk video tarihi: ${stats.minUploadDate || '-'}`,
      `Son video tarihi: ${stats.maxUploadDate || '-'}`
    ].join(' | ');

    analysisPayload.value = JSON.stringify(payload, null, 2);
  }

  function setActiveRecord(recordId){
    const id = String(recordId || '').trim();
    state.activeId = id || null;
    const row = state.records.find((item)=> String(item.id || '') === id) || null;

    editTitle.value = row ? String(row.title || '') : '';
    editChannel.value = row ? String(row.channelName || '') : '';
    editVideoUrl.value = row ? String(row.videoUrl || '') : '';
    editUploadDate.value = row ? String(normalizeVideoDate(row.uploadDate) || '') : '';
    editSummary.value = row ? String(row.summary || '') : '';

    renderRecordsTable();
  }

  function toggleSelection(id, checked){
    const key = String(id || '').trim();
    if(!key) return;

    if(checked) state.selectedIds.add(key);
    else state.selectedIds.delete(key);

    renderSelectedList();
    updateRecordsMeta();
  }

  function renderRecordsTable(){
    const rows = getFilteredRecords();
    if(!rows.length){
      recordsTbody.innerHTML = '<tr><td colspan="7" class="muted">Kayit bulunamadi.</td></tr>';
      return;
    }

    recordsTbody.innerHTML = rows.map((row)=>{
      const id = String(row.id || '');
      const checked = state.selectedIds.has(id) ? 'checked' : '';
      const activeClass = state.activeId === id ? 'active-row' : '';
      const title = esc(row.title || '(basliksiz)');
      const summary = esc(summarizeText(row.summary || '', 700));
      const channel = esc(row.channelName || '-');
      const uploadDate = esc(normalizeVideoDate(row.uploadDate) || '-');
      const createdAt = esc(formatDateTime(row.createdAt));
      const videoUrl = esc(row.videoUrl || '');

      return `
        <tr class="${activeClass}" data-record-id="${id}">
          <td><input type="checkbox" data-check-id="${id}" ${checked} /></td>
          <td><div class="title-cell" title="${title}">${title}</div></td>
          <td><div class="summary-snippet" title="${summary}">${summary}</div></td>
          <td><div class="meta-stack" title="${channel}">${channel}</div></td>
          <td><div class="meta-stack">${uploadDate}</div></td>
          <td><div class="meta-stack">${createdAt}</div></td>
          <td>
            <button class="btn" data-edit-id="${id}">Duzenle</button>
            ${videoUrl ? `<a class="btn table-action-link" target="_blank" rel="noopener" href="${videoUrl}">Ac</a>` : ''}
          </td>
        </tr>
      `;
    }).join('');
  }

  function renderSelectedList(){
    const selected = getSelectedRecords();
    if(!selected.length){
      selectedList.innerHTML = '<div class="muted">Henuz kayit secilmedi.</div>';
      setStatus(analysisSelectionStatus, 'Secili kayit: 0');
      renderAnalysisDetails();
      return;
    }

    selectedList.innerHTML = selected.map((row)=>{
      const uploadDate = normalizeVideoDate(row.uploadDate);
      return `
        <div class="record-chip">
          <div class="record-chip-title">${esc(row.title || '(basliksiz)')}</div>
          <div class="muted">${esc(row.channelName || '-')} | Video: ${esc(uploadDate || '-')} | Kayit: ${esc(formatDateTime(row.createdAt))}</div>
          <div class="record-chip-summary">${esc(summarizeText(row.summary || '', 440))}</div>
        </div>
      `;
    }).join('');

    setStatus(analysisSelectionStatus, `Secili kayit: ${selected.length}`);
    renderAnalysisDetails();
  }

  async function loadRecords(){
    setStatus(recordsStatus, 'Kayitlar yukleniyor...');
    const resp = await sendBackground({action:'list_analyses'});
    if(!resp || !resp.ok){
      setStatus(recordsStatus, (resp && resp.error) ? resp.error : 'Kayitlar alinamadi.');
      return;
    }

    state.records = Array.isArray(resp.records) ? resp.records : [];

    const known = new Set(state.records.map((r)=> String(r.id || '')));
    state.selectedIds = new Set(Array.from(state.selectedIds).filter((id)=> known.has(id)));
    if(state.activeId && !known.has(state.activeId)) state.activeId = null;

    renderRecordsTable();
    renderSelectedList();
    updateRecordsMeta();
    setStatus(recordsStatus, `Toplam kayit: ${state.records.length}`);

    if(!state.activeId && state.records.length){
      setActiveRecord(String(state.records[0].id || ''));
    } else {
      setActiveRecord(state.activeId);
    }
  }

  async function saveActiveRecord(){
    if(!state.activeId){
      setStatus(editStatus, 'Duzenlemek icin kayit secin.');
      return;
    }

    const payload = {
      id: state.activeId,
      title: editTitle.value,
      channelName: editChannel.value,
      videoUrl: editVideoUrl.value,
      uploadDate: normalizeVideoDate(editUploadDate.value),
      summary: editSummary.value
    };

    setStatus(editStatus, 'Kaydediliyor...');
    const resp = await sendBackground({action:'update_analysis', record: payload});
    if(!resp || !resp.ok){
      setStatus(editStatus, (resp && resp.error) ? resp.error : 'Guncelleme basarisiz.');
      return;
    }

    setStatus(editStatus, 'Kayit guncellendi.');
    await loadRecords();
  }

  async function deleteRecord(id){
    const key = String(id || '').trim();
    if(!key) return;

    const resp = await sendBackground({action:'delete_analysis', id: key});
    if(!resp || !resp.ok){
      setStatus(editStatus, (resp && resp.error) ? resp.error : 'Silme basarisiz.');
      return;
    }

    state.selectedIds.delete(key);
    if(state.activeId === key) state.activeId = null;
    await loadRecords();
    setStatus(editStatus, 'Kayit silindi.');
  }

  async function deleteSelectedRecords(){
    const ids = Array.from(state.selectedIds);
    if(!ids.length){
      setStatus(recordsStatus, 'Silinecek kayit secilmedi.');
      return;
    }

    if(!window.confirm(`${ids.length} kayit silinsin mi?`)) return;

    setStatus(recordsStatus, 'Secili kayitlar siliniyor...');
    for(const id of ids){
      // eslint-disable-next-line no-await-in-loop
      await sendBackground({action:'delete_analysis', id});
    }

    state.selectedIds.clear();
    if(state.activeId && !state.selectedIds.has(state.activeId)) state.activeId = null;
    await loadRecords();
    setStatus(recordsStatus, 'Secili kayitlar silindi.');
  }

  function selectVisibleRecords(){
    const rows = getFilteredRecords();
    rows.forEach((row)=>{
      const id = String(row && row.id || '').trim();
      if(id) state.selectedIds.add(id);
    });
    renderRecordsTable();
    renderSelectedList();
    updateRecordsMeta();
    setStatus(recordsStatus, `Filtredeki kayitlar secildi (${rows.length}).`);
  }

  function clearVisibleSelection(){
    const rows = getFilteredRecords();
    rows.forEach((row)=> state.selectedIds.delete(String(row && row.id || '').trim()));
    renderRecordsTable();
    renderSelectedList();
    updateRecordsMeta();
    setStatus(recordsStatus, 'Filtre secimi temizlendi.');
  }

  function exportSelectedRecords(){
    const selected = getSelectedRecords();
    if(!selected.length){
      setStatus(recordsStatus, 'Disa aktarim icin secili kayit yok.');
      return;
    }
    downloadJson(`analiz-kayitlari-secili-${Date.now()}.json`, {records: selected});
    setStatus(recordsStatus, `Secili kayitlar disa aktarildi (${selected.length}).`);
  }

  function exportAllRecords(){
    if(!state.records.length){
      setStatus(recordsStatus, 'Disa aktarim icin kayit yok.');
      return;
    }
    downloadJson(`analiz-kayitlari-tumu-${Date.now()}.json`, {records: state.records});
    setStatus(recordsStatus, `Tum kayitlar disa aktarildi (${state.records.length}).`);
  }

  async function importRecordsFromFile(file){
    if(!file) return;

    let parsed;
    try{
      parsed = JSON.parse(await file.text());
    }catch(e){
      setStatus(recordsStatus, 'JSON parse edilemedi.');
      return;
    }

    const rows = Array.isArray(parsed)
      ? parsed
      : (parsed && Array.isArray(parsed.records) ? parsed.records : []);
    if(!rows.length){
      setStatus(recordsStatus, 'Ice aktarim dosyasinda kayit bulunamadi.');
      return;
    }

    setStatus(recordsStatus, `Kayitlar ice aktariliyor (${rows.length})...`);
    let imported = 0;
    for(const row of rows){
      // eslint-disable-next-line no-await-in-loop
      const resp = await sendBackground({action:'save_analysis', record: row});
      if(resp && resp.ok) imported++;
    }

    await loadRecords();
    setStatus(recordsStatus, `Ice aktarim tamamlandi. Basarili: ${imported}/${rows.length}`);
  }

  function switchTab(tab){
    const next = tab === 'analysis' ? 'analysis' : 'records';
    state.tab = next;

    tabRecordsBtn.classList.toggle('active', next === 'records');
    tabAnalysisBtn.classList.toggle('active', next === 'analysis');
    recordsTab.classList.toggle('hidden', next !== 'records');
    analysisTab.classList.toggle('hidden', next !== 'analysis');

    if(next === 'analysis') renderSelectedList();
  }

  async function copyAnalysisPayload(){
    const payload = buildAnalysisPayload();
    if(!payload.records.length){
      setStatus(analysisStatus, 'Once kayitlar sekmesinden en az 1 kayit secin.');
      return;
    }

    const text = JSON.stringify(payload, null, 2);

    try{
      await navigator.clipboard.writeText(text);
      setStatus(analysisStatus, 'Veri paketi panoya kopyalandi.');
    }catch(e){
      const fallback = document.createElement('textarea');
      fallback.value = text;
      document.body.appendChild(fallback);
      fallback.select();
      document.execCommand('copy');
      fallback.remove();
      setStatus(analysisStatus, 'Veri paketi kopyalandi (fallback).');
    }
  }

  function downloadAnalysisPayload(){
    const payload = buildAnalysisPayload();
    if(!payload.records.length){
      setStatus(analysisStatus, 'JSON indirmek icin secili kayit yok.');
      return;
    }
    downloadJson(`analiz-payload-${Date.now()}.json`, payload);
    setStatus(analysisStatus, 'Payload JSON indirildi.');
  }

  function clearSelection(){
    state.selectedIds.clear();
    renderRecordsTable();
    renderSelectedList();
    updateRecordsMeta();
    setStatus(analysisStatus, 'Secimler temizlendi.');
  }

  function setBusyAnalysis(isBusy){
    state.analysisBusy = !!isBusy;
    runAnalysisBtn.disabled = state.analysisBusy;
    runAnalysisBtn.style.opacity = state.analysisBusy ? '0.7' : '1';
    runAnalysisBtn.textContent = state.analysisBusy ? 'Analiz Suruyor...' : 'Gemini ile Analiz Et';
  }

  async function runGeminiAnalysis(){
    if(state.analysisBusy) return;

    const payload = buildAnalysisPayload();
    if(!payload.records.length){
      setStatus(analysisStatus, 'Analiz icin once kayit secin.');
      return;
    }

    const prompt = String(payload.prompt || '').trim();
    if(!prompt){
      setStatus(analysisStatus, 'Analiz promptu bos olamaz. Bir mod secin veya ozel prompt yazin.');
      return;
    }

    setSectionCollapsed('modePromptBody', true);
    setSectionCollapsed('payloadBody', true);

    setBusyAnalysis(true);
    setStatus(analysisStatus, 'Gemini analizi baslatildi...');

    const resp = await sendBackground({
      action: 'analyze_records',
      mode: payload.mode,
      prompt,
      records: payload.records
    });

    setBusyAnalysis(false);

    if(!resp || !resp.ok){
      setStatus(analysisStatus, (resp && resp.error) ? resp.error : 'Analiz basarisiz oldu.');
      return;
    }

    analysisResult.value = String(resp.analysis || '');
    renderAnalysisResult();
    setResultView('rendered');

    const metaParts = [];
    if(typeof resp.includedCount === 'number' && typeof resp.totalCount === 'number'){
      metaParts.push(`Kayit: ${resp.includedCount}/${resp.totalCount}`);
    }
    if(resp.truncated) metaParts.push('Icerik kisaltilarak gonderildi');
    if(resp.modeLabel) metaParts.push(`Mod: ${resp.modeLabel}`);

    setStatus(analysisStatus, metaParts.length ? `Analiz tamamlandi. ${metaParts.join(' | ')}` : 'Analiz tamamlandi.');
  }

  async function copyAnalysisResult(){
    const text = String(analysisResult.value || '').trim();
    if(!text){
      setStatus(analysisStatus, 'Kopyalanacak analiz sonucu yok.');
      return;
    }

    try{
      await navigator.clipboard.writeText(text);
      setStatus(analysisStatus, 'Analiz sonucu panoya kopyalandi.');
    }catch(e){
      const fallback = document.createElement('textarea');
      fallback.value = text;
      document.body.appendChild(fallback);
      fallback.select();
      document.execCommand('copy');
      fallback.remove();
      setStatus(analysisStatus, 'Analiz sonucu kopyalandi (fallback).');
    }
  }

  function clearAnalysisResult(){
    analysisResult.value = '';
    renderAnalysisResult();
    setStatus(analysisStatus, 'Analiz sonucu temizlendi.');
  }

  function selectAnalysisMode(modeId, {keepPrompt} = {keepPrompt:false}){
    const mode = String(modeId || '').trim();
    if(!Object.hasOwn(ANALYSIS_MODE_PRESETS, mode)) return;

    state.analysisMode = mode;
    renderModeButtons();

    if(!keepPrompt){
      const nextPrompt = String(ANALYSIS_MODE_PRESETS[mode].prompt || '').trim();
      analysisPrompt.value = nextPrompt;
    }

    renderAnalysisDetails();
  }

  recordsTbody.addEventListener('click', (event)=>{
    const target = event.target;
    if(!target) return;

    if(target.closest('[data-check-id]')) return;

    if(target.matches('[data-edit-id]')){
      const id = target.getAttribute('data-edit-id');
      setActiveRecord(id);
      return;
    }

    if(target.closest('a[href]')) return;

    const row = target.closest('tr[data-record-id]');
    if(row){
      const id = row.getAttribute('data-record-id');
      setActiveRecord(id);
    }
  });

  recordsTbody.addEventListener('change', (event)=>{
    const target = event.target;
    if(!target || !target.matches('[data-check-id]')) return;
    toggleSelection(target.getAttribute('data-check-id'), !!target.checked);
  });

  searchInput.addEventListener('input', ()=>{
    state.query = searchInput.value || '';
    renderRecordsTable();
    updateRecordsMeta();
  });

  analysisPrompt.addEventListener('input', ()=>{
    renderAnalysisDetails();
  });

  modeButtons.forEach((btn)=>{
    btn.addEventListener('click', ()=>{
      const mode = String(btn.dataset.mode || '').trim();
      selectAnalysisMode(mode, {keepPrompt:false});
    });
  });

  collapseButtons.forEach((btn)=>{
    btn.addEventListener('click', ()=>{
      const bodyId = String(btn.dataset.bodyId || '').trim();
      if(!bodyId) return;
      const current = !!state.collapsedBodies[bodyId];
      setSectionCollapsed(bodyId, !current);
    });
  });

  resultViewRenderedBtn.addEventListener('click', ()=>setResultView('rendered'));
  resultViewRawBtn.addEventListener('click', ()=>setResultView('raw'));

  refreshBtn.addEventListener('click', loadRecords);
  selectVisibleBtn.addEventListener('click', selectVisibleRecords);
  clearVisibleBtn.addEventListener('click', clearVisibleSelection);
  exportSelectedBtn.addEventListener('click', exportSelectedRecords);
  exportAllBtn.addEventListener('click', exportAllRecords);
  importBtn.addEventListener('click', ()=> importFileInput.click());

  importFileInput.addEventListener('change', async ()=>{
    const file = importFileInput.files && importFileInput.files[0];
    await importRecordsFromFile(file);
    importFileInput.value = '';
  });

  deleteSelectedBtn.addEventListener('click', deleteSelectedRecords);

  saveEditBtn.addEventListener('click', saveActiveRecord);
  deleteActiveBtn.addEventListener('click', async ()=>{
    if(!state.activeId){
      setStatus(editStatus, 'Silmek icin kayit secin.');
      return;
    }
    if(!window.confirm('Aktif kayit silinsin mi?')) return;
    await deleteRecord(state.activeId);
  });

  tabRecordsBtn.addEventListener('click', ()=>switchTab('records'));
  tabAnalysisBtn.addEventListener('click', ()=>switchTab('analysis'));

  runAnalysisBtn.addEventListener('click', runGeminiAnalysis);
  copyPayloadBtn.addEventListener('click', copyAnalysisPayload);
  downloadPayloadBtn.addEventListener('click', downloadAnalysisPayload);
  clearSelectionBtn.addEventListener('click', clearSelection);
  copyResultBtn.addEventListener('click', copyAnalysisResult);
  clearResultBtn.addEventListener('click', clearAnalysisResult);

  selectAnalysisMode('idea_timeline', {keepPrompt:false});
  setSectionCollapsed('modePromptBody', false);
  setSectionCollapsed('payloadBody', false);
  setResultView('rendered');
  renderAnalysisResult();
  loadRecords();
})();
