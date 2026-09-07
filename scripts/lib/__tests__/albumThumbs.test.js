// Resolving an album's cover means fetching a page from someone else's server,
// so the two things worth pinning are what we read out of it and what we refuse
// to fetch at all.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractOgImage, knownAlbums, resolveThumb, duplicateCovers } from '../albumThumbs.js';

describe('extractOgImage', () => {
  it('reads og:image in either attribute order', () => {
    expect(extractOgImage('<meta property="og:image" content="https://x.test/a.jpg">')).toBe(
      'https://x.test/a.jpg',
    );
    expect(extractOgImage("<meta content='https://x.test/b.jpg' property='og:image'>")).toBe(
      'https://x.test/b.jpg',
    );
  });

  it('falls back to twitter:image when there is no og:image', () => {
    expect(extractOgImage('<meta name="twitter:image" content="https://x.test/c.jpg">')).toBe(
      'https://x.test/c.jpg',
    );
  });

  it('ignores a relative image, which we could not resolve later', () => {
    expect(extractOgImage('<meta property="og:image" content="/local/a.jpg">')).toBe('');
  });

  it('says nothing rather than guessing', () => {
    expect(extractOgImage('<html><body>no meta here</body></html>')).toBe('');
    expect(extractOgImage('')).toBe('');
    expect(extractOgImage(null)).toBe('');
  });
});

describe('knownAlbums', () => {
  let dir;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'albums-'));
    await mkdir(join(dir, 'events', 'nested'), { recursive: true });
    await writeFile(
      join(dir, 'events', 'a.json'),
      JSON.stringify({ event: { flickr: { groupUrl: 'https://flic.kr/g/abc' } }, items: [] }),
    );
    await writeFile(
      join(dir, 'events', 'nested', 'b.json'),
      JSON.stringify({
        event: { flickr: { groupUrl: 'https://photos.app.goo.gl/xyz' } },
        items: [],
      }),
    );
    // No album, and a file that will not parse: neither may contribute a URL.
    await writeFile(join(dir, 'events', 'c.json'), JSON.stringify({ event: {}, items: [] }));
    await writeFile(join(dir, 'events', 'broken.json'), '{ not json');
  });
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('collects every recorded album, including nested datasets', async () => {
    const set = await knownAlbums(dir);
    expect([...set].sort()).toEqual(['https://flic.kr/g/abc', 'https://photos.app.goo.gl/xyz']);
  });

  it('is the allowlist: anything not in the archive is simply absent', async () => {
    const set = await knownAlbums(dir);
    // This is what stops the endpoint being pointed at an arbitrary host.
    expect(set.has('http://169.254.169.254/latest/meta-data/')).toBe(false);
    expect(set.has('https://flickr.com/groups/not-ours/')).toBe(false);
  });
});

describe('resolveThumb', () => {
  const page =
    '<html><head><meta property="og:image" content="https://live.staticflickr.com/1.jpg"></head></html>';

  it('fetches once and serves the cache afterwards', async () => {
    const cache = {};
    const fetchImpl = vi.fn(async () => ({ ok: true, text: async () => page }));
    const first = await resolveThumb('https://flic.kr/g/abc', { cache, fetchImpl });
    expect(first).toEqual({ thumb: 'https://live.staticflickr.com/1.jpg', cached: false });

    const second = await resolveThumb('https://flic.kr/g/abc', { cache, fetchImpl });
    expect(second).toEqual({ thumb: 'https://live.staticflickr.com/1.jpg', cached: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('remembers a miss, so a coverless album is not re-fetched every time', async () => {
    const cache = {};
    const fetchImpl = vi.fn(async () => ({ ok: true, text: async () => '<html></html>' }));
    expect((await resolveThumb('https://x.test/none', { cache, fetchImpl })).thumb).toBe('');
    expect((await resolveThumb('https://x.test/none', { cache, fetchImpl })).cached).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('gives up on a miss far sooner than on a hit', async () => {
    // Resolving 33 albums in a row had Google rate-limit two of them; both had
    // covers seconds later. A miss must not be believed for a month.
    const fetchImpl = vi.fn(async () => ({ ok: true, text: async () => page }));
    const missCache = { 'https://x.test/a': { thumb: '', at: 0 } };
    expect(
      (await resolveThumb('https://x.test/a', { cache: missCache, fetchImpl, now: 3 * 864e5 }))
        .cached,
    ).toBe(false);

    const hitCache = { 'https://x.test/b': { thumb: 'https://old.test/x.jpg', at: 0 } };
    expect(
      (await resolveThumb('https://x.test/b', { cache: hitCache, fetchImpl, now: 3 * 864e5 }))
        .cached,
    ).toBe(true);
  });

  it('refetches once the cached answer is old enough to be worth rechecking', async () => {
    const cache = { 'https://flic.kr/g/abc': { thumb: 'https://old.test/x.jpg', at: 0 } };
    const fetchImpl = vi.fn(async () => ({ ok: true, text: async () => page }));
    const r = await resolveThumb('https://flic.kr/g/abc', { cache, fetchImpl, now: 40 * 864e5 });
    expect(r.cached).toBe(false);
    expect(r.thumb).toBe('https://live.staticflickr.com/1.jpg');
  });

  it('treats an unreachable host as "no cover", not as a failure', async () => {
    const cache = {};
    const fetchImpl = vi.fn(async () => {
      throw new Error('ETIMEDOUT');
    });
    await expect(resolveThumb('https://x.test/down', { cache, fetchImpl })).resolves.toEqual({
      thumb: '',
      cached: false,
    });
  });
});

// A cache holding the WRONG cover is worse than one holding none: a hit lives for
// thirty days, so a bad write is served for a month and filling gaps never
// touches it. Production showed one photograph on all 54 cards until somebody
// noticed by eye — this is the check that makes it self-correcting.
describe('duplicateCovers', () => {
  const at = 1;
  const cache = (pairs) => Object.fromEntries(pairs.map(([u, t]) => [u, { thumb: t, at }]));

  it('flags a cover claimed by three or more albums', () => {
    const same = 'https://live.staticflickr.com/same.jpg';
    const urls = ['a', 'b', 'c', 'd'];
    const dupes = duplicateCovers(
      cache([
        ['a', same],
        ['b', same],
        ['c', same],
        ['d', 'https://x/1.jpg'],
      ]),
      urls,
    );
    expect([...dupes.keys()]).toEqual([same]);
    expect(dupes.get(same)).toEqual(['a', 'b', 'c']);
  });

  it('leaves two albums sharing a cover alone — the same photo can be in two pools', () => {
    const same = 'https://live.staticflickr.com/same.jpg';
    expect(
      duplicateCovers(
        cache([
          ['a', same],
          ['b', same],
        ]),
        ['a', 'b'],
      ).size,
    ).toBe(0);
  });

  it('ignores albums with no cover, however many there are', () => {
    const c = cache([
      ['a', ''],
      ['b', ''],
      ['c', ''],
      ['d', ''],
    ]);
    expect(duplicateCovers(c, ['a', 'b', 'c', 'd']).size).toBe(0);
  });

  it('does not flag a healthy cache', () => {
    const c = cache([
      ['a', 'https://x/1.jpg'],
      ['b', 'https://x/2.jpg'],
      ['c', 'https://x/3.jpg'],
    ]);
    expect(duplicateCovers(c, ['a', 'b', 'c']).size).toBe(0);
  });
});
