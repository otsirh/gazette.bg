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

// A slow answer is replaced by the saved copy only when there is one;
// otherwise the reader waits for the network. The offline page stands in for
// pages alone: a summary or index the page fetches must never come back as
// HTML, or the page would show it as the summary.
async function networkFirst(request, { offlinePage = false } = {}) {
    const cache = await caches.open(PAGES);
    const network = fetch(request).then(async (response) => {
        if (response.ok) {
            await cache.put(request, response.clone());
            trim(cache);
        }
        return response;
    });
    // Settles on its own even if the saved copy is served instead.
    network.catch(() => {});
    const fallback = async () => {
        const saved = await cache.match(request, { ignoreSearch: true });
        if (saved) return saved;
        const offline = offlinePage ? await cache.match(OFFLINE) : null;
        return offline || Response.error();
    };
    try {
        const first = await Promise.race([
            network,
            new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT_MS, null)),
        ]);
        if (first) return first;
        return (await cache.match(request, { ignoreSearch: true })) || (await network);
    } catch {
        return fallback();
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
        event.respondWith(networkFirst(request, { offlinePage: true }));
    } else if (/^\/(fonts|src\/js|og)\//.test(url.pathname) || /\.(png|ico|svg)$/.test(url.pathname)) {
        event.respondWith(cacheFirst(request));
    } else if (/^\/issues\/|^\/(catalog|search-index)\.json$/.test(url.pathname)) {
        // The summaries and indexes the page fetches when moving between issues.
        event.respondWith(networkFirst(request));
    }
});
