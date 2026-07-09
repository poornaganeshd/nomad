const CACHE_NAME = 'nomad-app-v12';
const APP_SHELL = ['/', '/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  // NO skipWaiting() here: taking over immediately fires controllerchange,
  // which main.jsx answers with a reload — yanking the app out from under the
  // user mid-scroll every time a deploy lands. The new SW now WAITS until the
  // user taps the "App updated — reload" banner, which posts SKIP_WAITING.
});

self.addEventListener('message', (event) => {
  // waitUntil keeps the just-woken waiting worker alive until skipWaiting
  // completes — without it the promotion can be silently dropped when the
  // worker is stopped right after the message handler returns.
  if (event.data === 'SKIP_WAITING') event.waitUntil(self.skipWaiting());
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

// ── Web Push ────────────────────────────────────────────────────────────────
// The server (send-reports cron / /api/push test) sends a JSON payload:
// { title, body, tag, url }. Render it as a system notification — this is what
// puts NOMAD reminders in the phone's notification shade with the app closed.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'NOMAD';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || 'nomad-reminder',
    renotify: !!data.tag,
    data: { url: data.url || '/' },
  }));
});

// Tap → focus an open NOMAD tab if there is one, else open a fresh one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});

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

