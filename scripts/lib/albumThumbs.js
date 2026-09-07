// A cover image for a photo album, without an API key for every host.
//
// Flickr and Google Photos both publish an `og:image` on the album's own page —
// the picture they would show if you pasted the link into a chat app — so one
// resolver covers both, and anything else that follows the same convention.
//
// Two things make this safe to do from the server. The URL must already be an
// album recorded in the archive, so this cannot be pointed at an arbitrary host;
// and every answer is cached to disk, because an album's cover changes about as
// often as the conference happens.
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Read `og:image` (either attribute order) from a page. */
export function extractOgImage(html) {
  const s = String(html || '');
  const m =
    s.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
    s.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) ||
    s.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
  const url = m?.[1]?.trim();
  // Only an absolute http(s) image is worth storing: a relative one would have to
  // be resolved against a page we do not otherwise keep.
  return url && /^https?:\/\//i.test(url) ? url : '';
}

async function datasetFiles(dir, out = []) {
  for (const name of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) await datasetFiles(p, out);
    else if (name.name.endsWith('.json')) out.push(p);
  }
  return out;
}

/**
 * Every album URL the archive actually records.
 *
 * This is the allowlist: a request to resolve anything else is refused, so the
 * endpoint cannot be used to make the server fetch a URL of the caller's
 * choosing.
 *
 * @param {string} dataDir
 * @returns {Promise<Set<string>>}
 */
export async function knownAlbums(dataDir) {
  const out = new Set();
  for (const path of await datasetFiles(join(dataDir, 'events'))) {
    try {
      const d = JSON.parse(await readFile(path, 'utf8'));
      const url = String(d?.event?.flickr?.groupUrl || '').trim();
      if (url) out.add(url);
    } catch {
      /* a dataset that will not parse has no album to offer */
    }
  }
  return out;
}

/**
 * Read a response only as far as its og:image.
 *
 * Flickr puts the tag in the first few kilobytes; Google Photos puts it 1.1 MB
 * into a 1.4 MB document. Reading the whole body for both meant every Google
 * album cost seconds and megabytes, so this consumes the stream in chunks and
 * stops at the tag — and gives up at a ceiling rather than trusting a stranger's
 * page to end.
 *
 * @param {Response} res
 * @param {number} [maxBytes]
 */
async function readOgImage(res, maxBytes = 2_000_000) {
  if (!res.body?.getReader) return extractOgImage((await res.text()).slice(0, maxBytes));
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (buf.length < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const found = extractOgImage(buf);
      if (found) return found;
      // The tag never appears after </head>; anything past it is the app itself.
      if (buf.includes('</head>')) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return extractOgImage(buf);
}

/**
 * Albums whose cached cover is shared with several others.
 *
 * A cache holding the WRONG answer is worse than one holding none: a hit lives
 * for thirty days, so a bad write is served for a month. Production once showed
 * the same photograph on all 54 cards, and nothing in a normal run would have
 * corrected it — filling gaps skips every entry that already has a cover.
 *
 * Two albums sharing a cover is possible (the same photo in two pools), so one
 * duplicate is not evidence. Three is: no real archive has one picture standing
 * for three different conferences.
 *
 * @param {Record<string, {thumb?: string}>} cache
 * @param {Iterable<string>} albums
 * @param {number} [min] how many albums must share a cover before it is suspect
 * @returns {Map<string, string[]>} cover url → the albums claiming it
 */
export function duplicateCovers(cache, albums, min = 3) {
  const byThumb = new Map();
  for (const url of albums) {
    const thumb = cache?.[url]?.thumb;
    if (!thumb) continue;
    if (!byThumb.has(thumb)) byThumb.set(thumb, []);
    byThumb.get(thumb).push(url);
  }
  return new Map([...byThumb].filter(([, urls]) => urls.length >= min));
}

const CACHE_FILE = 'album-thumbs.json';

export async function loadThumbCache(dataDir) {
  try {
    return JSON.parse(await readFile(join(dataDir, CACHE_FILE), 'utf8'));
  } catch {
    return {}; // no cache yet is the normal first run, not an error
  }
}

export async function saveThumbCache(dataDir, cache) {
  await writeFile(join(dataDir, CACHE_FILE), `${JSON.stringify(cache, null, 2)}\n`);
}

/**
 * Resolve one album's cover, using the cache first.
 *
 * A miss is cached too — as an empty string with a timestamp — so an album whose
 * host publishes nothing is not re-fetched on every page view. It is kept for far
 * less time than a hit, because a miss is often not the album's fault: resolving
 * all 33 in a row had Google rate-limit two of them, and both had covers when
 * asked again a moment later. A month of blankness for a momentary 429 is the
 * wrong trade.
 *
 * `refresh` re-asks even when the cache has an answer — the way to clear a miss
 * that was really a rate-limit, without waiting for it to expire.
 *
 * @param {string} url
 * @param {{cache: Record<string, any>, fetchImpl?: typeof fetch, now?: number, ttlDays?: number, missTtlDays?: number, refresh?: boolean}} opts
 */
export async function resolveThumb(
  url,
  {
    cache,
    fetchImpl = fetch,
    now = Date.now(),
    ttlDays = 30,
    missTtlDays = 2,
    refresh = false,
  } = {},
) {
  const hit = cache[url];
  const ttl = (hit?.thumb ? ttlDays : missTtlDays) * 864e5;
  if (!refresh && hit && now - (hit.at || 0) < ttl) return { thumb: hit.thumb || '', cached: true };

  let thumb = '';
  try {
    const res = await fetchImpl(url, {
      redirect: 'follow',
      headers: { 'user-agent': 'conference-planner (archive album preview)' },
      signal: AbortSignal.timeout(12000),
    });
    if (res.ok) {
      thumb = await readOgImage(res);
    }
  } catch {
    thumb = ''; // unreachable host, timeout, bad TLS — all the same answer here
  }
  cache[url] = { thumb, at: now };
  return { thumb, cached: false };
}
