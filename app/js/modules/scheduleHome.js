// The schedule page's "Browse" home: a flat, searchable list of every event.
// Reuses the shared home-layout kit (so it matches the planner/editor homes) and
// the event metadata already loaded by events.js. Deliberately NOT grouped by
// category — one grid + a search box. The nominated default is pinned + badged.

import { homeRoot, heroPanel, searchBar, cardGrid, emptyState } from './homeLayout.js';
import { escapeHtml as esc } from './utils.js';

// deps: { getEvents(includeAll), isOwner(), onSelect(category, file), getDefaultFile(), onClose() }
let _deps = null;
// Whether disabled/unpublished schedules are revealed in the grid. Owners
// (?showHidden=1) start with everything shown; the public toggle flips this.
let _showAll = false;

export function initScheduleHome(deps) {
  _deps = deps;
  _showAll = !!deps.isOwner?.();
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

function renderGrid(events, defaultFile, owner, query = '') {
  const filtered = events
    .filter((evt) => _showAll || !evt.hidden)
    .filter((evt) => matchesQuery(evt, query.toLowerCase().trim()));
  return filtered.length
    ? filtered.map((evt) => eventCardHtml(evt, evt.file === defaultFile, owner)).join('')
    : emptyState('No events match your search.');
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
      searchBar({
        inputId: 'eventHomeSearch',
        placeholder: 'Search events by name, place, year…',
      }) +
      toggleHtml +
      cardGrid({ id: 'eventHomeGrid', innerHtml: renderGrid(events, defaultFile, owner) }),
  );

  const input = container.querySelector('#eventHomeSearch');
  const rerender = () => {
    const grid = container.querySelector('#eventHomeGrid');
    if (grid) grid.innerHTML = renderGrid(events, defaultFile, owner, input?.value || '');
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

export function closeScheduleHome() {
  document.getElementById('eventHomeView')?.classList.add('hidden');
  document.getElementById('scheduleMain')?.classList.remove('home-active');
  const url = new URL(window.location.href);
  url.searchParams.delete('browse');
  window.history.replaceState({}, '', url.toString());
}
