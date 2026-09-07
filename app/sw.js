// Service worker for the Conference Planner PWA. Makes the app installable and
// lets the shell (HTML/CSS/JS/fonts) load offline; the planner itself already
// keeps its data in localStorage, so once the shell is cached the trip planner
// works with no network. Best-effort throughout — a caching miss must never break
// a request, so every strategy falls back to the network (and vice versa).
//
// No build step: rather than maintain a precache manifest of every ES module, the
// shell is cached at runtime (stale-while-revalidate). Bump CACHE_VERSION to
// invalidate everything after a deploy.

const CACHE_VERSION = 'cp-v4';
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

// Warm the cache with the entry pages on install so a first offline launch works.
// Failures are ignored (e.g. an auth-gated page when signed out).
const PRECACHE_URLS = ['/', '/index.html'];

// Which shell can render which route, for the offline navigation fallback below.
// Longest-lived first; anything unmatched falls back to '/'.
const SHELL_FOR = [
  { test: (p) => p === '/schedule' || p.startsWith('/schedules/'), shell: '/index.html' },
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(RUNTIME_CACHE)
      .then((cache) => Promise.allSettled(PRECACHE_URLS.map((u) => cache.add(u))))
      .then(() => self.skipWaiting()),
  );
});

// Saved programmes (app/js/modules/offlineData.js writes here). Kept in step by
// name — if that constant changes, change this one.
//
// It MUST survive the cleanup below. The sweep deletes every cache that is not
// the current version, which silently included this one: a schedule was saved for
// offline use and deleted seconds later, on the same page load, by the worker
// activating. The write succeeded, so nothing looked wrong; the copy was just
// never there when it was needed.
//
// It is also deliberately NOT version-prefixed. A deploy should not throw away the
// programme somebody is standing in a corridor reading.
const DATA_CACHE = 'cp-data-v1';

const KEEP_CACHES = (name) => name.startsWith(CACHE_VERSION) || name === DATA_CACHE;

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !KEEP_CACHES(k)).map((k) => caches.delete(k))))
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

// Mark a response as having come from the cache rather than the network.
//
// Without this the fallback is INVISIBLE to the page: fetch() resolves 200 with a
// stale body and the app cannot tell it is showing yesterday's programme. The
// schedule labels an offline copy with its age, and it can only do that if it
// knows. `date` is the original response's, so it doubles as "how old".
function markFromCache(response) {
  const headers = new Headers(response.headers);
  headers.set('x-from-cache', '1');
  if (!headers.has('date')) headers.set('date', new Date(0).toUTCString());
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// Network-first: prefer fresh (navigations, API GETs), fall back to cache offline.
async function networkFirst(request) {
  try {
    return putInCache(request, await fetch(request));
  } catch {
    const cached = await caches.match(request);
    if (cached) return markFromCache(cached);
    if (request.mode === 'navigate') {
      // Fall back to the shell that can RENDER the requested route, not simply
      // to '/'. A deep schedule URL (/schedules/<slug>) is served by index.html;
      // answering it with the home page offline is why "reload the schedule you
      // were reading" landed on a page with no programme — measured, not assumed.
      // The client re-resolves the slug from the cached catalog and dataset.
      const path = new URL(request.url).pathname;
      const shell = await caches.match(SHELL_FOR.find((s) => s.test(path))?.shell || '/');
      if (shell) return shell;
      const home = await caches.match('/');
      if (home) return home;
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
