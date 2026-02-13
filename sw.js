'use strict';

const CACHE_NAME = 'gazette-bg-v1';
const SHELL_URLS = [
  '/',
  '/index.html',
  '/css/styles.css',
  '/js/app.js',
  '/favicon.svg',
  '/manifest.json'
];

// Install: cache app shell
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(SHELL_URLS);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

// Activate: take control and remove old caches
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys
          .filter(function (key) { return key !== CACHE_NAME; })
          .map(function (key) { return caches.delete(key); })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

// Fetch: cache-first for shell, network-first for data (catalog + issue JSON)
self.addEventListener('fetch', function (event) {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  const path = url.pathname;

  // App shell: cache-first
  if (
    path === '/' ||
    path === '/index.html' ||
    path === '/css/styles.css' ||
    path === '/js/app.js' ||
    path === '/favicon.svg' ||
    path === '/manifest.json'
  ) {
    event.respondWith(
      caches.match(event.request).then(function (cached) {
        return cached || fetch(event.request).then(function (res) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(event.request, clone);
          });
          return res;
        });
      })
    );
    return;
  }

  // Catalog and issue JSON: network-first, fallback to cache
  if (path === '/catalog.json' || (path.startsWith('/issues/') && path.endsWith('.json'))) {
    event.respondWith(
      fetch(event.request)
        .then(function (res) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(event.request, clone);
          });
          return res;
        })
        .catch(function () {
          return caches.match(event.request);
        })
    );
    return;
  }
});
