const STATIC_CACHE = 'gvsi-shell-v2.3.2';
const STATIC_ASSETS = [
  './index.html',
  './styles.css',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
'./node-module.js', // <--- Idinagdag ang bagong JS file
'./backbone-module.js' // <--- Backbone Links Module
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== STATIC_CACHE) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = e.request.url;

  // 1. Google Apps Script API Requests -> ALWAYS NETWORK (Fresh Data)
  if (url.includes('script.google.com')) {
    e.respondWith(
      fetch(e.request, { cache: 'no-store' }).catch(() => fetch(e.request))
    );
  } else {
    // 2. Static Assets (App Shell) -> CACHE FIRST (Instant Load)
    e.respondWith(
      caches.match(e.request).then((cachedResponse) => {
        return cachedResponse || fetch(e.request).then((networkResponse) => {
          return caches.open(STATIC_CACHE).then((cache) => {
            cache.put(e.request, networkResponse.clone());
            return networkResponse;
          });
        });
      })
    );
  }
});