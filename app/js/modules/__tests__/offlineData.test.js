import { describe, it, expect, beforeEach } from 'vitest';
import { loadJson, saveCopy, readCopy, savedAgo, DATA_CACHE } from '../offlineData.js';

// A minimal Cache Storage stand-in. The node test env has none, and the module
// takes an injectable scope precisely so this logic is testable without a browser.
function fakeCaches() {
  const stores = new Map();
  return {
    caches: {
      async open(name) {
        if (!stores.has(name)) stores.set(name, new Map());
        const store = stores.get(name);
        return {
          async put(url, response) {
            // Store the BYTES, not the Response. A body can only be read once,
            // and the real Cache Storage hands back a fresh Response per match —
            // a fake that returns the same object makes the second read fail and
            // looks like a cache miss in production code that is actually fine.
            store.set(String(url), {
              body: await response.text(),
              headers: [...response.headers.entries()],
            });
          },
          async match(url) {
            const hit = store.get(String(url));
            return hit ? new Response(hit.body, { headers: hit.headers }) : undefined;
          },
        };
      },
    },
    stores,
  };
}

const okJson = (body, headers = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { ...headers } });

let scope;

beforeEach(() => {
  scope = { ...fakeCaches() };
});

describe('loadJson', () => {
  it('returns fresh data and saves a copy', async () => {
    const r = await loadJson('/data/x.json', {
      scope,
      fetchFn: async () => okJson({ hello: 'world' }),
    });
    expect(r).toMatchObject({ fromCache: false, savedAt: null });
    expect(r.data).toEqual({ hello: 'world' });

    const saved = await readCopy('/data/x.json', { scope });
    expect(saved.data).toEqual({ hello: 'world' });
  });

  it('falls back to the saved copy when the network fails', async () => {
    await saveCopy('/data/x.json', JSON.stringify({ from: 'cache' }), {
      scope,
      now: new Date('2026-08-19T00:00:00Z'),
    });
    const r = await loadJson('/data/x.json', {
      scope,
      fetchFn: async () => {
        throw new Error('offline');
      },
    });
    expect(r.fromCache).toBe(true);
    expect(r.data).toEqual({ from: 'cache' });
    expect(r.savedAt.toISOString()).toBe('2026-08-19T00:00:00.000Z');
  });

  it('treats a non-200 as a failure, not as data', async () => {
    // An HTML 404 page parses as JSON in some setups; "not found" is not a
    // programme with no sessions.
    await saveCopy('/data/x.json', JSON.stringify({ from: 'cache' }), { scope });
    const r = await loadJson('/data/x.json', {
      scope,
      fetchFn: async () => new Response('<!doctype html>', { status: 404 }),
    });
    expect(r.fromCache).toBe(true);
  });

  it('throws only when BOTH the network and the cache fail', async () => {
    await expect(
      loadJson('/data/missing.json', {
        scope,
        fetchFn: async () => {
          throw new Error('offline');
        },
      }),
    ).rejects.toThrow(/offline/);
  });

  it('does not overwrite a good copy with a failed response', async () => {
    await saveCopy('/data/x.json', JSON.stringify({ good: true }), { scope });
    await loadJson('/data/x.json', {
      scope,
      fetchFn: async () => new Response('nope', { status: 500 }),
    }).catch(() => {});
    expect((await readCopy('/data/x.json', { scope })).data).toEqual({ good: true });
  });

  it('calls fetch bound to its global, as a browser demands', async () => {
    // Regression: `const doFetch = scope.fetch` then `doFetch(url)` throws
    // "Illegal invocation" in Chrome, which brand-checks `this`. Node's fetch does
    // not, so this passed in tests and failed only in the real app — where the
    // throw landed in the offline path and looked exactly like being offline.
    // This scope brand-checks the way a browser does.
    const branded = {
      caches: scope.caches,
      fetch() {
        if (this !== branded) throw new TypeError('Illegal invocation');
        return Promise.resolve(okJson({ ok: true }));
      },
    };
    const r = await loadJson('/data/x.json', { scope: branded });
    expect(r.data).toEqual({ ok: true });
    expect(r.fromCache).toBe(false);
  });

  it('works where there is no Cache Storage at all', async () => {
    const bare = {};
    const r = await loadJson('/data/x.json', {
      scope: bare,
      fetchFn: async () => okJson({ a: 1 }),
    });
    expect(r.data).toEqual({ a: 1 });
    expect(await readCopy('/data/x.json', { scope: bare })).toBeNull();
  });

  it('treats a corrupt cache entry as a miss', async () => {
    const cache = await scope.caches.open(DATA_CACHE);
    await cache.put('/data/x.json', new Response('{not json'));
    expect(await readCopy('/data/x.json', { scope })).toBeNull();
  });
});

describe('savedAgo', () => {
  const now = new Date('2026-08-19T12:00:00Z');
  it.each([
    ['2026-08-19T11:59:30Z', 'saved just now'],
    ['2026-08-19T11:30:00Z', 'saved 30 minutes ago'],
    ['2026-08-19T11:00:00Z', 'saved 1 hour ago'],
    ['2026-08-19T06:00:00Z', 'saved 6 hours ago'],
    ['2026-08-17T12:00:00Z', 'saved 2 days ago'],
  ])('%s → %s', (iso, expected) => {
    expect(savedAgo(new Date(iso), now)).toBe(expected);
  });

  it('does not invent precision it does not have', () => {
    expect(savedAgo(null, now)).toBe('saved earlier');
  });
});
