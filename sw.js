/* The cache generation this release installs under. It follows the app version, because
   the page asks for every file with that version in its URL (`styles.css?v=3.9.2`): a
   device that still holds a cache of this name misses on all of them and re-fetches, and
   `install` rewrites the precache entries below in place with `cache: 'reload'` regardless.

   So a name only has to be NEW when a publish changes files WITHOUT moving the label:
   then the copy cached under the same name is exactly the copy the page asks for again,
   and nothing evicts it. That is why commit fe3459c shipped generation v3.9.4 while the
   label stayed 3.9.1, and why this release can take the name back to the label. A publish
   has to move the label, or the generation, or both — never neither.

   Delivery depends on it being cache-first, because the precache list holds the
   UNVERSIONED names the page requests (`admin-module.js`, not `admin-module.js?v=...`),
   so for those files `install` re-fetching every entry and `activate` deleting every
   other cache is the whole delivery mechanism. */
const STATIC_CACHE = 'gvsi-shell-v3.9.6';
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
'./admin-module.js',
'./db.js',
'./fetch-gate.js',
'./notifications.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      // 'reload' bypasses the HTTP cache, so a new generation can never seed itself
      // with the copy the browser is still holding — a plain addAll can, and then the
      // "update" installs the old bytes under the new name.
      //
      // Each entry is added independently: one missing or slow file must not fail the
      // whole install, which would leave the device on the OLD worker (and, with a
      // cache-first strategy, on every old file it had already cached).
      return Promise.all(
        STATIC_ASSETS.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch(() => {})
        )
      );
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

/* The API's host when the app calls it through the edge proxy (window.NETPULSE_PROXY in
   index.html — see proxy/README.md).

   This MUST be excluded below. This worker is CACHE-FIRST for everything that is not
   `script.google.com`, so with the proxy in front the API's host is this one — and a
   cache-first branch would hand a wall display a STALE OUTAGE, the one thing it must
   never show. It is the same reasoning that put this file's API branch first in the
   newer tree; here it is two values that have to be changed together, so: the pair is
   `NETPULSE_PROXY` in index.html and this constant.

   BLANK while the proxy is off (2026-09-15): the app calls `script.google.com` directly
   again and that rule above already covers it. Set this back in the same step that
   `NETPULSE_PROXY` in index.html is restored — never one without the other. */
const API_PROXY_HOST = '';

self.addEventListener('fetch', (e) => {
  const url = e.request.url;

  // Skip non-http(s) requests (chrome-extension, file:, etc.)
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return;
  }

  // 1. Google Apps Script API Requests -> ALWAYS NETWORK (Fresh Data)
  if (url.includes('script.google.com') || (API_PROXY_HOST && url.includes(API_PROXY_HOST))) {
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