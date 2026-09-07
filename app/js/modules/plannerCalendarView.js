// A second renderer over the day-grouped agenda data (`buildDayItinerary` output):
// a genuine month-style CALENDAR GRID (weekday columns, weeks as rows) instead of
// the vertical Journey Line. Each event chip carries the same `data-view-*` payload
// as the agenda rows, so the shared detail-modal click handler opens them
// identically. Pure — no state/DOM at module load.
//
// Also owns the per-surface view-mode preference (list | calendar), persisted to
// localStorage so each itinerary-like page remembers what you were doing.

import { escapeHtml as esc } from './utils.js';
import { readText, writeText } from './plannerStorage.js';

const VIEWMODE_KEY = (surface) => `cp:viewmode:${surface}`;

/** @returns {'list'|'calendar'} */
export function getViewMode(surface, fallback = 'list') {
  const v = readText(VIEWMODE_KEY(surface), fallback);
  return v === 'calendar' || v === 'list' ? v : fallback;
}
export function setViewMode(surface, mode) {
  writeText(VIEWMODE_KEY(surface), mode === 'calendar' ? 'calendar' : 'list');
}

// The List / Calendar segmented control. Two words, no glyphs: "List" and
// "Calendar" say it better than any pair of icons, and the icon font is gone.
export function viewToggleHtml(surface, mode) {
  const seg = (m, label) =>
    `<button type="button" class="smy-seg-btn pl-viewseg${mode === m ? ' is-active' : ''}" data-view-surface="${esc(surface)}" data-view-mode="${m}" aria-pressed="${mode === m}">${label}</button>`;
  return `<div class="cal-toolbar"><div class="smy-seg" role="group" aria-label="View mode">
    ${seg('list', 'List')}${seg('calendar', 'Calendar')}
  </div></div>`;
}

// Which agenda events resolve to a detail view (mirrors the Journey Line).
export function isClickableEvent(ev) {
  return !!(
    ev.type === 'item' ||
    ev.type === 'hosted' ||
    (ev.type === 'travel' && ev.legId) ||
    (ev.type === 'accom' && ev.accomId) ||
    (ev.type === 'session' && ev.sessionId) ||
    (ev.type === 'ticket' && ev.ticketId)
  );
}

// The `data-view-*` attribute string the detail resolver reads. Shared by the
// Journey Line and the calendar so both open the exact same modal.
export function viewAttrsFor(ev, dayDate) {
  if (!isClickableEvent(ev)) return '';
  const isItem = ev.type === 'item';
  const isHosted = ev.type === 'hosted';
  let a = ` data-view-type="${esc(ev.type)}"`;
  if (isItem || isHosted) a += ` data-view-id="${esc(ev.id)}"`;
  if (isItem) a += ` data-view-day="${esc(dayDate)}"`;
  if (ev.type === 'travel')
    a += ` data-view-leg-id="${esc(ev.legId)}" data-view-leg-dir="${esc(ev.legDir)}"`;
  if (ev.type === 'accom') a += ` data-view-accom-id="${esc(ev.accomId)}"`;
  if (ev.type === 'session') a += ` data-view-session-id="${esc(ev.sessionId)}"`;
  if (ev.type === 'ticket') a += ` data-view-ticket-id="${esc(ev.ticketId)}"`;
  return a;
}

// How a chip opens is the per-surface DRY seam: a chipOpen(ev, dayDate) callback
// returns `{ cls, attrs }` (making the chip a <button> with those hooks) or null
// (a static chip). The default routes to the shared read-only detail modal via
// `data-view-*`; org events override it to open their own editor instead.
export function defaultChipOpen(ev, dayDate) {
  return isClickableEvent(ev) ? { cls: '', attrs: viewAttrsFor(ev, dayDate) } : null;
}

// One compact event chip inside a day cell.
function calChipHtml(ev, dayDate, chipOpen) {
  const open = (chipOpen || defaultChipOpen)(ev, dayDate);
  const done = !!ev.done;
  const title = [ev.time, ev.label].filter(Boolean).join(' ');
  const type = esc(ev.type || 'item');
  const doneCls = done ? ' cal-ev--done' : '';
  // The chip's type is carried by a colour-free marker in CSS, not a glyph —
  // every surface feeding this grid used a different icon for what is, to the
  // reader, just "a thing on this day".
  const inner = `<span class="cal-ev-ic cal-ev-ic--${type}" aria-hidden="true"></span><span class="cal-ev-label">${ev.time ? `<span class="cal-ev-t">${esc(ev.time)}</span>` : ''}${esc(ev.label)}</span>`;
  return open
    ? `<button type="button" class="cal-ev cal-ev--${type}${doneCls}${open.cls ? ' ' + open.cls : ''}" title="${esc(title)}"${open.attrs || ''}>${inner}</button>`
    : `<div class="cal-ev cal-ev--${type}${doneCls} cal-ev--static" title="${esc(title)}">${inner}</div>`;
}

// Group a flat list of dated agenda events into the `[{date, events}]` shape the
// grid consumes — sorted by date, then by time within each day. The shared
// day-bucketing primitive every itinerary-like surface feeds the calendar with.
export function groupEventsByDay(events) {
  const days = {};
  for (const ev of events || []) if (ev.date) (days[ev.date] ??= []).push(ev);
  return Object.keys(days)
    .sort()
    .map((date) => ({
      date,
      events: days[date].sort((a, b) =>
        String(a.sortTime || a.time || '').localeCompare(String(b.sortTime || b.time || '')),
      ),
    }));
}

// Local (not UTC) YYYY-MM-DD so "today" highlights the viewer's actual day.
function localTodayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ── Date helpers (UTC arithmetic, no local-tz drift) ─────────────────────────
function parseYmd(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return Date.UTC(y, (m || 1) - 1, d || 1);
}
function ymd(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}
// 0 = Monday … 6 = Sunday
function weekdayMon(ms) {
  return (new Date(ms).getUTCDay() + 6) % 7;
}
const DAY_MS = 86400000;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function emptyStateHtml() {
  return `
    <div class="jrn-empty">
      <div class="jrn-empty-badge"><i class="fas fa-route" aria-hidden="true"></i></div>
      <p class="jrn-empty-t">Your journey starts here</p>
      <p class="jrn-empty-s">Add travel, a place to stay, or a plan of your own to build the day-by-day line.</p>
      <button type="button" class="agenda-add-item jrn-empty-btn">
        <i class="fas fa-plus text-[0.7rem]" aria-hidden="true"></i>Add the first thing
      </button>
    </div>`;
}

// Render `buildDayItinerary()` output as a genuine calendar grid: weekday columns,
// weeks as rows (wrap down — no horizontal scroll). Scoped to the trip's weeks
// (Mon of the first day's week … Sun of the last), so there's no empty-month
// navigation and it handles any trip length.
export function calendarGridHtml(days, { todayStr, chipOpen } = {}) {
  const today = todayStr || localTodayStr();
  const dated = (days || []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date || ''));
  if (!dated.length) return emptyStateHtml();

  const byDate = new Map(
    dated.map((d) => [d.date, (d.events || []).filter((e) => e.type !== 'gap')]),
  );
  const startMs = parseYmd(dated[0].date);
  const endMs = parseYmd(dated[dated.length - 1].date);
  const gridStart = startMs - weekdayMon(startMs) * DAY_MS;
  const gridEnd = endMs + (6 - weekdayMon(endMs)) * DAY_MS;

  const head = `<div class="cal-grid-head">${WEEKDAYS.map((w) => `<span class="cal-wd">${w}</span>`).join('')}</div>`;

  let weeks = '';
  for (let wk = gridStart; wk <= gridEnd; wk += 7 * DAY_MS) {
    let cells = '';
    for (let i = 0; i < 7; i++) {
      const ms = wk + i * DAY_MS;
      const date = ymd(ms);
      const inTrip = ms >= startMs && ms <= endMs;
      const isToday = date === today;
      const evs = byDate.get(date) || [];
      const dnum = new Date(ms).getUTCDate();
      const chips = evs.length
        ? evs.map((ev) => calChipHtml(ev, date, chipOpen)).join('')
        : inTrip
          ? `<button type="button" class="cal-cell-add agenda-day-add" data-agenda-day="${esc(date)}" aria-label="Add on ${esc(date)}"><i class="fas fa-plus" aria-hidden="true"></i></button>`
          : '';
      cells += `<div class="cal-cell${inTrip ? '' : ' cal-cell--off'}${isToday ? ' cal-cell--today' : ''}">
        <span class="cal-cell-date">${dnum}</span>
        <div class="cal-cell-evs">${chips}</div>
      </div>`;
    }
    weeks += `<div class="cal-week">${cells}</div>`;
  }
  return `<div class="cal-grid">${head}${weeks}</div>`;
}

// ── Per-surface wiring (DRY) ─────────────────────────────────────────────────
// Each itinerary-like surface registers a re-render fn under its key; the single
// toggle handler (plannerItinerary.wireItineraryPanel) calls it after flipping the
// mode. Adding a new surface = register + call renderSurfaceView, nothing else.
const _rerenderers = {};
export function registerViewSurface(surface, rerender) {
  _rerenderers[surface] = rerender;
}
export function rerenderViewSurface(surface) {
  _rerenderers[surface]?.();
}

// The shared "toggle + (list | calendar)" render for a surface. Callers supply
// the container id, their already-built list markup, and the day-grouped events;
// this centralises the mode read, the toggle, and the grid so every surface is
// identical. `onList` runs after a list-mode render (e.g. weather chips).
export function renderSurfaceView(
  containerId,
  surface,
  { hasItems = true, days, listHtml, calOpts = {}, onList } = {},
) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!hasItems) {
    el.innerHTML = '';
    return;
  }
  const mode = getViewMode(surface);
  el.innerHTML =
    viewToggleHtml(surface, mode) +
    (mode === 'calendar' ? calendarGridHtml(days, calOpts) : listHtml);
  if (mode === 'list' && onList) onList();
}
