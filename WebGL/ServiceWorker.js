const cacheName = "MassiveHadron-TileStormEvolution-0.1.5";
const contentToCache = [
    "Build/e4fb9db110463708dd3745ce6d412e7e.loader.js",
    "Build/5de88da418c52e9cdbe0fe5e6783efc4.framework.js.unityweb",
    "Build/94310ae65dad5ca0f4df2f9ffebf60f9.data.unityweb",
    "Build/dbf913342c20f09b007ec494146ceb84.wasm.unityweb",
    "TemplateData/style.css"

];

self.addEventListener('install', function (e) {
    console.log('[Service Worker] Install');
    
    e.waitUntil((async function () {
      const cache = await caches.open(cacheName);
      console.log('[Service Worker] Caching all: app shell and content');
      await cache.addAll(contentToCache);
    })());
});

self.addEventListener('fetch', function (e) {
    e.respondWith((async function () {
      let response = await caches.match(e.request);
      console.log(`[Service Worker] Fetching resource: ${e.request.url}`);
      if (response) { return response; }

      response = await fetch(e.request);
      const cache = await caches.open(cacheName);
      console.log(`[Service Worker] Caching new resource: ${e.request.url}`);
      cache.put(e.request, response.clone());
      return response;
    })());
});
