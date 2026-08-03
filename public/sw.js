/* Service worker: network-first for the app shell + code (so updates appear
   immediately, with the cache as an offline fallback), network-only for the
   API, plus web-push notification display. */
const CACHE = 'smartoneg-v5'; // bumped: boot splash + precache its logo
const SHELL = ['/', '/index.html', '/css/app.css', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return; // network-only
  // Network-first: always try the server (self-hosted, on the LAN — fast) so a
  // rebuilt app is picked up on the very next load; fall back to the cache only
  // when the network is unavailable, keeping the PWA usable offline.
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {}); }
      return res;
    }).catch(() => caches.match(e.request)),
  );
});

self.addEventListener('push', (e) => {
  const data = e.data?.json() ?? { title: 'Shabbos & Yom Tov Smart Home', body: '' };
  e.waitUntil(self.registration.showNotification(data.title, {
    body: data.body, icon: '/icons/apple-touch-icon.png', badge: '/icons/apple-touch-icon.png',
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.openWindow('/'));
});
