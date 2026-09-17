const cacheName = "MassiveHadron-TileStormEvolution-0.1.50";
const contentToCache = [
    "Build/45487669ac62c60dbb0f21abc9d230c5.loader.js",
    "Build/0839b589450c859983c75ded7bfe3bc6.framework.js.unityweb",
    "Build/4762563ef42dffcecdc0b7488c982b60.data.unityweb",
    "Build/5042befd6025224c453613a545918108.wasm.unityweb",
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
