// @ts-check
// Schedule routing — paths, not query strings.
//
//   /schedules                        the selection screen (browse)
//   /schedules/<slug>                 that schedule
//   /schedules/<slug>/calendar.ics    that schedule's subscription feed
//   /schedules/<slug>/subscribe       an alias for the feed, for humans to type
//
// The query form (`index.html?id=<slug>`) is NOT legacy to be tidied away — it
// is the form the app speaks when served as plain files, which is a supported
// deployment. Both are first class; `usePathRouting()` says which one this page
// is currently speaking, and the redirects that join them exist only when the
// Node server is running.
//
// Pure: reads a location shape, returns strings. History calls live in events.js.

/** The feed filename. A calendar client is happier with a real `.ics`. */
export const FEED_FILE = 'calendar.ics';

/**
 * @param {string} pathname
 * @returns {string[]}
 */
function segments(pathname) {
  return String(pathname || '')
    .split('/')
    .filter(Boolean);
}

/**
 * Is this page served at a `/schedules` path (rather than opened as
 * `index.html` from a static host or the file system)?
 *
 * @param {string} pathname
 * @returns {boolean}
 */
export function usePathRouting(pathname) {
  return segments(pathname)[0] === 'schedules';
}

/**
 * What this URL asks for. The path wins where it says anything — it is the more
 * specific statement — and the query fills in the rest, so
 * `/schedules/my-event?theme=dark` works.
 *
 * `view` is 'browse' for the bare section address, 'feed' for the subscription
 * endpoint, and 'schedule' for a named schedule.
 *
 * @param {{pathname?: string, search?: string}} [loc]
 * @returns {{slug: string|null, file: string|null, view: 'browse'|'schedule'|'feed'}}
 */
export function parseScheduleRoute(loc = {}) {
  const segs = segments(loc.pathname || '');
  const params = new URLSearchParams(loc.search || '');

  let slug = null;
  /** @type {'browse'|'schedule'|'feed'} */
  let view = 'schedule';

  if (segs[0] === 'schedules') {
    if (segs[1]) slug = decodeURIComponent(segs[1]);
    else view = 'browse';
    if (segs[2] === FEED_FILE || segs[2] === 'subscribe') view = 'feed';
  }

  // `?event=` carries a dataset FILENAME, which cannot be a path segment
  // without reading as a file — so it stays in the query, like the planner's.
  const file = params.get('event');
  if (!slug) slug = params.get('id');
  if (!slug && !file && params.get('browse')) view = 'browse';

  return { slug: slug || null, file: file || null, view };
}

/**
 * The address for a schedule.
 *
 * @param {string|null} slug
 * @param {{pathRouting?: boolean, base?: string, feed?: boolean, params?: Record<string,string>}} [opts]
 * @returns {string}
 */
export function scheduleHref(slug, opts = {}) {
  const pathRouting =
    opts.pathRouting ??
    (typeof location !== 'undefined' ? usePathRouting(location.pathname) : false);
  const base = opts.base ?? (pathRouting ? '/schedules' : './index.html');
  const extra = new URLSearchParams(opts.params || {});

  if (pathRouting) {
    const parts = ['/schedules'];
    if (slug) parts.push(encodeURIComponent(slug));
    if (slug && opts.feed) parts.push(FEED_FILE);
    const q = extra.toString();
    return parts.join('/') + (q ? `?${q}` : '');
  }

  // Static form. There is no path to hang `calendar.ics` off, so the feed keeps
  // the query endpoint it already had.
  if (opts.feed) {
    if (slug) extra.set('id', slug);
    const q = extra.toString();
    return `./schedule.ics${q ? `?${q}` : ''}`;
  }
  if (slug) extra.set('id', slug);
  const q = extra.toString();
  return `${base}${q ? `?${q}` : ''}`;
}

/**
 * The subscription URL for a schedule, as `webcal://` so a calendar client
 * takes it directly. Falls back to the http(s) form when there is no origin
 * (tests, file://).
 *
 * @param {string} slug
 * @param {{origin?: string, pathRouting?: boolean}} [opts]
 * @returns {string}
 */
export function scheduleFeedUrl(slug, opts = {}) {
  const origin = opts.origin ?? (typeof location !== 'undefined' ? location.origin : '');
  const href = scheduleHref(slug, { feed: true, pathRouting: opts.pathRouting });
  if (!origin) return href;
  const abs = new URL(href, origin).toString();
  return abs.replace(/^https?:/, 'webcal:');
}

/**
 * The breadcrumb trail for a schedule view — the route, rendered. Same contract
 * as the planner and archive, so the three sections read alike.
 *
 * @param {{slug?: string|null, name?: string|null, view?: string}} [view]
 * @returns {Array<{label: string, href?: string}>}
 */
export function scheduleCrumbs(view = {}) {
  /** @type {Array<{label: string, href?: string}>} */
  const trail = [{ label: 'Home', href: './home.html' }];
  const atRoot = !view.slug;
  trail.push({ label: 'Schedules', ...(atRoot ? {} : { href: scheduleHref(null) }) });
  if (view.slug) trail.push({ label: view.name || view.slug });
  return trail;
}
