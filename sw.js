/* ------------------------------------------------------------------ *
   GVSI NetPulse — service worker

   Strategy
     • Apps Script API — direct, or through the edge proxy (window.NETPULSE_PROXY)
                              -> network only. Never cached here: the app owns
                                 its own data cache (dataCache + IndexedDB) and
                                 a stale API reply is worse than a slow one.
     • Navigations (index.html) -> network first, cache as the offline fallback.
     • Everything else static   -> stale-while-revalidate.

   Why SWR for the assets: the cached copy paints instantly, the fresh copy is
   fetched and stored in the background, and the NEXT load is current. That means
   an edit reaches the browser on its own — no need to bump STATIC_CACHE (or a
   ?v= token) every time a file changes.

   Why NOT SWR for the shell itself: the shell is the one file with no ?v= token
   to key a version on, and a 24/7 wall display may not load twice for days. SWR
   would serve it the old build and only STORE the new one — measured on the
   display, the running page had the build with the boot crash while the cache
   already held the fix. A display that is always online should just take the new
   bytes; offline still falls back to the cached shell.

   The versioned assets (?v=<ASSET_VERSION>) keep SWR on purpose: their name
   carries a token, so a release that changes them is expected to bump it.
 * ------------------------------------------------------------------ */

/* Bump this when a PRECACHE-ONLY asset changes. Icons and the manifest are never
   requested by the page, so stale-while-revalidate never touches them — they only
   refresh when a worker installs, and an install only happens when this file's own
   bytes change. Everything the page does request lands through SWR on its own, so
   this needs bumping for the icons, not for a CSS or module edit.

   Raising it costs nothing extra: `install` re-adds every entry above regardless,
   so the same bytes are fetched either way — a new name just makes the generation
   explicit and lets `activate` drop the old copy in one step. */
const STATIC_CACHE = 'gvsi-shell-v3.10.0';

/* Must match the ?v= token on the <script>/<link> tags in index.html.

   The precache has to warm the SAME keys the page asks for. Caching
   './nap-module.js' while the page requests './nap-module.js?v=3.10.0' stores a
   copy nobody ever reads, and quietly leaves the offline shell depending
   entirely on stale-while-revalidate. Keep the two in step. */
const ASSET_VERSION = '3.10.0';

/* The API's host when the app calls it through the edge proxy (window.NETPULSE_PROXY in
   index.html — see proxy/README.md).

   This MUST be in the network-only API branch below. With the proxy in front, the API's
   host is this one, and stale-while-revalidate here would hand a wall display a stale
   outage — the one thing it must never do. Keep it in step with index.html: 
   tests/proxy.test.js fails if the two disagree, in either direction, so a revert of
   NETPULSE_PROXY has to blank this too. */
const API_PROXY_HOST = 'holy-cloud-1d7a.jeremysamsonpanaligan.workers.dev';

// Requested without a version token.
const UNVERSIONED_ASSETS = [
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

// Requested by index.html as `<name>?v=<ASSET_VERSION>`.
const VERSIONED_ASSETS = [
  './styles.css',
  './kiosk.css',
  './nap-module.js',
  './lcp-module.js',
  './olt-module.js',
  './node-module.js',
  './backbone-module.js',
  './analytics-module.js',
  './admin-module.js',
  './kiosk-module.js',
  './db.js',
  './notifications.js',
  './cache-control.js',
  './last-good.js'
].map((file) => file + '?v=' + ASSET_VERSION);

const STATIC_ASSETS = UNVERSIONED_ASSETS.concat(VERSIONED_ASSETS);

/* Drop stale variants of the assets we manage — e.g. the unversioned URLs used
   before the ?v= token was mirrored here, or a copy left under an older token.
   They would otherwise sit in the cache forever, never read.

   Deliberately narrow: only keys whose *pathname* is a file we precache are
   considered, so unrelated entries like the stale-while-revalidate navigation
   copy of `index.html?kiosk=true` survive. Pruning is safe because anything
   still wanted is re-fetched on demand. */
function pruneStaleAssets() {
  const wanted = new Set(STATIC_ASSETS.map((u) => new URL(u, self.location).href));
  const managed = new Set(VERSIONED_ASSETS.map((u) => new URL(u, self.location).pathname));
  return caches.open(STATIC_CACHE)
    .then((cache) => cache.keys().then((reqs) =>
      Promise.all(
        reqs
          .filter((req) => {
            if (wanted.has(req.url)) return false;
            return managed.has(new URL(req.url).pathname);
          })
          .map((req) => cache.delete(req))
      )
    ))
    .catch(() => {});
}

/* Store a response only when it can safely be replayed. Errors, partial
   content (206) and opaque cross-origin replies are all skipped. */
function isCacheable(res) {
  return !!res && res.ok && res.status !== 206 && res.type !== 'opaque';
}

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      // Precache for offline-first startup. 'reload' bypasses the HTTP cache so a
      // fresh install never seeds itself from stale copies. Each file is added
      // independently — one missing asset must not fail the whole install.
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
    })
      .then(() => pruneStaleAssets())
      .then(() => self.clients.claim())
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

  // 1. Google Apps Script API -> ALWAYS NETWORK (fresh data).
  //    If it fails the app's own retry/backoff layer handles it — which is
  //    exactly why the catch matters. Unhandled, a stalled or mid-deploy
  //    response (this deployment throttles, and Google can answer with a page
  //    that has no CORS header) rejects here and surfaces in the console as an
  //    unhandled "Failed to fetch" that looks like a CORS misconfiguration.
  //    Converting it to a plain 503 lets fetchWithRetry classify and retry it.
  if (url.includes('script.google.com') || (API_PROXY_HOST && url.includes(API_PROXY_HOST))) {
    e.respondWith(
      fetch(e.request, { cache: 'no-store' }).catch(() => new Response(
        JSON.stringify({ offline: true, message: 'Network unavailable' }),
        {
          status: 503,
          statusText: 'Service Unavailable',
          headers: { 'Content-Type': 'application/json' }
        }
      ))
    );
    return;
  }

  // Only GET is cacheable.
  if (e.request.method !== 'GET') return;

  const cachePromise = caches.open(STATIC_CACHE);

  // 2. Navigations -> NETWORK FIRST, cache fallback. See the header for why the
  //    shell is the one thing that must not be a load behind.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      cachePromise.then((cache) => fetch(e.request, { cache: 'no-cache' })
        .then((res) => {
          if (isCacheable(res)) {
            cache.put(e.request, res.clone()).catch(() => {});
            return res;
          }
          // An error page or a 404: a known-good cached shell beats serving it.
          return cache.match(e.request).then((cached) => cached || res);
        })
        .catch(() => cache.match(e.request).then(
          (cached) => cached || new Response('', { status: 504, statusText: 'Offline' })
        ))
      )
    );
    return;
  }

  // 3. App shell / static assets -> STALE-WHILE-REVALIDATE.

  // Start the network request straight away so the refresh overlaps the paint.
  // 'no-cache' forces revalidation — that is what makes an edit actually land
  // instead of being served from a still-"fresh" HTTP cache entry.
  const networkPromise = fetch(e.request, { cache: 'no-cache' });

  e.respondWith(
    cachePromise.then((cache) =>
      cache.match(e.request).then((cached) => {
        const revalidate = networkPromise
          .then((res) => {
            if (isCacheable(res)) {
              // clone() before the body is read; a failed put must never matter.
              cache.put(e.request, res.clone()).catch(() => {});
            }
            return res;
          })
          .catch(() => null);

        if (cached) {
          // Serve from cache immediately, finish the refresh in the background.
          // waitUntil is valid here: respondWith keeps the event alive until
          // its promise settles.
          e.waitUntil(revalidate);
          return cached;
        }

        // Nothing cached yet -> wait for the network.
        return revalidate.then(
          (res) => res || new Response('', { status: 504, statusText: 'Offline' })
        );
      })
    )
  );
});
