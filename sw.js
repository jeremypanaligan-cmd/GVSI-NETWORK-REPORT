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
const STATIC_CACHE = 'gvsi-shell-v3.9.27';
const STATIC_ASSETS = [
  './index.html',
  './lucide-icons.js',
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
'./cache-store.js',
'./diag-store.js',
'./boot-bundle.js',
'./rev-watch.js',
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

/* A worker that is INSTALLED but not ACTIVATED holds a release back: the page keeps the
   old bytes, the new cache sits unused, and nothing on screen says so. `skipWaiting()` in
   `install` normally prevents that, but a device whose RUNNING worker predates these lines
   can still hold a new one in `waiting` — and a waiting worker stays waiting until every
   controlled tab goes away, which for an installed app that is never closed is never.

   index.html watches for that worker (and for one already waiting at launch) and posts
   this message. Answering it here is what turns the nudge into an activation, an
   `activate` that drops the old cache, a `controllerchange`, and a reload in the same
   launch — instead of an uninstall and reinstall. */
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
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
const API_PROXY_HOST = 'holy-cloud-1d7a.jeremysamsonpanaligan.workers.dev';

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
    return;
  }

  /* 2. THE RELEASE DOCUMENT -> ALWAYS NETWORK, and never stored.

     `version.json` is the one file whose cached answer would defeat its whole purpose. The
     page asks it "is a newer release published?" and a cache-first branch would answer with
     the release that was current when this device last asked — which is exactly the false
     "you are up to date" that keeps a device on yesterday's build. Never cached, not even as
     a fallback: an offline check should fail and be retried, never lie. */
  if (url.indexOf('version.json') !== -1) {
    e.respondWith(fetch(e.request, { cache: 'no-store' }));
    return;
  }

  /* 3. NAVIGATIONS -> NETWORK FIRST, with the cache only as the offline fallback.

     This is the branch that decides whether a release can arrive at all. A navigation was
     being answered cache-first and then PINNED under its own URL — and the manifest's
     `start_url` is a VERSIONED navigation (`index.html?v=3.9.19`), so the launch the OS
     performs for an installed app hit the pinned copy every single time. The page then kept
     the old `?v=` tokens inside it, which meant it kept asking for the old generation, which
     meant the one document that could have moved the device forward was the one document the
     cache refused to refresh. That is the deadlock an uninstall was breaking.

     `cache: 'no-cache'` rather than a plain fetch: it revalidates, so a changed shell is seen
     on that same launch (a 304 costs one small round trip when it has not changed), and the
     precached `./index.html` stays as the offline copy — refreshed at every install, which
     is also what makes it worth having. */
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request, { cache: 'no-cache' }).catch(() =>
        caches.match(e.request).then((c) => c || caches.match('./index.html'))
      )
    );
    return;
  }

  // 4. Static Assets (App Shell) -> CACHE FIRST (Instant Load)
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
});