import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock localStorage before importing the module
const store = new Map();
vi.stubGlobal('localStorage', {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => store.set(k, v),
  removeItem: (k) => store.delete(k),
});

import {
  STORAGE_PREFIX,
  GLOBAL_KEY,
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
    planner.personal.notes = 'test note';
    savePlanner(key, planner);
    const loaded = loadPlanner(key);
    expect(loaded.personal.notes).toBe('test note');
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
        accommodation: { name: 'Hotel X', checkIn: '2025-07-09', checkOut: '2025-07-12', address: '', confirmation: '', budget: '', budgetActual: '', currency: 'AUD', notes: '' },
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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(['a.json', 'b.json']),
    }));
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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: 'Internal Server Error' }),
    }));
    await expect(
      savePlannerViaApi('http://localhost:3000', 'event.json', makeEmptyPlanner('event.json')),
    ).rejects.toThrow(/Internal Server Error/);
  });

  it('throws with HTTP status when error body has no message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.resolve({}),
    }));
    await expect(
      savePlannerViaApi('http://localhost:3000', 'event.json', makeEmptyPlanner('event.json')),
    ).rejects.toThrow(/503/);
  });
});