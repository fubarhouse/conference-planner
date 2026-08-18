import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// geocode.js caches through plannerStorage (localStorage) and hits Nominatim via
// global fetch, draining its queue on timers. Stub all three.
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

import { STORAGE_KEYS } from '../plannerStorage.js';
import { geocodeLocation, geocodeSearch } from '../geocode.js';

const nominatim = (lat, lon) => ({ json: async () => [{ lat: String(lat), lon: String(lon) }] });

beforeEach(() => {
  store.clear();
});
afterEach(async () => {
  // Let any trailing throttle timer fire so the module's queue/timer reset to
  // idle (otherwise the next test's enqueue sees a stale non-null timer).
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(1200);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('geocodeLocation — instant paths (no network)', () => {
  it('returns null for an empty query', async () => {
    expect(await geocodeLocation('')).toBeNull();
  });

  it('parses a direct "lat,lon" string', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await geocodeLocation('-17.73, 168.32')).toEqual([-17.73, 168.32]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('resolves a known IATA code from the embedded table', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await geocodeLocation('SYD')).toEqual([-33.9461, 151.1772]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns a cached location without hitting the network', async () => {
    store.set(STORAGE_KEYS.geocodeCache, JSON.stringify({ 'paris place': [48.8, 2.3] }));
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await geocodeLocation('paris place')).toEqual([48.8, 2.3]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('geocodeLocation — queued Nominatim lookups', () => {
  it('resolves free text via Nominatim and caches the result', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn().mockResolvedValue(nominatim('48.85', '2.35'));
    vi.stubGlobal('fetch', fetchSpy);

    const p = geocodeLocation('some obscure place');
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toEqual([48.85, 2.35]);
    expect(fetchSpy).toHaveBeenCalledOnce();
    // cached under the query key
    expect(JSON.parse(store.get(STORAGE_KEYS.geocodeCache))['some obscure place']).toEqual([
      48.85, 2.35,
    ]);
  });

  it('resolves null when Nominatim returns no match and Open-Meteo has none either', async () => {
    vi.useFakeTimers();
    // Both providers return empty.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ json: async () => ({ length: 0, results: [] }) }),
    );
    const p = geocodeLocation('nowhere at all');
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toBeNull();
  });

  it('falls back to Open-Meteo when Nominatim finds nothing', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({ json: async () => [] }) // Nominatim: no match
      .mockResolvedValueOnce({
        json: async () => ({ results: [{ latitude: -41.29, longitude: 174.78 }] }),
      }); // Open-Meteo
    vi.stubGlobal('fetch', fetchSpy);
    const p = geocodeLocation('wellington fallback');
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toEqual([-41.29, 174.78]);
    expect(fetchSpy).toHaveBeenCalledTimes(2); // Nominatim, then Open-Meteo
  });

  it('resolves null when the fetch rejects', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const p = geocodeLocation('unreachable place');
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toBeNull();
  });

  it('geocodeSearch: bounds the Nominatim query to the view (viewbox + bounded)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(nominatim('-41.29', '174.78'));
    vi.stubGlobal('fetch', fetchSpy);
    const vb = { west: 174.6, south: -41.4, east: 174.9, north: -41.1 };
    expect(await geocodeSearch('Te Papa', vb)).toEqual([-41.29, 174.78]);
    const url = fetchSpy.mock.calls[0][0];
    expect(url).toContain('bounded=1');
    expect(url).toContain('viewbox=174.6,-41.1,174.9,-41.4'); // west,north,east,south
  });

  it('geocodeSearch: falls back to an unbounded query when nothing is in view', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({ json: async () => [] }) // in-view (bounded): none
      .mockResolvedValueOnce(nominatim('48.85', '2.35')); // unbounded: found elsewhere
    vi.stubGlobal('fetch', fetchSpy);
    const vb = { west: 174.6, south: -41.4, east: 174.9, north: -41.1 };
    expect(await geocodeSearch('Somewhere far', vb)).toEqual([48.85, 2.35]);
    expect(fetchSpy.mock.calls[1][0]).not.toContain('bounded=1');
  });

  it('geocodeSearch: Open-Meteo fallback prefers a result inside the view', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({ json: async () => [] }) // Nominatim bounded: none
      .mockResolvedValueOnce({ json: async () => [] }) // Nominatim unbounded: none
      .mockResolvedValueOnce({
        json: async () => ({
          results: [
            { latitude: -37.95, longitude: 174.88 }, // out of view (a namesake)
            { latitude: -41.29, longitude: 174.78 }, // inside the view
          ],
        }),
      });
    vi.stubGlobal('fetch', fetchSpy);
    const vb = { west: 174.6, south: -41.4, east: 174.9, north: -41.1 };
    expect(await geocodeSearch('Wellington', vb)).toEqual([-41.29, 174.78]);
  });

  it('throttles successive network lookups ~1100ms apart', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn().mockResolvedValue(nominatim('1', '2'));
    vi.stubGlobal('fetch', fetchSpy);

    const p1 = geocodeLocation('first place here');
    const p2 = geocodeLocation('second place here');

    await vi.advanceTimersByTimeAsync(1);
    await p1;
    expect(fetchSpy).toHaveBeenCalledTimes(1); // second still throttled

    await vi.advanceTimersByTimeAsync(1100);
    await p2;
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
