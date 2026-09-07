// Reading the scrape caches under cache/wayback/ back into source descriptors.
//
// These directories accumulated over a year of scraping and no two generations
// agree on a format. There are six shapes in there right now:
//
//   manifest.json          items[] with url, file, title, sha256 — the richest
//   urls.json  (a)         schedule_url + session_links[]
//   urls.json  (b)         schedule_urls[] + session_links[]
//   urls.json  (c)         generatedAt + urls[]
//   urls.json  (d)         programme_url + downloaded_session_pages[]
//   raw/*.txt              bare URL lists (sources.txt, <name>.url.txt)
//
// Rewriting the caches to one format would be the tidier fix, but they are the
// evidence — rewriting evidence to make a script simpler is the wrong trade. So
// the mess is absorbed here, once, and everything downstream sees one shape.
//
// The value being recovered: these files hold the Wayback URLs the data was
// actually scraped from, which means capture dates and per-session source URLs
// that no longer exist anywhere else. Several of the sites involved are gone.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * @typedef {object} CacheEntry
 * @property {string} url live or Wayback URL
 * @property {string} [file] repo-relative path to the local copy
 * @property {string} [title]
 * @property {'schedule'|'sessions'|'venue'|'other'} role what the page was
 */

/**
 * @typedef {object} CacheRead
 * @property {string} dir
 * @property {string|null} retrievedAt when we fetched, if the cache recorded it
 * @property {CacheEntry[]} entries
 * @property {string[]} shapes which formats were found, for the report
 */

// Page furniture, not evidence. Note what is NOT here: a PDF is very often the
// programme itself for an older conference, and .zip/.mp4 can be the recording
// or the proceedings. Only things that cannot carry a fact are excluded.
const ASSET_RE = /\.(png|jpe?g|gif|svg|webp|ico|css|js|woff2?|ttf|eot)(\?|#|$)/i;

/** JSON, or null when absent/unparseable. A broken cache file is not fatal. */
function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** URLs from a text file, one per line, blanks and comments dropped. */
function readUrlLines(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && /^https?:\/\//.test(line));
}

/**
 * Guess what a page was from its URL and filename.
 *
 * Deliberately coarse. `sessions` means a per-session detail page — the ones
 * that carry descriptions and speaker names — and everything schedule-shaped is
 * `schedule`. Getting this wrong mislabels a source's kind, not its URL, so a
 * wrong guess is cosmetic and correctable in the editor.
 *
 * @param {string} url
 * @param {string} [file]
 * @returns {CacheEntry['role']}
 */
export function classifyEntry(url, file) {
  const haystack = `${url} ${file ?? ''}`.toLowerCase();
  if (/venue|accommodation|hotel/.test(haystack)) return 'venue';
  // A `/session/` PATH SEGMENT is the reliable marker of a detail page. The
  // looser `session` test has to come after the schedule one, because
  // `/program/session-schedule/all` is a schedule that contains the word — and
  // reading it as a session page cost one event its entire item attribution.
  if (/\/sessions?\/|\/talks?\//.test(haystack)) return 'sessions';
  if (/schedule|programme|program|agenda|day-?\d|\d{4}-\d{2}-\d{2}/.test(haystack)) {
    return 'schedule';
  }
  if (/session|talk/.test(haystack)) return 'sessions';
  return 'other';
}

/**
 * Read one cache directory, whatever format it happens to be in.
 *
 * @param {string} dir absolute path to a cache/wayback/<event> directory
 * @param {string} [relTo] prefix for the reported `file` paths
 * @returns {CacheRead}
 */
export function readCacheDir(dir, relTo = '') {
  /** @type {CacheEntry[]} */
  const entries = [];
  const shapes = [];
  let retrievedAt = null;
  const raw = join(dir, 'raw');
  const rel = (path) => (relTo ? join(relTo, path.slice(dir.length + 1)) : path);
  /**
   * @param {any} url
   * @param {{file?: string, title?: string, role?: CacheEntry['role'], hint?: string}} [opts]
   */
  const push = (url, opts = {}) => {
    if (typeof url !== 'string' || !/^https?:\/\//.test(url.trim())) return;
    const clean = url.trim();
    // An asset is not a source. The caches sometimes swept up a logo or a
    // stylesheet alongside the pages, and one of them ended up in the registry
    // as an `other` source that nothing could ever cite — a PNG does not say
    // who spoke at a conference.
    if (ASSET_RE.test(clean)) return;
    // The same URL turns up in a manifest and in a stray .url.txt beside it.
    if (entries.some((e) => e.url === clean)) return;
    const { file, title, role, hint } = opts;
    entries.push({
      url: clean,
      ...(file ? { file: rel(file) } : {}),
      ...(title ? { title } : {}),
      // An explicit role beats sniffing: `session_links` says what those pages
      // are, while their URLs (`lanyrd.com/2013/drupalgov/scmgwz/`) do not.
      role: role ?? classifyEntry(clean, hint ?? file),
    });
  };

  const manifest = readJson(join(dir, 'manifest.json'));
  if (manifest?.items?.length) {
    shapes.push('manifest.json');
    if (manifest.cachedAt) retrievedAt = String(manifest.cachedAt).slice(0, 10);
    for (const item of manifest.items) {
      push(item?.url, {
        file: item?.file ? join(raw, item.file) : undefined,
        title: item?.title,
      });
    }
  }

  const urls = readJson(join(raw, 'urls.json'));
  if (urls) {
    shapes.push('urls.json');
    const stamp = urls.generatedAt ?? urls.downloaded_at;
    if (stamp && !retrievedAt) retrievedAt = String(stamp).slice(0, 10);
    // Shapes (a) through (d), each contributing whichever keys it happens to
    // have. Reading them all unconditionally beats detecting the variant.
    push(urls.schedule_url, { role: 'schedule' });
    push(urls.programme_url, { role: 'schedule' });
    for (const url of urls.schedule_urls ?? []) push(url, { role: 'schedule' });
    for (const url of urls.urls ?? []) push(url);
    for (const url of urls.session_links ?? []) push(url, { role: 'sessions' });
    for (const page of urls.downloaded_session_pages ?? []) {
      push(typeof page === 'string' ? page : page?.url, { role: 'sessions' });
    }
  }

  // Bare URL lists: sources.txt, schedule.url.txt, session-wayback-urls.txt.
  if (existsSync(raw)) {
    for (const name of readdirSync(raw)) {
      if (!/\.(txt)$/.test(name) || name === 'SHA256SUMS.txt') continue;
      const path = join(raw, name);
      if (!statSync(path).isFile()) continue;
      let lines;
      try {
        lines = readUrlLines(path);
      } catch {
        continue;
      }
      if (!lines.length) continue;
      shapes.push(name);
      // `schedule.url.txt` sits beside `schedule.html`; pair them so the source
      // records where the local copy is.
      const sibling = name.replace(/\.url\.txt$|\.txt$/, '.html');
      const siblingPath = join(raw, sibling);
      const hasSibling = existsSync(siblingPath);
      for (const url of lines) {
        push(url, {
          file: hasSibling && lines.length === 1 ? siblingPath : undefined,
          hint: name,
        });
      }
    }
  }

  if (!retrievedAt && existsSync(raw)) {
    // No cache recorded when it ran. The directory's own mtime is a worse
    // answer than a stated one but a much better answer than none — and it is
    // honest: it is when the files landed.
    try {
      retrievedAt = statSync(raw).mtime.toISOString().slice(0, 10);
    } catch {
      /* leave null */
    }
  }

  return { dir: basename(dir), retrievedAt, entries, shapes };
}

/**
 * Every cache directory under `root`, read.
 *
 * @param {string} root cache/wayback
 * @param {string} [relTo]
 * @returns {CacheRead[]}
 */
export function readAllCaches(root, relTo = '') {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => statSync(join(root, name)).isDirectory())
    .sort()
    .map((name) => readCacheDir(join(root, name), relTo ? join(relTo, name) : ''));
}
