const cacheName = "MassiveHadron-TileStormEvolution-0.1.5";
const contentToCache = [
    "Build/4d10a94a6b1fea45713b7d8fb2ef22ca.loader.js",
    "Build/60b51095c5878b43c4413d011dfaa435.framework.js.unityweb",
    "Build/6bc04875c63ecdd5f76445cb33cba65c.data.unityweb",
    "Build/48584e78ad329a70f606789c17edab4f.wasm.unityweb",
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
