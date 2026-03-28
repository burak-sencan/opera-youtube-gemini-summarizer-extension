// Analysis storage and helper functions extracted from background.js

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
  const rows = Array.isArray(records) ? records.slice() : [];
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

// Helper functions used from background.js but defined here
function normalizeVideoUploadDate(value){
  const raw = String(value || '').trim();
  if(!raw) return '';
  if(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(raw)) return raw;
  const d = new Date(raw);
  if(Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

function trimPromptSection(text, maxChars){
  const value = String(text || '').trim();
  if(!value || value.length <= maxChars) return { text: value, truncated: false };
  return { text: `${value.slice(0, maxChars)}\n\n...(kısaltıldı)`, truncated: true };
}

// Expose analysis helpers globally for backward compatibility
try{
  self.GSAnalysis = {
    storageGet, storageSet, cleanRecordText,
    normalizeAnalyzeMode, getAnalyzeModeDefinition,
    buildAnalysisInputText, buildAnalyzePrompt,
    normalizeIsoDate, makeRecordId, normalizeAnalysisRecord,
    loadAnalysisRecords, saveAnalysisRecords, insertAnalysisRecord,
    updateAnalysisRecord, deleteAnalysisRecord,
    normalizeVideoUploadDate, trimPromptSection
  };

  for(const k of Object.keys(self.GSAnalysis)){
    if(typeof self.GSAnalysis[k] === 'function' && !self[k]){
      self[k] = self.GSAnalysis[k];
    }
  }
}catch(e){}
