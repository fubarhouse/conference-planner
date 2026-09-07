// @ts-check
// Weather tab — an opt-in view (disabled by default) showing the forecast for the
// trip's location. Uses the keyless Open-Meteo helpers in weather.js. Everything is
// additive and best-effort: no location, no network, or a trip beyond the forecast
// horizon each render a friendly state rather than an error, and the tab never
// blocks the rest of the planner. Temperature unit is a global preference (°C/°F).

import {
  weatherInfo,
  weatherGlyph,
  formatTemp,
  daysUntil,
  loadForecast,
  loadNormals,
  geocode,
  enumerateDates,
  locationEvents,
  groupByLocation,
  meStayDates,
  reverseGeocode,
  FORECAST_HORIZON_DAYS,
} from './weather.js';
import { loadGlobal, saveGlobal, readJson, writeJson } from './plannerStorage.js';

/** @type {any} */
let state;
/** @type {() => void} */
let scheduleAutoSave;
/** @type {(s: any) => string} */
let esc;

/**
 * @param {{ state: any, scheduleAutoSave: () => void, esc: (s: any) => string }} deps
 */
export function initWeather(deps) {
  ({ state, scheduleAutoSave, esc } = deps);
}

// A render token so a slow forecast fetch from a previous render can't overwrite
// the panel after the user has navigated/changed location.
let _renderToken = 0;

// Signature of the last render's resolved trip (mode + per-location segments). When it
// hasn't changed, the panel already shows the (cached) weather, so we skip the
// "Loading…" flash on re-entry and just refresh in place from cache.
let _lastRenderSig = '';

function unit() {
  return loadGlobal().tempUnit === 'F' ? 'F' : 'C';
}

/** @param {string} u */
function setUnit(u) {
  saveGlobal({ ...loadGlobal(), tempUnit: u === 'F' ? 'F' : 'C' });
}

// The saved weather location for this planner, defaulting to the associated
// event's location name (the user confirms/geocodes it with "Update").
function savedLocation() {
  return state.planner?.weatherLocation || null;
}

// The location to auto-load: a saved pick, else the associated event's location,
// else the first signal from the trip itself — an outbound destination or an
// accommodation — so a standalone trip (no associated event) still populates
// automatically instead of showing a blank prompt.
function defaultLocationName() {
  const loc = savedLocation();
  if (loc?.name) return loc.name;
  const personal = state.planner?.personal || {};
  const legTo = (personal.outboundLegs || [])
    .map((/** @type {any} */ l) => (l.to || '').trim())
    .find(Boolean);
  const accom = (personal.accommodations || [])
    .map((/** @type {any} */ a) => (a.name || a.address || '').trim())
    .find(Boolean);
  return state.eventMeta?.location || state.eventMeta?.venue || legTo || accom || '';
}

/** @param {number} n */
function pad(n) {
  return String(n).padStart(2, '0');
}
/** @param {Date} d */
function toDateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Earliest/latest dates across the trip's own dated signals (location events +
// accommodation stays), so a trip with no associated event still knows its span.
function tripDateBounds() {
  const personal = state.planner?.personal || {};
  /** @type {string[]} */
  const dates = [];
  for (const e of locationEvents(personal)) dates.push(e.date);
  for (const a of personal.accommodations || []) {
    // Check-in/out live on the traveller's own stay (assignments['__me__']).
    const { checkIn, checkOut } = meStayDates(a);
    if (checkIn) dates.push(checkIn);
    if (checkOut) dates.push(checkOut);
  }
  const valid = dates.filter((/** @type {string} */ d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  return { start: valid[0] || '', end: valid[valid.length - 1] || '' };
}

// The trip window + how to source weather. Uses the event dates, else derives the
// span from the trip's own dated signals so it covers the WHOLE trip — not a
// default week. Within the forecast horizon → a live 'forecast'; further out →
// The union of the event window and the trip's own dated span (bounds), so weather
// covers the WHOLE trip — the conference days plus any early-arrival / late-departure
// captured by legs, stays and itinerary. Pure (ISO YYYY-MM-DD compares lexically);
// exported for testing. `end` defaults to `start` when only a single date is known.
/**
 * @param {string} [eventStart]
 * @param {string} [eventEnd]
 * @param {{start?: string, end?: string}} [bounds]
 * @returns {{start: string, end: string}}
 */
export function unionTripRange(eventStart, eventEnd, bounds = {}) {
  let start = eventStart || '';
  let end = eventEnd || '';
  if (bounds.start && (!start || bounds.start < start)) start = bounds.start;
  if (bounds.end && (!end || bounds.end > end)) end = bounds.end;
  return { start, end: end || start };
}

// 'normals' (typical weather from the archive); nothing dated → the coming week.
/** @returns {{start: string, end: string, mode: 'forecast' | 'normals'}} */
function tripRange() {
  const today = new Date();
  const todayStr = toDateStr(today);
  const horizonEnd = toDateStr(new Date(today.getTime() + FORECAST_HORIZON_DAYS * 86400000));

  // Expand to the WHOLE trip: a trip usually extends beyond the conference dates
  // (arrive early, leave late) via travel legs, stays and itinerary. Take the union
  // of the event window and the trip's own dated signals so weather covers every day.
  const { start, end } = unionTripRange(
    state.eventMeta?.startDate?.slice(0, 10),
    state.eventMeta?.endDate?.slice(0, 10),
    tripDateBounds(),
  );
  if (!start) {
    return {
      start: todayStr,
      end: toDateStr(new Date(today.getTime() + 6 * 86400000)),
      mode: 'forecast',
    };
  }
  const d = daysUntil(start, today);
  if (d != null && d > FORECAST_HORIZON_DAYS) return { start, end, mode: 'normals' };
  const from = d != null && d > 0 ? start : todayStr;
  const to = end < horizonEnd ? end : horizonEnd;
  return { start: from, end: to, mode: 'forecast' };
}

// ── Panel shell (injected by planner.js) ────────────────────────────────────

export function weatherPanelHtml() {
  return `
    <section>
      <div class="pln-section__head">
        <div>
          <p class="pln-eyebrow">Along your trip</p>
          <h2 class="pln-section__title">Weather</h2>
        </div>
        <div class="smy-seg" role="group" aria-label="Temperature unit">
          <button type="button" data-weather-unit="C" class="smy-seg-btn">°C</button>
          <button type="button" data-weather-unit="F" class="smy-seg-btn">°F</button>
        </div>
      </div>
      <p class="wx-lede">A live forecast within ~${FORECAST_HORIZON_DAYS} days and typical conditions beyond, from Open-Meteo. Places come from your travel legs, stays and itinerary.</p>
      <div id="weatherBody" aria-live="polite"></div>
    </section>`;
}

// ── Render ──────────────────────────────────────────────────────────────────

function bodyEl() {
  return document.getElementById('weatherBody');
}

/** @param {string} html */
function setBody(html) {
  const el = bodyEl();
  if (el) el.innerHTML = html;
}

/** @param {string} text */
function note(text) {
  return `<p class="wx-note">${esc(text)}</p>`;
}

/**
 * @param {{code:number, date:string, tmax:number, tmin:number}} day
 * @param {'C'|'F'} u
 * @param {boolean} [isConf] mark this as a conference day
 */
function dayCard(day, u, isConf = false) {
  const info = weatherInfo(day.code);
  const d = new Date(`${day.date}T00:00:00`);
  const wd = d.toLocaleDateString(undefined, { weekday: 'short' });
  const md = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  // A conference day is marked by the card itself (a brand rule along its top),
  // so the badge only has to name the state for anyone reading the markup.
  const conf = isConf ? `<span class="wx-card-conf">Conf</span>` : '';
  return `<div class="wx-card${isConf ? ' wx-card--conf' : ''}" data-tone="${esc(info.tone)}" title="${esc(info.label)}${isConf ? ' · Conference day' : ''}">
    ${conf}
    <span class="wx-card-wd">${esc(wd)}</span>
    <span class="wx-card-md">${esc(md)}</span>
    ${weatherGlyph(info.tone, 'wx-glyph wx-card-icon')}
    <span class="wx-card-hi">${esc(formatTemp(day.tmax, u))}</span>
    <span class="wx-card-lo">${esc(formatTemp(day.tmin, u))}</span>
  </div>`;
}

function syncUnitButtons() {
  const u = unit();
  document.querySelectorAll('[data-weather-unit]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.getAttribute('data-weather-unit') === u);
  });
}

export function renderWeatherTab() {
  if (!bodyEl()) return; // panel not injected
  syncUnitButtons();
  const token = ++_renderToken;
  void resolveAndRenderForecast(token);
}

/**
 * Resolve the location(s) and render the forecast. The trip's primary location is
 * auto-resolved from its travel legs / stays / itinerary; then, as accommodations
 * or stops move you between places, each stretch of days gets its own forecast at
 * that place. Guarded by the render token so a stale async result can't clobber a
 * newer render.
 * @param {number} token
 */
async function resolveAndRenderForecast(token) {
  let primary = savedLocation();

  if (!primary?.lat) {
    const name = defaultLocationName();
    if (!name) {
      setBody(note('Add travel legs or accommodation to see the weather for your trip.'));
      return;
    }
    setBody(note(`Finding ${name}…`));
    const geo = await geocode(name);
    if (token !== _renderToken) return;
    if (!geo) {
      setBody(note(`Couldn't find weather for "${name}".`));
      return;
    }
    state.planner.weatherLocation = { name, lat: geo.lat, lon: geo.lon, label: geo.label };
    scheduleAutoSave();
    primary = state.planner.weatherLocation;
  }

  const range = tripRange();

  // Split the whole trip into per-location segments from every dated location
  // signal (leg arrivals, accommodation check-ins, dated cruise/tour stops, dated
  // itinerary items).
  const dates = enumerateDates(range.start, range.end);
  // Base segments = where you're STAYING (legs + stays), not day excursions — those
  // are drawn as base→excursion→base sequences by dayHops.
  const events = locationEvents(state.planner?.personal, { includeItinerary: false });
  const segments = groupByLocation(dates, events, primary.name);
  const isNormals = range.mode === 'normals';

  // Only show the "Loading…" placeholder when the resolved trip actually changed —
  // otherwise keep the already-rendered (cached) weather visible and refresh in place,
  // so re-opening the tab for the same trip doesn't flash empty.
  const sig = JSON.stringify([range.mode, segments.map((s) => [s.key, s.start, s.end])]);
  if (sig !== _lastRenderSig || !bodyEl()?.innerHTML.trim()) {
    setBody(note(`Loading ${isNormals ? 'typical weather' : 'forecast'}…`));
  }
  _lastRenderSig = sig;

  // A stop with coordinates is used directly; otherwise geocode the place name,
  // falling back to the trip's primary location so every day gets weather.
  const primaryPlace = { lat: primary.lat, lon: primary.lon, label: primary.label || primary.name };
  /** @type {Map<string, {lat:number, lon:number, label:string}|null>} */
  const geoCache = new Map([[primary.name, primaryPlace]]);
  /** @type {Array<{label:string, days:any[], stale:boolean}>} */
  const blocks = [];
  for (const seg of segments) {
    /** @type {{lat:number, lon:number, label:string}} */
    let place;
    if (seg.coords) {
      place = { lat: seg.coords.lat, lon: seg.coords.lon, label: seg.location };
    } else {
      let g = geoCache.get(seg.location);
      if (g === undefined) {
        g = (await geocode(seg.location)) || null;
        geoCache.set(seg.location, g);
      }
      if (token !== _renderToken) return;
      place = g || primaryPlace;
    }
    const fc = isNormals
      ? await loadNormals(place.lat, place.lon, seg.start, seg.end)
      : await loadForecast(place.lat, place.lon, seg.start, seg.end);
    if (token !== _renderToken) return;
    // Normalise the label to a clean city name from the coordinates (hotel names,
    // airport codes and tour titles all collapse to their city); keep the original
    // as a fallback when reverse-geocoding is unavailable.
    const city = await reverseGeocodeMemo(place.lat, place.lon);
    if (token !== _renderToken) return;
    blocks.push({
      label: city || place.label || seg.location,
      days: fc?.days || [],
      stale: !!fc?.stale,
    });
  }

  if (!blocks.some((b) => b.days.length)) {
    setBody(
      note(
        isNormals
          ? 'Typical weather is unavailable right now — check back when you are online.'
          : 'Forecast unavailable right now — check back when you are online.',
      ),
    );
    return;
  }

  const u = unit();

  // Conference days (from the associated event) get a clear badge on their card.
  const confStart = state.eventMeta?.startDate?.slice(0, 10) || '';
  const confEnd = state.eventMeta?.endDate?.slice(0, 10) || confStart;
  const isConf = (/** @type {string} */ date) =>
    !!confStart && date >= confStart && date <= confEnd;

  // Each place is a compact group (label above its day cards); the groups wrap
  // side-by-side, so a short stop doesn't leave an empty row. One card per day.
  const groups = blocks
    .map(
      (b) =>
        `<div class="wx-group">
          <div class="wx-place" title="${esc(b.label)}"><span class="wx-place-name">${esc(b.label.split(',')[0])}</span></div>
          <div class="wx-strip">${b.days
            .map((/** @type {any} */ d) => dayCard(d, u, isConf(d.date)))
            .join('')}</div>
        </div>`,
    )
    .join('');
  const typicalNote = isNormals
    ? `<p class="wx-note">Typical weather for these dates (based on last year) — your trip is beyond the ${FORECAST_HORIZON_DAYS}-day forecast.</p>`
    : '';
  const staleNote = blocks.some((b) => b.stale)
    ? `<p class="wx-note">Showing a saved copy (offline).</p>`
    : '';
  const confNote =
    confStart && blocks.some((b) => b.days.some((/** @type {any} */ d) => isConf(d.date)))
      ? `<p class="wx-note">Marked days are the conference (${esc(confStart)} – ${esc(confEnd)}).</p>`
      : '';
  setBody(`<div class="wx-groups">${groups}</div>${confNote}${typicalNote}${staleNote}`);
}

// ── Itinerary day-header chips ──────────────────────────────────────────────
// A small per-day weather chip on the itinerary/timeline, independent of the
// Weather tab (works even when that tab is disabled). Reuses the same per-day
// location resolver, so each day shows the weather where the trip actually is.

/** @type {Map<string, {lat:number,lon:number,label:string}|null>} */
const _geoMemo = new Map();
/** @param {string} name */
async function geocodeMemo(name) {
  if (_geoMemo.has(name)) return _geoMemo.get(name);
  const g = (await geocode(name)) || null;
  _geoMemo.set(name, g);
  return g;
}

// Reverse-geocode (coords → city) with a persistent cache: cities don't move, so the
// result is stored in localStorage keyed by ~1km-rounded coords and reused forever.
const REVERSE_CACHE_KEY = '__plannerRevGeo_v1__';
/** @type {Map<string, string|null>} */
const _revGeoMemo = new Map();
/**
 * @param {number} lat
 * @param {number} lon
 * @returns {Promise<string|null>}
 */
async function reverseGeocodeMemo(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  if (_revGeoMemo.has(key)) return _revGeoMemo.get(key) ?? null;
  const cache = readJson(REVERSE_CACHE_KEY) || {};
  if (Object.prototype.hasOwnProperty.call(cache, key)) {
    _revGeoMemo.set(key, cache[key]);
    return cache[key];
  }
  const city = await reverseGeocode(lat, lon);
  _revGeoMemo.set(key, city);
  if (city) {
    cache[key] = city;
    writeJson(REVERSE_CACHE_KEY, cache);
  }
  return city;
}

/**
 * Weather keyed by date for a set of trip dates: resolve each date's location,
 * fetch per contiguous place-segment, return a Map date → day record.
 * @param {string[]} dateList
 * @returns {Promise<Map<string, any>>}
 */
async function weatherByDate(dateList) {
  /** @type {Map<string, any>} */
  const out = new Map();
  const uniq = [...new Set(dateList)].filter(Boolean).sort();
  if (!uniq.length) return out;

  let primary = savedLocation();
  if (!primary?.lat) {
    const name = defaultLocationName();
    const geo = name ? await geocodeMemo(name) : null;
    if (!geo) return out;
    primary = { name, lat: geo.lat, lon: geo.lon, label: geo.label };
  }

  const start = uniq[0];
  const end = uniq[uniq.length - 1];
  const isNormals = (daysUntil(start) ?? 0) > FORECAST_HORIZON_DAYS;
  const events = locationEvents(state.planner?.personal);
  const segments = groupByLocation(enumerateDates(start, end), events, primary.name);
  const primaryPlace = { lat: primary.lat, lon: primary.lon };

  for (const seg of segments) {
    let place = seg.coords ? { lat: seg.coords.lat, lon: seg.coords.lon } : null;
    if (!place) place = (await geocodeMemo(seg.location)) || primaryPlace;
    const fc = isNormals
      ? await loadNormals(place.lat, place.lon, seg.start, seg.end)
      : await loadForecast(place.lat, place.lon, seg.start, seg.end);
    for (const d of fc?.days || []) out.set(d.date, d);
  }
  return out;
}

let _itinToken = 0;

/**
 * Fill the itinerary day-header weather slots ([data-wx-day]) with a small chip.
 * Best-effort: a day with no resolvable weather just clears its slot.
 */
export async function renderItineraryWeather() {
  const slots = /** @type {HTMLElement[]} */ ([...document.querySelectorAll('[data-wx-day]')]);
  if (!slots.length) return;
  const token = ++_itinToken;
  const byDate = await weatherByDate(slots.map((s) => s.getAttribute('data-wx-day') || ''));
  if (token !== _itinToken) return;
  const u = unit();
  for (const slot of slots) {
    const d = byDate.get(slot.getAttribute('data-wx-day') || '');
    if (!d || d.tmax == null) {
      slot.innerHTML = '';
      continue;
    }
    const info = weatherInfo(d.code);
    slot.innerHTML = `<span class="itin-wx-chip" data-tone="${esc(info.tone)}" title="${esc(info.label)}"><i class="fas ${esc(info.icon)}" aria-hidden="true"></i><span>${esc(formatTemp(d.tmax, u))}</span></span>`;
  }
}

// ── Compact summary (Personal / Sponsor tabs) ───────────────────────────────
// A small, subtle strip — the trip location + the next few days — for the mode
// dashboards. Fills any [data-wx-summary] slot; clears them when there's nothing.

let _summaryToken = 0;

export async function renderWeatherSummary() {
  const slots = /** @type {HTMLElement[]} */ ([...document.querySelectorAll('[data-wx-summary]')]);
  if (!slots.length) return;
  const token = ++_summaryToken;
  const range = tripRange();
  const dates = enumerateDates(range.start, range.end).slice(0, 4);
  const byDate = await weatherByDate(dates);
  if (token !== _summaryToken) return;

  const u = unit();
  const chips = dates
    .map((dt) => {
      const d = byDate.get(dt);
      if (!d || d.tmax == null) return '';
      const info = weatherInfo(d.code);
      const wd = new Date(`${dt}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short' });
      return `<span class="wx-sum-day" data-tone="${esc(info.tone)}" title="${esc(info.label)}"><span class="wx-sum-wd">${esc(wd)}</span>${weatherGlyph(info.tone, 'wx-glyph wx-glyph--sm')}${esc(formatTemp(d.tmax, u))}</span>`;
    })
    .filter(Boolean)
    .join('');
  const loc = savedLocation()?.label || defaultLocationName();
  const html = chips
    ? `<div class="wx-sum"><span class="wx-sum-loc">${esc((loc || '').split(',')[0])}</span>${chips}</div>`
    : '';
  slots.forEach((s) => {
    s.innerHTML = html;
  });
}

// ── Wire ────────────────────────────────────────────────────────────────────

export function wireWeatherPanel() {
  document.querySelectorAll('[data-weather-unit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      setUnit(btn.getAttribute('data-weather-unit') || 'C');
      renderWeatherTab();
    });
  });
}
