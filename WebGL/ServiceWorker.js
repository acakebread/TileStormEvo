const cacheName = "MassiveHadron-TileStormEvolution-0.1.3";
const contentToCache = [
    "Build/fd3aba90c37ca6186d79a278346f3c97.loader.js",
    "Build/9e39d385f3ef5e10a4a72a247f874074.framework.js.unityweb",
    "Build/d22f68c27d043f5fa4f079ca88d45802.data.unityweb",
    "Build/cd5804eb46599b8ebed1e2bae01ccf8e.wasm.unityweb",
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
