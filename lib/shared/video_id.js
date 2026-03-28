(function(global){
  function getVideoIdFromUrl(url){
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
    const id = String(videoId || '').trim();
    return id ? `https://www.youtube.com/watch?v=${encodeURIComponent(id)}` : '';
  }

  global.GSVideoId = {
    getVideoIdFromUrl,
    buildCanonicalWatchUrl
  };
})(self);