// Archive Observatory — a data-viz dashboard over the whole 19-year archive:
// events/sessions per year, series + tier breakdowns, ranked speakers/sponsors
// (with appearance timelines), a topic-trend line chart mined from session titles +
// descriptions, and archive-wide search. The "after" the Curation Studio hands off to — it
// reflects your reconciliation (aliased names aggregate cleanly). Bar charts are
// hand-built CSS; the topic trend is inline SVG (no chart lib). Read-only.

import { escapeHtml as esc, slugify } from './utils.js';
import { archiveHref, parseArchiveRoute } from './archiveRoute.js';
import { countsAsSession } from './sessionKind.js';
import { tipPromptHtml, wireTipPrompt } from './archiveTip.js';
import {
  annotationColor,
  annotationMarks,
  annotationsByYear,
  yearPos,
  yearRangeLabel,
} from './archiveAnnotations.js';
import {
  provisionalFrom,
  stackByYear,
  stackedChartSvg,
  stackedLegend,
  wireStacks,
} from './archiveStacks.js';
import { initMaximise, observeMaximise } from './chartMaximise.js';

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
  ['sources', 'Sources'],
];
let _homeTab = 'overview';
let _videoQ = ''; // free-text query on the video view: a person, a topic, an event
const VIDEO_PAGE = 60;
let _videoRows = []; // results gathered so far — "Show more" adds a page, it does not replace one
let _videoTotal = 0; // how many the current scope has in all, so paging knows when it is done
let _videoGen = 0; // bumped per search, so an in-flight page can tell it is stale

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
  // Newest first, by when the event actually ran — the same order the
  // recordings view uses, so the two read as one timeline. Sorting on `year`
  // and then the label put DrupalCon Dublin (September) above Mumbai
  // (February) in 2016, and did that to 12 of the 14 years holding more than
  // one album. `year` remains the fallback for a row with no start date.
  return rows.sort(
    (a, b) =>
      String(b.startDate || '').localeCompare(String(a.startDate || '')) ||
      b.year - a.year ||
      a.label.localeCompare(b.label),
  );
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
  let survival = false; // do the in-scope event rows carry videos/described at all?
  for (const e of all)
    if (inScope(e, true)) {
      const row = (byY[e.year] ??= {
        events: 0,
        sessions: 0,
        videos: 0,
        described: 0,
        albums: 0,
      });
      row.events++;
      row.sessions += e.sessions || 0;
      // "What survives" is faceted like everything else, so its three figures
      // have to be re-summed from the in-scope events. The payload's year
      // totals are archive-wide and cannot be filtered after the fact — left
      // to them, the chart kept showing the whole archive under a series
      // filter, which is the one reading it must never give.
      //
      // Older payloads have no per-event `videos`/`described`, and a scope
      // summed from those rows is unanswerable rather than zero. `survival`
      // records which it is; see canShowSurvival().
      if (e.videos !== undefined || e.described !== undefined) survival = true;
      row.videos += e.videos || 0;
      row.described += e.described || 0;
      if (e.album) row.albums++;
    }
  const years = [];
  for (let y = Y0; y <= Y1; y++)
    years.push({
      year: y,
      events: byY[y]?.events || 0,
      sessions: byY[y]?.sessions || 0,
      // Undefined, not zero, when the event rows could not answer — so the
      // chart can decline instead of reporting a confident nothing.
      videos: survival ? byY[y]?.videos || 0 : undefined,
      described: survival ? byY[y]?.described || 0 : undefined,
      albums: byY[y]?.albums || 0,
    });
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

/**
 * What survives, year by year — the companion to yearsChart().
 *
 * That chart answers "how much conference was there". This one answers "how
 * much of it does the archive actually hold", which is a different question and
 * the one worth watching: a year with 700 sessions and no recordings is a worse
 * record than one with 200 and half of them filmed.
 *
 * Three rows over a shared year axis rather than three charts, because the only
 * interesting readings are comparisons DOWN a year — 2020 has the descriptions
 * and none of the galleries — and separate charts put those in different places.
 *
 * The coverage row is a proportion and the other two are counts, so they are
 * scaled independently and labelled as what they are. Sharing one scale would
 * make 63 albums invisible beside 9,904 sessions.
 *
 * @param {Array<{year:number,events:number,sessions:number,videos:number,described:number,albums:number}>} years
 */
/**
 * Can these year rows answer the survival question at all?
 *
 * ABSENCE OF THE KEY, not a zero value: a year with no recordings is a real
 * answer and must plot as zero, while a payload that predates these fields can
 * answer nothing and must say so. Summing `undefined` with `|| 0` turns the
 * second into the first — the faceted path did exactly that against an older
 * server and drew "0% described" over 693 sessions, which is a confident lie.
 *
 * @param {Array<object>} years
 */
export function canShowSurvival(years) {
  return (years || []).some((y) => y && y.described !== undefined && y.videos !== undefined);
}

export function survivalChart(years) {
  const rows = [
    {
      key: 'described',
      label: 'Described',
      // A share of the programme, not a count: "91% of sessions have an
      // abstract" is the readable fact, and the count is in the tooltip.
      value: (y) => (y.sessions ? (y.described / y.sessions) * 100 : 0),
      max: () => 100,
      show: (y) => (y.sessions ? `${Math.round((y.described / y.sessions) * 100)}%` : ''),
    },
    {
      key: 'videos',
      label: 'Recordings',
      value: (y) => y.videos,
      max: (all) => Math.max(1, ...all.map((y) => y.videos)),
      show: (y) => (y.videos ? String(y.videos) : ''),
    },
    {
      key: 'albums',
      label: 'Galleries',
      value: (y) => y.albums,
      max: (all) => Math.max(1, ...all.map((y) => y.albums)),
      show: (y) => (y.albums ? String(y.albums) : ''),
    },
  ];
  return rows
    .map((row) => {
      const max = row.max(years);
      const cols = years
        .map((y) => {
          const v = row.value(y);
          const pct = y.sessions || y.events ? Math.max(v ? 3 : 0, (v / max) * 100) : 0;
          const tip =
            `${y.year}: ${y.described} of ${y.sessions} session${y.sessions === 1 ? '' : 's'} described` +
            ` · ${y.videos} recording${y.videos === 1 ? '' : 's'}` +
            ` · ${y.albums} galler${y.albums === 1 ? 'y' : 'ies'}`;
          return `<div class="obs-ycol${y.events ? '' : ' obs-ycol--empty'}"${
            y.events ? ` data-drill="year" data-key="${y.year}" role="button" tabindex="0"` : ''
          } title="${esc(tip)}" aria-label="${esc(tip)}">
        <div class="obs-ybar obs-ybar--${row.key}" style="height:${pct || 2}%">${
          row.show(y) ? `<span class="obs-ybar-n">${esc(row.show(y))}</span>` : ''
        }</div>
        <span class="obs-ylabel">'${String(y.year).slice(2)}</span>
      </div>`;
        })
        .join('');
      return `<div class="obs-survival-row">
      <span class="obs-survival-label">${row.label}</span>
      <div class="obs-years obs-years--short">${cols}</div>
    </div>`;
    })
    .join('');
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

/**
 * Events per year, split by country or by series — the rows both the Countries
 * and Series subjects are built from.
 *
 * Faceted like every other panel EXCEPT on its own dimension: the country
 * subject ignores `_country` and the series subject ignores `_series`, because
 * a chart whose whole job is to compare communities is useless once it has been
 * filtered down to one of them. Every other facet still applies, so picking a
 * region really does redraw both.
 *
 * @param {'country'|'series'|'region'} facet
 * @returns {{rows: {year:number, key:string}[], undated: number}}
 */
function stackRows(facet) {
  const rows = [];
  let undated = 0;
  for (const e of flatEvents()) {
    const scoped =
      (facet === 'series' || _series === 'All' || e.series === _series) &&
      (_year === 'All' || e.year === Number(_year)) &&
      (facet === 'region' || _region === 'All' || e.region === _region) &&
      (facet === 'country' || _country === 'All' || e.country === _country);
    if (!scoped) continue;
    if (!Number.isFinite(Number(e.year))) undated++;
    const key = facet === 'country' ? e.country : facet === 'region' ? e.region : e.series;
    rows.push({ year: e.year, key: key || 'Unknown' });
  }
  return { rows, undated };
}

/**
 * The stacked model for a subject, ready for archiveStacks to draw.
 *
 * @param {'countries'|'series'|'regions'} mode
 */
function stackModelFor(mode) {
  const { rows } = stackRows(GEO_FACET[mode]);
  return stackByYear(rows, { y0: Y0, y1: Y1 });
}

/** Subject → the event field it groups by. */
const GEO_FACET = { countries: 'country', series: 'series', regions: 'region' };

/**
 * Countries/Series as LINE series, in the shape the chart's drawing loop wants.
 *
 * @param {'countries'|'series'|'regions'} mode
 * @returns {{term:string, key:string, byYear:Record<number,number>, total:number}[]}
 */
function geoSeries(mode) {
  const m = stackModelFor(mode);
  const byKey = new Map(m.keys.map((k) => [k.key, {}]));
  for (const y of m.years) for (const s of y.segs) byKey.get(s.key)[y.year] = s.n;
  return m.keys.map((k) => ({
    term: k.key,
    key: k.key,
    byYear: byKey.get(k.key) || {},
    total: k.total,
  }));
}

/**
 * ⚠ THIRTY-NINE LINES IS NOT A CHART, so the line views open on the busiest
 * eight and the legend toggles the rest — the same bargain Topics already
 * strikes. The Stacked sub-view is the one that shows everybody at once, which
 * is why both exist.
 */
const GEO_DEFAULT_N = 8;
/** @type {Record<string, Set<string>|null>} */
const _geoSel = { countries: null, series: null, regions: null };
/**
 * @param {'countries'|'series'|'regions'} mode
 * @returns {Set<string>}
 */
function ensureGeoSel(mode) {
  const all = geoSeries(mode);
  const live = new Set(all.map((s) => s.key));
  // Re-seed when the scope changes out from under the selection: a country the
  // reader picked can vanish entirely when they pick a region.
  if (!_geoSel[mode] || ![..._geoSel[mode]].some((k) => live.has(k)))
    _geoSel[mode] = new Set(all.slice(0, GEO_DEFAULT_N).map((s) => s.key));
  return _geoSel[mode];
}

function hbars(rows, labelKey, valKey, drill) {
  const max = Math.max(1, ...rows.map((r) => r[valKey]));
  return `<div class="obs-hbars">${rows
    .map((r) => {
      // Rows with no events in the current scope are greyed and non-clickable, but kept
      // visible and marked 0 — so e.g. a series absent from the filtered country still shows.
      const zero = !r[valKey];
      const click = drill && !zero;
      return `<div class="obs-hbar${click ? ' obs-clickable' : ''}${zero ? ' obs-hbar--zero' : ''}"${click ? ` data-drill="${drill}" data-key="${esc(r[labelKey])}" role="button" tabindex="0"` : ''}><span class="obs-hbar-l" title="${esc(r[labelKey])}">${esc(r[labelKey])}</span>
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
      ) => `<div class="obs-rankrow${drill ? ' obs-clickable' : ''}"${drill ? ` data-drill="${drill}" data-key="${esc(r[keyKey || nameKey])}" role="button" tabindex="0"` : ''}><span class="obs-rank-i">${i + 1}</span>
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

/**
 * ⚠ BOTH ARCHIVE MAPS HARDCODED `dark_all`, so in light mode the page sat a
 * black rectangle in the middle of a white page. Every other map in the app
 * (planner, itinerary, schedule venue, picker) already switched on the body
 * class; these two were simply written before that and never revisited.
 *
 * The slug is read at layer-creation time AND on every theme change, because a
 * mode switch does not re-render the dashboard — the map object outlives it.
 */
/**
 * The reset control, rendered inline in each maximisable map wrapper and shown
 * by CSS only while that wrapper is maximised — so the inline strip keeps its
 * clean edge and gains a control exactly when there is something to reset.
 */
function mapResetBtn() {
  return (
    '<button type="button" class="obs-map-reset" aria-label="Reset view" title="Reset view">' +
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
    '<circle cx="8" cy="8" r="6.2"/><path d="M8 1.2v1.6M8 13.2v1.6M1.2 8h1.6M13.2 8h1.6"/>' +
    '<path d="M10.4 5.6 6.9 6.9 5.6 10.4 9.1 9.1Z"/></svg></button>'
  );
}

function mapTileSlug() {
  return document.body.classList.contains('theme-dark') ? 'dark_all' : 'light_all';
}

function mapTileUrl() {
  return `https://{s}.basemaps.cartocdn.com/${mapTileSlug()}/{z}/{x}/{y}{r}.png`;
}

/**
 * Leaflet caches its container size, so a map that has just been blown up to
 * fill the screen keeps drawing its old viewport — grey gutters down the sides
 * and pins nowhere near where they belong. chartMaximise fires `obs:maximise`
 * precisely so it does not have to know that; this is the half that does.
 *
 * The two rAFs are not superstition: the class lands, the browser lays the
 * panel out, and only then is `getSize()` worth asking. One frame is enough in
 * Chromium and not in Safari, where the fullscreen transition runs longer —
 * hence a `setTimeout` chaser as well, which is cheap and idempotent.
 */
/**
 * The world strip is deliberately inert in the page — no dragging, no wheel
 * zoom, no keyboard — because it sits inline under the stats and a map that
 * eats scroll events there is an obstacle, not a feature.
 *
 * Maximised, that reasoning inverts: the map IS the page, there is nothing to
 * scroll past, and being unable to look around is the obstacle. So the handlers
 * are turned on when a map is blown up and off again when it is restored, and
 * the framing is re-applied on the way out so the strip returns to exactly the
 * band it was — an exploration should not leave the page changed behind it.
 *
 * @param {any} map a Leaflet map
 * @param {boolean} on
 */
function setMapInteractive(map, on) {
  if (!map) return;
  for (const h of [
    'dragging',
    'scrollWheelZoom',
    'doubleClickZoom',
    'touchZoom',
    'boxZoom',
    'keyboard',
  ]) {
    // A handler a map was built without simply is not there; `?.` covers both
    // maps with one loop rather than branching per map.
    map[h]?.[on ? 'enable' : 'disable']?.();
  }
  const L = window.L;
  if (!L) return;
  if (on && !map._obsZoomCtl) {
    map._obsZoomCtl = L.control.zoom({ position: 'topleft' }).addTo(map);
  } else if (!on && map._obsZoomCtl) {
    map.removeControl(map._obsZoomCtl);
    map._obsZoomCtl = null;
  }
}

function wireMapMaximise() {
  if (typeof document === 'undefined' || /** @type {any} */ (document)._obsMapMaxWired) return;
  /** @type {any} */ (document)._obsMapMaxWired = true;

  // "Reset view" — the way back from having wandered off. It re-applies the
  // map's own framing without leaving fullscreen, which matters most on the
  // strip, where one drag can put you in the middle of an ocean.
  document.addEventListener('click', (e) => {
    const btn = /** @type {Element} */ (e.target)?.closest?.('.obs-map-reset');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const wrap = btn.closest('.obs-maxable');
    for (const m of [_map, _stripMap]) {
      if (m && wrap?.contains?.(m.getContainer?.())) {
        m.invalidateSize();
        m._obsRefit?.();
      }
    }
  });

  document.addEventListener('obs:maximise', (e) => {
    const el = /** @type {Element} */ (e.target);
    const open = !!(/** @type {CustomEvent} */ (e).detail?.open);
    const resize = () => {
      for (const m of [_map, _stripMap]) {
        if (!m || !el.contains?.(m.getContainer?.())) continue;
        setMapInteractive(m, open);
        m.invalidateSize();
        // Re-fit rather than merely re-measure: a strip map sized to fill a
        // 200px-tall band tells you nothing at full height if it keeps that
        // zoom. Each map re-applies its own framing — which is also what
        // discards any panning done while it was maximised.
        m._obsRefit?.();
      }
    };
    requestAnimationFrame(() => requestAnimationFrame(resize));
    setTimeout(resize, 260);
  });
}

/** @type {any[]} */
let _mapTileLayers = [];

/** Re-point every live archive tile layer at the current theme's basemap. */
function updateMapTheme() {
  const url = mapTileUrl();
  for (const layer of _mapTileLayers) {
    try {
      layer?.setUrl?.(url);
    } catch {
      /* a layer whose map was torn down; the next render makes a fresh one */
    }
  }
}

/**
 * Watch the body class once, as plannerMap does. Registered when the first tile
 * layer is created rather than at module load, so a page without a map never
 * installs an observer.
 */
let _mapThemeWatched = false;
function watchMapTheme() {
  if (_mapThemeWatched || typeof MutationObserver === 'undefined') return;
  _mapThemeWatched = true;
  new MutationObserver(updateMapTheme).observe(document.body, {
    attributes: true,
    attributeFilter: ['class'],
  });
}

/**
 * Create a basemap layer that follows the theme, and remember it so a later
 * mode switch can re-point it.
 *
 * @param {any} L Leaflet
 * @param {any} map the map to add the layer to
 * @param {Record<string, unknown>} [opts] extra tileLayer options
 */
function addBasemap(L, map, opts) {
  const layer = L.tileLayer(mapTileUrl(), {
    subdomains: 'abcd',
    maxZoom: 19,
    noWrap: true, // one Earth only — no repeating tiles to the sides
    ...(opts || {}),
  }).addTo(map);
  // Drop layers belonging to maps that have since been removed, so this list
  // cannot grow without bound across re-renders.
  _mapTileLayers = _mapTileLayers.filter((l) => l?._map).concat(layer);
  watchMapTheme();
  return layer;
}
function initDrillMap() {
  if (!_mapPts.length) return;
  loadLeaflet(() => {
    const el = document.getElementById('obsMap');
    const L = window.L;
    if (!el || !L) return;
    if (_map) _map.remove();
    _map = L.map(el, { zoomControl: true, attributionControl: false, scrollWheelZoom: false });
    addBasemap(L, _map);
    // Bounds from the point list, so the view can be fitted before a single
    // marker exists — same reasoning as the world strip.
    const bounds = _mapPts.map((p) => [p.lat, p.lon]);
    const pts = _mapPts;
    const map = _map;
    const alive = () => _map === map;
    const CHUNK = 60;
    let next = 0;
    const addPins = () => {
      if (!alive()) return;
      const end = Math.min(next + CHUNK, pts.length);
      for (; next < end; next++) {
        const p = pts[next];
        L.circleMarker([p.lat, p.lon], {
          radius: 6,
          weight: 2,
          fillOpacity: 0.9,
          // Colour lives in CSS so pins follow the silver ramp in both modes;
          // Leaflet writes stroke/fill as attributes, which cannot read a var().
          className: 'obs-map-pin',
        })
          .addTo(map)
          .bindPopup(`<b>${esc(p.label)}</b>${p.year ? `<br>${esc(String(p.year))}` : ''}`);
      }
      if (next < pts.length) requestAnimationFrame(addPins);
    };
    requestAnimationFrame(addPins);
    // CONTAIN, deliberately. This is the drill-down map — a speaker's journey or
    // a sponsor's — where every plotted place must stay on screen. Cover is
    // right for the world strip, which is decorative and may crop; it is wrong
    // here, where cropping loses data.
    const fit = () => {
      if (!alive()) return;
      if (bounds.length === 1) map.setView(bounds[0], 5);
      else map.fitBounds(bounds, { padding: [34, 34], maxZoom: 10 });
    };
    fit();
    // Re-framed, not just re-measured, when the panel is maximised.
    map._obsRefit = fit;
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
/**
 * Breathing room, in pixels, allowed beyond the world's east/west edge on the
 * footprint strip. Sized for the largest pin (radius 8 + stroke) plus a little
 * air, so New Zealand — the archive's most easterly community, at ~174.8°E
 * against a world that stops at 180° — is never drawn flush against the frame.
 */
const EDGE_PAD = 22;

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
  // Leaflet is vendored but still a fetch, and the tiles are a network round
  // trip after that — so the strip sat blank and then snapped into existence.
  // Say what is happening instead. The height is fixed in CSS, so this reserves
  // no extra space and nothing shifts when the map replaces it.
  if (!_stripMap) {
    el.classList.remove('obs-stripmap-empty');
    el.classList.add('obs-stripmap-loading');
    el.innerHTML = `<div class="obs-stripmap-skeleton" role="status" aria-live="polite">
        <span class="obs-stripmap-skeleton-bar"></span>
        <span class="obs-stripmap-skeleton-text">Placing ${pts.length} location${
          pts.length === 1 ? '' : 's'
        }…</span>
      </div>`;
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
    addBasemap(L, _stripMap);
    // Bounds come from the point list, not from creating the markers, so the
    // view can be fitted immediately while the pins arrive behind it.
    const bounds = pts.map((p) => [p.lat, p.lon]);
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
      //
      // ⚠ MINUS A DELIBERATE MARGIN, BECAUSE NEW ZEALAND LIVES AT THE EDGE OF THE
      // WORLD. Auckland is 174.8°E and the map stops at 180°, so when the strip
      // is zoomed out far enough for the world to exactly cover the frame, those
      // pins land ~13px from the right-hand edge — close enough that the marker
      // and its tooltip are clipped by the frame. The clamp below was doing its
      // job (keep the viewport inside the world); the problem is that "inside
      // the world" and "comfortably on screen" are not the same thing near
      // ±180°. Reserving a few pixels beyond each edge gives anything at the
      // antimeridian room to breathe, and costs a barely-visible strip of the
      // map's own background elsewhere.
      const coverZoom = Math.log2(Math.max(px - EDGE_PAD * 2, 64) / 256);
      // A Leaflet zoom level is a power of two: each level doubles the world's
      // pixel width, so -1 shows twice as much ground. One level wider reads
      // better, but never below the cover floor or the gutters come back.
      const z = pts.length === 1 ? 4 : Math.max(coverZoom, Math.min(fillZoom, fitZoom) - 1);
      // Clamp the focal point so the viewport stays wholly inside the world at this zoom.
      const world = 256 * Math.pow(2, z);
      const p = map.project([midLat, anchor.lon], z);
      // The same margin on the clamp: the viewport may overhang the world's edge
      // by EDGE_PAD, so a cluster pressed against ±180° is never flush with the
      // frame. At the widest zoom the world is narrower than the frame and the
      // first branch centres it, which produces the margin on both sides.
      const clamp1 = (v, half) =>
        world <= half * 2
          ? world / 2
          : Math.min(Math.max(v, half - EDGE_PAD), world - half + EDGE_PAD);
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

    // Pins are added in batches AFTER the view is set, so the basemap is on
    // screen first and a large archive never blocks the main thread creating
    // several hundred markers and tooltips in one pass. Each batch re-checks
    // `alive()` because a facet change can tear this map down mid-flight.
    const CHUNK = 60;
    let next = 0;
    const addPins = () => {
      if (!alive()) return;
      const end = Math.min(next + CHUNK, pts.length);
      for (; next < end; next++) {
        const p = pts[next];
        L.circleMarker([p.lat, p.lon], {
          radius: Math.min(3 + p.count * 0.7, 8),
          weight: 1,
          fillOpacity: 0.85,
          className: 'obs-map-pin',
        })
          .addTo(map)
          .bindTooltip(`${esc(p.labels[0])}${p.count > 1 ? ` +${p.count - 1} more` : ''}`, {
            direction: 'top',
          });
      }
      if (next < pts.length) requestAnimationFrame(addPins);
      else el.classList.remove('obs-stripmap-loading');
    };
    requestAnimationFrame(addPins);

    map.whenReady(() => requestAnimationFrame(settle));
    map.on('resize', () => alive() && applyView());
    // The strip's zoom is computed from its own width, so a maximised strip has
    // to recompute it rather than keep the band's framing at full height.
    map._obsRefit = applyView;
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
    <div class="obs-map-wrap"><div class="obs-map-box obs-maxable">${mapResetBtn()}<div class="obs-map" id="obsMap"></div></div>${unmappedList(evs)}</div>
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
  let out = { items: [], tz: '', event: {} };
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
      // `event` too: the Sources drill needs the sponsor list and the source
      // registry, and re-fetching the same file for it would be silly.
      out = { items: d.items || [], tz: (d.event || {}).timezone || '', event: d.event || {} };
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
  return kind
    ? archiveHref({ view: 'drill', kind, key: slugify(String(key)) })
    : archiveHref({ view: 'home' });
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
  // A crumb trail IS the record of being somewhere other than the home view, and
  // every drill already has to set one — so this is the one place that can track
  // it without a second thing to keep in step. See `_drillOpen`.
  _drillOpen = trail.length > 0;
  const nav = document.getElementById('scheduleCrumbs');
  if (!nav) return;
  const parts = [
    '<a href="./home.html">Home</a>',
    trail.length
      ? `<a href="${esc(archiveHref({ view: 'home' }))}">Archive</a>`
      : '<span aria-current="page">Archive</span>',
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

  const ann = annotationMarks({
    x: (y) => X(y - span.min),
    top: padT,
    bottom: padT + ph,
    min: span.min,
    max: span.max,
  });

  return `<div class="obs-st-wrap">
    <svg class="obs-st" viewBox="0 0 ${W} ${H}" role="img"
        aria-label="Matching sessions per year, ${span.min} to ${span.max}">
      ${ann}
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
  return archiveHref({ view: 'topic', key: slugify(String(term)), year });
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
  return archiveHref({ view: 'debuts', year });
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
  const back = `<button type="button" class="obs-back" data-back="1">← Back</button>`;
  const rows = debuts
    .map(
      (d) =>
        `<div class="obs-ev obs-clickable" data-drill="person" data-key="${esc(d.name)}" role="button" tabindex="0">
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
/**
 * Run a session search AND give it an address.
 *
 * One helper because there are now three ways in — the suggestion button, Enter
 * in the search box, and Browse all — and when the pushState lived inside the
 * click handler only that one route was linkable or Back-able.
 */
function openSessionSearch(query) {
  const q = String(query || '').trim();
  showSessionSearch(q);
  if (typeof history !== 'undefined') {
    pushArchiveState({ sessions: q, match: _sessMode }, sessionPath(q, _sessMode));
  }
}

export function sessionPath(query, mode) {
  return archiveHref({ view: 'sessions', key: String(query || ''), mode });
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
  // No query is a browse, and it needs its own words throughout: “”, an empty
  // pair of quotation marks, is what the heading used to render.
  setCrumbs([{ label: 'Sessions' }, { label: q ? `“${q}”` : 'All' }]);
  body.innerHTML = `
    <button type="button" class="obs-back" data-back="1">← Back</button>
    <div class="obs-drill-head">
      <span class="obs-eyebrow">Sessions</span>
      <h2 class="obs-drill-name">${q ? `“${esc(q)}”` : 'Every session'}</h2>
      <p class="obs-sub">${q ? 'Searching the whole archive…' : 'Loading…'}</p>
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
    <button type="button" class="obs-back" data-back="1">← Back</button>
    <div class="obs-drill-head">
      <span class="obs-eyebrow">Sessions</span>
      <h2 class="obs-drill-name">${
        (data.terms || []).length
          ? data.terms.map((t) => `“${esc(t)}”`).join(' or ')
          : 'Every session'
      }</h2>
      <!-- The count changes when Show more is pressed, and it is the only
           feedback that anything happened; role=status announces it without
           moving focus (WCAG 4.1.3). -->
      <p class="obs-sub" data-sess-count role="status">${sessionCountLine(data.total, data.results.length)}</p>
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
        <input id="obsSessQ" type="search" class="app-control obs-sess-input" value="${esc(q)}"
               placeholder="Search every session — commas for either/or" autocomplete="off">
        <button type="submit" class="app-btn">Search</button>
        ${
          q
            ? // Clearing the query is a destination, not an absence: it lists
              // every session the current facets allow.
              `<button type="button" class="app-btn" data-sess-clear>Clear</button>`
            : ''
        }
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
    if (e.target.closest('[data-sess-clear]')) {
      openSessionSearch('');
      return;
    }
    const pick = e.target.closest('[data-sess-mode]');
    if (!pick || pick.dataset.sessMode === _sessMode) return;
    _sessMode = pick.dataset.sessMode === 'exact' ? 'exact' : 'contains';
    // The same query read a different way is a different result set, so it gets
    // its own history entry rather than silently rewriting the one you are on.
    showSessionSearch(q);
    if (typeof history !== 'undefined')
      pushArchiveState({ sessions: q, match: _sessMode }, sessionPath(q, _sessMode));
  });

  body.querySelector('[data-sess-form]')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const next = body.querySelector('#obsSessQ').value.trim();
    // An EMPTY box is now a real request — "everything in this scope" — not a
    // no-op. It used to return early, which made a search a one-way door: the
    // only way back to the full list was the browser's Back button.
    if (next === q) return;
    openSessionSearch(next);
  });
  return true;
}

/**
 * Push a history entry, recording HOW DEEP into the archive it is.
 *
 * The depth is what lets "← Back to overview" be an actual back rather than a
 * third entry that happens to look like the first. It rides on the entry, so it
 * stays correct however the reader has moved around: an entry pushed from the
 * overview is 1, one pushed from a drill is 2, and going back to that drill by
 * any means brings its own 1 with it.
 *
 * A deep link has no state at all, so depth is undefined — which is the signal
 * that there is nothing of ours behind this entry to go back TO.
 */
function pushArchiveState(state, path, { home = false } = {}) {
  if (typeof history === 'undefined') return;
  const depth = (history.state?.archiveDepth || 0) + 1;
  // Where the nearest HOME view sits, carried along by every drill pushed from
  // it. Back returns to the tab you were reading — open a speaker from Videos
  // and Back belongs on Videos, not on the overview you started from an hour
  // ago. A home view is its own answer to that question.
  const homeDepth = home ? depth : (history.state?.homeDepth ?? 0);
  history.pushState({ ...state, archiveDepth: depth, homeDepth }, '', path);
}

/**
 * Is a drill or search on screen, as opposed to the archive home?
 *
 * `_homeTab` cannot answer this — it names which HOME tab is selected, and stays
 * "overview" the whole time you are reading a speaker page. Routing back to
 * /archive therefore concluded "already right, nothing to do", the popstate
 * handler fell through to its last resort, and the browser's Back button
 * RELOADED THE WHOLE PAGE instead of drawing the overview.
 */
let _drillOpen = false;

export function openDrillFromPath(pathname = location.pathname, search) {
  // BOTH ADDRESS FORMS, one parser. Served, this reads `/archive/person/x`; as
  // plain files it reads `archive.html?drill=person&key=x`. The dashboard used
  // to match path literals only, so every deep address was unreachable in a
  // static deployment — including the ones it had just written itself.
  const loc = {
    pathname: String(pathname ?? ''),
    search: search ?? (typeof location === 'undefined' ? '' : location.search),
  };
  const route = parseArchiveRoute(loc);

  if (route.view === 'home') {
    // Back from a view mode returns here. Without this the address said /archive
    // while the videos were still on screen.
    if (_homeTab === 'overview' && !_drillOpen) return false; // already right; let the caller be
    _homeTab = 'overview';
    _videoQ = '';
    _videoRows = [];
    renderHome();
    return true;
  }

  if (route.view === 'tab') {
    if (!_data) return false; // the payload feeds both views; the caller retries
    const raw = new URLSearchParams(loc.search);
    _videoQ = raw.get('q') || '';
    _videoRows = [];
    _homeTab = route.tab;
    renderHome();
    return true;
  }

  // Sessions is a query, not a record — the address carries the search text.
  if (route.view === 'sessions') {
    // Rendering the search reads the loaded insights (the facet lists, the series
    // options), so it CANNOT run before they arrive. This branch used to report
    // success regardless: on a refresh it ran against a null payload, threw
    // mid-render, and the caller's observer — already disconnected because we
    // said "routed" — never tried again. The dashboard then finished loading and
    // painted the overview over it, leaving the archive home page under a
    // /archive/sessions/… URL. Same contract as showDrill now: not yet.
    if (!_data) return false;
    _sessMode = route.mode;
    showSessionSearch(String(route.key || '').replace(/\+/g, ' '));
    return true;
  }

  // One event's provenance page. Addressable so a citation can be linked to —
  // which is the whole point of recording provenance in the first place.
  if (route.view === 'source') {
    if (!_data) return false; // payload feeds it; the caller retries
    _homeTab = 'sources';
    return openSourceDrill(route.key);
  }

  if (route.view === 'debuts') {
    if (!_data) return false;
    const y = Number(route.year);
    if (!Number.isFinite(y)) return false;
    openDebutDrill(y);
    return true;
  }

  // A topic is the one view addressed by a PAIR — the term and the year.
  if (route.view === 'topic') {
    if (!_data) return false; // the term list is not loaded yet; the caller retries
    const year = Number(route.year);
    if (!route.key || !Number.isFinite(year)) return false;
    const known = [...currentTopics().map((t) => t.term), ...(_topicSel || []), ..._pinned];
    openTopicDrill(termFromSlug(route.key, known), year);
    return true;
  }

  if (route.view !== 'drill') return false;
  const type = route.kind;
  if (!DRILL_KINDS[type]) return false;
  const key = keyForSlug(type, route.key);
  if (!key) return false;
  const shown = showDrill(type, key);
  // A profile slug, or a spelling that curation has since mapped, is an ALIAS of
  // the canonical page — not a second page. `keyForSlug` already resolves it, but
  // the address bar kept the alias, so copying the link or reloading spread the
  // old name around. Settle on the canonical URL. replaceState, not pushState: the
  // alias is not somewhere the reader chose to be, so Back must not return to it.
  if (shown && typeof history !== 'undefined') {
    const canonical = drillPath(type, key);
    const here = decodeURIComponent(location.pathname) + location.search;
    if (canonical !== here && canonical !== decodeURIComponent(location.pathname))
      history.replaceState({ drill: DRILL_KINDS[type] || type, key }, '', canonical);
  }
  return shown;
}

function drillHtml(type, key) {
  const back = `<button type="button" class="obs-back" data-back="1">← Back</button>`;
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
export const MODES = [
  ['topics', 'Topics'],
  ['programme', 'Programme'],
  ['speakers', 'Speakers'],
  ['sponsors', 'Sponsors'],
  ['community', 'Community'],
  // WHERE and WHO ran it, rather than what was said. These read the event
  // records themselves, so they are the only subjects that work on an archive
  // with no session titles at all.
  ['regions', 'Regions'],
  ['countries', 'Countries'],
  ['series', 'Series'],
  // ⚠ NOT "Count" — next to "Countries" in a tab bar the two are genuinely
  // misread. "Scale" also says what it plots, which "Count" did not.
  ['count', 'Scale'],
];

/**
 * The two families of subject, because eight flat tabs do not scan.
 *
 * The split is real and not cosmetic: the first group counts EVENTS — it works
 * on a record with no programme at all — while the second reads what was INSIDE
 * them, and goes blank on an archive of dated stubs.
 */
const MODE_GROUPS = [
  ['The archive', ['count', 'regions', 'countries', 'series']],
  ['What was in it', ['topics', 'programme', 'speakers', 'sponsors', 'community']],
];

/**
 * The views each subject offers — a flat list of complete answers rather than
 * "units" of one measure, because "Hours" is not a unit of "Sessions", and
 * pretending otherwise is what made the old right-hand group unreadable.
 */
export const VIEWS = {
  // Lines answer "what happened to THIS community"; stacked answers "who made
  // up that year". Lines lead because a trend is the question being asked, and
  // stacked is where the long tail of one-event countries stays visible.
  regions: [
    ['lines', 'Lines'],
    ['stacked', 'Stacked'],
    ['share', 'Share&nbsp;%'],
  ],
  countries: [
    ['lines', 'Lines'],
    ['stacked', 'Stacked'],
    // Volume and balance are different questions and routinely disagree: a
    // community can grow every year and still be a shrinking share of a
    // faster-growing whole.
    ['share', 'Share&nbsp;%'],
  ],
  series: [
    ['lines', 'Lines'],
    ['stacked', 'Stacked'],
    ['share', 'Share&nbsp;%'],
  ],
  // "How big was it" and "how widely spread was it" are different questions and
  // routinely disagree — 2016 is the biggest year, but not the broadest.
  count: [
    ['total', 'Total'],
    ['active', 'Active'],
  ],
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
  // The first two count PEOPLE; the last two read the PROGRAMME's language.
  // They share this subject because both answer "what is this community like",
  // and the register views have nowhere better to live.
  community: [
    ['peak', '% of peak'],
    ['count', 'Count'],
    ['energy', 'Energy'],
    ['headwinds', 'Headwinds'],
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

/**
 * The view a mode should open on.
 *
 * ⚠ `DEFAULT_VIEW[mode] || 'count'` WAS THE BUG, TWICE OVER. DEFAULT_VIEW was
 * written when there were five modes and never gained entries for the four that
 * came later (Scale, Countries, Series, Regions) — so entering any of them fell
 * back to the literal `'count'`, **which Scale does not offer**. `_chartView`
 * then matched no view at all: `countTotal` and `countActive` were both false,
 * `sel` fell through to the keyword branch, and Scale drew TOPIC LINES under a
 * legend reading "Events | Sessions". The chart looked fine, which is why it
 * survived — a wrong chart that renders is harder to see than one that throws.
 *
 * The fallback is now the mode's own FIRST view, so a mode added tomorrow is
 * correct without anyone remembering to touch this table. DEFAULT_VIEW stays for
 * the modes whose preferred opening view is NOT their first, and is itself
 * validated rather than trusted.
 *
 * @param {string} mode
 * @returns {string}
 */
export function defaultViewFor(mode) {
  const views = VIEWS[mode] || [];
  const want = DEFAULT_VIEW[mode];
  if (want && views.some(([k]) => k === want)) return want;
  return views[0]?.[0] || 'count';
}
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
      : defaultViewFor(_chartMode);
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
 * contributes three slots, because the question is about slots. The two series
 * are averages rather than parts of a whole, so they must never be summed or
 * stacked; every view in this chart is drawn as lines now, which makes that the
 * default rather than something this one has to ask for.
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
  // The bands land under the same years in all six, which is the whole point of
  // a small multiple — you read the pandemic across the brackets, not in one of
  // them. Names come from the shared hover tooltip below (see smHover).
  const ann = annotationMarks({
    x: X,
    top: padT,
    bottom: padT + ph,
    min: years[0],
    max: years[years.length - 1],
  });
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
          ${ann}
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
      .join('') +
    // Six panels share one tooltip, and they share the annotation bands too —
    // so the note belongs to the year, not to the bracket under the cursor.
    annotationTipRows(year);
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
 * PROGRAMME REGISTER — the closest this archive can honestly get to "the vibe".
 *
 * There is no sentiment in here to read: no comments, no feedback forms, no
 * reviews, nothing where anybody said how they felt. Session descriptions are ad
 * copy, uniformly upbeat, and scoring them for positivity draws a flat line.
 * What CAN be measured is which way the programme faces — four word-lists,
 * counted per 1,000 words. See tools/server/internal/archive/register.go for the
 * lists, what was deliberately kept out of them, and the three controls the
 * trend survived (language, event weight, CFP boilerplate).
 *
 * Two pairings, because four lines on one axis is a soup:
 *   Energy    — collective voice and forward-looking language, both rising
 *   Headwinds — legacy/migration and strain, which is where the validation is:
 *               strain peaks in 2020 and migration in 2022 (Drupal 7 EOL)
 *               without having been told about either.
 */
const REGISTER_VIEWS = {
  energy: ['collective', 'forward'],
  headwinds: ['legacy', 'strain'],
};

/**
 * How many events a year needs before it plots.
 *
 * THIS WAS 2, AND IT WAS WRONG. The reasoning — "a median of one event is that
 * event's rate wearing a year's label" — confuses two different things:
 *
 *   sampling error, taking 1 of a year's 10 events to stand for the year, and
 *   a census, where the scope genuinely held one event and that event IS the year.
 *
 * Filter to DrupalSouth and every year is a census: it is one conference a year,
 * with 3,500-8,100 words and 31-59 readable descriptions behind each edition.
 * The floor of 2 excluded all thirteen of them — it punished exactly the series
 * that are cleanest to measure, while admitting nothing in exchange.
 *
 * The evidence bar belongs per EVENT (see register.go: at least 8 readable
 * English descriptions and 2,000 words), where it is about whether a rate is
 * stable, and it is enforced there. A year is then as good as the events that
 * cleared it. Years resting on a single event are drawn with a hollow dot
 * wherever the scope has better-supported years to compare them against.
 */
const REGISTER_MIN_EVENTS = 1;

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  if (!s.length) return 0;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Per-year register rates for one view, from the server's per-event rows.
 *
 * The rate is computed WITHIN each event and then taken as a median ACROSS the
 * year's events, never by pooling a year's words: one large DrupalCon brought
 * 140k words in 2013, and pooling lets it speak for the year.
 *
 * Exported for its test — the median-not-mean and the two-event floor are the
 * two things about this that are easy to quietly get wrong.
 *
 * @param {string} view key into REGISTER_VIEWS
 * @param {Array} rows `registerEvents` — [year, series, region, country, words, docs, counts]
 * @param {Array} lexicons `registerLexicons` — [{key, label, note}]
 * @param {(row: {series: string, region: string, country: string}) => boolean} [keep]
 */
export function registerRates(view, rows, lexicons, keep) {
  const keys = REGISTER_VIEWS[view];
  if (!keys || !lexicons?.length || !rows?.length) return [];
  const cols = keys.map((k) => lexicons.findIndex((l) => l?.key === k));
  // An older payload without these lexicons is not an empty chart, it is a
  // chart this build cannot draw. Say nothing rather than plot zeroes.
  if (cols.some((i) => i < 0)) return [];
  const byYear = new Map();
  for (const row of rows) {
    const [year, series, region, country, words, , counts] = row || [];
    if (!year || !words || !Array.isArray(counts)) continue;
    if (keep && !keep({ series, region, country })) continue;
    let bucket = byYear.get(year);
    if (!bucket) byYear.set(year, (bucket = []));
    bucket.push(counts.map((n) => ((n || 0) / words) * 1000));
  }
  return keys.map((key, i) => {
    const col = cols[i];
    const rates = {};
    const events = {};
    for (const [year, bucket] of byYear) {
      if (bucket.length < REGISTER_MIN_EVENTS) continue;
      rates[year] = median(bucket.map((b) => b[col] || 0));
      events[year] = bucket.length;
    }
    return {
      term: lexicons[col].label,
      key,
      byYear: rates,
      // How many events the median was taken over, so the tooltip can show it.
      // A rate with no n beside it cannot be judged.
      raw: events,
    };
  });
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

/**
 * The chart's user-unit box, sized to the space it will actually occupy.
 *
 * An SVG viewBox is scaled to its container, and text inside it is scaled with
 * everything else — so user units are only "pixels" at 1:1. The fixed 1000×340
 * box was drawn into 249 CSS px on a 390 px phone, a scale of 0.25: the axis
 * labels came out at 3 px, the plot at 85 px tall, and twelve lines through
 * 85 px is a smudge. It was not a small chart, it was an unreadable one.
 *
 * So below the breakpoint the box is measured from the container, which puts
 * the scale back at 1:1 and makes every `px` in the stylesheet mean what it
 * says. The aspect ratio goes with it: 2.9:1 is a shape for a wide screen, and
 * a phone has height to spend but no width.
 *
 * @returns {{W:number,H:number,padL:number,padR:number,padT:number,padB:number,yearStep:number}}
 */
function chartGeom() {
  const w = $('obsTopicChart')?.clientWidth || 0;
  // Wide enough that 1000 units scale to something legible — keep the drawing
  // everything was tuned against.
  if (!w || w >= 560) {
    return { W: 1000, H: 340, padL: 46, padR: 18, padT: 16, padB: 30, yearStep: 3 };
  }
  // 1:1, so `font-size: var(--step--2)` on a label is that many real pixels.
  // The y axis needs less room here because "12.1%" is set at its true size
  // rather than being scaled down with the rest of the drawing.
  const W = Math.max(260, Math.round(w));
  return {
    W,
    H: Math.round(Math.min(340, Math.max(240, W * 0.85))),
    padL: 34,
    padR: 8,
    padT: 12,
    padB: 26,
    // ~34 px a label at this size, and a year every three would collide.
    yearStep: W < 340 ? 5 : 4,
  };
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
  // Countries/Series draw lines through the same loop as everything else; their
  // Stacked view never reaches here (renderTopics short-circuits to the stacked
  // renderer, which is a different drawing entirely).
  const geo = _chartMode === 'countries' || _chartMode === 'series' || _chartMode === 'regions';
  // Each year normalised to 100%: the balance BETWEEN communities, which volume
  // cannot show — a community can grow every year and still be a shrinking share.
  //
  // ⚠ THE NORMALISATION IS DONE BY `denom` BELOW, NOT HERE. `share` is set from
  // the VIEW NAME alone (`v === 'share'`), so it is already true for this view —
  // pre-dividing the series as well made val() divide a second time and plotted
  // Spain at 111% of 2007. One divisor, in one place.
  const geoShare = geo && v === 'share';
  /** @type {Record<number, number>} */
  const geoTotals = {};
  if (geoShare)
    for (const g of geoSeries(/** @type {'countries'|'series'|'regions'} */ (_chartMode)))
      for (const [y, n] of Object.entries(g.byYear)) geoTotals[y] = (geoTotals[y] || 0) + n;
  const countTotal = _chartMode === 'count' && v === 'total';
  const countActive = _chartMode === 'count' && v === 'active';
  // Two of the Community views read the programme's LANGUAGE rather than
  // counting people, so they take none of the population machinery below.
  const register = community && !!REGISTER_VIEWS[v];
  const regSel = register
    ? registerRates(
        v,
        _data.registerEvents,
        _data.registerLexicons,
        (e) =>
          // Series/region/country only. The year facet highlights a year on this
          // chart rather than collapsing it, exactly as it does for topics.
          (_series === 'All' || e.series === _series) &&
          (_region === 'All' || e.region === _region) &&
          (_country === 'All' || e.country === _country),
      )
    : [];
  // Denominator for topic "share %" — titled sessions per year in the *current scope*.
  const sessBy =
    computeScopeTopics().sessBy ||
    Object.fromEntries((_data.years || []).map((y) => [y.year, y.sessions]));
  // Whether this scope mixes single-event years with better-supported ones. If it
  // does not — a once-a-year conference, every year a census — there is nothing
  // for a thin-year marker to distinguish.
  const regMixed = register && Object.values(regSel[0]?.raw || {}).some((n) => n > 1);
  // Not for the register views: communitySeries() walks computeView(), and they
  // plot none of it.
  const commAll = community && !register ? communitySeries() : [];
  // "% of peak" rescales each series against its OWN maximum, so five populations
  // of wildly different size can share one axis without a second scale.
  const peak = community && v === 'peak';
  // "% of peak" is a view of the population lines only; the register views are
  // already a rate and must not be indexed a second time.
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
  const sel = geo
    ? (() => {
        const mode = /** @type {'countries'|'series'|'regions'} */ (_chartMode);
        // Raw counts. The share view divides them by `geoTotals` in val(), like
        // every other share on this chart.
        return geoSeries(mode).filter((g) => ensureGeoSel(mode).has(g.key));
      })()
    : countTotal
      ? (() => {
          // Events AND sessions, because this view replaces the standalone
          // "archive over time" panel, which drew both (bar = sessions, number
          // = events) and is now gone.
          const ev = {};
          const ses = {};
          for (const e of flatEvents()) {
            if (!inScope(e, true) || !e.year) continue;
            ev[e.year] = (ev[e.year] || 0) + 1;
            ses[e.year] = (ses[e.year] || 0) + (e.sessions || 0);
          }
          return [
            { term: 'Events', byYear: ev },
            { term: 'Sessions', byYear: ses },
          ];
        })()
      : countActive
        ? (() => {
            // DISTINCT countries and distinct series per year — a country that
            // ran four camps in 2016 is one active country, not four. This is
            // the measure that says whether the community was spreading or
            // concentrating, which the event total cannot.
            const countries = {};
            const seriesN = {};
            const seenC = {};
            const seenS = {};
            for (const e of flatEvents()) {
              if (!inScope(e, true) || !e.year) continue;
              (seenC[e.year] ??= new Set()).add(e.country || 'Unknown');
              (seenS[e.year] ??= new Set()).add(e.series || 'Unknown');
            }
            for (const [y, set] of Object.entries(seenC)) countries[y] = set.size;
            for (const [y, set] of Object.entries(seenS)) seriesN[y] = set.size;
            return [
              { term: 'Countries', byYear: countries },
              { term: 'Series', byYear: seriesN },
            ];
          })()
        : sponsorTiers
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
              : register
                ? regSel
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
                        {
                          term: 'First time',
                          byYear: mapVals(slotAvg, (r) => Math.round(r.first)),
                        },
                        {
                          term: 'Spoken before',
                          byYear: mapVals(slotAvg, (r) => Math.round(r.returning)),
                        },
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
                          : [..._topicSel]
                              .map(topicObj)
                              .filter((t) => Object.keys(t.byYear).length);
  const yearHas = sponsorTiers
    ? Object.fromEntries(
        [...new Set(sel.flatMap((t) => Object.keys(t.byYear)))].map((y) => [
          y,
          sel.reduce((n, t) => n + (t.byYear[y] || 0), 0),
        ]),
      )
    : hours || sponsorCount
      ? sel[0].byYear
      : register
        ? // How many events each year's median was taken over — that is what the
          // scope "has" here, and it keeps a thin year distinguishable from a
          // year with no events at all.
          (regSel[0]?.raw ?? {})
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
  // Years the scope actually HAS something for. Kept separate from the years the
  // chart draws, because the two are different questions: this one decides where
  // the timeline starts and ends, and which years get called out as holes.
  const dataYears = [];
  for (let y = Y0; y <= Y1; y++) if ((yearHas[y] || 0) > 0) dataYears.push(y);
  if (!dataYears.length || !sel.length) {
    _plot = null;
    return `<p class="obs-topic-empty">${
      _chartMode === 'sponsors'
        ? 'No sponsors recorded in this view.'
        : register
          ? // Either the payload predates this measure, or the scope is too
            // narrow to carry it. Both are worth saying out loud rather than
            // drawing an empty frame.
            !(_data.registerEvents || []).length
            ? 'No register data in this payload — rebuild the insights to plot it.'
            : 'No event here has enough English description text to read. An edition needs 8 descriptions and 2,000 words.'
          : community
            ? peak && commAll.some((c) => _communitySel.has(c.key))
              ? 'Every series switched on has one year of data, so each would plot a flat 100%. Switch to <strong>Count</strong>.'
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
  // EVERY year between the first and the last, whether the scope has data for it
  // or not. A year with nothing recorded plots as zero, which is what it is: no
  // sessions, no speakers, no sponsors. Skipping those years let the x axis
  // compress — 2016 and 2019 sat a single step apart as though they were
  // consecutive — and drew a line whose slope was an artefact of the gap rather
  // than of the data. The zeros are still labelled as holes (see `gaps` below),
  // so "nothing happened" and "nothing recorded" stay distinguishable.
  const plotYears = [];
  for (let y = dataYears[0]; y <= dataYears[dataYears.length - 1]; y++) plotYears.push(y);
  const share = v === 'share' || v === 'lengthShare' || v === 'whoShare';
  // In people mode a share is of that year's CAST, not of its sessions.
  const topicShare = _chartMode === 'topics' && share;
  const readBy = computeScopeTopics().readBy || {};
  // ⚠ THE DENOMINATOR IS THE WHOLE YEAR, not the selected lines — dividing by
  // the selection would make any two countries look like 100% of Drupal between
  // them.
  const denom = topicShare
    ? readBy
    : geoShare
      ? geoTotals
      : stacked
        ? castTotals
        : lengths
          ? mixTotals
          : sessBy;
  const val = (t, y) => {
    // For a topic SHARE both halves come from the readable sub-population: matches
    // among sessions with a description, over sessions with a description. Mixing
    // title-only matches into a described-only denominator would swing the error
    // the other way. Count stays a count of every match — that number is true
    // whatever the coverage.
    const c = (topicShare ? t.byYearD?.[y] : t.byYear[y]) || 0;
    return share ? (denom[y] ? (c / denom[y]) * 100 : 0) : c;
  };
  // The axis has to fit what is DRAWN, and everything is now drawn as lines, so
  // the ceiling is the tallest single value.
  //
  // The first-timer/returning views used to be the exception: as stacked bars
  // their ceiling was the tallest STACK, because scaling to the tallest segment
  // sent a 496-person year off the top of the plot. Now that they are lines that
  // rule would waste half the height — two series summing to the ceiling means
  // neither ever reaches it — so the exception goes with the bars.
  let yMax = 0;
  for (const t of sel) for (const y of plotYears) yMax = Math.max(yMax, val(t, y));
  yMax = yMax || 1;

  const { W, H, padL, padR, padT, padB, yearStep } = chartGeom();
  const pw = W - padL - padR,
    ph = H - padT - padB;
  const X = (y) => padL + ((y - Y0) / (Y1 - Y0)) * pw;
  const Yv = (v) => padT + ph - (v / yMax) * ph;
  const fmt = (v) =>
    share
      ? `${v.toFixed(1)}%`
      : slots
        ? `${Math.round(v)}m`
        : // A register rate is single-digit-to-low-twenties per 1,000 words, so
          // rounding to whole numbers would flatten most of the movement away.
          register
          ? v.toFixed(1)
          : String(Math.round(v));

  let grid = '';
  for (let i = 0; i <= 4; i++) {
    const v = (yMax / 4) * i;
    const gy = Yv(v).toFixed(1);
    grid += `<line class="obs-tc-grid" x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}"/><text class="obs-tc-ylab" x="${padL - 7}" y="${(+gy + 3).toFixed(1)}" text-anchor="end">${fmt(v)}</text>`;
  }
  // Years INSIDE the plotted span that the current scope has nothing for. Those
  // years are now drawn at zero like any other, so the band and the label are
  // what keep a recorded zero and an unrecorded year apart — without them the
  // chart would assert that nothing happened in a year we simply never covered.
  let gaps = '';
  if (dataYears.length > 1) {
    const has = new Set(dataYears);
    const missing = plotYears.filter((y) => !has.has(y));
    for (const y of missing)
      gaps += `<rect class="obs-tc-gap" x="${(X(y) - 4).toFixed(1)}" y="${padT}" width="8" height="${ph.toFixed(1)}"><title>${y}: no events in this scope</title></rect>`;
    if (missing.length)
      gaps += `<text class="obs-tc-gaplab" x="${padL}" y="${(padT - 4).toFixed(1)}">no data: ${missing.join(', ')}</text>`;
  }

  // Highlight the selected year (the year facet shows as a gold band rather than
  // collapsing the timeline to a single point).
  let hi = '';
  if (_year !== 'All' && plotYears.includes(Number(_year))) {
    const hx = X(Number(_year));
    hi = `<line class="obs-tc-yearhi" x1="${hx.toFixed(1)}" y1="${padT}" x2="${hx.toFixed(1)}" y2="${padT + ph}"/>`;
  }
  // The reader's own margin notes on the time axis (see archiveAnnotations.js).
  // Drawn UNDER the data — an annotation explains the shape of the line, it does
  // not compete with it. Wordless on the plot: the name is in the crosshair
  // tooltip, which is where a reader already goes to ask about a year.
  const ann = annotationMarks({
    x: X,
    top: padT,
    bottom: padT + ph,
    min: plotYears[0],
    max: plotYears[plotYears.length - 1],
  });

  // ⚠ THE SAME "NOT FINISHED YET" WASH THE STACKED VIEW DRAWS. Without it the
  // final point reads as a collapse, when what it is is a year with events
  // still to come — see provisionalFrom().
  const provY = provisionalFrom();
  const provX = plotYears.some((y) => y >= provY) ? X(Math.max(plotYears[0], provY)) : null;
  const provBand =
    provX == null
      ? ''
      : `<rect class="obs-tc-prov" x="${provX.toFixed(1)}" y="${padT}" width="${(W - padR - provX).toFixed(1)}" height="${H - padT - padB}"/>` +
        `<text class="obs-tc-provl" x="${(provX + 4).toFixed(1)}" y="${padT + 11}">in progress</text>`;
  let xlab = '';
  for (const y of plotYears)
    if ((y - Y0) % yearStep === 0 || y === Y1)
      xlab += `<text class="obs-tc-xlab" x="${X(y).toFixed(1)}" y="${H - 9}" text-anchor="middle">'${String(y).slice(2)}</text>`;

  let lines = '';
  const geomSel = [];
  // Speakers Who / Who % and Sponsors Loyalty used to draw STACKED BARS here:
  // first-timers anchored to the baseline, returners on top, the stack's height
  // the whole cast. That read well on its own and badly with the reader's own
  // annotations, which are vertical marks on the same time axis — a bar 22px
  // wide sits on top of the mark explaining it.
  //
  // They are lines now, like every other view. The cost is real and worth
  // naming: two lines no longer add up to a visible total, so "how big was the
  // cast" has to be read from the tooltip rather than from the bar's height.
  // What the views are actually for — the first-timer/returner CROSSOVER, and
  // which way it is moving — is if anything easier to see as two lines. On the
  // share views the pair are exact mirrors about 50%, which makes the crossing
  // point the whole picture.
  for (const [si, t] of sel.entries()) {
    // Fixed sets in a fixed order — including the two-series stacked views, now
    // drawn as lines — take palette slots by POSITION rather than competing for
    // the keyword colour map.
    //
    // The register pair is positional too: its legend is a staticLegend, which
    // swatches by position, so looking the key up in commAll (where a lexicon is
    // not) would hand both lines slot -1 and leave the legend describing colours
    // the chart never drew.
    //
    // ⚠ COUNTRIES/SERIES MUST BE HERE TOO, AND WERE NOT. Falling through to
    // topicStyle() looks up a country in the KEYWORD colour map, which has no
    // entry for "Poland" — so every line resolved to slotStyle(-1), the single
    // overflow colour, and all eight were drawn identically while geoLegend()
    // swatched them positionally with eight different ones. A legend that
    // disagrees with the chart is worse than no legend.
    //
    // ⚠ AND SCALE→TOTAL BELONGS HERE TOO, FOR THE MIRROR-IMAGE REASON. It was
    // grouped with the single-line views below and given `var(--viz-1)`, which
    // is right for a view that draws ONE line and wrong for this one: it plots
    // TWO series, Events and Sessions, so both were stroked the same gold while
    // staticLegend() swatched them slot 0 and slot 1. The single-colour branch
    // is for single-series views only — the test is how many entries `sel` has,
    // not which panel it came from.
    const positional =
      lengths || slots || sponsorTiers || stacked || register || geo || countActive || countTotal;
    const style =
      sessions || hours || sponsorCount
        ? { color: 'var(--viz-1)', dash: '' }
        : positional
          ? slotStyle(si)
          : community
            ? slotStyle(commAll.findIndex((c) => c.key === t.key))
            : topicStyle(t.term);
    const col = style.color;
    geomSel.push({ term: t.term, color: col, byYear: t.byYear, byYearD: t.byYearD, raw: t.raw });
    // One continuous polyline across the whole span: a year with no data is a
    // point at zero, so the line dips to the baseline and back rather than
    // bridging the hole at height or breaking into disjoint runs.
    {
      const coords = plotYears.map((y) => `${X(y).toFixed(1)},${Yv(val(t, y)).toFixed(1)}`);
      // Sessions view is a filled area under a single gold line; keyword lines stay clean.
      if (sessions && plotYears.length > 1)
        lines += `<polygon class="obs-tc-area" points="${X(plotYears[0]).toFixed(1)},${padT + ph} ${coords.join(' ')} ${X(plotYears[plotYears.length - 1]).toFixed(1)},${padT + ph}"/>`;
      // A single-year scope has no line to draw — its dot below is the whole story.
      if (plotYears.length > 1)
        lines += `<polyline class="obs-tc-line${sessions ? ' obs-tc-line--lead' : ''}" data-term="${esc(t.term)}" points="${coords.join(' ')}" style="stroke:${col}"${dashAttr(style.dash)}/>`;
    }
    for (const y of plotYears) {
      const c = t.byYear[y] || 0;
      if (!c) continue;
      // A register year resting on ONE event is a weaker claim than one resting
      // on ten, so it is drawn hollow — but only where the scope holds
      // better-supported years to compare it with. Under a single annual
      // conference every year is a census and marking them all would say
      // nothing, so the ring stays off and the caption explains instead.
      const thin = regMixed && t.raw?.[y] === 1;
      lines += `<circle class="obs-tc-dot${thin ? ' obs-tc-dot--thin' : ''}" data-term="${esc(t.term)}" r="3" cx="${X(y).toFixed(1)}" cy="${Yv(val(t, y)).toFixed(1)}" style="${thin ? `fill:none;stroke:${col}` : `fill:${col}`}"/>`;
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
  return `<svg class="obs-tc" viewBox="0 0 ${W} ${H}" role="img" aria-label="${sessions ? 'Sessions per year' : 'Topic mentions over time'}">${grid}${provBand}${gaps}${ann}${hi}${xlab}<g class="obs-rise" style="--rise-base:${(padT + ph).toFixed(1)}px">${lines}</g></svg>`;
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

/**
 * The notes covering a hovered year, as tooltip rows.
 *
 * This is where an annotation's words live now. On the plot it is a wordless
 * band — four notes put four strings across the drawing and they collided with
 * each other and with the line — and a tooltip is both where the reader already
 * goes to ask about a year and the one place with room for the whole note
 * rather than a truncated label.
 *
 * Set apart from the data rows by a rule, because they are a different KIND of
 * statement: everything above is measured from the archive, and this is
 * something you wrote down.
 */
function annotationTipRows(year) {
  const notes = annotationsByYear().get(Number(year)) || [];
  if (!notes.length) return '';
  return `<div class="obs-tc-tip-ann">${notes
    .map(
      (a) =>
        `<div class="obs-tc-tip-row"><span class="obs-tc-tip-sw" style="background:${annotationColor(a)}"></span><span class="obs-tc-tip-t">${esc(a.label)}</span><b>${esc(yearRangeLabel(a))}</b></div>${
          a.note ? `<div class="obs-tc-tip-note">${esc(a.note)}</div>` : ''
        }`,
    )
    .join('')}</div>`;
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
              : REGISTER_VIEWS[_plot?.unit]
                ? // The rate, then how many events the median was taken over.
                  // Two events and eleven are very different claims.
                  `${r.value.toFixed(1)} <span class="obs-tc-tip-raw">per 1,000 words · ${num(r.raw)} event${r.raw === 1 ? '' : 's'}</span>`
                : _plot?.unit === 'minutes'
                  ? `${r.count} min`
                  : r.count
        }</b></div>`,
    )
    .join('');
  const notes = annotationTipRows(hit.year);
  // A year with no data but a note on it is exactly the case the note exists
  // for — 2020 is blank BECAUSE of the thing you wrote down. Bailing on empty
  // data rows used to make that year the one year you could not ask about.
  if (!rows && !notes) return hideChartTip();
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
  tip.innerHTML = `<div class="obs-tc-tip-y">${hit.year}</div>${rows}${cov}${notes}`;
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
  const back = `<button type="button" class="obs-back" data-back="1">← Back</button>`;
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
/**
 * A toggling legend for the Countries/Series line views.
 *
 * Same bargain as the keyword chips: the chart opens on the busiest eight and
 * every other key is one click away. The count rides along on each chip, so the
 * tail is still *countable* here even when it is not plotted — which is the
 * thing the Stacked sub-view exists to draw in full.
 *
 * @param {'countries'|'series'|'regions'} mode
 * @returns {string}
 */
function geoLegend(mode) {
  const sel = ensureGeoSel(mode);
  return geoSeries(mode)
    .map((g, i) => {
      const on = sel.has(g.key);
      return `<span class="obs-topic-chip${on ? ' is-on' : ''}" data-term="${esc(g.term)}">
        <button type="button" class="obs-topic-tog" data-geo="${esc(g.key)}" aria-pressed="${on}">${swatch(slotStyle(i), on)}${esc(g.term)}<span class="obs-rank-count">${num(g.total)}</span></button>
      </span>`;
    })
    .join('');
}

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
/** A lexicon's display label, falling back to its key on an older payload. */
function registerLabel(key) {
  return (_data.registerLexicons || []).find((l) => l?.key === key)?.label || key;
}

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
  const startAll = () => marks.forEach((el) => el.classList.add('is-rising'));
  if (typeof IntersectionObserver === 'undefined') {
    startAll();
    return;
  }
  // ⚠ OBSERVE THE CONTAINER, NOT THE SVG GROUPS. `.obs-rise` is a <g> inside the
  // chart's SVG, and intersection observation of SVG CHILD elements is not
  // reliable outside Chromium — Safari and Firefox can report a zero-size rect
  // and never fire. `is-armed` holds the group at scaleY(0) with the animation
  // paused, so a callback that never comes leaves the chart flattened to
  // nothing: axes drawn, not a single line visible. That is precisely what the
  // dashboard did on mobile, in more than one browser.
  //
  // The container is an ordinary HTML div, which every engine observes correctly.
  const host = root instanceof Element ? root : null;
  if (!host) {
    startAll();
    return;
  }
  _riseObserver?.disconnect();
  _riseObserver = new IntersectionObserver(
    (entries, obs) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        startAll();
        obs.unobserve(entry.target);
      }
    },
    // A sliver is enough — waiting for a quarter of a tall chart means scrolling
    // past the top of it before anything happens.
    { threshold: 0.01 },
  );
  marks.forEach((el) => el.classList.add('is-armed'));
  _riseObserver.observe(host);
  // ⚠ FAILSAFE. An entrance animation must never be the reason data cannot be
  // read: if the observer has not fired by now — zero-height container, a
  // browser quirk, a tab restored in the background — draw the chart anyway.
  // Losing the animation is nothing; losing the chart is the bug this had.
  if (typeof setTimeout === 'function') setTimeout(startAll, 1200);
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
  // The stacked view is a different drawing, not a different line style: it has
  // its own renderer, its own hit-testing (a <title> per segment) and no
  // crosshair, so it short-circuits the line path exactly as brackets do.
  const stackedView =
    (_chartMode === 'countries' || _chartMode === 'series' || _chartMode === 'regions') &&
    _chartView === 'stacked';
  if (chart) {
    if (stackedView) {
      _plot = null;
      const mode = /** @type {'countries'|'series'|'regions'} */ (_chartMode);
      chart.innerHTML = stackedChartSvg(stackModelFor(mode), { facet: GEO_FACET[mode] });
      armRise(chart);
      wireStacks(chart.closest('.obs-panel'));
    } else if (facets) {
      // Small multiples have no single plot to hit-test, so the crosshair and its
      // tooltip stay out of this view; each point carries its own <title>.
      _plot = null;
      chart.innerHTML = bracketPanels();
    } else {
      chart.innerHTML = `${topicChartSvg()}<div class="obs-tc-guide" id="obsTcGuide" hidden></div><div class="obs-tc-tip" id="obsTcTip" hidden></div>`;
    }
    if (!stackedView) {
      armRise(chart);
      watchChartWidth(chart);
    }
  }
  const leg = $('obsTopicLegend');
  // The keyword legend/add-box only makes sense for the Topics view.
  if (leg)
    leg.innerHTML =
      _chartMode === 'countries' || _chartMode === 'series' || _chartMode === 'regions'
        ? _chartView === 'stacked'
          ? // Every key, because that view's whole point is that nothing is hidden.
            stackedLegend(
              stackModelFor(/** @type {'countries'|'series'|'regions'} */ (_chartMode)),
              { facet: GEO_FACET[_chartMode] },
            )
          : geoLegend(/** @type {'countries'|'series'|'regions'} */ (_chartMode))
        : _chartMode === 'count'
          ? staticLegend(_chartView === 'active' ? ['Countries', 'Series'] : ['Events', 'Sessions'])
          : _chartMode === 'sponsors'
            ? _chartView === 'loyalty'
              ? staticLegend(['First time', 'Sponsored before'])
              : _chartView === 'tiers'
                ? staticLegend(
                    sponsorTierSeries((_view || computeView()).sponsors || [], (e) =>
                      inScope(e),
                    ).map((t) => t.term),
                  )
                : '' // Count is one line; the heading names it
            : _chartMode === 'community'
              ? REGISTER_VIEWS[_chartView]
                ? // A fixed pair, like Slot length or Loyalty — the legend names the
                  // two lines, it is not a control.
                  staticLegend(REGISTER_VIEWS[_chartView].map((k) => registerLabel(k)))
                : communityLegend()
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
    closeSearchResults();
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
  $('obsSearch')?.setAttribute('aria-expanded', 'true');
  setActiveResult(0);
}

/**
 * Close the suggestion list.
 *
 * It used to have no way to close: clicking anywhere else on the page left it
 * hanging over the content, because the only thing that ever emptied it was
 * typing fewer than two characters. Blur alone is the wrong signal — the list is
 * made of buttons, and blurring to click one would close it before the click
 * lands — so this is called from an outside-pointerdown handler and from Escape.
 */
function closeSearchResults() {
  const box = $('obsResults');
  if (!box) return;
  box.classList.remove('is-open');
  box.innerHTML = '';
  _activeResult = -1;
  const input = $('obsSearch');
  input?.removeAttribute('aria-activedescendant');
  input?.setAttribute('aria-expanded', 'false');
}

/** Which suggestion the arrow keys are on. -1 is "none — Enter searches sessions". */
let _activeResult = -1;

/**
 * Move the highlight, clamped to the list.
 *
 * The first row is the sessions search, so opening on 0 means Enter does the
 * thing the reader most often wants without touching an arrow key.
 */
function setActiveResult(index) {
  const box = $('obsResults');
  if (!box) return;
  const rows = [...box.querySelectorAll('.obs-result')];
  if (!rows.length) return;
  _activeResult = Math.max(0, Math.min(index, rows.length - 1));
  rows.forEach((row, i) => {
    const on = i === _activeResult;
    row.classList.toggle('is-active', on);
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(on));
    if (on) {
      row.id ||= `obs-result-${i}`;
      $('obsSearch')?.setAttribute('aria-activedescendant', row.id);
      row.scrollIntoView({ block: 'nearest' });
    }
  });
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

/**
 * Where a count applies — "in DrupalCon · 2024", or the whole archive.
 *
 * The unfiltered case says "the community" rather than "every series": it is
 * the one place this names a GROUP rather than echoing a filter, and the group
 * is the community. The filtered case still names what you picked, because
 * calling a DrupalCon-only count "the community" would be a different, wrong
 * claim. The chart captions carry none of this — the filter controls sit
 * directly above them, so restating the scope there was just length.
 */
function scopeSummary() {
  const parts = [_series, _region, _country, _year].filter((x) => x !== 'All');
  return parts.length ? `in ${parts.join(' · ')}` : 'across the community';
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
// What the programme is made of, under the session count. Workshops are part
// of the session total (a sprint is content someone attended); social events
// sit outside it, which is why they read as an addition rather than a share.
//
// Every segment is nowrap so a break can only fall BETWEEN segments. Left to
// wrap freely the tile reads "8,536 hours ·" / "356 days", stranding the
// separator at the end of a line.
function sessionMix(s) {
  const seg = (t) => `<span class="obs-nw">${t}</span>`;
  const mix = [];
  if (s.workshops) mix.push(`${num(s.workshops)} hands-on`);
  if (s.socials) mix.push(`${num(s.socials)} social`);
  const hours = programmeHours(s.minutes)
    .split(/\s*·\s*/)
    .map(seg)
    .join(' ');
  return mix.length ? `${hours}<span class="obs-tile-mix">${mix.map(seg).join(' ')}</span>` : hours;
}

function programmeHours(minutes) {
  const h = Math.round((minutes || 0) / 60);
  if (!h) return '';
  const days = h / 24;
  return days >= 20 ? `${num(h)} hours · ${Math.round(days)} days` : `${num(h)} hours`;
}

/**
 * "Attendance for 12 of 84 events, credits for 1."
 *
 * Both fractions in one clause, because both lines on that chart are drawn from
 * a minority of the archive and a line reads as the whole population unless
 * something says otherwise. It was two sentences of sixteen words; the numbers
 * are the part that matters.
 */
function populationCoverage() {
  const credits = creditsCoverage({
    events: _data ? flatEvents() : [],
    people: _data?.credits?.people || [],
    inScope: (e) => inScope(e),
  });
  let attendance = 0;
  let total = 0;
  for (const e of flatEvents())
    if (inScope(e)) {
      total += 1;
      if (Number.isFinite(e.attendance)) attendance += 1;
    }
  if (!total) return '';
  return ` Attendance for ${num(attendance)} of ${num(total)} events, credits for ${num(credits.withCredits)}.`;
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
/**
 * How thinly supported the plotted years are — only worth a word in the two
 * cases where it changes how the line should be read.
 *
 * A once-a-year conference plots one event per year by definition: a census,
 * not a thin sample.
 */
function registerThinNote() {
  const series = registerRates(
    _chartView,
    _data.registerEvents,
    _data.registerLexicons,
    (e) =>
      (_series === 'All' || e.series === _series) &&
      (_region === 'All' || e.region === _region) &&
      (_country === 'All' || e.country === _country),
  );
  const counts = Object.values(series[0]?.raw || {});
  if (!counts.length) return '';
  const thin = counts.filter((n) => n === 1).length;
  if (!thin) return '';
  if (thin === counts.length) return `One event a year, so each point is that edition. `;
  return `${thin} of ${counts.length} years rest${thin === 1 ? 's' : ''} on one event (hollow dots). `;
}

/**
 * "Read from 13 of 20 events with enough English text."
 *
 * SCOPED, like the chart above it. An archive-wide ratio printed under a
 * filtered chart is just a wrong number: filter to DrupalSouth and the honest
 * answer is 13 of 20, not 111 of 205.
 */
function registerCoverageNote() {
  const inScopeRow = (e) =>
    (_series === 'All' || e.series === _series) &&
    (_region === 'All' || e.region === _region) &&
    (_country === 'All' || e.country === _country);
  const read = (_data.registerEvents || []).filter(([, series, region, country]) =>
    inScopeRow({ series, region, country }),
  ).length;
  const events = flatEvents().filter((e) => inScope(e, true)).length;
  if (!read || !events) return '';
  return `From ${num(read)} of ${num(events)} events with enough English text.`;
}

/**
 * The sentence under the chart: one per (subject, view), so each says what IT is.
 *
 * SAY WHAT THE LINE IS, then only what a reader would otherwise MISREAD. The
 * reasoning behind a measure belongs in the code, not in the caption — these had
 * grown into method defences nobody asked for.
 */
function chartNote() {
  const notes = {
    programme: {
      sessions: `Sessions per year. Click a year to open its events.`,
      hours: `Hours of programme per year, from each session's recorded length.`,
      lengths: `Sessions grouped by how long they ran.`,
      lengthShare: `The same mix as a share of each year, so big and small years compare.`,
    },
    // "New" means new to the ARCHIVE, and that caveat stays: without it the
    // chart reads as a claim about someone's first-ever talk.
    speakers: {
      who: `Speakers per year, new against returning. New to <em>this archive</em>, not to speaking.`,
      whoShare: `How much of each year's cast was new. The halves always total 100%.`,
      slots: `Average slot length, first-year speakers against returning. Averaged over slots, not people.`,
      brackets: `Each length bracket on its own panel. One scale across all six.`,
    },
    sponsors: {
      count: `Organisations sponsoring each year. Counted once, however many events they backed.`,
      // Not one ladder: this stops a reader ranking tiers that were never ranked.
      tiers: `Sponsorship levels in each event's own words. Not one ladder — a Champion is not a Gold.`,
      loyalty: `Sponsoring organisations per year, new against returning.`,
    },
    community: {
      peak: `Five populations, each scaled to its own best year: shapes compare, sizes don't.${populationCoverage()}`,
      count: `The same five at real size.${populationCoverage()}`,
      // "Language, not sentiment" is the whole caveat, and it has to stay: the
      // chart is otherwise read as a mood ring.
      energy: `Collective and forward-looking language, per 1,000 words. Language, not sentiment. ${registerThinNote()}${registerCoverageNote()}`,
      headwinds: `Migration and difficulty language, per 1,000 words. Energy, pointed the other way. ${registerThinNote()}${registerCoverageNote()}`,
    },
  };
  return (
    notes[_chartMode]?.[_chartView] ||
    (_chartView === 'share'
      ? // The denominator matters: dividing by every session would turn a
        // capture gap into a fall in interest.
        `Keyword share of described sessions only — counting all of them would read a capture gap as lost interest.`
      : `Keywords from titles and descriptions. Add any word or phrase; pin what you care about.`)
  );
}

function chartControls() {
  const views = VIEWS[_chartMode] || [];
  return `<div class="obs-chart-bar">
    ${MODE_GROUPS.map(
      ([label, keys]) =>
        `<span class="obs-topic-views" role="group" aria-label="${esc(label)}">
      <span class="obs-mode-group-l">${esc(label)}</span>
      ${keys
        .map((mode) => {
          const text = (MODES.find(([m]) => m === mode) || [])[1] || mode;
          return `<button type="button" class="obs-topic-view${_chartMode === mode ? ' is-on' : ''}" data-mode="${mode}" aria-pressed="${_chartMode === mode}">${text}</button>`;
        })
        .join('')}
    </span>`,
    ).join('')}
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
        <label class="obs-scope-l" for="obsSearch">Search</label>
        <input id="obsSearch" type="search" class="obs-search-input" placeholder="Speakers, sponsors, events, series…" autocomplete="off" spellcheck="false"
               role="combobox" aria-expanded="false" aria-controls="obsResults" aria-autocomplete="list">
        <div class="obs-results" id="obsResults" role="listbox" aria-label="Search suggestions"></div>
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

/**
 * Re-draw whatever chart is on screen after the annotation set changed.
 *
 * Deliberately not "re-render everything": the archive shows one view at a
 * time, each owns its own charts, and blowing `#obsBody` away would drop the
 * drill-down the reader is reading. Each branch below re-runs the narrowest
 * render that redraws an axis.
 *
 * A view with no year axis (a speaker page, an event page) has nothing to
 * redraw and correctly does nothing — it will pick the note up when it is next
 * rendered, because the marks are read at draw time, not cached.
 */
function redrawAnnotations() {
  if (typeof document === 'undefined' || !_data) return;
  if ($('obsTopicChart')) renderTopics();
  else if (document.querySelector('.obs-subtabs')) renderHome();
  else if (_lastSearch && document.querySelector('.obs-st')) {
    showSessionSearch(_lastSearch.query, _sessMode);
  }
}

/** Render whichever home view is selected. */
function renderHome() {
  if (_homeTab === 'videos') return renderVideos();
  if (_homeTab === 'albums') return renderAlbums();
  if (_homeTab === 'sources') return renderSources();
  return renderDashboard();
}

/** Switch view mode, keeping the scope and putting the mode in the URL. */
function setHomeTab(tab, { push = true } = {}) {
  if (!HOME_TABS.some(([id]) => id === tab)) return;
  _homeTab = tab;
  _videoRows = [];
  if (push && typeof history !== 'undefined') {
    const path =
      tab === 'overview' ? archiveHref({ view: 'home' }) : archiveHref({ view: 'tab', tab });
    const qs = tab === 'videos' && _videoQ ? `?q=${encodeURIComponent(_videoQ)}` : '';
    pushArchiveState({ homeTab: tab }, `${path}${qs}`, { home: true });
  }
  renderHome();
}

// ── Sources ───────────────────────────────────────────────────────────────────
//
// Where the archive's data came from — written for a reader, not a maintainer.
//
// Two levels, because the flat version was a wall: the overview answers "how do
// I know any of this is true" in a paragraph and a few numbers, and every event
// is a door into its own bibliography. Nobody arrives wanting 469 URLs.
//
// Evidence and claim are reported separately throughout. `checked` describes the
// SOURCE; "cited to its own page" describes the CLAIM that a particular session
// came off it. They fail independently — an event can rest entirely on solid
// archived captures and still have every session attached by inference — and a
// blended score would hide whichever is worse.

/** Rows for the sources view: every in-scope event, provenance attached. */
export function sourceRows(yearEvents = {}, inScopeFn = () => true) {
  const rows = [];
  for (const [year, list] of Object.entries(yearEvents || {})) {
    for (const e of list || []) {
      if (!inScopeFn({ ...e, year: Number(year) })) continue;
      rows.push({ ...e, year: Number(year), sources: e.sources || null });
    }
  }
  return rows.sort(
    (a, b) =>
      String(b.startDate || '').localeCompare(String(a.startDate || '')) ||
      b.year - a.year ||
      String(a.label).localeCompare(String(b.label)),
  );
}

/**
 * Sourced records per year, for the scope in view.
 *
 * ONE series, deliberately. The first version plotted sources against events and
 * broke two ways at once. Events run 1–8 a year while sources run 5–58, so on a
 * shared axis the events line was a flat squiggle along the baseline — and two
 * measures of different scale on one plot is the classic misread, whether they
 * share an axis or get given one each.
 *
 * Worse, "sources per year" was not a fact about the archive at all: it spikes
 * at 2010, 2013, 2014 and 2016 — precisely the years scraped from captures that
 * happened to include a page per session. That is a chart of our method, the
 * same objection that took archive.org off this page.
 *
 * So the line is the material itself: every session and sponsor that cites a
 * source. It matches what the tiles above count, moves with the conferences
 * rather than with our tooling, and sits on one scale (129 → 827).
 *
 * @param {ReturnType<typeof sourceRows>} rows already filtered to the scope
 */
export function sourceTrendSvg(rows) {
  const years = [...new Set(rows.map((r) => Number(r.year)).filter(Boolean))].sort((a, b) => a - b);
  if (years.length < 2) return ''; // a single year is a number, not a trend

  const byYear = new Map(years.map((y) => [y, 0]));
  for (const row of rows) {
    const y = Number(row.year);
    if (!byYear.has(y)) continue;
    const p = row.sources || {};
    byYear.set(y, byYear.get(y) + (p.sessions || 0) + (p.sponsorCount || 0));
  }
  const vals = years.map((y) => byYear.get(y) || 0);
  const max = Math.max(...vals);
  if (!max) return '';

  const style = slotStyle(0);
  const W = 720;
  const H = 160;
  const padL = 40;
  const padR = 10;
  const padT = 16;
  const padB = 26;
  const pw = W - padL - padR;
  const ph = H - padT - padB;
  const X = (i) => padL + (i / (years.length - 1)) * pw;
  const Y = (v) => padT + ph - (v / max) * ph;

  const peak = vals.indexOf(max);
  const dots = vals
    .map((v, i) =>
      v
        ? `<circle class="obs-st-dot" style="fill:${style.color}" cx="${X(i).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="3"><title>${years[i]} · ${v} sourced records</title></circle>`
        : '',
    )
    .join('');

  // One direct label, on the peak. A number on every point is noise; the peak is
  // the only value a reader needs read out for them.
  const peakLabel = `<text class="obs-st-lab" x="${X(peak).toFixed(1)}" y="${(Y(max) - 8).toFixed(1)}"
    text-anchor="${peak > years.length - 3 ? 'end' : 'middle'}">${max}</text>`;

  const xlab = years
    .map((y, i) =>
      (y - years[0]) % 3 === 0 || y === years[years.length - 1]
        ? `<text class="obs-st-lab" x="${X(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">'${String(y).slice(2)}</text>`
        : '',
    )
    .join('');

  // This chart's x is an INDEX into a list that skips empty years, so a year
  // between two entries has to be placed proportionally — see yearPos().
  const ann = annotationMarks({
    x: (y) => X(yearPos(years, y)),
    top: padT,
    bottom: padT + ph,
    min: years[0],
    max: years[years.length - 1],
  });

  return `<div class="obs-st-wrap">
    <svg class="obs-st" viewBox="0 0 ${W} ${H}" role="img"
        aria-label="Sessions and sponsors citing a source, per year, ${years[0]} to ${years[years.length - 1]}. Peak ${max} in ${years[peak]}.">
      ${ann}
      <line class="obs-st-axis" x1="${padL}" y1="${padT + ph}" x2="${W - padR}" y2="${padT + ph}"/>
      <text class="obs-st-lab" x="${padL - 6}" y="${padT + ph}" text-anchor="end">0</text>
      <g class="obs-rise" style="--rise-base:${(padT + ph).toFixed(1)}px">
        <polyline class="obs-st-line" style="stroke:${style.color}"
          points="${vals.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ')}"/>
        ${dots}
      </g>
      ${peakLabel}
      ${xlab}
    </svg>
    <p class="obs-st-cap">By year, across the events in view.</p>
  </div>`;
}

/** Archive-wide totals for the scope in view. */
export function sourceTotals(rows) {
  let sources = 0;
  let references = 0;
  let wayback = 0;
  let stated = 0;
  let unchecked = 0;
  let exact = 0;
  let cited = 0;
  let ownPage = 0;
  let sessions = 0;
  let sponsors = 0;
  let noSources = 0;
  let undated = 0;
  let oldestCapture = null;
  for (const row of rows) {
    const p = row.sources;
    if (!p || !p.count) {
      noSources += 1;
      continue;
    }
    sources += p.count;
    references += p.references || 0;
    if (p.wayback) wayback += 1;
    stated += p.stated || 0;
    unchecked += p.count - ((p.tiers?.verified || 0) + (p.tiers?.accepted || 0));
    undated += p.undated || 0;
    exact += p.exact || 0;
    cited += p.cited || 0;
    ownPage += p.ownPage || 0;
    sessions += p.sessions || 0;
    sponsors += p.sponsorCount || 0;
    if (p.oldestCapture && (!oldestCapture || p.oldestCapture < oldestCapture)) {
      oldestCapture = p.oldestCapture;
    }
  }
  return {
    events: rows.length,
    sources,
    references,
    waybackEvents: wayback,
    stated,
    unchecked,
    exact,
    cited,
    ownPage,
    sessions,
    sponsors,
    noSources,
    undated,
    oldestCapture,
    // What share of sessions can be checked at their own page. The registry
    // figure (`exact`) measures how thoroughly the backfill wrote citations,
    // not how traceable the archive is, and reporting it as the headline said
    // 1% of an archive where most sessions link straight to their source.
    ownPagePct: sessions ? Math.round((ownPage / sessions) * 100) : 0,
    exactPct: cited ? Math.round((exact / cited) * 100) : 0,
  };
}

/** The slug an event's provenance page lives at. */
export function sourceDrillPath(file) {
  return archiveHref({ view: 'source', key: String(file || '').replace(/\.json$/, '') });
}

/** One compact, clickable row per event on the overview. */
function sourceRowHtml(row) {
  const p = row.sources;
  const file = String(row.file || '');
  if (!p || !p.count) {
    return `<div class="obs-ev obs-ev--muted">
      <span class="obs-ev-y">—</span>
      <div class="obs-ev-main"><span class="obs-ev-t">${esc(row.label)}</span>
      <span class="obs-ev-s">no sources recorded</span></div>
    </div>`;
  }
  // What the event holds, not how well we cited it. The citation ratio that
  // used to sit here measured our scraping rather than the conference — see
  // claimSentence — and read as a mark out of ten on somebody else's archive.
  const bits = [];
  if (p.sessions) bits.push(plural(p.sessions, 'session'));
  if (p.sponsorCount) bits.push(plural(p.sponsorCount, 'sponsor'));
  if (p.stated) bits.push(plural(p.stated, 'stated source'));
  // The leading number is REFERENCES, not registry size. Ranked on the registry
  // a captured event looks like a wild outlier — DrupalSouth 2010 shows 33
  // where its neighbours show 1 or 2 — when what differs is that its session
  // pages were archived and theirs were not. By pages referenced it is 33
  // against their 90-odd: unremarkable, which is the truth.
  return `<div class="obs-ev obs-clickable" data-source-event="${esc(file)}" role="button" tabindex="0">
    <span class="obs-ev-y">${p.references ?? p.count}</span>
    <div class="obs-ev-main"><span class="obs-ev-t">${esc(row.label)}</span>
    <span class="obs-ev-s">${esc(bits.join('  ·  '))}</span></div>
  </div>`;
}

/** The overview: a paragraph, a few numbers, and a door per event. */
async function renderSources() {
  const body = $('obsBody');
  if (!body) return;
  destroyMap();
  destroyStripMap();
  setCrumbs();
  const rows = sourceRows(_data?.yearEvents, (e) => inScope(e));
  const t = sourceTotals(rows);

  // No archive.org headline here. Where a given page came from is recorded
  // against each source and reachable from the event's own page; leading the
  // whole section with it would make this project's sourcing method the story
  // rather than the conferences.

  body.innerHTML = `
    ${homeTopbar()}
    ${homeTabsHtml()}
    <p class="obs-sub">${
      rows.length
        ? `${plural(t.sources, 'source')} across ${plural(t.events, 'event')} ${esc(scopeSummary())}`
        : 'No events in this scope.'
    }</p>
    <div class="obs-src-intro">
      <p>Every session, sponsor and organiser in this archive records where it came
      from. Open an event to see its sources and follow them back.</p>
    </div>
    ${
      rows.length
        ? `<div class="obs-src-stats">
            ${statTile(t.sessions + t.sponsors, 'sourced records', 'sessions and sponsors that cite a source')}
            ${statTile(t.sessions, 'sessions', 'each traceable to where it was published')}
            ${statTile(t.sponsors, 'sponsors', 'recorded against the page that listed them')}
            ${statTile(t.references, 'pages referenced', 'every address these events point at')}
          </div>
          ${sourceTrendSvg(rows)}
          <h3 class="obs-src-h">What survives</h3>
          ${(() => {
            const years = (_view || computeView()).years || [];
            if (!canShowSurvival(years)) {
              // Only reachable against a server older than these fields. Saying
              // so beats drawing 0% over a programme that is 91% described.
              return `<p class="obs-src-note">Needs a newer server — the per-event
              figures aren't in this payload. Nothing else here is affected.</p>`;
            }
            return `<p class="obs-src-note">How much of each year this archive still
            holds, not how much happened. Descriptions as a share of the programme;
            recordings and galleries as counts, each scaled to its own maximum.</p>
            <div class="obs-panel">${survivalChart(years)}</div>`;
          })()}
          <h3 class="obs-src-h">Every event</h3>
          <div class="obs-evlist">${rows.map(sourceRowHtml).join('')}</div>`
        : ''
    }`;
}

function statTile(value, label, note) {
  return `<div class="obs-src-stat">
    <span class="obs-src-stat-v">${esc(String(value))}</span>
    <span class="obs-src-stat-l">${esc(label)}</span>
    <span class="obs-src-stat-n">${esc(note)}</span>
  </div>`;
}

/**
 * One group of provenance entries: a heading, said once, then the entries.
 *
 * Replaces a flat list that repeated the kind on every row — five schedule
 * pages meant the word "schedule" five times down the left margin, which reads
 * as five different things rather than one thing with five parts. The label
 * belongs to the group, not the row; the count sits opposite it.
 *
 * Long groups collapse into a `<details>`: 42 session links and 28 recordings
 * are worth having but not worth scrolling past to reach the next heading.
 * Native `<details>` rather than a scripted accordion — keyboard- and
 * screen-reader-correct for free, survives having no JavaScript, and Ctrl-F
 * still finds text inside it in current browsers.
 *
 * @param {string} label
 * @param {string} note the count, set opposite the label
 * @param {{href?: string, text?: string, meta?: string}[]} entries
 * @param {{collapseOver?: number, external?: boolean}} [opts]
 */
function sourceGroupHtml(label, note, entries, opts = {}) {
  if (!entries.length) return '';
  const { collapseOver = 0, external = false } = opts;
  const inner = external ? outboundRowsHtml(entries) : linkRowsHtml(entries);
  const head = `<span class="obs-src-group-t">${esc(label)}</span>${
    note ? `<span class="obs-src-group-n">${esc(note)}</span>` : ''
  }`;

  if (collapseOver && entries.length > collapseOver) {
    return `<details class="obs-src-group obs-src-details">
      <summary class="obs-src-group-h">${head}</summary>
      ${inner}
    </details>`;
  }
  return `<section class="obs-src-group">
    <h4 class="obs-src-group-h">${head}</h4>
    ${inner}
  </section>`;
}

/** Registry entries: one bordered row each, with its retrieval date. */
function linkRowsHtml(entries) {
  return `<ul class="obs-src-list">
    ${entries
      .map(
        (e) => `<li class="obs-src-line">
          <span class="obs-src-body">${
            e.href
              ? `<a href="${esc(e.href)}" target="_blank" rel="noopener noreferrer">${esc(
                  e.text || e.href,
                )} <span aria-hidden="true">↗</span></a>`
              : `<span class="obs-src-stated">${esc(e.text || '')}</span>`
          }</span>
          ${e.meta ? `<span class="obs-src-when">${esc(e.meta)}</span>` : ''}
        </li>`,
      )
      .join('')}
  </ul>`;
}

/** The host of a URL, for the row's leading column. Empty if unparseable. */
function hostOf(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Records' outbound links, in the archive's own event-row shape.
 *
 * The session search already sets the pattern — a mono leading column, the
 * title, and a marker on the right — and inventing bordered buttons next to it
 * made this read as a different application. Same three columns here, with the
 * host in the leading column: it says where the link goes before you follow it,
 * which matters when a conference splits its sessions across two domains or a
 * recording is on Vimeo rather than YouTube.
 */
function outboundRowsHtml(entries) {
  return `<div class="obs-evlist obs-evlist--links">
    ${entries
      .map(
        (e) => `<a class="obs-ev obs-ev--link" href="${esc(e.href)}"
          target="_blank" rel="noopener noreferrer">
          <span class="obs-ev-y">${esc(e.meta || hostOf(e.href))}</span>
          <div class="obs-ev-main">
            <span class="obs-ev-t">${esc(e.text || e.href)}</span>
          </div>
          <span class="obs-ev-caret" aria-hidden="true">↗</span>
        </a>`,
      )
      .join('')}
  </div>`;
}

/**
 * The standing note about dead links, shown once at the top.
 *
 * Deliberately says nothing about how many of these sources we recovered from a
 * capture. That is recorded against each source for anyone who wants it, but
 * announcing it makes this project's sourcing method the subject of a page that
 * is supposed to be about the conference. What a reader needs from us here is
 * one thing: what to do when a link does not answer.
 */
function archiveNoteHtml() {
  return `<p class="obs-src-lede">Links below point at the addresses as they were
    published. Some of these pages have since moved or gone — if one does not answer, try
    it at <a href="https://web.archive.org/" target="_blank" rel="noopener noreferrer">the
    Internet Archive <span aria-hidden="true">↗</span></a>.</p>`;
}

/** Registry sources, grouped by kind, in a deliberate reading order. */
const KIND_ORDER = [
  'schedule',
  'sessions',
  'sponsors',
  'community',
  'speaker',
  'venue',
  'stats',
  'video',
  'photos',
  'other',
];
const KIND_LABEL = {
  schedule: 'Schedule pages',
  sessions: 'Session pages',
  sponsors: 'Sponsor listings',
  community: 'Community & organisers',
  speaker: 'Speaker listings',
  venue: 'Venue & travel',
  stats: 'Reported figures',
  video: 'Recordings',
  photos: 'Photos',
  other: 'Other pages',
};

export function registryGroupsHtml(list) {
  /** @type {Map<string, any[]>} */
  const byKind = new Map();
  for (const source of list) {
    // Per-session pages are shown under "Where its records point", with every
    // other event's session pages, NEVER here. Whether one is in the registry
    // depends only on whether that scrape captured it — so leaving them here
    // put DrupalSouth 2010's sessions in a different part of the page from
    // DrupalCon Paris 2009's, for a reason no reader could see.
    if (source.kind === 'sessions') continue;
    if (!byKind.has(source.kind)) byKind.set(source.kind, []);
    byKind.get(source.kind).push(source);
  }
  // A deliberate reading order — how the event was assembled, roughly — with
  // anything unrecognised last rather than wherever Map iteration put it.
  const kinds = [...byKind.keys()].sort((a, b) => {
    const ia = KIND_ORDER.indexOf(a);
    const ib = KIND_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  return kinds
    .map((kind) => {
      const sources = byKind.get(kind);
      // One row per source, the ORIGINAL address only. Each archived copy used
      // to get a row of its own, which doubled the length of every recovered
      // event's bibliography and put a long wayback URL — not what was
      // published, and not what a reader recognises — beside every address.
      // The standing note at the top of the page covers them all instead.
      const entries = sources.map((source) => ({
        href: source.stated ? null : source.url || null,
        text: source.stated ? source.title || source.id : source.title || source.url || source.id,
        meta: source.retrievedAt ? `retrieved ${source.retrievedAt}` : 'no retrieval date',
      }));
      // Collapse on the same threshold the record links use. A well-sourced
      // event records a page per session — 28 rows for DrupalSouth 2010 — so
      // this is the same wall the accordion was added for, just moved into the
      // registry once the duplicate rendering was removed. (The trailing `60`
      // here was a leftover from the old positional signature and had been
      // silently ignored since it became an options object.)
      return sourceGroupHtml(KIND_LABEL[kind] || kind, String(sources.length), entries, {
        collapseOver: 8,
      });
    })
    .join('');
}

/**
 * What the numbers mean, in a sentence.
 *
 * Written out rather than left as a percentage because the distinction is
 * genuinely subtle. The no-sessions case says what the event DOES hold instead
 * of announcing an absence — an event can be an archive of recordings and
 * photographs and still have no session list, and "records no sessions" made
 * that read as a broken record.
 */
export function claimSentence(p, extras = {}) {
  if (!p.sessions) {
    // Deliberately makes no claim about WHY. "Survives" reads as loss, and it
    // was being said about events whose schedule is still live and simply has
    // not been imported yet — which is a gap in this archive, not in history.
    const has = [];
    if (extras.videos) has.push(plural(extras.videos, 'recording'));
    if (extras.photos) has.push('a photo album');
    return has.length
      ? `No sessions are recorded here yet — what this event holds so far is ${has.join(' and ')}.`
      : 'No sessions are recorded for this event yet.';
  }
  // Nothing is said about how many sessions have a page of their own. Plenty of
  // conferences never publish one — the schedule IS the record, and it is right
  // there in the list below — so a ratio framed it as a shortfall when it is
  // just how that conference published. It measured our scraping, not their
  // archive.
  return '';
}

/**
 * The event drill: one event's full provenance, including where its records point.
 *
 * Stays synchronous and returns a boolean because the router uses that answer to
 * decide whether to retry once the payload lands — an async version always
 * returns a truthy Promise, so a miss would look like a hit and the retry would
 * never happen. The per-record links arrive separately, in hydrateSourceRecords.
 */
export function openSourceDrill(file) {
  destroyMap();
  destroyStripMap();
  const rows = sourceRows(_data?.yearEvents, () => true);
  const row = rows.find((r) => String(r.file || '').replace(/\.json$/, '') === String(file));
  const body = $('obsBody');
  if (!body) return false;
  if (!row) return false;

  setCrumbs([{ label: 'Sources', href: '/archive/sources' }, { label: row.label }]);
  const p = row.sources;
  const back = `<button type="button" class="obs-back" data-back="sources">← Back to sources</button>`;

  if (!p || !p.count) {
    body.innerHTML = `${back}
      <div class="obs-drill-head">
        <span class="obs-eyebrow">Sources</span>
        <h2 class="obs-drill-name">${esc(row.label)}</h2>
        <p class="obs-sub">No sources recorded for this event.</p>
      </div>`;
    toTopOfView();
    return true;
  }

  // What this page actually holds, in the order it appears below. The old line
  // read "2 sources · 2 checked · 2 undated" — three numbers about our
  // bookkeeping, two of them the same figure, and none of them describing the
  // event. "checked" was the worst of them: it counts policy acceptance, so it
  // told a reader a person had looked when nobody had.
  // Counts the REFERENCES on this page, not the registry. The registry holds
  // the pages the dataset was built from — two or three — while the page also
  // lists every session page, recording and album the records point at. Saying
  // "2 sources" above a screen showing seventy links was simply describing a
  // different thing from the one being read.
  const summaryBits = [
    `${plural(p.references ?? p.count, 'reference')} in all`,
    `${p.count} recorded as ${p.count === 1 ? 'a source' : 'sources'}`,
  ];
  if (p.sessions) summaryBits.push(plural(p.sessions, 'session'));
  if (p.sponsorCount) summaryBits.push(plural(p.sponsorCount, 'sponsor'));

  // Paint the registry immediately, then fill in the per-record links once the
  // dataset arrives. The bibliography is already in the payload; making the
  // reader wait on a fetch for it would be a regression.
  body.innerHTML = `${back}
    <div class="obs-drill-head">
      <span class="obs-eyebrow">Sources · ${row.year || ''}</span>
      <h2 class="obs-drill-name">${esc(row.label)}</h2>
      <p class="obs-sub" id="obsSrcSummary">${esc(summaryBits.join(' · '))}</p>
    </div>
    ${archiveNoteHtml()}
    <p class="obs-src-claim${claimSentence(p) ? '' : ' hidden'}" id="obsSrcClaim">${esc(
      claimSentence(p),
    )}</p>
    <h3 class="obs-src-h">What this event was built from</h3>
    ${registryGroupsHtml(p.list)}
    <div id="obsSrcRecords"><p class="obs-src-more">Loading the pages its records point at…</p></div>`;
  toTopOfView();

  hydrateSourceRecords(String(row.file || ''), p);
  return true;
}

/**
 * The Session pages list: every per-session page, from wherever it is recorded.
 *
 * Sessions come from two places and must land in one list. Most events keep the
 * page on the session (`items[].link`); an event scraped from captures also has
 * it in the registry as a `sessions` source. Which of the two happened is an
 * accident of how that year was scraped, and a reader should not be able to
 * tell — DrupalSouth 2010 was showing its sessions in a different part of the
 * page from DrupalCon Paris 2009 for exactly that reason.
 *
 * @param {any[]} items the dataset's sessions
 * @param {any[]} sessionSources registry entries of kind `sessions`
 * @param {(url: string) => boolean} fresh false for URLs already shown elsewhere
 */
export function sessionEntries(items, sessionSources, fresh = () => true, opts = {}) {
  const { agenda = false } = opts;
  const seen = new Set();
  const out = [];
  for (const item of items || []) {
    // Lunch is not a session. It is on the schedule and it may well have a page,
    // so it is listed — just not among the talks.
    if (countsAsSession(item) === agenda) continue;
    const href = String(item?.link || '').trim();
    if (!href || !fresh(href) || seen.has(href)) continue;
    seen.add(href);
    out.push({ href, text: String(item.title || href) });
  }
  // Registry session sources belong to the programme, never to the agenda list.
  if (agenda) return out;
  // A captured session page whose session is no longer in the dataset still
  // belongs on the list — it is evidence about this event either way.
  for (const source of sessionSources || []) {
    if (!source?.url || seen.has(source.url)) continue;
    seen.add(source.url);
    out.push({ href: source.url, text: source.title || source.url });
  }
  return out;
}

/**
 * Fill in the pages the event's own records point at, once the dataset arrives.
 *
 * Fetched on demand rather than shipped in the insights payload: these are
 * ~6,600 session links archive-wide, and nobody needs them until they open one
 * event. Fire-and-forget — the registry is already on screen.
 */
async function hydrateSourceRecords(file, p) {
  const data = await fetchDataset(file);
  const slot = $('obsSrcRecords');
  // The reader may have navigated on while that was in flight.
  if (!slot || !slot.isConnected) return;

  const items = data.items || [];
  const event = data.event || {};

  // A page the registry already lists is not repeated here — one URL, one row,
  // wherever it is stored. The exception is per-session pages: those belong in
  // this section by definition, so they are drawn in from the registry too and
  // merged with the sessions' own links.
  const sessionSources = (p.list || []).filter((x) => x.kind === 'sessions' && x.url);
  const registered = new Set(
    (p.list || [])
      .filter((x) => x.kind !== 'sessions')
      .map((x) => x.url)
      .filter(Boolean),
  );
  const fresh = (url) => url && !registered.has(url);

  const sessions = sessionEntries(items, sessionSources, fresh);
  const agenda = sessionEntries(items, [], fresh, { agenda: true });

  const videos = items
    .map((i) => {
      const url = String(i.video_url || '').trim();
      return { href: url, text: String(i.title || url), meta: videoRef(url).host || '' };
    })
    .filter((e) => fresh(e.href));

  const photos = [];
  const album = String(event.flickr?.groupUrl || '').trim();
  if (fresh(album)) {
    photos.push({ href: album, text: String(event.flickr.provider || 'Photo album') });
  }
  const playlist = String(event.videoPlaylist || '').trim();
  if (fresh(playlist)) {
    videos.unshift({ href: playlist, text: 'Full playlist for this event', meta: 'playlist' });
  }

  // Sponsor websites are deliberately NOT listed. A sponsor's own site is the
  // sponsor, not provenance for it — and a decade on, many are dead, parked or
  // repointed at whoever bought them. What IS provenance is the page that said
  // they sponsored this event, so the count is stated against that page.
  const sponsorPages = (p.list || []).filter((x) => x.kind === 'sponsors' && x.url);
  const sponsorNote = p.sponsorCount
    ? sponsorPages.length
      ? `<p class="obs-src-more">${plural(
          p.sponsorCount,
          'sponsor',
        )} recorded for this event, listed at ${sponsorPages
          .map(
            (x) =>
              `<a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.url)}</a>`,
          )
          .join(' and ')}.</p>`
      : `<p class="obs-src-more">${plural(
          p.sponsorCount,
          'sponsor',
        )} recorded for this event, but no sponsor listing page was captured — they are attributed to the schedule instead.</p>`
    : '';

  // The sentence at the top could not know about recordings and photographs
  // until this fetch landed; an event with no sessions but 40 talks on video is
  // not an empty record and should not have said so.
  // Now that the dataset is here, lead with the total: every address this page
  // will send you to, of any kind.
  const summary = $('obsSrcSummary');
  if (summary) {
    const parts = [
      `${plural(p.references ?? p.count, 'reference')} in all`,
      `${p.count} recorded as ${p.count === 1 ? 'a source' : 'sources'}`,
    ];
    if (sessions.length) parts.push(`${sessions.length} session pages`);
    if (agenda.length) parts.push(`${agenda.length} break and logistics pages`);
    if (videos.length) parts.push(plural(videos.length, 'recording'));
    if (photos.length) parts.push(plural(photos.length, 'album'));
    if (p.sponsorCount) parts.push(plural(p.sponsorCount, 'sponsor'));
    summary.textContent = parts.join(' · ');
  }

  const claim = $('obsSrcClaim');
  if (claim && !p.sessions) {
    const line = claimSentence(p, { videos: videos.length, photos: photos.length });
    claim.textContent = line;
    claim.classList.toggle('hidden', !line);
  }

  const groups = [
    sourceGroupHtml('Session pages', String(sessions.length), sessions, {
      collapseOver: 8,
      external: true,
    }),
    sourceGroupHtml('Recordings', String(videos.length), videos, {
      collapseOver: 8,
      external: true,
    }),
    sourceGroupHtml('Photos', String(photos.length), photos, { external: true }),
    // Its own group, below the programme: breaks and registration are part of
    // the record but they are not what anyone came to read.
    sourceGroupHtml('Breaks and logistics', String(agenda.length), agenda, {
      collapseOver: 4,
      external: true,
    }),
  ].filter(Boolean);

  slot.innerHTML =
    groups.length || sponsorNote
      ? `<h3 class="obs-src-h">Where its records point</h3>${groups.join('')}${sponsorNote}`
      : '<p class="obs-src-more">Its records carry no outbound links of their own.</p>';
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

/** The scope/query the recordings list is currently showing, minus paging. */
function videoQueryParams() {
  const params = new URLSearchParams({ q: _videoQ, video: '1' });
  params.set('mode', _sessMode);
  params.set('limit', String(VIDEO_PAGE));
  if (_series !== 'All') params.set('series', _series);
  if (_region !== 'All') params.set('region', _region);
  if (_country !== 'All') params.set('country', _country);
  if (_year !== 'All') params.set('year', String(_year));
  return params;
}

/**
 * "1,204 recordings across every series · showing 60".
 *
 * scopeSummary() supplies its own preposition — "in 2024", "across every
 * series" — so it is appended, not introduced.
 *
 * Returns PLAIN TEXT, not HTML: paging assigns it to textContent, where an
 * escaped `&` would surface to the reader as `&amp;`. The one caller that
 * interpolates it into markup escapes it there.
 */
export function videoCountLine(total, shown, query, scope) {
  const head = query
    ? `${num(total)} recording${total === 1 ? '' : 's'} match “${query}” ${scope}`
    : `${num(total)} recording${total === 1 ? '' : 's'} ${scope}`;
  return shown < total ? `${head} · showing ${num(shown)}` : head;
}

export const videoMoreLabel = (total, shown) =>
  `Show ${num(Math.min(VIDEO_PAGE, Math.max(0, total - shown)))} more`;

/** The Show-more footer, or nothing once the whole result set is on the page. */
export const videoMoreHtml = (total, shown) =>
  shown < total
    ? `<div class="obs-more-wrap"><button type="button" class="obs-more" data-vid-more="1">${videoMoreLabel(
        total,
        shown,
      )}</button></div>`
    : '';

/**
 * Add the next page of recordings to the grid.
 *
 * Deliberately NOT a re-render. renderVideos() rebuilds `body`, and its first
 * act is to drop the panel to a one-line "Searching recordings…" placeholder
 * while the request is in flight. That collapses the document to a fraction of
 * its height, the browser clamps the scroll position to what is left, and the
 * reader is thrown back to the top of the page having lost the row they were
 * on. Appending leaves every card — and the scroll position — untouched, which
 * is what the sessions panel already does for the same reason.
 */
async function appendVideoPage(btn) {
  if (btn.disabled) return;
  btn.disabled = true;
  btn.textContent = 'Loading…';

  const gen = _videoGen;
  const params = videoQueryParams();
  params.set('offset', String(_videoRows.length));
  let data;
  try {
    const r = await fetch(new URL(`../../api/archive/sessions?${params}`, import.meta.url));
    data = r.ok ? await r.json() : null;
  } catch {
    data = null;
  }
  // The tab may have been switched, or a new search run, while the request was
  // in flight — page 3 of the query the reader just abandoned must not be
  // concatenated onto page 1 of the one they replaced it with.
  if (_homeTab !== 'videos' || gen !== _videoGen) return;
  if (!data?.results?.length) {
    // Say so on the button itself: a control that silently does nothing reads
    // as a broken page rather than as a failed request.
    btn.textContent = data ? 'No more to show' : 'Could not load more — try again';
    btn.disabled = !!data;
    return;
  }

  const body = $('obsBody');
  body
    ?.querySelector('[data-vid-grid]')
    ?.insertAdjacentHTML('beforeend', data.results.map(videoCardHtml).join(''));
  _videoRows = _videoRows.concat(data.results);
  _videoTotal = data.total;

  const count = body?.querySelector('[data-vid-count]');
  if (count)
    count.textContent = videoCountLine(_videoTotal, _videoRows.length, _videoQ, scopeSummary());

  if (_videoRows.length >= _videoTotal) btn.closest('.obs-more-wrap')?.remove();
  else {
    btn.disabled = false;
    btn.textContent = videoMoreLabel(_videoTotal, _videoRows.length);
  }
}

async function renderVideos() {
  const body = $('obsBody');
  if (!body) return;
  _videoGen += 1;
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

  const params = videoQueryParams();
  params.set('offset', '0');

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

  // A fresh render is always page one; paging is appendVideoPage()'s job and
  // never comes back through here.
  _videoRows = data.results;
  _videoTotal = data.total;

  body.innerHTML = shell(`
    <p class="obs-sub" data-vid-count>${esc(videoCountLine(data.total, _videoRows.length, _videoQ, scopeSummary()))}</p>
    ${
      _videoRows.length
        ? `<div class="obs-vid-grid" data-vid-grid>${_videoRows.map(videoCardHtml).join('')}</div>`
        : `<p class="obs-topic-empty">No recordings here yet. ${
            _videoQ ? 'Try a different term, or' : 'Try'
          } widening the filters.</p>`
    }
    ${videoMoreHtml(data.total, _videoRows.length)}
  `);
  if (typeof history !== 'undefined') {
    // replaceState, not push: typing a new term is a refinement of this view, not
    // a new place — Back should leave the videos, not walk the search history.
    // The video query rides in `?q=` in BOTH forms — a search term is not a
    // path segment — so the base address comes from the router and the query is
    // appended to whatever it returns.
    const base = archiveHref({ view: 'tab', tab: 'videos' });
    const params = new URLSearchParams(base.includes('?') ? base.split('?')[1] : '');
    if (_videoQ) params.set('q', _videoQ);
    if (_sessMode === 'contains') params.set('match', 'contains');
    const qs = params.toString();
    history.replaceState({ homeTab: 'videos' }, '', `${base.split('?')[0]}${qs ? `?${qs}` : ''}`);
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
      <div class="obs-tile"><div class="obs-tile-n">${communityYears(s.yearMin, s.yearMax)}</div><div class="obs-tile-l">Years of community</div><div class="obs-tile-s"><span class="obs-nw">${s.yearMin}–${s.yearMax}</span> <span class="obs-nw">${s.yearCount ?? s.yearMax - s.yearMin + 1} with events</span></div></div>
      <div class="obs-tile"><div class="obs-tile-n">${num(s.sessions)}</div><div class="obs-tile-l">Sessions</div><div class="obs-tile-s">${sessionMix(s)}</div></div>
      ${peopleTile(v, organisers, volunteers)}
      <div class="obs-tile"><div class="obs-tile-n">${num(s.sponsors)}</div><div class="obs-tile-l">Sponsors</div><div class="obs-tile-s">${num(s.sponsorSlots)} slots</div></div>
    </div>
    <div class="obs-stripmap-wrap">
      <div class="obs-stripmap-map obs-maxable">
        ${mapResetBtn()}
        <div class="obs-stripmap" id="obsStripMap"></div>
        <div class="obs-mapfilters" id="obsMapFilters"></div>
      </div>
      <aside class="obs-globe" id="obsGlobe"></aside>
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
            community: {
              peak: 'The community, side by side',
              count: 'The community, side by side',
              energy: 'Which way the programme faces',
              headwinds: 'What the programme is pushing against',
            }[_chartView],
          }[_chartMode] || 'What the community talked about'
        }</h2>
      </div>
      ${chartControls()}
      <p class="obs-section-note obs-topic-sub">${chartNote()}</p>
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
    </div></div>
    ${tipPromptHtml()}`;
  renderTopics();
  renderRanks();
  initStripMap();
  // The maximise controls come from observeMaximise(), wired once for the whole
  // page; the stacked chart arms its own hover in renderTopics().
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
    _videoRows = [];
    // The cached view is the scope being cleared. This is the worst place to
    // leave it stale: clearing a filter is what somebody does to ESCAPE an
    // empty panel, and without this the panel stayed exactly as empty as it
    // was — the filter chip gone, the numbers still those of a scope no longer
    // selected.
    _view = null;
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
    _videoRows = [];
    // Videos does not read the cached view, but every other tab does, and this
    // reset drops all four facets — leaving it would carry the old scope into
    // whichever tab is opened next.
    _view = null;
    renderVideos();
    return;
  }
  const modeBtn = e.target.closest('[data-vid-mode]');
  if (modeBtn) {
    _sessMode = modeBtn.dataset.vidMode === 'contains' ? 'contains' : 'exact';
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
  const vidMore = e.target.closest('[data-vid-more]');
  if (vidMore) {
    appendVideoPage(vidMore);
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
    mapIdentity(mapGo.dataset.kind, mapGo.dataset.name, $('obsMapidInput')?.value);
    return;
  }
  const toSessions = e.target.closest('[data-sessions]');
  if (toSessions) {
    openSessionSearch(toSessions.dataset.sessions);
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
      if (!VIEWS[next]?.some(([k]) => k === _chartView)) _chartView = defaultViewFor(next);
      persistPrefs();
      renderDashboard(); // header/controls/legend all change with the mode
    }
    return;
  }
  const geoTog = e.target.closest('[data-geo]');
  if (geoTog) {
    const mode = /** @type {'countries'|'series'|'regions'} */ (_chartMode);
    const key = geoTog.dataset.geo;
    const sel = ensureGeoSel(mode);
    // Never leave the chart empty — the last line stays put, as for Community.
    if (sel.has(key) && sel.size > 1) sel.delete(key);
    else sel.add(key);
    renderTopics();
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
          pushArchiveState({ debuts: hit.year }, debutPath(hit.year));
      } else if (_chartMode === 'programme' || _chartMode === 'community') {
        // Same drill the year bars open, so it gets the same URL: clicking a point
        // and clicking a column must be the same act, refreshable either way.
        showDrill('year', String(hit.year));
        if (typeof history !== 'undefined')
          pushArchiveState({ drill: 'year', key: String(hit.year) }, drillPath('year', hit.year));
      } else {
        openTopicDrill(hit.term, hit.year);
        if (typeof history !== 'undefined')
          pushArchiveState({ topic: hit.term, year: hit.year }, topicPath(hit.term, hit.year));
      }
    }
    return;
  }
  const srcHit = e.target.closest('[data-source-event]');
  if (srcHit) {
    const file = srcHit.dataset.sourceEvent;
    if (openSourceDrill(String(file).replace(/\.json$/, '')) && typeof history !== 'undefined') {
      pushArchiveState({ source: file }, sourceDrillPath(file));
    }
    return;
  }
  if (e.target.closest('[data-back]')) {
    // A button that says "Back" should BE the browser's back, or the two
    // disagree: this used to push a third entry that merely looked like the
    // first, so pressing Back afterwards went forwards, into the drill you had
    // just left. Unwinding the whole depth — not one step — is what makes it
    // "back to the OVERVIEW" from two drills deep, matching the label.
    const state = typeof history !== 'undefined' ? history.state : null;
    const steps = (state?.archiveDepth || 0) - (state?.homeDepth || 0);
    if (steps > 0) {
      history.go(-steps); // popstate draws whichever home view we came from
      return;
    }
    // Nothing of ours behind this entry — a deep link straight into a drill.
    // Going to the overview is a genuine navigation, so it earns an entry.
    destroyMap();
    renderHome();
    setCrumbs();
    toTopOfView();
    if (typeof history !== 'undefined')
      history.pushState(
        { archiveDepth: 0 },
        '',
        _homeTab === 'overview'
          ? archiveHref({ view: 'home' })
          : archiveHref({ view: 'tab', tab: _homeTab }),
      );
    return;
  }
  // ── Stacked trend charts: a segment or legend chip sets that facet ──────────
  // These FILTER rather than drill. There is no /archive/country/<x> route, and
  // filtering is the more useful action anyway: it redraws every panel for that
  // community instead of leaving the dashboard for a detail page.
  const facetHit = e.target.closest?.('[data-facet]');
  if (facetHit) {
    const f = facetHit.dataset.facet;
    const key = facetHit.dataset.key;
    if (f === 'country') _country = _country === key ? 'All' : key;
    else if (f === 'series') {
      if (_series === key) _series = 'All';
      else {
        saveTopicSel();
        _series = key;
        _topicSel = null;
      }
      persistPrefs();
    }
    _rankN = { speaker: RANK_MIN, sponsor: RANK_MIN };
    _videoRows = [];
    _view = null;
    destroyMap();
    destroyStripMap();
    renderHome();
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
    pushArchiveState({ drill: type, key }, drillPath(type, key));
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
  return { min, max, years: years.length, elapsed: communityYears(min, max) };
}

/**
 * How old the community is, for a first and last year.
 *
 * The ONE place this arithmetic lives, so the masthead and the hero tile cannot
 * drift: a community whose first event was 2007 is 19 in 2026 and turns 20 when
 * 2027 lands. Counting calendar years instead gives 20, which is true of the
 * data and wrong about the community — and put "19 years of the community"
 * beside a tile reading "20" on the same screen.
 */
export function communityYears(min, max) {
  return Math.max(0, max - min);
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
  // NO SCROLL LOCK. Inherited from the overlay this used to be; #archiveObservatory
  // is now the archive page's <main>, so locking body scroll locked the page.
  // archive.js had been undoing it on the line after calling this.
  if (!wired) {
    wired = true;
    // One hook for the whole page: every panel gets a maximise control however
    // it was rendered — overview, home tabs, drill-downs, async paths alike.
    initMaximise(typeof document !== 'undefined' ? document : null);
    observeMaximise($('obsBody'));
    wireMapMaximise();
    $('obsBody').addEventListener('click', onBodyClick);
    // Enter in the field and the Search button are the same action, so both come
    // through submit rather than being wired twice.
    $('obsBody').addEventListener('submit', (e) => {
      if (!e.target.closest('[data-vid-form]')) return;
      e.preventDefault();
      _videoQ = ($('obsVideoQ')?.value || '').trim();
      _videoRows = [];
      renderVideos();
    });
    $('obsBody').addEventListener('input', (e) => {
      if (e.target.id === 'obsSearch') renderSearch(e.target.value);
      // The video query is submitted, not typed: every keystroke was a scan of
      // every dataset on the server, and a half-typed name is not a search anyone
      // meant to run.
    });
    // THE SEARCH BOX IS A COMBOBOX, and was missing every keyboard convention of
    // one: Enter did nothing at all, so a reader who typed a query and pressed
    // the obvious key got silence and had to go back for the mouse.
    $('obsBody').addEventListener('keydown', (e) => {
      if (e.target.id !== 'obsSearch') return;
      const box = $('obsResults');
      const rows = box?.classList.contains('is-open')
        ? [...box.querySelectorAll('.obs-result')]
        : [];
      if (e.key === 'Escape') {
        // First Escape closes the list, a second clears the box — so Escape is
        // always "back one step" rather than sometimes destroying a long query.
        if (rows.length) closeSearchResults();
        else e.target.value = '';
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!rows.length) return;
        e.preventDefault();
        setActiveResult(_activeResult + (e.key === 'ArrowDown' ? 1 : -1));
        return;
      }
      if (e.key !== 'Enter') return;
      e.preventDefault();
      // Enter takes the highlighted suggestion; with none it searches sessions
      // for whatever is typed, which is the whole point of a results page.
      const pick = rows[_activeResult];
      if (pick) {
        pick.click();
        return;
      }
      const q = e.target.value.trim();
      if (q.length < 2) return;
      closeSearchResults();
      openSessionSearch(q);
    });
    // Clicking anywhere else closes the suggestions. pointerdown rather than
    // click so it beats a drag, and it must not fire for the list itself or the
    // button under the pointer would never receive its click.
    document.addEventListener('pointerdown', (e) => {
      if (e.target.closest?.('#obsResults, #obsSearch')) return;
      closeSearchResults();
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
        _videoRows = [];
        // The cached view belongs to the OUTGOING scope. Everything downstream
        // reads it as `_view || computeView()`, which short-circuits — so a
        // stale `_view` is never recomputed and every facet change after the
        // first silently kept the first scope's speakers and sponsors. Restore
        // a scope with no sponsors from saved prefs and the Sponsors chart then
        // stayed empty for the rest of the session, whatever you selected next.
        // The session-search handler has always cleared it; this one did not.
        _view = null;
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
        _videoRows = []; // a new scope is a new result set, not page 3 of the old one
        _view = null; // as above: the cached view is the outgoing scope's
        destroyMap();
        renderHome();
      }
    });
    document.addEventListener('keydown', (e) => {
      // NO ESCAPE-TO-CLOSE. This used to hide #archiveObservatory, which is the
      // archive page's <main>: pressing Escape anywhere emptied the screen with
      // no way back. Escape belongs to whatever is genuinely dismissible and
      // currently open — the rail owns it (rail.js), and the search box owns it
      // while its suggestions are up.
      //
      // ENTER AND SPACE ON ANYTHING THAT IS A BUTTON IN BEHAVIOUR BUT A DIV IN
      // MARKUP — the year columns, the horizontal bars, the ranking rows, the
      // expandable session and source rows. This used to name one of them
      // (`[data-source-event]`) and so fixed exactly one; the rest were either
      // unreachable or reachable and inert.
      //
      // Every click on them is delegated from #obsBody, so forwarding the
      // keypress as a click runs the same code by construction and the two
      // cannot drift apart.
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const row = e.target?.closest?.('[role="button"]');
      // A real <button> already does this itself; doing it again would fire twice.
      if (!row || row.tagName === 'BUTTON' || !$('archiveObservatory')?.contains(row)) return;
      e.preventDefault();
      row.click();
    });
    // One listener for every chart on the page: the rail edits the store, the
    // store announces it, and whatever is on screen redraws. The rail does not
    // need to know which view is showing, and a chart does not need to know a
    // rail exists.
    document.addEventListener('archive:annotations', redrawAnnotations);
    // Delegated on the studio root, so the prompt can be re-rendered with the
    // rest of a tab without anything re-binding it.
    wireTipPrompt(o);
  }
  loadPrefs();
  loadInsights();
}

/**
 * Re-draw the chart when the width it was drawn for stops being true.
 *
 * The geometry is chosen from the container's width (see `chartGeom`), so a
 * rotation or a window drag across the breakpoint leaves a box built for the
 * old width — on a phone turned landscape, a chart still drawn tall and narrow.
 *
 * Threshold, not every pixel: a resize fires continuously, `renderTopics`
 * rebuilds the legend and the keyword chips too, and re-running that per frame
 * would make dragging a desktop window feel broken to fix a problem desktop
 * does not have. 24 px is under the smallest change that alters the geometry.
 */
let _chartW = 0;
let _chartObserved = null;
function watchChartWidth(chart) {
  if (typeof ResizeObserver === 'undefined' || !chart || _chartObserved === chart) return;
  _chartObserved = chart;
  _chartW = chart.clientWidth;
  new ResizeObserver(() => {
    const w = chart.clientWidth;
    if (!w || Math.abs(w - _chartW) < 24) return;
    _chartW = w;
    renderTopics();
  }).observe(chart);
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
        <label class="u-visually-hidden" for="obsMapidInput">Canonical name to map ${esc(key)} to</label>
        <input class="obs-mapid-input" id="obsMapidInput" list="obsMapidList" placeholder="Canonical name…" autocomplete="off" spellcheck="false">
        <datalist id="obsMapidList">${opts}</datalist>
        <button type="button" class="obs-mapid-go" data-mapid-confirm data-name="${esc(key)}" data-kind="${type}" data-slug="${esc(slug || key)}">Map</button>
      </div>
      <p class="obs-mapid-note">Sent for review — an editor approves it in the curation tool. The datasets are never changed.</p>
    </div>
  </div>`;
}

/**
 * Propose that two names are the same identity.
 *
 * This used to write the alias immediately (POST /api/curation/merge) and then
 * re-render the merged archive under your feet. It now files a SUGGESTION and
 * the archive does not change: an editor vets it in the curation tool, and
 * approving there is what writes the alias.
 *
 * The reason is who gets to click it. Saying "this is actually someone else" is
 * a claim about a real person's identity, and the moment the archive is readable
 * by anyone but its owner that claim needs a reviewer between it and the ledger.
 * Making it a proposal for everyone — the owner included — means there is one
 * rule to reason about, and it is already the right one on the day /archive opens
 * up. Nothing here re-renders, because nothing has been decided yet.
 */
/**
 * The body of an identity proposal, as the ledger expects it.
 *
 * THE FIELD IS `idType`, NOT `type`. This shipped sending `type`, which the
 * server reads as an empty string and rejects with "Unknown identity type" —
 * so remapping was broken for every subject, people and sponsors alike, and the
 * error blamed the value rather than the name. `idType` is the stored field
 * name: the queue writes it and the curation tool reads it back.
 *
 * Exported so the wire shape is pinned by a test rather than by whoever last
 * read the handler.
 */
export function identitySuggestionBody(type, from, to) {
  return { kind: 'identity', idType: type, from, to };
}

async function mapIdentity(type, name, canonical) {
  const target = String(canonical || '').trim();
  const form = document.querySelector('.obs-mapid-form');
  const say = (msg, ok) => {
    const note = form?.querySelector('.obs-mapid-note');
    if (note) {
      note.textContent = msg;
      note.classList.toggle('is-sent', !!ok);
    }
  };
  if (!target) return say('Type the name this should map to.', false);
  if (target === name) return say('That is already the same name.', false);
  try {
    const res = await fetch('/api/curation/suggestions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(identitySuggestionBody(type, name, target)),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) return say(body?.error || 'That could not be sent. Try again shortly.', false);
    say(
      body?.duplicate
        ? 'Already suggested — it is waiting for review.'
        : `Suggested: ${name} → ${target}. Waiting for review in the curation tool.`,
      true,
    );
    const input = form?.querySelector('.obs-mapid-input');
    if (input) input.value = '';
  } catch {
    say('You appear to be offline — nothing was sent.', false);
  }
}

// closeObservatory() USED TO LIVE HERE, and it hid #archiveObservatory.
//
// That was right when this module was an overlay inside the editor. It is not
// any more: #archiveObservatory now exists in exactly one place, archive.html,
// where it is the page's <main>. So "close" meant hiding the whole archive —
// and because the .obs-close button it was written for no longer exists in any
// markup, Escape was its only caller and nothing could bring the page back. One
// keystroke, anywhere, emptied the screen until you reloaded.
//
// The overlay is gone, so its close is gone. If a dismissible host ever returns,
// give it its own close control and let that own the Escape key — the page's
// main element must never be something a stray keypress can hide.
