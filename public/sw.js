const cachePrefix = 'neuroslice-ar:';
const releaseCache = cachePrefix + '__BUILD__';

self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  const names = await caches.keys();
  await Promise.all(names.filter(name => name.startsWith(cachePrefix) && name !== releaseCache)
    .map(name => caches.delete(name)));
  await self.clients.claim();
})()));

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || request.headers.has('range') ||
      !url.href.startsWith(self.registration.scope)) return;

  event.respondWith((async () => {
    const cache = await caches.open(releaseCache);
    const cached = await cache.match(request);
    if (cached && request.mode !== 'navigate') return cached;
    try {
      const response = await fetch(request);
      if (response.ok) {
        await cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    } catch {
      return cached || Response.error();
    }
  })());
});
