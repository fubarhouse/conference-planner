// @ts-check
// Archive routing — paths, not query strings.
//
//   /archive                          the overview
//   /archive/<tab>                    videos | albums | sources
//   /archive/<kind>/<slug>            a record: person, sponsor, year, …
//   /archive/topic/<term>/<year>      a keyword in one year
//   /archive/debuts/<year>            everyone new that year
//   /archive/sessions/<query>         a session search
//   /archive/source/<file>            one event's provenance
//
// The query form (`archive.html?...`) is NOT legacy to be tidied away — it is
// the form the app speaks when served as plain files, which is a supported
// deployment. Both are first class; `usePathRouting()` says which one this page
// is speaking, and the 301s that join them exist only when the server runs.
//
// THIS MODULE EXISTS BECAUSE THE ARCHIVE NEVER GOT ONE. The schedule and the
// planner were converted; the archive kept building `/archive/...` literals
// unconditionally. Served, that is right. As plain files it is wrong twice
// over: the breadcrumb's `<a href="/archive">` points at the host root rather
// than the page, and every pushState mints an address that 404s on reload.
//
// Pure: reads a location shape, returns strings. History calls stay in
// archiveDashboard.js.

/** The home views that are addressed by a single segment. */
export const ARCHIVE_TABS = ['videos', 'albums', 'sources'];

/** Views whose address carries a value rather than naming a record kind. */
const VALUE_VIEWS = { topic: 'topic', debuts: 'debuts', sessions: 'sessions', source: 'source' };

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
 * Is this page served at an `/archive` path (rather than opened as
 * `archive.html` from a static host or the file system)?
 *
 * @param {string} pathname
 * @returns {boolean}
 */
export function usePathRouting(pathname) {
  return segments(pathname)[0] === 'archive';
}

/**
 * What this URL asks for, from either form.
 *
 * The path wins where it says anything — it is the more specific statement —
 * and the query fills in the rest.
 *
 * @param {{pathname?: string, search?: string}} [loc]
 * @returns {{view: string, kind?: string, key?: string, year?: string, mode?: string, tab?: string}}
 */
export function parseArchiveRoute(loc = {}) {
  const segs = segments(loc.pathname || '');
  const params = new URLSearchParams(loc.search || '');
  const mode = params.get('match') === 'contains' ? 'contains' : 'exact';

  if (segs[0] === 'archive' && segs.length > 1) {
    const [, first, ...rest] = segs;
    if (ARCHIVE_TABS.includes(first)) return { view: 'tab', tab: first };
    if (first === 'sessions')
      return { view: 'sessions', key: decodeURIComponent(rest.join('/')), mode };
    if (first === 'source') return { view: 'source', key: decodeURIComponent(rest.join('/')) };
    if (first === 'debuts') return { view: 'debuts', year: decodeURIComponent(rest[0] || '') };
    if (first === 'topic') {
      // The one address carrying a PAIR, and the term may contain slashes.
      const year = rest.pop() || '';
      return { view: 'topic', key: decodeURIComponent(rest.join('/')), year };
    }
    if (rest.length) return { view: 'drill', kind: first, key: decodeURIComponent(rest.join('/')) };
  }

  // Static form. One key per view, so a reader can see what an address means.
  for (const name of Object.keys(VALUE_VIEWS)) {
    const value = params.get(name);
    if (value === null) continue;
    if (name === 'topic') return { view: 'topic', key: value, year: params.get('year') || '' };
    if (name === 'debuts') return { view: 'debuts', year: value };
    if (name === 'sessions') return { view: 'sessions', key: value, mode };
    return { view: 'source', key: value };
  }
  const kind = params.get('drill');
  if (kind) return { view: 'drill', kind, key: params.get('key') || '' };
  const tab = params.get('tab');
  if (tab && ARCHIVE_TABS.includes(tab)) return { view: 'tab', tab };

  return { view: 'home' };
}

/**
 * Whether to build path-form addresses. Read from the live location unless the
 * caller says otherwise (tests, and the server-side render that has no
 * location).
 *
 * @param {boolean} [override]
 * @returns {boolean}
 */
function pathMode(override) {
  return override ?? (typeof location !== 'undefined' ? usePathRouting(location.pathname) : false);
}

/**
 * The address for an archive view, in whichever form this page speaks.
 *
 * @param {{view: string, kind?: string, key?: string, year?: string|number, mode?: string, tab?: string}} view
 * @param {{pathRouting?: boolean}} [opts]
 * @returns {string}
 */
export function archiveHref(view, opts = {}) {
  const path = pathMode(opts.pathRouting);
  const enc = encodeURIComponent;
  /** @param {Array<[string, string]>} pairs */
  const q = (pairs) => {
    const params = new URLSearchParams();
    for (const [k, v] of pairs) if (v !== '' && v != null) params.set(k, String(v));
    const s = params.toString();
    return `./archive.html${s ? `?${s}` : ''}`;
  };

  switch (view.view) {
    case 'tab':
      if (!view.tab || !ARCHIVE_TABS.includes(view.tab)) return archiveHref({ view: 'home' }, opts);
      return path ? `/archive/${view.tab}` : q([['tab', view.tab]]);
    case 'sessions': {
      // Only the NON-default reading needs saying. Whole words is the default,
      // so a plain address means whole words and always will.
      const match = view.mode === 'contains' ? 'contains' : '';
      return path
        ? `/archive/sessions/${enc(String(view.key ?? ''))}${match ? `?match=${match}` : ''}`
        : q([
            ['sessions', String(view.key ?? '')],
            ['match', match],
          ]);
    }
    case 'source':
      return path
        ? `/archive/source/${enc(String(view.key ?? ''))}`
        : q([['source', String(view.key ?? '')]]);
    case 'debuts':
      return path
        ? `/archive/debuts/${enc(String(view.year ?? ''))}`
        : q([['debuts', String(view.year ?? '')]]);
    case 'topic':
      return path
        ? `/archive/topic/${String(view.key ?? '')}/${enc(String(view.year ?? ''))}`
        : q([
            ['topic', String(view.key ?? '')],
            ['year', String(view.year ?? '')],
          ]);
    case 'drill':
      if (!view.kind) return archiveHref({ view: 'home' }, opts);
      return path
        ? `/archive/${view.kind}/${String(view.key ?? '')}`
        : q([
            ['drill', view.kind],
            ['key', String(view.key ?? '')],
          ]);
    default:
      // The section's own address. `./archive.html` rather than `/archive` is
      // what makes this work as plain files; a served deployment 301s it.
      return path ? '/archive' : './archive.html';
  }
}
