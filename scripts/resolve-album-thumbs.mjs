#!/usr/bin/env node
// Resolve a cover image for every photo album in the archive.
//
//   pnpm run resolve:albums            # fill in anything not already cached
//   pnpm run resolve:albums -- --retry # also re-ask the ones that came back empty
//   pnpm run resolve:albums -- --all   # re-ask everything, cache or not
//   pnpm run resolve:albums -- --prune # also drop albums the archive no longer has
//
// The archive page resolves covers on demand, so this is not required — but it is
// how you fix the case where an album shows blank because a burst of requests got
// rate-limited and the empty answer was cached. It is also worth running before a
// deploy, so the first visitor is not the one paying for 33 lookups.
//
// A plain run SKIPS anything that already has a cover, which is right for a cache
// but wrong for a cache holding the wrong answer. That is not hypothetical: a
// production deploy once served the same photo on all 54 cards, and because a hit
// is kept for thirty days it would have stayed that way for a month. So before
// resolving anything, the cache is checked for one cover claimed by many albums —
// the shape that failure takes — and those entries are re-asked whatever their age.
import {
  knownAlbums,
  loadThumbCache,
  saveThumbCache,
  resolveThumb,
  duplicateCovers,
} from './lib/albumThumbs.js';
import { DATA_ROOT } from './lib/roots.js';

const DATA = DATA_ROOT;
const argv = process.argv.slice(2);
const RETRY_MISSES = argv.includes('--retry');
const ALL = argv.includes('--all');
const PRUNE = argv.includes('--prune');

const albums = [...(await knownAlbums(DATA))].sort();
const cache = await loadThumbCache(DATA);

const poisoned = new Set();
for (const [thumb, urls] of duplicateCovers(cache, albums)) {
  console.warn(`[albums] ${urls.length} albums share one cover — re-asking all of them`);
  console.warn(`[albums]   ${thumb}`);
  for (const u of urls) poisoned.add(u);
}

if (PRUNE) {
  const gone = Object.keys(cache).filter((u) => !albums.includes(u));
  for (const u of gone) delete cache[u];
  if (gone.length) console.log(`pruned ${gone.length} cached album(s) no longer in the archive`);
}

let resolved = 0;
let already = 0;
const still = [];

for (const url of albums) {
  const known = cache[url];
  const skip = !ALL && !poisoned.has(url) && known && (known.thumb || !RETRY_MISSES);
  if (skip) {
    already += 1;
    if (!known.thumb) still.push(url);
    continue;
  }
  const { thumb } = await resolveThumb(url, { cache, refresh: true });
  if (thumb) resolved += 1;
  else still.push(url);
  process.stdout.write(`${thumb ? '·' : '×'}`);
  // These are other people's servers, and asking for 33 pages at once is how two
  // of them came back empty the first time. A pause is cheaper than a retry.
  await new Promise((r) => setTimeout(r, 400));
}

await saveThumbCache(DATA, cache);
const withCover = albums.filter((u) => cache[u]?.thumb).length;
console.log(
  `\n${albums.length} albums · ${withCover} with a cover · ${resolved} resolved now · ${already} already cached`,
);
for (const url of still) console.log(`   no cover: ${url}`);
if (still.length) console.log('\nRe-ask these with: pnpm run resolve:albums -- --retry');
