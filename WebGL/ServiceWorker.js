const cacheName = "MassiveHadron-TileStormEvolution-0.1.60";
const contentToCache = [
    "Build/9540dbd3dfbf18f89c13581cede271d8.loader.js",
    "Build/2488e3bf9b4a797ce72cc02a9e581ef9.framework.js.unityweb",
    "Build/b800daeb76bc2e9f425dfbea68cd1baf.data.unityweb",
    "Build/74f7169f0f4fb85422ed568ec1b8b945.wasm.unityweb",
    "TemplateData/style.css"

];

const cacheablePrefixes = [
    `${self.location.origin}/Build/`,
    `${self.location.origin}/TemplateData/`
];

function shouldCache(request) {
    if (!request || request.method !== "GET")
        return false;

    if (request.url.startsWith("blob:") || request.url.startsWith("data:"))
        return false;

    return cacheablePrefixes.some(prefix => request.url.startsWith(prefix));
}

self.addEventListener('install', function (e) {
    console.log('[Service Worker] Install');
    
    e.waitUntil((async function () {
      const cache = await caches.open(cacheName);
      console.log('[Service Worker] Caching all: app shell and content');
      await cache.addAll(contentToCache);
    })());
});

self.addEventListener('activate', function (e) {
    e.waitUntil((async function () {
        const keys = await caches.keys();
        await Promise.all(keys.map(async key => {
            if (key !== cacheName)
                await caches.delete(key);
        }));
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', function (e) {
    if (!shouldCache(e.request))
        return;

    e.respondWith((async function () {
      let response = await caches.match(e.request);
      console.log(`[Service Worker] Fetching resource: ${e.request.url}`);
      if (response) { return response; }

      response = await fetch(e.request);
      if (!response || !response.ok)
        return response;

      const cache = await caches.open(cacheName);
      console.log(`[Service Worker] Caching new resource: ${e.request.url}`);
      cache.put(e.request, response.clone());
      return response;
    })());
});
