// "Now / Up next" — the during-event companion view. A compact, mobile-first
// panel at the top of the schedule that answers the two questions an attendee has
// while they're at the event: what's on right now, and what's up next. It reuses
// nowIndicator's clock (incl. ?debugNow=) and the event timezone, and — when the
// visitor has selected sessions — narrows to *their* picks so it reads as a
// personal agenda. Pure logic (computeNowNext) is split out for testing; the rest
// is DOM-guarded so it's a no-op in a non-browser/test environment.
import state from './state.js';
import { escapeHtml } from './utils.js';
import { getNow, getTimezone } from './nowIndicator.js';

const PANEL_ID = 'nowNextPanel';
const HIGHLIGHT_MS = 1600;
// A full multi-track schedule can have a dozen concurrent sessions; cap each
// section so the panel stays a glanceable companion, not a wall. The personalised
// (selected-sessions) view is almost always well under this.
const MAX_CARDS = 4;

// Pure: given sessions and a moment, return what's on now and the soonest
// upcoming slot (all sessions sharing that earliest future start).
export function computeNowNext(sessions, nowMs) {
  const parsed = (sessions || [])
    .map((s) => ({ s, start: Date.parse(s.startTime), end: Date.parse(s.endTime) }))
    .filter((x) => Number.isFinite(x.start));

  const onNow = parsed
    .filter((x) => Number.isFinite(x.end) && x.start <= nowMs && nowMs < x.end)
    .sort((a, b) => a.start - b.start)
    .map((x) => x.s);

  const future = parsed.filter((x) => x.start > nowMs).sort((a, b) => a.start - b.start);
  const nextStartMs = future.length ? future[0].start : null;
  const upNext =
    nextStartMs == null ? [] : future.filter((x) => x.start === nextStartMs).map((x) => x.s);

  return { onNow, upNext, nextStartMs };
}

// The sessions we consider: the visitor's selected set if they've picked any,
// otherwise the whole schedule (so the panel is useful before anyone selects).
function sessionPool() {
  const all = state.allEvents || [];
  if (state.selectedEvents?.size) return all.filter((e) => state.selectedEvents.has(e.id));
  return all;
}

function eventDate(ms, tz) {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: tz });
}

// Only surface the panel during the event itself (today, in the event's tz, is one
// of its scheduled days) — off-event we don't want an "up next" pointing weeks out.
function isDuringEvent() {
  const tz = getTimezone();
  const today = eventDate(getNow(), tz);
  return (state.allEvents || []).some((e) => eventDate(Date.parse(e.startTime), tz) === today);
}

function formatTime(ms) {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: getTimezone(),
  });
}

function relativeLabel(startMs, nowMs) {
  const mins = Math.round((startMs - nowMs) / 60000);
  if (mins <= 0) return 'starting';
  if (mins < 60) return `in ${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `in ${h}h ${m}m` : `in ${h}h`;
}

function cardHtml(session, { relTo } = {}) {
  const startMs = Date.parse(session.startTime);
  const rel =
    relTo != null ? `<span class="now-next-card-rel">${relativeLabel(startMs, relTo)}</span>` : '';
  const loc = session.location
    ? `<span class="now-next-card-loc">${escapeHtml(session.location)}</span>`
    : '';
  return `
    <button type="button" class="now-next-card" data-jump="${escapeHtml(session.id)}">
      <span class="now-next-card-time">${escapeHtml(formatTime(startMs))}</span>
      <span class="now-next-card-body">
        <span class="now-next-card-title">${escapeHtml(session.title || 'Untitled session')}</span>
        <span class="now-next-card-meta">${loc}${rel}</span>
      </span>
      <span class="now-next-card-go" aria-hidden="true">→</span>
    </button>`;
}

function sectionHtml(label, dotClass, sessions, cardOpts) {
  if (!sessions.length) return '';
  const shown = sessions.slice(0, MAX_CARDS);
  const extra = sessions.length - shown.length;
  const cards = shown.map((s) => cardHtml(s, cardOpts)).join('');
  const more = extra > 0 ? `<div class="now-next-more">+${extra} more</div>` : '';
  return `
    <div class="now-next-section">
      <div class="now-next-section-head"><span class="now-next-dot ${dotClass}"></span>${label}</div>
      <div class="now-next-cards">${cards}</div>
      ${more}
    </div>`;
}

function renderNowNext() {
  const panel = document.getElementById(PANEL_ID);
  if (!panel) return;

  if (!isDuringEvent() || !state.allEvents?.length) {
    panel.classList.add('hidden');
    panel.innerHTML = '';
    return;
  }

  const now = getNow();
  const { onNow, upNext, nextStartMs } = computeNowNext(sessionPool(), now);

  if (!onNow.length && !upNext.length) {
    panel.classList.add('hidden');
    panel.innerHTML = '';
    return;
  }

  const personal = state.selectedEvents?.size ? ' &middot; your picks' : '';

  panel.innerHTML = `
    <div class="now-next-head">
      <span class="now-next-eyebrow">Happening now${personal}</span>
      <span class="now-next-clock">${escapeHtml(formatTime(now))}</span>
    </div>
    ${sectionHtml('On now', 'is-live', onNow, {})}
    ${sectionHtml(nextStartMs ? 'Up next' : '', 'is-next', upNext, { relTo: now })}
  `;
  panel.classList.remove('hidden');
}

function jumpToSession(id, retried = false) {
  const card = document.querySelector(`[data-event-id="${CSS.escape(id)}"]`);

  // The session can be on the programme but hidden by the active filters, in
  // which case the jump used to do nothing at all. Clear them through the app's
  // own reset control so filter state stays consistent, announce it, then retry
  // once the list has re-rendered.
  if (!card) {
    const reset = document.getElementById('resetFilters');
    if (retried || !reset) return;
    reset.click();
    const status = document.getElementById('ariaStatus');
    if (status) status.textContent = 'Filters cleared so the session could be shown.';
    requestAnimationFrame(() => jumpToSession(id, true));
    return;
  }

  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.add('now-next-flash');
  setTimeout(() => card.classList.remove('now-next-flash'), HIGHLIGHT_MS);
}

export function initNowNext() {
  const panel = document.getElementById(PANEL_ID);
  if (!panel) return;

  panel.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-jump]');
    if (btn) jumpToSession(btn.dataset.jump);
  });

  // Re-render when the schedule re-renders (day/track filter changes rebuild the
  // container) and when the selection changes (personalises the pool instantly).
  const container = document.getElementById('eventsContainer');
  if (container) new MutationObserver(renderNowNext).observe(container, { childList: true });
  document.addEventListener('schedule-selection-changed', renderNowNext);

  renderNowNext();
  setInterval(renderNowNext, 60_000);
}
