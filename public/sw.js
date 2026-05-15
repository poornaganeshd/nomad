const CACHE_NAME = 'nomad-app-v9';
const APP_SHELL = ['/', '/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

const cacheResponse = async (request, response) => {
  // Only cache responses we can actually inspect. Opaque responses (cross-origin
  // no-cors) may be huge or be cached errors — they evict the app shell silently.
  if (!response || !response.ok || response.type === 'opaque') return response;
  const cache = await caches.open(CACHE_NAME);
  cache.put(request, response.clone());
  return response;
};

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const { request } = event;
  const isNavigation = request.mode === 'navigate';
  const isSameOrigin = new URL(request.url).origin === self.location.origin;
  const isAsset = ['style', 'script', 'worker', 'font', 'image'].includes(request.destination);

  if (isNavigation || (isSameOrigin && isAsset && ['style', 'script', 'worker'].includes(request.destination))) {
    event.respondWith(
      fetch(request)
        .then((response) => cacheResponse(request, response))
        .catch(async () => (await caches.match(request)) || (isNavigation ? caches.match('/') : undefined))
    );
    return;
  }

  if (isSameOrigin || isAsset) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const networkFetch = fetch(request)
          .then((response) => cacheResponse(request, response))
          .catch(() => cached);
        return cached || networkFetch;
      })
    );
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const focused = clients.find(c => c.focused) || clients[0];
      if (focused) return focused.focus();
      return self.clients.openWindow('/');
    })
  );
});

self.addEventListener('push', (event) => {
  let payload = { title: 'NOMAD', body: '', tag: 'nomad-push', requireInteraction: false };
  try { if (event.data) payload = { ...payload, ...event.data.json() }; } catch {}
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: payload.tag,
      requireInteraction: payload.requireInteraction,
      data: { url: '/' },
    })
  );
});
