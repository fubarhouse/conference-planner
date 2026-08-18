// Service worker for the Conference Planner PWA. Makes the app installable and
// lets the shell (HTML/CSS/JS/fonts) load offline; the planner itself already
// keeps its data in localStorage, so once the shell is cached the trip planner
// works with no network. Best-effort throughout — a caching miss must never break
// a request, so every strategy falls back to the network (and vice versa).
//
// No build step: rather than maintain a precache manifest of every ES module, the
// shell is cached at runtime (stale-while-revalidate). Bump CACHE_VERSION to
// invalidate everything after a deploy.

const CACHE_VERSION = 'cp-v3';
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

// Warm the cache with the entry pages on install so a first offline launch works.
// Failures are ignored (e.g. an auth-gated page when signed out).
const PRECACHE_URLS = ['/', '/index.html'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(RUNTIME_CACHE)
      .then((cache) => Promise.allSettled(PRECACHE_URLS.map((u) => cache.add(u))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => !k.startsWith(CACHE_VERSION)).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

// Cache a response if it's usable (basic same-origin 200, or an opaque CDN
// response for fonts/icons). Clones because a Response body can only be read once.
function putInCache(request, response) {
  if (!request.url.startsWith('http')) return response; // Cache.put rejects chrome-extension:, data:, etc.
  if (!response || (response.status !== 200 && response.type !== 'opaque')) return response;
  const copy = response.clone();
  caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy));
  return response;
}

// Stale-while-revalidate: serve the cached copy immediately (if any) and refresh
// it in the background. Used for static assets — fast, and self-healing on deploy.
async function staleWhileRevalidate(request) {
  const cached = await caches.match(request);
  const network = fetch(request)
    .then((response) => putInCache(request, response))
    .catch(() => null);
  return cached || (await network) || fetch(request);
}

// Network-first: prefer fresh (navigations, API GETs), fall back to cache offline.
async function networkFirst(request) {
  try {
    return putInCache(request, await fetch(request));
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (request.mode === 'navigate') {
      const shell = await caches.match('/');
      if (shell) return shell;
    }
    throw new Error('offline and not cached');
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // never cache writes

  const url = new URL(request.url);

  // Only touch http(s). Browser extensions and the like issue chrome-extension:,
  // data:, etc. requests — leave them to the browser (Cache.put rejects them).
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // Same-origin — the app itself (HTML, JS modules, CSS, images, /api). Use
  // network-first so an online user ALWAYS gets the latest build; the cache is
  // only the offline fallback. (Cache-first / stale-while-revalidate would leave
  // the app one reload behind after every deploy — a real foot-gun for a
  // frequently-updated app, and how earlier tab additions went unseen.)
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(request));
    return;
  }

  // Cross-origin (Google Fonts, Font Awesome, CDN libs) rarely changes — serve it
  // fast from cache and refresh in the background.
  event.respondWith(staleWhileRevalidate(request));
});
