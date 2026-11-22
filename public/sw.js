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

  const path = url.href.slice(self.registration.scope.length);
  // 医学资产和跟踪模型交给 HTTP 缓存，避免 SW 缓存副本影响下载、进度与取消。
  const shell = /^(?:assets\/[^/?]+\.(?:js|css)|fonts\/[^/?]+\.woff2|branding\/neuroslice\.svg)$/.test(path);
  if (request.mode !== 'navigate' && !shell) return;

  let save = Promise.resolve();
  const response = (async () => {
    const cache = await caches.open(releaseCache);
    const cached = await cache.match(request);
    if (cached && request.mode !== 'navigate') return cached;
    try {
      const response = await fetch(request);
      const type = response.headers.get('content-type') ?? '';
      const html = type.includes('text/html');
      if (response.ok && !response.redirected && html === (request.mode === 'navigate')) {
        save = cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    } catch {
      return cached || Response.error();
    }
  })();
  event.respondWith(response);
  event.waitUntil(response.then(() => save));
});
