(function(global){
  function isAbortError(err){
    return !!(err && (err.name === 'AbortError' || /aborted|abort/i.test(String(err.message || ''))));
  }

  async function fetchJsonWithTimeout(url, options, timeoutMs){
    const controller = new AbortController();
    const ms = Number.isFinite(timeoutMs) ? timeoutMs : 30000;
    const handle = setTimeout(()=>{
      try{ controller.abort(); }catch(e){}
    }, ms);

    try{
      const merged = Object.assign({}, options || {}, {signal: controller.signal});
      const response = await fetch(url, merged);
      const data = await response.json().catch(()=>({}));
      return {response, data};
    }finally{
      clearTimeout(handle);
    }
  }

  global.GSBackgroundFetch = {
    fetchJsonWithTimeout,
    isAbortError
  };
})(self);