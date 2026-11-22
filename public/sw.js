const cachePrefix = 'neuroslice-ar:';
const releaseCache = cachePrefix + 'shell-v2:__BUILD__';

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

  const path = url.pathname.slice(new URL(self.registration.scope).pathname.length);
  const navigation = request.mode === 'navigate' && (path === '' || path === 'index.html');
  // 仅处理工作站入口。影像、标注和其他资源走浏览器原生 HTTP 缓存和响应流。
  const shell = /^(?:assets\/index-[\w-]+\.(?:js|css)|fonts\/[^/]+\.woff2|branding\/neuroslice\.svg)$/.test(path);
  if (!navigation && !shell) return;

  let save = Promise.resolve();
  const response = (async () => {
    const cache = await caches.open(releaseCache);
    const cached = await cache.match(request);
    if (cached && !navigation) return cached;
    try {
      const response = await fetch(request);
      const type = response.headers.get('content-type') ?? '';
      const html = type.includes('text/html');
      if (response.ok && !response.redirected && html === navigation) {
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
