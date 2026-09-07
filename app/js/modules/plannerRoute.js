// @ts-check
// Planner routing — paths, not query strings.
//
//   /planner                    the selection screen
//   /planner/<slug>             that planner, on its default tab
//   /planner/<slug>/<tab>       that planner, on that tab
//
// The query form (`planner.html?id=<slug>&tab=<tab>`) is NOT legacy support to
// be tidied away later — it is the form the app uses when it is served as plain
// files, which is a supported way to run it. So both are first class, and
// `usePathRouting()` decides which one this page is speaking.
//
// Everything here is pure: it reads a location shape and returns strings. The
// history calls live in planner.js, where the state they describe lives.

/**
 * Segments of a pathname, empty ones dropped.
 * @param {string} pathname
 * @returns {string[]}
 */
function segments(pathname) {
  return String(pathname || '')
    .split('/')
    .filter(Boolean);
}

/**
 * Is this page being served at a `/planner` path (as opposed to opened as
 * `planner.html` from a file system or a static sub-directory)?
 *
 * @param {string} pathname
 * @returns {boolean}
 */
export function usePathRouting(pathname) {
  const segs = segments(pathname);
  return segs[0] === 'planner';
}

/**
 * The planner key and tab this URL asks for. The path wins where it says
 * anything, because it is the more specific statement; the query fills in what
 * the path leaves out, so `/planner/my-trip?tab=budget` works too.
 *
 * @param {{pathname?: string, search?: string}} [loc]
 * @returns {{key: string|null, tab: string|null}}
 */
export function parsePlannerRoute(loc = {}) {
  const segs = segments(loc.pathname || '');
  const params = new URLSearchParams(loc.search || '');

  let key = null;
  let tab = null;

  if (segs[0] === 'planner') {
    if (segs[1]) key = decodeURIComponent(segs[1]);
    if (segs[2]) tab = decodeURIComponent(segs[2]);
  }

  // `?event=` carries a dataset FILENAME (`drupalcon-us-2025.json`), not a slug.
  // A dot-suffixed path segment reads as a file to servers and to people, so
  // those keys keep the query form — see `plannerHref`.
  if (!key) key = params.get('event') || params.get('id') || null;
  if (!tab) tab = params.get('tab') || null;

  return { key, tab };
}

/**
 * The address for a planner (and optionally a tab).
 *
 * @param {string|null} key            planner slug, or a legacy `*.json` event file
 * @param {string|null} [tab]
 * @param {{pathRouting?: boolean, base?: string}} [opts]
 *   `pathRouting` defaults to whatever this page is currently using.
 * @returns {string}
 */
export function plannerHref(key, tab = null, opts = {}) {
  const pathRouting =
    opts.pathRouting ??
    (typeof location !== 'undefined' ? usePathRouting(location.pathname) : false);
  const base = opts.base ?? (pathRouting ? '/planner' : './planner.html');

  // A `.json` event file cannot be a path segment without reading as a file.
  const fileKey = !!key && key.endsWith('.json');

  if (!key) return base;

  if (pathRouting && !fileKey) {
    const parts = [base, encodeURIComponent(key)];
    if (tab) parts.push(encodeURIComponent(tab));
    return parts.join('/');
  }

  const params = new URLSearchParams();
  params.set(fileKey ? 'event' : 'id', key);
  if (tab) params.set('tab', tab);
  return `${pathRouting ? '/planner.html' : base}?${params}`;
}

/**
 * The breadcrumb trail for a planner view. The route, rendered — the same
 * contract the archive uses, so the two sections read alike.
 *
 * @param {{key?: string|null, name?: string|null, tab?: string|null, tabLabel?: string|null}} [view]
 * @returns {Array<{label: string, href?: string}>}
 */
export function plannerCrumbs(view = {}) {
  /** @type {Array<{label: string, href?: string}>} */
  const trail = [{ label: 'Home', href: './home.html' }];
  const atRoot = !view.key;
  trail.push({ label: 'Planner', ...(atRoot ? {} : { href: plannerHref(null) }) });
  if (view.key) {
    const name = view.name || view.key;
    const last = !view.tabLabel;
    trail.push({ label: name, ...(last ? {} : { href: plannerHref(view.key) }) });
    if (view.tabLabel) trail.push({ label: view.tabLabel });
  }
  return trail;
}
