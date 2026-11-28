// The site no longer keeps anything on the reader's device without being
// asked (ЗЕТ чл. 4а), so there is no offline copy any more. This worker
// stays at the same address only to undo the one that browsers installed
// before: it deletes every cache it made and unregisters itself.
const VERSION = '__ASSET_VERSION__';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches
            .keys()
            .then((keys) => Promise.all(keys.filter((k) => k.startsWith('live-')).map((k) => caches.delete(k))))
            .then(() => self.registration.unregister()),
    );
});

void VERSION;
