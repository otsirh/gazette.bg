// Offline reading for live.gazette.bg. Pages are fetched from the network
// first, so a reader online always sees the newest version; the copy kept
// here is used only when there is no connection. Fonts, styles, scripts and
// icons never change under the same address, so they come from the cache.
const CACHE = 'live-v1';
const OFFLINE_PAGES = 40;

self.addEventListener('install', (e) => {
    e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/style.css', '/live.js'])));
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches
            .keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
            .then(() => self.clients.claim()),
    );
});

async function trim(cache) {
    const pages = (await cache.keys()).filter((r) => r.mode === 'navigate' || r.url.endsWith('/'));
    for (const r of pages.slice(0, Math.max(0, pages.length - OFFLINE_PAGES))) await cache.delete(r);
}

self.addEventListener('fetch', (e) => {
    const req = e.request;
    const url = new URL(req.url);
    if (req.method !== 'GET' || url.origin !== location.origin) return;
    // Live data is never served from the cache.
    if (url.pathname === '/version.json' || url.pathname === '/state.json') return;
    if (req.mode === 'navigate') {
        e.respondWith(
            fetch(req)
                .then(async (res) => {
                    if (res.ok) {
                        const cache = await caches.open(CACHE);
                        await cache.put(req, res.clone());
                        trim(cache);
                    }
                    return res;
                })
                .catch(async () => (await caches.match(req)) ?? (await caches.match('/')) ?? Response.error()),
        );
        return;
    }
    if (/^\/(fonts|icons)\//.test(url.pathname) || /\.(css|js)$/.test(url.pathname)) {
        e.respondWith(
            caches.match(req).then(
                (hit) =>
                    hit ??
                    fetch(req).then(async (res) => {
                        if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
                        return res;
                    }),
            ),
        );
    }
});
