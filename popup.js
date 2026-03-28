const msgEl = document.getElementById('msg');

function setMsg(text){
  msgEl.textContent = String(text || '');
}

function getActiveTab(){
  return new Promise((resolve)=>{
    chrome.tabs.query({active:true,currentWindow:true}, (tabs)=>{
      resolve((tabs && tabs[0]) ? tabs[0] : null);
    });
  });
}

function sendMessageToTab(tabId, payload){
  return new Promise((resolve)=>{
    chrome.tabs.sendMessage(tabId, payload, (resp)=>{
      const lastErr = chrome.runtime.lastError;
      if(lastErr){
        resolve({ok:false, error:lastErr.message || 'Tab ile iletisim hatasi'});
        return;
      }
      resolve(resp || {ok:false, error:'Bos yanit'});
    });
  });
}

async function handleSummarize(){
  const tab = await getActiveTab();
  if(!tab || typeof tab.id !== 'number'){
    setMsg('Aktif sekme bulunamadi.');
    return;
  }

  setMsg('Özet başlatılıyor...');
  const resp = await sendMessageToTab(tab.id, {action:'start_summary'});
  if(resp && resp.ok){
    setMsg('İstek gönderildi. Sonuç sayfada sağdan açılacak.');
    return;
  }

  setMsg((resp && resp.error) ? resp.error : 'Özet başlatılamadı.');
}

function handleOpenOptions(){
  chrome.runtime.openOptionsPage();
}

document.getElementById('summarize').addEventListener('click', handleSummarize);
document.getElementById('openOptions').addEventListener('click', handleOpenOptions);
