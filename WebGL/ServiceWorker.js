const cacheName = "MassiveHadron-TileStormEvolution-0.1.14";
const contentToCache = [
    "Build/85064dd0d596ad67c0d3dc4ecb20b0ce.loader.js",
    "Build/abd1e62ea9d4f67b1b533cd6ce5277c0.framework.js.unityweb",
    "Build/3462d8b4bd2440dbe014ad5a0b547c5a.data.unityweb",
    "Build/5b6ad5c0ba994252b116c011c41b9943.wasm.unityweb",
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
