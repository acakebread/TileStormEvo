const productCachePrefix = "MassiveHadron-TileStormEvolution-";
const buildVersion = "0.1.144";
const scopeUrl = new URL("./", self.location.href).href;
const cachePrefix = `TileStorm-build-v2:${scopeUrl}:${productCachePrefix}`;
const cacheName = cachePrefix + buildVersion;
// Cache only resources requested by the player. Preloading the whole build at
// install time downloads it alongside Unity and can temporarily double buffers.
// Unity's own IndexedDB data cache already owns the large .data response.
const contentToCache = [
    "Build/52052c770ae80b066e6dbf1a86e3eab7.loader.js",
    "Build/ab4fba60d16bec24c20b66587e3d6732.framework.js.unityweb",
    "Build/641b782cb5c039e5fff82bb55dc2f204.wasm.unityweb",
    "TemplateData/style.css"

];

const cacheableUrls = new Set(contentToCache.map(path => new URL(path, scopeUrl).href));

function cacheKey(request) {
    if (!request || request.method !== "GET")
        return null;

    if (request.url.startsWith("blob:") || request.url.startsWith("data:"))
        return null;

    const url = new URL(request.url);
    // Never turn arbitrary query strings into additional copies of a build.
    if ([...url.searchParams.keys()].some(key => key !== "v"))
        return null;
    if (url.pathname.includes("/Build/") && url.searchParams.has("v")
        && url.searchParams.get("v") !== buildVersion)
        return null;
    url.search = "";
    return cacheableUrls.has(url.href) ? url.href : null;
}

self.addEventListener('activate', function (e) {
    e.waitUntil((async function () {
        const keys = await caches.keys();
        await Promise.all(keys.map(async key => {
            if (key.startsWith(cachePrefix) && key !== cacheName) {
                await caches.delete(key);
            } else if (key.startsWith(productCachePrefix)) {
                // Migrate the old unscoped cache only when all its entries
                // belong to this deployment. Never delete another app's cache.
                const legacyCache = await caches.open(key);
                const requests = await legacyCache.keys();
                if (requests.length > 0 && requests.every(request => request.url.startsWith(scopeUrl)))
                    await caches.delete(key);
            }
        }));
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', function (e) {
    const key = cacheKey(e.request);
    if (!key)
        return;

    const responsePromise = (async function () {
      let cache = null;
      try {
        cache = await caches.open(cacheName);
        const response = await cache.match(key);
        if (response) return { response, cache, hit: true };
      } catch (error) {
        // Storage may be unavailable or full. The game must still load.
        cache = null;
      }
      return { response: await fetch(e.request), cache, hit: false };
    })();

    // Register the write with the event lifetime so the browser doesn't abandon
    // it when the page leaves. Consume both branches of the response promptly.
    e.waitUntil(responsePromise.then(async ({ response, cache, hit }) => {
      if (hit || !cache || !response || !response.ok) return;
      try {
        await cache.put(key, response.clone());
      } catch (error) {
        console.warn('[Service Worker] Build cache write failed; continuing without caching.', error);
      }
    }).catch(() => {}));
    e.respondWith(responsePromise.then(({ response }) => response));
});
