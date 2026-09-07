// Where content lives on disk — the single answer for the whole app.
//
// The app renders an archive; it should not care WHERE that archive sits. Every
// root here is env-overridable and defaults to exactly the layout that shipped
// before this module existed, so an install that sets nothing behaves
// identically.
//
// Three independent roots:
//
//   CONTENT_PATH  the content directory — the usual way to point the app at data
//   DATA_ROOT     public archive — events/, sponsors.json, themes.json, caches
//   IMG_ROOT      data-owned images — sponsors/, flickr/, logos/
//   PRIVATE_ROOT  this installation's state — planners, uploads, curation
//
// Set CONTENT_PATH and the three roots follow; set a root and it wins. Precedence
// is: explicit root → CONTENT_PATH → the in-repo default.
//
// The private sub-roots all derive from PRIVATE_ROOT, so pointing it somewhere
// else moves them together. That is the point: private state has one owner and
// one mount, and can live on a volume, in its own repo, or nowhere at all when S3
// is authoritative.
//
// URLs are NOT affected by any of this. Dataset files store `./img/…` paths and
// the client fetches `./data/catalog.json`, so `/data` and `/img` stay the URL
// contract no matter what the disk looks like — server.js mounts these roots
// there explicitly rather than relying on them happening to live inside `app/`.

import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The repository root — the anchor for defaults and for relative overrides.
 *
 * Derived from this file's own location, which means it MOVES WHEN THIS FILE
 * MOVES. That is not hypothetical: when this module lived at `lib/roots.js` the
 * hop was one level, and relocating it to `scripts/lib/` silently repointed
 * ROOT at `scripts/` — taking DATA_ROOT, PRIVATE_ROOT and the S3 manifest with
 * it. Nothing failed; the paths were simply wrong, which is worse.
 *
 * roots.test.js now pins ROOT to the directory holding package.json, so the next
 * move fails a test instead of a deployment.
 */
export const ROOT = resolve(HERE, '..', '..');

/** The served static tree. App chrome, HTML entry points, client JS/CSS. */
export const APP = join(ROOT, 'app');

/**
 * Read a root from the environment, resolved to an absolute, normalised path.
 *
 * Resolution matters more than it looks. `guardPath` compares a resolved
 * candidate against its base with `startsWith`, so a base carrying a trailing
 * slash, a `./` prefix, or an unresolved `..` would never match its own children
 * and every guarded write would start returning null. That fails closed — safe,
 * but it presents as "the editor stopped saving", which is a bad afternoon. Do
 * the resolution once, here, and the comparison downstream is always sound.
 *
 * A relative override resolves against the repo root, not the process CWD, so
 * `DATA_ROOT=../archive` means the same thing regardless of where the server was
 * started from.
 *
 * @param {string} name env var to read
 * @param {string} fallback absolute path used when unset or blank
 * @returns {string}
 */
function rootFromEnv(name, fallback) {
  return absolutize(process.env[name]?.trim()) ?? fallback;
}

/** @param {string|undefined} raw @returns {string|null} */
function absolutize(raw) {
  if (!raw) return null;
  return isAbsolute(raw) ? resolve(raw) : resolve(ROOT, raw);
}

/**
 * CONTENT_PATH — one variable naming WHERE the content directory is, so the path
 * to it is written down once instead of three times.
 *
 * The three roots below then derive from it:
 *
 *   CONTENT_PATH=../my-content-directory
 *     → DATA_ROOT    = <CONTENT_PATH>/public
 *     → IMG_ROOT     = <CONTENT_PATH>/public/img
 *     → PRIVATE_ROOT = <CONTENT_PATH>/private
 *
 * The derivation has to happen HERE rather than in `.env`, because Node's
 * `--env-file` parser does no variable expansion — `DATA_ROOT=${CONTENT_PATH}/public`
 * would be read as that literal string, dollars and braces included. (Docker
 * Compose *does* interpolate, which is why the compose file can write
 * `${CONTENT_PATH}/public` directly and this module cannot.)
 *
 * Setting a root explicitly still wins, so a layout that is not public/private —
 * an archive and a state volume in unrelated places — remains expressible.
 */
const CONTENT_PATH = absolutize(process.env.CONTENT_PATH?.trim());

/** Public archive: event datasets, sponsors.json, themes.json, committed caches. */
export const DATA_ROOT = rootFromEnv(
  'DATA_ROOT',
  CONTENT_PATH ? join(CONTENT_PATH, 'public') : join(APP, 'data'),
);

/**
 * Data-owned images: sponsors/, flickr/, logos/. Served at `/img`.
 *
 * Under CONTENT_PATH the images sit inside the archive (`public/img`); without it
 * the historical `app/img` stands, so an install that sets only DATA_ROOT keeps
 * the behaviour it had.
 */
export const IMG_ROOT = rootFromEnv(
  'IMG_ROOT',
  CONTENT_PATH ? join(CONTENT_PATH, 'public', 'img') : join(APP, 'img'),
);

/**
 * This installation's private state. Never served as a whole.
 *
 * Deliberately OUTSIDE `app/`. While it sat inside, `express.static(APP)` was one
 * unmatched URL shape away from serving planners and uploads to anyone — which
 * had already happened once (see the note above PRIVATE_TREES in server.js). The
 * HTTP guards stay, but a private tree that is not in the served directory at all
 * cannot be leaked by a routing mistake.
 */
export const PRIVATE_ROOT = rootFromEnv(
  'PRIVATE_ROOT',
  CONTENT_PATH ? join(CONTENT_PATH, 'private') : join(ROOT, 'private'),
);

/**
 * Planner state — one JSON per planner, plus tombstones and global settings.
 * Plural, matching the `planners/` S3 prefix it has always synced to.
 */
export const PLANNER_ROOT = join(PRIVATE_ROOT, 'planners');

/** Receipt uploads. The S3 prefix (`receipts/`) is independent of this path. */
export const RECEIPT_ROOT = join(PRIVATE_ROOT, 'receipts');

/** Document uploads. The S3 prefix (`documents/`) is independent of this path. */
export const DOCUMENT_ROOT = join(PRIVATE_ROOT, 'documents');

/**
 * The curation ledger's home — private, because it is an identity document: it
 * maps pseudonyms to the real names behind them.
 *
 * It lived in the public data tree, which meant a static deploy that copied that
 * tree published it. The S3 key is deliberately NOT moving with it (see
 * DECISIONS_SUBPATH in s3-sync.js) — the bucket layout is a contract with every
 * existing installation, and only the local side is ours to change.
 */
export const CURATION_ROOT = join(PRIVATE_ROOT, 'curation');

/**
 * Where the ledger used to live. Read-through fallback ONLY — never written.
 *
 * An install that upgrades has its decisions at the old path, and that ledger is
 * the sole record of slow human reconciliation work; silently starting from an
 * empty one would look like the work was lost. Reads fall back here, the next
 * write lands in CURATION_ROOT, and the old file becomes inert.
 */
export const LEGACY_CURATION_ROOT = join(DATA_ROOT, 'curation');

/**
 * Resolve `sub` beneath `base`, or null if it escapes.
 *
 * Both sides are resolved before comparing. The base is normally already a root
 * from this module and therefore absolute, but scripts pass their own bases and
 * an unresolved one silently rejects everything (see rootFromEnv above).
 *
 * @param {string} base directory the result must stay inside
 * @param {string} sub untrusted relative path
 * @returns {string | null} absolute path, or null if it escapes `base`
 */
export function guardPath(base, sub) {
  const root = resolve(base);
  const full = resolve(join(root, sub));
  return full === root || full.startsWith(root + sep) ? full : null;
}
