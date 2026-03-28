document.addEventListener('DOMContentLoaded', ()=>{
  const apikey = document.getElementById('apikey');
  const model = document.getElementById('model');
  const modelStatus = document.getElementById('modelStatus');
  const language = document.getElementById('language');
  const summaryFormat = document.getElementById('summaryFormat');
  const drawerFontSize = document.getElementById('drawerFontSize');
  const drawerWidth = document.getElementById('drawerWidth');
  const status = document.getElementById('status');

  function setModelStatus(text){
    if(!modelStatus) return;
    modelStatus.textContent = text || '';
  }

  function setModelOptions(models, rateLimitInfo){
    if(!model) return;
    const current = model.value || '';
    model.innerHTML = '';
    const optAuto = document.createElement('option');
    optAuto.value = '';
    optAuto.textContent = 'Otomatik (önerilen)';
    model.appendChild(optAuto);

    const now = Date.now();
    (models || []).forEach(m=>{
      const name = (m && m.name) ? String(m.name) : '';
      if(!name) return;
      const cleaned = name.replace(/^models\//, '');
      const opt = document.createElement('option');
      opt.value = cleaned;
      let label = cleaned;
      const entry = rateLimitInfo && rateLimitInfo[cleaned];
      if(entry && entry.unavailable){
        label = `${cleaned} (unavailable)`;
      } else 
      if(entry && entry.untilTs && entry.untilTs > now){
        const leftSec = Math.max(1, Math.ceil((entry.untilTs - now) / 1000));
        label = `${cleaned} (rate limit ~${leftSec}s)`;
      }
      opt.textContent = label;
      model.appendChild(opt);
    });
    model.value = current;
  }

  function refreshModels(){
    const key = (apikey.value || '').trim();
    if(!key){
      setModelStatus('Model listesi için önce API key girin.');
      setModelOptions([]);
      return;
    }

    setModelStatus('Modeller yükleniyor...');
    chrome.runtime.sendMessage({action:'list_models', apiKey: key}, (resp)=>{
      const lastErr = chrome.runtime.lastError;
      if(lastErr){
        setModelStatus('Modeller alınamadı. (Uzantıyı yeniden yükleyip tekrar deneyin)');
        return;
      }
      if(!resp || !resp.ok){
        setModelStatus((resp && resp.error) ? String(resp.error) : 'Modeller alınamadı.');
        return;
      }

      chrome.storage.local.get(['modelRateLimitInfo'], (cfg)=>{
        const info = (cfg && cfg.modelRateLimitInfo && typeof cfg.modelRateLimitInfo === 'object') ? cfg.modelRateLimitInfo : {};
        setModelOptions(resp.models || [], info);
        setModelStatus('');
      });
    });
  }

  let refreshTimer = null;
  function scheduleRefresh(){
    if(refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(()=>{
      refreshTimer = null;
      refreshModels();
    }, 400);
  }

  chrome.storage.local.get(['apiKey','apiModel','language','summaryFormat','drawerFontSize','drawerWidth'], cfg=>{
    apikey.value = cfg.apiKey || '';
    model.value = cfg.apiModel || '';
    language.value = cfg.language || 'Türkçe';
    summaryFormat.value = cfg.summaryFormat || 'simple';
    drawerFontSize.value = cfg.drawerFontSize || 15;
    drawerWidth.value = cfg.drawerWidth || 440;

    // Populate model list on load.
    refreshModels();
  });

  apikey.addEventListener('input', ()=>{
    scheduleRefresh();
  });

  document.getElementById('save').addEventListener('click', ()=>{
    const fontSizeNum = Math.max(12, Math.min(22, parseInt(drawerFontSize.value || '15', 10) || 15));
    const widthNum = Math.max(320, Math.min(1440, parseInt(drawerWidth.value || '440', 10) || 440));
    chrome.storage.local.set({
      apiKey: apikey.value.trim(),
      apiModel: (model && model.value ? model.value.trim() : ''),
      language: language.value.trim(),
      summaryFormat: summaryFormat.value,
      drawerFontSize: fontSizeNum,
      drawerWidth: widthNum
    }, ()=>{
      // Remove legacy keys from older versions (no longer used)
      try{ chrome.storage.local.remove(['apiEndpoint','apiVersion'], ()=>{}); }catch(e){}
      status.textContent = 'Kaydedildi.';
      setTimeout(()=>status.textContent='', 2000);
    });
  });
});
