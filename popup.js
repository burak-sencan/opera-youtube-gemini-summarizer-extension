document.getElementById('summarize').addEventListener('click', ()=>{
  chrome.tabs.query({active:true,currentWindow:true}, tabs=>{
    if(!tabs || !tabs[0]) return;
    const tabId = tabs[0].id;
    const msgEl = document.getElementById('msg');
    msgEl.textContent = 'Özet başlatılıyor...';

    let didFinish = false;
    const t = setTimeout(()=>{
      if(didFinish) return;
      msgEl.textContent = 'Video bilgileri alınamadı. YouTube video sayfasını (watch) açıp tekrar deneyin.';
    }, 3000);

    // Prefer: let content script run the full flow (shows drawer + triggers background)
    chrome.tabs.sendMessage(tabId, {action:'start_summary'}, (resp)=>{
      didFinish = true;
      clearTimeout(t);
      const lastErr = chrome.runtime.lastError;
      if(lastErr){
        msgEl.textContent = 'Bu sayfada çalışamadım. YouTube video sayfasını açıp tekrar deneyin.';
        return;
      }
      if(resp && resp.ok){
        msgEl.textContent = 'İstek gönderildi. Sonuç sayfada sağdan açılacak.';
      } else {
        msgEl.textContent = (resp && resp.error) ? resp.error : 'Özet başlatılamadı.';
      }
    });
  });
});

document.getElementById('openOptions').addEventListener('click', ()=>{
  chrome.runtime.openOptionsPage();
});
