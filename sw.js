// Offline shell for the POS so the installed app opens without a connection.
const CACHE = 'pos-shell-v1';
const SHELL = ['/', '/index.html', '/app.js', '/lib/finance.js', '/lib/data.js', '/lib/barcode.js', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/fonts/cairo-arabic-400-normal.woff2', '/fonts/cairo-arabic-700-normal.woff2', '/fonts/cairo-latin-400-normal.woff2', '/fonts/cairo-latin-700-normal.woff2'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return; // sync writes must always reach the network
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // never serve stale sync data
  event.respondWith(
    fetch(request).then(response => {
      if (response && response.ok) {
        const copy = response.clone();
        caches.open(CACHE).then(cache => cache.put(request, copy)).catch(() => {});
      }
      return response;
    }).catch(() => caches.match(request).then(hit => hit || caches.match('/index.html')))
  );
});
