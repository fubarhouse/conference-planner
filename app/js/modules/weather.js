// @ts-check
// Weather via Open-Meteo (open-meteo.com) — a keyless, CORS-friendly API, so it's
// called straight from the browser with no server proxy or API key (fits the app's
// no-backend-secret ethos). The pure helpers (WMO code → icon/label, unit
// formatting, the forecast-vs-normals decision, cache keys) are unit-tested; the
// network + cache layer degrades gracefully — every failure returns null and never
// throws into a render, and results are cached so an offline reopen still shows the
// last-known values.

import { readJson, writeJson } from './plannerStorage.js';

const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const CACHE_KEY = '__plannerWeather_v1__';
const CACHE_TTL_MS = 3 * 60 * 60 * 1000; // forecasts refresh every 3h
// Open-Meteo publishes daily forecasts ~16 days out.
export const FORECAST_HORIZON_DAYS = 15;

// WMO weather codes → a Font Awesome icon + short label.
/** @type {Record<number, {icon: string, label: string}>} */
const WMO = {
  0: { icon: 'fa-sun', label: 'Clear' },
  1: { icon: 'fa-sun', label: 'Mainly clear' },
  2: { icon: 'fa-cloud-sun', label: 'Partly cloudy' },
  3: { icon: 'fa-cloud', label: 'Overcast' },
  45: { icon: 'fa-smog', label: 'Fog' },
  48: { icon: 'fa-smog', label: 'Rime fog' },
  51: { icon: 'fa-cloud-rain', label: 'Light drizzle' },
  53: { icon: 'fa-cloud-rain', label: 'Drizzle' },
  55: { icon: 'fa-cloud-rain', label: 'Heavy drizzle' },
  61: { icon: 'fa-cloud-showers-heavy', label: 'Light rain' },
  63: { icon: 'fa-cloud-showers-heavy', label: 'Rain' },
  65: { icon: 'fa-cloud-showers-heavy', label: 'Heavy rain' },
  71: { icon: 'fa-snowflake', label: 'Light snow' },
  73: { icon: 'fa-snowflake', label: 'Snow' },
  75: { icon: 'fa-snowflake', label: 'Heavy snow' },
  77: { icon: 'fa-snowflake', label: 'Snow grains' },
  80: { icon: 'fa-cloud-showers-heavy', label: 'Showers' },
  81: { icon: 'fa-cloud-showers-heavy', label: 'Showers' },
  82: { icon: 'fa-cloud-showers-heavy', label: 'Violent showers' },
  85: { icon: 'fa-snowflake', label: 'Snow showers' },
  86: { icon: 'fa-snowflake', label: 'Snow showers' },
  95: { icon: 'fa-cloud-bolt', label: 'Thunderstorm' },
  96: { icon: 'fa-cloud-bolt', label: 'Thunderstorm' },
  99: { icon: 'fa-cloud-bolt', label: 'Thunderstorm' },
};

/**
 * A visual "tone" for a WMO code, used to colour the day card (sun/part/cloud/
 * rain/snow/storm/fog).
 * @param {number} code
 * @returns {'sun'|'part'|'cloud'|'rain'|'snow'|'storm'|'fog'}
 */
function weatherTone(code) {
  if (code === 0 || code === 1) return 'sun';
  if (code === 2) return 'part';
  if (code === 45 || code === 48) return 'fog';
  if (code >= 95 && code <= 99) return 'storm';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  return 'cloud';
}

/**
 * @param {number} code
 * @returns {{icon: string, label: string, tone: string}}
 */
export function weatherInfo(code) {
  const base = WMO[code] || { icon: 'fa-cloud', label: '—' };
  return { ...base, tone: weatherTone(code) };
}

// ── Weather glyphs ───────────────────────────────────────────────────────────
// Seven line drawings, one per tone. This is the one place in the product where
// a pictogram beats a word: reading seven days across a strip, "is it raining on
// Thursday" is answered by shape at a glance and by prose only after you read
// it. Everything else that had an icon lost it.
//
// Drawn rather than fetched — the icon font is gone, and a sprite would be an
// asset to host for seven shapes. Monochrome and stroked, so they inherit the
// surrounding ink and need no palette of their own.
const CLOUD =
  '<path d="M7.2 18h9.3a3.6 3.6 0 0 0 .3-7.2 5.4 5.4 0 0 0-10.3-1.4A3.9 3.9 0 0 0 7.2 18Z"/>';

const SUN_RAYS = [
  'M12 2.4v2.2',
  'M12 19.4v2.2',
  'M4.6 12H2.4',
  'M21.6 12h-2.2',
  'M6.4 6.4 4.8 4.8',
  'M19.2 19.2l-1.6-1.6',
  'M17.6 6.4l1.6-1.6',
  'M4.8 19.2l1.6-1.6',
]
  .map((d) => `<path d="${d}"/>`)
  .join('');

/** @type {Record<string, string>} */
const GLYPHS = {
  sun: `<circle cx="12" cy="12" r="4.2"/>${SUN_RAYS}`,
  // The sun behind the cloud, so the cloud reads as partial cover.
  part: `<circle cx="15.5" cy="7.5" r="3"/><path d="M15.5 1.8v1.6"/><path d="M20.4 7.5h1.6"/><path d="M19.2 3.8l1.1-1.1"/>${CLOUD}`,
  cloud: CLOUD,
  // Bands, not a cloud: fog is the air, not the sky.
  fog: `<path d="M3.5 8h17"/><path d="M5.5 12h13"/><path d="M3.5 16h17"/><path d="M7 20h10"/>`,
  rain: `${CLOUD}<path d="M9 20.5l-.8 2"/><path d="M12.5 20.5l-.8 2"/><path d="M16 20.5l-.8 2"/>`,
  snow: `${CLOUD}<path d="M9 21.4h1.6"/><path d="M9.8 20.6v1.6"/><path d="M15 21.4h1.6"/><path d="M15.8 20.6v1.6"/>`,
  storm: `${CLOUD}<path d="M13 19.6l-3 3.2h2.6l-1 2.4"/>`,
};

/**
 * An inline SVG for a weather tone. Returns markup, not an element, so it drops
 * straight into the template strings the strip is built from.
 * @param {string} tone one of sun|part|cloud|fog|rain|snow|storm
 * @param {string} [cls] class for the <svg>
 * @returns {string}
 */
export function weatherGlyph(tone, cls = 'wx-glyph') {
  const body = GLYPHS[tone] || GLYPHS.cloud;
  return `<svg class="${cls}" viewBox="0 0 24 26" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

/** @param {number} c @returns {number} */
export function cToF(c) {
  return (c * 9) / 5 + 32;
}

/**
 * @param {number|null|undefined} celsius
 * @param {'C'|'F'} [unit]
 * @returns {string}
 */
export function formatTemp(celsius, unit = 'C') {
  if (celsius == null || !Number.isFinite(celsius)) return '—';
  const v = unit === 'F' ? cToF(celsius) : celsius;
  return `${Math.round(v)}°${unit}`;
}

/**
 * Whole days from today (local midnight) to an ISO date string, or null if unparseable.
 * @param {string} dateStr YYYY-MM-DD
 * @param {Date} [today]
 * @returns {number|null}
 */
export function daysUntil(dateStr, today = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr || ''));
  if (!m) return null;
  const target = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const base = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((target - base) / 86400000);
}

/**
 * How to present weather for a date: a live 'forecast' inside the horizon,
 * seasonal 'normals' beyond it, 'past' for history, or 'none' when undatable.
 * @param {string} dateStr
 * @param {Date} [today]
 * @returns {'forecast'|'normals'|'past'|'none'}
 */
export function forecastMode(dateStr, today = new Date()) {
  const d = daysUntil(dateStr, today);
  if (d == null) return 'none';
  if (d < 0) return 'past';
  return d <= FORECAST_HORIZON_DAYS ? 'forecast' : 'normals';
}

// ── Per-day location resolution (for trips that move between places) ────────

/** @param {number} n */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Every ISO date from start..end inclusive.
 * @param {string} start
 * @param {string} end
 * @returns {string[]}
 */
export function enumerateDates(start, end) {
  /** @type {string[]} */
  const out = [];
  const s = new Date(`${start}T00:00:00`);
  const e = new Date(`${end}T00:00:00`);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return out;
  for (const d = s; d <= e; d.setDate(d.getDate() + 1)) {
    out.push(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`);
  }
  return out;
}

/**
 * Parse a "lat, lng" string into coordinates, or null.
 * @param {any} str
 * @returns {{lat: number, lon: number} | null}
 */
export function parseCoords(str) {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(String(str || ''));
  return m ? { lat: +m[1], lon: +m[2] } : null;
}

/**
 * @typedef {{date: string, location: string, coords: {lat: number, lon: number} | null}} LocEvent
 */

/**
 * The traveller's own stay dates for an accommodation. Check-in/out live on the
 * `__me__` assignment (per-member stays); fall back to the legacy top-level fields.
 * @param {any} a - an accommodation
 * @returns {{checkIn: string, checkOut: string}}
 */
export function meStayDates(a) {
  const meStay = (a?.assignments || []).find((/** @type {any} */ s) => s.memberId === '__me__');
  return {
    checkIn: String(meStay?.checkIn || a?.checkIn || '').slice(0, 10),
    checkOut: String(meStay?.checkOut || a?.checkOut || '').slice(0, 10),
  };
}

/**
 * A chronological list of location events built from every dated location signal
 * in the trip — leg arrivals (you're at `to` from its arrival date), accommodation
 * check-ins, dated **cruise/tour stops** (which carry coordinates), and dated
 * itinerary items. This is what lets weather follow the trip as it moves.
 * Itinerary items are DAY EXCURSIONS, not where you're based — pass
 * `{ includeItinerary: false }` to get only the base signals (legs + stays) used for
 * the per-day "where am I staying" resolution; the default includes them so callers
 * that just need the trip's date span still see every dated signal.
 * @param {any} personal - planner.personal
 * @param {{includeItinerary?: boolean}} [opts]
 * @returns {LocEvent[]}
 */
export function locationEvents(personal, opts = {}) {
  const { includeItinerary = true } = opts;
  const p = personal || {};
  /** @type {LocEvent[]} */
  const events = [];
  const add = (
    /** @type {any} */ date,
    /** @type {any} */ location,
    /** @type {{lat:number,lon:number}|null} */ coords = null,
  ) => {
    const d = String(date || '').slice(0, 10);
    const loc = String(location || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && (loc || coords))
      events.push({ date: d, location: loc, coords });
  };
  // Legs: one arrival event per date — the TERMINAL destination (the `to` that
  // isn't also a `from` that same day), so a multi-hop travel day (e.g. taxi to the
  // airport → flight) resolves to where you actually end up, not a transit stop.
  /** @type {Record<string, {tos: string[], froms: Set<string>}>} */
  const legDays = {};
  for (const l of [...(p.outboundLegs || []), ...(p.returnLegs || [])]) {
    const date = String(l.arriveDate || l.date || '').slice(0, 10);
    const to = String(l.to || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !to) continue;
    const rec = (legDays[date] ??= { tos: [], froms: new Set() });
    rec.tos.push(to);
    const from = String(l.from || '').trim();
    if (from) rec.froms.add(from);
  }
  // Departures: you're at each leg's origin on its DEPARTURE date. Added before the
  // arrival terminals so an arrival on the same date wins the day's carry-forward (you
  // end the day where you land), while a day you only depart still shows the origin.
  for (const l of [...(p.outboundLegs || []), ...(p.returnLegs || [])]) {
    add(l.date, String(l.from || '').trim());
  }
  for (const [date, { tos, froms }] of Object.entries(legDays)) {
    const terminals = tos.filter((t) => !froms.has(t));
    add(date, terminals.length ? terminals[terminals.length - 1] : tos[tos.length - 1]);
  }
  for (const a of p.accommodations || []) {
    // Check-in/out live on the traveller's own stay (assignments['__me__']); the
    // top-level a.checkIn is usually blank. Use coords directly when present; else the
    // ADDRESS (a geocodable place) rather than the hotel NAME ("Henk's Place" won't
    // geocode, but its "Oldenzaal, NL" address will).
    const { checkIn } = meStayDates(a);
    add(checkIn, a.address || a.name, parseCoords(a.coords));
    // Cruise / multi-stop accommodations carry dated port stops with coordinates —
    // use those directly (no geocoding, no ambiguity).
    for (const s of a.stops || []) add(s.date, s.location, parseCoords(s.coords));
  }
  // Itinerary items are day excursions (handled separately by dayHops), not places you
  // stay — only include them when the caller wants the full dated span.
  if (includeItinerary)
    for (const i of p.itinerary || []) add(i.date, i.location || i.title, parseCoords(i.coords));
  return events.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Location on a date = the most recent event on or before it (carry-forward), so
 * you stay "at" a place until the trip's next dated signal. Falls back to the
 * trip's primary location before any event.
 * @param {string} dateStr
 * @param {LocEvent[]} events - sorted ascending
 * @param {string} fallbackName
 * @returns {{location: string, coords: {lat: number, lon: number} | null}}
 */
export function locationAtDate(dateStr, events, fallbackName) {
  /** @type {{location: string, coords: {lat:number,lon:number}|null}} */
  let current = { location: fallbackName, coords: null };
  for (const e of events || []) {
    if (e.date <= dateStr)
      current = { location: e.location || fallbackName, coords: e.coords || null };
    else break;
  }
  return current;
}

/**
 * Group consecutive dates at the same place into contiguous segments — one forecast
 * block per place. Segments carry coordinates when the source event had them.
 * @param {string[]} dates
 * @param {LocEvent[]} events
 * @param {string} fallbackName
 * @returns {Array<{key: string, location: string, coords: {lat:number,lon:number}|null, start: string, end: string}>}
 */
export function groupByLocation(dates, events, fallbackName) {
  /** @type {Array<{key: string, location: string, coords: {lat:number,lon:number}|null, start: string, end: string}>} */
  const segs = [];
  for (const date of dates) {
    const { location, coords } = locationAtDate(date, events, fallbackName);
    const key = coords ? `${coords.lat},${coords.lon}` : location;
    const last = segs[segs.length - 1];
    if (last && last.key === key) last.end = date;
    else segs.push({ key, location, coords, start: date, end: date });
  }
  return segs;
}

/**
 * Days where you check OUT of one place and INTO another on the same date — a
 * "you're in two cities today" day. Keyed by date → { from, to } place names.
 * @param {any} personal - planner.personal
 * @returns {Map<string, {from: string, to: string}>}
 */
export function accomTransitions(personal) {
  /** @type {Record<string, string>} */
  const checkouts = {};
  /** @type {Record<string, string>} */
  const checkins = {};
  for (const a of (personal || {}).accommodations || []) {
    const place = String(a.name || a.address || '').trim();
    if (!place) continue;
    const { checkIn: ci, checkOut: co } = meStayDates(a);
    if (/^\d{4}-\d{2}-\d{2}$/.test(ci)) checkins[ci] = place;
    if (/^\d{4}-\d{2}-\d{2}$/.test(co)) checkouts[co] = place;
  }
  /** @type {Map<string, {from: string, to: string}>} */
  const out = new Map();
  for (const [date, to] of Object.entries(checkins)) {
    if (checkouts[date] && checkouts[date] !== to) out.set(date, { from: checkouts[date], to });
  }
  return out;
}

/**
 * Days where travel legs move you between places — you START the day at one place and
 * END it at another (a "two cities today" travel day), derived from the legs directly.
 * For a multi-hop day the origin is the leg `from` that isn't itself a same-day arrival,
 * and the terminal is the `to` that isn't a same-day departure (matching locationEvents),
 * so transit airports drop out. Keyed by arrival date → { from, to } place names.
 * @param {any} personal - planner.personal
 * @returns {Map<string, {from: string, to: string}>}
 */
export function legTransitions(personal) {
  const p = personal || {};
  /** @type {Record<string, {tos: string[], froms: Set<string>}>} */
  const byDate = {};
  for (const l of [...(p.outboundLegs || []), ...(p.returnLegs || [])]) {
    const date = String(l.arriveDate || l.date || '').slice(0, 10);
    const to = String(l.to || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !to) continue;
    const rec = (byDate[date] ??= { tos: [], froms: new Set() });
    rec.tos.push(to);
    const from = String(l.from || '').trim();
    if (from) rec.froms.add(from);
  }
  /** @type {Map<string, {from: string, to: string}>} */
  const out = new Map();
  for (const [date, { tos, froms }] of Object.entries(byDate)) {
    const terminals = tos.filter((t) => !froms.has(t));
    const terminal = terminals.length ? terminals[terminals.length - 1] : tos[tos.length - 1];
    const origins = [...froms].filter((f) => !tos.includes(f));
    const origin = origins.length ? origins[0] : [...froms][0];
    if (origin && terminal && origin !== terminal) out.set(date, { from: origin, to: terminal });
  }
  return out;
}

/**
 * The ordered sequence of distinct places you pass through on each travel day — leg
 * arrivals that day plus any accommodation you check into, in order. The day's origin
 * (a leg's `from`) is prepended ONLY when that leg also departed that day; an overnight
 * leg's origin is a previous day's location, so it's skipped (e.g. an overnight
 * MEL→DOH that lands on the 23rd makes the 23rd start at DOH, not MEL). Consecutive
 * duplicates are collapsed. Only days with ≥2 distinct places are returned.
 * @param {any} personal - planner.personal
 * @returns {Map<string, Array<{name: string, coords: {lat:number,lon:number}|null}>>}
 */
export function dayHops(personal) {
  const p = personal || {};
  const iso = (/** @type {any} */ v) => String(v || '').slice(0, 10);
  const isDate = (/** @type {string} */ d) => /^\d{4}-\d{2}-\d{2}$/.test(d);
  const keyOf = (/** @type {any} */ h) =>
    h.coords ? `${h.coords.lat},${h.coords.lon}` : String(h.name || '').toLowerCase();
  // Two hops are the "same" place when their coords match, or (lacking coords) their
  // names do — used to avoid an excursion that's really at your base.
  const sameHop = (/** @type {any} */ a, /** @type {any} */ b) =>
    !!a &&
    !!b &&
    ((a.coords && b.coords && a.coords.lat === b.coords.lat && a.coords.lon === b.coords.lon) ||
      (!!a.name && !!b.name && a.name.toLowerCase() === b.name.toLowerCase()));

  // Where you're BASED, carried forward (legs + stays, not excursions). `baseBefore`
  // is where you wake up on a date (the last base event strictly before it).
  const base = locationEvents(p, { includeItinerary: false });
  const baseBefore = (/** @type {string} */ date) => {
    /** @type {any} */
    let cur = null;
    for (const e of base) {
      if (e.date < date) cur = e;
      else break;
    }
    return cur ? { name: cur.location, coords: cur.coords } : null;
  };

  // Legs by arrival date; accommodation check-ins (base changes) by date; itinerary
  // excursions by date.
  /** @type {Record<string, any[]>} */
  const legDays = {};
  for (const l of [...(p.outboundLegs || []), ...(p.returnLegs || [])]) {
    const date = iso(l.arriveDate || l.date);
    if (isDate(date)) (legDays[date] ??= []).push(l);
  }
  /** @type {Record<string, Array<{name:string, coords:any}>>} */
  const accomIn = {};
  for (const a of p.accommodations || []) {
    const d = meStayDates(a).checkIn;
    if (isDate(d))
      (accomIn[d] ??= []).push({ name: a.address || a.name, coords: parseCoords(a.coords) });
  }
  /** @type {Record<string, Array<{name:string, coords:any}>>} */
  const excursions = {};
  for (const i of p.itinerary || []) {
    const d = iso(i.date);
    if (isDate(d))
      (excursions[d] ??= []).push({
        name: String(i.location || i.title || '').trim(),
        coords: parseCoords(i.coords),
      });
  }

  const dates = new Set(
    [...Object.keys(legDays), ...Object.keys(accomIn), ...Object.keys(excursions)].filter(isDate),
  );
  /** @type {Map<string, Array<{name:string, coords:{lat:number,lon:number}|null}>>} */
  const out = new Map();
  for (const date of dates) {
    /** @type {Array<{name:string, coords:{lat:number,lon:number}|null}>} */
    const seq = [];
    const legs = legDays[date] || [];
    // Where the day starts: a same-day leg's origin, an overnight leg's first arrival,
    // else where you woke up (your base).
    let start;
    if (legs.length) {
      start =
        iso(legs[0].date) === date && legs[0].from
          ? { name: String(legs[0].from).trim(), coords: null }
          : { name: String(legs[0].to).trim(), coords: null };
    } else {
      start = baseBefore(date);
    }
    if (start && (start.name || start.coords)) seq.push(start);
    // Travel: each leg arrival that day.
    for (const l of legs) {
      const to = String(l.to || '').trim();
      if (to) seq.push({ name: to, coords: null });
    }
    // Excursions: a there-and-back from your base (skip one that's already at the base).
    for (const ex of excursions[date] || []) {
      if ((!ex.name && !ex.coords) || sameHop(ex, start)) continue;
      seq.push(ex);
      if (start && (start.name || start.coords)) seq.push(start);
    }
    // A stay you check into today ends the day at a new base.
    for (const ac of accomIn[date] || []) seq.push(ac);

    /** @type {Array<{name:string, coords:{lat:number,lon:number}|null}>} */
    const dedup = [];
    for (const h of seq) {
      if (!dedup.length || keyOf(dedup[dedup.length - 1]) !== keyOf(h)) dedup.push(h);
    }
    if (dedup.length >= 2) out.set(date, dedup);
  }
  return out;
}

/**
 * Stable cache key for a place + date range (coords rounded to ~1km).
 * @param {number} lat
 * @param {number} lon
 * @param {string} start
 * @param {string} end
 * @returns {string}
 */
export function cacheKey(lat, lon, start, end) {
  return `${Number(lat).toFixed(2)},${Number(lon).toFixed(2)}:${start}:${end}`;
}

// ── Network (all best-effort: return null on any failure) ───────────────────

/**
 * Geocode a place name to coordinates via Open-Meteo's keyless geocoder.
 * @param {string} name
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<{lat:number, lon:number, label:string}|null>}
 */
export async function geocode(name, fetchFn = globalThis.fetch) {
  const q = String(name || '').trim();
  if (!q) return null;
  try {
    const res = await fetchFn(`${GEO_URL}?name=${encodeURIComponent(q)}&count=5`);
    if (!res.ok) return null;
    const data = await res.json();
    const results = data?.results || [];
    if (!results.length) return null;
    // Prefer the most populous match — disambiguates common names (e.g. "Bali" →
    // the Indonesian island, not a tiny same-named town) while keeping the API's
    // top result when population is unknown.
    const r = results.reduce(
      (/** @type {any} */ best, /** @type {any} */ cur) =>
        (cur.population || 0) > (best.population || 0) ? cur : best,
      results[0],
    );
    const label = [r.name, r.admin1, r.country].filter(Boolean).join(', ');
    return { lat: r.latitude, lon: r.longitude, label };
  } catch {
    return null;
  }
}

const REVERSE_URL = 'https://api.bigdatacloud.net/data/reverse-geocode-client';

/**
 * Reverse-geocode a coordinate to a clean city/town name via BigDataCloud's keyless,
 * CORS-friendly client endpoint — so a heterogeneous label (hotel name, airport code,
 * tour title) can be normalised to the place's city. Best-effort: null on failure.
 * @param {number} lat
 * @param {number} lon
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<string|null>}
 */
export async function reverseGeocode(lat, lon, fetchFn = globalThis.fetch) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  try {
    const res = await fetchFn(
      `${REVERSE_URL}?latitude=${lat}&longitude=${lon}&localityLanguage=en`,
    );
    if (!res.ok) return null;
    const d = await res.json();
    return d.city || d.locality || d.principalSubdivision || d.countryName || null;
  } catch {
    return null;
  }
}

/**
 * Fetch daily max/min + weather code for a coordinate + date range (temps in °C).
 * @param {number} lat
 * @param {number} lon
 * @param {string} start
 * @param {string} end
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<Array<{date:string, code:number, tmax:number, tmin:number}>|null>}
 */
export async function fetchDailyForecast(lat, lon, start, end, fetchFn = globalThis.fetch) {
  try {
    const url =
      `${FORECAST_URL}?latitude=${lat}&longitude=${lon}` +
      `&daily=weathercode,temperature_2m_max,temperature_2m_min&timezone=auto` +
      `&start_date=${start}&end_date=${end}`;
    const res = await fetchFn(url);
    if (!res.ok) return null;
    const d = await res.json();
    const days = d?.daily?.time || [];
    return days.map((/** @type {string} */ date, /** @type {number} */ i) => ({
      date,
      code: d.daily.weathercode?.[i],
      tmax: d.daily.temperature_2m_max?.[i],
      tmin: d.daily.temperature_2m_min?.[i],
    }));
  } catch {
    return null;
  }
}

// ── Cache (localStorage, TTL) ───────────────────────────────────────────────

function readCache() {
  const c = readJson(CACHE_KEY);
  return c && typeof c === 'object' ? c : {};
}

/**
 * Forecast for a place + range: fresh cache → network → stale cache. Returns
 * { days, at, stale } or null. `at` is the fetch time; `stale` flags a cache
 * fallback used because the network was unavailable.
 * @param {number} lat
 * @param {number} lon
 * @param {string} start
 * @param {string} end
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<{days:Array<any>, at:number, stale:boolean}|null>}
 */
export async function loadForecast(lat, lon, start, end, fetchFn = globalThis.fetch) {
  const key = cacheKey(lat, lon, start, end);
  const cache = readCache();
  const hit = cache[key];
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ...hit, stale: false };

  const days = await fetchDailyForecast(lat, lon, start, end, fetchFn);
  if (days && days.length) {
    const entry = { days, at: Date.now() };
    cache[key] = entry;
    writeJson(CACHE_KEY, cache);
    return { ...entry, stale: false };
  }
  // Network failed — fall back to any cached copy, however old.
  return hit ? { ...hit, stale: true } : null;
}

const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';
const NORMALS_TTL_MS = 30 * 24 * 60 * 60 * 1000; // typical weather barely changes

/**
 * "Typical" weather for a date range beyond the forecast horizon (e.g. a trip a
 * year out): the same calendar days from the last completed year, pulled from the
 * historical archive and relabelled to the requested dates. Cached long; returns
 * `typical: true` so the UI can say so. Best-effort (null on failure).
 * @param {number} lat
 * @param {number} lon
 * @param {string} start
 * @param {string} end
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<{days:Array<any>, at:number, stale:boolean, typical:true}|null>}
 */
export async function loadNormals(lat, lon, start, end, fetchFn = globalThis.fetch) {
  const year = new Date().getFullYear() - 1;
  const ps = `${year}${start.slice(4)}`;
  const pe = `${year}${end.slice(4)}`;
  const key = `normals:${cacheKey(lat, lon, ps, pe)}`;
  const cache = readCache();
  const hit = cache[key];
  if (hit && Date.now() - hit.at < NORMALS_TTL_MS) return { ...hit, stale: false, typical: true };

  try {
    const url =
      `${ARCHIVE_URL}?latitude=${lat}&longitude=${lon}` +
      `&daily=weathercode,temperature_2m_max,temperature_2m_min&timezone=auto` +
      `&start_date=${ps}&end_date=${pe}`;
    const res = await fetchFn(url);
    if (res.ok) {
      const d = await res.json();
      const times = d?.daily?.time || [];
      const tripYear = start.slice(0, 4);
      const days = times.map((/** @type {string} */ date, /** @type {number} */ i) => ({
        date: `${tripYear}${String(date).slice(4)}`, // relabel to the trip's year
        code: d.daily.weathercode?.[i],
        tmax: d.daily.temperature_2m_max?.[i],
        tmin: d.daily.temperature_2m_min?.[i],
      }));
      if (days.length) {
        const entry = { days, at: Date.now() };
        cache[key] = entry;
        writeJson(CACHE_KEY, cache);
        return { ...entry, stale: false, typical: true };
      }
    }
  } catch {
    /* fall through to any cached copy */
  }
  return hit ? { ...hit, stale: true, typical: true } : null;
}
