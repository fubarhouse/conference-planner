import express from 'express';
import compression from 'compression';
import { cacheControlFor } from './lib/cachePolicy.js';
import { injectProvenance } from './lib/provenance.js';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { readFile, writeFile, mkdir, readdir, unlink, stat } from 'fs/promises';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, sep, posix, relative } from 'path';
import * as s3Sync from './lib/s3-sync.js';
import { validatePlanner, PLANNER_SCHEMA_FINGERPRINT } from './lib/validatePlanner.js';
import { validateDataset, DATASET_SCHEMA_FINGERPRINT } from './lib/validateDataset.js';
import { validateDataFile, summarizeErrors } from './lib/validateDataFile.js';
import { createV1Router } from './lib/crudApi.js';
import { HttpError } from './lib/httpError.js';
import {
  APP,
  DATA_ROOT,
  IMG_ROOT,
  PLANNER_ROOT,
  RECEIPT_ROOT,
  DOCUMENT_ROOT,
  CURATION_ROOT,
  guardPath,
} from './lib/roots.js';
import {
  AUTH_MODE,
  logAuthMode,
  bootstrapAdmin,
  requireAuth,
  requireRole,
  checkAuth,
  serveLoginPage,
  handleLogin,
  handleLogout,
  handleVerifyPassword,
} from './lib/auth.js';
import {
  handleListUsers,
  handleGetCurrentUser,
  handleCreateUser,
  handleUpdateUser,
  handleDeleteUser,
  handleGenerateToken,
  handleRevokeToken,
} from './lib/users.js';
import { writeCatalog, collectEventFiles } from './lib/buildCatalog.js';
// The slug rule is shared with the browser (app/js/modules/scheduleSlug.js) so
// `/schedules/<slug>` and the client's own links cannot disagree about what a
// schedule is called.
import { fileForSlug } from './app/js/modules/scheduleSlug.js';
import { buildPlannerFeedIcs, buildEventScheduleIcs } from './lib/tripFeed.js';
import {
  addFeed,
  findFeed,
  listFeeds,
  revokeFeed,
  touchFeed,
} from './lib/feedTokens.js';
import {
  buildCurationData,
  saveDecision,
  removeDecision,
  fingerprint,
  diskDecisionStore,
  serializeDecisions,
  parseDecisions,
} from './lib/archiveAudit.js';
import { buildInsights, coSpeakers, searchTopic } from './lib/archiveInsights.js';
import { buildCoverage, snoozeKey } from './lib/archiveCoverage.js';
import { searchSessions } from './lib/archiveSessions.js';
import { knownAlbums, loadThumbCache, saveThumbCache, resolveThumb } from './lib/albumThumbs.js';

// Disk layout lives in lib/roots.js — every path below is env-overridable and
// defaults to the layout that has always shipped. Local aliases keep the rest of
// this file reading as it did.
const DATA_DIR = DATA_ROOT;
const IMG_DIR = IMG_ROOT;
const PLANNER_DIR = PLANNER_ROOT;
const RECEIPT_DIR = RECEIPT_ROOT;
const DOCUMENT_DIR = DOCUMENT_ROOT;

// Log a catalog build result, including any event files found on disk that
// couldn't be read (missing/invalid) — otherwise they silently vanish from the
// schedule with no trace.
function logCatalogResult(c, context) {
  const skips = c.skipped || [];
  console.log(
    `[catalog] ${context} — ${c.events.length} events${skips.length ? `, ${skips.length} skipped` : ''}`,
  );
  for (const s of skips) {
    console.warn(`[catalog] ⚠ skipped ${s.file} (${s.reason}) — on disk but not readable`);
  }
}

// Regenerate the consolidated event-metadata cache (app/data/catalog.json) so the
// schedule page fetches one file instead of every event. Best-effort — a failure
// never blocks a request. Debounced so a burst of editor saves rebuilds once.
let _catalogTimer = null;
function regenerateCatalog(reason) {
  clearTimeout(_catalogTimer);
  _catalogTimer = setTimeout(() => {
    writeCatalog(DATA_DIR)
      .then((c) => logCatalogResult(c, `rebuilt (${reason})`))
      .catch((e) => console.warn(`[catalog] rebuild failed (${reason}): ${e.message}`));
  }, 800);
  if (_catalogTimer.unref) _catalogTimer.unref();
}

const app = express();

// Trust the first proxy hop (CDN/reverse proxy) for accurate req.ip
app.set('trust proxy', 1);

// ── Rate limits ────────────────────────────────────────────────────────────
// The login form has always had its own limiter (10 attempts / 15 min, in
// lib/auth.js). These cover the surfaces it does not:
//
//   - The token-gated calendar feeds. `/planner/<slug>/calendar.ics?k=<token>`
//     is the one place a secret can be GUESSED, and with no limit an attacker
//     can try as fast as the network allows. This makes that pointless.
//   - `/api/auth/verify`, which is a password oracle even behind a session.
//   - Uploads, which cost disk and S3 calls.
//   - The rest of /api, generously — enough to stop scraping and accidental
//     hammering, far above anything the app itself does in normal use.
//
// `trust proxy` is set to 1 above, so `req.ip` is the client address from the
// CDN's X-Forwarded-For rather than the CDN's own — without that every visitor
// would share one bucket and the limits would be meaningless.
const limit = (max, windowMinutes, message) =>
  rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: message },
    // Health checks are how a load balancer decides this box is alive; never
    // rate-limit them into a false outage.
    skip: (req) => req.path === '/api/health',
  });

const feedLimiter = limit(60, 15, 'Too many feed requests. Try again shortly.');
const verifyLimiter = limit(10, 15, 'Too many attempts. Try again in 15 minutes.');
const uploadLimiter = limit(30, 15, 'Too many uploads. Try again shortly.');
const apiLimiter = limit(600, 15, 'Too many requests. Try again shortly.');

// Compression. Everything this server sends is text — HTML, CSS, JS, JSON
// datasets, .ics feeds — and none of it was compressed, which is why a schedule
// cost ~1.3 MB over the wire and took 7.2s to paint its first session on a
// throttled phone. Measured on the Rotterdam dataset:
//
//   schedule.css        77 KB -> 14 KB      2026-rotterdam.json  256 KB -> 70 KB
//   components.css      73 KB -> 14 KB      section-chrome.css    67 KB -> 15 KB
//
// First in the stack, so it wraps every later route: the static files, the
// generated feeds and the JSON API alike.
//
// NOTE: this is the Node deployment only. Served as plain static files — a
// supported deployment, see docs/architecture.md — compression is the host's
// job, and every static host does it by default.
app.use(
  compression({
    // Below ~1 KB the header costs more than the saving.
    threshold: 1024,
  }),
);

// Cache-Control for generated responses. Runs before the routes so a handler can
// still override it — the planner feed does, and must keep doing so.
//
// Default deny: lib/cachePolicy.js answers `private, no-store` for anything it
// does not recognise, so a route added later is uncacheable until someone
// classifies it deliberately.
app.use((req, res, next) => {
  res.setHeader('Cache-Control', cacheControlFor(req.path, { versioned: !!req.query?.v }));
  next();
});

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
  // The public schedule may be embedded on other sites (?embed=1) — allow it to be
  // framed by anyone. Everything else (incl. the auth-gated planner/editor) stays
  // frame-DENY, so `?embed=1` on a protected page can't be used to clickjack it.
  const schedulePath = req.path === '/' || req.path === '/index.html' || req.path === '/schedule';
  // Uploaded receipt/document files are previewed in a same-origin lightbox iframe
  // in the planner, so they must allow same-origin framing (still blocked cross-origin).
  const uploadFile =
    req.path.startsWith('/receipts/') ||
    req.path.startsWith('/documents/') ||
    req.path.startsWith('/api/receipts/') ||
    req.path.startsWith('/api/documents/');
  if (schedulePath && req.query?.embed === '1') {
    res.setHeader('Content-Security-Policy', 'frame-ancestors *');
  } else if (uploadFile) {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  } else {
    res.setHeader('X-Frame-Options', 'DENY');
  }
  next();
});

// Allow cross-origin requests so the editor works when opened as a file:// URL
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Strip trailing slashes so relative asset paths resolve correctly from clean URLs
app.use((req, res, next) => {
  if (req.path !== '/' && req.path.endsWith('/')) {
    const qs = req.url.slice(req.path.length);
    return res.redirect(301, req.path.slice(0, -1) + qs);
  }
  next();
});

// Request logger
app.use((req, res, next) => {
  res.on('finish', () => {
    if (res.statusCode >= 400)
      console.error(`[http] ${res.statusCode} ${req.method} ${req.path} (auth-mode: ${AUTH_MODE})`);
  });
  next();
});

// Auth status (always public — lets the UI know what mode is active)
app.use('/api', apiLimiter);

app.get('/api/auth/status', async (req, res) => {
  // Report whether THIS client is authorized, so the frontend can skip
  // authorized-only requests (e.g. disk-seeding the planner) when it isn't —
  // avoiding noisy 401s. In 'open' mode checkAuth resolves a synthetic admin.
  const user = await checkAuth(req).catch(() => null);
  res.json({ mode: AUTH_MODE, authenticated: !!user, role: user?.role ?? 'anonymous' });
});

// Login / logout
app.get('/login', serveLoginPage);
app.post('/login', express.urlencoded({ extended: false }), handleLogin);
app.get('/logout', handleLogout);
// Re-verify the current password (planner lock re-auth). Use requireRole (API-style
// 401 JSON on failure) rather than requireAuth (which 302-redirects to the login HTML
// — the fetch client would misread that as a wrong password). A logged-in user is at
// least a viewer, and multi-mode still gets req.user for the per-user check.
app.post('/api/auth/verify', verifyLimiter, requireRole('viewer'), express.json(), handleVerifyPassword);

// ── Deep routes need a <base> the browser sees FIRST ────────────────────────
// A deep route (/planner/<slug>, /archive/<kind>/<slug>) serves the same HTML
// from a deeper path, so relative asset URLs resolve against the route.
//
// The client used to insert `<base href="/">` itself from an inline script.
// That is too late: the browser's speculative preload scanner has already
// started fetching the stylesheets, and they resolved against the route —
// returning this very HTML (200, text/html) rather than 404, so a status-code
// check does not see it, and a warm service-worker cache hides it entirely.
//
// The SERVER knows it is serving a deep route, so it says so in the markup.
// Static deployments never reach this path and are unaffected.
// Keyed by mtime, not just by name: an unkeyed cache serves the page as it was
// at boot, so an edited file keeps rendering the old markup and a verification
// pass reports a clean run against markup that no longer exists. It cost two
// false passes during the rebrand before anyone noticed.
const _pageCache = new Map();

/**
 * `og:url` and `og:image` must be ABSOLUTE, and a shared product must not have
 * somebody's domain compiled into it — anyone can host this, and a hardcoded
 * origin would make every share on their deployment point at someone else's
 * site. So the origin is never configured: it is read from the request the
 * browser actually made. `trust proxy` is set, so `req.protocol` honours the
 * CDN's X-Forwarded-Proto and this is https behind CloudFront.
 *
 * Pages OPT IN by carrying `og:title` in their own markup. The server completes
 * what only it can know; it never invents social markup for a page that did not
 * ask (the gated tools have none, and should not).
 *
 * A plain-static deployment never runs this, so those pages simply ship without
 * the absolute pair — the same as today, and better than a wrong URL.
 */
/**
 * The origin as the VIEWER sees it, which is not always what the origin server
 * sees. CloudFront sends the ORIGIN's own domain in `Host` unless the
 * distribution is configured to forward the viewer's, so reading `Host` alone
 * produced `https://app-origin.internal.example/…` on every share. Proxies that
 * preserve the viewer host advertise it in `X-Forwarded-Host`, so that wins.
 *
 * `PUBLIC_ORIGIN` is an explicit override for topologies where neither header
 * is trustworthy — and, incidentally, the answer for anyone who does not want
 * these tags derived from an attacker-controllable header at all. Nothing but
 * og/twitter metadata uses this, so a forged Host cannot move a redirect or a
 * cookie; it can only put a wrong URL in someone's share preview.
 */
function viewerOrigin(req) {
  const override = process.env.PUBLIC_ORIGIN?.trim();
  if (override) return override.replace(/\/$/, '');
  // A proxy chain appends, so the viewer's host is the FIRST entry.
  const forwardedHost = String(req.get('x-forwarded-host') || '')
    .split(',')[0]
    .trim();
  const host = forwardedHost || req.get('host') || '';
  // `trust proxy` makes req.protocol honour X-Forwarded-Proto; CloudFront also
  // sends its own header, which is the one present on some distributions.
  const proto =
    String(req.get('cloudfront-forwarded-proto') || '').trim() || req.protocol || 'https';
  return `${proto}://${host}`;
}

function ogTags(req, html) {
  if (!html.includes('og:title')) return '';
  const origin = viewerOrigin(req);
  // The path without the query: a share of `?id=x` and of the bare page are the
  // same document, and two card URLs for one page splits the sharing signal.
  const url = origin + req.path;
  return (
    `\n  <meta property="og:url" content="${escapeAttr(url)}">` +
    `\n  <meta property="og:image" content="${escapeAttr(origin + '/img/og-card.png')}">` +
    `\n  <meta name="twitter:image" content="${escapeAttr(origin + '/img/og-card.png')}">`
  );
}

/** Minimal attribute escaping — these values come from the Host header. */
function escapeAttr(v) {
  return String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function sendPage(res, file, { deep = false, req = null } = {}) {
  const path = join(APP, file);
  const stamp = statSync(path).mtimeMs;
  let hit = _pageCache.get(file);
  if (hit?.stamp !== stamp) {
    // Cache the FILE, not the response: the OG tags differ per request (host,
    // path), so baking them into the cached copy would serve the first
    // visitor's URL to everyone after them.
    // The provenance notice is injected once, at read time, not per request:
    // it is identical for every visitor, unlike the OG tags below.
    hit = { stamp, raw: injectProvenance(readFileSync(path, 'utf8')) };
    _pageCache.set(file, hit);
  }
  const head = (deep ? '\n  <base href="/">' : '') + (req ? ogTags(req, hit.raw) : '');
  if (!head) return res.sendFile(path);
  res.type('html').send(hit.raw.replace(/<head>/i, `<head>${head}`));
}

// ── Section addresses ───────────────────────────────────────────────────────
// Every section has ONE address when this app is served: /schedule, /planner,
// /archive, /editor. The pages themselves still link to `./index.html`,
// `./planner.html` and friends, because those are the links that work when the
// app is deployed as plain files (GitHub Pages) — so the file form is
// canonicalised HERE rather than guessed at in the browser.
//
// The query string is carried across, so `./planner.html?id=x` still lands on
// the right planner; the client then rewrites that to `/planner/x` itself.
const canonical = (to) => (req, res) => {
  const q = req.originalUrl.indexOf('?');
  res.redirect(301, q === -1 ? to : to + req.originalUrl.slice(q));
};

// Public HTML routes. `/` is HOME — a real page, not an alias for the schedule.
// That was the last inconsistency in the nav: "Home" and "Schedule" pointed at
// the same document, so one of the five items said nothing.
app.get('/', (req, res) => sendPage(res, 'home.html', { req }));
app.get('/home.html', canonical('/'));
// The schedule section is path-addressed, like the planner and the archive:
//   /schedules                       the selection screen
//   /schedules/<slug>                that schedule
//   /schedules/<slug>/calendar.ics   its subscription feed
//   /schedules/<slug>/subscribe      an alias for the feed, for humans to type
//
// `index.html?id=<slug>` keeps working and is NOT deprecated: it is the form the
// app speaks when served as plain files. These redirects only exist while this
// server is running, which is exactly the point — a static deployment has no
// redirects and needs none.
// Served deep (with `<base href="/">`) even though it is one segment: the client
// pushState()s to `/schedules/<slug>` when you pick a schedule, and without a
// base every relative fetch after that would resolve against the NEW path —
// `/schedules/data/events/x.json`, which this router happily answers with HTML.
app.get('/schedules', (req, res) => sendPage(res, 'index.html', { deep: true, req }));

// Resolve a slug against the catalog. Returns null when the catalog is missing
// or the slug names nothing — the caller decides whether that is a 404.
async function fileForScheduleSlug(slug) {
  try {
    const catalog = JSON.parse(await readFile(join(DATA_DIR, 'catalog.json'), 'utf8'));
    return fileForSlug(slug, catalog.events || []);
  } catch {
    return null;
  }
}

// The subscription endpoint. `subscribe` is an alias so the address is typeable;
// `calendar.ics` is the canonical one, because some calendar clients still read
// the extension before they read the Content-Type.
app.get('/schedules/:slug/:feed(calendar.ics|subscribe)', feedLimiter, async (req, res) => {
  const file = await fileForScheduleSlug(req.params.slug);
  if (!file) return res.status(404).type('text/plain').send('Unknown schedule.');
  if (req.params.feed === 'subscribe') {
    return res.redirect(302, `/schedules/${encodeURIComponent(req.params.slug)}/calendar.ics`);
  }
  return serveEventIcs(file, req, res);
});

app.get('/schedules/:slug', (req, res) => sendPage(res, 'index.html', { deep: true, req }));

// The old singular address, and the file form, both land on the section.
app.get('/schedule', canonical('/schedules'));
app.get('/index.html', canonical('/schedules'));

// Protected HTML routes — must come before express.static so .html files are also guarded
// The planner is path-addressed, the same way the archive is:
//   /planner                the selection screen
//   /planner/<slug>         that planner, on its default tab
//   /planner/<slug>/<tab>   that planner, on that tab
// The client resolves the slug against its own stored planners, so there is no
// server-side registry — and no reason for the server to 404 on a slug it has
// never heard of, since a planner can live only in the browser.
// ── Calendar subscription feeds ───────────────────────────────────────────
// REGISTERED BEFORE `/planner/:slug/:tab`, and that ordering is load-bearing:
// `calendar.ics` matches `:tab`, so with the routes the other way round a
// calendar client would follow a 302 to /login, receive HTML, and quietly show
// an empty calendar with no error anyone would ever see.
//
// Public by necessity — a calendar client cannot log in, so the token IS the
// credential. It is verified against a stored SHA-256, in constant time, and
// every failure is a 404 so the endpoint never confirms that a planner exists.

// The planner as the FEED must see it: S3 first when configured, exactly like
// plannerRead. The retired /feed.ics read local disk only, which on this
// infrastructure (one ECS task, ephemeral disk, no boot-time pull) meant every
// deploy silently broke every subscription until someone pulled by hand.
async function plannerForFeed(relPath) {
  if (s3Configured()) {
    try {
      return JSON.parse(await s3Sync.getPlanner(relPath, { userId: null }));
    } catch (e) {
      if (e.name === 'NoSuchKey') return null;
      if (!s3Unavailable(e)) throw e;
      console.warn(`[s3] feed read unavailable (${e.name}) — falling back to local disk`);
    }
  }
  const target = guardPath(PLANNER_DIR, relPath);
  if (!target) return null;
  try {
    return JSON.parse(await readFile(target, 'utf8'));
  } catch {
    return null;
  }
}

// A poll updates `lastUsedAt`, which is how a reader notices a token being used
// from somewhere it should not be. Written back through plannerWrite so it
// lands in S3 like any other change — and only when `touchFeed` says the record
// actually moved, because calendars poll every few minutes.
async function recordFeedUse(relPath, planner, feedId, req) {
  if (!touchFeed(planner, feedId, req.get('user-agent') || '')) return;
  await plannerWrite(relPath, JSON.stringify(planner, null, 2), req).catch((e) =>
    console.warn(`[feed] could not record use: ${e.message}`),
  );
}

async function servePlannerFeed(relPath, token, req, res) {
  const planner = await plannerForFeed(relPath);
  const feed = planner ? findFeed(planner, token) : null;
  // One response for "no such planner" and "wrong token" — never distinguish.
  if (!planner || !feed) return res.status(404).type('text/plain').send('Not found.');
  res.set('Cache-Control', 'private, max-age=300');
  const ics = await buildPlannerFeedIcs(planner, { dataDir: DATA_DIR });
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition', 'inline; filename="trip.ics"');
  res.send(ics);
  // After the response: the reader waits for their calendar, not for our
  // bookkeeping, and a failed write must never fail the feed.
  void recordFeedUse(relPath, planner, feed.id, req);
}

app.get('/planner/:slug/calendar.ics', feedLimiter, async (req, res) => {
  const k = String(req.query.k || '');
  if (!k) return res.status(404).type('text/plain').send('Not found.');
  try {
    await servePlannerFeed(`${req.params.slug}.json`, k, req, res);
  } catch (e) {
    console.error('[feed] error:', e.message);
    res.status(500).type('text/plain').send('Feed error.');
  }
});

app.get('/planner', requireAuth, (_, res) => res.sendFile(join(APP, 'planner.html')));
app.get('/planner.html', canonical('/planner'));
app.get('/planner/:slug', requireAuth, (_, res) => sendPage(res, 'planner.html', { deep: true }));
app.get('/planner/:slug/:tab', requireAuth, (_, res) =>
  sendPage(res, 'planner.html', { deep: true }),
);
// The archive is a first-class section, not an editor overlay. Gated for now
// because its data source (/api/archive/insights) requires the editor role;
// opening it to the public means relaxing that endpoint too.
app.get('/archive', requireAuth, (req, res) => sendPage(res, 'archive.html', { req }));
app.get('/archive.html', canonical('/archive'));
// Every drill-down is addressable — /archive/<kind>/<slug>. The client resolves
// the slug against the loaded archive, so no server-side registry.
// One or more segments in total: the home's view modes are a single segment
// (/archive/videos), a drill is two (/archive/speaker/<name>), and a topic drill
// is three (/archive/topic/<term>/<year>). This pattern used to require two, so
// the view modes 404ed before the client ever saw them. The last segment must
// not look like a file, for the same reason as /editor — see there.
app.get(/^\/archive\/(?:[^/]+\/)*[^/.]+$/, requireAuth, (_req, res) =>
  sendPage(res, 'archive.html', { deep: true }),
);

// "Observatory" is superseded by "Archive". Old links keep working — a rename
// should never be a 404 for anyone who bookmarked the section.
app.get(['/observatory', '/observatory.html'], (_, res) => res.redirect(301, '/archive'));
app.get('/observatory/:kind/:slug', (req, res) =>
  res.redirect(301, `/archive/${req.params.kind}/${req.params.slug}`),
);
// Curation is its own section, not an editor mode. Gated like the editor
// because it writes alias data that every other view reads.
app.get('/curation', requireAuth, (_, res) => res.sendFile(join(APP, 'curation.html')));
app.get('/curation.html', canonical('/curation'));
app.get('/editor', requireAuth, (_, res) => res.sendFile(join(APP, 'editor.html')));
app.get('/editor.html', canonical('/editor'));
// /editor/<dataset path>/<tab> — the record being edited is part of the address,
// so a refresh or a shared link reopens it. The client parses the path (see
// editorRoute.js); the server only has to serve the same page for every depth,
// the way it already does for /archive/<kind>/<slug>.
// `deep: true` ships `<base href="/">`: editor.html links its CSS and modules
// relatively (so the app still works as plain files), and at this depth those
// would otherwise resolve against /editor/<series>/<event>/ and 404.
//
// `[^.]+$` on the last segment is load-bearing. Without it this route answered
// EVERY path under /editor/ with the page — so a document-relative
// `fetch('./schemas/event.schema.json')` from a deep route got HTML back and died
// on "Unexpected token '<'". A request that names a file must fall through to
// static/404, where a wrong URL fails loudly instead of looking like data.
app.get(/^\/editor\/(?:[^/]+\/)*[^/.]+$/, requireAuth, (_req, res) =>
  sendPage(res, 'editor.html', { deep: true }),
);

// Serve receipt/document uploads S3-first when configured, so a deployment whose
// uploads live only in S3 (never written to this container's disk) still serves
// them. Falls through to express.static for local-disk files and S3 outages.
async function serveUpload(top, req, res, _next) {
  const rel = req.params[0];
  if (s3Configured()) {
    try {
      const { body, contentType } = await s3Sync.getUpload(`${top}/${rel}`);
      return res.type(contentType).send(body);
    } catch (e) {
      if (e.code === 'INVALID_PATH') return res.status(400).json({ error: 'Invalid path' });
      if (!(e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404 || s3Unavailable(e))) {
        return res.status(502).json({ error: e.message });
      }
      // Missing in S3, or S3 unreachable — try the local mirror below.
    }
  }
  // Serve the local file HERE rather than falling through to express.static.
  // The fall-through only ever worked for the `/receipts/*` shape; the same
  // handler mounted under `/api` would have 404'd every local file, and relying
  // on the static handler is what made these files reachable without a session
  // in the first place.
  const dir = top === 'receipts' ? RECEIPT_DIR : DOCUMENT_DIR;
  const target = guardPath(dir, rel);
  if (!target) return res.status(400).json({ error: 'Invalid path' });
  return res.sendFile(target, (err) => {
    if (err) res.status(404).json({ error: 'Not found' });
  });
}
// Uploaded receipts and documents are PERSONAL DATA — travel bookings, tickets,
// identity documents — and they were reachable by anyone who knew or guessed a
// path. `serveUpload` falls through to the static handler when S3 is not
// configured, and `express.static(APP)` happily served the upload trees — which
// then lived at app/receipts/** and app/documents/** — with no check at all.
// (They now live under PRIVATE_ROOT, outside the served tree entirely, so the
// static handler cannot reach them however the URL is shaped. The role gate
// below stays: defence in depth, and it is what protects the S3 path too.)
// Verified before the fix: an anonymous
// GET returned a real 928 KB travel receipt with the session auth mode fully
// enabled. The role gate now runs before either path can be reached.
// Uploads are served under /api, which is where every other authenticated read
// lives. That is not cosmetic: it means `/receipts/*` and `/documents/*` can be
// blocked outright at the CDN without breaking the product, so a future gap in
// the origin's own guard cannot expose personal files.
app.get('/api/receipts/*', requireRole('viewer'), (req, res, next) =>
  serveUpload('receipts', req, res, next),
);
app.get('/api/documents/*', requireRole('viewer'), (req, res, next) =>
  serveUpload('documents', req, res, next),
);

// The original paths, kept working and still gated, for anything that stored an
// absolute URL before the move. Nothing in the app builds these any more.
app.get('/receipts/*', requireRole('viewer'), (req, res, next) =>
  serveUpload('receipts', req, res, next),
);
app.get('/documents/*', requireRole('viewer'), (req, res, next) =>
  serveUpload('documents', req, res, next),
);

// Belt and braces for the static handler below. The routes above already gate
// the paths they match, but a URL shape they do NOT match (an extra segment, a
// directory index, an encoded separator) would otherwise reach `express.static`
// and be served from disk unauthenticated. Private trees are named here once,
// so adding a route shape later cannot silently reopen them.
//
// `/data/curation/` is here because the curation ledger is an identity document:
// it maps pseudonyms to the real names behind them. Every /api/curation route is
// `requireRole('editor')`, but the FILE sat inside the public data tree with
// nothing in front of it, so the ledger those routes protect could be fetched
// whole and unauthenticated. It moves out of the public tree entirely later; the
// guard stays regardless, because it costs nothing and the failure mode is a
// silent one.
const PRIVATE_TREES = ['/receipts/', '/documents/', '/planner/', '/data/curation/'];

/**
 * The path as the FILE SYSTEM will see it, not as the router saw it.
 *
 * `req.path` keeps percent-encoding, so `/planner%2Fglobal.json` does not start
 * with `/planner/` and sailed straight past a naive prefix check — while
 * `express.static` decoded it and served the file. That is not hypothetical:
 * it returned global.json, which carries eight team members' names, roles,
 * companies and phone numbers. Decode to a fixed point (bounded, because a
 * malicious path can be encoded many times over), fold backslashes, and
 * compare case-insensitively since Express routes case-insensitively.
 */
function fsPath(raw) {
  let path = String(raw || '');
  for (let i = 0; i < 5; i += 1) {
    let next;
    try {
      next = decodeURIComponent(path);
    } catch {
      break; // malformed encoding — judge it as it stands
    }
    if (next === path) break;
    path = next;
  }
  // `posix.normalize` rather than another regex. Three separate leaks got past
  // hand-rolled matching here — `%2F`, then `//`, then `/.//` — because each fix
  // only knew about the trick in front of it. Normalising resolves `.`, `..` and
  // repeated separators together, which is the same thing the file system does,
  // and is the only version that stops being a guessing game.
  const folded = path.replace(/\\/g, '/');
  return posix.normalize(folded.startsWith('/') ? folded : `/${folded}`).toLowerCase();
}

app.use((req, res, next) => {
  const path = fsPath(req.path);
  if (!PRIVATE_TREES.some((prefix) => path.startsWith(prefix))) return next();
  return requireRole('viewer')(req, res, next);
});

// Serve static files (CSS, JS, images — no auth required)
// Cache-Control for everything the static handler serves. Without `setHeaders`
// express.static stamps its own `public, max-age=0` over anything set earlier,
// so the policy has to be applied HERE rather than in the middleware above.
// Cache-Control is keyed off the URL, so each mount reconstructs the URL its own
// files are served at rather than assuming the disk path resembles it.
const staticOpts = (base, urlPrefix = '') => ({
  setHeaders: (res, filePath) => {
    const rel = urlPrefix + '/' + relative(base, filePath).split(sep).join('/');
    res.setHeader('Cache-Control', cacheControlFor(rel));
  },
});

// `/data` and `/img` are the URL contract — dataset files store `./img/…` paths
// and the client fetches `./data/catalog.json`. Mount the roots there EXPLICITLY
// so the contract survives the data living outside `app/`. These must precede the
// `app/` mount: when the roots are at their defaults both mounts can serve the
// same file, and the specific one should decide the caching.
app.use('/data', express.static(DATA_DIR, staticOpts(DATA_DIR, '/data')));
app.use('/img', express.static(IMG_DIR, staticOpts(IMG_DIR, '/img')));

app.use(express.static(APP, staticOpts(APP)));

// Health check for connection testing
app.get('/api/health', (_, res) =>
  res.json({ ok: true, app: 'conference-planner-api', version: 1 }),
);

// Public feed of a whole event's programme: webcal://host/schedule.ics?e=<eventFile>.
// No token — same public data as the schedule page; the event is whitelisted against
// the catalog so it can't read arbitrary files.
// One event's whole programme as a calendar feed. Shared by the two addresses
// that serve it: `/schedule.ics?e=<file>` (the static-form endpoint, unchanged)
// and `/schedules/<slug>/calendar.ics` (the path form). No token — this is the
// same public data the schedule page shows — and the file is whitelisted against
// the catalog so a request cannot read arbitrary paths.
async function serveEventIcs(eventFile, req, res) {
  try {
    const result = await buildEventScheduleIcs(eventFile, { dataDir: DATA_DIR });
    if (!result) return res.status(404).type('text/plain').send('Not found.');
    let etag = '';
    try {
      const st = await stat(result.path);
      etag = `W/"${st.mtimeMs.toString(36)}-${st.size.toString(36)}"`;
    } catch {
      /* stat failed → skip conditional caching, still serve */
    }
    res.set('Cache-Control', 'public, max-age=1800');
    if (etag) {
      res.set('ETag', etag);
      if (req.headers['if-none-match'] === etag) return res.status(304).end();
    }
    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Content-Disposition', 'inline; filename="calendar.ics"');
    return res.send(result.ics);
  } catch (err) {
    console.error('[schedule feed] error:', err.message);
    return res.status(500).type('text/plain').send('Feed error.');
  }
}

app.get('/schedule.ics', feedLimiter, async (req, res) => {
  const e = String(req.query.e || req.query.event || '');
  // The static form can name the event by slug too, so one link shape works in
  // both deployments.
  const bySlug = !e && req.query.id ? await fileForScheduleSlug(String(req.query.id)) : null;
  const file = e || bySlug;
  if (!file) return res.status(400).type('text/plain').send('Missing e (event file) or id (slug).');
  return serveEventIcs(file, req, res);
});

// ── Archive curation (editor only) — the identity-reconciliation desk ──────────
// Speaker/sponsor near-duplicate clusters with context, a preview-able cross-file
// merge, and durable decisions (alias = same entity / distinct = genuinely not).

// The decisions ledger is S3-first, for the reason planners and uploads are: on a
// container filesystem, a decision made between two syncs does not survive the next
// deploy. Reconciliation is slow human work and this file is its only record — the
// datasets are never rewritten — so it is written through on every decision and read
// back on every request, rather than left for the bulk sync to notice.
//
// Local disk keeps a mirror: it is the fallback when S3 is not configured or is
// unreachable, and (because the read falls back to it) it is also how an existing
// on-disk ledger migrates into S3 on the first write.
const decisionsStore = {
  async read() {
    if (s3Configured()) {
      try {
        const text = await s3Sync.getDecisions();
        if (text != null) return text;
        // No object yet — fall through to disk, which may hold decisions made
        // before this became S3-first. The next write pushes them up.
      } catch (e) {
        if (!s3Unavailable(e)) throw e;
        console.warn(`[s3] read unavailable (${e.name}) — reading decisions from local disk`);
      }
    }
    return diskDecisionStore().read();
  },
  async write(text) {
    if (s3Configured()) {
      try {
        await s3Sync.putDecisions(text);
        // Best-effort mirror: a disk failure must never fail a decision that S3
        // already accepted.
        await diskDecisionStore()
          .write(text)
          .catch((e) => console.warn(`[disk] decisions mirror write failed: ${e.message}`));
        return;
      } catch (e) {
        if (!s3Unavailable(e)) throw e;
        console.warn(`[s3] write unavailable (${e.name}) — saving decisions to local disk`);
      }
    }
    return diskDecisionStore().write(text);
  },
};

// A short content hash of the ledger. Content-addressed on purpose: every instance
// behind the load balancer derives the SAME token from the same bytes, which an
// mtime cannot promise and an S3 ETag only promises while S3 is the source.
//
// Hashed through parse→serialize so the token names the DECISIONS, not the file:
// a re-indented ledger, and a missing one versus an empty one, are the same
// archive and must not look like two versions of it.
function curationToken(text) {
  return createHash('sha1')
    .update(serializeDecisions(parseDecisions(text)))
    .digest('hex')
    .slice(0, 12);
}

// Hand an already-read ledger to a builder so one request reads the file once.
function frozenDecisionStore(text) {
  return { read: async () => text, write: async () => {} };
}

app.get('/api/curation/clusters', requireRole('editor'), async (_req, res) => {
  try {
    const text = await decisionsStore.read();
    res.json(await buildCurationData(DATA_DIR, APP, frozenDecisionStore(text)));
  } catch (e) {
    console.error('[curation] clusters:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Map a cluster's spellings to a canonical name. RECORDED ONLY — a private alias in
// decisions.json that the Observatory applies at READ TIME. This never rewrites the
// source datasets: the original programmes are preserved verbatim (the project's whole
// point), and the mapping is the owner's private lens (decisions.json is gitignored).
app.post('/api/curation/merge', requireRole('editor'), express.json(), async (req, res) => {
  // Accept a pre-computed `key` (Curation Studio, cluster.key) OR a raw `name` to
  // fingerprint here (Observatory "map to another identity"). Both resolve the same
  // read-time alias — mapping-only, datasets untouched.
  const { key, name, canonical } = req.body || {};
  const aliasKey = key || (name ? fingerprint(name) : '');
  if (!aliasKey || !canonical)
    return res.status(400).json({ error: 'key/name + canonical required' });
  try {
    const next = await saveDecision(
      { type: 'alias', key: aliasKey, canonical },
      decisionsStore,
    );
    // Hand back the new token: the caller re-reads the archive at a fresh URL
    // instead of asking a CDN to forget the old one. See the insights route.
    res.json({ ok: true, version: curationToken(serializeDecisions(next)) });
  } catch (e) {
    console.error('[curation] map:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Archive Observatory — aggregated 19-year stats for the data-viz dashboard.
// The archive's aggregates cost ~1s of CPU and 3.5 MB, and are byte-identical
// for every caller until a dataset changes — so they were being rebuilt from
// scratch on every load of the archive page, for nobody's benefit.
//
// The catalog already carries `generatedAt`, and the server regenerates the
// catalog on every dataset write, so it is exactly the data version this needs.
// No new bookkeeping, and no way for the cache to outlive the data it describes.
//
// The catalog is only HALF the version, though: insights also resolve names through
// the curation aliases, and a merge changes the answer without touching a dataset.
// Keyed on the catalog alone, the memo happily served pre-merge names until the next
// dataset write — so the identity you had just reconciled reappeared un-merged. The
// key is therefore catalog + ledger content.
let _insightsCache = { version: null, payload: null };

async function dataVersion() {
  try {
    const raw = await readFile(join(DATA_DIR, 'catalog.json'), 'utf8');
    return JSON.parse(raw).generatedAt || null;
  } catch {
    return null; // no catalog → never cache, rather than cache "unknown"
  }
}

// `?v=<token>` is a CONTENT ADDRESS, not a cache-buster: the response is the same
// for every caller holding that token, so the versioned URL is cached hard (see
// cachePolicy) and a decision invalidates it by moving to a new URL. The
// unversioned URL exists for the first load, when the client has no token yet, and
// is revalidated rather than held. `cache: 'reload'` was the old attempt at this;
// it can bypass a browser's cache but never a CDN's.
app.get('/api/archive/insights', requireRole('editor'), async (req, res) => {
  try {
    const ledger = await decisionsStore.read();
    const token = curationToken(ledger);
    const catalog = await dataVersion();
    const version = catalog && `${catalog}:${token}`;
    // A `?v=` naming an older ledger is a client holding a stale URL — answer with
    // what is true now rather than 404-ing a page mid-render, and say which
    // version this actually is so the client can settle on it.
    res.set('X-Curation-Version', token);
    if (version && _insightsCache.version === version) {
      res.set('X-Cache', 'hit');
      return res.json(_insightsCache.payload);
    }
    const payload = {
      ...(await buildInsights(DATA_DIR, frozenDecisionStore(ledger))),
      curationVersion: token,
      // The payload is a function of the DATASETS as well as the ledger, which is
      // why the cache key above is `${catalog}:${token}`. The client used to
      // address it by ledger token alone, so a `?v=` URL — held `immutable` for a
      // year — kept serving the archive as it was before an event was edited.
      // Hand back both halves so the client can address the same content we cached.
      dataVersion: catalog,
    };
    if (version) _insightsCache = { version, payload };
    res.set('X-Cache', 'miss');
    res.json(payload);
  } catch (e) {
    console.error('[insights]:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Free-text keyword/phrase lookup over titles + descriptions (for the topic chart's
// "add any keyword" + point drill-down).
// Session text search. Lives server-side because the insights payload carries
// no titles or descriptions — see lib/archiveSessions.js.
app.get('/api/archive/sessions', requireRole('editor'), async (req, res) => {
  try {
    const { series, region, country, year, limit, offset } = req.query;
    // Paged so a broad search ("ai") can be read past its first page. Clamped
    // here rather than trusted: the page size is a client convenience, and an
    // unbounded one would let a caller ask for every match in one response.
    const asInt = (v, dflt, max) => {
      const n = Number.parseInt(String(v ?? ''), 10);
      return Number.isFinite(n) ? Math.min(Math.max(n, 0), max) : dflt;
    };
    res.json(
      await searchSessions(DATA_DIR, String(req.query.q || ''), {
        limit: Math.max(1, asInt(limit, 200, 500)),
        offset: asInt(offset, 0, 100000),
        // Whole words unless asked otherwise — see the `mode` note in searchSessions.
        mode: String(req.query.mode || '') === 'contains' ? 'contains' : 'exact',
        series: series ? String(series) : 'All',
        region: region ? String(region) : 'All',
        country: country ? String(country) : 'All',
        year: year ? String(year) : 'All',
        // `video=1` turns the same search into the recordings view: only sessions
        // that were filmed, and an empty query browses them rather than returning
        // nothing.
        hasVideo: String(req.query.video || '') === '1',
      }),
    );
  } catch (e) {
    console.error('[sessions]:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Who has shared a session with this person. On demand rather than in the
// insights payload — see coSpeakers.
app.get('/api/archive/cospeakers', requireRole('editor'), async (req, res) => {
  try {
    res.json(
      await coSpeakers(
        DATA_DIR,
        String(req.query.name || ''),
        {
          series: String(req.query.series || 'All'),
          region: String(req.query.region || 'All'),
          country: String(req.query.country || 'All'),
        },
        decisionsStore,
      ),
    );
  } catch (e) {
    console.error('[cospeakers]:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// A cover image for a photo album, resolved from the album's own og:image and
// cached on disk. Flickr and Google Photos both publish one, so the archive can
// show a picture instead of a link without an API key for either.
//
// The URL must be an album the archive actually records — the endpoint resolves
// what is in the datasets, never what a caller asks for, so it cannot be used to
// make this server fetch an address of someone else's choosing.
let _albumCache = null;
let _albumAllow = null;
app.get('/api/archive/album-thumb', requireRole('viewer'), async (req, res) => {
  try {
    const url = String(req.query.url || '');
    _albumAllow ??= await knownAlbums(DATA_DIR);
    if (!_albumAllow.has(url)) {
      // A newly added album is worth one re-read before refusing.
      _albumAllow = await knownAlbums(DATA_DIR);
      if (!_albumAllow.has(url)) return res.status(400).json({ error: 'Unknown album' });
    }
    _albumCache ??= await loadThumbCache(DATA_DIR);
    // `refresh=1` re-asks the host — how you clear a miss that was really a
    // rate-limit, without waiting for it to age out. Editors only: a reader
    // should not be able to make this server fetch on demand.
    // requireRole populates req.user (open mode included, as an admin), so the
    // check is on the level rather than one role name — an admin is an editor's
    // superior, not a stranger to it.
    const canRefresh = ['editor', 'admin'].includes(req.user?.role || '');
    const refresh = String(req.query.refresh || '') === '1' && canRefresh;
    const before = _albumCache[url]?.at;
    const { thumb, cached } = await resolveThumb(url, { cache: _albumCache, refresh });
    if (_albumCache[url]?.at !== before) await saveThumbCache(DATA_DIR, _albumCache);
    // A cover is worth caching for a day; the ABSENCE of one is not. An empty
    // answer is usually temporary — a rate-limit, a slow host — and caching it
    // for a day means the card stays blank long after the server can resolve it,
    // with no way for the reader to tell the difference from a broken feature.
    res.set('Cache-Control', thumb ? 'public, max-age=86400' : 'no-store');
    res.json({ thumb, cached });
  } catch (e) {
    console.error('[album-thumb]:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/archive/topic', requireRole('editor'), async (req, res) => {
  try {
    res.json(
      await searchTopic(
        DATA_DIR,
        String(req.query.term || ''),
        String(req.query.series || 'All'),
        String(req.query.region || 'All'),
        String(req.query.country || 'All'),
        // `year` switches the response from "counts for the chart" to "the
        // sessions themselves, for the drill" — same matcher, one year's worth.
        { year: req.query.year ? Number(req.query.year) : null },
      ),
    );
  } catch (e) {
    console.error('[topic]:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// The coverage worklist: what each event is missing, minus what you have told it
// to stop asking about. Same ledger as the identity decisions — see
// lib/archiveCoverage.js for why a snooze belongs there.
app.get('/api/curation/coverage', requireRole('editor'), async (_req, res) => {
  try {
    const text = await decisionsStore.read();
    res.json(await buildCoverage(DATA_DIR, frozenDecisionStore(text)));
  } catch (e) {
    console.error('[curation] coverage:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Ignore a gap for ever, snooze it until a date, or (with no state) reopen it.
app.post('/api/curation/coverage', requireRole('editor'), express.json(), async (req, res) => {
  const { file, check, state, until, note } = req.body || {};
  if (!file || !check) return res.status(400).json({ error: 'file and check required' });
  if (state && state !== 'ignored' && state !== 'later')
    return res.status(400).json({ error: 'state must be "ignored", "later" or omitted' });
  try {
    const next = await saveDecision(
      { type: 'coverage', key: snoozeKey(file, check), state, until, note },
      decisionsStore,
    );
    res.json({ ok: true, version: curationToken(serializeDecisions(next)) });
  } catch (e) {
    console.error('[curation] coverage save:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/curation/distinct', requireRole('editor'), express.json(), async (req, res) => {
  const { key } = req.body || {};
  if (!key) return res.status(400).json({ error: 'key required' });
  try {
    const next = await saveDecision({ type: 'distinct', key }, decisionsStore);
    res.json({ ok: true, version: curationToken(serializeDecisions(next)) });
  } catch (e) {
    console.error('[curation] distinct:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Undo a decision from the desk's decisions log: un-mark a `distinct` and its cluster
// resurfaces; drop an `alias` and the spellings separate again. Nothing else needs
// reverting — the decision only ever existed in the ledger.
app.post('/api/curation/undo', requireRole('editor'), express.json(), async (req, res) => {
  const { type, key } = req.body || {};
  if (!type || !key) return res.status(400).json({ error: 'type and key required' });
  try {
    // Mapping-only: removing a decision never touches datasets, so no catalog rebuild.
    const next = await removeDecision({ type, key }, decisionsStore);
    res.json({ ok: true, version: curationToken(serializeDecisions(next)) });
  } catch (e) {
    console.error('[curation] undo:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// User management (multi-user mode only)
app.get('/api/users/me', requireRole('viewer'), handleGetCurrentUser);
app.get('/api/users', requireRole('admin'), handleListUsers);
app.post('/api/users', requireRole('admin'), express.json(), handleCreateUser);
app.put('/api/users/:id', requireRole('admin'), express.json(), handleUpdateUser);
app.delete('/api/users/:id', requireRole('admin'), handleDeleteUser);
app.post('/api/users/:id/token', requireRole('admin'), handleGenerateToken);
app.delete('/api/users/:id/token', requireRole('admin'), handleRevokeToken);

// S3 sync endpoints
function s3Error(res, e) {
  const httpStatus = e.$metadata?.httpStatusCode;
  const awsCode = e.Code ?? e.name ?? e.code;
  console.error(
    '[s3]',
    awsCode ?? 'error',
    httpStatus ? `HTTP ${httpStatus}` : '',
    e.message,
    e.stack ?? '',
  );
  if (e.code === 'NOT_CONFIGURED') return res.status(503).json({ ok: false, error: e.message });
  const detail = httpStatus ? ` (AWS HTTP ${httpStatus}${awsCode ? `, ${awsCode}` : ''})` : '';
  return res.status(502).json({ ok: false, error: e.message + detail });
}

// Discloses bucket, region and prefix — that is infrastructure detail, not
// public information, so it is gated like the rest of the S3 surface.
app.get('/api/s3/config', requireRole('viewer'), (_, res) => {
  const bucket = process.env.S3_BUCKET?.trim() || '';
  res.json({
    bucket,
    region: process.env.S3_REGION?.trim() || 'us-east-1',
    prefix: process.env.S3_PREFIX?.trim() || '',
    configured: !!bucket,
  });
});

// Performs a live AWS call, so anonymous access is both a disclosure and a
// way to spend someone else's money.
app.get('/api/s3/test', requireRole('editor'), async (_, res) => {
  // Connectivity probe. A failure (no bucket, missing credentials, unreachable)
  // is a valid answer — not a server error — so always respond 200 with the
  // result. This keeps S3 sync an optional feature that never breaks the app
  // when it isn't configured. Callers gate their UI on the `ok` field.
  try {
    res.json({ ok: true, ...(await s3Sync.testConnection()) });
  } catch (e) {
    const code = e.code || e.Code || e.name || 'ERROR';
    console.error('[s3] connectivity probe failed:', code, e.message);
    res.json({ ok: false, code, error: e.message });
  }
});

// Limit a sync to one side ('data' = editor, 'planner' = planner) or 'all'.
function s3Scope(value) {
  return value === 'data' || value === 'planner' ? value : 'all';
}

app.get('/api/s3/status', requireRole('viewer'), async (req, res) => {
  const userId = AUTH_MODE === 'multi' ? req.user?.user_id : null;
  try {
    res.json(await s3Sync.getStatus({ userId, scope: s3Scope(req.query?.scope) }));
  } catch (e) {
    s3Error(res, e);
  }
});

app.post('/api/s3/push', requireRole('editor'), express.json(), async (req, res) => {
  const userId = AUTH_MODE === 'multi' ? req.user?.user_id : null;
  try {
    res.json(
      await s3Sync.push({ force: !!req.body?.force, userId, scope: s3Scope(req.body?.scope) }),
    );
  } catch (e) {
    s3Error(res, e);
  }
});

app.post('/api/s3/pull', requireRole('editor'), express.json(), async (req, res) => {
  const userId = AUTH_MODE === 'multi' ? req.user?.user_id : null;
  try {
    res.json(
      await s3Sync.pull({ force: !!req.body?.force, userId, scope: s3Scope(req.body?.scope) }),
    );
  } catch (e) {
    s3Error(res, e);
  }
});

// Metadata summary — returns event metadata for all dataset files (no items arrays)
app.get('/api/meta', async (_, res) => {
  try {
    const files = await collectEventFiles(join(DATA_DIR, 'events'), DATA_DIR);
    const metas = await Promise.all(
      files.map(async (file) => {
        try {
          const target = guardPath(DATA_DIR, file);
          if (!target) return null;
          const raw = await readFile(target, 'utf8');
          const parsed = JSON.parse(raw);
          if (!parsed?.event || typeof parsed.event !== 'object' || Array.isArray(parsed.event))
            return null;
          const m = parsed.event;
          return {
            file,
            designation: String(m.designation || '').trim(),
            location: String(m.location || '').trim(),
            year: String(m.year || '').trim(),
            region: String(m.region || '').trim(),
            venue: String(m.venue || '').trim(),
            enabled: m.enabled !== false,
          };
        } catch {
          return null;
        }
      }),
    );
    res.json(metas.filter(Boolean));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Read a data file (supports subdirectory paths like events/drupalcon/us/2025-atlanta.json)
app.get('/api/data/*', async (req, res) => {
  const target = guardPath(DATA_DIR, req.params[0]);
  if (!target) return res.status(400).json({ error: 'Invalid path' });
  try {
    const raw = await readFile(target, 'utf8');
    res.type('json').send(raw);
  } catch {
    res.status(404).json({ error: 'Not found' });
  }
});

// Write a data file — receives raw JSON text to preserve formatting
app.put(
  '/api/data/*',
  requireRole('editor'),
  express.text({ type: 'application/json', limit: '10mb' }),
  async (req, res) => {
    if (!req.params[0].endsWith('.json')) return res.status(400).json({ error: 'JSON files only' });
    const target = guardPath(DATA_DIR, req.params[0]);
    if (!target) return res.status(400).json({ error: 'Invalid path' });
    let parsed;
    try {
      parsed = JSON.parse(req.body);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    // Schema-validate, not just parse. This route only checked that the body was
    // parseable JSON, so the editor could save a dataset the schema rejects —
    // e.g. `"startDate": "2025-13-28T25:00:00Z"` was written happily and then
    // failed `pnpm run validate` in CI, after it had been committed. The browser
    // validator is more permissive than this one (vendored AJV 6 vs AJV 8 +
    // ajv-formats; see docs/todo.md 2.4), so the client cannot be the only gate.
    //
    // 422 matches /api/v1. `error` carries a readable summary because the editor
    // shows it verbatim — a bare code would tell the person nothing to fix.
    const { valid, errors, skipped } = validateDataFile(req.params[0], parsed);
    if (!valid) {
      return res.status(422).json({
        error: summarizeErrors(errors),
        code: 'validation_failed',
        errors,
      });
    }
    if (skipped) console.log(`[data] ${req.params[0]} is a generated cache — written unvalidated`);

    try {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, req.body, 'utf8');
      res.json({ ok: true });
      regenerateCatalog(`data write: ${req.params[0]}`); // keep the catalog fresh after event edits/creates
      return;
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

// In multi-user mode planner files live under planner/{user_id}/ so each user's
// files are isolated locally, mirroring the planners/{user_id}/ layout in S3.
function userPlannerDir(req) {
  return AUTH_MODE === 'multi' && req.user?.user_id
    ? join(PLANNER_DIR, req.user.user_id)
    : PLANNER_DIR;
}

function s3Configured() {
  return !!process.env.S3_BUCKET?.trim();
}
function plannerUserId(req) {
  return AUTH_MODE === 'multi' ? req.user?.user_id : null;
}

// True when an S3 error means the store is unreachable or misconfigured — as
// opposed to a real per-object result (a missing key is NoSuchKey, handled
// separately). Covers three buckets of failure so a broken/incomplete S3 setup
// degrades to local disk instead of 502-ing every read/write:
//   • not configured / bad credentials
//   • network / unreachable (DNS, refused, timeout)
//   • misconfiguration: bucket missing, wrong region, access denied
// In all of these the planner + upload routes fall back to disk (with a warn),
// keeping S3 optional and a half-configured deployment usable.
function s3Unavailable(e) {
  const name = String(e?.name || '');
  const code = String(e?.code || '');
  const status = e?.$metadata?.httpStatusCode;
  const msg = String(e?.message || '');
  return (
    // not configured / credentials
    code === 'NOT_CONFIGURED' ||
    /Credentials/i.test(name) ||
    /credential/i.test(msg) ||
    ['InvalidAccessKeyId', 'SignatureDoesNotMatch'].includes(name) ||
    // network / unreachable
    ['TimeoutError', 'NetworkingError'].includes(name) ||
    ['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN'].includes(code) ||
    // misconfiguration: bucket missing, wrong region, access denied
    ['NoSuchBucket', 'NotFound', 'PermanentRedirect', 'AccessDenied', 'AllAccessDisabled'].includes(
      name,
    ) ||
    status === 301 ||
    status === 403
  );
}

// The /api/planner/* routes and the /api/v1 planners domain share ONE set of
// document-I/O helpers (plannerList/Read/Write/Remove, defined in the /api/v1
// section below) so the S3-first-with-local-disk-fallback logic lives in exactly
// one place. Those helpers signal failure by throwing HttpError; this adapter
// renders it for the legacy routes.
function sendPlannerError(res, e) {
  if (e instanceof HttpError) {
    return res.status(e.status).json({ error: e.message, ...(e.extra || {}) });
  }
  console.error('[planner]', e);
  return res.status(500).json({ error: e.message });
}

// ── Subscription management ────────────────────────────────────────────────
// REGISTERED BEFORE `/api/planner/*`, which would otherwise match these and
// treat "feeds" as a filename.
//
// Minting happens on the SERVER: the token needs the server's CSPRNG, and the
// browser must never be the thing that decides how strong it is. The plaintext
// is in the response and nowhere else — what persists is a SHA-256 — so this
// endpoint's response body is the only copy that will ever exist.
//
// It writes through plannerWrite, which is S3-first. That makes "saved to S3"
// the same act as "minted", rather than a second step someone has to remember
// before the link works.

async function readPlannerForFeeds(slug, req) {
  const relPath = `${slug}.json`;
  try {
    return { relPath, planner: JSON.parse(await plannerRead(relPath, req)) };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(404, 'Planner not found');
  }
}

app.get('/api/planner/:slug/feeds', requireRole('viewer'), async (req, res) => {
  try {
    const { planner } = await readPlannerForFeeds(req.params.slug, req);
    res.json({ feeds: listFeeds(planner) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post('/api/planner/:slug/feeds', requireRole('editor'), express.json(), async (req, res) => {
  try {
    const { relPath, planner } = await readPlannerForFeeds(req.params.slug, req);
    const { token, entry } = addFeed(planner, { label: req.body?.label });
    await plannerWrite(relPath, JSON.stringify(planner, null, 2), req);
    // The one and only time the plaintext leaves this process.
    res.json({
      ...entry,
      token,
      url: `/planner/${encodeURIComponent(req.params.slug)}/calendar.ics?k=${token}`,
      note: 'Copy this link now — it cannot be shown again.',
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.delete('/api/planner/:slug/feeds/:id', requireRole('editor'), async (req, res) => {
  try {
    const { relPath, planner } = await readPlannerForFeeds(req.params.slug, req);
    if (!revokeFeed(planner, req.params.id)) return res.status(404).json({ error: 'No such feed' });
    // Revocation is a single act that reaches S3 — the old scheme deleted the
    // token locally and asked the reader to remember to push, which is the
    // wrong latency for retiring a leaked credential.
    await plannerWrite(relPath, JSON.stringify(planner, null, 2), req);
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// List planner files
app.get('/api/planner', requireRole('viewer'), async (req, res) => {
  try {
    res.json(await plannerList(req));
  } catch (e) {
    sendPlannerError(res, e);
  }
});

// Read a planner file
app.get('/api/planner/*', requireRole('viewer'), async (req, res) => {
  try {
    res.type('application/json').send(await plannerRead(req.params[0], req));
  } catch (e) {
    sendPlannerError(res, e);
  }
});

// Write a planner file (PUT for existing clients, POST for flush-from-browser).
// Parse + schema-validate here, then hand the raw body to the shared writer.
async function handlePlannerWrite(req, res) {
  if (!req.params[0].endsWith('.json')) return res.status(400).json({ error: 'JSON files only' });
  let parsed;
  try {
    parsed = JSON.parse(req.body);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const { valid, errors } = validatePlanner(parsed);
  if (!valid) {
    return res
      .status(422)
      .json({ error: 'validation_failed', message: 'Planner failed schema validation', errors });
  }
  try {
    res.json(await plannerWrite(req.params[0], req.body, req));
  } catch (e) {
    sendPlannerError(res, e);
  }
}
app.put(
  '/api/planner/*',
  requireRole('editor'),
  express.text({ type: 'application/json', limit: '10mb' }),
  handlePlannerWrite,
);
app.post(
  '/api/planner/*',
  requireRole('editor'),
  express.text({ type: 'application/json', limit: '10mb' }),
  handlePlannerWrite,
);

// Delete a planner file
app.delete('/api/planner/*', requireRole('editor'), async (req, res) => {
  try {
    res.json(await plannerRemove(req.params[0], req));
  } catch (e) {
    sendPlannerError(res, e);
  }
});

// ── /api/v1 CRUD surface ─────────────────────────────────────────────────────
// Versioned REST API for custom integrations. Additive: the legacy /api/data/*
// routes are unchanged. The document-I/O helpers below are the single source of
// truth for reading/writing each domain's whole document (raw JSON string): the
// generic engine in lib/crudApi.js uses them for nested read-modify-write +
// schema validation, and the legacy /api/planner/* routes above delegate to the
// planner ones too. Failure is signalled by throwing HttpError.

// Event datasets — files under app/data/events/, catalog kept fresh on write/delete.
async function datasetRead(relPath) {
  if (!relPath.endsWith('.json')) throw new HttpError(400, 'JSON files only');
  const target = guardPath(DATA_DIR, relPath);
  if (!target) throw new HttpError(400, 'Invalid path');
  try {
    return await readFile(target, 'utf8');
  } catch {
    throw new HttpError(404, 'Not found');
  }
}
async function datasetWrite(relPath, str) {
  if (!relPath.endsWith('.json')) throw new HttpError(400, 'JSON files only');
  const target = guardPath(DATA_DIR, relPath);
  if (!target) throw new HttpError(400, 'Invalid path');
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, str, 'utf8');
  regenerateCatalog(`v1 dataset write: ${relPath}`);
  return { ok: true };
}
async function datasetRemove(relPath) {
  if (!relPath.endsWith('.json')) throw new HttpError(400, 'JSON files only');
  const target = guardPath(DATA_DIR, relPath);
  if (!target) throw new HttpError(400, 'Invalid path');
  try {
    await unlink(target);
  } catch (e) {
    if (e.code === 'ENOENT') throw new HttpError(404, 'Not found');
    throw new HttpError(500, e.message);
  }
  regenerateCatalog(`v1 dataset delete: ${relPath}`);
  return { ok: true };
}
async function datasetList() {
  return (await collectEventFiles(join(DATA_DIR, 'events'), DATA_DIR)).sort((a, b) =>
    a.localeCompare(b),
  );
}

// Per-user planners — the S3-first-with-local-fallback document I/O shared by the
// legacy /api/planner/* routes and the v1 planners domain. A hard (unreachable)
// S3 failure surfaces as 502; a missing object/file as 404.
async function plannerRead(relPath, req) {
  if (!relPath.endsWith('.json')) throw new HttpError(400, 'JSON files only');
  if (s3Configured()) {
    try {
      return await s3Sync.getPlanner(relPath, { userId: plannerUserId(req) });
    } catch (e) {
      if (e.name === 'NoSuchKey') throw new HttpError(404, 'Not found');
      if (!s3Unavailable(e)) throw new HttpError(502, e.message);
      console.warn(`[s3] read unavailable (${e.name}) — serving planner from local disk`);
    }
  }
  const target = guardPath(userPlannerDir(req), relPath);
  if (!target) throw new HttpError(400, 'Invalid path');
  try {
    return await readFile(target, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') throw new HttpError(404, 'Not found');
    throw new HttpError(500, e.message);
  }
}
// Write/delete a planner on local disk. Used both as the no-S3 store and as the
// on-disk mirror kept beside S3 (see plannerWrite/plannerRemove).
async function plannerDiskWrite(relPath, str, req) {
  const target = guardPath(userPlannerDir(req), relPath);
  if (!target) throw new HttpError(400, 'Invalid path');
  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, str, 'utf8');
    return { ok: true };
  } catch (e) {
    throw new HttpError(500, e.message);
  }
}
async function plannerDiskRemove(relPath, req) {
  const target = guardPath(userPlannerDir(req), relPath);
  if (!target) throw new HttpError(400, 'Invalid path');
  try {
    await unlink(target);
    return { ok: true };
  } catch (e) {
    if (e.code === 'ENOENT') throw new HttpError(404, 'Not found');
    throw new HttpError(500, e.message);
  }
}
async function plannerWrite(relPath, str, req) {
  if (!relPath.endsWith('.json')) throw new HttpError(400, 'JSON files only');
  if (s3Configured()) {
    try {
      const result = await s3Sync.putPlanner(relPath, str, { userId: plannerUserId(req) });
      // Mirror the write to local disk so a durable, auditable copy always sits
      // beside the S3 object (S3 stays authoritative on read). Best-effort: a disk
      // failure must never fail a save that already succeeded in S3.
      await plannerDiskWrite(relPath, str, req).catch((e) =>
        console.warn(`[disk] planner mirror write failed: ${e.message}`),
      );
      return { ok: true, ...result };
    } catch (e) {
      if (!s3Unavailable(e)) throw new HttpError(502, e.message);
      console.warn(`[s3] write unavailable (${e.name}) — saving planner to local disk`);
    }
  }
  return plannerDiskWrite(relPath, str, req);
}
async function plannerRemove(relPath, req) {
  if (!relPath.endsWith('.json')) throw new HttpError(400, 'JSON files only');
  if (s3Configured()) {
    try {
      const result = await s3Sync.deletePlanner(relPath, { userId: plannerUserId(req) });
      // Remove the on-disk mirror too so a deleted planner doesn't linger locally.
      // A missing mirror (404) is fine; only log real failures.
      await plannerDiskRemove(relPath, req).catch((e) => {
        if (e.status !== 404) console.warn(`[disk] planner mirror delete failed: ${e.message}`);
      });
      return { ok: true, ...result };
    } catch (e) {
      if (e.name === 'NoSuchKey') throw new HttpError(404, 'Not found');
      if (!s3Unavailable(e)) throw new HttpError(502, e.message);
      console.warn(`[s3] delete unavailable (${e.name}) — deleting planner from local disk`);
    }
  }
  return plannerDiskRemove(relPath, req);
}
async function plannerList(req) {
  if (s3Configured()) {
    try {
      return await s3Sync.listPlannerFiles({ userId: plannerUserId(req) });
    } catch (e) {
      if (!s3Unavailable(e)) throw new HttpError(502, e.message);
      console.warn(`[s3] list unavailable (${e.name}) — listing planners from local disk`);
    }
  }
  const dir = userPlannerDir(req);
  try {
    // No mkdir here. This is a READ, and it used to create the planner directory
    // as a side effect — which fails outright on the read-only filesystem this
    // path exists to support (immutable container, S3 authoritative), turning a
    // listing into a 500. Writes still create what they need on the way past.
    return (await readdir(dir)).filter((f) => f.endsWith('.json'));
  } catch (e) {
    // No local mirror is a legitimate state, not an error: with S3 authoritative
    // the disk may hold nothing, and a fresh install has written no planner yet.
    // Either way the honest answer is "none", not a 500.
    if (e.code === 'ENOENT') return [];
    throw new HttpError(500, e.message);
  }
}

app.get('/api/v1/openapi.yaml', (_, res) =>
  res.type('text/yaml').sendFile(join(APP, 'openapi.yaml')),
);
app.use(
  '/api/v1',
  createV1Router({
    requireRole,
    datasets: {
      list: datasetList,
      read: (p) => datasetRead(p),
      write: (p, s) => datasetWrite(p, s),
      remove: (p) => datasetRemove(p),
      validate: validateDataset,
      schemaFingerprint: DATASET_SCHEMA_FINGERPRINT,
    },
    planners: {
      list: plannerList,
      read: plannerRead,
      write: plannerWrite,
      remove: plannerRemove,
      validate: validatePlanner,
      schemaFingerprint: PLANNER_SCHEMA_FINGERPRINT,
    },
  }),
);

// Upload an image into img/
//
// Memory storage means every upload is held in RAM until it is written, so it needs
// a ceiling: without one a single request can be as large as the client cares to
// make it. 25 MB is well above a scanned receipt or a sponsor logo and well below
// anything that threatens the process.
const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_MAX_BYTES, files: 1 },
});
app.post('/api/upload', uploadLimiter, requireRole('editor'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  const targetRelative = String(req.body.targetPath || '')
    .trim()
    .replace(/^\.\//, '');
  if (!targetRelative || !targetRelative.startsWith('img/')) {
    return res.status(400).json({ error: 'targetPath must start with img/' });
  }
  const target = guardPath(IMG_DIR, targetRelative.slice(4)); // strip "img/"
  if (!target) return res.status(400).json({ error: 'Invalid path' });
  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, req.file.buffer);
    res.json({ ok: true, path: `./${targetRelative}` });
  } catch (e) {
    console.error('[upload]', e.message, e.stack ?? '');
    res.status(500).json({ error: e.message });
  }
});

// Derive the stored filename for an upload. The stored name is ALWAYS server-
// generated — either from the client's `fileName` (a sensible base derived from the
// description, e.g. "conference-pass") or, when that's absent, an autogenerated
// `<prefix>-<timestamp>` — so a silly/non-descript camera name (IMG_9999.jpg) can
// never land on disk. Only the extension is taken from the upload. Collisions get a
// `-2`, `-3`, … suffix so nothing is overwritten.
async function resolveUploadName(slug, fileName, originalName, prefix, exists) {
  const sanitize = (s) => String(s || '').replace(/[^a-zA-Z0-9._-]/g, '_');
  const ext = (originalName.match(/\.([a-zA-Z0-9]+)$/)?.[1] || '').toLowerCase();
  const cleanBase = sanitize(fileName).replace(/^[._-]+|[._-]+$/g, '');
  const pad = (n) => String(n).padStart(2, '0');
  const d = new Date();
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const base = cleanBase || `${prefix || 'file'}-${stamp}`;
  const withExt = (b) => (ext ? `${b}.${ext}` : b);
  let candidate = withExt(base);
  for (let n = 2; n < 1000; n++) {
    const rel = `${slug}/${candidate}`;
    if (!(await exists(rel))) return { name: candidate, rel }; // free slot
    candidate = withExt(`${base}-${n}`); // exists → try the next suffix
  }
  return null;
}

// Write an upload buffer to local disk under `dir` at the resolved sub-path.
// Shared by the no-S3 store and the on-disk mirror kept beside S3.
async function writeUploadDisk(dir, rel, buffer) {
  const target = guardPath(dir, rel);
  if (!target) throw new HttpError(400, 'Invalid path');
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, buffer);
  return target;
}

// Store a receipt/document upload. S3-first when configured (so uploads persist
// across container redeploys, matching the planner's S3-first CRUD), local disk
// otherwise or when S3 is momentarily unavailable. In S3 mode the file is also
// mirrored to local disk (best-effort) so a durable, auditable copy sits beside
// the S3 object. `top` is the shared top-level prefix ('receipts' | 'documents')
// used for both the S3 key and the disk dir.
async function storeUpload(req, res, { dir, top, prefix }) {
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  const eventFile = String(req.body.eventFile || '').trim();
  if (!eventFile) return res.status(400).json({ error: 'eventFile required' });
  const slug = eventFile.endsWith('.json') ? eventFile.slice(0, -5) : eventFile;
  if (!guardPath(dir, slug)) return res.status(400).json({ error: 'Invalid path' });

  if (s3Configured()) {
    try {
      const resolved = await resolveUploadName(
        slug,
        req.body.fileName,
        req.file.originalname,
        prefix,
        (rel) => s3Sync.uploadExists(`${top}/${rel}`),
      );
      if (!resolved) return res.status(400).json({ error: 'Could not allocate filename' });
      await s3Sync.putUpload(`${top}/${resolved.rel}`, req.file.buffer);
      // Mirror to disk beside the S3 object (best-effort: a disk failure must not
      // fail an upload that already succeeded in S3).
      await writeUploadDisk(dir, resolved.rel, req.file.buffer).catch((e) =>
        console.warn(`[disk] ${top} mirror write failed: ${e.message}`),
      );
      return res.json({ ok: true, path: `${top}/${resolved.rel}` });
    } catch (e) {
      if (!s3Unavailable(e)) return res.status(502).json({ error: e.message });
      console.warn(`[s3] upload unavailable (${e.name}) — saving ${top} to local disk`);
    }
  }

  const resolved = await resolveUploadName(
    slug,
    req.body.fileName,
    req.file.originalname,
    prefix,
    async (rel) => {
      const t = guardPath(dir, rel);
      if (!t) return true; // treat invalid as taken so we never write outside dir
      return stat(t).then(
        () => true,
        () => false,
      );
    },
  );
  if (!resolved) return res.status(400).json({ error: 'Could not allocate filename' });
  try {
    await writeUploadDisk(dir, resolved.rel, req.file.buffer);
    res.json({ ok: true, path: `${top}/${resolved.rel}` });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
}

app.post('/api/receipts', uploadLimiter, requireRole('editor'), upload.single('file'), (req, res) =>
  storeUpload(req, res, { dir: RECEIPT_DIR, top: 'receipts', prefix: 'receipt' }),
);

app.post('/api/documents', uploadLimiter, requireRole('editor'), upload.single('file'), (req, res) =>
  storeUpload(req, res, { dir: DOCUMENT_DIR, top: 'documents', prefix: 'document' }),
);

// Delete a stored receipt/document file. S3-first when configured, plus the disk
// mirror (best-effort). A missing file is not an error (idempotent cleanup).
async function removeUpload(req, res, { dir, top }) {
  const rel = req.params[0];
  if (!rel || !guardPath(dir, rel)) return res.status(400).json({ error: 'Invalid path' });
  if (s3Configured()) {
    try {
      await s3Sync.deleteUpload(`${top}/${rel}`);
    } catch (e) {
      if (!s3Unavailable(e)) return res.status(502).json({ error: e.message });
    }
  }
  try {
    await unlink(guardPath(dir, rel));
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`[disk] ${top} delete failed: ${e.message}`);
  }
  res.json({ ok: true });
}

app.delete('/api/receipts/*', requireRole('editor'), (req, res) =>
  removeUpload(req, res, { dir: RECEIPT_DIR, top: 'receipts' }),
);
app.delete('/api/documents/*', requireRole('editor'), (req, res) =>
  removeUpload(req, res, { dir: DOCUMENT_DIR, top: 'documents' }),
);

// Proxy exchange rates from Frankfurter so the browser call is same-origin.
// date param: 'YYYY-MM-DD' for historical lookup, omit for latest rates.
app.get('/api/rates', async (req, res) => {
  const base = String(req.query.base || '').toUpperCase();
  const date = String(req.query.date || '').trim();
  if (!/^[A-Z]{3}$/.test(base)) return res.status(400).json({ error: 'Invalid currency code' });
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date))
    return res.status(400).json({ error: 'Invalid date format, expected YYYY-MM-DD' });
  try {
    const path = date ? `/${date}` : '/latest';
    const upstream = await fetch(`https://api.frankfurter.app${path}?base=${base}`);
    if (!upstream.ok) return res.status(502).json({ error: `Upstream ${upstream.status}` });
    const data = await upstream.json();
    // Historical rates never change — cache them for a year; current rates expire in 1h.
    res.set('Cache-Control', date ? 'public, max-age=31536000' : 'public, max-age=3600').json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── Error pages ────────────────────────────────────────────────────────────
// Until now an unknown URL got Express's built-in `Cannot GET /path`, which
// names the framework, matches nothing else in the product and tells the reader
// nothing useful. These pages are static, script-free and depend only on the
// foundation sheet, because they are served when something has already failed.
//
// Content negotiation matters more than the page does: an API client asked for
// JSON and must keep getting JSON, or error handling in the app breaks. Only a
// request that actually wants HTML gets HTML.

function wantsHtml(req) {
  if (req.path.startsWith('/api/')) return false;
  return req.accepts(['html', 'json']) === 'html';
}

app.use((req, res) => {
  if (wantsHtml(req)) return res.status(404).sendFile(join(APP, '404.html'));
  res.status(404).json({ error: 'Not found' });
});

// Four arguments — Express identifies an error handler by arity, so `next` must
// stay even though it is unused.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // A rejected upload is the client's problem, not a server fault: multer raises a
  // MulterError with a code but no status, which would otherwise read as a 500 and
  // tell the uploader nothing about why their file bounced.
  if (err instanceof multer.MulterError) {
    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    return res.status(tooBig ? 413 : 400).json({
      error: tooBig ? `File too large (limit ${Math.round(UPLOAD_MAX_BYTES / 1024 / 1024)} MB)` : err.message,
    });
  }
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('[server]', err.stack || err.message);
  if (wantsHtml(req)) {
    if (status === 403) return res.status(403).sendFile(join(APP, '403.html'));
    if (status === 404) return res.status(404).sendFile(join(APP, '404.html'));
  }
  res.status(status).json({ error: status >= 500 ? 'Server error' : err.message || 'Error' });
});

// Private state moved out of `app/`. An install that upgrades still has its files
// at the old paths, and the new roots would simply be empty — which looks exactly
// like "all my planners are gone" and invites a panicked restore over the top of
// a working install. Say so, loudly, once, at boot. Cheap to check and it only
// ever fires on a tree that genuinely needs moving.
function warnAboutUnmovedPrivateState() {
  const moves = [
    [join(APP, 'planner'), PLANNER_DIR],
    [join(APP, 'receipts'), RECEIPT_DIR],
    [join(APP, 'documents'), DOCUMENT_DIR],
    [join(DATA_DIR, 'curation'), CURATION_ROOT],
  ].filter(([from, to]) => existsSync(from) && !existsSync(to));
  if (!moves.length) return;
  console.warn('[roots] private state found at its OLD locations — the app is not reading it:');
  for (const [from, to] of moves) console.warn(`[roots]   mv ${from} ${to}`);
  console.warn('[roots] move these, or set PRIVATE_ROOT to where they already live.');
}

const PORT = parseInt(process.env.PORT || '8080', 10);
app.listen(PORT, async () => {
  logAuthMode();
  warnAboutUnmovedPrivateState();
  await bootstrapAdmin().catch((e) => console.error('[auth] bootstrap error:', e.message));
  // Rebuild the catalog from the event files on disk so any added/removed since
  // last run are picked up. Best-effort — a read-only data dir must never block boot.
  await writeCatalog(DATA_DIR)
    .then((c) => logCatalogResult(c, 'built on boot'))
    .catch((e) => console.warn(`[catalog] boot build failed: ${e.message}`));
  console.log(`Conference schedule editor & planner server → http://localhost:${PORT}`);
  console.log(`  schedule → http://localhost:${PORT}/schedule`);
  console.log(`  planner → http://localhost:${PORT}/planner`);
  console.log(`  editor  → http://localhost:${PORT}/editor`);
});
