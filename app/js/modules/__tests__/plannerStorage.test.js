import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock localStorage before importing the module
const store = new Map();
vi.stubGlobal('localStorage', {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => store.set(k, v),
  removeItem: (k) => store.delete(k),
  get length() {
    return store.size;
  },
  key: (i) => [...store.keys()][i] ?? null,
});

import {
  STORAGE_PREFIX,
  GLOBAL_KEY,
  STORAGE_KEYS,
  PLANNER_VERSION,
  makeEmptyGlobal,
  makeEmptyPlanner,
  makeItemId,
  makeSessionId,
  loadGlobal,
  saveGlobal,
  loadPlanner,
  savePlanner,
  parsePlannerImport,
  getPlannerKey,
  listPlannerFiles,
  savePlannerViaApi,
  readJson,
  writeJson,
  readText,
  writeText,
  removeKey,
  listKeys,
  loadRates,
  saveRates,
  isPlannerEntry,
  plannerDisplayName,
  normalizeEventFiles,
} from '../plannerStorage.js';

beforeEach(() => store.clear());

// ── makeEmptyPlanner ──────────────────────────────────────────────────────────

describe('makeEmptyPlanner', () => {
  it('returns the current schema version', () => {
    const p = makeEmptyPlanner('test-key');
    expect(p._version).toBe(PLANNER_VERSION);
  });

  it('sets _plannerKey and _eventFile', () => {
    const p = makeEmptyPlanner('my-key', 'my-event.json');
    expect(p._plannerKey).toBe('my-key');
    expect(p._eventFile).toBe('my-event.json');
  });

  it('includes empty personal and org sub-objects', () => {
    const p = makeEmptyPlanner('k');
    expect(Array.isArray(p.personal.outboundLegs)).toBe(true);
    expect(Array.isArray(p.org.teamAssignments)).toBe(true);
    expect(Array.isArray(p.tasks)).toBe(true);
    expect(Array.isArray(p.contacts)).toBe(true);
  });

  it('defaults mode to personal', () => {
    expect(makeEmptyPlanner('k').mode).toBe('personal');
  });

  it('seeds _eventFiles from the event file (or [] when none)', () => {
    expect(makeEmptyPlanner('k', 'e.json')._eventFiles).toEqual(['e.json']);
    expect(makeEmptyPlanner('k')._eventFiles).toEqual([]);
  });
});

// ── normalizeEventFiles (multi-event association) ─────────────────────────────

describe('normalizeEventFiles', () => {
  it('derives _eventFiles from a legacy single _eventFile', () => {
    const p = normalizeEventFiles({ _eventFile: 'a.json' });
    expect(p._eventFiles).toEqual(['a.json']);
    expect(p._eventFile).toBe('a.json');
  });

  it('keeps _eventFile in sync with the first (primary) entry', () => {
    const p = normalizeEventFiles({ _eventFiles: ['a.json', 'b.json'] });
    expect(p._eventFile).toBe('a.json');
  });

  it('de-dupes and drops blanks, preserving order', () => {
    const p = normalizeEventFiles({ _eventFiles: ['a.json', '', 'b.json', 'a.json', null] });
    expect(p._eventFiles).toEqual(['a.json', 'b.json']);
  });

  it('empties both when there are no events', () => {
    const p = normalizeEventFiles({ _eventFile: '', _eventFiles: [] });
    expect(p._eventFiles).toEqual([]);
    expect(p._eventFile).toBe('');
  });

  it('loadPlanner migrates a stored legacy single-event planner', () => {
    savePlanner('legacy', {
      ...makeEmptyPlanner('legacy'),
      _eventFile: 'x.json',
      _eventFiles: undefined,
    });
    const loaded = loadPlanner('legacy');
    expect(loaded._eventFiles).toEqual(['x.json']);
    expect(loaded._eventFile).toBe('x.json');
  });
});

// ── makeItemId ────────────────────────────────────────────────────────────────

describe('makeItemId', () => {
  it('starts with the given prefix', () => {
    expect(makeItemId('item').startsWith('item_')).toBe(true);
    expect(makeItemId('ia').startsWith('ia_')).toBe(true);
  });

  it('produces unique values on successive calls', () => {
    const ids = new Set(Array.from({ length: 20 }, () => makeItemId()));
    expect(ids.size).toBe(20);
  });
});

// ── makeSessionId ─────────────────────────────────────────────────────────────

describe('makeSessionId', () => {
  it('produces a deterministic id from session fields', () => {
    const session = { startTime: '2025-07-10T09:00:00Z', location: 'Room A', title: 'My Talk' };
    expect(makeSessionId(session)).toBe(makeSessionId(session));
  });

  it('replaces non-alphanumeric characters with hyphens', () => {
    const session = { startTime: '2025-07-10T09:00:00Z', location: 'Room A', title: 'Talk!' };
    const id = makeSessionId(session);
    expect(/^[a-zA-Z0-9-]+$/.test(id)).toBe(true);
  });
});

// ── loadPlanner / savePlanner ─────────────────────────────────────────────────

describe('loadPlanner', () => {
  it('returns an empty planner when nothing is stored', () => {
    const p = loadPlanner('unknown-key');
    expect(p._plannerKey).toBe('unknown-key');
    expect(Array.isArray(p.tasks)).toBe(true);
  });

  it('roundtrips a saved planner', () => {
    const key = 'my-event.json';
    const planner = makeEmptyPlanner(key, key);
    planner.personal.budget = '500';
    savePlanner(key, planner);
    const loaded = loadPlanner(key);
    expect(loaded.personal.budget).toBe('500');
  });

  it('migrates a legacy free-text personal.notes string into a note list', () => {
    const key = 'legacy-notes.json';
    const planner = makeEmptyPlanner(key, key);
    planner.personal.notes = 'test note';
    planner.personal.noteList = [];
    savePlanner(key, planner);
    const loaded = loadPlanner(key);
    expect(loaded.personal.notes).toBe('');
    expect(loaded.personal.noteList).toHaveLength(1);
    expect(loaded.personal.noteList[0].body).toBe('test note');
    expect(loaded.personal.noteList[0].id).toBeTruthy();
  });

  it('handles corrupted JSON gracefully', () => {
    store.set(`${STORAGE_PREFIX}bad-key`, 'not valid json{{');
    const p = loadPlanner('bad-key');
    expect(p._plannerKey).toBe('bad-key');
  });

  it("migrates mode 'individual' to 'personal'", () => {
    const raw = JSON.stringify({ ...makeEmptyPlanner('k'), mode: 'individual' });
    store.set(`${STORAGE_PREFIX}k`, raw);
    expect(loadPlanner('k').mode).toBe('personal');
  });

  it('strips legacy top-level trip/individual keys', () => {
    const raw = JSON.stringify({
      ...makeEmptyPlanner('k'),
      trip: { foo: 'bar' },
      individual: { notes: 'old' },
    });
    store.set(`${STORAGE_PREFIX}k`, raw);
    const p = loadPlanner('k');
    expect(p.trip).toBeUndefined();
    expect(p.individual).toBeUndefined();
  });

  it('migrates legacy single-object accommodation to array', () => {
    const raw = JSON.stringify({
      ...makeEmptyPlanner('k'),
      personal: {
        accommodation: {
          name: 'Hotel X',
          checkIn: '2025-07-09',
          checkOut: '2025-07-12',
          address: '',
          confirmation: '',
          budget: '',
          budgetActual: '',
          currency: 'AUD',
          notes: '',
        },
        accommodations: [],
      },
    });
    store.set(`${STORAGE_PREFIX}k`, raw);
    const p = loadPlanner('k');
    expect(p.personal.accommodations).toHaveLength(1);
    expect(p.personal.accommodations[0].name).toBe('Hotel X');
    expect(p.personal.accommodation).toBeUndefined();
  });

  it('migrates legacy swag items from {label} to {name} shape', () => {
    const raw = JSON.stringify({
      ...makeEmptyPlanner('k'),
      org: {
        ...makeEmptyPlanner('k').org,
        swag: [{ label: 'T-Shirt', done: false }],
      },
    });
    store.set(`${STORAGE_PREFIX}k`, raw);
    const p = loadPlanner('k');
    expect(p.org.swag[0].name).toBe('T-Shirt');
    expect(p.org.swag[0].quantity).toBe(1);
    // The migration spreads the original item, so legacy fields (label, done) are preserved
    expect(p.org.swag[0].budget).toBe('');
  });
});

describe('savePlanner', () => {
  it('persists data under the correct localStorage key', () => {
    savePlanner('event.json', makeEmptyPlanner('event.json', 'event.json'));
    expect(store.has(getPlannerKey('event.json'))).toBe(true);
  });

  it('stamps _lastModified on every save', () => {
    savePlanner('k', makeEmptyPlanner('k'));
    const saved = JSON.parse(store.get(getPlannerKey('k')));
    expect(saved._lastModified).toBeDefined();
    expect(new Date(saved._lastModified).getTime()).not.toBeNaN();
  });
});

// ── parsePlannerImport ────────────────────────────────────────────────────────

describe('parsePlannerImport', () => {
  it('returns a parsed planner for valid JSON with identity fields', () => {
    const p = makeEmptyPlanner('k', 'event.json');
    const json = JSON.stringify(p);
    expect(parsePlannerImport(json)._plannerKey).toBe('k');
  });

  it('throws on invalid JSON', () => {
    expect(() => parsePlannerImport('not json')).toThrow();
  });

  it('throws when identity fields are missing', () => {
    expect(() => parsePlannerImport('{"foo":"bar"}')).toThrow(/identity fields/i);
  });
});

// ── makeEmptyGlobal ───────────────────────────────────────────────────────────

describe('makeEmptyGlobal', () => {
  it('returns an object with the expected keys', () => {
    const g = makeEmptyGlobal();
    expect(Array.isArray(g.teamMembers)).toBe(true);
    expect(Array.isArray(g.budgetCategories)).toBe(true);
    expect('defaultCurrency' in g).toBe(true);
    expect('defaultMode' in g).toBe(true);
  });

  it('returns fresh arrays on each call (not shared references)', () => {
    const a = makeEmptyGlobal();
    const b = makeEmptyGlobal();
    a.teamMembers.push({ id: 'x' });
    expect(b.teamMembers).toHaveLength(0);
  });
});

// ── loadGlobal / saveGlobal ───────────────────────────────────────────────────

describe('loadGlobal / saveGlobal', () => {
  it('returns default shape when nothing is stored', () => {
    const g = loadGlobal();
    expect(Array.isArray(g.teamMembers)).toBe(true);
  });

  it('roundtrips a saved global object', () => {
    saveGlobal({ ...makeEmptyGlobal(), defaultCurrency: 'EUR' });
    expect(loadGlobal().defaultCurrency).toBe('EUR');
  });

  it('merges saved data with defaults so missing keys are always present', () => {
    store.set(GLOBAL_KEY, JSON.stringify({ defaultCurrency: 'JPY' }));
    const g = loadGlobal();
    expect(g.defaultCurrency).toBe('JPY');
    expect(Array.isArray(g.teamMembers)).toBe(true);
  });

  it('handles corrupted JSON gracefully and returns default shape', () => {
    store.set(GLOBAL_KEY, 'not valid json{{{');
    const g = loadGlobal();
    expect(Array.isArray(g.teamMembers)).toBe(true);
  });
});

// ── loadPlanner — v2 memberItinerary migration ────────────────────────────────

describe('loadPlanner — v2 memberItinerary migration', () => {
  it('migrates a top-level itinerary array into org.memberItinerary', () => {
    // Simulate a v2 planner: top-level itinerary present, org.memberItinerary absent
    const { memberItinerary: _dropped, ...orgWithoutMemberItinerary } = makeEmptyPlanner('k').org;
    const raw = JSON.stringify({
      ...makeEmptyPlanner('k'),
      itinerary: [{ id: 'it1', memberId: 'tmb_a', date: '2025-07-10', title: 'Setup' }],
      org: orgWithoutMemberItinerary,
    });
    store.set(`${STORAGE_PREFIX}k`, raw);
    const p = loadPlanner('k');
    expect(p.org.memberItinerary).toHaveLength(1);
    expect(p.org.memberItinerary[0].id).toBe('it1');
  });

  it('prefers org.memberItinerary over legacy top-level itinerary when both are non-empty', () => {
    const raw = JSON.stringify({
      ...makeEmptyPlanner('k'),
      itinerary: [{ id: 'legacy' }],
      org: { ...makeEmptyPlanner('k').org, memberItinerary: [{ id: 'fresh' }] },
    });
    store.set(`${STORAGE_PREFIX}k`, raw);
    const p = loadPlanner('k');
    expect(p.org.memberItinerary[0].id).toBe('fresh');
  });

  it('does not expose a top-level itinerary key after migration', () => {
    const raw = JSON.stringify({
      ...makeEmptyPlanner('k'),
      itinerary: [{ id: 'x' }],
    });
    store.set(`${STORAGE_PREFIX}k`, raw);
    expect(loadPlanner('k').itinerary).toBeUndefined();
  });
});

// ── listPlannerFiles ──────────────────────────────────────────────────────────

describe('listPlannerFiles', () => {
  it('returns the file list on a successful response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(['a.json', 'b.json']),
      }),
    );
    expect(await listPlannerFiles('http://localhost:3000')).toEqual(['a.json', 'b.json']);
  });

  it('returns an empty array when the response is not ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    expect(await listPlannerFiles('http://localhost:3000')).toEqual([]);
  });

  it('strips a trailing slash from the endpoint before building the URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) });
    vi.stubGlobal('fetch', fetchMock);
    await listPlannerFiles('http://localhost:3000/');
    const [url] = fetchMock.mock.calls[0];
    expect(url).not.toContain('//api');
  });
});

// ── savePlannerViaApi ─────────────────────────────────────────────────────────

describe('savePlannerViaApi', () => {
  it('sends a PUT request to the correct URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    await savePlannerViaApi('http://localhost:3000', 'event.json', makeEmptyPlanner('event.json'));
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/api/planner/event.json',
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('flattens a path-style key so the save target is a flat file (no nesting)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    await savePlannerViaApi(
      '',
      'events/drupalcon/eu/2026-rotterdam.json',
      makeEmptyPlanner('events/drupalcon/eu/2026-rotterdam.json'),
    );
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/planner/events-drupalcon-eu-2026-rotterdam.json');
    expect(url).not.toContain('/eu/'); // no directory nesting
  });

  it('PUTs to a same-origin, root-relative URL when no endpoint is given', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    await savePlannerViaApi('', 'event.json', makeEmptyPlanner('event.json'));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/planner/event.json',
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('appends .json suffix if plannerKey lacks it', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    await savePlannerViaApi('http://localhost:3000', 'myevent', makeEmptyPlanner('myevent'));
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('myevent.json');
  });

  it('sends Content-Type: application/json', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    await savePlannerViaApi('http://localhost:3000', 'e.json', makeEmptyPlanner('e.json'));
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers['Content-Type']).toBe('application/json');
  });

  it('throws with the server error message on a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: 'Internal Server Error' }),
      }),
    );
    await expect(
      savePlannerViaApi('http://localhost:3000', 'event.json', makeEmptyPlanner('event.json')),
    ).rejects.toThrow(/Internal Server Error/);
  });

  it('throws with HTTP status when error body has no message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: () => Promise.resolve({}),
      }),
    );
    await expect(
      savePlannerViaApi('http://localhost:3000', 'event.json', makeEmptyPlanner('event.json')),
    ).rejects.toThrow(/503/);
  });
});

// ── Storage key registry ──────────────────────────────────────────────────────

describe('STORAGE_KEYS registry', () => {
  it('resolves the deleted-planners key to the single canonical string', () => {
    // Previously defined twice (DELETED_KEY / DELETED_SLUGS_KEY) — both must agree.
    expect(STORAGE_KEYS.deletedPlanners).toBe(`${STORAGE_PREFIX}_deleted`);
  });

  it('has no duplicate key strings', () => {
    const values = Object.values(STORAGE_KEYS);
    expect(new Set(values).size).toBe(values.length);
  });
});

// ── Generic JSON/text helpers ─────────────────────────────────────────────────

describe('readJson / writeJson', () => {
  it('round-trips a value', () => {
    writeJson('k', { a: 1, b: [2, 3] });
    expect(readJson('k')).toEqual({ a: 1, b: [2, 3] });
  });

  it('returns the fallback for an absent key', () => {
    expect(readJson('missing', { d: true })).toEqual({ d: true });
  });

  it('returns the fallback for corrupt JSON', () => {
    store.set('bad', '{not json');
    expect(readJson('bad', [])).toEqual([]);
  });

  it('treats a stored literal null as absent (returns fallback)', () => {
    store.set('nul', 'null');
    expect(readJson('nul', 'fb')).toBe('fb');
  });
});

describe('readText / writeText / removeKey', () => {
  it('round-trips a raw string without JSON encoding', () => {
    writeText('t', 'hello');
    expect(store.get('t')).toBe('hello');
    expect(readText('t')).toBe('hello');
  });

  it('readText returns the fallback for an absent key', () => {
    expect(readText('none', 'fb')).toBe('fb');
  });

  it('removeKey deletes the entry', () => {
    writeText('t', 'x');
    removeKey('t');
    expect(store.has('t')).toBe(false);
  });
});

describe('listKeys', () => {
  it('returns only keys matching the prefix', () => {
    store.clear();
    writeText(`${STORAGE_PREFIX}a`, '1');
    writeText(`${STORAGE_PREFIX}b`, '2');
    writeText('unrelated', '3');
    expect(listKeys(STORAGE_PREFIX).sort()).toEqual([`${STORAGE_PREFIX}a`, `${STORAGE_PREFIX}b`]);
  });

  it('returns every key when no prefix is given', () => {
    store.clear();
    writeText('x', '1');
    writeText('y', '2');
    expect(listKeys().sort()).toEqual(['x', 'y']);
  });
});

// ── Exchange-rate persistence ─────────────────────────────────────────────────

describe('loadRates / saveRates', () => {
  it('persists under the registry rates key and round-trips', () => {
    const rates = { 'USD:current': { rates: { EUR: 0.9 }, fetchedAt: 123 } };
    saveRates(rates);
    expect(store.has(STORAGE_KEYS.rates)).toBe(true);
    expect(loadRates()).toEqual(rates);
  });

  it('returns an empty object when nothing is stored', () => {
    store.clear();
    expect(loadRates()).toEqual({});
  });
});

describe('isPlannerEntry', () => {
  it('rejects the reserved non-planner slugs', () => {
    expect(isPlannerEntry('geocache', { mode: 'personal' })).toBe(false);
    expect(isPlannerEntry('rates', { personal: {} })).toBe(false);
    expect(isPlannerEntry('exchangerates', { org: {} })).toBe(false);
  });

  it('rejects non-object or array data', () => {
    expect(isPlannerEntry('trip', null)).toBe(false);
    expect(isPlannerEntry('trip', 'x')).toBe(false);
    expect(isPlannerEntry('trip', [])).toBe(false);
  });

  it('accepts data carrying any planner marker field', () => {
    expect(isPlannerEntry('trip', { mode: 'personal' })).toBe(true);
    expect(isPlannerEntry('trip', { personal: {} })).toBe(true);
    expect(isPlannerEntry('trip', { org: {} })).toBe(true);
    expect(isPlannerEntry('trip', { _eventFile: 'e.json' })).toBe(true);
    expect(isPlannerEntry('trip', { _displayName: 'My Trip' })).toBe(true);
  });

  it('rejects an object with no planner markers', () => {
    expect(isPlannerEntry('trip', { foo: 1 })).toBe(false);
  });
});

describe('plannerDisplayName', () => {
  it('prefers an explicit _displayName', () => {
    expect(plannerDisplayName({ _displayName: 'My Trip' }, 'planner-foo')).toBe('My Trip');
  });

  it('derives from the event file (dropping .json) when no display name', () => {
    expect(plannerDisplayName({ _eventFile: 'wellington-2026.json' }, 'planner-x')).toBe(
      'wellington-2026',
    );
  });

  it('de-slugifies the plannerKey as a last resort', () => {
    expect(plannerDisplayName({}, 'planner-drupalsouth-2026')).toBe('drupalsouth 2026');
    expect(plannerDisplayName(null, 'planner-my-trip')).toBe('my trip');
  });
});
