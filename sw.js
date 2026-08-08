self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(clients.claim());
});

self.addEventListener('fetch', (e) => {
  // Piliting mag-fetch sa network nang walang HTTP cache
  e.respondWith(
    fetch(e.request, { cache: 'no-store' }).catch(() => fetch(e.request))
  );
});
