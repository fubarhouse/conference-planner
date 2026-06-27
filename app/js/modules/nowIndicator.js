import state from './state.js';

const NOW_LINE_ID = 'nowIndicatorLine';
const JUMP_BTN_ID = 'jumpToNow';

let rafPending = false;

function getNow() {
  const param = new URLSearchParams(location.search).get('debugNow');
  if (param) {
    const ms = new Date(param).getTime();
    if (!Number.isNaN(ms)) return ms;
  }
  return Date.now();
}

function schedulePlacement() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    placeNowIndicator();
  });
}

function getTimezone() {
  return state.eventMeta?.timezone || undefined;
}

function toEventDate(ms) {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: getTimezone() });
}

function todayInEventTz() {
  return new Date(getNow()).toLocaleDateString('en-CA', { timeZone: getTimezone() });
}

// Returns the start time (ms) for a .timeline-row by looking at the first card inside it.
function getRowStartMs(row) {
  const card = row.querySelector('[data-event-id]');
  if (!card) return null;
  const ev = state.allEvents?.find((e) => e.id === card.dataset.eventId);
  return ev ? new Date(ev.startTime).getTime() : null;
}

function buildNowLine() {
  const tz = getTimezone();
  const timeStr = new Date(getNow()).toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit', timeZone: tz,
  });
  const el = document.createElement('div');
  el.id = NOW_LINE_ID;
  el.className = 'now-indicator';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `
    <div class="now-indicator-label">
      <i class="fas fa-circle now-indicator-dot" aria-hidden="true"></i>
      Now &bull; ${timeStr}
    </div>
    <div class="now-indicator-line"></div>
  `;
  return el;
}

function setJumpButtonVisible(visible) {
  const btn = document.getElementById(JUMP_BTN_ID);
  if (btn) btn.classList.toggle('hidden', !visible);
}

export function placeNowIndicator() {
  document.getElementById(NOW_LINE_ID)?.remove();

  if (!state.allEvents?.length || !state.eventMeta) {
    setJumpButtonVisible(false);
    return;
  }

  const today = todayInEventTz();
  const now = getNow();

  // Check today is actually one of the event's scheduled days.
  const hasToday = state.allEvents.some((ev) => toEventDate(new Date(ev.startTime).getTime()) === today);
  if (!hasToday) {
    setJumpButtonVisible(false);
    return;
  }

  // Find today's .schedule-day element and its .timeline-row children.
  const container = document.getElementById('eventsContainer');
  if (!container) { setJumpButtonVisible(false); return; }

  let todayDayEl = null;
  let todayRows = [];

  for (const dayEl of container.querySelectorAll('.schedule-day')) {
    const rows = [];
    for (const rowEl of dayEl.querySelectorAll('.timeline-row')) {
      const startMs = getRowStartMs(rowEl);
      if (startMs !== null && toEventDate(startMs) === today) {
        rows.push({ el: rowEl, startMs });
      }
    }
    if (rows.length) {
      todayDayEl = dayEl;
      todayRows = rows;
      break;
    }
  }

  if (!todayDayEl || !todayRows.length) {
    setJumpButtonVisible(false);
    return;
  }

  const line = buildNowLine();

  // Find insertion point: between the last past slot and the first future slot.
  let insertBeforeRow = null;
  let lastPastRow = null;

  for (const row of todayRows) {
    if (row.startMs < now) {
      lastPastRow = row;
    } else {
      insertBeforeRow = row;
      break;
    }
  }

  if (insertBeforeRow) {
    insertBeforeRow.el.parentNode.insertBefore(line, insertBeforeRow.el);
  } else if (lastPastRow) {
    lastPastRow.el.after(line);
  } else {
    todayRows[0].el.parentNode.insertBefore(line, todayRows[0].el);
  }

  setJumpButtonVisible(true);
}

export function scrollToNow() {
  document.getElementById(NOW_LINE_ID)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

export function initNowIndicator() {
  const btn = document.getElementById(JUMP_BTN_ID);
  if (btn) btn.addEventListener('click', scrollToNow);

  // Re-place whenever the events container's direct children change (i.e. after any displayListView call).
  const container = document.getElementById('eventsContainer');
  if (container) {
    const observer = new MutationObserver(schedulePlacement);
    // childList only (not subtree) — the now-indicator is inserted inside .schedule-day,
    // not directly in the container, so it won't retrigger the observer.
    observer.observe(container, { childList: true });
  }

  // Initial placement (events are already rendered by the time initNowIndicator is called).
  placeNowIndicator();

  // Update time label every minute.
  setInterval(placeNowIndicator, 60_000);
}
