const cacheName = "MassiveHadron-TileStormEvolution-0.1.81";
const contentToCache = [
    "Build/a6fc887456e811a87ae2c783e9a903eb.loader.js",
    "Build/1b89d0b40af449f2624502e138cf511c.framework.js.unityweb",
    "Build/7d2f27956754b33d7caaa79d871e3266.data.unityweb",
    "Build/74174f8a1220083b16e9a99c1a694a08.wasm.unityweb",
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
