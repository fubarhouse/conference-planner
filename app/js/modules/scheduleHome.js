// The schedule page's "Browse" home: every event, split into what is still to
// come and what has already happened, with the archive's own filters over the
// top — series, region and year.
//
// EVERYTHING HERE IS COMPUTED FROM catalog.json IN THE BROWSER. That is what
// keeps the static deployment working: no counting endpoint, no query API, and
// the same code path whether a Go server is running or the folder is being
// served off a CDN. The catalog already carries every field these filters and
// counts need, so none of this required a change to how it is built.

import { homeRoot, heroPanel, searchBar, cardGrid, emptyState } from './homeLayout.js';
import { escapeHtml as esc } from './utils.js';

// deps: { getEvents(includeAll), isOwner(), onSelect(category, file), getDefaultFile(), onClose() }
let _deps = null;
// Whether disabled/unpublished schedules are revealed in the grid. Owners
// (?showHidden=1) start with everything shown; the public toggle flips this.
let _showAll = false;
// Scope filters, mirroring the archive's: series · region · year. 'All' is the
// unset value in each, so one comparison covers both states.
const ALL = 'All';
let _filters = { series: ALL, region: ALL, year: ALL };

export function initScheduleHome(deps) {
  _deps = deps;
  _showAll = !!deps.isOwner?.();
  _filters = { series: ALL, region: ALL, year: ALL };
}

// An event is past once its LAST day is over, not its first — a three-day
// conference is still "on" on day two, and moving it to Past the moment it
// starts is the bug this function exists to avoid. Events with no end date fall
// back to their start; events with neither are treated as upcoming, because an
// undated record is more likely to be a draft than a memory.
function isPast(evt, now = Date.now()) {
  const end = evt.endDate || evt.startDate;
  if (!end) return false;
  const t = new Date(end).getTime();
  if (Number.isNaN(t)) return false;
  // End-of-day: an endDate is a date, and a conference finishing today has not
  // finished until today is over.
  return t + 24 * 60 * 60 * 1000 < now;
}

function fmtDateRange(startIso, endIso) {
  const start = startIso ? new Date(startIso) : null;
  const end = endIso ? new Date(endIso) : null;
  const valid = (d) => d && !Number.isNaN(d.getTime());
  if (!valid(start)) return '';
  const opts = { day: 'numeric', month: 'short', year: 'numeric' };
  if (!valid(end) || start.toDateString() === end.toDateString()) {
    return start.toLocaleDateString(undefined, opts);
  }
  const sameMonth =
    start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear();
  if (sameMonth) {
    const month = start.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
    return `${start.getDate()}–${end.getDate()} ${month}`;
  }
  return `${start.toLocaleDateString(undefined, opts)} – ${end.toLocaleDateString(undefined, opts)}`;
}

function eventCardHtml(evt, isDefault, owner) {
  const title = evt.label || `${evt.designation} ${evt.year}`.trim() || 'Event';
  const dates = fmtDateRange(evt.startDate, evt.endDate);
  // A disabled/unpublished schedule is shown but locked for the public — visible
  // so the coverage is apparent, but not openable. Owners (?showHidden=1) get a
  // normal clickable card so they can render it.
  const locked = evt.hidden && !owner;
  const tag = locked ? 'div' : 'button';
  const attrs = locked
    ? 'class="hl-event-card is-hidden is-locked" aria-disabled="true"'
    : `type="button" class="hl-event-card${evt.hidden ? ' is-hidden' : ''}" data-file="${esc(evt.file)}" data-category="${esc(evt.category)}"`;
  const flag = evt.hidden
    ? locked
      ? '<span class="hl-event-hidden"> Locked</span>'
      : '<span class="hl-event-hidden"> Unpublished</span>'
    : '';
  return `<${tag} ${attrs}>
    <div class="hl-event-card-top">
      <span class="hl-event-badge">${esc(evt.designation || evt.category || 'Event')}</span>
      <span class="hl-event-flags">
        ${flag}
        ${isDefault ? '<span class="hl-event-default"> Default</span>' : ''}
      </span>
    </div>
    <h3 class="hl-event-title">${esc(title)}</h3>
    <div class="hl-event-meta">
      ${evt.location ? `<span>${esc(evt.location)}</span>` : ''}
      ${dates ? `<span>${esc(dates)}</span>` : ''}
    </div>
  </${tag}>`;
}

function matchesQuery(evt, q) {
  if (!q) return true;
  const hay = [evt.designation, evt.location, evt.year, evt.region, evt.venue, evt.label]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return q.split(/\s+/).every((term) => hay.includes(term));
}

// The series an event BELONGS to, which is not always what it is called: the
// catalog resolves a curation mapping into `series`, and everything else falls
// back to the name it was marketed under.
function seriesOf(evt) {
  return evt.series || evt.designation || evt.category || '';
}

function inScope(evt) {
  return (
    (_filters.series === ALL || seriesOf(evt) === _filters.series) &&
    (_filters.region === ALL || evt.region === _filters.region) &&
    (_filters.year === ALL || String(evt.year) === _filters.year)
  );
}

function visible(events, query) {
  const q = query.toLowerCase().trim();
  return events
    .filter((evt) => _showAll || !evt.hidden)
    .filter(inScope)
    .filter((evt) => matchesQuery(evt, q));
}

// The counts describe what is CURRENTLY IN VIEW, not the archive as a whole.
// A total that never moves is decoration; one that answers "how much am I
// looking at" is the reason to render it at all — pick a series and it tells you
// how many editions that series has and how far back it goes.
function statStrip(shown) {
  const series = new Set(shown.map(seriesOf).filter(Boolean));
  const regions = new Set(shown.map((e) => e.region).filter(Boolean));
  const years = shown.map((e) => Number(e.year)).filter((y) => Number.isFinite(y));
  const span = years.length
    ? Math.min(...years) === Math.max(...years)
      ? String(Math.min(...years))
      : `${Math.min(...years)}–${Math.max(...years)}`
    : '—';
  const cell = (n, label) =>
    `<div class="hl-stat"><b class="hl-stat-n">${esc(String(n))}</b><span class="hl-stat-label">${esc(label)}</span></div>`;
  return `<div class="hl-stats" role="group" aria-label="What is in view">
    ${cell(shown.length, shown.length === 1 ? 'event' : 'events')}
    ${cell(series.size, series.size === 1 ? 'series' : 'series')}
    ${cell(regions.size, regions.size === 1 ? 'region' : 'regions')}
    ${cell(span, 'years')}
  </div>`;
}

function options(values, selected) {
  return [ALL, ...values]
    .map(
      (v) =>
        `<option value="${esc(String(v))}"${String(v) === String(selected) ? ' selected' : ''}>${esc(v === ALL ? 'All' : String(v))}</option>`,
    )
    .join('');
}

// Built from the events that pass the OTHER filters, so a choice never leaves
// the control offering something that would return nothing.
function filterBar(events) {
  const pool = events.filter((evt) => _showAll || !evt.hidden);
  const uniq = (list, key) => [...new Set(list.map((e) => e[key]).filter(Boolean))];
  const series = [...new Set(pool.map(seriesOf).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
  const regions = uniq(pool, 'region').sort((a, b) => a.localeCompare(b));
  const years = uniq(pool, 'year').sort((a, b) => Number(b) - Number(a));
  const active = Object.values(_filters).some((v) => v !== ALL);
  const sel = (id, label, opts) =>
    `<label class="hl-filter">
      <span class="hl-filter-label">${esc(label)}</span>
      <select id="${id}" class="hl-filter-select">${opts}</select>
    </label>`;
  return `<div class="hl-filters">
    ${sel('eventHomeSeries', 'Series', options(series, _filters.series))}
    ${sel('eventHomeRegion', 'Region', options(regions, _filters.region))}
    ${sel('eventHomeYear', 'Year', options(years, _filters.year))}
    <button type="button" id="eventHomeReset" class="hl-filter-reset"${active ? '' : ' disabled'}>Reset</button>
  </div>`;
}

function group(title, events, defaultFile, owner) {
  if (!events.length) return '';
  return `<section class="hl-group">
    <h3 class="hl-group-title">${esc(title)} <span class="hl-group-count">${events.length}</span></h3>
    <div class="hl-card-grid">${events.map((evt) => eventCardHtml(evt, evt.file === defaultFile, owner)).join('')}</div>
  </section>`;
}

function renderGrid(events, defaultFile, owner, query = '') {
  const shown = visible(events, query);
  if (!shown.length) return emptyState('No events match those filters.');
  const now = Date.now();
  const upcoming = shown.filter((e) => !isPast(e, now));
  const past = shown.filter((e) => isPast(e, now));
  // Upcoming reads soonest-first — the next thing you could go to is the point.
  // Past keeps the catalog's newest-first order.
  upcoming.sort((a, b) => new Date(a.startDate || 0) - new Date(b.startDate || 0));
  // The stat strip is rendered above the search box, not here — see
  // renderScheduleHome. It is kept out of the grid so it does not scroll away
  // with the results it describes.
  return group('Upcoming', upcoming, defaultFile, owner) + group('Past', past, defaultFile, owner);
}

function renderScheduleHome() {
  const container = document.getElementById('eventHomeView');
  if (!container || !_deps) return;
  const defaultFile = _deps.getDefaultFile();
  const owner = !!_deps.isOwner?.();
  // Keep the natural newest→oldest date order; the default sits in its date
  // position and is called out by the "Default" badge instead of being pinned.
  // Always fetch the full list (hidden tagged) — the toggle decides what shows.
  const events = _deps.getEvents(true);
  const hiddenCount = events.filter((evt) => evt.hidden).length;
  const toggleHtml = hiddenCount
    ? `<label class="hl-showall-toggle">
        <input type="checkbox" id="eventHomeShowAll"${_showAll ? ' checked' : ''}>
        <span>Show all schedules <span class="hl-showall-count">${hiddenCount} unpublished</span></span>
      </label>`
    : '';

  container.innerHTML = homeRoot(
    heroPanel({
      iconClass: 'fas fa-calendar-days',
      title: 'Browse events',
      lead: 'Search and open any conference schedule.',
      // The label is VISIBLE text, not an aria-label on an empty button. This
      // held a Font Awesome glyph; the rebrand removed the icon and left the
      // element behind, so it rendered as a blank 44px box — announced fine to
      // a screen reader, invisible to everyone else. On mobile this view takes
      // the whole viewport, so that box was the only way out and it looked
      // like nothing. `.hl-settings-btn` already expects a word (see the
      // padding note in section-chrome.css), as the editor and home hero do.
      actionsHtml:
        '<button type="button" id="eventHomeClose" class="hl-settings-btn">Back to schedule</button>',
    }) +
      // The counts lead, because they are the answer to "what is in here?" —
      // the question somebody arriving at a browse page is actually asking.
      // They narrow as the filters do, so they keep answering it.
      `<div id="eventHomeStats">${statStrip(visible(events, ''))}</div>` +
      // Search and the three scope filters read as one control strip, so they
      // share a row rather than stacking. The search grows; the selects keep
      // their intrinsic width and wrap beneath only when the row runs out.
      `<div class="hl-controls">` +
      searchBar({
        inputId: 'eventHomeSearch',
        placeholder: 'Search events by name, place, year…',
      }) +
      `<div id="eventHomeFilters">${filterBar(events)}</div>` +
      `</div>` +
      toggleHtml +
      cardGrid({ id: 'eventHomeGrid', innerHtml: renderGrid(events, defaultFile, owner) }),
  );

  const input = container.querySelector('#eventHomeSearch');
  const rerender = () => {
    const query = input?.value || '';
    const grid = container.querySelector('#eventHomeGrid');
    if (grid) grid.innerHTML = renderGrid(events, defaultFile, owner, query);
    const stats = container.querySelector('#eventHomeStats');
    if (stats) stats.innerHTML = statStrip(visible(events, query));
    // The controls rebuild too: their option lists depend on `_showAll`, and the
    // Reset button on whether anything is set.
    const bar = container.querySelector('#eventHomeFilters');
    if (bar) bar.innerHTML = filterBar(events);
  };

  container.querySelector('#eventHomeClose')?.addEventListener('click', () => _deps.onClose());
  container.querySelector('#eventHomeGrid')?.addEventListener('click', (e) => {
    // Locked (unpublished, non-owner) cards are inert <div>s — ignore them.
    const card = e.target.closest('.hl-event-card:not(.is-locked)');
    if (card) _deps.onSelect(card.dataset.category, card.dataset.file);
  });
  container.querySelector('#eventHomeShowAll')?.addEventListener('change', (e) => {
    _showAll = e.target.checked;
    rerender();
  });
  // Delegated, because the bar is replaced on every render.
  container.querySelector('#eventHomeFilters')?.addEventListener('change', (e) => {
    const key = { eventHomeSeries: 'series', eventHomeRegion: 'region', eventHomeYear: 'year' }[
      e.target.id
    ];
    if (!key) return;
    _filters[key] = e.target.value;
    rerender();
  });
  container.querySelector('#eventHomeFilters')?.addEventListener('click', (e) => {
    if (e.target.id !== 'eventHomeReset') return;
    _filters = { series: ALL, region: ALL, year: ALL };
    rerender();
  });
  input?.addEventListener('input', rerender);
}

export function openScheduleHome() {
  renderScheduleHome();
  document.title = 'Drupal Event Schedule Builder';
  document.getElementById('eventHomeView')?.classList.remove('hidden');
  document.getElementById('scheduleMain')?.classList.add('home-active');
  const url = new URL(window.location.href);
  url.searchParams.set('browse', '1');
  window.history.replaceState({}, '', url.toString());
  // No auto-focus: the search only takes focus when the user taps it (avoids the
  // keyboard/zoom jump on mobile the moment Browse opens).
}

// The date boundary is the one piece of real logic here and it has an off-by-a-
// day failure mode, so it is exposed for its own test rather than reached
// through the DOM.
export const __test = { isPast, seriesOf };

export function closeScheduleHome() {
  document.getElementById('eventHomeView')?.classList.add('hidden');
  document.getElementById('scheduleMain')?.classList.remove('home-active');
  const url = new URL(window.location.href);
  url.searchParams.delete('browse');
  window.history.replaceState({}, '', url.toString());
}
