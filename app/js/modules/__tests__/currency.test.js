import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// currency.js persists through plannerStorage (localStorage) and fetches via
// global fetch. Stub both before importing, matching the folder's convention.
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
import {
  loadRatesIntoCache,
  fetchRates,
  buildConvFn,
  getRateEntry,
  hasRate,
  ratesLoadedFor,
  ensureRatesForDates,
  clampRateDate,
} from '../currency.js';

// The module keeps one in-memory cache for the whole test file, so each test
// uses a unique base-currency code to stay isolated from the others.
function mockRatesResponse(rates, date = '2024-01-02') {
  return { ok: true, json: async () => ({ rates, date }) };
}

beforeEach(() => {
  store.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('fetchRates', () => {
  it('fetches, injects a self-rate of 1, caches, and persists', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockRatesResponse({ EUR: 0.9, GBP: 0.8 }));
    vi.stubGlobal('fetch', fetchSpy);

    const entry = await fetchRates('AAA', '');

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(entry.rates).toEqual({ EUR: 0.9, GBP: 0.8, AAA: 1 });
    expect(entry.rateDate).toBe('2024-01-02');
    expect(store.has(STORAGE_KEYS.rates)).toBe(true); // persisted under the registry key
  });

  it('serves current rates from cache within the 24h TTL (no refetch)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockRatesResponse({ EUR: 0.9 }));
    vi.stubGlobal('fetch', fetchSpy);

    await fetchRates('BBB', '');
    await fetchRates('BBB', '');

    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('refetches current rates once the TTL has elapsed', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn().mockResolvedValue(mockRatesResponse({ EUR: 0.9 }));
    vi.stubGlobal('fetch', fetchSpy);

    await fetchRates('CCC', '');
    vi.advanceTimersByTime(86_400_000 + 1); // > 24h
    await fetchRates('CCC', '');

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('caches historical rates permanently (never refetches by TTL)', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn().mockResolvedValue(mockRatesResponse({ EUR: 0.9 }, '2023-05-01'));
    vi.stubGlobal('fetch', fetchSpy);

    await fetchRates('DDD', '2023-05-01');
    vi.advanceTimersByTime(10 * 86_400_000); // 10 days later
    await fetchRates('DDD', '2023-05-01');

    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('throws on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    await expect(fetchRates('EEE', '')).rejects.toThrow(/503/);
  });
});

describe('clampRateDate', () => {
  it('passes through past dates and blanks', () => {
    expect(clampRateDate('2020-01-15')).toBe('2020-01-15');
    expect(clampRateDate('')).toBe('');
    expect(clampRateDate(undefined)).toBe('');
  });

  it('clamps a future date to current ("") so we never request nonexistent rates', () => {
    const future = new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10);
    expect(clampRateDate(future)).toBe('');
  });

  it('treats today as valid (not future)', () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(clampRateDate(today)).toBe(today);
  });
});

describe('buildConvFn', () => {
  beforeEach(async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockRatesResponse({ EUR: 0.5, GBP: 0.8 })));
    await fetchRates('FFF', '');
  });

  it('returns null when no target currency is given', () => {
    expect(buildConvFn('', '')).toBeNull();
  });

  it('returns null when the target currency has no cached rates', () => {
    expect(buildConvFn('ZZZ', '')).toBeNull();
  });

  it('converts a foreign amount into the target by dividing by its rate', () => {
    const conv = buildConvFn('FFF', '');
    // 10 EUR at EUR=0.5 per FFF → 10 / 0.5 = 20 FFF
    expect(conv(10, 'EUR')).toBe(20);
  });

  it('passes through amounts already in the target currency', () => {
    expect(buildConvFn('FFF', '')(10, 'FFF')).toBe(10);
  });

  it('passes through unknown currencies and zero amounts unchanged', () => {
    const conv = buildConvFn('FFF', '');
    expect(conv(10, 'JPY')).toBe(10); // not in rate table
    expect(conv(0, 'EUR')).toBe(0);
  });
});

describe('buildConvFn — per-date (purchase-date) conversion', () => {
  it('uses the item-date rate when cached, else falls back to the base-date rate', async () => {
    // Base (event) date rate: EUR 0.5 per HHH. A purchase-date rate: EUR 0.4.
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(mockRatesResponse({ EUR: 0.5 }, '2025-01-10'))
      .mockResolvedValueOnce(mockRatesResponse({ EUR: 0.4 }, '2025-03-20'));
    vi.stubGlobal('fetch', fetchSpy);
    await fetchRates('HHH', '2025-01-10'); // base
    await fetchRates('HHH', '2025-03-20'); // purchase day

    const conv = buildConvFn('HHH', '2025-01-10');
    // Purchase-day rate cached → convert at 0.4: 10 / 0.4 = 25
    expect(conv(10, 'EUR', '2025-03-20')).toBe(25);
    // Unknown item date → fall back to base-date rate 0.5: 10 / 0.5 = 20
    expect(conv(10, 'EUR', '2099-12-31')).toBe(20);
    // No item date → base-date rate
    expect(conv(10, 'EUR')).toBe(20);
  });

  it('is gated on the base date only (null until that is cached)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockRatesResponse({ EUR: 0.5 }, '2025-06-01')),
    );
    // Base date not cached yet → converter unavailable
    expect(buildConvFn('III', '2025-06-01')).toBeNull();
    await fetchRates('III', '2025-06-01');
    expect(buildConvFn('III', '2025-06-01')).not.toBeNull();
  });
});

describe('ensureRatesForDates', () => {
  it('fetches only the uncached distinct dates, then re-renders once', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockRatesResponse({ EUR: 0.9 }, '2025-02-02'));
    vi.stubGlobal('fetch', fetchSpy);
    await fetchRates('JJJ', '2025-02-02'); // pre-cache one date
    fetchSpy.mockClear();

    const rerender = vi.fn();
    // Duplicates + falsy entries collapse; the already-cached date is skipped.
    ensureRatesForDates('JJJ', ['2025-02-02', '2025-05-05', '2025-05-05', '', null], rerender);
    await vi.waitFor(() => expect(rerender).toHaveBeenCalledTimes(1));

    // Only the one genuinely-missing date was fetched.
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(hasRate('JJJ', '2025-05-05')).toBe(true);
  });

  it('does nothing (no rerender) when every date is already cached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockRatesResponse({ EUR: 0.9 }, '2025-07-07')),
    );
    await fetchRates('KKK', '2025-07-07');
    const rerender = vi.fn();
    ensureRatesForDates('KKK', ['2025-07-07', '', null], rerender);
    // Give any stray microtasks a tick; nothing should fire.
    await Promise.resolve();
    expect(rerender).not.toHaveBeenCalled();
  });
});

describe('cache queries + persistence hydration', () => {
  it('hasRate / ratesLoadedFor / getRateEntry reflect the cache', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockRatesResponse({ EUR: 0.9 })));
    await fetchRates('GGG', '');

    expect(hasRate('GGG', '')).toBe(true);
    expect(hasRate('ZZZ', '')).toBe(false);
    expect(ratesLoadedFor('GGG')).toBe(true);
    expect(ratesLoadedFor('ZZZ')).toBe(false);
    expect(ratesLoadedFor('')).toBe(false);
    expect(getRateEntry('GGG')?.rates.EUR).toBe(0.9);
    expect(getRateEntry('ZZZ')).toBeNull();
  });

  it('loadRatesIntoCache hydrates valid stored entries and ignores malformed ones', () => {
    store.set(
      STORAGE_KEYS.rates,
      JSON.stringify({
        'HYA:current': { rates: { EUR: 0.9, HYA: 1 }, fetchedAt: Date.now() },
        'HYB:current': { rates: { EUR: 1 } }, // missing fetchedAt → ignored
        'HYC:current': { fetchedAt: 123 }, // missing rates → ignored
      }),
    );

    loadRatesIntoCache();

    expect(hasRate('HYA', '')).toBe(true);
    expect(hasRate('HYB', '')).toBe(false);
    expect(hasRate('HYC', '')).toBe(false);
  });
});
