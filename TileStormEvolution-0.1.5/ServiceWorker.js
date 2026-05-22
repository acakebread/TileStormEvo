const cacheName = "MassiveHadron-TileStormEvolution-0.1.5";
const contentToCache = [
    "Build/23cc3c945cae1148b4afc7b979e309ad.loader.js",
    "Build/60b51095c5878b43c4413d011dfaa435.framework.js.unityweb",
    "Build/0882fc9fce61d23394ae4f7d23058d45.data.unityweb",
    "Build/13262135de8024130e9cb566d9c2c17a.wasm.unityweb",
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
