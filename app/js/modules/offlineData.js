// @ts-check
// Keeping the programme you were reading, when the network goes away.
//
// The service worker already caches same-origin GETs, but only once it CONTROLS
// the page — which it does not on the visit that registered it. Measured: opening
// a schedule for the first time and then losing connectivity leaves nothing
// cached, and reloading falls back to the app shell with no programme. That is
// precisely the conference-corridor case the PWA exists for.
//
// So the dataset is cached explicitly, by the page, on every successful load. It
// does not depend on the service worker being in control, or existing at all.
//
// The other half is honesty: a cached copy is shown WITH its age, never silently.
// A stale programme presented as current is worse than an error, because the
// reader acts on it.

/** Cache name, versioned so a format change cannot resurrect an old shape. */
export const DATA_CACHE = 'cp-data-v1';

/** Header carrying when we stored it — Response has nowhere else to put it. */
const SAVED_AT = 'x-cached-at';

/**
 * @typedef {object} LoadResult
 * @property {any} data the parsed JSON
 * @property {boolean} fromCache true when the network failed and this is a saved copy
 * @property {Date|null} savedAt when the cached copy was stored
 */

/** The Cache Storage API, or null where there isn't one (tests, file://, old browsers). */
function cacheApi(scope = globalThis) {
  return scope && 'caches' in scope ? scope.caches : null;
}

/**
 * Store a copy of a successful response body.
 *
 * Best-effort by design: a full disk or a private-mode restriction must never
 * turn a working page into a broken one.
 *
 * @param {string} url
 * @param {string} text raw JSON, stored verbatim
 * @param {object} [opts]
 * @param {*} [opts.scope] injectable global for tests
 * @param {Date} [opts.now]
 */
export async function saveCopy(url, text, { scope = globalThis, now = new Date() } = {}) {
  const caches = cacheApi(scope);
  if (!caches) return false;
  try {
    const cache = await caches.open(DATA_CACHE);
    await cache.put(
      url,
      new Response(text, {
        headers: { 'content-type': 'application/json', [SAVED_AT]: now.toISOString() },
      }),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a previously saved copy.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {*} [opts.scope]
 * @returns {Promise<{ data: any, savedAt: Date|null } | null>}
 */
export async function readCopy(url, { scope = globalThis } = {}) {
  const caches = cacheApi(scope);
  if (!caches) return null;
  try {
    const cache = await caches.open(DATA_CACHE);
    const hit = await cache.match(url);
    if (!hit) return null;
    const stamp = hit.headers.get(SAVED_AT);
    const at = stamp ? new Date(stamp) : null;
    return {
      data: JSON.parse(await hit.text()),
      savedAt: at && !Number.isNaN(at.getTime()) ? at : null,
    };
  } catch {
    // A corrupt entry is a cache miss, not an error to propagate.
    return null;
  }
}

/**
 * Fetch JSON, falling back to the last saved copy when the network fails.
 *
 * Throws only when BOTH fail — a caller that gets a resolved value can trust it,
 * and `fromCache` tells it whether to say so.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetchFn]
 * @param {*} [opts.scope]
 * @param {Date} [opts.now]
 * @returns {Promise<LoadResult>}
 */
export async function loadJson(url, { fetchFn, scope = globalThis, now = new Date() } = {}) {
  // Bound, not detached. `scope.fetch` pulled off the global and called bare
  // throws "Illegal invocation" in Chrome — the browser brand-checks `this`. Node
  // does not, so it passes every unit test and fails only in a real browser,
  // silently, because the throw lands in the catch below and looks like being
  // offline.
  const doFetch = fetchFn || scope.fetch.bind(scope);
  let networkError;
  try {
    const res = await doFetch(url, { cache: 'no-cache' });
    // An HTML error page parses as JSON in some setups and throws in others, and
    // neither means "this event has no programme". Check the status first.
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const data = JSON.parse(text);

    // A 200 does not mean "fresh". The service worker answers from its own cache
    // when the network is gone, and says so with this header — without it the app
    // shows a stale programme believing it is current, which is the one outcome
    // worse than showing nothing.
    if (res.headers.get('x-from-cache')) {
      const date = res.headers.get('date');
      const at = date ? new Date(date) : null;
      const usable = at && !Number.isNaN(at.getTime()) && at.getTime() > 0 ? at : null;
      // The worker's `date` is the ORIGINAL response's and is often absent or
      // unhelpful. Our own copy of the same URL carries the moment we stored it,
      // which is the honest answer to "how old is this?" — fall back to it rather
      // than shrug with "saved earlier".
      const own = usable ? null : await readCopy(url, { scope });
      return { data, fromCache: true, savedAt: usable || own?.savedAt || null };
    }

    await saveCopy(url, text, { scope, now });
    return { data, fromCache: false, savedAt: null };
  } catch (err) {
    networkError = err;
  }

  const cached = await readCopy(url, { scope });
  if (cached) return { data: cached.data, fromCache: true, savedAt: cached.savedAt };
  throw networkError;
}

/**
 * "saved 3 hours ago" — plain, and never pretends to more precision than it has.
 *
 * @param {Date|null} savedAt
 * @param {Date} [now]
 * @returns {string}
 */
export function savedAgo(savedAt, now = new Date()) {
  if (!savedAt) return 'saved earlier';
  const secs = Math.round((now.getTime() - savedAt.getTime()) / 1000);
  if (secs < 60) return 'saved just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `saved ${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `saved ${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `saved ${days} day${days === 1 ? '' : 's'} ago`;
}
