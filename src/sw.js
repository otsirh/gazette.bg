// Offline reading. Pages come from the network first, so a reader online
// always gets the current site; each page read is kept, and comes back from
// the cache when there is no connection. Fonts, scripts and pictures never
// change under the same address (see _headers), so they come from the cache.
// The build writes the version below; a new build replaces every cache.
const VERSION = '__VERSION__';
const PAGES = `pages-${VERSION}`;
const ASSETS = `assets-${VERSION}`;
const OFFLINE = '/offline/';
const PRECACHE = ['/', OFFLINE];
// Network first, but not forever: a slow connection gets the saved copy.
const NETWORK_TIMEOUT_MS = 4000;
const MAX_PAGES = 80;

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches
            .open(PAGES)
            .then((cache) => cache.addAll(PRECACHE))
            .then(() => self.skipWaiting()),
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches
            .keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== PAGES && k !== ASSETS).map((k) => caches.delete(k))))
            .then(() => self.clients.claim()),
    );
});

async function trim(cache) {
    const keys = await cache.keys();
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_PAGES))) await cache.delete(key);
}

async function networkFirst(request) {
    const cache = await caches.open(PAGES);
    try {
        const response = await Promise.race([
            fetch(request),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), NETWORK_TIMEOUT_MS)),
        ]);
        if (response.ok) {
            await cache.put(request, response.clone());
            trim(cache);
        }
        return response;
    } catch {
        return (await cache.match(request, { ignoreSearch: true })) || (await cache.match(OFFLINE)) || Response.error();
    }
}

async function cacheFirst(request) {
    const cache = await caches.open(ASSETS);
    const hit = await cache.match(request);
    if (hit) return hit;
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
}

self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;
    if (request.mode === 'navigate') {
        event.respondWith(networkFirst(request));
    } else if (/^\/(fonts|src\/js|og)\//.test(url.pathname) || /\.(png|ico|svg)$/.test(url.pathname)) {
        event.respondWith(cacheFirst(request));
    } else if (/^\/issues\/|^\/(catalog|search-index)\.json$/.test(url.pathname)) {
        // The summaries and indexes the page fetches when moving between issues.
        event.respondWith(networkFirst(request));
    }
});
