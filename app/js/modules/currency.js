// @ts-check
// Exchange-rate engine for the planner's budget summaries.
//
// Rates come from frankfurter.app (ECB, daily) via the app's /api/rates proxy,
// keyed by `${base}:${date}` (date '' → 'current'). Historical rates (a date is
// given) are cached permanently; current rates expire after 24h. This module owns
// the in-memory cache and its persistence; the planner keeps the UI-facing display
// state (which currency to convert to, the current render date) and calls in here.

import { loadRates, saveRates } from './plannerStorage.js';

const RATE_TTL = 86_400_000; // 24h TTL for current rates; historical entries never expire

// key: `${base}:${date||'current'}` → { rates, fetchedAt, rateDate }
/** @type {Map<string, any>} */
const _rateCache = new Map();

/**
 * @param {string} currency
 * @param {string} [date]
 * @returns {string}
 */
function cacheKey(currency, date) {
  return `${currency}:${date || 'current'}`;
}

// Hydrate the in-memory cache from localStorage (call once at startup).
export function loadRatesIntoCache() {
  const stored = loadRates();
  Object.entries(stored).forEach(([key, val]) => {
    if (val?.rates && typeof val.fetchedAt === 'number') _rateCache.set(key, val);
  });
}

function persist() {
  /** @type {Record<string, any>} */
  const obj = {};
  _rateCache.forEach((val, key) => {
    obj[key] = val;
  });
  saveRates(obj);
}

// Fetch (or return cached) rates for `currency`. date: 'YYYY-MM-DD' for a
// historical lookup, '' for current/latest. Throws on network/HTTP failure so
// callers can surface a notice.
/**
 * @param {string} currency
 * @param {string} [date]
 */
export async function fetchRates(currency, date = '') {
  const key = cacheKey(currency, date);
  const cached = _rateCache.get(key);
  const ttl = date ? Infinity : RATE_TTL; // historical rates never go stale
  if (cached && Date.now() - cached.fetchedAt < ttl) return cached;
  const url = date
    ? `/api/rates?base=${encodeURIComponent(currency)}&date=${encodeURIComponent(date)}`
    : `/api/rates?base=${encodeURIComponent(currency)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const entry = {
    rates: { ...data.rates, [currency]: 1 },
    fetchedAt: Date.now(),
    rateDate: data.date || date || '',
  };
  _rateCache.set(key, entry);
  persist();
  return entry;
}

// Clamp a rate date to one that exchange-rate data can actually exist for.
// Historical rates (ECB via frankfurter) don't cover future dates — requesting a
// future date 404s upstream — so a future event/purchase date falls back to
// current rates (''), the best available estimate. Blank/invalid → '' (current).
/**
 * @param {string} [dateStr] - a 'YYYY-MM-DD' date
 * @returns {string} the same date, or '' when it's in the future / invalid
 */
export function clampRateDate(dateStr) {
  if (!dateStr) return '';
  const today = new Date().toISOString().slice(0, 10);
  return dateStr > today ? '' : dateStr; // ISO dates compare lexicographically
}

// Build a converter (amount, fromCurrency, itemDate?) → amount in `targetCurrency`,
// or null when no target is set or the base date's rates aren't cached yet.
//
// The converter is date-aware: pass a per-item date (e.g. a purchase date) as the
// third argument and, when that date's historical rates are also cached, the
// amount converts at *that day's* rate — important for foreign-currency spend
// recorded across a trip. Absent (or not-yet-cached) item dates fall back to the
// converter's base `date` rates, so existing callers that pass only (n, curr) are
// unaffected.
/**
 * @param {string} targetCurrency
 * @param {string} [date] - base/fallback rate date ('' = current)
 * @returns {((n: number, curr: string, itemDate?: string) => number) | null}
 */
export function buildConvFn(targetCurrency, date = '') {
  if (!targetCurrency) return null;
  const base = _rateCache.get(cacheKey(targetCurrency, date));
  if (!base) return null;
  return (n, curr, itemDate) => {
    if (!n || !curr || curr === targetCurrency) return n;
    let rates = base.rates;
    const d = clampRateDate(itemDate);
    if (d && d !== date) {
      const dated = _rateCache.get(cacheKey(targetCurrency, d));
      if (dated) rates = dated.rates; // this day's rate if we have it
    }
    const rate = rates[curr];
    return rate != null ? n / rate : n;
  };
}

// Ensure historical rates for `currency` across several dates are cached, then
// invoke `rerender` once after any fetch resolves so newly-available per-date
// rates can refine the displayed totals. Best-effort — failures are ignored.
/**
 * @param {string} currency
 * @param {Array<string|undefined|null>} dates
 * @param {() => void} rerender
 */
export function ensureRatesForDates(currency, dates, rerender) {
  if (!currency) return;
  // Clamp future dates to '' (current) so we never request rates that can't exist.
  const uniq = /** @type {string[]} */ ([
    ...new Set(dates.map((d) => clampRateDate(d || '')).filter(Boolean)),
  ]);
  const missing = uniq.filter((d) => !hasRate(currency, d));
  if (!missing.length) return;
  Promise.allSettled(missing.map((d) => fetchRates(currency, d))).then((res) => {
    if (res.some((r) => r.status === 'fulfilled')) rerender();
  });
}

// ── Cache queries for UI/render code ──────────────────────────────────────────

// The cached entry for a currency+date, or null. Pass '' for current rates.
/**
 * @param {string} currency
 * @param {string} [date]
 */
export function getRateEntry(currency, date = '') {
  return _rateCache.get(cacheKey(currency, date)) || null;
}

// The cached entry for a raw `${currency}:${date}` cache key, or null.
/** @param {string} key */
export function getRateEntryByKey(key) {
  return _rateCache.get(key) || null;
}

// Whether a specific currency+date pair is cached.
/**
 * @param {string} currency
 * @param {string} [date]
 */
export function hasRate(currency, date) {
  return _rateCache.has(cacheKey(currency, date));
}

// Whether any rates (current or historical) are cached for `currency`.
/** @param {string} currency */
export function ratesLoadedFor(currency) {
  if (!currency) return false;
  for (const k of _rateCache.keys()) if (k.startsWith(`${currency}:`)) return true;
  return false;
}
