// Archive Observatory — a data-viz dashboard over the whole 19-year archive:
// events/sessions per year, series + tier breakdowns, ranked speakers/sponsors
// (with appearance timelines), a topic-trend line chart mined from session titles +
// descriptions, and archive-wide search. The "after" the Curation Studio hands off to — it
// reflects your reconciliation (aliased names aggregate cleanly). Bar charts are
// hand-built CSS; the topic trend is inline SVG (no chart lib). Read-only.

import { escapeHtml as esc, slugify } from './utils.js';

const Y0 = 2007;
const Y1 = 2026;
const $ = (id) => document.getElementById(id);
const num = (n) => Number(n || 0).toLocaleString();
const plural = (n, w, many) => `${n} ${n === 1 ? w : many || `${w}s`}`;
let _data = null; // last-loaded insights, so drill-downs can read detail without a refetch
let _series = 'All'; // global dashboard scope — filters every panel + search
let _view = null; // cached filtered view for the current series
const RANK_MIN = 12; // ranked rows shown before "Show more"
const RANK_STEP = 25; // rows revealed per "Show more" click
let _rankN = { speaker: RANK_MIN, sponsor: RANK_MIN };

// ── Home view modes ───────────────────────────────────────────────────────────
//
// The archive home answers three different questions from one filtered scope:
// what is in here (the overview), what was filmed (videos), and what was
// photographed (albums). They share the series/region/country/year filters —
// choosing DrupalCon 2024 and switching to Videos should show that event's
// recordings, not start again — so the scope lives in the module, not the tab.
const HOME_TABS = [
  ['overview', 'Overview'],
  ['videos', 'Videos'],
  ['albums', 'Photo albums'],
];
let _homeTab = 'overview';
let _videoQ = ''; // free-text query on the video view: a person, a topic, an event
let _videoOffset = 0; // paging cursor, reset whenever the query or scope changes
const VIDEO_PAGE = 60;
let _videoRows = []; // results gathered so far — "Show more" adds a page, it does not replace one

/**
 * The video id and host behind a recording URL.
 *
 * Only YouTube can give us a thumbnail without an API call, and the archive holds
 * 245 recordings elsewhere (mostly archive.org), so the shape has to say which
 * kind it is rather than assume.
 *
 * @param {string} url
 * @returns {{host: string, id: string}}
 */
export function videoRef(url) {
  const u = String(url || '').trim();
  if (!u) return { host: '', id: '' };
  const yt = u.match(
    /(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|live\/)|youtu\.be\/)([\w-]{6,})/i,
  );
  if (yt) return { host: 'YouTube', id: yt[1] };
  if (/(?:^|\.)archive\.org\//i.test(u)) return { host: 'archive.org', id: '' };
  if (/vimeo\.com\//i.test(u)) return { host: 'Vimeo', id: '' };
  try {
    return { host: new URL(u).hostname.replace(/^www\./, ''), id: '' };
  } catch {
    return { host: '', id: '' };
  }
}

/** YouTube's own still for a recording, or '' when we have no thumbnail to show. */
export function videoThumb(url) {
  const { id } = videoRef(url);
  return id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : '';
}

/**
 * Events with a photo album, newest first.
 *
 * Album data is event-level — there are no per-session photos — so this reads the
 * insights event rows rather than the session index. Events without an album are
 * left out: this view is for looking at pictures, and the coverage report is
 * where missing ones belong.
 *
 * @param {Record<string, any[]>} yearEvents
 * @param {(e: any) => boolean} inScopeFn
 */
export function albumRows(yearEvents = {}, inScopeFn = () => true) {
  const rows = [];
  for (const [year, list] of Object.entries(yearEvents || {})) {
    for (const e of list || []) {
      if (!e.album || !inScopeFn({ ...e, year: Number(year) })) continue;
      rows.push({
        ...e,
        year: Number(year),
        provider: e.albumProvider || providerFromUrl(e.album),
      });
    }
  }
  return rows.sort((a, b) => b.year - a.year || a.label.localeCompare(b.label));
}

/** Name the host when the dataset never recorded a provider — 21 of them do not. */
function providerFromUrl(url) {
  const u = String(url || '');
  if (/flic\.kr|flickr\.com/i.test(u)) return 'Flickr';
  if (/photos\.app\.goo\.gl|photos\.google/i.test(u)) return 'Google Photos';
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return 'Album';
  }
}

// ── Global scope filters — series · year · region (EUR/MEA/APAC/AMER/LATAM) · country ──
let _year = 'All';
let _region = 'All';
let _country = 'All';
// Friendly labels for the region facet + "Now viewing" chip (codes are terse).
const REGION_LABELS = {
  EUR: 'Europe',
  MEA: 'Middle East & Africa',
  APAC: 'Asia-Pacific',
  AMER: 'North America',
  LATAM: 'Latin America',
};
const regionLabel = (code) => REGION_LABELS[code] || code;

function facetsActive() {
  return _series !== 'All' || _year !== 'All' || _region !== 'All' || _country !== 'All';
}
// An event/appearance matches the active facets. `noYear` is used by the "over time"
// year chart, which shows the time axis regardless of a year filter.
function inScope(e, noYear) {
  return (
    (_series === 'All' || e.series === _series) &&
    (noYear || _year === 'All' || e.year === Number(_year)) &&
    (_region === 'All' || e.region === _region) &&
    (_country === 'All' || e.country === _country)
  );
}
function scopedEntities(list, kind) {
  const out = [];
  for (const s of list || []) {
    const evs = s.detail.filter((e) => inScope(e));
    if (!evs.length) continue;
    const years = [...new Set(evs.map((e) => e.year).filter(Boolean))].sort((a, b) => a - b);
    if (kind === 'speaker')
      out.push({
        name: s.name,
        appearances: evs.reduce((n, e) => n + (e.n || e.talks?.length || 1), 0),
        events: evs.length,
        years,
        detail: evs,
      });
    else
      out.push({
        title: s.title,
        events: evs.length,
        years,
        tiers: [...new Set(evs.map((e) => e.tier).filter(Boolean))],
        detail: evs,
      });
  }
  return out.sort(
    kind === 'speaker'
      ? (a, b) => b.appearances - a.appearances || b.events - a.events
      : (a, b) => b.events - a.events,
  );
}
// Every event as a flat list (from yearEvents), tagged with its year.
function flatEvents() {
  const out = [];
  for (const [y, evs] of Object.entries(_data.yearEvents || {}))
    for (const e of evs) out.push({ ...e, year: Number(y) });
  return out;
}
function tiersFrom(sponsors) {
  const c = {};
  for (const s of sponsors) for (const e of s.detail) if (e.tier) c[e.tier] = (c[e.tier] || 0) + 1;
  return Object.entries(c)
    .map(([tier, count]) => ({ tier, count }))
    .sort((a, b) => b.count - a.count);
}
function computeView() {
  if (!facetsActive()) {
    _view = {
      stats: _data.stats,
      years: _data.years,
      speakers: _data.speakers,
      sponsors: _data.sponsors,
      tiers: _data.tiers,
    };
    return _view;
  }
  const all = flatEvents();
  // Year chart: faceted by everything EXCEPT year (full range, selected year highlighted).
  const byY = {};
  for (const e of all)
    if (inScope(e, true)) {
      (byY[e.year] ??= { events: 0, sessions: 0 }).events++;
      byY[e.year].sessions += e.sessions || 0;
    }
  const years = [];
  for (let y = Y0; y <= Y1; y++)
    years.push({ year: y, events: byY[y]?.events || 0, sessions: byY[y]?.sessions || 0 });
  // Fully-scoped events → stats.
  const evs = all.filter((e) => inScope(e));
  const ys = [...new Set(evs.map((e) => e.year).filter(Boolean))].sort((a, b) => a - b);
  const speakers = scopedEntities(_data.speakers, 'speaker');
  const sponsors = scopedEntities(_data.sponsors, 'sponsor');
  _view = {
    stats: {
      events: evs.length,
      sessions: evs.reduce((n, e) => n + (e.sessions || 0), 0),
      yearMin: ys[0] || (_data.stats || {}).yearMin,
      yearMax: ys[ys.length - 1] || (_data.stats || {}).yearMax,
      // Years that HAVE events in this scope, not the width of the range. The
      // tile was `yearMax - yearMin + 1`, which is the same number only while
      // every year in the range is represented — filter to one series and the
      // gaps are immediate, and it would have counted years that series never ran.
      yearCount: ys.length,
      minutes: evs.reduce((n, e) => n + (e.minutes || 0), 0),
      speakers: speakers.length,
      sponsors: sponsors.length,
      sponsorSlots: sponsors.reduce((n, s) => n + s.detail.length, 0),
    },
    years,
    speakers,
    sponsors,
    tiers: tiersFrom(sponsors),
  };
  return _view;
}
function facetOptions(values, current, allLabel) {
  return [`<option value="All"${current === 'All' ? ' selected' : ''}>${allLabel}</option>`]
    .concat(
      (values || []).map(
        (v) =>
          `<option value="${esc(String(v))}"${String(v) === String(current) ? ' selected' : ''}>${esc(String(v))}</option>`,
      ),
    )
    .join('');
}
// Years newest-first, shared by the dashboard facets and the session search.
function yearsDescList() {
  return (_data?.years || [])
    .filter((y) => y.events > 0)
    .map((y) => y.year)
    .filter(Boolean)
    .sort((a, b) => b - a);
}

function seriesOptions() {
  return (_data.topicSeries || ['All'])
    .map(
      (name) =>
        `<option value="${esc(name)}"${name === _series ? ' selected' : ''}>${name === 'All' ? 'All series' : esc(name)}</option>`,
    )
    .join('');
}

function timeline(years) {
  const set = new Set((years || []).map(Number));
  let s = '<span class="obs-tl" aria-hidden="true">';
  for (let y = Y0; y <= Y1; y++) s += `<i class="${set.has(y) ? 'on' : ''}"></i>`;
  return s + '</span>';
}

function yearsChart(years) {
  const max = Math.max(1, ...years.map((y) => y.sessions));
  return `<div class="obs-years">${years
    .map(
      (
        y,
      ) => `<div class="obs-ycol${y.events ? '' : ' obs-ycol--empty'}${_year !== 'All' && String(y.year) === String(_year) ? ' obs-ycol--sel' : ''}"${y.events ? ` data-drill="year" data-key="${y.year}"` : ''} title="${y.year}: ${y.events} event${y.events === 1 ? '' : 's'}, ${y.sessions} session${y.sessions === 1 ? '' : 's'}">
      <div class="obs-ybar" style="height:${y.sessions ? Math.max(3, (y.sessions / max) * 100) : 2}%">${y.events ? `<span class="obs-ybar-n">${y.events}</span>` : ''}</div>
      <span class="obs-ylabel">'${String(y.year).slice(2)}</span>
    </div>`,
    )
    .join('')}</div>`;
}

// A section heading and, where there is one, its legend.
//
// These used to be one element: `<h2>Most prolific speakers <span>click for
// their journey</span></h2>`. Navigating by heading then announced "Most
// prolific speakers click for their journey" — an instruction welded to a
// landmark. The row keeps its layout; the heading keeps only its name.
// ── Community credits ────────────────────────────────────────────────────────
// Organisers and volunteers, captured from each event's drupal.org community
// page. Two lists rather than one ranking: the roles are different jobs, and
// merging them would rank the person who volunteered once above the person who
// ran three events.
//
// Rows carry the same per-event `detail` shape as speakers and sponsors, so
// they go through the same inScope() filter and respond to the series / region /
// country / year facets exactly like the rest of the dashboard.

/** Credits for one role, filtered to the active facets. */
function scopedCredits(role) {
  const out = [];
  for (const p of _data?.credits?.people || []) {
    if (p.role !== role) continue;
    const evs = (p.detail || []).filter((e) => inScope(e));
    if (!evs.length) continue;
    out.push({
      name: p.name,
      username: p.username,
      events: evs.length,
      years: [...new Set(evs.map((e) => e.year).filter(Boolean))].sort((a, b) => a - b),
      detail: evs,
    });
  }
  return out.sort((a, b) => b.events - a.events || a.name.localeCompare(b.name));
}

/**
 * How much of a SCOPE has credits, counted in events.
 *
 * The ranking beside it is already filtered, so an archive-wide fraction next to
 * a filtered list is two different questions answered as one line: under a
 * DrupalSouth filter it read "credits captured for 28 of 84 events" while the
 * list beneath it was drawn from 4 DrupalSouth events out of 16.
 *
 * Counted by FILE, because a credit's detail row is per event and a person with
 * three roles at one event must not make that event count three times.
 *
 * @param {{events?: any[], people?: any[], inScope?: (e: any) => boolean}} args
 * @returns {{withCredits: number, events: number}}
 */
export function creditsCoverage({ events = [], people = [], inScope = () => true }) {
  const credited = new Set();
  for (const p of people || [])
    for (const e of p?.detail || []) if (e?.file && inScope(e)) credited.add(e.file);
  return { withCredits: credited.size, events: (events || []).filter((e) => inScope(e)).length };
}

/** Coverage first — a ranking over a fraction of the archive must say so. */
function creditsNote(rows) {
  const c = creditsCoverage({
    events: _data ? flatEvents() : [],
    people: _data?.credits?.people || [],
    inScope: (e) => inScope(e),
  });
  if (!c.events) return '';
  const scope = facetsActive() ? ' in scope' : '';
  if (!c.withCredits) return `no credits captured${scope || ' yet'}`;
  return `${plural(rows.length, 'person', 'people')}${scope} · credits captured for ${c.withCredits} of ${c.events} events`;
}

/** One credit column, using the shared rank row so it matches speakers/sponsors. */
function creditsPanel(rows) {
  if (!rows.length) {
    return `<p class="obs-drill-note">None captured for this selection. Credits are added per event in the editor, under Content &rarr; People.</p>`;
  }
  const top = rows.slice(0, 12);
  return (
    rankList(top, 'name', (r) => plural(r.events, 'event'), 'person') +
    (rows.length > top.length
      ? `<p class="obs-rank-count">Top 12 of ${rows.length} — search for any other</p>`
      : '')
  );
}

function sectionHeading(title, note = '') {
  return `<div class="obs-section-t">
    <h2 class="obs-section-h">${title}</h2>
    ${note ? `<span class="obs-section-note">${note}</span>` : ''}
  </div>`;
}

function hbars(rows, labelKey, valKey, drill) {
  const max = Math.max(1, ...rows.map((r) => r[valKey]));
  return `<div class="obs-hbars">${rows
    .map((r) => {
      // Rows with no events in the current scope are greyed and non-clickable, but kept
      // visible and marked 0 — so e.g. a series absent from the filtered country still shows.
      const zero = !r[valKey];
      const click = drill && !zero;
      return `<div class="obs-hbar${click ? ' obs-clickable' : ''}${zero ? ' obs-hbar--zero' : ''}"${click ? ` data-drill="${drill}" data-key="${esc(r[labelKey])}"` : ''}><span class="obs-hbar-l" title="${esc(r[labelKey])}">${esc(r[labelKey])}</span>
      <div class="obs-hbar-track"><div class="obs-hbar-fill" style="width:${(r[valKey] / max) * 100}%"></div></div>
      <span class="obs-hbar-v">${r[valKey]}</span></div>`;
    })
    .join('')}</div>`;
}
// Every series with its event count in the *current* facet scope (region/country/year),
// keeping series that drop to 0 so they render greyed rather than disappearing.
// Events AND sessions per series in scope. It used to count events only, so
// switching the chart to Sessions left this panel silently answering a different
// question with the same heading.
function scopedSeriesRows() {
  const counts = {};
  for (const e of flatEvents()) {
    if (!inScope(e)) continue;
    const c = (counts[e.series] ||= { events: 0, sessions: 0 });
    c.events += 1;
    c.sessions += Number(e.sessions) || 0;
  }
  return (_data.series || []).map((s) => ({
    name: s.name,
    events: counts[s.name]?.events || 0,
    sessions: counts[s.name]?.sessions || 0,
  }));
}

function rankList(rows, nameKey, metaFn, drill, keyKey) {
  return `<div class="obs-rank">${rows
    .map(
      (
        r,
        i,
      ) => `<div class="obs-rankrow${drill ? ' obs-clickable' : ''}"${drill ? ` data-drill="${drill}" data-key="${esc(r[keyKey || nameKey])}"` : ''}><span class="obs-rank-i">${i + 1}</span>
      <span class="obs-rank-main"><span class="obs-rank-name">${esc(r[nameKey])}</span><span class="obs-rank-meta">${esc(metaFn(r))}</span></span>
      ${timeline(r.years || [])}</div>`,
    )
    .join('')}</div>`;
}

// ── Map (Leaflet, lazy-loaded, dark CartoDB) ─────────────────────────────────
let _leafletReady = false;
let _leafletCbs = [];
let _map = null;
let _mapPts = [];
function loadLeaflet(cb) {
  if (window.L || _leafletReady) {
    _leafletReady = true;
    return cb();
  }
  _leafletCbs.push(cb);
  if (_leafletCbs.length > 1) return;
  if (!document.getElementById('obs-leaflet-css')) {
    const link = document.createElement('link');
    link.id = 'obs-leaflet-css';
    link.rel = 'stylesheet';
    link.href = new URL('../../vendor/leaflet-1.9.4/leaflet.css', import.meta.url).href;
    document.head.appendChild(link);
  }
  const sc = document.createElement('script');
  // Vendored, not from a CDN — see leafletLoader.js.
  sc.src = new URL('../../vendor/leaflet-1.9.4/leaflet.js', import.meta.url).href;
  sc.onload = () => {
    _leafletReady = true;
    _leafletCbs.forEach((f) => f());
    _leafletCbs = [];
  };
  document.body.appendChild(sc);
}
function destroyMap() {
  if (_map) {
    _map.remove();
    _map = null;
  }
  _mapPts = [];
}
function initDrillMap() {
  if (!_mapPts.length) return;
  loadLeaflet(() => {
    const el = document.getElementById('obsMap');
    const L = window.L;
    if (!el || !L) return;
    if (_map) _map.remove();
    _map = L.map(el, { zoomControl: true, attributionControl: false, scrollWheelZoom: false });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd',
      maxZoom: 19,
      noWrap: true, // one Earth only — no repeating tiles to the sides
    }).addTo(_map);
    const bounds = [];
    for (const p of _mapPts) {
      L.circleMarker([p.lat, p.lon], {
        radius: 6,
        weight: 2,
        fillOpacity: 0.9,
        // Colour lives in CSS so pins follow the silver ramp in both modes;
        // Leaflet writes stroke/fill as attributes, which cannot read a var().
        className: 'obs-map-pin',
      })
        .addTo(_map)
        .bindPopup(`<b>${esc(p.label)}</b>${p.year ? `<br>${esc(String(p.year))}` : ''}`);
      bounds.push([p.lat, p.lon]);
    }
    // CONTAIN, deliberately. This is the drill-down map — a speaker's journey or
    // a sponsor's — where every plotted place must stay on screen. Cover is
    // right for the world strip, which is decorative and may crop; it is wrong
    // here, where cropping loses data.
    if (bounds.length === 1) _map.setView(bounds[0], 5);
    else _map.fitBounds(bounds, { padding: [34, 34], maxZoom: 10 });
    setTimeout(() => _map && _map.invalidateSize(), 90);
  });
}
// ── Global footprint strip — a thin, non-interactive world map under the stats ─
let _stripMap = null;
function destroyStripMap() {
  if (_stripMap) {
    _stripMap.remove();
    _stripMap = null;
  }
}
// Distinct geocoded locations in the current facet scope, with a per-city count.
function stripPoints() {
  const by = new Map();
  for (const e of flatEvents()) {
    if (!inScope(e) || !(Number.isFinite(e.lat) && Number.isFinite(e.lon))) continue;
    const key = `${e.lat.toFixed(2)},${e.lon.toFixed(2)}`;
    if (!by.has(key)) by.set(key, { lat: e.lat, lon: e.lon, count: 0, labels: [] });
    const g = by.get(key);
    g.count++;
    if (g.labels.length < 10) g.labels.push(e.label);
  }
  return [...by.values()];
}
// The most recent geocoded event in scope — used as the map's focal centre so the view
// always settles on a real, meaningful place (the latest event) rather than an arbitrary
// geometric midpoint that can land in empty ocean.
function stripAnchor() {
  let best = null;
  for (const e of flatEvents()) {
    if (!inScope(e) || !(Number.isFinite(e.lat) && Number.isFinite(e.lon))) continue;
    if (!best || e.year > best.year) best = { year: e.year, lat: e.lat, lon: e.lon };
  }
  return best;
}
// Global-reach stats beside the footprint map — countries · regions · cities, from
// the current facet scope.
function renderGlobeStats(pts) {
  const g = $('obsGlobe');
  if (!g) return;
  const evs = flatEvents().filter((e) => inScope(e));
  const countries = new Set(evs.map((e) => e.country).filter(Boolean)).size;
  const regions = new Set(evs.map((e) => e.region).filter(Boolean)).size;
  const mapped = pts.reduce((n, p) => n + p.count, 0);
  const stat = (n, label) =>
    `<div class="obs-globe-stat"><b>${num(n)}</b><span>${label}</span></div>`;
  g.innerHTML = `
    <span class="obs-globe-eyebrow">Global reach</span>
    ${stat(countries, countries === 1 ? 'country' : 'countries')}
    ${stat(regions, regions === 1 ? 'region' : 'regions')}
    ${stat(pts.length, pts.length === 1 ? 'city' : 'cities')}
    <span class="obs-globe-foot">${plural(mapped, 'event')} on the map</span>`;
}
// The "Now viewing" card floating over the map — the active facets as removable
// chips, or an evocative line for the whole archive. Fills the map's empty gutter.
function renderMapFilters() {
  const box = $('obsMapFilters');
  if (!box) return;
  const chip = (f, label, val) =>
    `<button type="button" class="obs-mapfilter-chip" data-clear="${f}" title="Clear this filter"><span>${label}</span><b>${esc(val)}</b></button>`;
  const chips = [];
  if (_series !== 'All') chips.push(chip('series', 'Series', _series));
  if (_region !== 'All') chips.push(chip('region', 'Region', regionLabel(_region)));
  if (_country !== 'All') chips.push(chip('country', 'Country', _country));
  if (_year !== 'All') chips.push(chip('year', 'Year', _year));
  const st = _data.stats || {};
  box.innerHTML = chips.length
    ? `<span class="obs-mapfilter-eyebrow">Now viewing</span>${chips.join('')}`
    : `<span class="obs-mapfilter-eyebrow">The whole archive</span><span class="obs-mapfilter-all">${st.yearMin}–${st.yearMax} · every region</span>`;
}
function initStripMap() {
  const el = $('obsStripMap');
  if (!el) return;
  const pts = stripPoints();
  renderGlobeStats(pts);
  renderMapFilters();
  const wrap = el.closest('.obs-stripmap-wrap');
  wrap?.removeAttribute('hidden');
  if (!pts.length) {
    // Nothing to plot (every event in scope is online / unplaced) — keep the row and its
    // "Global reach" stats, but swap the map for an honest placeholder instead of vanishing.
    destroyStripMap();
    el.classList.add('obs-stripmap-empty');
    el.innerHTML =
      '<div class="obs-stripmap-none"><b>No mapped locations here</b><span>Every event in this view is online or hasn’t been placed yet.</span></div>';
    return;
  }
  loadLeaflet(() => {
    const L = window.L;
    if (!$('obsStripMap') || !L) return;
    destroyStripMap();
    el.classList.remove('obs-stripmap-empty');
    el.innerHTML = ''; // clear any prior placeholder before Leaflet mounts
    _stripMap = L.map(el, {
      zoomControl: false,
      attributionControl: false,
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false,
      touchZoom: false,
      // Stop the world repeating left/right so it can zoom in on one Earth.
      worldCopyJump: false,
      zoomSnap: 0, // allow fractional zoom so the map fills the strip width exactly
    });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd',
      maxZoom: 19,
      noWrap: true, // one Earth only — no repeating tiles to the sides
    }).addTo(_stripMap);
    const bounds = [];
    for (const p of pts) {
      L.circleMarker([p.lat, p.lon], {
        radius: Math.min(3 + p.count * 0.7, 8),
        weight: 1,
        fillOpacity: 0.85,
        className: 'obs-map-pin',
      })
        .addTo(_stripMap)
        .bindTooltip(`${esc(p.labels[0])}${p.count > 1 ? ` +${p.count - 1} more` : ''}`, {
          direction: 'top',
        });
      bounds.push([p.lat, p.lon]);
    }
    // Fill the strip width edge-to-edge (no blank gutters) without repeating the world:
    // drive the zoom from the events' *longitude* span so their spread fills the container
    // width. Centre on the newest event (stripAnchor), then clamp the centre in pixel space
    // so the view can never run past the edge of the single, non-repeating world — which is
    // what broke antimeridian events like New Zealand (~174°E spilled into the empty gutter).
    const lons = pts.map((p) => p.lon);
    const lats = pts.map((p) => p.lat);
    // Focal meridian = the newest event (resolves the antimeridian ambiguity that broke NZ);
    // focal latitude = the cluster midpoint so no city crops off the top/bottom of the strip.
    const anchor = stripAnchor() || { lon: (Math.min(...lons) + Math.max(...lons)) / 2 };
    const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
    // Capture this specific map instance; deferred/resize callbacks bail if a later render
    // has replaced or torn it down (else Leaflet throws on a removed map's panes).
    const map = _stripMap;
    // Still the current, un-torn-down map? A re-render/destroy reassigns _stripMap, so this
    // identity check alone lets deferred/resize callbacks bail safely — WITHOUT requiring
    // map._loaded, which Leaflet only sets after the first setView (that applyView itself does).
    const alive = () => _stripMap === map;
    const applyView = () => {
      if (!alive()) return;
      const size = map.getSize();
      const px = size.x || el.clientWidth || 900;
      // World is 256·2^z px wide; the padded longitude span should fill the container width.
      const spanDeg = Math.min(Math.max(Math.max(...lons) - Math.min(...lons), 1) * 1.15, 360);
      const fillZoom = Math.min(Math.log2((px * 360) / (256 * spanDeg)), 6);
      // Never zoom past the point where every plotted location still fits — otherwise a
      // latitudinally-tall cluster (e.g. New Zealand) fills the width but crops its own
      // northern/southern cities off the short strip.
      const fitZoom = map.getBoundsZoom(L.latLngBounds(bounds), false, L.point(30, 34));
      // With `noWrap` the world stops at its edges, so any zoom where the world
      // is narrower than the frame leaves gutters. This is the floor at which
      // the world covers the width — below it the map letterboxes.
      const coverZoom = Math.log2(px / 256);
      // A Leaflet zoom level is a power of two: each level doubles the world's
      // pixel width, so -1 shows twice as much ground. One level wider reads
      // better, but never below the cover floor or the gutters come back.
      const z = pts.length === 1 ? 4 : Math.max(coverZoom, Math.min(fillZoom, fitZoom) - 1);
      // Clamp the focal point so the viewport stays wholly inside the world at this zoom.
      const world = 256 * Math.pow(2, z);
      const p = map.project([midLat, anchor.lon], z);
      const clamp1 = (v, half) =>
        world <= half * 2 ? world / 2 : Math.min(Math.max(v, half), world - half);
      p.x = clamp1(p.x, size.x / 2);
      p.y = clamp1(p.y, size.y / 2);
      map.setView(map.unproject(p, z), z);
    };
    // On first paint the container is often not laid out yet, so getSize()/fillZoom are
    // wrong and the map lands with side gutters. Re-apply once the map is ready, on the
    // next frame, after an invalidateSize, and again shortly after — and on any resize —
    // so the fill+anchor view always settles against the real width.
    const settle = () => {
      if (!alive()) return;
      map.invalidateSize();
      applyView();
    };
    applyView();
    map.whenReady(() => requestAnimationFrame(settle));
    map.on('resize', () => alive() && applyView());
    setTimeout(settle, 120);
    setTimeout(settle, 340);
  });
}
const geocoded = (arr) =>
  (arr || []).filter((e) => Number.isFinite(e.lat) && Number.isFinite(e.lon));
// A disclosure listing the events that AREN'T on the map (placeless like Online/Global,
// or a location not yet in the geocode cache) — so nothing silently disappears.
function unmappedList(evs) {
  const missing = (evs || []).filter((e) => !(Number.isFinite(e.lat) && Number.isFinite(e.lon)));
  if (!missing.length) return '';
  const items = missing
    .map(
      (e) =>
        `<li>${esc(e.label || e.location || '—')}${e.year ? ` <span>(${e.year})</span>` : ''}</li>`,
    )
    .join('');
  return `<details class="obs-map-unmapped"><summary>${missing.length} not on the map</summary><ul>${items}</ul></details>`;
}
function mapBlock(pts, evs) {
  const total = (evs || []).length;
  if (!pts.length)
    return total
      ? `<div class="obs-map-wrap"><p class="obs-map-none">No coordinates for these ${total} event${total === 1 ? '' : 's'} — run <code>npm run geocode:events</code> to map them.</p>${unmappedList(evs)}</div>`
      : '';
  // Map and reach side by side: the figures carry the summary, so the map can be
  // narrower instead of being the only place the story is told.
  return `<div class="obs-map-row">
    <div class="obs-map-wrap"><div class="obs-map" id="obsMap"></div>${unmappedList(evs)}</div>
    ${reachBlock(evs || [])}
  </div>`;
}

// ── Drill-down detail views ──────────────────────────────────────────────────
const txt = (v) => String(v ?? '').trim();

function eventRow(year, main, sub) {
  return `<div class="obs-ev"><span class="obs-ev-y">${year || '—'}</span><div class="obs-ev-main"><span class="obs-ev-t">${esc(main)}</span>${sub ? `<span class="obs-ev-s">${esc(sub)}</span>` : ''}</div></div>`;
}

// Expandable event rows on a speaker journey → full per-talk detail, fetched on
// demand from the (statically-served) dataset. `_drillDetail` holds the current
// speaker's events so the click handler can look one up by index.
let _drillDetail = [];
const _datasetCache = {};
async function fetchDataset(file) {
  if (_datasetCache[file]) return _datasetCache[file];
  let out = { items: [], tz: '' };
  try {
    // Resolved against THIS MODULE's url, not the page's. A relative './data/'
    // breaks the moment the page has path segments (/archive/speaker/x
    // resolves it to /archive/speaker/data/…), which is exactly what made
    // every talk expander report "no detail" on a drill-down page. Using
    // import.meta.url also keeps a sub-directory deployment working, which a
    // root-absolute '/data/' would not.
    const r = await fetch(new URL(`../../data/${file}`, import.meta.url), { cache: 'no-cache' });
    if (r.ok) {
      const d = await r.json();
      out = { items: d.items || [], tz: (d.event || {}).timezone || '' };
    }
  } catch {
    /* offline / missing → no detail */
  }
  _datasetCache[file] = out;
  return out;
}

function talkTime(startTime, endTime, tz) {
  if (!startTime) return '';
  const s = new Date(startTime);
  if (Number.isNaN(s.getTime())) return '';
  const zone = tz ? { timeZone: tz } : {};
  let out = s.toLocaleString('en-GB', {
    ...zone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const e = endTime ? new Date(endTime) : null;
  if (e && !Number.isNaN(e.getTime()))
    out += `–${e.toLocaleTimeString('en-GB', { ...zone, hour: '2-digit', minute: '2-digit', hour12: false })}`;
  return out;
}

// One talk, full-width — echoes the planner's detail-row pattern in the Observatory's
// dark language: title, a meta strip (time · room · track · co-speakers), the abstract,
// then session/recording links.
function talkCard(s, tz) {
  const speakers = (s.speakers || [])
    .map((sp) => (typeof sp === 'string' ? sp : sp?.name))
    .filter(Boolean);
  const track = Array.isArray(s.track) ? s.track.filter(Boolean).join(', ') : txt(s.track);
  const meta = [
    talkTime(s.startTime, s.endTime, tz) &&
      `<span class="obs-talk-m">${esc(talkTime(s.startTime, s.endTime, tz))}</span>`,
    txt(s.location) && `<span class="obs-talk-m">${esc(txt(s.location))}</span>`,
    track && `<span class="obs-talk-m">${esc(track)}</span>`,
    speakers.length > 1 && `<span class="obs-talk-m">${esc(speakers.join(', '))}</span>`,
  ]
    .filter(Boolean)
    .join('');
  const desc = txt(s.full_description || s.description);
  const links = [
    txt(s.link) &&
      `<a class="obs-talk-link" href="${esc(txt(s.link))}" target="_blank" rel="noopener">Session page</a>`,
    txt(s.video_url) &&
      `<a class="obs-talk-link" href="${esc(txt(s.video_url))}" target="_blank" rel="noopener">Recording</a>`,
  ]
    .filter(Boolean)
    .join('');
  return `<article class="obs-talk">
    <h4 class="obs-talk-title">${esc(txt(s.title) || 'Untitled session')}</h4>
    ${meta ? `<div class="obs-talk-metarow">${meta}</div>` : ''}
    ${desc ? `<p class="obs-talk-desc">${esc(desc)}</p>` : ''}
    ${links ? `<div class="obs-talk-links">${links}</div>` : ''}
  </article>`;
}

async function expandTalks(row) {
  const i = Number(row.dataset.talkexp);
  const panel = document.getElementById(`obsEvDetail-${i}`);
  const ev = _drillDetail[i];
  if (!panel || !ev) return;
  if (!panel.hasAttribute('hidden')) {
    panel.setAttribute('hidden', '');
    row.classList.remove('is-open');
    return;
  }
  panel.removeAttribute('hidden');
  row.classList.add('is-open');
  if (panel.dataset.loaded) return;
  panel.innerHTML = '<div class="obs-talk-load">Loading…</div>';
  const { items, tz } = await fetchDataset(ev.file);
  const wanted = new Set((ev.talks || []).map(txt));
  const cards = (items || [])
    .filter((s) => wanted.has(txt(s.title)))
    .map((s) => talkCard(s, tz))
    .join('');
  panel.innerHTML = cards || '<p class="obs-talk-none">No talk detail recorded for this event.</p>';
  panel.dataset.loaded = '1';
}

// ── Routing ────────────────────────────────────────────────────────────────
// Every drill-down is addressable: /archive/<kind>/<slug>. Slugs are derived
// from the record's own name, so no id registry is needed; the reverse lookup
// scans the loaded set for a matching slug.
const DRILL_KINDS = {
  // ONE route for anyone: /archive/person/<slug>. A speaker, an organiser and a
  // volunteer are people, and once curation maps two of them together they are
  // the same person — so they cannot live at different URLs. `speaker` and
  // `search` stay as aliases so older links keep resolving. drillPath() picks
  // the FIRST key matching the type, so `person` must lead.
  person: 'person',
  speaker: 'person',
  search: 'person',
  sponsor: 'sponsor',
  event: 'event',
  conference: 'series',
  // A year is a record like any other — /archive/year/2024. It was the one drill
  // with no route, so `drillPath` fell through to '/archive', nothing was pushed,
  // and a refresh (or a shared link) landed back on the overview while the address
  // bar claimed otherwise.
  year: 'year',
};

export function drillPath(type, key) {
  // Resolve aliases FIRST: a row still carries data-drill="speaker", but a
  // speaker is a person now, and the URL must say so. Without this the alias
  // matched itself (`k === type`) and kept minting /archive/speaker/...
  const target = DRILL_KINDS[type] || type;
  const kind = Object.keys(DRILL_KINDS).find((k) => DRILL_KINDS[k] === target || k === target);
  return kind ? `/archive/${kind}/${slugify(String(key))}` : '/archive';
}

function keyForSlug(type, slug) {
  // Slugify BOTH sides. The incoming segment was only lowercased, so a name
  // that slugifies away punctuation ("kim.pepper" -> "kimpepper") never matched
  // when someone typed or shared the punctuated form.
  const want = slugify(String(slug || ''));
  const lists =
    {
      // Speaker names, credited names and profile slugs all address one person, so
      // the three kinds share a lookup. Names lead: the canonical name is the key
      // the person page is built on, and a slug is resolved back to it below.
      ...(() => {
        const people = [
          (_data?.speakers || []).map((r) => r.name),
          (_data?.credits?.people || []).map((r) => r.name),
          (_data?.credits?.people || []).map((r) => r.username),
        ];
        return { person: people, speaker: people, search: people };
      })(),
      sponsor: [(_data?.sponsors || []).map((r) => r.title)],
      // Years come from the data, so /archive/year/1999 is a miss rather than an
      // empty page pretending to be a record.
      year: [Object.keys(_data?.yearEvents || {})],
      event: [
        (_data?.yearEvents ? Object.values(_data.yearEvents).flat() : []).map(
          (e) => e.label || e.name,
        ),
      ],
      conference: [(_data?.series || []).map((r) => r.series || r.name || r)],
    }[type] || [];
  for (const names of lists) {
    const hit = (names || []).find((n) => n && slugify(String(n)) === want);
    if (hit) {
      // A person is addressed by slug everywhere else, so resolve a display-name
      // match back to its username rather than handing the drill a name it
      // cannot look up.
      if (type === 'person' || type === 'speaker' || type === 'search') {
        // A username resolves to its canonical display name — the key every
        // source shares and what curation aliases converge on.
        const rec = (_data?.credits?.people || []).find((r) => r.username === hit);
        return rec ? rec.name : hit;
      }
      return hit;
    }
  }
  return null;
}

// The breadcrumb is the route rendered. The archive gets deep enough — overview
// → kind → record, or a session search — that "Back to overview" alone leaves
// you without a sense of where you are.
const CRUMB_LABELS = {
  speaker: 'People',
  search: 'People',
  person: 'People',
  sponsor: 'Sponsors',
  event: 'Events',
  conference: 'Conferences',
  series: 'Conferences',
  year: 'Years',
  sessions: 'Sessions',
  topic: 'Topics',
};

export function setCrumbs(trail = []) {
  const nav = document.getElementById('scheduleCrumbs');
  if (!nav) return;
  const parts = [
    '<a href="./home.html">Home</a>',
    trail.length ? '<a href="/archive">Archive</a>' : '<span aria-current="page">Archive</span>',
    ...trail.map((c, i) =>
      i === trail.length - 1
        ? `<span aria-current="page">${esc(c.label)}</span>`
        : c.href
          ? `<a href="${esc(c.href)}">${esc(c.label)}</a>`
          : `<span>${esc(c.label)}</span>`,
    ),
  ];
  nav.innerHTML = parts.join('<span class="app-crumbs__sep" aria-hidden="true">→</span>');
}

/**
 * Arriving at a new view means arriving at the TOP of it.
 *
 * Resetting `#archiveObservatory` was only half the job: in the editor the studio
 * is an overlay with its own scrollport, but on the archive page it IS the page,
 * so the window keeps whatever offset the previous view had. Follow a speaker
 * from two thirds down the overview and the phone lands two thirds down their
 * page — past the heading, past the map, in the middle of a list, with no way to
 * tell what you are looking at.
 *
 * Focus moves with the scroll, not just the pixels: a keyboard or screen-reader
 * user is otherwise still parked in a control that no longer exists. `preventScroll`
 * because the scroll has already happened, and 'instant' because a navigation is
 * not a scroll gesture — animating a phone up through a page of results is slower
 * than simply being there.
 */
function toTopOfView() {
  const studio = $('archiveObservatory');
  if (studio) studio.scrollTop = 0;
  if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') {
    try {
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    } catch {
      window.scrollTo(0, 0);
    }
  }
  const body = $('obsBody');
  const head = body?.querySelector('.obs-drill-head, .obs-topbar') || body;
  if (head && typeof head.focus === 'function') {
    if (!head.hasAttribute('tabindex')) head.setAttribute('tabindex', '-1');
    head.focus({ preventScroll: true });
  }
}

// Renders a drill-down without touching history — the caller decides whether
// this is a navigation or the restoration of one.
export function showDrill(type, key) {
  if (!_data) return false;
  setCrumbs([{ label: CRUMB_LABELS[type] || type }, { label: String(key) }]);
  destroyMap();
  destroyStripMap();
  $('obsBody').innerHTML = drillHtml(DRILL_KINDS[type] || type, key);
  toTopOfView();
  initDrillMap();
  if ((DRILL_KINDS[type] || type) === 'person') hydrateCoSpeakers(key);
  return true;
}

// One line per search term over the archive's full span. Every year is plotted,
// zeros included, so a gap reads as a gap instead of being interpolated away.
//
// Colour comes from the same validated categorical slots as the topic chart, in
// fixed order. A single term needs no legend — the heading names it; two or more
// always carry one, so identity is never colour-alone.
function sessionTrendSvg(byTerm, terms) {
  const span = getYearSpan();
  const list = (terms || []).filter((t) => byTerm?.[t]);
  if (!span || !list.length) return '';

  const years = [];
  for (let y = span.min; y <= span.max; y += 1) years.push(y);
  const series = list.map((term, i) => ({
    term,
    ...slotStyle(i),
    vals: years.map((y) => Number(byTerm[term]?.[y] || 0)),
  }));
  const max = Math.max(1, ...series.flatMap((s) => s.vals));
  if (!series.some((s) => s.vals.some((v) => v > 0))) return '';

  const W = 720;
  const H = 160;
  const padL = 34;
  const padR = 10;
  const padT = 16;
  const padB = 26;
  const pw = W - padL - padR;
  const ph = H - padT - padB;
  const X = (i) => padL + (years.length === 1 ? pw / 2 : (i / (years.length - 1)) * pw);
  const Y = (v) => padT + ph - (v / max) * ph;

  const lines = series
    .map(
      (s) => `<polyline class="obs-st-line" style="stroke:${s.color}"${dashAttr(s.dash)}
        points="${s.vals.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ')}"/>
      ${s.vals
        .map((v, i) =>
          v
            ? `<circle class="obs-st-dot" style="fill:${s.color}" cx="${X(i).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="3"><title>${years[i]} · ${esc(s.term)}: ${plural(v, 'session')}</title></circle>`
            : '',
        )
        .join('')}`,
    )
    .join('');

  const xlab = years
    .map((y, i) =>
      (y - span.min) % 3 === 0 || y === span.max
        ? `<text class="obs-st-lab" x="${X(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">'${String(y).slice(2)}</text>`
        : '',
    )
    .join('');

  const legend =
    series.length > 1
      ? `<div class="obs-st-legend">${series
          .map(
            (s) =>
              `<span class="obs-st-key">${swatch(s)}${esc(s.term)} <b>${s.vals.reduce((a, b) => a + b, 0)}</b></span>`,
          )
          .join('')}</div>`
      : '';

  return `<div class="obs-st-wrap">
    <svg class="obs-st" viewBox="0 0 ${W} ${H}" role="img"
        aria-label="Matching sessions per year, ${span.min} to ${span.max}">
      <line class="obs-st-axis" x1="${padL}" y1="${padT + ph}" x2="${W - padR}" y2="${padT + ph}"/>
      <text class="obs-st-lab" x="${padL - 6}" y="${padT + 4}" text-anchor="end">${max}</text>
      <text class="obs-st-lab" x="${padL - 6}" y="${padT + ph}" text-anchor="end">0</text>
      <g class="obs-rise" style="--rise-base:${(padT + ph).toFixed(1)}px">${lines}</g>
      ${xlab}
    </svg>
    ${legend}
  </div>`;
}

// ── Session search ─────────────────────────────────────────────────────────
// /archive/sessions/<query> — every session whose title, description or
// speaker matches, newest first, each expandable to its description. The same
// reading pattern as a speaker page, applied to a search instead of a person.

/** How many more results "Show more" asks for. Matches the server's page size. */
const SESS_PAGE = 200;

/**
 * How a search term matches: `contains` (substring, the original rule) or
 * `exact` (whole words only). It lives in the URL as `?match=exact`, not just in
 * this variable, so a search you share or refresh keeps the reading you meant —
 * "ai" as the subject is a different question from "ai" inside "maintain".
 */
let _sessMode = 'exact';

/**
 * Where each term matched in a piece of text, as [start, end) ranges.
 *
 * Ranges rather than a replaced string, because the text still has to be escaped
 * — building HTML first and searching it second would let a description
 * containing `&amp;` shift every offset, and a term like `<` match markup that
 * escaping had just introduced.
 *
 * `exact` mirrors the server's rule (lib/archiveSessions.js): word boundaries,
 * and a phrase may be separated by any run of punctuation, so "display suite"
 * marks "Display-Suite" too.
 *
 * @param {string} text
 * @param {string[]} terms lowercased
 * @param {'contains'|'exact'} mode
 * @returns {Array<[number, number]>} merged, in document order
 */
export function matchRanges(text, terms, mode = 'contains') {
  const hay = String(text || '');
  const found = [];
  for (const raw of terms || []) {
    const term = String(raw || '').trim();
    if (!term) continue;
    if (mode === 'exact') {
      const words = term
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean)
        .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      if (!words.length) continue;
      const re = new RegExp(
        `(^|[^\\p{L}\\p{N}])(${words.join('[^\\p{L}\\p{N}]+')})(?![\\p{L}\\p{N}])`,
        'giu',
      );
      for (const m of hay.matchAll(re)) {
        const start = (m.index || 0) + m[1].length;
        found.push([start, start + m[2].length]);
      }
    } else {
      const low = hay.toLowerCase();
      const needle = term.toLowerCase();
      let i = low.indexOf(needle);
      while (i !== -1) {
        found.push([i, i + needle.length]);
        i = low.indexOf(needle, i + needle.length);
      }
    }
  }
  // Overlaps happen the moment two terms share a prefix ("ai, ai tools"), and two
  // <mark>s over the same characters would nest and double-shade them.
  found.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const r of found) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  return merged;
}

/** Escaped text with every match wrapped in a <mark>. */
export function highlightHtml(text, terms, mode = 'contains') {
  const hay = String(text || '');
  const ranges = matchRanges(hay, terms, mode);
  if (!ranges.length) return esc(hay);
  let out = '';
  let at = 0;
  for (const [s, e] of ranges) {
    out += esc(hay.slice(at, s)) + `<mark class="obs-hl">${esc(hay.slice(s, e))}</mark>`;
    at = e;
  }
  return out + esc(hay.slice(at));
}

/**
 * A short excerpt around the first match — the answer to "why is this here?".
 *
 * A row shows title, event, speakers and location, so a match inside the
 * description is invisible: "Wrap Up Ceremony" came back for `ai` because its
 * description says "join our mailing list", and nothing on the row said so.
 *
 * @returns {string} escaped HTML with the match marked, or '' when nothing matched
 */
export function matchSnippet(text, terms, mode = 'contains', pad = 44) {
  const hay = String(text || '');
  const ranges = matchRanges(hay, terms, mode);
  if (!ranges.length) return '';
  const [s, e] = ranges[0];
  const from = Math.max(0, s - pad);
  const to = Math.min(hay.length, e + pad);
  // Don't cut mid-word at either end.
  const head = from > 0 ? hay.slice(from, s).replace(/^\S*\s/, '') : hay.slice(from, s);
  const tail = to < hay.length ? hay.slice(e, to).replace(/\s\S*$/, '') : hay.slice(e, to);
  return `${from > 0 ? '…' : ''}${esc(head)}<mark class="obs-hl">${esc(hay.slice(s, e))}</mark>${esc(tail)}${to < hay.length ? '…' : ''}`;
}

/**
 * The address of one keyword in one year: /archive/topic/<term>/<year>.
 *
 * Two segments after the kind, where every other drill has one — a topic drill is
 * genuinely a pair (the keyword alone is the chart, not a page), so the route
 * carries both rather than pretending the year is part of the term.
 */
export function topicPath(term, year) {
  return `/archive/topic/${slugify(String(term))}/${encodeURIComponent(String(year))}`;
}

/**
 * Recover the keyword a slug came from.
 *
 * Slugs are lossy ("layout builder" and "layout-builder" slugify alike), so the
 * terms the archive actually knows are consulted first and the de-slugged text is
 * only the fallback — which is right for a custom keyword that was typed once,
 * shared, and never pinned.
 *
 * @param {string} slug
 * @param {readonly string[]} known
 */
export function termFromSlug(slug, known = []) {
  const want = slugify(String(slug || ''));
  const hit = (known || []).find((t) => slugify(String(t)) === want);
  return (
    hit ||
    String(slug || '')
      .replace(/-+/g, ' ')
      .trim()
  );
}

/**
 * "Shared a stage with" — the collaborators a person's sessions reveal.
 *
 * Fetched after the page renders rather than blocking it: the answer needs a pass
 * over the datasets, and a person page is worth reading before it arrives.
 * Absent for the ~73% of sessions with a single speaker, in which case the
 * section removes itself rather than announcing an empty result.
 */
async function hydrateCoSpeakers(name) {
  const slot = $('obsCoSpk');
  if (!slot || slot.dataset.cospk !== name) return;
  const q = new URLSearchParams({ name, series: _series, region: _region, country: _country });
  let data = null;
  try {
    const res = await fetch(`/api/archive/cospeakers?${q}`);
    data = res.ok ? await res.json() : null;
  } catch {
    data = null;
  }
  // The page may have moved on while this was in flight.
  if (!slot.isConnected || slot.dataset.cospk !== name) return;
  if (!data?.partners?.length) return slot.remove();
  const top = data.partners.slice(0, 24);
  slot.innerHTML = `
    ${sectionHeading('Shared a stage with', `${plural(data.sessions, 'joint session')} · ${plural(data.partners.length, 'person', 'people')}`)}
    <div class="obs-panel obs-cospk">${top
      .map(
        (p) =>
          `<button type="button" class="obs-cospk-chip" data-drill="person" data-key="${esc(p.name)}" title="${esc(p.sessions.map((x) => `${x.year} ${x.event}: ${x.title}`).join('\n'))}">
             ${esc(p.name)}<span class="obs-cospk-n">${p.count}</span>
           </button>`,
      )
      .join('')}${
      data.partners.length > top.length
        ? `<span class="obs-rank-count">+${data.partners.length - top.length} more</span>`
        : ''
    }</div>`;
}

/** The address of one year's first-time speakers. */
function debutPath(year) {
  return `/archive/debuts/${encodeURIComponent(String(year))}`;
}

/**
 * Everyone whose first appearance in the archive was this year.
 *
 * The chart says how many; this says WHO, which is the half that makes it a
 * community story rather than a statistic. Scoped like everything else, so under
 * a DrupalSouth filter it lists people new to DrupalSouth.
 */
export async function openDebutDrill(year) {
  const y = Number(year);
  destroyMap();
  destroyStripMap();
  // "Speakers", not "People": this drill is first-time SPEAKERS. The person-page
  // crumb stays "People" on purpose — that page covers speakers, organisers and
  // volunteers under one identity.
  setCrumbs([{ label: 'Speakers' }, { label: `First-timers of ${y}` }]);
  const v = _view || computeView();
  const debuts = [];
  for (const s of v.speakers || []) {
    const evs = (s.detail || []).filter((e) => inScope(e) && Number(e.year));
    if (!evs.length) continue;
    const first = Math.min(...evs.map((e) => Number(e.year)));
    if (first !== y) continue;
    const here = evs.filter((e) => Number(e.year) === y);
    debuts.push({
      name: s.name,
      talks: here.reduce((n, e) => n + (e.n || e.talks?.length || 1), 0),
      events: [...new Set(here.map((e) => e.label))],
      later: evs.some((e) => Number(e.year) > y),
    });
  }
  debuts.sort((a, b) => b.talks - a.talks || a.name.localeCompare(b.name));
  const stayed = debuts.filter((d) => d.later).length;
  const back = `<button type="button" class="obs-back" data-back="1">← Back to overview</button>`;
  const rows = debuts
    .map(
      (d) =>
        `<div class="obs-ev obs-clickable" data-drill="person" data-key="${esc(d.name)}">
           <span class="obs-ev-y">${d.talks}</span>
           <div class="obs-ev-main"><span class="obs-ev-t">${esc(d.name)}</span>
           <span class="obs-ev-s">${esc(d.events.join('  ·  '))}${d.later ? '' : ' · did not return'}</span></div>
         </div>`,
    )
    .join('');
  $('obsBody').innerHTML = `${back}
    <div class="obs-drill-head">
      <span class="obs-eyebrow">People · ${y}</span>
      <h2 class="obs-drill-name">First-timers of ${y}</h2>
      <p class="obs-sub">${plural(debuts.length, 'person', 'people')} on the programme for the first time${
        debuts.length ? ` · ${stayed} came back in a later year` : ''
      } <span class="obs-section-note">first appearance in this archive</span></p>
    </div>
    <div class="obs-evlist">${rows || '<p class="obs-drill-note">Nobody debuted in this scope.</p>'}</div>`;
  toTopOfView();
}

/** The addressable form of a session search. */
export function sessionPath(query, mode) {
  const q = encodeURIComponent(String(query || ''));
  // Only the NON-default reading needs saying. Whole words is the default, so a
  // plain /archive/sessions/<q> means whole words and always will.
  return `/archive/sessions/${q}${mode === 'contains' ? '?match=contains' : ''}`;
}

/**
 * The result rows for one page of a session search.
 *
 * `start` is the offset of this page in the whole result set, because the ids
 * here (`obsSessDetail-<n>`) must stay unique as later pages are APPENDED to the
 * list — restarting at 0 each page would give two rows the same id and the
 * expander would open the wrong description.
 */
function sessionRowsHtml(results, terms = [], start = 0, mode = 'contains') {
  return (results || [])
    .map((s, n) => {
      const i = start + n;
      // Only when the row's own text does not already show why it matched: a hit
      // in the title is self-evident and a second copy of it is noise.
      const visible = `${s.title || ''} ${s.speakers || ''} ${s.event || ''}`;
      const why = matchRanges(visible, terms, mode).length
        ? ''
        : matchSnippet(s.description, terms, mode);
      return `
      <div class="obs-ev obs-ev--exp" data-sessexp="${i}" role="button" tabindex="0">
        <span class="obs-ev-y">${s.year || '—'}</span>
        <div class="obs-ev-main">
          <span class="obs-ev-t">${highlightHtml(s.title, terms, mode)}</span>
          <span class="obs-ev-s">${esc([s.event, s.speakers, s.location].filter(Boolean).join('  ·  '))}</span>
          ${why ? `<span class="obs-ev-why">${why}</span>` : ''}
          ${
            (terms || []).length > 1 && s.matched?.length
              ? `<span class="obs-ev-match">${s.matched
                  .map((t) => {
                    // Same colour, same index, as the line for that term in the
                    // trend chart above — so "which of my words did this match"
                    // is answered by looking, not by reading.
                    const ti = (terms || []).indexOf(t);
                    const col = slotStyle(ti).color;
                    return `<span class="obs-ev-term" style="--term: ${col}">${esc(t)}</span>`;
                  })
                  .join('')}</span>`
              : ''
          }
        </div>
        <span class="obs-ev-caret" aria-hidden="true">▾</span>
      </div>
      <div class="obs-ev-detail" id="obsSessDetail-${i}" hidden>
        ${s.description ? `<p class="obs-sess-desc">${highlightHtml(s.description, terms, mode)}</p>` : '<p class="obs-talk-none">No description recorded.</p>'}
        <p class="obs-sess-links">
          ${s.link ? `<a href="${esc(s.link)}" target="_blank" rel="noopener noreferrer">Session page ↗</a>` : ''}
          ${s.video ? `<a href="${esc(s.video)}" target="_blank" rel="noopener noreferrer">Recording ↗</a>` : ''}
          <a href="./index.html?q=${encodeURIComponent(s.file.replace(/^events\//, '').replace(/\.json$/, ''))}">Open the schedule ↗</a>
        </p>
      </div>`;
    })
    .join('');
}

/** The "showing the newest N" line and the Show-more button both count the same. */
export function sessionCountLine(total, shown) {
  const n = `${total} session${total === 1 ? '' : 's'} across the archive`;
  return total > shown ? `${n} · showing the newest ${shown}` : n;
}

/**
 * The Show-more footer, or nothing once the whole result set is on the page.
 * Naming the remainder is the point: "2,624 more" is what tells you the tallies
 * in the breakdown are counting something you have not scrolled past yet.
 */
function moreButtonHtml(total, shown) {
  const left = Math.max(0, total - shown);
  if (!left) return '';
  return `<div class="obs-sess-more"><button type="button" class="app-btn" data-sess-more>
      Show ${Math.min(SESS_PAGE, left)} more
    </button><span class="obs-rank-count">${num(left)} not shown</span></div>`;
}

export async function showSessionSearch(query, mode) {
  const body = $('obsBody');
  if (!body) return false;
  // A caller restoring a history entry knows which reading that entry was.
  if (mode === 'exact' || mode === 'contains') _sessMode = mode;
  destroyMap();
  destroyStripMap();
  const q = String(query || '').trim();
  setCrumbs([{ label: 'Sessions' }, { label: `“${q}”` }]);
  body.innerHTML = `
    <button type="button" class="obs-back" data-back="1">← Back to overview</button>
    <div class="obs-drill-head">
      <span class="obs-eyebrow">Sessions</span>
      <h2 class="obs-drill-name">“${esc(q)}”</h2>
      <p class="obs-sub">Searching the whole archive…</p>
    </div>`;
  // Before the fetch, not after: the reader should watch "Searching…" from the
  // top of the page rather than be moved once the results land under them.
  toTopOfView();

  // The same facets as the dashboard, applied server-side. Reading them from the
  // module's own scope means a search inherits whatever the overview was showing.
  const params = new URLSearchParams({ q });
  params.set('mode', _sessMode);
  if (_series !== 'All') params.set('series', _series);
  if (_region !== 'All') params.set('region', _region);
  if (_country !== 'All') params.set('country', _country);
  if (_year !== 'All') params.set('year', String(_year));

  let data;
  try {
    const r = await fetch(new URL(`../../api/archive/sessions?${params}`, import.meta.url));
    data = r.ok ? await r.json() : null;
  } catch {
    data = null;
  }
  if (!data) {
    body.querySelector('.obs-sub').textContent = 'Could not reach the archive search.';
    return true;
  }

  const rows = sessionRowsHtml(data.results, data.terms, 0, data.mode || _sessMode);

  body.innerHTML = `
    <button type="button" class="obs-back" data-back="1">← Back to overview</button>
    <div class="obs-drill-head">
      <span class="obs-eyebrow">Sessions</span>
      <h2 class="obs-drill-name">${(data.terms || [q]).map((t) => `“${esc(t)}”`).join(' or ')}</h2>
      <p class="obs-sub" data-sess-count>${sessionCountLine(data.total, data.results.length)}</p>
      ${sessionTrendSvg(data.byTerm, data.terms)}
      <div class="obs-scopes" data-sess-scopes>
        <div class="obs-scope"><label class="obs-scope-l" for="obsSeries">Series</label>
          <select id="obsSeries" class="obs-series-filter">${seriesOptions()}</select></div>
        <div class="obs-scope"><label class="obs-scope-l" for="obsRegion">Region</label>
          <select id="obsRegion" class="obs-series-filter">${[
            `<option value="All"${_region === 'All' ? ' selected' : ''}>All regions</option>`,
            ...(_data.facetRegions || []).map(
              (r) =>
                `<option value="${esc(r)}"${r === _region ? ' selected' : ''}>${esc(regionLabel(r))}</option>`,
            ),
          ].join('')}</select></div>
        <div class="obs-scope"><label class="obs-scope-l" for="obsCountry">Country</label>
          <select id="obsCountry" class="obs-series-filter">${facetOptions(_data.facetCountries, _country, 'All countries')}</select></div>
        <div class="obs-scope"><label class="obs-scope-l" for="obsYear">Year</label>
          <select id="obsYear" class="obs-series-filter">${facetOptions(yearsDescList(), _year, 'All years')}</select></div>
      </div>
      <form class="obs-sess-form" data-sess-form>
        <label class="u-visually-hidden" for="obsSessQ">Search sessions</label>
        <input id="obsSessQ" class="app-control obs-sess-input" value="${esc(q)}"
               placeholder="Search every session — commas for either/or" autocomplete="off">
        <button type="submit" class="app-btn">Search</button>
        <button type="button" class="app-btn" data-breakdown>Breakdown</button>
        <span class="obs-sess-mode" role="group" aria-label="How terms match">
          <button type="button" class="obs-sess-mode__btn${_sessMode === 'contains' ? ' is-on' : ''}"
                  data-sess-mode="contains" aria-pressed="${_sessMode === 'contains'}">Contains</button>
          <button type="button" class="obs-sess-mode__btn${_sessMode === 'exact' ? ' is-on' : ''}"
                  data-sess-mode="exact" aria-pressed="${_sessMode === 'exact'}">Whole words</button>
        </span>
      </form>
    </div>
    <div data-sess-results>
      <div class="obs-evs" data-sess-list>${rows || '<p class="obs-drill-note">Nothing matched.</p>'}</div>
      ${moreButtonHtml(data.total, data.results.length)}
    </div>`;

  armRise(body);

  // `shown` is how many of `total` made it onto the page: the breakdown counts
  // every match, so it needs to be able to say where the two diverge.
  _lastSearch = {
    query: q,
    terms: data.terms,
    total: data.total,
    shown: data.results.length,
    breakdown: data.breakdown,
  };
  document.dispatchEvent(new CustomEvent('archive:search', { detail: _lastSearch }));

  body.querySelector('[data-sess-scopes]')?.addEventListener('change', (e) => {
    const id = e.target.id;
    if (id === 'obsSeries') _series = e.target.value;
    else if (id === 'obsRegion') _region = e.target.value;
    else if (id === 'obsCountry') _country = e.target.value;
    else if (id === 'obsYear') _year = e.target.value;
    else return;
    e.stopPropagation(); // the dashboard's change handler would re-render the overview
    _scopeTopics = null;
    _view = null;
    showSessionSearch(q);
  });

  // Show more: APPEND the next page rather than re-render, so the rows you have
  // already scrolled past, and any description you left open, stay where they are.
  // The listener goes on the results wrapper, which this render just created — on
  // `body`, which outlives every render, each new search would add another.
  let shown = data.results.length;
  body.querySelector('[data-sess-results]')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-sess-more]');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    btn.textContent = 'Loading…';
    const page = new URLSearchParams(params);
    page.set('offset', String(shown));
    page.set('limit', String(SESS_PAGE));
    let next = null;
    try {
      const r = await fetch(new URL(`../../api/archive/sessions?${page}`, import.meta.url));
      next = r.ok ? await r.json() : null;
    } catch {
      next = null;
    }
    if (!next?.results?.length) {
      // Say so on the button itself: a control that silently does nothing reads
      // as a broken page rather than as a failed request.
      btn.textContent = next ? 'No more to show' : 'Could not load more — try again';
      btn.disabled = !!next;
      return;
    }
    const wrap = btn.closest('[data-sess-results]');
    wrap
      ?.querySelector('[data-sess-list]')
      ?.insertAdjacentHTML(
        'beforeend',
        sessionRowsHtml(next.results, data.terms, shown, data.mode || _sessMode),
      );
    shown += next.results.length;
    const count = body.querySelector('[data-sess-count]');
    if (count) count.textContent = sessionCountLine(data.total, shown);
    // The breakdown rail reads this to caveat its own tallies.
    if (_lastSearch) _lastSearch.shown = shown;
    btn.closest('.obs-sess-more')?.remove();
    wrap?.insertAdjacentHTML('beforeend', moreButtonHtml(data.total, shown));
  });

  body.querySelector('[data-sess-form]')?.addEventListener('click', (e) => {
    const pick = e.target.closest('[data-sess-mode]');
    if (!pick || pick.dataset.sessMode === _sessMode) return;
    _sessMode = pick.dataset.sessMode === 'exact' ? 'exact' : 'contains';
    // The same query read a different way is a different result set, so it gets
    // its own history entry rather than silently rewriting the one you are on.
    showSessionSearch(q);
    if (typeof history !== 'undefined')
      history.pushState({ sessions: q, match: _sessMode }, '', sessionPath(q, _sessMode));
  });

  body.querySelector('[data-sess-form]')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const next = body.querySelector('#obsSessQ').value.trim();
    if (!next || next === q) return;
    showSessionSearch(next);
    if (typeof history !== 'undefined') {
      history.pushState({ sessions: next, match: _sessMode }, '', sessionPath(next, _sessMode));
    }
  });
  return true;
}

export function openDrillFromPath(pathname = location.pathname) {
  // The view modes are addresses too: /archive/videos is a place you can link to,
  // reload, and come Back to. They carry no slug — the query rides in ?q= — so
  // they are matched before the drill pattern, which requires one.
  if (/\/archive\/?$/i.test(String(pathname))) {
    // Back from a view mode returns here. Without this the address said /archive
    // while the videos were still on screen.
    if (_homeTab === 'overview') return false; // already right; let the caller be
    _homeTab = 'overview';
    _videoQ = '';
    _videoOffset = 0;
    renderHome();
    return true;
  }
  const tab = String(pathname).match(/\/archive\/(videos|albums)\/?$/i);
  if (tab) {
    if (!_data) return false; // the payload feeds both views; the caller retries
    const raw = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
    _videoQ = raw.get('q') || '';
    _videoOffset = 0;
    _homeTab = tab[1].toLowerCase();
    renderHome();
    return true;
  }
  const m = String(pathname).match(/\/archive\/([a-z]+)\/(.+)$/i);
  if (!m) return false;
  const [, type, slug] = m;
  // Sessions is a query, not a record — the segment is the search text.
  if (type === 'sessions') {
    // Rendering the search reads the loaded insights (the facet lists, the series
    // options), so it CANNOT run before they arrive. This branch used to report
    // success regardless: on a refresh it ran against a null payload, threw
    // mid-render, and the caller's observer — already disconnected because we
    // said "routed" — never tried again. The dashboard then finished loading and
    // painted the overview over it, leaving the archive home page under a
    // /archive/sessions/… URL. Same contract as showDrill now: not yet.
    if (!_data) return false;
    const raw = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
    _sessMode = raw.get('match') === 'contains' ? 'contains' : 'exact';
    showSessionSearch(decodeURIComponent(slug).replace(/\+/g, ' '));
    return true;
  }
  if (type === 'debuts') {
    if (!_data) return false;
    const y = Number(decodeURIComponent(slug));
    if (!Number.isFinite(y)) return false;
    openDebutDrill(y);
    return true;
  }
  // A topic is the one drill addressed by a PAIR — /archive/topic/<term>/<year>.
  if (type === 'topic') {
    if (!_data) return false; // the term list is not loaded yet; the caller retries
    const parts = decodeURIComponent(slug).split('/').filter(Boolean);
    const year = Number(parts.pop());
    if (!parts.length || !Number.isFinite(year)) return false;
    const known = [...currentTopics().map((t) => t.term), ...(_topicSel || []), ..._pinned];
    openTopicDrill(termFromSlug(parts.join('/'), known), year);
    return true;
  }
  if (!DRILL_KINDS[type]) return false;
  const key = keyForSlug(type, decodeURIComponent(slug));
  if (!key) return false;
  const shown = showDrill(type, key);
  // A profile slug, or a spelling that curation has since mapped, is an ALIAS of
  // the canonical page — not a second page. `keyForSlug` already resolves it, but
  // the address bar kept the alias, so copying the link or reloading spread the
  // old name around. Settle on the canonical URL. replaceState, not pushState: the
  // alias is not somewhere the reader chose to be, so Back must not return to it.
  if (shown && typeof history !== 'undefined') {
    const canonical = drillPath(type, key);
    if (canonical !== decodeURIComponent(location.pathname))
      history.replaceState({ drill: DRILL_KINDS[type] || type, key }, '', canonical);
  }
  return shown;
}

function drillHtml(type, key) {
  const back = `<button type="button" class="obs-back" data-back="1">← Back to overview</button>`;
  if (type === 'person') {
    // One page per PERSON, keyed on the canonical name. A speaker record and any
    // organiser/volunteer credits under that same name are the same human — so
    // they are merged here rather than living at two URLs that never meet.
    // `canon()` on the server is what makes the names converge, which is why a
    // curation merge instantly unifies the two halves.
    const spk = (_data?.speakers || []).find((r) => r.name === key) || null;
    const creditRows = (_data?.credits?.people || []).filter((r) => r.name === key);
    if (!spk && !creditRows.length)
      return back + '<p class="obs-drill-note">No detail available.</p>';

    // One entry per CONTRIBUTION, not per event. Speaking at DrupalCon and
    // volunteering at the same DrupalCon are two separate things a person did;
    // collapsing them into one row hid the second and made the counts in the
    // summary line disagree with the list beneath it.
    const entries = [];
    for (const e of spk?.detail || [])
      entries.push({ ...e, kind: 'speaking', talks: e.talks || [] });
    for (const r of creditRows)
      for (const e of r.detail || []) entries.push({ ...e, kind: r.role, talks: [] });
    // Chronological, then grouped by event: sorting on kind alone split the two
    // things you did at one conference across the year, with other events
    // between them. Event label ties the pair together; kind orders within it.
    entries.sort(
      (a, b) =>
        (b.year || 0) - (a.year || 0) ||
        String(a.label).localeCompare(String(b.label)) ||
        String(a.kind).localeCompare(String(b.kind)),
    );
    const detail = entries;
    _drillDetail = detail;
    const years = [...new Set(detail.map((e) => e.year).filter(Boolean))].sort((a, b) => a - b);

    const bits = [];
    if (spk) bits.push(`${plural(spk.appearances, 'talk')} across ${plural(spk.events, 'event')}`);
    for (const r of creditRows) bits.push(`${plural(r.detail?.length || 0, 'event')} as ${r.role}`);
    const slugs = [...new Set(creditRows.map((r) => r.username))];

    _mapPts = geocoded(detail).map((e) => ({
      lat: e.lat,
      lon: e.lon,
      label: e.label,
      year: e.year,
    }));
    return `${back}
      <div class="obs-drill-head">
        <span class="obs-eyebrow">Person</span>
        <h2 class="obs-drill-name">${esc(key)}</h2>
        <p class="obs-sub">${esc(bits.join(' · '))}${years.length ? ` · ${years[0]}${years.length > 1 ? `–${years[years.length - 1]}` : ''}` : ''}${
          slugs.length
            ? ` <span class="obs-section-note">${esc(slugs.map((u) => `/u/${u}`).join(' '))}</span>`
            : ''
        }</p>
        ${years.length ? `<div style="margin-top:0.8rem">${timeline(years)}</div>` : ''}
      </div>
      <div id="obsCoSpk" data-cospk="${esc(key)}"></div>
      ${mapIdentityBlock('person', key, slugs[0] || key)}
      ${mapBlock(_mapPts, detail)}
      <div class="obs-evlist">${detail
        .map((e, i) => {
          const KIND = { speaking: 'Speaker', organiser: 'Organiser', volunteer: 'Volunteer' };
          const label = KIND[e.kind] || e.kind;
          const talks = (e.talks || []).map((t) => `“${t}”`).join('  ·  ');
          const sub = [label, talks].filter(Boolean).join(' — ');
          return (e.talks || []).length
            ? `<div class="obs-ev obs-ev--exp" data-talkexp="${i}" role="button" tabindex="0">
                 <span class="obs-ev-y">${e.year || '—'}</span>
                 <div class="obs-ev-main"><span class="obs-ev-t">${esc(e.label)}</span><span class="obs-ev-s">${esc(sub)}</span></div>
                 <span class="obs-ev-caret" aria-hidden="true">▾</span>
               </div><div class="obs-ev-detail" id="obsEvDetail-${i}" hidden></div>`
            : eventRow(e.year, e.label, sub);
        })
        .join('')}</div>`;
  }
  if (type === 'speaker' || type === 'sponsor') {
    const list = type === 'speaker' ? _data.speakers : _data.sponsors;
    const nameKey = type === 'speaker' ? 'name' : 'title';
    const rec = (list || []).find((r) => r[nameKey] === key);
    if (!rec) return back + '<p class="obs-drill-note">No detail available.</p>';
    const detail = [...(rec.detail || [])].sort((a, b) => (b.year || 0) - (a.year || 0));
    const sub =
      type === 'speaker'
        ? `${rec.appearances} talks across ${rec.events} events`
        : `Sponsored ${rec.events} events${rec.tiers?.length ? ` · ${rec.tiers.join(', ')}` : ''}`;
    _drillDetail = detail;
    const rows = detail
      .map((e, i) =>
        type === 'speaker'
          ? `<div class="obs-ev obs-ev--exp" data-talkexp="${i}" role="button" tabindex="0">
               <span class="obs-ev-y">${e.year || '—'}</span>
               <div class="obs-ev-main"><span class="obs-ev-t">${esc(e.label)}</span><span class="obs-ev-s">${esc((e.talks || []).map((t) => `“${t}”`).join('  ·  '))}</span></div>
               <span class="obs-ev-caret" aria-hidden="true">▾</span>
             </div><div class="obs-ev-detail" id="obsEvDetail-${i}" hidden></div>`
          : eventRow(e.year, e.label, e.tier ? `${e.tier} sponsor` : ''),
      )
      .join('');
    _mapPts = geocoded(detail).map((e) => ({
      lat: e.lat,
      lon: e.lon,
      label: e.label,
      year: e.year,
    }));
    return `${back}
      <div class="obs-drill-head">
        <span class="obs-eyebrow">${type === 'speaker' ? 'Speaker journey' : 'Sponsor timeline'}</span>
        <h2 class="obs-drill-name">${esc(key)}</h2>
        <p class="obs-sub">${esc(sub)} · ${rec.years[0]}–${rec.years[rec.years.length - 1]}</p>
        <div style="margin-top:0.8rem">${timeline(rec.years)}</div>
      </div>
      ${mapIdentityBlock(type, key)}
      ${mapBlock(_mapPts, detail)}
      <div class="obs-evlist">${rows}</div>`;
  }
  if (type === 'year') {
    const evs = [...(_data.yearEvents?.[key] || [])].sort((a, b) => b.sessions - a.sessions);
    const rows = evs.map((e) => eventRow(key, e.label, `${e.sessions} sessions`)).join('');
    _mapPts = geocoded(evs).map((e) => ({ lat: e.lat, lon: e.lon, label: e.label, year: key }));
    return `${back}<div class="obs-drill-head"><span class="obs-eyebrow">Year</span><h2 class="obs-drill-name">${esc(key)}</h2><p class="obs-sub">${evs.length} event${evs.length === 1 ? '' : 's'}</p></div>${mapBlock(_mapPts, evs)}<div class="obs-evlist">${rows}</div>`;
  }
  if (type === 'series') {
    const evs = [...(_data.seriesEvents?.[key] || [])].sort(
      (a, b) => (b.year || 0) - (a.year || 0),
    );
    const rows = evs
      .map((e) => eventRow(e.year, e.location || e.label, `${e.sessions} sessions`))
      .join('');
    _mapPts = geocoded(evs).map((e) => ({
      lat: e.lat,
      lon: e.lon,
      label: e.location || e.label,
      year: e.year,
    }));
    return `${back}<div class="obs-drill-head"><span class="obs-eyebrow">Series</span><h2 class="obs-drill-name">${esc(key)}</h2><p class="obs-sub">${evs.length} event${evs.length === 1 ? '' : 's'} · ${evs.length ? evs[evs.length - 1].year + '–' + evs[0].year : ''}</p></div>${mapBlock(_mapPts, evs)}<div class="obs-evlist">${rows}</div>`;
  }
  _mapPts = [];
  return back;
}

// ── Topic trends (session-title keywords, plotted as lines over time) ─────────
// Categorical palette — identity, so hues are assigned in FIXED ORDER and never
// cycled (a cycled hue means two visible lines share a colour and the encoding
// lies). Emitted as CSS custom properties so light and dark are stepped
// separately rather than flipped; see section-archive.css.
//
// Validated with the dataviz validator against both our surfaces (#f4f5f0 /
// #131614): lightness band, chroma floor, adjacent CVD separation and the
// normal-vision floor all pass in both modes.
//
// Eleven slots is the cap — the point where the adjacent-pair CVD check still
// passes in both modes. Past it the colour genuinely cannot carry identity, so
// the twelfth series falls back to a neutral rather than pretending: two greys
// tell you they are both "other", where two near-identical hues would lie.
const TOPIC_COLORS = [
  'var(--viz-1)',
  'var(--viz-2)',
  'var(--viz-3)',
  'var(--viz-4)',
  'var(--viz-5)',
  'var(--viz-6)',
  'var(--viz-7)',
  'var(--viz-8)',
  'var(--viz-9)',
  'var(--viz-10)',
  'var(--viz-11)',
];
const TOPIC_OVERFLOW = 'var(--viz-overflow)';

/**
 * Laps around the palette, as stroke patterns.
 *
 * The eleven hues are a validated set — twelve failed CVD separation, which is why
 * there are eleven — so a twelfth KEYWORD cannot be given a twelfth hue without
 * breaking the thing the palette guarantees. Inventing hues past the ramp is the
 * standard way categorical colour goes wrong; the standard fix is a second
 * channel. Identity here is therefore hue + dash: eleven solid lines, then the
 * same eleven dashed, then dotted, then dash-dot.
 *
 * Forty-four distinguishable keywords before anything falls back to grey, and
 * every line still wears a colour that passed the checker.
 */
const TOPIC_DASHES = ['', '7 5', '2 5', '12 4 2 4'];

/**
 * The look of palette slot `i`: which hue, and which lap's dash.
 * A slot past the last lap is genuine overflow — grey, solid, no identity claimed.
 */
export function slotStyle(i) {
  const lap = Math.floor(i / TOPIC_COLORS.length);
  if (!(i >= 0) || lap >= TOPIC_DASHES.length) return { color: TOPIC_OVERFLOW, dash: '' };
  return { color: TOPIC_COLORS[i % TOPIC_COLORS.length], dash: TOPIC_DASHES[lap] };
}

/** `stroke-dasharray="…"` for a lap, or nothing at all on the solid first lap. */
function dashAttr(dash) {
  return dash ? ` stroke-dasharray="${dash}"` : '';
}

/**
 * A legend swatch that shows the LINE, not just the hue — a short rule in the
 * series' own colour and dash. A plain colour chip would have told two lines
 * sharing a hue apart by nothing at all, which is the failure the dashes exist to
 * prevent: identity is never colour alone.
 */
function swatch(style, on = true) {
  return `<svg class="obs-sw${on ? '' : ' is-off'}" viewBox="0 0 20 8" aria-hidden="true"><line x1="1" y1="4" x2="19" y2="4" stroke="${style.color}" stroke-width="2.5" stroke-linecap="round"${dashAttr(style.dash)}/></svg>`;
}

let _topicSel = null; // current series' shown terms (Set)
let _chartMode = 'topics'; // 'topics' (keyword lines) | 'sessions' (total sessions/yr)
let _colorMap = {}; // term → colour for the current render (no reuse among visible lines)
let _chartView = 'share'; // which view of the current subject — see VIEWS
/** Which community series are plotted. Persisted, like the keyword selection. */
const _communitySel = new Set(['attendees', 'speakers']);

/**
 * FOUR SUBJECTS. Six modes had accumulated and two did not earn their place:
 * "Attendance" was the Community chart with one series switched on, and "Lengths"
 * was a property of the programme whose most interesting view was about speakers.
 * Subjects sit on the left of the control bar; the views within them on the right.
 */
const MODES = [
  ['topics', 'Topics'],
  ['programme', 'Programme'],
  ['speakers', 'Speakers'],
  ['sponsors', 'Sponsors'],
  ['community', 'Community'],
];

/**
 * The views each subject offers — a flat list of complete answers rather than
 * "units" of one measure, because "Hours" is not a unit of "Sessions", and
 * pretending otherwise is what made the old right-hand group unreadable.
 */
const VIEWS = {
  topics: [
    ['share', 'Share&nbsp;%'],
    ['count', 'Count'],
  ],
  programme: [
    ['sessions', 'Sessions'],
    ['hours', 'Hours'],
    ['lengths', 'Lengths'],
    ['lengthShare', 'Length mix&nbsp;%'],
  ],
  speakers: [
    ['who', 'Who'],
    ['whoShare', 'Who&nbsp;%'],
    ['slots', 'Slot length'],
    ['brackets', 'Brackets'],
  ],
  community: [
    ['peak', '% of peak'],
    ['count', 'Count'],
  ],
  // Organisations, so their own subject rather than a fourth people-line. Three
  // questions: how many, at what level, and how many came back.
  sponsors: [
    ['count', 'Count'],
    ['tiers', 'Tiers'],
    ['loyalty', 'Loyalty'],
  ],
};

/** The view a subject opens on. */
const DEFAULT_VIEW = {
  topics: 'share',
  programme: 'sessions',
  speakers: 'who',
  sponsors: 'count',
  community: 'peak',
};
let _selBySeries = {}; // series → [terms] — remembered per scope, persisted
let _pinned = []; // owner's featured keywords — surfaced first + shown by default
let _plot = null; // last-rendered chart geometry, for hover/click hit-testing
const PREFS_KEY = 'obs.topicPrefs';

// Recompute the mined topic trends for the CURRENT facet scope (series + region +
// country — the year facet only highlights, so the timeline stays whole) from the
// compact per-session index the server ships. This is what lets the keyword lines
// filter geographically, not just by series. Memoised per scope key.
let _scopeTopics = null;
let _scopeKey = '';
function computeScopeTopics() {
  const key = `${_series}|${_region}|${_country}`;
  if (_scopeTopics && _scopeKey === key) return _scopeTopics;
  const vocab = _data.topicVocab;
  const rows = _data.topicSessions;
  if (!vocab || !rows) {
    // Fallback for an older payload: series-only, no geo filtering.
    const ranked = _data.topicsBySeries?.[_series] || _data.topics || [];
    _scopeTopics = {
      ranked,
      byTerm: new Map(ranked.map((t) => [t.term, t])),
      sessBy: _data.topicSessionsByYear?.[_series] || {},
    };
    _scopeKey = key;
    return _scopeTopics;
  }
  const terms = vocab.map((t) => ({ term: t, total: 0, byYear: {}, byYearD: {} }));
  const sessBy = {};
  // Sessions we can actually READ — the ones that brought a description. Kept
  // separately from sessBy because "share of the programme" has to be a share of
  // the part of the programme the archive can see: description coverage swings
  // from 35% (2013) to 100% (2018), so dividing every year by its full session
  // count turns a capture gap into a fall in interest.
  const readBy = {};
  for (const [year, s, r, c, k, d] of rows) {
    if (_series !== 'All' && s !== _series) continue;
    if (_region !== 'All' && r !== _region) continue;
    if (_country !== 'All' && c !== _country) continue;
    sessBy[year] = (sessBy[year] || 0) + 1;
    if (d) readBy[year] = (readBy[year] || 0) + 1;
    for (const i of k) {
      const rec = terms[i];
      rec.total++;
      rec.byYear[year] = (rec.byYear[year] || 0) + 1;
      if (d) rec.byYearD[year] = (rec.byYearD[year] || 0) + 1;
    }
  }
  const ranked = terms.filter((t) => t.total > 0).sort((a, b) => b.total - a.total);
  _scopeTopics = { ranked, byTerm: new Map(ranked.map((t) => [t.term, t])), sessBy, readBy };
  _scopeKey = key;
  return _scopeTopics;
}
function currentTopics() {
  return computeScopeTopics().ranked;
}
// Assign a palette slot to every term currently in play, in a stable order, so no
// two visible lines look alike until 44 of them are on the chart (see slotStyle).
//
// PLOTTED TERMS TAKE THEIR SLOTS FIRST. The mined top-16 are chips you have not
// asked to see; when they shared the queue, a legend full of suggestions could
// push the lines you actually selected off the end of the ramp — which is how a
// chart with six lines on it ended up drawing some of them in grey.
function buildColorMap() {
  const order = [];
  const push = (t) => t && !order.includes(t) && order.push(t);
  // Pinned-and-plotted first, so your own keywords keep the same colour session to
  // session; then the rest of what is on the chart; then a pinned term you have
  // switched off; then the suggestions.
  _pinned.filter((t) => _topicSel?.has(t)).forEach(push);
  for (const t of _topicSel || []) push(t);
  _pinned.forEach(push);
  currentTopics()
    .slice(0, 16)
    .forEach((t) => push(t.term));
  _colorMap = {};
  order.forEach((t, i) => (_colorMap[t] = i));
}
/** The full look of a term's line: hue for identity, dash for which lap it is on. */
function topicStyle(term) {
  return slotStyle(_colorMap[term] ?? -1);
}
function topicColor(term) {
  return topicStyle(term).color;
}
// Custom keyword/phrase results (title + description search), cached per full scope.
const _topicCache = {};
function cacheKey(term) {
  return `${_series}|${_region}|${_country}::${term}`;
}
async function fetchTopic(term) {
  const key = cacheKey(term);
  if (_topicCache[key]) return _topicCache[key];
  let data = { term, byYear: {}, sessions: [] };
  try {
    const q = `term=${encodeURIComponent(term)}&series=${encodeURIComponent(_series)}&region=${encodeURIComponent(_region)}&country=${encodeURIComponent(_country)}`;
    const res = await fetch(`/api/archive/topic?${q}`);
    if (res.ok) data = await res.json();
  } catch {
    /* offline — leave empty */
  }
  _topicCache[key] = data;
  return data;
}
// A plottable {term, byYear} — from the scoped mined set if known, else the fetched
// custom result (empty until fetchTopic resolves; renderTopics kicks that off).
function topicObj(term) {
  const mined = computeScopeTopics().byTerm.get(term);
  if (mined) return mined;
  const custom = _topicCache[cacheKey(term)];
  // The endpoint names it byYearDescribed; the mined index names it byYearD. One
  // shape from here on, so the share maths does not have to know which it got.
  return custom
    ? { term, byYear: custom.byYear || {}, byYearD: custom.byYearDescribed || {} }
    : { term, byYear: {}, byYearD: {} };
}
function ensureTopicSel() {
  if (_topicSel) return;
  const saved = _selBySeries[_series];
  // Precedence: this series' remembered selection → your pinned defaults → the
  // frequency top-6. So pinned keywords are what you see by default everywhere.
  const base =
    saved && saved.length
      ? saved
      : _pinned.length
        ? _pinned
        : currentTopics()
            .slice(0, 6)
            .map((t) => t.term);
  _topicSel = new Set(base);
}
function saveTopicSel() {
  if (_topicSel) _selBySeries[_series] = [..._topicSel];
  persistPrefs();
}
function persistPrefs() {
  try {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({
        view: _chartView,
        mode: _chartMode,
        series: _series,
        sel: _selBySeries,
        pinned: _pinned,
        community: [..._communitySel],
      }),
    );
  } catch {
    /* storage unavailable — non-fatal */
  }
}
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    // Validated against the mode table rather than a hardcoded pair: these tests
    // were written when there were two modes and two units, so every view added
    // since — People, Lengths, Attendance, Community, and the units they brought —
    // silently failed to survive a reload.
    // 'people' was renamed to 'speakers' — that subject only ever measured
    // speakers, and Community is where "people" means everyone. Migrate rather
    // than drop, so a saved view is not silently thrown away.
    const mode = p.mode === 'people' ? 'speakers' : p.mode;
    if (MODES.some(([m]) => m === mode)) _chartMode = mode;
    // The view must belong to the mode we just restored. Validating it and
    // otherwise leaving `_chartView` alone kept the *initial* 'share' under a
    // restored mode that never offers it — every unit button unlit and the chart
    // silently drawing counts, the same drift the click handler already guards.
    _chartView = VIEWS[_chartMode]?.some(([k]) => k === p.view)
      ? p.view
      : DEFAULT_VIEW[_chartMode] || 'count';
    if (Array.isArray(p.community)) {
      // Filtered against the current series list: a stored key for a series that
      // has since been removed ("sponsors") would otherwise sit in the set for
      // ever, invisible and unclearable.
      const known = new Set(['attendees', 'speakers', 'organisers', 'volunteers']);
      const kept = p.community.filter((k) => known.has(k));
      if (kept.length) {
        _communitySel.clear();
        for (const k of kept) _communitySel.add(k);
      }
    }
    if (p.sel && typeof p.sel === 'object') _selBySeries = p.sel;
    if (Array.isArray(p.pinned)) _pinned = p.pinned;
    if (typeof p.series === 'string') _series = p.series; // validated against topicSeries on load
  } catch {
    /* ignore malformed prefs */
  }
}

// Total sessions per year in the *current facet scope* (series + region + country),
// ignoring the year facet so the whole timeline still plots.
function sessionsByYearScoped() {
  const by = {};
  for (const e of flatEvents())
    if (inScope(e, true)) by[e.year] = (by[e.year] || 0) + (e.sessions || 0);
  return by;
}

/**
 * Per year: how many people were speaking for the FIRST time, and how many had
 * spoken before.
 *
 * "First" means first in the archive AND within the current scope — filter to
 * DrupalSouth and it answers "new to DrupalSouth". That is what every other facet
 * does, and the alternative (archive-wide firsts shown under a filter) would
 * report debuts for years the filtered series did not even run.
 *
 * Two things this number is NOT, both of which the chart has to say out loud:
 *   - not "new to Drupal" — the archive is missing DrupalJam 2010–2019 and most
 *     camps, so a first captured talk may be someone's fifth;
 *   - not immune to spelling — every name variant reads as a new person, which is
 *     why the curation merges land before this ships (49 of 2025's 316 "debuts"
 *     were a spelling already seen).
 *
 * @param {Array<{detail?: Array<{year?: number}>}>} speakers
 * @param {(e: any) => boolean} [inScopeFn]
 * @returns {{byYear: Record<number, {first: number, returning: number}>, firsts: Record<number, number>}}
 */
/** A speaker's years, in scope, in order — the basis of "was this their first?". */
function yearsOf(s, inScopeFn) {
  return [
    ...new Set(
      (s?.detail || [])
        .filter((e) => inScopeFn(e))
        .map((e) => Number(e.year))
        .filter(Boolean),
    ),
  ].sort((a, b) => a - b);
}

/**
 * How long a slot each group gets: average session minutes per year, for speakers
 * in their first year vs speakers who had spoken before.
 *
 * Averaged over APPEARANCES, not people — a speaker with three sessions that year
 * contributes three slots, because the question is about slots. The two lines are
 * an average and not a part of a whole, which is why this view is drawn as lines
 * rather than as the stacked bars the counts use.
 *
 * @param {Array<{detail?: Array<any>}>} speakers
 * @param {(e: any) => boolean} [inScopeFn]
 * @returns {Record<number, {first: number, returning: number}>} average minutes
 */
export function slotLengthByStatus(speakers, inScopeFn = () => true) {
  /** @type {Record<number, {first: number[], returning: number[]}>} */
  const acc = {};
  for (const s of speakers || []) {
    const years = yearsOf(s, inScopeFn);
    if (!years.length) continue;
    const firstYear = years[0];
    for (const e of s.detail || []) {
      if (!inScopeFn(e)) continue;
      const y = Number(e.year);
      const n = Number(e.n) || 0;
      const mins = Number(e.minutes) || 0;
      // No duration recorded → no opinion about length. Counting it as 0 would
      // drag the average down and read as "shorter talks that year".
      if (!y || !n || !mins) continue;
      const row = (acc[y] ??= { first: [], returning: [] });
      row[y === firstYear ? 'first' : 'returning'].push([mins, n]);
    }
  }
  const mean = (pairs) => {
    const slots = pairs.reduce((a, [, n]) => a + n, 0);
    return slots ? pairs.reduce((a, [m]) => a + m, 0) / slots : 0;
  };
  return Object.fromEntries(
    Object.entries(acc).map(([y, r]) => [
      y,
      { first: mean(r.first), returning: mean(r.returning) },
    ]),
  );
}

/**
 * Length brackets crossed with speaker status: per year, per bracket, how many
 * slots went to someone in their first year and how many to someone returning.
 *
 * The average slot length answers "how long", but hides the distribution — a
 * 65-minute mean is either a room full of hour slots or a mix of lightning talks
 * and workshops. This is the same question asked per bracket, which is where a
 * pattern like "newcomers get the 45s, veterans get the hours" would actually be
 * visible.
 *
 * @param {Array<{detail?: Array<any>}>} speakers
 * @param {(e: any) => boolean} [inScopeFn]
 * @returns {Record<number, Record<string, {first: number, returning: number}>>}
 */
export function bracketByStatus(speakers, inScopeFn = () => true) {
  /** @type {Record<number, Record<string, {first: number, returning: number}>>} */
  const out = {};
  for (const s of speakers || []) {
    const years = yearsOf(s, inScopeFn);
    if (!years.length) continue;
    const firstYear = years[0];
    for (const e of s.detail || []) {
      if (!inScopeFn(e)) continue;
      const y = Number(e.year);
      if (!y) continue;
      const key = y === firstYear ? 'first' : 'returning';
      for (const [bucket, n] of Object.entries(e.lengths || {})) {
        const row = ((out[y] ??= {})[bucket] ??= { first: 0, returning: 0 });
        row[key] += Number(n) || 0;
      }
    }
  }
  return out;
}

export function newVsReturning(speakers, inScopeFn = () => true) {
  /** @type {Record<number, {first: number, returning: number}>} */
  const byYear = {};
  const row = (y) => (byYear[y] ??= { first: 0, returning: 0 });
  for (const s of speakers || []) {
    yearsOf(s, inScopeFn).forEach((y, i) => (i === 0 ? row(y).first++ : row(y).returning++));
  }
  return {
    byYear,
    firsts: Object.fromEntries(Object.entries(byYear).map(([y, r]) => [y, r.first])),
  };
}

/** `{2024: {first, returning}}` → `{2024: <one of them>}`. */
function mapVals(obj, fn) {
  return Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [k, fn(v)]));
}

/**
 * Six small charts, one per length bracket, each showing first-timers against
 * returning speakers.
 *
 * SMALL MULTIPLES, not twelve lines on one axis: six brackets times two statuses
 * is past the point where a shared axis can be read, and the comparison people
 * actually make is bracket-to-bracket ("are newcomers getting the hour slots?"),
 * which facets answer directly.
 *
 * One shared y-scale across all six panels — the whole question is how the
 * brackets compare, and per-panel scales would draw the 21-slot bracket the same
 * height as the 378-slot one.
 */
function bracketPanels() {
  const v = _view || computeView();
  const rows = bracketByStatus(v.speakers || [], (e) => inScope(e));
  const buckets = _data.lengthBuckets || [];
  const years = [];
  for (let y = Y0; y <= Y1; y++) if (rows[y]) years.push(y);
  if (!years.length || !buckets.length)
    return '<p class="obs-topic-empty">No session lengths recorded in this view.</p>';

  let yMax = 1;
  for (const y of years)
    for (const b of buckets) {
      const r = rows[y]?.[b.key];
      if (r) yMax = Math.max(yMax, r.first, r.returning);
    }

  const W = 320;
  const H = 132;
  const padL = 26;
  const padR = 8;
  const padT = 10;
  const padB = 20;
  const pw = W - padL - padR;
  const ph = H - padT - padB;
  const X = (y) => padL + ((y - Y0) / Math.max(1, Y1 - Y0)) * pw;
  const Yv = (n) => padT + ph - (n / yMax) * ph;
  const series = [
    { key: 'first', label: 'First time', ...slotStyle(0) },
    { key: 'returning', label: 'Spoken before', ...slotStyle(1) },
  ];

  _smPlot = { rows, buckets, years, yMax, W, H, padL, padT, pw, ph, series };
  return `<div class="obs-sm" data-sm>${buckets
    .map((b) => {
      const total = years.reduce(
        (n, y) => n + (rows[y]?.[b.key]?.first || 0) + (rows[y]?.[b.key]?.returning || 0),
        0,
      );
      const lines = series
        .map((s) => {
          const pts = years
            .map((y) => `${X(y).toFixed(1)},${Yv(rows[y]?.[b.key]?.[s.key] || 0).toFixed(1)}`)
            .join(' ');
          const dots = years
            .map((y) => {
              const n = rows[y]?.[b.key]?.[s.key] || 0;
              return n
                ? `<circle class="obs-sm-dot" cx="${X(y).toFixed(1)}" cy="${Yv(n).toFixed(1)}" r="2.2" style="fill:${s.color}"><title>${y} · ${esc(b.label)} · ${esc(s.label)}: ${plural(n, 'slot')}</title></circle>`
                : '';
            })
            .join('');
          return `<polyline class="obs-sm-line" points="${pts}" style="stroke:${s.color}"${dashAttr(s.dash)}/>${dots}`;
        })
        .join('');
      return `<figure class="obs-sm-cell" data-bucket="${esc(b.key)}">
        <figcaption class="obs-sm-cap">${esc(b.label)} <span class="obs-rank-count">${plural(total, 'slot')}</span></figcaption>
        <svg class="obs-sm-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(b.label)}: first-time against returning speakers per year">
          <line class="obs-tc-grid" x1="${padL}" y1="${padT}" x2="${W - padR}" y2="${padT}"/>
          <line class="obs-st-axis" x1="${padL}" y1="${padT + ph}" x2="${W - padR}" y2="${padT + ph}"/>
          <text class="obs-tc-ylab" x="${padL - 5}" y="${padT + 4}" text-anchor="end">${yMax}</text>
          <text class="obs-tc-ylab" x="${padL - 5}" y="${padT + ph}" text-anchor="end">0</text>
          <text class="obs-tc-xlab" x="${padL}" y="${H - 6}">'${String(years[0]).slice(2)}</text>
          <text class="obs-tc-xlab" x="${W - padR}" y="${H - 6}" text-anchor="end">'${String(years[years.length - 1]).slice(2)}</text>
          <g class="obs-rise" style="--rise-base:${(padT + ph).toFixed(1)}px">${lines}</g>
        </svg>
      </figure>`;
    })
    .join('')}<div class="obs-tc-tip obs-sm-tip" id="obsSmTip" hidden></div></div>`;
}

/** Last small-multiples geometry, for the shared hover layer. */
let _smPlot = null;

/**
 * Hover any panel: read the year from the cursor's x, then show BOTH series for
 * that bracket. The dots carry <title>s for keyboard and screen-reader users, but
 * a native tooltip needs a pixel-perfect hit on a 2.2px circle — this reads the
 * nearest year the way the main chart's crosshair does.
 */
function smHover(e) {
  const tip = $('obsSmTip');
  const cell = e.target.closest?.('[data-bucket]');
  if (!tip || !_smPlot || !cell) return smHoverOut();
  const svg = cell.querySelector('svg');
  const r = svg?.getBoundingClientRect();
  if (!r?.width) return smHoverOut();
  const { rows, buckets, years, W, padL, pw } = _smPlot;
  const vbx = ((e.clientX - r.left) / r.width) * W;
  let year = years[0];
  let best = Infinity;
  for (const y of years) {
    const d = Math.abs(padL + ((y - Y0) / Math.max(1, Y1 - Y0)) * pw - vbx);
    if (d < best) {
      best = d;
      year = y;
    }
  }
  const bucket = buckets.find((b) => b.key === cell.dataset.bucket);
  const row = rows[year]?.[bucket?.key] || { first: 0, returning: 0 };
  const box = cell.closest('[data-sm]')?.getBoundingClientRect();
  if (!box) return smHoverOut();
  tip.innerHTML =
    `<div class="obs-tc-tip-y">${year} · ${esc(bucket?.label || '')}</div>` +
    _smPlot.series
      .map(
        (s) =>
          `<div class="obs-tc-tip-row"><span class="obs-tc-tip-sw" style="background:${s.color}"></span><span class="obs-tc-tip-t">${esc(s.label)}</span><b>${row[s.key] || 0}</b></div>`,
      )
      .join('');
  tip.removeAttribute('hidden');
  // Flip rather than clamp, the same rule the main chart's tooltip uses.
  const x = e.clientX - box.left;
  const w = tip.offsetWidth;
  const left = x + 14 + w <= box.width ? x + 14 : x - 14 - w;
  tip.style.left = `${Math.max(0, Math.min(left, Math.max(0, box.width - w)))}px`;
  tip.style.top = `${Math.max(0, e.clientY - box.top - tip.offsetHeight - 12)}px`;
}

function smHoverOut() {
  $('obsSmTip')?.setAttribute('hidden', '');
}

/**
 * The four populations of PEOPLE an event is made of, per year: attendees,
 * speakers, organisers, volunteers.
 *
 * Sponsors used to be a fifth line and should not have been. They are
 * organisations, not people; one company backing three events in a year is one
 * sponsor doing three things, not three of anything the other lines count — and
 * with no attendee-style denominator, a "% of peak" for them was measuring the
 * archive's sponsor-capture rate, not the community. They have their own view now
 * (Sponsor loyalty), where the question is one the data can actually answer.
 *
 * They are wildly different magnitudes — thousands of attendees against dozens of
 * organisers — which is exactly why this view offers "% of peak" as well as a raw
 * count, and why every series can be switched off. A dual axis would be the usual
 * answer and the wrong one: it lets a chart imply any relationship you like by
 * choosing two scales. Indexing each series to its own peak makes the SHAPES
 * comparable and says nothing about relative size, which is the honest trade.
 */
function communitySeries() {
  const v = _view || computeView();
  const per = (fn) => {
    const by = {};
    fn((y, n) => {
      if (y) by[y] = (by[y] || 0) + n;
    });
    return by;
  };
  const credits = (role) =>
    per((add) => {
      for (const p of _data?.credits?.people || [])
        if (p.role === role) for (const e of p.detail || []) if (inScope(e)) add(Number(e.year), 1);
    });
  return [
    {
      key: 'attendees',
      label: 'Attendees',
      byYear: per((add) => {
        for (const e of flatEvents())
          if (inScope(e) && Number.isFinite(e.attendance)) add(e.year, e.attendance);
      }),
    },
    {
      key: 'speakers',
      label: 'Speakers',
      byYear: per((add) => {
        for (const s of v.speakers || [])
          for (const y of new Set(
            (s.detail || []).filter((e) => inScope(e)).map((e) => Number(e.year)),
          ))
            add(y, 1);
      }),
    },
    { key: 'organisers', label: 'Organisers', byYear: credits('organiser') },
    { key: 'volunteers', label: 'Volunteers', byYear: credits('volunteer') },
  ];
}

/**
 * How many years a series actually has numbers for — its denominator, counted.
 *
 * Exported for the test that pins the rule it exists for: under "% of peak" a
 * series with fewer than two of these is indistinguishable from a flat 100%.
 */
export function yearsWithData(byYear) {
  return Object.values(byYear || {}).filter((n) => n > 0).length;
}

/**
 * Sponsor tiers, as the events themselves name them.
 *
 * 68 distinct labels across 2,016 slots, and they are not one ladder: some events
 * sell metals (Bronze, Silver, Gold, Platinum, Diamond), others sell roles
 * (Exhibitor, Media, Module, Community). Mapping "Champion" onto "Gold" would be
 * inventing an equivalence no organiser agreed to, so the only normalising done
 * here is case and whitespace — "Add-on" and "Add-On" are the same word typed
 * twice. The long tail folds into "Other tiers" rather than being ranked.
 *
 * @param {any[]} sponsors scoped sponsor rows
 * @param {number} [top] how many tiers to name before folding the rest
 */
export function sponsorTierSeries(sponsors, inScopeFn = () => true, top = 8) {
  const label = new Map(); // lowercased → the spelling used most
  const spellings = new Map();
  const byTierYear = new Map();
  const totals = new Map();
  for (const s of sponsors || [])
    for (const e of s.detail || []) {
      if (!inScopeFn(e) || !e.tier || !e.year) continue;
      const key = String(e.tier).trim().toLowerCase().replace(/\s+/g, ' ');
      if (!key) continue;
      const seen = spellings.get(key) || new Map();
      seen.set(String(e.tier).trim(), (seen.get(String(e.tier).trim()) || 0) + 1);
      spellings.set(key, seen);
      totals.set(key, (totals.get(key) || 0) + 1);
      const row = byTierYear.get(key) || {};
      row[e.year] = (row[e.year] || 0) + 1;
      byTierYear.set(key, row);
    }
  for (const [key, seen] of spellings) label.set(key, [...seen].sort((a, b) => b[1] - a[1])[0][0]);

  const ranked = [...totals].sort((a, b) => b[1] - a[1]);
  const named = ranked.slice(0, top);
  const tail = ranked.slice(top);
  const series = named.map(([key]) => ({ term: label.get(key), byYear: byTierYear.get(key) }));
  if (tail.length) {
    const other = {};
    for (const [key] of tail)
      for (const [y, n] of Object.entries(byTierYear.get(key) || {}))
        other[y] = (other[y] || 0) + n;
    series.push({ term: `Other tiers (${tail.length})`, byYear: other });
  }
  return series;
}

function topicChartSvg() {
  // FOUR SUBJECTS, each with its own views (see VIEWS). The flags below translate
  // (subject, view) into the handful of shapes this renderer can draw, so every
  // branch downstream asks "what am I drawing?" and never "which button is lit?".
  const v = _chartView;
  const sessions = _chartMode === 'programme' && v === 'sessions';
  const hours = _chartMode === 'programme' && v === 'hours';
  const lengths = _chartMode === 'programme' && (v === 'lengths' || v === 'lengthShare');
  // Two pseudo-series, so the tooltip, the emphasis and the hit-testing work on
  // them unchanged — only the DRAWING differs (stacked bars, because the two parts
  // make a whole: everyone who spoke).
  const people = _chartMode === 'speakers' && (v === 'who' || v === 'whoShare');
  // Same shape, different population: how many of a year's sponsors had backed an
  // event before. The two parts are the whole sponsor list, so they stack.
  const sponsorLoyalty = _chartMode === 'sponsors' && v === 'loyalty';
  const sponsorCount = _chartMode === 'sponsors' && v === 'count';
  const sponsorTiers = _chartMode === 'sponsors' && v === 'tiers';
  // Not how MANY spoke but how long they got. An average is not part of a whole, so
  // it is lines — stacking two averages would draw a session nobody ran.
  const slots = _chartMode === 'speakers' && v === 'slots';
  const community = _chartMode === 'community';
  // Denominator for topic "share %" — titled sessions per year in the *current scope*.
  const sessBy =
    computeScopeTopics().sessBy ||
    Object.fromEntries((_data.years || []).map((y) => [y.year, y.sessions]));
  const commAll = community ? communitySeries() : [];
  // "% of peak" rescales each series against its OWN maximum, so five populations
  // of wildly different size can share one axis without a second scale.
  const peak = community && v === 'peak';
  // …but a series with ONE year of data is its own peak, so indexing it plots a
  // lone 100% point — the chart then says "2024 was the peak volunteer year" when
  // what happened is that 2024 is the only event whose credits were captured.
  // A percentage of a denominator of one is not a finding, so those series sit
  // out the peak view and the legend says where to find them (Count).
  const commOn = commAll.filter(
    (c) => _communitySel.has(c.key) && !(peak && yearsWithData(c.byYear) < 2),
  );
  const peaks = Object.fromEntries(
    commAll.map((c) => [c.key, Math.max(1, ...Object.values(c.byYear))]),
  );
  // Length mix per year, summed from the in-scope events (each carries its own
  // `lengths` tally), so the facets apply exactly as they do everywhere else.
  const mix = {};
  if (lengths)
    for (const e of flatEvents())
      if (inScope(e))
        for (const [k, n] of Object.entries(e.lengths || {}))
          (mix[e.year] ??= {})[k] = (mix[e.year][k] || 0) + n;
  const mixTotals = mapVals(mix, (r) => Object.values(r).reduce((a, b) => a + b, 0));
  const castOf = people
    ? (_view || computeView()).speakers
    : sponsorLoyalty
      ? (_view || computeView()).sponsors
      : null;
  const cast = castOf ? newVsReturning(castOf, (e) => inScope(e)).byYear : {};
  const castTotals = Object.fromEntries(
    Object.entries(cast).map(([y, r]) => [y, r.first + r.returning]),
  );
  const slotAvg = slots
    ? slotLengthByStatus((_view || computeView()).speakers || [], (e) => inScope(e))
    : {};
  const stacked = people || sponsorLoyalty;
  const scopedSponsors = (_view || computeView()).sponsors || [];
  const sel = sponsorTiers
    ? sponsorTierSeries(scopedSponsors, (e) => inScope(e)).filter((t) =>
        Object.values(t.byYear).some(Boolean),
      )
    : sponsorCount
      ? [
          {
            term: 'Sponsors',
            // Distinct organisations per YEAR: a company backing three events in
            // one year is one sponsor that year, not three.
            byYear: (() => {
              const by = {};
              for (const sp of scopedSponsors)
                for (const y of new Set(
                  (sp.detail || []).filter((e) => inScope(e)).map((e) => Number(e.year)),
                ))
                  if (y) by[y] = (by[y] || 0) + 1;
              return by;
            })(),
          },
        ]
      : hours
        ? [
            {
              term: 'Hours',
              byYear: Object.fromEntries(
                flatEvents()
                  .filter((e) => inScope(e))
                  .reduce(
                    (m, e) => m.set(e.year, (m.get(e.year) || 0) + (e.minutes || 0)),
                    new Map(),
                  ),
              ),
            },
          ].map((t) => ({ ...t, byYear: mapVals(t.byYear, (n) => Math.round(n / 60)) }))
        : community
          ? commOn.map((c) => ({
              term: c.label,
              key: c.key,
              byYear: peak
                ? mapVals(c.byYear, (n) => Math.round((n / peaks[c.key]) * 100))
                : c.byYear,
              // The real headcount rides along even when the plot is indexed, so the
              // tooltip can show "62% (1,240)" — an index nobody can convert back is
              // the other half of the denominator problem.
              raw: c.byYear,
            }))
          : slots
            ? [
                { term: 'First time', byYear: mapVals(slotAvg, (r) => Math.round(r.first)) },
                { term: 'Spoken before', byYear: mapVals(slotAvg, (r) => Math.round(r.returning)) },
              ]
            : lengths
              ? (_data.lengthBuckets || [])
                  .map((b) => ({
                    term: b.label,
                    byYear: mapVals(mix, (r) => r[b.key] || 0),
                  }))
                  .filter((t) => Object.values(t.byYear).some(Boolean))
              : stacked
                ? [
                    { term: 'First time', byYear: mapVals(cast, (r) => r.first) },
                    {
                      term: sponsorLoyalty ? 'Sponsored before' : 'Spoken before',
                      byYear: mapVals(cast, (r) => r.returning),
                    },
                  ]
                : sessions
                  ? [{ term: 'Sessions', byYear: sessionsByYearScoped() }]
                  : [..._topicSel].map(topicObj).filter((t) => Object.keys(t.byYear).length);
  const plotYears = [];
  const yearHas = sponsorTiers
    ? Object.fromEntries(
        [...new Set(sel.flatMap((t) => Object.keys(t.byYear)))].map((y) => [
          y,
          sel.reduce((n, t) => n + (t.byYear[y] || 0), 0),
        ]),
      )
    : hours || sponsorCount
      ? sel[0].byYear
      : community
        ? Object.fromEntries(
            [...new Set(commOn.flatMap((c) => Object.keys(c.byYear)))].map((y) => [
              y,
              commOn.reduce((n, c) => n + (c.byYear[y] || 0), 0),
            ]),
          )
        : slots
          ? mapVals(slotAvg, (r) => Math.round(r.first + r.returning))
          : lengths
            ? mixTotals
            : stacked
              ? castTotals
              : sessions
                ? sel[0].byYear
                : sessBy;
  for (let y = Y0; y <= Y1; y++) if ((yearHas[y] || 0) > 0) plotYears.push(y);
  if (!plotYears.length || !sel.length) {
    _plot = null;
    return `<p class="obs-topic-empty">${
      _chartMode === 'sponsors'
        ? 'No sponsors recorded in this view.'
        : community
          ? peak && commAll.some((c) => _communitySel.has(c.key))
            ? 'Every series switched on has one year of data — against its own peak each would plot a flat 100%. Switch to <strong>Count</strong>.'
            : 'Nothing to compare — switch a series on below.'
          : lengths
            ? 'No session lengths recorded in this view.'
            : people
              ? 'No speakers recorded in this view.'
              : sessions
                ? 'No sessions recorded in this view.'
                : 'Select a topic below to plot how often it appeared in session titles.'
    }</p>`;
  }
  const share = v === 'share' || v === 'lengthShare' || v === 'whoShare';
  // In people mode a share is of that year's CAST, not of its sessions.
  const topicShare = _chartMode === 'topics' && share;
  const readBy = computeScopeTopics().readBy || {};
  const denom = topicShare ? readBy : stacked ? castTotals : lengths ? mixTotals : sessBy;
  const val = (t, y) => {
    // For a topic SHARE both halves come from the readable sub-population: matches
    // among sessions with a description, over sessions with a description. Mixing
    // title-only matches into a described-only denominator would swing the error
    // the other way. Count stays a count of every match — that number is true
    // whatever the coverage.
    const c = (topicShare ? t.byYearD?.[y] : t.byYear[y]) || 0;
    return share ? (denom[y] ? (c / denom[y]) * 100 : 0) : c;
  };
  // The axis has to fit what is DRAWN. Lines are drawn independently, so the
  // tallest single value is the ceiling; stacked bars are drawn on top of each
  // other, so the ceiling is the tallest STACK. Scaling people mode to its
  // tallest segment sent a 496-person year off the top of the plot.
  let yMax = 0;
  if (stacked) {
    for (const y of plotYears)
      yMax = Math.max(yMax, share ? 100 : sel.reduce((n, t) => n + (t.byYear[y] || 0), 0));
  } else {
    for (const t of sel) for (const y of plotYears) yMax = Math.max(yMax, val(t, y));
  }
  yMax = yMax || 1;

  const W = 1000,
    H = 340,
    padL = 46,
    padR = 18,
    padT = 16,
    padB = 30;
  const pw = W - padL - padR,
    ph = H - padT - padB;
  const X = (y) => padL + ((y - Y0) / (Y1 - Y0)) * pw;
  const Yv = (v) => padT + ph - (v / yMax) * ph;
  const fmt = (v) =>
    share ? `${v.toFixed(1)}%` : slots ? `${Math.round(v)}m` : String(Math.round(v));

  let grid = '';
  for (let i = 0; i <= 4; i++) {
    const v = (yMax / 4) * i;
    const gy = Yv(v).toFixed(1);
    grid += `<line class="obs-tc-grid" x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}"/><text class="obs-tc-ylab" x="${padL - 7}" y="${(+gy + 3).toFixed(1)}" text-anchor="end">${fmt(v)}</text>`;
  }
  // Highlight the selected year (the year facet shows as a gold band rather than
  // collapsing the timeline to a single point).
  let hi = '';
  if (_year !== 'All' && plotYears.includes(Number(_year))) {
    const hx = X(Number(_year));
    hi = `<line class="obs-tc-yearhi" x1="${hx.toFixed(1)}" y1="${padT}" x2="${hx.toFixed(1)}" y2="${padT + ph}"/>`;
  }
  let xlab = '';
  for (const y of plotYears)
    if ((y - Y0) % 3 === 0 || y === Y1)
      xlab += `<text class="obs-tc-xlab" x="${X(y).toFixed(1)}" y="${H - 9}" text-anchor="middle">'${String(y).slice(2)}</text>`;

  let lines = '';
  const geomSel = [];
  // Stacked bars, first-timers on the BOTTOM: a segment anchored to the baseline
  // is the one you can compare across twenty years by eye, and "how much of this
  // year's cast was new" is the question the mode exists to answer.
  if (people && !slots) {
    const span = Math.max(1, Y1 - Y0);
    const bw = Math.min(22, (pw / (span + 1)) * 0.62);
    const order = [
      { t: sel[0], color: slotStyle(0).color },
      { t: sel[1], color: slotStyle(1).color },
    ];
    for (const y of plotYears) {
      // Cumulative, so the stack's height is exactly what the axis says; the 2px
      // surface gap is then taken OUT of each lower segment rather than added to
      // the top of the bar, which would push the tallest year past the ceiling.
      let cum = 0;
      order.forEach(({ t, color }, i) => {
        const v = val(t, y);
        if (!v) return;
        const top = Yv(cum + v);
        const bottom = Yv(cum);
        cum += v;
        const gap = i < order.length - 1 ? 2 : 0;
        const h = Math.max(1, bottom - top - gap);
        lines += `<rect class="obs-tc-bar" data-term="${esc(t.term)}" x="${(X(y) - bw / 2).toFixed(1)}" y="${(bottom - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" style="fill:${color}"/>`;
      });
    }
    for (const [i, t] of sel.entries())
      geomSel.push({ term: t.term, color: slotStyle(i).color, byYear: t.byYear });
  }
  for (const [si, t] of (stacked ? [] : sel).entries()) {
    // Lengths are a FIXED set in a fixed order, so they take palette slots by
    // position — they are not keywords competing for the colour map.
    const style =
      sessions || hours || sponsorCount
        ? { color: 'var(--viz-1)', dash: '' }
        : lengths || slots || sponsorTiers
          ? slotStyle(si)
          : community
            ? slotStyle(commAll.findIndex((c) => c.key === t.key))
            : topicStyle(t.term);
    const col = style.color;
    geomSel.push({ term: t.term, color: col, byYear: t.byYear, byYearD: t.byYearD, raw: t.raw });
    const coords = plotYears.map((y) => `${X(y).toFixed(1)},${Yv(val(t, y)).toFixed(1)}`);
    // Sessions view is a filled area under a single gold line; keyword lines stay clean.
    if (sessions)
      lines += `<polygon class="obs-tc-area" points="${padL},${padT + ph} ${coords.join(' ')} ${(padL + pw).toFixed(1)},${padT + ph}"/>`;
    lines += `<polyline class="obs-tc-line${sessions ? ' obs-tc-line--lead' : ''}" data-term="${esc(t.term)}" points="${coords.join(' ')}" style="stroke:${col}"${dashAttr(style.dash)}/>`;
    for (const y of plotYears) {
      const c = t.byYear[y] || 0;
      if (!c) continue;
      lines += `<circle class="obs-tc-dot" data-term="${esc(t.term)}" r="3" cx="${X(y).toFixed(1)}" cy="${Yv(val(t, y)).toFixed(1)}" style="fill:${col}"/>`;
    }
  }
  // Remember the geometry so mouse handlers can map cursor → (year, topic).
  _plot = {
    // Coverage per year, so the tooltip can say what the share was measured over.
    readBy,
    topicShare,
    allBy: sessBy,
    W,
    H,
    padL,
    padT,
    pw,
    ph,
    yMax,
    plotYears,
    sel: geomSel,
    sessBy,
    // The denominator this mode's shares are OF. The tooltip used to divide by
    // sessions whatever was plotted, so People in Share % read first/sessions and
    // returning/sessions — two numbers that describe the year correctly and add
    // up to 98.3% instead of 100.
    denom,
    unit: _chartView,
    sessions,
  };
  // The data marks ride in their own group so they can grow out of the baseline
  // on first paint; the grid, the axis labels and the year highlight must not
  // move, which is what makes the rise read as data rather than as the whole
  // panel sliding. See `.obs-rise`.
  return `<svg class="obs-tc" viewBox="0 0 ${W} ${H}" role="img" aria-label="${sessions ? 'Sessions per year' : 'Topic mentions over time'}">${grid}${hi}${xlab}<g class="obs-rise" style="--rise-base:${(padT + ph).toFixed(1)}px">${lines}</g></svg>`;
}

// Map a mouse event over the chart → nearest { year, term, per-topic values, pixel x }.
function chartHit(e) {
  const chart = $('obsTopicChart');
  const svg = chart?.querySelector('svg');
  if (!svg || !_plot) return null;
  const r = svg.getBoundingClientRect();
  if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
    return null;
  const { W, H, padL, padT, pw, ph, yMax, plotYears, sel, sessBy, denom, unit, sessions } = _plot;
  const share = !sessions && unit === 'share';
  const over = denom || sessBy;
  const vbx = ((e.clientX - r.left) / r.width) * W;
  let year = plotYears[0];
  let best = Infinity;
  for (const y of plotYears) {
    const d = Math.abs(padL + ((y - Y0) / (Y1 - Y0)) * pw - vbx);
    if (d < best) {
      best = d;
      year = y;
    }
  }
  const vby = ((e.clientY - r.top) / r.height) * H;
  let term = null;
  let bestY = Infinity;
  const rows = sel.map((s) => {
    const c = ((_plot.topicShare ? s.byYearD?.[year] : s.byYear[year]) ?? s.byYear[year]) || 0;
    const value = share ? (over[year] ? (c / over[year]) * 100 : 0) : c;
    if (c > 0) {
      const py = padT + ph - (value / yMax) * ph;
      const d = Math.abs(py - vby);
      if (d < bestY) {
        bestY = d;
        term = s.term;
      }
    }
    return { term: s.term, color: s.color, count: c, value, raw: s.raw ? s.raw[year] || 0 : c };
  });
  const contRect = chart.getBoundingClientRect();
  const px = r.left - contRect.left + ((padL + ((year - Y0) / (Y1 - Y0)) * pw) / W) * r.width;
  return { year, term, rows, px, cursorY: e.clientY - contRect.top };
}

function hideChartTip() {
  $('obsTcGuide')?.setAttribute('hidden', '');
  $('obsTcTip')?.setAttribute('hidden', '');
}

function onChartMove(e) {
  // Small multiples have their own hover layer: six plots, one tooltip.
  if (e.target.closest?.('[data-sm]')) {
    hideChartTip();
    return smHover(e);
  }
  smHoverOut();
  const hit = chartHit(e);
  const guide = $('obsTcGuide');
  const tip = $('obsTcTip');
  if (!hit || !guide || !tip) return hideChartTip();
  const share = _chartMode !== 'sessions' && _chartView === 'share';
  const rows = hit.rows
    .filter((r) => r.count > 0)
    // Biggest first: a tooltip is read top-down, so plot order is the wrong order.
    .sort((x, y) => (y.value ?? y.count) - (x.value ?? x.count))
    .map(
      (r) =>
        `<div class="obs-tc-tip-row"><span class="obs-tc-tip-sw" style="background:${r.color}"></span><span class="obs-tc-tip-t">${esc(r.term)}</span><b>${
          share
            ? `${r.value.toFixed(1)}%`
            : _plot?.unit === 'peak'
              ? // An index with no headcount beside it cannot be checked: "100%"
                // of five volunteers and of five thousand attendees look alike.
                `${Math.round(r.value)}% <span class="obs-tc-tip-raw">${num(r.raw)}</span>`
              : _plot?.unit === 'minutes'
                ? `${r.count} min`
                : r.count
        }</b></div>`,
    )
    .join('');
  if (!rows) return hideChartTip();
  guide.style.left = `${hit.px}px`;
  guide.removeAttribute('hidden');
  // A share is only as good as the text behind it, so the tooltip says how much of
  // that year the archive can actually read. 2013 sits at 35%: without this line a
  // reader has no way to tell a quiet year from an unrecorded one.
  const cov =
    _plot.topicShare && _plot.readBy
      ? (() => {
          const r = _plot.readBy[hit.year] || 0;
          const all = _plot.allBy?.[hit.year] || 0;
          return all
            ? `<div class="obs-tc-tip-note">of ${plural(r, 'session')} with a description · ${Math.round((r / all) * 100)}% of that year</div>`
            : '';
        })()
      : '';
  tip.innerHTML = `<div class="obs-tc-tip-y">${hit.year}</div>${rows}${cov}`;
  tip.removeAttribute('hidden');
  // FLIP, don't squash. Clamping the tooltip inside the chart meant that on the
  // right-hand years it slid back under the cursor and covered the very point you
  // were reading. It sits to the right of the cursor while there is room, and to
  // the LEFT when there is not — the side changes, the gap never does. Clamping
  // stays as the last resort for a tooltip wider than the chart itself.
  const cw = tip.offsetWidth;
  const contW = $('obsTopicChart').clientWidth;
  const GAP = 14;
  const right = hit.px + GAP;
  const left = right + cw <= contW - 4 ? right : Math.max(0, hit.px - GAP - cw);
  tip.style.left = `${Math.min(Math.max(0, left), Math.max(0, contW - cw - 4))}px`;
  tip.style.top = `${Math.max(0, hit.cursorY - tip.offsetHeight - 12)}px`;
}

// Click a point → the real session titles behind that keyword+year (current scope).
// Async: pulls titles from the search endpoint (cached), searching title+description.
export async function openTopicDrill(term, year) {
  destroyMap();
  destroyStripMap();
  const back = `<button type="button" class="obs-back" data-back="1">← Back to overview</button>`;
  setCrumbs([{ label: CRUMB_LABELS.topic }, { label: `“${term}” · ${year}` }]);
  const head = (sub) =>
    `${back}<div class="obs-drill-head"><span class="obs-eyebrow">Topic · ${esc(String(year))}</span><h2 class="obs-drill-name">“${esc(term)}”</h2><p class="obs-sub">${sub}</p></div>`;
  $('obsBody').innerHTML = head('Reading the sessions behind this point…');
  toTopOfView();

  const q = new URLSearchParams({
    term,
    year: String(year),
    series: _series,
    region: _region,
    country: _country,
  });
  let data = null;
  try {
    const res = await fetch(`/api/archive/topic?${q}`);
    data = res.ok ? await res.json() : null;
  } catch {
    data = null;
  }
  if (!data) {
    $('obsBody').innerHTML = head('Could not reach the archive.');
    return;
  }

  // Newest first inside the year, then by title — the same ordering the session
  // search uses, so two lists of sessions never read differently.
  const list = [...(data.sessions || [])].sort(
    (a, b) =>
      String(b.startTime || '').localeCompare(String(a.startTime || '')) ||
      String(a.title).localeCompare(String(b.title)),
  );

  // The events behind those sessions, deduped: a keyword that came up four times
  // at one conference is one pin on the map, not four.
  const byFile = new Map();
  for (const s of list) if (s.file && !byFile.has(s.file)) byFile.set(s.file, s);
  const evs = [...byFile.values()].map((s) => ({
    label: s.event,
    year: s.year,
    series: s.series,
    region: s.region,
    country: s.country,
    file: s.file,
    lat: s.lat,
    lon: s.lon,
  }));
  _drillDetail = evs;
  _mapPts = geocoded(evs).map((e) => ({ lat: e.lat, lon: e.lon, label: e.label, year: e.year }));

  const facets = [_series, _region, _country].filter((x) => x !== 'All');
  const scope = facets.length ? esc(facets.join(' · ')) : 'the archive';
  const speakers = new Set();
  for (const s of list)
    for (const n of String(s.speakers || '').split(',')) if (n.trim()) speakers.add(n.trim());
  const bits = [
    plural(list.length, 'session'),
    plural(evs.length, 'event'),
    speakers.size ? plural(speakers.size, 'speaker') : '',
    `in ${scope}`,
  ].filter(Boolean);

  // The same row as a session search result — expandable, with the description,
  // the speakers, the event it was at, and the term marked wherever it appears.
  // A keyword drill and a text search answer the same question about a session,
  // so they must not present it two different ways.
  const rows = sessionRowsHtml(list, [String(term).toLowerCase()], 0, 'exact');
  $('obsBody').innerHTML =
    `${head(`${esc(bits.join(' · '))} <span class="obs-section-note">title + description</span>`)}
    ${mapBlock(_mapPts, evs)}
    <div class="obs-evs">${rows || '<p class="obs-drill-note">No sessions found.</p>'}</div>`;
  initDrillMap();
  toTopOfView();
}

/**
 * The community legend IS the control: five populations, each switchable, because
 * comparing 2,437 attendees with 44 organisers on one axis is only useful when you
 * can put the big ones away.
 */
function communityLegend() {
  return communitySeries()
    .map((c, i) => {
      const on = _communitySel.has(c.key);
      const total = Object.values(c.byYear).reduce((a, b) => a + b, 0);
      const years = yearsWithData(c.byYear);
      // A series the peak view cannot honestly draw still belongs in the legend —
      // switched on, counted, and told why the line is missing. Dropping it
      // silently would read as "no volunteers", which is the opposite of the truth.
      const oneYear = _chartView === 'peak' && years === 1;
      const note = oneYear
        ? `<span class="obs-rank-count" title="One year of data indexes to a flat 100% against its own peak. Switch to Count to see it.">1 yr · Count only</span>`
        : '';
      return `<span class="obs-topic-chip${on ? ' is-on' : ''}${oneYear ? ' is-muted' : ''}" data-term="${esc(c.label)}">
        <button type="button" class="obs-topic-tog" data-community="${c.key}" aria-pressed="${on}">${swatch(slotStyle(i), on && !oneYear)}${esc(c.label)}<span class="obs-rank-count">${num(total)}</span>${note}</button>
      </span>`;
    })
    .join('');
}

/**
 * A legend for a FIXED set of series — the two halves of the cast, the six session
 * lengths. Nothing to toggle, unlike the keyword chips: these are what the chart
 * is, not a selection within it.
 */
function staticLegend(labels) {
  return (labels || [])
    .map(
      (label, i) =>
        `<span class="obs-topic-chip is-on is-static">${swatch(slotStyle(i))}${esc(label)}</span>`,
    )
    .join('');
}

function topicLegend() {
  const topics = currentTopics();
  // Order: your pinned defaults first, then the frequency top-16, then any other
  // selected/custom terms.
  const shown = [];
  const push = (t) => t && !shown.includes(t) && shown.push(t);
  _pinned.forEach(push);
  topics.slice(0, 16).forEach((t) => push(t.term));
  for (const term of _topicSel) push(term);
  const chips = shown
    .map((term) => {
      const on = _topicSel.has(term);
      const pinned = _pinned.includes(term);
      const style = topicStyle(term);
      // The legend is a legend: it names the series and lets you turn one off.
      // Pinning and adding live in the rail, so there is one place that edits
      // the set rather than two that half-do.
      return `<span class="obs-topic-chip${on ? ' is-on' : ''}${pinned ? ' is-pinned' : ''}" data-term="${esc(term)}">
        <button type="button" class="obs-topic-tog" data-topic="${esc(term)}">${swatch(style, on)}${esc(term)}</button>
      </span>`;
    })
    .join('');
  const opts = topics
    .filter((t) => !_topicSel.has(t.term))
    .map((t) => `<option value="${esc(t.term)}">`)
    .join('');
  // The add field lives in the rail now — see addKeyword()/topicVocab().
  return `${chips}<datalist id="obsTopicVocab">${opts}</datalist>`;
}

/**
 * Hold a chart's rise until it is actually on screen.
 *
 * The animation is the chart drawing itself, and a drawing nobody watched has
 * not communicated anything — on a phone the topic chart is usually below the
 * fold when the dashboard renders, so the whole 500ms was spent off-screen and
 * you scrolled down to a chart that was simply there.
 *
 * The default state is FULLY DRAWN. `is-armed` is what collapses a chart to its
 * baseline, and only JS adds it — so if this never runs, or IntersectionObserver
 * is missing, the charts render normally instead of staying invisible.
 */
let _riseObserver = null;
function armRise(root) {
  const marks = root?.querySelectorAll?.('.obs-rise');
  if (!marks?.length) return;
  const start = (el) => el.classList.add('is-rising');
  if (typeof IntersectionObserver === 'undefined') {
    marks.forEach((el) => start(el));
    return;
  }
  // One observer, reset per render: the charts it was watching have just been
  // replaced, and an observer holds its targets alive.
  _riseObserver?.disconnect();
  _riseObserver = new IntersectionObserver(
    (entries, obs) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        start(entry.target);
        obs.unobserve(entry.target);
      }
    },
    // A sliver is enough — waiting for a quarter of a tall chart means scrolling
    // past the top of it before anything happens.
    { threshold: 0.01 },
  );
  marks.forEach((el) => {
    el.classList.add('is-armed');
    /** @type {IntersectionObserver} */ (_riseObserver).observe(el);
  });
}

function renderTopics() {
  ensureTopicSel();
  buildColorMap(); // stable, non-repeating colours for every visible line
  // Custom terms (typed or restored from storage) need a fetch before they can plot.
  const missing = [..._topicSel].filter(
    (t) => !currentTopics().some((x) => x.term === t) && !_topicCache[cacheKey(t)],
  );
  if (missing.length) Promise.all(missing.map(fetchTopic)).then(renderTopics);
  const chart = $('obsTopicChart');
  const facets = _chartMode === 'speakers' && _chartView === 'brackets';
  if (chart) {
    if (facets) {
      // Small multiples have no single plot to hit-test, so the crosshair and its
      // tooltip stay out of this view; each point carries its own <title>.
      _plot = null;
      chart.innerHTML = bracketPanels();
    } else {
      chart.innerHTML = `${topicChartSvg()}<div class="obs-tc-guide" id="obsTcGuide" hidden></div><div class="obs-tc-tip" id="obsTcTip" hidden></div>`;
    }
    armRise(chart);
  }
  const leg = $('obsTopicLegend');
  // The keyword legend/add-box only makes sense for the Topics view.
  if (leg)
    leg.innerHTML =
      _chartMode === 'sponsors'
        ? _chartView === 'loyalty'
          ? staticLegend(['First time', 'Sponsored before'])
          : _chartView === 'tiers'
            ? staticLegend(
                sponsorTierSeries((_view || computeView()).sponsors || [], (e) => inScope(e)).map(
                  (t) => t.term,
                ),
              )
            : '' // Count is one line; the heading names it
        : _chartMode === 'community'
          ? communityLegend()
          : _chartMode === 'speakers'
            ? staticLegend(['First time', 'Spoken before'])
            : _chartMode === 'programme'
              ? _chartView === 'lengths' || _chartView === 'lengthShare'
                ? staticLegend((_data.lengthBuckets || []).map((b) => b.label))
                : '' // Sessions and Hours are one series; the heading names it
              : topicLegend();
  // The control bar renders its own active state (see chartControls); this keeps
  // it true when only the chart is re-rendered, e.g. after a unit click.
  syncSegmented();
}

/**
 * Move the active state on the chart's two segmented controls.
 *
 * BOTH signals have to move together. `is-on` is what the control's own CSS
 * styles, but the archive's studio skin also lights ANY pressed button inside
 * `.obs-studio` off `[aria-pressed='true']` — so toggling only the class left the
 * previously-active button still wearing the gold inset rule, and two buttons in
 * a group of two both read as selected. It looked right at load only because the
 * initial markup writes both attributes in one place (chartControls).
 */
function syncSegmented() {
  if (typeof document === 'undefined') return;
  const mark = (sel, key, want) =>
    document.querySelectorAll(sel).forEach((b) => {
      const on = b.dataset[key] === want;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    });
  mark('.obs-topic-unit', 'unit', _chartView);
  mark('.obs-topic-view', 'mode', _chartMode);
}

/**
 * People matching `term`, ONE row per person.
 *
 * Speaking, organising and volunteering are three things one human did, and they
 * all open the same page — so three result rows for `/archive/person/<name>` was
 * three doors into one room. They are merged here and the roles become the row's
 * meta line ("6 talks · 6 events · 4 events as volunteer").
 *
 * The key is the CANONICAL DISPLAY NAME, because that is what the person page
 * looks records up by (`drillHtml`). Passing a profile slug instead used to open
 * an empty page for anyone whose slug had been mapped to a real name — it only
 * appeared to work because most credits still display as their slug, where the
 * two are the same string.
 *
 * A slug still MATCHES (you search "fubarhouse", you find Karl Hepworth); it is
 * only the address that is canonical.
 *
 * @param {{speakers?: any[], credits?: any[], term: string, inScope?: (e: any) => boolean}} args
 * @returns {Array<{key: string, label: string, meta: string}>}
 */
export function peopleSearchHits({ speakers = [], credits = [], term, inScope = () => true }) {
  const t = String(term || '').toLowerCase();
  const hit = (s) =>
    String(s || '')
      .toLowerCase()
      .includes(t);

  const speakerByName = new Map();
  for (const s of speakers || []) if (s?.name) speakerByName.set(s.name, s);

  // Credits are stored one row per person PER ROLE, like the source pages. Here
  // they collapse onto the person.
  const creditsByName = new Map();
  for (const p of credits || []) {
    const name = p?.name || p?.username;
    if (!name) continue;
    if (!creditsByName.has(name)) creditsByName.set(name, []);
    creditsByName.get(name).push(p);
  }

  // Match on either half, then build the row from BOTH halves: finding someone by
  // their slug must still show the talks they gave under their real name.
  const names = [];
  for (const name of speakerByName.keys()) if (hit(name)) names.push(name);
  for (const [name, list] of creditsByName) {
    if (names.includes(name)) continue;
    if (hit(name) || list.some((p) => hit(p?.username))) names.push(name);
  }

  const rows = [];
  for (const name of names) {
    const spk = speakerByName.get(name);
    const parts = [];
    if (spk) parts.push(`${plural(spk.appearances, 'talk')} · ${plural(spk.events, 'event')}`);
    for (const p of creditsByName.get(name) || []) {
      const evs = (p.detail || []).filter((e) => inScope(e));
      if (evs.length) parts.push(`${plural(evs.length, 'event')} as ${p.role}`);
    }
    // Credits that are all out of scope and no talks: the person is not in this
    // slice of the archive, so the row would lead to an empty page.
    if (!parts.length) continue;
    rows.push({ key: name, label: name, meta: parts.join(' · ') });
  }
  return rows;
}

// ── Archive-wide search (speakers, sponsors, series, events) ──────────────────
function renderSearch(q) {
  const box = $('obsResults');
  if (!box) return;
  const term = q.trim().toLowerCase();
  if (term.length < 2) {
    box.innerHTML = '';
    box.classList.remove('is-open');
    return;
  }
  const v = _view || computeView();
  const all = _series === 'All';
  const hits = [];
  const add = (drill, key, label, meta) => hits.push({ drill, key, label, meta });
  // Speakers and credited organisers/volunteers are one population: see
  // peopleSearchHits.
  for (const h of peopleSearchHits({
    speakers: v.speakers || [],
    credits: _data?.credits?.people || [],
    term,
    inScope,
  }))
    add('person', h.key, h.label, h.meta);
  for (const s of v.sponsors || [])
    if (s.title.toLowerCase().includes(term))
      add(
        'sponsor',
        s.title,
        s.title,
        `${plural(s.events, 'event')}${s.tiers[0] ? ` · ${s.tiers[0]}` : ''}`,
      );
  if (all)
    for (const s of _data.series || [])
      if (s.name.toLowerCase().includes(term))
        add('series', s.name, s.name, plural(s.events, 'event'));
  for (const [yr, evs] of Object.entries(_data.yearEvents || {}))
    for (const e of evs)
      if (inScope({ ...e, year: Number(yr) }) && e.label.toLowerCase().includes(term))
        add('year', yr, e.label, plural(e.sessions, 'session'));
  hits.sort(
    (a, b) =>
      (b.label.toLowerCase().startsWith(term) ? 1 : 0) -
      (a.label.toLowerCase().startsWith(term) ? 1 : 0),
  );
  const cap = hits.slice(0, 40);
  // Names are only half of what people look for; the other half is what was
  // said — and the archive is mostly sessions, so what you typed is more often a
  // subject than a person. This led the list at the BOTTOM, under up to forty
  // names, which is where a reader stops scrolling. It goes first now, and the
  // name matches follow it.
  const sessions = `<button type="button" class="obs-result obs-result--sessions" data-sessions="${esc(q)}">
      <span class="obs-result-badge">sessions</span>
      <span class="obs-result-main"><span class="obs-result-name">Search sessions for “${esc(q)}”</span>
      <span class="obs-result-meta">titles, descriptions and speakers</span></span>
    </button>`;
  box.innerHTML =
    sessions +
    (cap.length
      ? cap
          .map(
            (h) =>
              `<button type="button" class="obs-result" data-drill="${h.drill}" data-key="${esc(String(h.key))}"><span class="obs-result-badge obs-result-badge--${h.drill}">${h.drill}</span><span class="obs-result-main"><span class="obs-result-name">${esc(h.label)}</span><span class="obs-result-meta">${esc(h.meta)}</span></span></button>`,
          )
          .join('') +
        (hits.length > cap.length
          ? `<div class="obs-result-more">+${hits.length - cap.length} more — keep typing</div>`
          : '')
      : `<div class="obs-result-none">No name matches for “${esc(q)}”.</div>`);
  box.classList.add('is-open');
}

// A ranked list capped at _rankN[kind], with a Show-more / Show-less footer and a
// scroll container once it grows past the initial dozen.
function rankBlock(kind, list, nameKey, metaFn) {
  // A dozen, and no Show-more. The full list is not a browsing surface — search
  // reaches any name directly, and every record has its own page.
  const total = list.length;
  const rows = rankList(list.slice(0, RANK_MIN), nameKey, metaFn, kind);
  const note =
    total > RANK_MIN
      ? `<p class="obs-rank-count">Top ${RANK_MIN} of ${num(total)} — search for any other</p>`
      : `<p class="obs-rank-count">${num(total)} in scope</p>`;
  return `<div class="obs-rank-wrap">${rows}</div>${note}`;
}

function renderRanks() {
  const sp = $('obsSpeakerPanel');
  if (sp)
    sp.innerHTML = rankBlock(
      'speaker',
      _view.speakers || [],
      'name',
      (r) => `${plural(r.appearances, 'talk')} · ${plural(r.events, 'event')}`,
    );
  const so = $('obsSponsorPanel');
  if (so)
    so.innerHTML = rankBlock(
      'sponsor',
      _view.sponsors || [],
      'title',
      (r) => `${plural(r.events, 'event')}${r.tiers.length ? ` · ${r.tiers[0]}` : ''}`,
    );
}

function scopeSummary() {
  const parts = [_series, _region, _country, _year].filter((x) => x !== 'All');
  return parts.length ? `in ${parts.join(' · ')}` : 'across every series';
}
/**
 * The People tile: one figure for how many humans the archive holds, and the
 * three roles it is made of.
 *
 * It was "Speakers", which stopped being true the moment organisers and
 * volunteers were captured — 91 organisers and 346 volunteers were in the data
 * and nothing on the homepage said so.
 *
 * The breakdown is a METER, not a third line of text, because the hero is a flex
 * row of content-sized tiles: "4,137 speakers · 91 organisers · 346 volunteers"
 * is ~45 characters, which would roughly triple this tile's width and push the
 * row onto a second line — on a phone it would take the whole width by itself.
 * The meter is a fixed 4.5rem whatever the numbers say, so the row can never
 * wrap because of it, and it answers the question the counts are usually asked
 * for at a glance: how much of this community is running the events versus
 * speaking at them. The exact figures ride on `title` + `aria-label`, and the
 * Organisers and Volunteers rankings below carry them in full.
 *
 * Total is DISTINCT PEOPLE, not the sum: someone who spoke at one event and
 * volunteered at another is one person, and the roles overlap heavily.
 */
function peopleTile(v, organisers, volunteers) {
  const names = new Set((v.speakers || []).map((r) => r.name));
  for (const r of [...organisers, ...volunteers]) names.add(r.name);
  const parts = [
    { n: (v.stats || {}).speakers || 0, label: 'speakers', color: 'var(--viz-1)' },
    { n: organisers.length, label: 'organisers', color: 'var(--viz-2)' },
    { n: volunteers.length, label: 'volunteers', color: 'var(--viz-3)' },
  ].filter((p) => p.n > 0);
  const full = parts.map((p) => `${num(p.n)} ${p.label}`).join(' · ');
  const meter = parts.length
    ? `<span class="obs-people" role="img" aria-label="${esc(full)}">${parts
        .map(
          (p) =>
            `<span class="obs-people-seg" style="flex-grow:${p.n};background:${p.color}" title="${esc(`${num(p.n)} ${p.label}`)}"></span>`,
        )
        .join('')}</span>`
    : '';
  return `<div class="obs-tile" title="${esc(full)}">
      <div class="obs-tile-n">${num(names.size)}</div>
      <div class="obs-tile-l">People involved</div>
      <div class="obs-tile-s">${meter}</div>
    </div>`;
}

/**
 * Programme time, in the unit a reader thinks in.
 *
 * Every session in the archive records its length (`P<n>M`) and nothing used it.
 * Hours are the honest unit up to a point — 6,905 of them is a number nobody can
 * hold — so past a year's worth it also says how many days that is, which is the
 * scale the answer actually lives at.
 */
function programmeHours(minutes) {
  const h = Math.round((minutes || 0) / 60);
  if (!h) return '';
  const days = h / 24;
  return days >= 20 ? `${num(h)} hours · ${Math.round(days)} days` : `${num(h)} hours`;
}

/**
 * "organiser/volunteer credits are captured for 1 of 84 events" — the same
 * sentence the credit rankings carry (`creditsNote`), said where the CHART is,
 * because the organiser and volunteer lines are drawn from that same fraction and
 * a line on a chart reads as the whole population unless something says otherwise.
 */
function creditsCoverageNote() {
  const c = creditsCoverage({
    events: _data ? flatEvents() : [],
    people: _data?.credits?.people || [],
    inScope: (e) => inScope(e),
  });
  if (!c.events) return 'no events in scope';
  if (!c.withCredits) return 'no organiser/volunteer credits captured yet';
  return `organiser/volunteer credits are captured for ${num(c.withCredits)} of ${num(c.events)} events`;
}

/** "recorded for 12 of 84 events" — the sentence the attendance chart cannot ship without. */
function attendanceCoverage() {
  let have = 0;
  let total = 0;
  for (const e of flatEvents())
    if (inScope(e)) {
      total += 1;
      if (Number.isFinite(e.attendance)) have += 1;
    }
  return total ? `recorded for ${num(have)} of ${num(total)} events` : 'no events in scope';
}

/**
 * The chart's controls: WHAT is being measured on the left, HOW it is being shown
 * on the right, on a line of their own.
 *
 * They used to share the heading row, which put a set that never changes (the
 * modes) beside a set that changes with every mode (the units) — so picking a
 * mode moved the buttons you had just been aiming at. Splitting them means the
 * left group is muscle memory and the right group is free to be whatever the
 * current mode needs, including nothing.
 */
/** The sentence under the chart: one per (subject, view), so each says what IT is. */
function chartNote(scopeLabel) {
  const notes = {
    programme: {
      sessions: `Total sessions per year ${scopeLabel} — click a year to open its events.`,
      hours: `Hours of programme per year ${scopeLabel}, from each session's own recorded length — the size of the thing that was built, not the count of its pieces.`,
      lengths: `Sessions per year ${scopeLabel} by how long they ran — the shape of a programme, not its size.`,
      lengthShare: `The same length mix as a share of each year ${scopeLabel}, so a 500-session year and a 200-session one can be compared.`,
    },
    speakers: {
      who: `Speakers per year ${scopeLabel}, split by whether the archive had seen them before — click a year for that year's first-timers. First appearance <em>in this archive</em>, which is not the same as a first talk: the archive does not hold every event.`,
      whoShare: `How much of each year's cast ${scopeLabel} was new. The two halves are the whole cast, so they always reach 100%.`,
      slots: `Average session length ${scopeLabel}, for people in their first year against people who had spoken before — does a newcomer get a shorter slot? Averaged over slots, not people.`,
      brackets: `Each length bracket on its own axis ${scopeLabel}, first-time speakers against returning ones — one y-scale across all six, so the brackets stay comparable.`,
    },
    sponsors: {
      count: `Distinct organisations sponsoring an event each year ${scopeLabel}. Counted once per year however many events they backed — names matched through the curation ledger, so a company spelled two ways is one sponsor.`,
      tiers: `Sponsorship levels per year ${scopeLabel}, in each event's own words. These are <em>not</em> one ladder: some events sell metals, others sell roles, and nothing here claims a Champion equals a Gold. The long tail folds into "Other tiers".`,
      loyalty: `Sponsoring organisations per year ${scopeLabel}, split by whether they had backed an event before — how much of the funding base is returning. Organisations, not people, which is why they are not one of the population lines.`,
    },
    community: {
      peak: `Attendees, speakers, organisers, volunteers and sponsors per year ${scopeLabel}. They differ by orders of magnitude, so <strong>% of peak</strong> scales each against its own best year — shapes are comparable, sizes are not. A series with a single year of data is left out here: against its own peak it can only be 100%. Switch series on and off below. Attendance is ${attendanceCoverage()}; ${creditsCoverageNote()}.`,
      count: `The five populations at their real sizes ${scopeLabel} — thousands of attendees against dozens of organisers, which is exactly why <strong>% of peak</strong> exists. Attendance is ${attendanceCoverage()}; ${creditsCoverageNote()}.`,
    },
  };
  return (
    notes[_chartMode]?.[_chartView] ||
    (_chartView === 'share'
      ? `Keywords mined from session titles + descriptions ${scopeLabel}. <strong>Share is of the sessions that HAVE a description</strong> — coverage swings from 35% to 100% across the years, and dividing by every session would read a gap in the archive as a fall in interest. Switch to Count for raw matches.`
      : `Keywords mined from session titles + descriptions ${scopeLabel} · add any word or phrase · pin the subjects you care about.`)
  );
}

function chartControls() {
  const views = VIEWS[_chartMode] || [];
  return `<div class="obs-chart-bar">
    <span class="obs-topic-views" role="group" aria-label="What to chart">
      ${MODES.map(
        ([mode, text]) =>
          `<button type="button" class="obs-topic-view${_chartMode === mode ? ' is-on' : ''}" data-mode="${mode}" aria-pressed="${_chartMode === mode}">${text}</button>`,
      ).join('')}
    </span>
    ${
      views.length > 1
        ? `<span class="obs-topic-units" role="group" aria-label="How to show it">
            ${views
              .map(
                ([key, text]) =>
                  `<button type="button" class="obs-topic-unit${_chartView === key ? ' is-on' : ''}" data-unit="${key}" aria-pressed="${_chartView === key}">${text}</button>`,
              )
              .join('')}
          </span>`
        : ''
    }
  </div>`;
}

/**
 * The filter bar every home view shares: free-text lookup plus the four scope
 * selects. One copy, because a filter that exists on one tab and not another is a
 * filter the reader has to re-apply — and the scope is deliberately global.
 */
function homeTopbar() {
  const yearsDesc = yearsDescList();
  return `
    <div class="obs-topbar">
      <div class="obs-search">
        <label class="sr-only" for="obsSearch">Search speakers, sponsors, events and series</label>
        <input id="obsSearch" type="search" class="obs-search-input" placeholder="Search speakers, sponsors, events, series…" autocomplete="off" spellcheck="false">
        <div class="obs-results" id="obsResults"></div>
      </div>
      <div class="obs-scopes">
        <div class="obs-scope"><label class="obs-scope-l" for="obsSeries">Series</label>
          <select id="obsSeries" class="obs-series-filter">${seriesOptions()}</select></div>
        <div class="obs-scope"><label class="obs-scope-l" for="obsRegion">Region</label>
          <select id="obsRegion" class="obs-series-filter">${[
            `<option value="All"${_region === 'All' ? ' selected' : ''}>All regions</option>`,
            ...(_data.facetRegions || []).map(
              (r) =>
                `<option value="${esc(r)}"${r === _region ? ' selected' : ''}>${esc(regionLabel(r))}</option>`,
            ),
          ].join('')}</select></div>
        <div class="obs-scope"><label class="obs-scope-l" for="obsCountry">Country</label>
          <select id="obsCountry" class="obs-series-filter">${facetOptions(_data.facetCountries, _country, 'All countries')}</select></div>
        <div class="obs-scope"><label class="obs-scope-l" for="obsYear">Year</label>
          <select id="obsYear" class="obs-series-filter">${facetOptions(yearsDesc, _year, 'All years')}</select></div>
      </div>
    </div>`;
}

/** The view-mode switch. Sub-tabs, not pages: the scope below them does not change. */
function homeTabsHtml() {
  return `
    <div class="obs-subtabs" role="tablist" aria-label="Archive view">
      ${HOME_TABS.map(
        ([id, label]) =>
          `<button type="button" role="tab" class="obs-subtab${
            id === _homeTab ? ' is-on' : ''
          }" aria-selected="${id === _homeTab}" data-home-tab="${id}">${esc(label)}</button>`,
      ).join('')}
    </div>`;
}

/** Render whichever home view is selected. */
function renderHome() {
  if (_homeTab === 'videos') return renderVideos();
  if (_homeTab === 'albums') return renderAlbums();
  return renderDashboard();
}

/** Switch view mode, keeping the scope and putting the mode in the URL. */
function setHomeTab(tab, { push = true } = {}) {
  if (!HOME_TABS.some(([id]) => id === tab)) return;
  _homeTab = tab;
  _videoOffset = 0;
  _videoRows = [];
  if (push && typeof history !== 'undefined') {
    const path = tab === 'overview' ? '/archive' : `/archive/${tab}`;
    const qs = tab === 'videos' && _videoQ ? `?q=${encodeURIComponent(_videoQ)}` : '';
    history.pushState({ homeTab: tab }, '', `${path}${qs}`);
  }
  renderHome();
}

// ── Videos ────────────────────────────────────────────────────────────────────
//
// A search over the 2,000-odd recordings the archive knows about. It runs on the
// same endpoint as the session search with `video=1`, so the scope filters, the
// whole-word matching and the paging all behave the way they do everywhere else.
// The difference is that an empty query is meaningful here: it browses.

/** One result card. The thumbnail is YouTube's own still; other hosts get a badge. */
function videoCardHtml(r) {
  const thumb = videoThumb(r.video);
  const { host } = videoRef(r.video);
  const mins = Number.isFinite(r.minutes) && r.minutes > 0 ? `${r.minutes} min` : '';
  const meta = [r.event, mins].filter(Boolean).join(' · ');
  return `
    <a class="obs-vid" href="${esc(r.video)}" target="_blank" rel="noopener noreferrer">
      <span class="obs-vid-thumb${thumb ? '' : ' obs-vid-thumb--none'}">
        ${
          thumb
            ? `<img src="${esc(thumb)}" alt="" loading="lazy" decoding="async" width="320" height="180">`
            : `<span class="obs-vid-host">${esc(host || 'Video')}</span>`
        }
        <span class="obs-vid-play" aria-hidden="true">▶</span>
      </span>
      <span class="obs-vid-body">
        <span class="obs-vid-title">${esc(r.title)}</span>
        ${r.speakers ? `<span class="obs-vid-speakers">${esc(r.speakers)}</span>` : ''}
        <span class="obs-vid-meta">${esc(meta)}</span>
        ${r.track ? `<span class="obs-vid-track">${esc(r.track)}</span>` : ''}
      </span>
    </a>`;
}

async function renderVideos() {
  const body = $('obsBody');
  if (!body) return;
  destroyMap();
  destroyStripMap();
  setCrumbs();

  const shell = (inner) => `
    ${homeTopbar()}
    ${homeTabsHtml()}
    <form class="obs-vid-search" data-vid-form="1">
      <label class="sr-only" for="obsVideoQ">Search recordings</label>
      <input id="obsVideoQ" type="search" class="obs-search-input" value="${esc(_videoQ)}"
        placeholder="Search recordings — a person, a topic, an event…" autocomplete="off" spellcheck="false">
      <button type="submit" class="obs-vid-go">Search</button>
      <button type="button" class="obs-vid-reset" data-vid-reset="1"${
        _videoQ || facetsActive() ? '' : ' disabled'
      }>Reset</button>
      <span class="obs-sess-mode" role="group" aria-label="Word matching">
        <button type="button" class="obs-sess-mode__btn${_sessMode === 'exact' ? ' is-on' : ''}"
                data-vid-mode="exact" aria-pressed="${_sessMode === 'exact'}">Whole words</button>
        <button type="button" class="obs-sess-mode__btn${_sessMode === 'contains' ? ' is-on' : ''}"
                data-vid-mode="contains" aria-pressed="${_sessMode === 'contains'}">Contains</button>
      </span>
    </form>
    ${inner}`;

  body.innerHTML = shell('<p class="obs-sub" data-vid-count>Searching recordings…</p>');

  const params = new URLSearchParams({ q: _videoQ, video: '1' });
  params.set('mode', _sessMode);
  params.set('limit', String(VIDEO_PAGE));
  params.set('offset', String(_videoOffset));
  if (_series !== 'All') params.set('series', _series);
  if (_region !== 'All') params.set('region', _region);
  if (_country !== 'All') params.set('country', _country);
  if (_year !== 'All') params.set('year', String(_year));

  let data;
  try {
    const r = await fetch(new URL(`../../api/archive/sessions?${params}`, import.meta.url));
    data = r.ok ? await r.json() : null;
  } catch {
    data = null;
  }
  // The tab may have been switched while the request was in flight.
  if (_homeTab !== 'videos') return;
  if (!data) {
    body.innerHTML = shell('<p class="obs-sub">Could not reach the archive search.</p>');
    return;
  }

  // Offset 0 is a new search; anything else is the next page of the same one.
  _videoRows = _videoOffset === 0 ? data.results : _videoRows.concat(data.results);
  const shown = _videoRows.length;
  const more = shown < data.total;
  // scopeSummary() supplies its own preposition — "in 2024", "across every
  // series" — so it is appended, not introduced.
  const count = _videoQ
    ? `${num(data.total)} recording${data.total === 1 ? '' : 's'} match “${esc(_videoQ)}” ${esc(scopeSummary())}`
    : `${num(data.total)} recording${data.total === 1 ? '' : 's'} ${esc(scopeSummary())}`;

  body.innerHTML = shell(`
    <p class="obs-sub" data-vid-count>${count}${
      shown < data.total ? ` · showing ${num(shown)}` : ''
    }</p>
    ${
      _videoRows.length
        ? `<div class="obs-vid-grid">${_videoRows.map(videoCardHtml).join('')}</div>`
        : `<p class="obs-topic-empty">No recordings here yet. ${
            _videoQ ? 'Try a different term, or' : 'Try'
          } widening the filters.</p>`
    }
    ${more ? `<div class="obs-more-wrap"><button type="button" class="obs-more" data-vid-more="1">Show ${num(Math.min(VIDEO_PAGE, data.total - shown))} more</button></div>` : ''}
  `);
  if (typeof history !== 'undefined' && _videoOffset === 0) {
    // replaceState, not push: typing a new term is a refinement of this view, not
    // a new place — Back should leave the videos, not walk the search history.
    const qs = _videoQ ? `?q=${encodeURIComponent(_videoQ)}` : '';
    const mode = _sessMode === 'contains' ? `${qs ? '&' : '?'}match=contains` : '';
    history.replaceState({ homeTab: 'videos' }, '', `/archive/videos${qs}${mode}`);
  }
  const input = $('obsVideoQ');
  if (input && _videoQ) {
    // Keep the caret where the reader left it rather than at position 0.
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

// ── Photo albums ──────────────────────────────────────────────────────────────
//
// Event-level, and only the events that have one: this view is for looking at
// pictures. Which events are MISSING an album is a curation question, and the
// coverage report already answers it.

async function renderAlbums() {
  const body = $('obsBody');
  if (!body) return;
  destroyMap();
  destroyStripMap();
  setCrumbs();
  const rows = albumRows(_data?.yearEvents, (e) => inScope(e));
  body.innerHTML = `
    ${homeTopbar()}
    ${homeTabsHtml()}
    <p class="obs-sub">${
      rows.length
        ? `${plural(rows.length, 'photo album')} ${esc(scopeSummary())}`
        : 'No photo albums recorded for this scope.'
    }</p>
    ${
      rows.length
        ? `<div class="obs-album-grid">${rows
            .map(
              (r) => `
        <a class="obs-album" href="${esc(r.album)}" target="_blank" rel="noopener noreferrer" data-album="${esc(r.album)}">
          <span class="obs-album-cover" aria-hidden="true"></span>
          <span class="obs-album-body">
            <span class="obs-album-year">${r.year}</span>
            <span class="obs-album-name">${esc(r.label)}</span>
            <span class="obs-album-meta">${esc(r.provider)} · ${plural(r.sessions || 0, 'session')}</span>
          </span>
        </a>`,
            )
            .join('')}</div>`
        : `<p class="obs-topic-empty">Albums are recorded per event. Widen the filters, or add one to an event in the editor.</p>`
    }`;
  fillAlbumCovers();
}

/**
 * Fill in each album's cover image.
 *
 * The cards do not wait for this: a grid of names is useful immediately, and the
 * pictures arrive as each one resolves. Answers are cached server-side, so this
 * is only slow the first time an album is ever shown.
 */
async function fillAlbumCovers() {
  const cards = [...document.querySelectorAll('.obs-album[data-album]')];
  for (const card of cards) {
    const url = card.dataset.album;
    if (!url || card.dataset.coverDone) continue;
    card.dataset.coverDone = '1';
    try {
      const r = await fetch(
        new URL(`../../api/archive/album-thumb?url=${encodeURIComponent(url)}`, import.meta.url),
      );
      if (!r.ok) continue;
      const { thumb } = await r.json();
      // The reader may have switched tabs or filters while this was in flight.
      if (!thumb || !card.isConnected) continue;
      const slot = card.querySelector('.obs-album-cover');
      if (slot) {
        slot.innerHTML = `<img src="${esc(thumb)}" alt="" loading="lazy" decoding="async">`;
        slot.classList.add('has-cover');
      }
    } catch {
      /* no cover is a fine outcome — the card already says what the album is */
    }
  }
}

function renderDashboard() {
  setCrumbs();
  const v = computeView();
  // Top 12, matching the speaker and sponsor ranks. Full lists stay reachable
  // through search.
  const organisers = scopedCredits('organiser');
  const volunteers = scopedCredits('volunteer');
  const s = v.stats || {};
  const all = _series === 'All';
  const scopeLabel = scopeSummary();
  // "By series" is meaningless once a single series is chosen — give sponsor tiers
  // the full width instead.
  const breakdowns = all
    ? `<div class="obs-grid">
        <div>${sectionHeading(`By series`, `${_chartMode === 'programme' && _chartView === 'sessions' ? 'sessions' : 'events'}`)}<div class="obs-panel">${hbars(scopedSeriesRows(), 'name', _chartMode === 'programme' && _chartView === 'sessions' ? 'sessions' : 'events', 'series')}</div></div>
        <div>${sectionHeading(`Sponsor tiers`)}<div class="obs-panel">${hbars((v.tiers || []).slice(0, 8), 'tier', 'count')}</div></div>
      </div>`
    : `${sectionHeading(`Sponsor tiers`)}<div class="obs-panel">${(v.tiers || []).length ? hbars(v.tiers.slice(0, 8), 'tier', 'count') : '<p class="obs-topic-empty">No tiered sponsors recorded for this series.</p>'}</div>`;
  $('obsBody').innerHTML = `
    ${homeTopbar()}
    ${homeTabsHtml()}
    <div class="obs-hero">
      <div class="obs-tile obs-tile--gold"><div class="obs-tile-n">${s.events}</div><div class="obs-tile-l">Events</div><div class="obs-tile-s">${all ? `${s.series || _data.stats.series} series` : esc(_series)}</div></div>
      <div class="obs-tile"><div class="obs-tile-n">${s.yearCount ?? s.yearMax - s.yearMin + 1}</div><div class="obs-tile-l">Years covered</div><div class="obs-tile-s">${s.yearMin}–${s.yearMax}</div></div>
      <div class="obs-tile"><div class="obs-tile-n">${num(s.sessions)}</div><div class="obs-tile-l">Sessions</div><div class="obs-tile-s">${programmeHours(s.minutes)}</div></div>
      ${peopleTile(v, organisers, volunteers)}
      <div class="obs-tile"><div class="obs-tile-n">${num(s.sponsors)}</div><div class="obs-tile-l">Sponsors</div><div class="obs-tile-s">${num(s.sponsorSlots)} slots</div></div>
    </div>
    <div class="obs-stripmap-wrap">
      <div class="obs-stripmap-map">
        <div class="obs-stripmap" id="obsStripMap"></div>
        <div class="obs-mapfilters" id="obsMapFilters"></div>
      </div>
      <aside class="obs-globe" id="obsGlobe"></aside>
    </div>
    <div class="obs-section">
      ${sectionHeading(`The archive over time`, `bar = sessions · number = events`)}
      <div class="obs-panel">${yearsChart(v.years || [])}</div>
    </div>
    <div class="obs-section">
      <div class="obs-section-t">
        <h2 class="obs-section-h">${
          {
            programme: {
              sessions: 'How busy the archive was',
              hours: 'How much programme there was',
              lengths: 'How long a session runs',
              lengthShare: 'How long a session runs',
            }[_chartView],
            speakers: {
              who: 'Who was on the programme',
              whoShare: 'Who was on the programme',
              slots: 'How long a slot each group gets',
              brackets: 'Which slots each group gets',
            }[_chartView],
            sponsors: {
              count: 'How many organisations backed the community',
              tiers: 'What they bought',
              loyalty: 'Who keeps backing the community',
            }[_chartView],
            community: 'The community, side by side',
          }[_chartMode] || 'What the community talked about'
        }</h2>
      </div>
      ${chartControls()}
      <p class="obs-section-note obs-topic-sub">${chartNote(scopeLabel)}</p>
      <div class="obs-panel">
        <div class="obs-topic-chart" id="obsTopicChart"></div>
        <div class="obs-topic-legend" id="obsTopicLegend"></div>
      </div>
    </div>
    <div class="obs-section">${breakdowns}</div>
    <div class="obs-section"><div class="obs-grid">
      <div>${sectionHeading(`Most prolific speakers`, `click for their journey`)}<div class="obs-panel" id="obsSpeakerPanel"></div></div>
      <div>${sectionHeading(`Longest-standing sponsors`)}<div class="obs-panel" id="obsSponsorPanel"></div></div>
    </div></div>
    <div class="obs-section"><div class="obs-grid">
      <div>${sectionHeading(`Organisers`, creditsNote(organisers))}<div class="obs-panel">${creditsPanel(organisers)}</div></div>
      <div>${sectionHeading(`Volunteers`, creditsNote(volunteers))}<div class="obs-panel">${creditsPanel(volunteers)}</div></div>
    </div></div>`;
  renderTopics();
  renderRanks();
  initStripMap();
}
function onBodyClick(e) {
  const clr = e.target.closest('[data-clear]');
  if (clr) {
    const f = clr.dataset.clear;
    if (f === 'series') {
      saveTopicSel();
      _series = 'All';
      _topicSel = null;
      persistPrefs();
    } else if (f === 'region') _region = 'All';
    else if (f === 'country') _country = 'All';
    else if (f === 'year') _year = 'All';
    _rankN = { speaker: RANK_MIN, sponsor: RANK_MIN };
    _videoOffset = 0;
    _videoRows = [];
    destroyMap();
    destroyStripMap();
    renderHome();
    return;
  }
  // ── Videos: submit, reset, word matching ────────────────────────────────────
  if (e.target.closest('[data-vid-reset]')) {
    _videoQ = '';
    _series = 'All';
    _region = 'All';
    _country = 'All';
    _year = 'All';
    _videoOffset = 0;
    _videoRows = [];
    renderVideos();
    return;
  }
  const modeBtn = e.target.closest('[data-vid-mode]');
  if (modeBtn) {
    _sessMode = modeBtn.dataset.vidMode === 'contains' ? 'contains' : 'exact';
    _videoOffset = 0;
    _videoRows = [];
    renderVideos();
    return;
  }
  // ── Home view modes ─────────────────────────────────────────────────────────
  const tabBtn = e.target.closest('[data-home-tab]');
  if (tabBtn) {
    setHomeTab(tabBtn.dataset.homeTab);
    return;
  }
  if (e.target.closest('[data-vid-more]')) {
    _videoOffset += VIDEO_PAGE;
    renderVideos();
    return;
  }
  const mapToggle = e.target.closest('[data-mapid-toggle]');
  if (mapToggle) {
    const form = mapToggle.parentElement?.querySelector('.obs-mapid-form');
    if (form) {
      form.hidden = !form.hidden;
      if (!form.hidden) form.querySelector('.obs-mapid-input')?.focus();
    }
    return;
  }
  const mapGo = e.target.closest('[data-mapid-confirm]');
  if (mapGo) {
    mapIdentity(
      mapGo.dataset.kind,
      mapGo.dataset.name,
      $('obsMapidInput')?.value,
      mapGo.dataset.slug,
    );
    return;
  }
  const toSessions = e.target.closest('[data-sessions]');
  if (toSessions) {
    const q = toSessions.dataset.sessions;
    showSessionSearch(q);
    if (typeof history !== 'undefined') {
      history.pushState({ sessions: q, match: _sessMode }, '', sessionPath(q, _sessMode));
    }
    return;
  }
  const sessRow = e.target.closest('[data-sessexp]');
  if (sessRow) {
    const panel = document.getElementById(`obsSessDetail-${sessRow.dataset.sessexp}`);
    if (panel) {
      const open = !panel.hasAttribute('hidden');
      panel.toggleAttribute('hidden', open);
      sessRow.classList.toggle('is-open', !open);
    }
    return;
  }
  const talkRow = e.target.closest('[data-talkexp]');
  if (talkRow) {
    expandTalks(talkRow);
    return;
  }
  const pin = e.target.closest('[data-pin]');
  if (pin) {
    const t = pin.dataset.pin;
    const i = _pinned.indexOf(t);
    if (i >= 0) _pinned.splice(i, 1);
    else {
      _pinned.push(t); // pinning also shows it on the chart
      _topicSel.add(t);
    }
    saveTopicSel(); // persists sel + pinned
    renderTopics();
    return;
  }
  const chip = e.target.closest('[data-topic]');
  if (chip) {
    const t = chip.dataset.topic;
    if (_topicSel.has(t)) _topicSel.delete(t);
    else _topicSel.add(t);
    saveTopicSel();
    renderTopics();
    return;
  }
  const view = e.target.closest('.obs-topic-view');
  if (view) {
    const next = view.dataset.mode;
    if (_chartMode !== next) {
      _chartMode = next;
      // Minutes belongs to People, By-speaker to Lengths. Carrying either into a
      // mode that does not offer it leaves every unit button unlit and the chart
      // silently counting — so a unit the new mode cannot show falls back.
      // A view belongs to its subject; entering a subject opens its default one.
      if (!VIEWS[next]?.some(([k]) => k === _chartView)) _chartView = DEFAULT_VIEW[next] || 'count';
      persistPrefs();
      renderDashboard(); // header/controls/legend all change with the mode
    }
    return;
  }
  const comm = e.target.closest('[data-community]');
  if (comm) {
    const key = comm.dataset.community;
    // Never leave the chart with nothing on it: the last series stays put.
    if (_communitySel.has(key) && _communitySel.size > 1) _communitySel.delete(key);
    else _communitySel.add(key);
    persistPrefs();
    renderTopics();
    return;
  }
  const unit = e.target.closest('.obs-topic-unit');
  if (unit) {
    _chartView = unit.dataset.unit;
    persistPrefs();
    renderTopics();
    return;
  }
  const more = e.target.closest('[data-more]');
  if (more) {
    const kind = more.dataset.more;
    const total = (_view[kind === 'speaker' ? 'speakers' : 'sponsors'] || []).length;
    _rankN[kind] = more.dataset.collapse ? RANK_MIN : Math.min(total, _rankN[kind] + RANK_STEP);
    renderRanks();
    return;
  }
  if (e.target.closest('#obsTopicChart')) {
    const hit = chartHit(e);
    if (hit?.term) {
      hideChartTip();
      // Sessions view: a point is a year → open that year's events, like the bar chart.
      if (_chartMode === 'speakers' && (_chartView === 'who' || _chartView === 'whoShare')) {
        openDebutDrill(hit.year);
        if (typeof history !== 'undefined')
          history.pushState({ debuts: hit.year }, '', debutPath(hit.year));
      } else if (_chartMode === 'programme' || _chartMode === 'community') {
        // Same drill the year bars open, so it gets the same URL: clicking a point
        // and clicking a column must be the same act, refreshable either way.
        showDrill('year', String(hit.year));
        if (typeof history !== 'undefined')
          history.pushState(
            { drill: 'year', key: String(hit.year) },
            '',
            drillPath('year', hit.year),
          );
      } else {
        openTopicDrill(hit.term, hit.year);
        if (typeof history !== 'undefined')
          history.pushState({ topic: hit.term, year: hit.year }, '', topicPath(hit.term, hit.year));
      }
    }
    return;
  }
  if (e.target.closest('[data-back]')) {
    destroyMap();
    renderHome();
    setCrumbs();
    toTopOfView();
    if (typeof history !== 'undefined')
      history.pushState({}, '', _homeTab === 'overview' ? '/archive' : `/archive/${_homeTab}`);
    return;
  }
  const hit = e.target.closest('[data-drill]');
  if (!hit) return;
  const type = hit.dataset.drill;
  const key = hit.dataset.key;
  destroyMap();
  destroyStripMap();
  $('obsBody').innerHTML = drillHtml(type, key);
  toTopOfView();
  initDrillMap();
  if ((DRILL_KINDS[type] || type) === 'person') hydrateCoSpeakers(key);
  // Addressable: the drill-down gets a real URL you can send to someone.
  setCrumbs([{ label: CRUMB_LABELS[type] || type }, { label: String(key) }]);
  const kind = Object.keys(DRILL_KINDS).find((k) => DRILL_KINDS[k] === type || k === type);
  if (kind && typeof history !== 'undefined') {
    history.pushState({ drill: type, key }, '', drillPath(type, key));
  }
}

let wired = false;
// ── Keyword discovery ──────────────────────────────────────────────────────
// "What was popular?" is the question the archive is for, and until now the only
// way in was to already know a word. These two rankings answer it directly:
// the most-discussed terms overall, and the ones climbing fastest lately.
export function getTopicInsights({ limit = 8, offset = 0, window: win = 5 } = {}) {
  const ranked = currentTopics();
  if (!ranked.length) return { top: [], rising: [], year: _year, more: false };

  // The topic SCOPE deliberately ignores the year facet — the chart is a time
  // series and would collapse to a single point. The rankings are a different
  // question ("what was big in this scope?"), so they do honour it, by reading
  // that year out of each term's byYear rather than its all-time total.
  const yearSel = _year !== 'All' ? Number(_year) : null;
  const totalOf = (t) => (yearSel ? t.byYear?.[yearSel] || 0 : t.total || 0);

  const sum = (t, from, to) => {
    let n = 0;
    for (let y = from; y <= to; y += 1) n += t.byYear?.[y] || 0;
    return n;
  };

  const byTotal = [...ranked].filter((t) => totalOf(t) > 0).sort((a, b) => totalOf(b) - totalOf(a));
  const top = byTotal
    .slice(offset, offset + limit)
    .map((t) => ({ term: t.term, value: totalOf(t) }));

  // Share of the recent window vs the one before it. Share, not raw count, so a
  // term does not look like it is "rising" purely because the archive grew.
  const recentFrom = Y1 - win + 1;
  const priorFrom = recentFrom - win;
  const totRecent = ranked.reduce((n, t) => n + sum(t, recentFrom, Y1), 0) || 1;
  const totPrior = ranked.reduce((n, t) => n + sum(t, priorFrom, recentFrom - 1), 0) || 1;

  const rising = ranked
    .map((t) => {
      const r = sum(t, recentFrom, Y1);
      const p = sum(t, priorFrom, recentFrom - 1);
      return { term: t.term, value: (r / totRecent) * 100 - (p / totPrior) * 100, recent: r };
    })
    // A term with almost no recent sessions is noise, not a trend.
    .filter((t) => t.recent >= 3 && t.value > 0)
    .sort((a, b) => b.value - a.value);

  return {
    top,
    // "Rising" compares two five-year windows, which says nothing when the scope
    // is already pinned to a single year.
    rising: yearSel ? [] : rising.slice(offset, offset + limit),
    year: yearSel,
    more: offset + limit < byTotal.length,
  };
}

// The chart mode decides whether keyword controls mean anything at all — the
// Sessions view plots one series and has no keywords.
export function getChartMode() {
  return _chartMode;
}

// Terms currently plotted, with their palette slot, so the rail can list them
// without the legend node having to move.
export function getPlottedTopics() {
  return [...(_topicSel || [])].map((term) => ({
    term,
    color: topicColor(term),
    pinned: _pinned.includes(term),
  }));
}

// Adding a keyword searches titles + descriptions, so a phrase that is not in
// the mined vocabulary still works. Resolves to whether anything matched.
export async function addKeyword(term) {
  const t = String(term || '')
    .trim()
    .toLowerCase();
  if (!t) return false;
  if (_topicSel.has(t)) return true;
  const data = await fetchTopic(t);
  if (!Object.keys(data.byYear).length) return false;
  _topicSel.add(t);
  saveTopicSel();
  renderTopics();
  return true;
}

// Years actually represented in the archive, not an assumed span — 2007–2026 is
// twenty distinct years, and every one of them has events.
let _lastSearch = null;

export function getSearchBreakdown() {
  return _lastSearch;
}

export function getYearSpan() {
  const years = Object.keys(_data?.yearEvents || {})
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (!years.length) return null;
  const min = years[0];
  const max = years[years.length - 1];
  // Three different numbers live in this range and only one of them is "how old
  // is the community": `years` counts the calendar years that HAVE events (the
  // hero tile's figure), `max - min + 1` counts the years the range spans, and
  // `elapsed` is the anniversary count. 2007–2026 is 20 years of events and 19
  // years of community, which is why the masthead read as a contradiction.
  return { min, max, years: years.length, elapsed: max - min };
}

/**
 * The masthead line, derived so it stays true as the archive grows.
 *
 * Anniversary arithmetic, deliberately: a community whose first event was in
 * 2007 is 19 years old in 2026, and turns 20 when 2027 lands. The pluralisation
 * and the one-year case are handled because the archive is small at the start of
 * a series' life, not only at the end of it.
 *
 * @param {{min: number, max: number, elapsed: number}|null} span
 * @returns {string|null} null when there is no data yet, so the caller can leave
 *   whatever static line the page shipped with in place.
 */
export function communitySubtitle(span) {
  if (!span) return null;
  const { min, max, elapsed } = span;
  // A single year is not "0 years of the community" — it has no anniversary to
  // count yet, so it states the year instead of counting to it.
  if (elapsed < 1) return `The community in ${min}`;
  return `${elapsed} year${elapsed === 1 ? '' : 's'} of the community · ${min}–${max}`;
}

export function togglePin(term) {
  const i = _pinned.indexOf(term);
  if (i >= 0) _pinned.splice(i, 1);
  else {
    _pinned.push(term);
    _topicSel.add(term);
  }
  saveTopicSel();
  renderTopics();
}

export function isTopicOn(term) {
  return !!_topicSel && _topicSel.has(term);
}

export function toggleTopic(term) {
  if (!_topicSel) return;
  if (_topicSel.has(term)) _topicSel.delete(term);
  else _topicSel.add(term);
  saveTopicSel();
  renderTopics();
}

export function openObservatory() {
  const o = $('archiveObservatory');
  if (!o) return;
  o.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  if (!wired) {
    wired = true;
    o.querySelector('.obs-close')?.addEventListener('click', closeObservatory);
    $('obsBody').addEventListener('click', onBodyClick);
    // Enter in the field and the Search button are the same action, so both come
    // through submit rather than being wired twice.
    $('obsBody').addEventListener('submit', (e) => {
      if (!e.target.closest('[data-vid-form]')) return;
      e.preventDefault();
      _videoQ = ($('obsVideoQ')?.value || '').trim();
      _videoOffset = 0;
      _videoRows = [];
      renderVideos();
    });
    $('obsBody').addEventListener('input', (e) => {
      if (e.target.id === 'obsSearch') renderSearch(e.target.value);
      // The video query is submitted, not typed: every keystroke was a scan of
      // every dataset on the server, and a half-typed name is not a search anyone
      // meant to run.
    });
    // Emphasis — highlight one, grey the rest. Six overlapping saturated lines
    // is the classic spaghetti chart; the palette is not the problem, the
    // number of simultaneously-competing series is.
    const emphasise = (term) => {
      const chart = $('obsTopicChart');
      if (!chart) return;
      chart.querySelectorAll('.is-emph').forEach((el) => el.classList.remove('is-emph'));
      // Only emphasise a term that is actually plotted — a legend chip can name
      // an unselected keyword, and dimming every line to spotlight nothing is
      // worse than doing nothing.
      const marks = term ? chart.querySelectorAll(`[data-term="${CSS.escape(term)}"]`) : [];
      if (marks.length) {
        marks.forEach((el) => el.classList.add('is-emph'));
        chart.dataset.emph = term;
      } else {
        delete chart.dataset.emph;
      }
    };
    $('obsBody').addEventListener('pointerover', (e) => {
      const chip = e.target.closest('.obs-topic-chip[data-term]');
      if (chip) emphasise(chip.dataset.term);
    });
    $('obsBody').addEventListener('pointerout', (e) => {
      if (e.target.closest('.obs-topic-chip[data-term]')) emphasise(null);
    });
    $('obsBody').addEventListener('focusin', (e) => {
      const chip = e.target.closest('.obs-topic-chip[data-term]');
      emphasise(chip ? chip.dataset.term : null);
    });

    $('obsBody').addEventListener('mousemove', onChartMove);
    $('obsBody').addEventListener('mouseleave', () => {
      hideChartTip();
      smHoverOut();
    });
    // 'change' fires on Enter, a datalist pick, or blur — the right moment to
    // commit a (possibly custom) keyword or a new global series scope.
    $('obsBody').addEventListener('change', (e) => {
      if (e.target.id === 'obsSeries') {
        saveTopicSel(); // remember the outgoing series' selection first
        _series = e.target.value;
        _topicSel = null; // reload this series' remembered (or default) terms
        _rankN = { speaker: RANK_MIN, sponsor: RANK_MIN }; // reset list depth
        _videoOffset = 0;
        _videoRows = [];
        destroyMap();
        renderHome();
        persistPrefs();
      } else if (
        e.target.id === 'obsRegion' ||
        e.target.id === 'obsCountry' ||
        e.target.id === 'obsYear'
      ) {
        if (e.target.id === 'obsRegion') _region = e.target.value;
        if (e.target.id === 'obsCountry') _country = e.target.value;
        if (e.target.id === 'obsYear') _year = e.target.value;
        _rankN = { speaker: RANK_MIN, sponsor: RANK_MIN };
        _videoOffset = 0; // a new scope is a new result set, not page 3 of the old one
        _videoRows = [];
        destroyMap();
        renderHome();
      }
    });
    document.addEventListener('keydown', (e) => {
      if (!o.classList.contains('hidden') && e.key === 'Escape') closeObservatory();
    });
  }
  loadPrefs();
  loadInsights();
}

// The content token of the curation ledger the last payload was built from. The
// server hands it back on every insights read AND on every decision, so after a
// merge we can ask for the merged archive BY NAME.
let _curationVersion = null;
// The dataset half of that address (the catalog's generatedAt). A curation
// decision moves the token; editing an event moves this. Both belong in the URL,
// because both change the answer — see the `dataVersion` note in server.js.
let _dataVersion = null;

// Fetch (or re-fetch) the archive insights, then run `after` (default: the dashboard).
// Re-fetching is how a just-saved identity mapping shows up merged.
/**
 * @param {Function} [after]
 * @param {boolean} [fresh] fetch the archive AS OF the newest curation token,
 *   required after a decision. `cache: 'reload'` was the previous attempt: a
 *   browser can bypass its own cache, but the response is `public` and a CDN
 *   holds a shared copy, so every other visitor kept the pre-merge names. A new
 *   token is a new URL, which nothing anywhere has a stale copy of.
 */
function loadInsights(after, fresh) {
  $('obsBody').innerHTML =
    '<div style="text-align:center;padding:5rem;color:rgba(231,238,247,0.6)"><p style="margin-top:1rem">Reading the whole archive…</p></div>';
  const address = [_dataVersion, _curationVersion].filter(Boolean).join(':');
  const url =
    fresh && _curationVersion
      ? `/api/archive/insights?v=${encodeURIComponent(address)}`
      : '/api/archive/insights';
  return fetch(url)
    .then((r) => r.json())
    .then((d) => {
      _curationVersion = d.curationVersion || _curationVersion;
      _dataVersion = d.dataVersion || _dataVersion;
      _data = d;
      _scopeTopics = null; // drop any memoised topic scope from a previous dataset
      // A remembered series must still exist in this dataset.
      if (!(d.topicSeries || ['All']).includes(_series)) _series = 'All';
      (after || renderHome)();
    })
    .catch((e) => {
      $('obsBody').innerHTML =
        `<p style="padding:3rem;text-align:center">Couldn't load insights: ${esc(e.message)}</p>`;
    });
}

// "Map to another identity" from a speaker/sponsor drill — the cross-cluster case the
// clustered Studio can't reach (typos, nicknames, genuinely different spellings). Posts
// a private alias, then rebuilds so the two entries show merged.
// The same reach figures the overview carries, computed from a drill-down's own
// detail. On a speaker or sponsor page they answer "how far did this go?" in a
// line, and let the map be smaller rather than the only place that story lives.
function reachBlock(detail) {
  const placed = detail.filter((e) => e.lat != null && e.lon != null);
  const countries = new Set(detail.map((e) => e.country).filter(Boolean)).size;
  const regions = new Set(detail.map((e) => e.region).filter(Boolean)).size;
  const cities = new Set(placed.map((e) => `${e.lat},${e.lon}`)).size;
  const series = new Set(detail.map((e) => e.series).filter(Boolean)).size;
  const stat = (n, label) =>
    `<div class="obs-globe-stat"><b>${num(n)}</b><span>${label}</span></div>`;
  return `<aside class="obs-globe obs-globe--drill">
    <span class="obs-globe-eyebrow">Reach</span>
    ${stat(countries, countries === 1 ? 'country' : 'countries')}
    ${stat(regions, regions === 1 ? 'region' : 'regions')}
    ${stat(cities, cities === 1 ? 'city' : 'cities')}
    ${stat(series, series === 1 ? 'series' : 'series')}
    <span class="obs-globe-foot">${placed.length} of ${detail.length} events located</span>
  </aside>`;
}

function mapIdentityBlock(type, key, slug) {
  // A person maps onto an established SPEAKER name: that is the identity the
  // archive already knows, and it is the join the credits otherwise lack.
  const list =
    type === 'person' ? _data.speakers : type === 'speaker' ? _data.speakers : _data.sponsors;
  const nameKey = type === 'sponsor' ? 'title' : 'name';
  const opts = (list || [])
    .filter((r) => r[nameKey] !== key)
    .slice(0, 500)
    .map((r) => `<option value="${esc(r[nameKey])}"></option>`)
    .join('');
  return `<div class="obs-mapid">
    <button type="button" class="obs-mapid-toggle" data-mapid-toggle>This is actually someone else…</button>
    <div class="obs-mapid-form" hidden>
      <span class="obs-mapid-lead">Map <b>${esc(key)}</b> to a canonical identity:</span>
      <div class="obs-mapid-row">
        <input class="obs-mapid-input" id="obsMapidInput" list="obsMapidList" placeholder="Canonical name…" autocomplete="off" spellcheck="false">
        <datalist id="obsMapidList">${opts}</datalist>
        <button type="button" class="obs-mapid-go" data-mapid-confirm data-name="${esc(key)}" data-kind="${type}" data-slug="${esc(slug || key)}">Map</button>
      </div>
      <p class="obs-mapid-note">Private mapping — the datasets are never changed.</p>
    </div>
  </div>`;
}

async function mapIdentity(type, name, canonical, slug) {
  const target = String(canonical || '').trim();
  if (!target || target === name) return;
  try {
    const res = await fetch('/api/curation/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, canonical: target }),
    });
    // The token of the ledger INCLUDING this mapping — the address the merged
    // archive now lives at.
    const body = await res.json().catch(() => null);
    if (body?.version) _curationVersion = body.version;
  } catch {
    /* offline — nothing saved */
  }
  destroyMap();
  loadInsights(() => {
    if (type === 'person') {
      // Land on the person you mapped ONTO, address bar included. Re-rendering
      // the merged page while the URL still named the old identity meant a
      // reload, a share or a back-button took you to the page you just retired.
      const target = String(canonical || '').trim() || slug;
      $('obsBody').innerHTML = drillHtml('person', target);
      toTopOfView();
      initDrillMap();
      setCrumbs([{ label: CRUMB_LABELS.person }, { label: target }]);
      if (typeof history !== 'undefined') {
        history.pushState({ drill: 'person', key: target }, '', drillPath('person', target));
      }
      return;
    }
    const list = type === 'speaker' ? _data.speakers : _data.sponsors;
    const nameKey = type === 'speaker' ? 'name' : 'title';
    if ((list || []).some((r) => r[nameKey] === target)) {
      $('obsBody').innerHTML = drillHtml(type, target);
      toTopOfView();
      initDrillMap();
    } else {
      renderDashboard();
    }
  }, true);
}

export function closeObservatory() {
  destroyMap();
  destroyStripMap();
  $('archiveObservatory')?.classList.add('hidden');
  document.body.style.overflow = '';
}
