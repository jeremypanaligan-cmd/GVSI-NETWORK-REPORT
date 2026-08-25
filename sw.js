const STATIC_CACHE = 'gvsi-shell-v3.2.2';
const STATIC_ASSETS = [
  './index.html',
  './styles.css',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
'./nap-module.js',
'./lcp-module.js',
'./olt-module.js',
'./node-module.js',
'./backbone-module.js',
'./analytics-module.js',
'./db.js',
'./notifications.js'
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

// Push Notification Handler
self.addEventListener('push', (e) => {
  let data = { title: 'GVSI NetPulse', body: 'New incident detected' };
  if (e.data) {
    try { data = e.data.json(); } catch (err) { data.body = e.data.text(); }
  }
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: './icon-192.png',
      badge: './icon-192.png',
      tag: data.tag || 'netpulse-alert',
      data: data.data || {}
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window' }).then(clientList => {
      if (clientList.length > 0) {
        clientList[0].focus();
      } else {
        clients.openWindow('./index.html');
      }
    })
  );
});

self.addEventListener('fetch', (e) => {
  const url = e.request.url;

  // Skip non-http(s) requests (chrome-extension, file:, etc.)
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return;
  }

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