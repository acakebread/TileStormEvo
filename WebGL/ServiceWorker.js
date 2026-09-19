const cacheName = "MassiveHadron-TileStormEvolution-0.1.58";
const contentToCache = [
    "Build/86d6ee955da8846cc09e473bed8f5d34.loader.js",
    "Build/5a5ae46cd53a05e8f7f2404534ece93c.framework.js.unityweb",
    "Build/1d62f9d9f7ffb172e7ca0effcdbb6df9.data.unityweb",
    "Build/48248b0d834c2dd019f9d6baa0a1de26.wasm.unityweb",
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
