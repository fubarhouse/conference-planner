// What may be cached, by whom, and for how long.
//
// One place decides this, rather than each route and each CDN behaviour having
// an opinion. The rule is DEFAULT DENY: anything this file does not recognise
// gets `private, no-store`. A caching mistake on a private path leaks one
// person's data to the next visitor, so an unclassified path must fail closed —
// the cost of getting it wrong in the other direction is only a slow response.
//
// The shape of the product constrains the policy in one important way: there is
// no bundler, and `app/js/app.js` imports `./modules/*.js` relatively. So an
// asset URL can never be fingerprinted — a deploy changes app.js and every
// module IN PLACE, at the same address. A long max-age on code would therefore
// serve a stale mixture of old and new modules to anyone whose cache had not
// expired, which is worse than slow: it is a half-updated app.
//
// So code is cached BRIEFLY rather than either indefinitely or not at all. See
// REVALIDATE below for why 60s and not zero. Express emits ETags for every
// static file and JSON response, so the revalidation at the end of that window
// costs a 304 with an empty body (~60ms on the archive's 335 KB search).

/** Immutable in practice: content that is added, not edited, at a given URL. */
const LONG = 'public, max-age=86400, stale-while-revalidate=604800';

/** Changes on a dataset write; readers should see it within a minute. */
const DATA = 'public, max-age=60, stale-while-revalidate=300';

/**
 * Expensive to compute, identical for everyone, changes only with the data.
 *
 * Served on the UNVERSIONED URL, so it must be revalidated: `max-age` here was
 * a bug, not a policy. A browser can bypass its own cache after a curation
 * decision (`cache: 'reload'`); it cannot make a CDN forget, so every other
 * visitor kept the pre-merge names for the length of the window. `no-cache`
 * still stores the response and still costs only a 304 when nothing changed —
 * it just never serves it without asking.
 */
const COMPUTED = 'public, no-cache';

/**
 * The same expensive content at a CONTENT-ADDRESSED url (`?v=<token>`). A new
 * token is a new URL, so browser and CDN both fetch it fresh and the stale copy
 * ages out at its own address, harming nobody. That is what makes it safe to
 * cache hard — the opposite trade to COMPUTED, and the reason both exist.
 */
const VERSIONED = 'public, max-age=31536000, immutable';

/**
 * Code and HTML: cached, but briefly and without serving stale.
 *
 * `no-cache` was the first instinct — revalidate every time, because assets
 * cannot be fingerprinted. But that is a conditional request per file per
 * navigation, and a page pulls ~20 ES modules; on a high-latency connection
 * that is 20 round trips to be told nothing changed.
 *
 * 60 seconds bounds the risk instead of eliminating it. After a deploy a
 * visitor can hold a mixture of old and new modules for at most a minute, and
 * it self-heals. `must-revalidate` forbids serving stale past that window —
 * deliberately no `stale-while-revalidate` here, which would extend the mixed
 * window to cover the whole SWR period. Fonts and images get SWR; code does not.
 */
const REVALIDATE = 'public, max-age=60, must-revalidate';

/** Never store, never share. */
const PRIVATE = 'private, no-store';

/**
 * Paths whose responses are the same for every caller. Everything else is
 * treated as personal until someone decides otherwise, IN THIS FILE.
 */
const PUBLIC_RULES = [
  // Code and styles — 60s, because they cannot be fingerprinted.
  [/^\/(js|css)\//, REVALIDATE],
  // Fonts and images change effectively never, and a stale one is cosmetic.
  [/^\/(fonts|img)\//, LONG],
  [/^\/(favicon\.\w+|manifest\.webmanifest|robots\.txt)$/, LONG],
  // The public datasets and the catalog that indexes them.
  [/^\/data\//, DATA],
  [/^\/api\/meta$/, DATA],
  [/^\/api\/data\//, DATA],
  // Public event programmes as calendar feeds. No secret in these.
  [/^\/schedules\/[^/]+\/(calendar\.ics|subscribe)$/, DATA],
  [/^\/schedule\.ics$/, DATA],
  // Public HTML. Same 60s window as the code it loads, so a navigation and its
  // modules cannot disagree about which deploy they came from.
  [/^\/(schedules|home\.html|index\.html)?$/, REVALIDATE],
  [/^\/schedules\/[^/]+$/, REVALIDATE],
];

/**
 * Public but EXPENSIVE — the archive's aggregates. Listed separately because
 * they are role-gated today: while that is true the header is harmless (a
 * shared cache never sees them), and it is already correct for the day the
 * archive is opened up.
 */
const COMPUTED_RULES = [/^\/api\/archive\/(insights|sessions|topic)$/];

/**
 * Never cacheable, however public the path looks. Checked FIRST, so a mistake
 * in the rules above cannot expose one of these.
 *
 *  - the planner feed carries a bearer token in its query string; a shared
 *    cache holding that response serves one person's whole trip to the next
 *    requester
 *  - auth status and health describe the caller or the moment, not the content
 */
const NEVER = [
  /^\/planner\//, // includes /planner/<slug>/calendar.ics
  /^\/api\/auth\//,
  /^\/api\/health$/,
  /^\/login$/,
  /^\/logout$/,
  /^\/receipts\//,
  /^\/documents\//,
];

/**
 * @param {string} pathname - `req.path`, already normalised by the caller
 * @param {{versioned?: boolean}} [opts] - `versioned` says the request carried a
 *   content token (`?v=`). It upgrades ONLY the COMPUTED paths: a token means
 *   something on a path that publishes one, and nothing anywhere else — so a
 *   stray `?v=` cannot buy a year of caching for an unrelated response.
 * @returns {string} a Cache-Control value; never null, so a caller cannot
 *   forget to set one
 */
export function cacheControlFor(pathname, opts = {}) {
  const path = String(pathname || '');
  if (NEVER.some((re) => re.test(path))) return PRIVATE;
  if (COMPUTED_RULES.some((re) => re.test(path))) return opts.versioned ? VERSIONED : COMPUTED;
  for (const [re, value] of PUBLIC_RULES) if (re.test(path)) return value;
  return PRIVATE;
}

export const POLICIES = { LONG, DATA, COMPUTED, VERSIONED, REVALIDATE, PRIVATE };
