// Thin DOM glue over the pure plannerCalendar builders: turn a normalised
// calEvent into a Google Calendar tab or a downloaded single-event .ics.
import state from './state.js';
import { buildIcsCalendar, googleCalendarUrl } from './plannerCalendar.js';

// A stable, readable filename base from the planner + event title.
function slugify(text) {
  return (
    String(text || 'event')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'event'
  );
}

// A UID that's stable for a given entity so re-importing updates rather than
// duplicates. `id` is the entity's own id; `plannerKey` scopes it to this trip.
function uidFor(id) {
  const key = (state.plannerKey || 'planner').replace(/\.json$/, '');
  return `${id || Math.random().toString(36).slice(2)}@${key}`;
}

export function openInGoogleCalendar(calEvent) {
  if (!calEvent) return;
  window.sa_event?.('planner_calendar_google');
  window.open(googleCalendarUrl(calEvent), '_blank', 'noopener,noreferrer');
}

// A tiny popover anchored to `anchorEl` offering the two export methods for one
// calEvent. Reused by every planner surface (itinerary, org, legs, stays): the
// caller only has to normalise its entity and hand over the calEvent. Closes on
// choice, outside click, or Escape.
export function openCalendarMenu(anchorEl, calEvent, opts = {}) {
  closeCalendarMenu();
  if (!calEvent || !anchorEl) return;

  const menu = document.createElement('div');
  menu.className = 'cal-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = `
    <button type="button" role="menuitem" class="cal-menu-item" data-cal="google">
      <i class="fas fa-calendar-plus" aria-hidden="true"></i> Google Calendar
    </button>
    <button type="button" role="menuitem" class="cal-menu-item" data-cal="ics">
      <i class="fas fa-download" aria-hidden="true"></i> Download .ics
    </button>`;
  document.body.appendChild(menu);

  const r = anchorEl.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.top = `${Math.round(r.bottom + 4)}px`;
  // Right-align to the anchor, clamped to the viewport.
  menu.style.left = `${Math.round(Math.max(8, Math.min(r.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8)))}px`;
  menu.style.zIndex = '2000';

  menu.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cal]');
    if (!btn) return;
    if (btn.dataset.cal === 'google') openInGoogleCalendar(calEvent);
    else downloadIcs(calEvent, opts);
    closeCalendarMenu();
  });
  // Defer so the opening click doesn't immediately close it.
  setTimeout(() => {
    document.addEventListener('click', _onDocClick, true);
    document.addEventListener('keydown', _onKeydown, true);
  }, 0);
}

function _onDocClick(e) {
  if (!e.target.closest('.cal-menu')) closeCalendarMenu();
}
function _onKeydown(e) {
  if (e.key === 'Escape') closeCalendarMenu();
}
export function closeCalendarMenu() {
  document.querySelector('.cal-menu')?.remove();
  document.removeEventListener('click', _onDocClick, true);
  document.removeEventListener('keydown', _onKeydown, true);
}

export function downloadIcs(calEvent, { id, filenameBase } = {}) {
  if (!calEvent) return;
  window.sa_event?.('planner_calendar_ics');
  const ics = buildIcsCalendar([calEvent], {
    calName: calEvent.title || 'Trip event',
    uidFor: () => uidFor(id),
  });
  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${slugify(filenameBase || calEvent.title)}.ics`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
