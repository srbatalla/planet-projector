// Offline support. Pages load network-first (a new deploy shows up as soon as it is online) and
// fall back to the cached shell; hashed build assets are cache-first, since a hash never changes.
// After each fresh page load, assets the new page no longer references are dropped.
const CACHE = 'planetary-patterns-v1';
const SHELL = ['./', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'favicon-64.png'];

/** Build assets referenced by an index.html (its entry script, stylesheet and preloads). */
function assetsIn(html) {
  const found = new Set();
  for (const match of html.matchAll(/(?:src|href)="([^"]*assets\/[^"]+)"/g)) {
    found.add(new URL(match[1], self.registration.scope).href);
  }
  return [...found];
}

async function cacheShell() {
  const cache = await caches.open(CACHE);
  await cache.addAll(SHELL);
  const page = await cache.match('./');
  if (page) {
    await cache.addAll(assetsIn(await page.text()));
  }
}

async function pruneAssets(cache, html) {
  const keep = new Set(assetsIn(html));
  for (const request of await cache.keys()) {
    if (request.url.includes('/assets/') && !keep.has(request.url)) {
      await cache.delete(request);
    }
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(cacheShell().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        try {
          const response = await fetch(request);
          if (response.ok) {
            const copy = response.clone();
            event.waitUntil(
              (async () => {
                const html = await copy.clone().text();
                await cache.put('./', copy);
                await cache.addAll(assetsIn(html));
                await pruneAssets(cache, html);
              })().catch(() => {})
            );
          }
          return response;
        } catch {
          return (await cache.match('./')) ?? Response.error();
        }
      })()
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(request, { ignoreSearch: true });
      if (cached) {
        return cached;
      }
      const response = await fetch(request);
      if (response.ok && url.pathname.includes('/assets/')) {
        event.waitUntil(cache.put(request, response.clone()));
      }
      return response;
    })()
  );
});
