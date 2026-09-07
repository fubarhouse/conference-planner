// "My Schedule" tab — events YOU host during the conference: in-booth demos,
// customer meetings, presentations at your own location. Their defining trait is
// counter-programming: "at the same time as [this session], we're running [this]
// at [our location] with [these people]." So they are a distinct entity
// (personal.hostedEvents), NOT itinerary items — they carry an optional anchor to
// a programme session (the time slot they run alongside), a location, and people.
//
// They still surface (read-only) on the Itinerary via buildDayItinerary, and
// export to calendars — but they're created and edited only here.
//
// Follows the planner contract: planner-internal collaborators are injected via
// initSchedule(); shared utilities/openers are imported directly.

import { escapeHtml as esc, slugify } from './utils.js';
import { makeItemId } from './plannerStorage.js';
import { showModal, hideModal } from './modal.js';
import { openCalendarMenu } from './plannerCalendarUi.js';
import { personalAssignablePeople, personalAssigneeChips } from './plannerItinerary.js';
import { renderSurfaceView, groupEventsByDay, registerViewSurface } from './plannerCalendarView.js';

// ── Injected planner collaborators ────────────────────────────────────────────
let state;
let scheduleAutoSave;
let fmtTime;
let getTimezone;
let renderPersonalItineraryTab;

export function initSchedule(deps) {
  ({ state, scheduleAutoSave, fmtTime, getTimezone, renderPersonalItineraryTab } = deps);
}

function hostedList() {
  return (state.planner.personal.hostedEvents ??= []);
}

// A session's local calendar date + wall-clock start/end (24h) in the trip's
// timezone — the same bucketing buildDayItinerary uses.
function sessionSlot(s) {
  const tz = getTimezone();
  const hm = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? ''
      : d.toLocaleTimeString('en-GB', {
          timeZone: tz,
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        });
  };
  const dt = new Date(s.startTime);
  return {
    date: Number.isNaN(dt.getTime()) ? '' : dt.toLocaleDateString('en-CA', { timeZone: tz }),
    time: hm(s.startTime),
    endTime: s.endTime ? hm(s.endTime) : '',
  };
}

// 'HH:MM' → '9:00 AM' for display (times are stored as local wall-clock).
function fmtHM(hhmm) {
  if (!hhmm) return '';
  const [h, m] = String(hhmm).split(':').map(Number);
  if (Number.isNaN(h)) return '';
  const am = h < 12;
  const hh = h % 12 || 12;
  return `${hh}:${String(m).padStart(2, '0')} ${am ? 'AM' : 'PM'}`;
}

// The left-rail time cell: start on top, end (if any) as a quiet second line.
function timeCellHtml(he) {
  if (!he.time) return '<span class="sch-time sch-time--all">All day</span>';
  const end = he.endTime ? `<span class="sch-time-end">${esc(fmtHM(he.endTime))}</span>` : '';
  return `<span class="sch-time">${esc(fmtHM(he.time))}${end}</span>`;
}

function dayLabel(date) {
  const d = new Date(date + 'T12:00:00');
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function cardHtml(he) {
  const avatars = personalAssigneeChips(he.memberIds || []);
  const meta = he.location ? `<p class="sch-meta">${esc(he.location)}</p>` : '';
  // The anchor is what makes a hosted event different from any other calendar
  // entry: it runs ALONGSIDE something in the official programme. That
  // relationship gets the label and the tie-line; it is the tab's whole point.
  const along = he.anchorTitle
    ? `<p class="sch-along"><span class="sch-along__label">Alongside</span><span class="sch-along__what">${esc(he.anchorTitle)}</span>${he.anchorLocation ? `<span class="sch-along__where">${esc(he.anchorLocation)}</span>` : ''}</p>`
    : '';
  const people = avatars.length
    ? `<div class="pl-avatars sch-people">${avatars.map((a) => `<span class="pl-avatar" title="${esc(a.name)}">${esc(a.initial)}</span>`).join('')}</div>`
    : '';
  const guests = he.guests
    ? `<p class="sch-guests"><span class="sch-guests__label">Guests</span>${esc(he.guests)}</p>`
    : '';
  return `<div class="sch-row sch-row--mine${he.done ? ' sch-row--done' : ''}" data-he-id="${esc(he.id)}">
    ${timeCellHtml(he)}
    <span class="sch-node" aria-hidden="true"></span>
    <div class="sch-main">
      <p class="sch-title sch-edit" data-he-id="${esc(he.id)}" role="button" tabindex="0">${esc(he.title || 'Hosted event')}</p>
      ${meta}${along}${guests}${people}
    </div>
    <span class="sch-acts">
      <button type="button" class="sch-act sch-cal" data-he-id="${esc(he.id)}" aria-label="Add ${esc(he.title || 'event')} to a calendar">Calendar</button>
      <button type="button" class="sch-act sch-edit" data-he-id="${esc(he.id)}" aria-label="Edit ${esc(he.title || 'event')}">Edit</button>
      <button type="button" class="sch-act sch-act--del sch-remove" data-he-id="${esc(he.id)}" aria-label="Remove ${esc(he.title || 'event')}">Remove</button>
    </span>
  </div>`;
}

const byTime = (a, b) => (a.time || '99:99').localeCompare(b.time || '99:99');
const locationKey = (he) => (he.location || '').trim() || '—';

// Single-column list — the default when a day happens at (at most) one place.
function dayListHtml(events) {
  return `<div class="sch-list">${events.slice().sort(byTime).map(cardHtml).join('')}</div>`;
}

// A compact card for a grid cell — the location is the column, so it's dropped.
function gridCardHtml(he) {
  const end = he.endTime ? `<p class="schg-ev-time">until ${esc(fmtHM(he.endTime))}</p>` : '';
  const along = he.anchorTitle
    ? `<p class="schg-ev-sub"><span class="sch-along__label">Alongside</span><span>${esc(he.anchorTitle)}</span></p>`
    : '';
  const guests = he.guests
    ? `<p class="schg-ev-sub"><span class="sch-guests__label">Guests</span><span>${esc(he.guests)}</span></p>`
    : '';
  const avatars = personalAssigneeChips(he.memberIds || []);
  const people = avatars.length
    ? `<div class="pl-avatars schg-ev-people">${avatars.map((a) => `<span class="pl-avatar" title="${esc(a.name)}">${esc(a.initial)}</span>`).join('')}</div>`
    : '';
  return `<div class="schg-ev${he.done ? ' schg-ev--done' : ''}" data-he-id="${esc(he.id)}">
    <span class="schg-ev-acts">
      <button type="button" class="sch-act sch-cal" data-he-id="${esc(he.id)}" aria-label="Add ${esc(he.title || 'event')} to a calendar">Calendar</button>
      <button type="button" class="sch-act sch-act--del sch-remove" data-he-id="${esc(he.id)}" aria-label="Remove ${esc(he.title || 'event')}">Remove</button>
    </span>
    <p class="schg-ev-title sch-edit" data-he-id="${esc(he.id)}" role="button" tabindex="0">${esc(he.title || 'Hosted event')}</p>
    ${end}${along}${guests}${people}
  </div>`;
}

// Location grid — one column per location, timeslots down the left rail. Scales
// to concurrent events across booths/rooms; scrolls horizontally past a few.
function dayGridHtml(events) {
  const locs = [...new Set(events.map(locationKey))].sort((a, b) =>
    a === '—' ? 1 : b === '—' ? -1 : a.localeCompare(b),
  );
  const slots = [...new Set(events.map((e) => e.time || ''))].sort();
  const head =
    `<div class="schg-corner"></div>` +
    locs
      .map(
        (l) => `<div class="schg-colhead"><span>${esc(l === '—' ? 'No location' : l)}</span></div>`,
      )
      .join('');
  const body = slots
    .map((slot) => {
      const timeCell = `<div class="schg-time">${slot ? esc(fmtHM(slot)) : 'All day'}</div>`;
      const cells = locs
        .map((l) => {
          const evs = events
            .filter((e) => (e.time || '') === slot && locationKey(e) === l)
            .sort(byTime);
          return `<div class="schg-cell">${evs.map(gridCardHtml).join('')}</div>`;
        })
        .join('');
      return timeCell + cells;
    })
    .join('');
  return `<div class="schg-scroll"><div class="schg" style="grid-template-columns:4.2rem repeat(${locs.length},minmax(10rem,1fr))">${head}${body}</div></div>`;
}

// A deep link to the public schedule (index.html) for the associated conference.
// Mirrors how index.html resolves ?id — meta slug first, else the data filename.
function officialScheduleUrl() {
  const meta = state.eventMeta || {};
  const fromMeta = slugify([meta.designation, meta.year, meta.location].filter(Boolean).join(' '));
  const id = fromMeta || slugify(String(state.eventFile || '').replace(/\.json$/i, ''));
  return id ? `./index.html?id=${id}` : '';
}

export function renderScheduleTab() {
  const listEl = document.getElementById('scheduleList');
  const emptyEl = document.getElementById('scheduleEmpty');
  if (!listEl) return;

  // Point the "Official schedule" link at the associated conference (if any).
  const link = document.getElementById('scheduleOfficialLink');
  if (link) {
    const url = officialScheduleUrl();
    link.classList.toggle('hidden', !url);
    if (url) link.href = url;
  }

  const events = hostedList().filter((h) => h.date);
  emptyEl?.classList.toggle('hidden', events.length > 0);

  const byDay = {};
  events.forEach((he) => (byDay[he.date] ??= []).push(he));
  const listHtml = Object.keys(byDay)
    .sort()
    .map((date) => {
      const dayEvents = byDay[date];
      // Grid once a day genuinely spans multiple places; otherwise the list reads cleaner.
      const realLocs = new Set(dayEvents.map((e) => (e.location || '').trim()).filter(Boolean));
      const body = realLocs.size >= 2 ? dayGridHtml(dayEvents) : dayListHtml(dayEvents);
      return `<div class="sch-day-block">
        <div class="doc-divider"><span>${esc(dayLabel(date))}</span><span class="doc-divider-n">${dayEvents.length} ${dayEvents.length === 1 ? 'event' : 'events'}</span></div>
        ${body}
      </div>`;
    })
    .join('');

  // Calendar chips reuse the shared read-only detail modal (hosted events are a
  // resolvable type), so the default chipOpen is fine.
  const calEvents = events.map((he) => ({
    date: he.date,
    time: he.time || '',
    icon: 'fas fa-bullhorn',
    label: he.title || 'Hosted event',
    sub: he.location || he.anchorTitle || '',
    type: 'hosted',
    id: he.id,
    done: he.done,
  }));
  renderSurfaceView('scheduleList', 'schedule', {
    hasItems: events.length > 0,
    days: groupEventsByDay(calEvents),
    listHtml,
  });
}

// ── Calendar ──────────────────────────────────────────────────────────────────

function hostedCalEvent(he) {
  if (!he.date) return null;
  const time = he.time || '';
  return {
    title: he.title || 'Hosted event',
    start: { date: he.date, time },
    end: time && he.endTime ? { date: he.date, time: he.endTime } : null,
    allDay: !time,
    location: he.location || '',
    description: [
      he.description,
      he.guests ? `Guests: ${he.guests}` : '',
      he.anchorTitle ? `Alongside: ${he.anchorTitle}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    // Hosted events are planned in the conference's local time.
    timezone: getTimezone() || '',
  };
}

// ── Editor modal ──────────────────────────────────────────────────────────────

let _heId = null;

function els() {
  return {
    modal: document.getElementById('hostedEventModal'),
    title: document.getElementById('heTitle'),
    anchor: document.getElementById('heAnchorSelect'),
    anchorHint: document.getElementById('heAnchorHint'),
    date: document.getElementById('heDate'),
    start: document.getElementById('heStart'),
    end: document.getElementById('heEnd'),
    location: document.getElementById('heLocation'),
    guests: document.getElementById('heGuests'),
    chips: document.getElementById('heAssignChips'),
    chipHint: document.getElementById('heAssignHint'),
    description: document.getElementById('heDescription'),
    done: document.getElementById('heDone'),
    delete: document.getElementById('hostedEventDelete'),
  };
}

function sortedSessions() {
  return (state.allSessions || [])
    .filter((s) => s.startTime)
    .slice()
    .sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));
}

function populateAnchorSelect(selectedId) {
  const m = els();
  if (!m.anchor) return;
  const tz = getTimezone();
  const opts = sortedSessions()
    .map((s) => {
      const dayShort = new Date(s.startTime).toLocaleDateString(undefined, {
        timeZone: tz,
        weekday: 'short',
        day: 'numeric',
      });
      return `<option value="${esc(s.id)}"${s.id === selectedId ? ' selected' : ''}>${esc(dayShort)} ${esc(fmtTime(s.startTime))} — ${esc(s.title || 'Session')}</option>`;
    })
    .join('');
  m.anchor.innerHTML = `<option value="">Custom time (not tied to a session)</option>${opts}`;
  // No programme? Hide the anchor row entirely — custom time is the only path.
  const wrap = m.anchor.closest('.editor-form-field');
  wrap?.classList.toggle('hidden', sortedSessions().length === 0);
}

function renderChips(selectedIds) {
  const m = els();
  if (!m.chips) return;
  const sel = new Set(selectedIds);
  m.chips.innerHTML = personalAssignablePeople()
    .map((pp) => {
      const initial = (pp.name.trim()[0] || '?').toUpperCase();
      return `<button type="button" class="pl-chip" aria-pressed="${sel.has(pp.id)}" data-person-id="${esc(pp.id)}"><span class="pl-chip-av">${esc(initial)}</span>${esc(pp.name)}</button>`;
    })
    .join('');
  updateChipHint();
}

function updateChipHint() {
  const m = els();
  if (!m.chipHint) return;
  const n = m.chips?.querySelectorAll('.pl-chip[aria-pressed="true"]').length || 0;
  m.chipHint.textContent = n ? '' : 'No one picked yet — add who’s involved.';
}

function readChips() {
  const m = els();
  return [...(m.chips?.querySelectorAll('.pl-chip[aria-pressed="true"]') || [])].map(
    (c) => c.dataset.personId,
  );
}

// Fill date/start/end from the chosen anchor session; update the hint. Called when
// the anchor select changes and when opening an anchored event.
function applyAnchor(sessionId, { fillTimes = true } = {}) {
  const m = els();
  const s = (state.allSessions || []).find((x) => x.id === sessionId);
  if (!s) {
    if (m.anchorHint)
      m.anchorHint.textContent = 'Pin this to a programme slot, or set your own time below.';
    return;
  }
  const slot = sessionSlot(s);
  if (fillTimes) {
    if (m.date) m.date.value = slot.date;
    if (m.start) m.start.value = slot.time;
    if (m.end) m.end.value = slot.endTime;
    if (m.location && !m.location.value.trim() && s.location) m.location.value = s.location;
  }
  if (m.anchorHint)
    m.anchorHint.textContent = `Runs alongside “${s.title || 'session'}”${s.location ? ` · ${s.location}` : ''}`;
}

function openHostedModal(id = null) {
  const m = els();
  if (!m.modal) return;
  _heId = id;
  const he = id ? hostedList().find((x) => x.id === id) : null;

  document.getElementById('hostedEventModalTitle').textContent = id
    ? 'Edit hosted event'
    : 'Add hosted event';

  m.title.value = he?.title || '';
  populateAnchorSelect(he?.anchorSessionId || '');
  m.date.value = he?.date || '';
  m.start.value = he?.time || '';
  m.end.value = he?.endTime || '';
  m.location.value = he?.location || '';
  m.guests.value = he?.guests || '';
  m.description.value = he?.description || '';
  m.done.checked = !!he?.done;
  renderChips(he?.memberIds || []);
  applyAnchor(he?.anchorSessionId || '', { fillTimes: false });
  m.delete.classList.toggle('hidden', !id);

  showModal('hostedEventModal', 'heTitle');
}

function closeHostedModal() {
  hideModal('hostedEventModal');
  _heId = null;
}

function saveHostedEvent() {
  const m = els();
  const personal = state.planner?.personal;
  if (!personal) return;
  const title = m.title.value.trim();
  if (!title) {
    m.title.focus();
    return;
  }
  const date = m.date.value || '';
  if (!date) {
    m.date.focus();
    return;
  }
  const anchorSessionId = m.anchor.value || '';
  const anchor = anchorSessionId
    ? (state.allSessions || []).find((s) => s.id === anchorSessionId)
    : null;

  const fields = {
    title,
    description: m.description.value.trim(),
    location: m.location.value.trim(),
    guests: m.guests.value.trim(),
    date,
    time: m.start.value || '',
    endTime: m.end.value || '',
    memberIds: readChips(),
    done: m.done.checked,
    anchorSessionId,
    anchorTitle: anchor?.title || '',
    anchorLocation: anchor?.location || '',
  };

  const list = hostedList();
  if (_heId) {
    const existing = list.find((x) => x.id === _heId);
    if (existing) Object.assign(existing, fields);
  } else {
    list.push({ id: makeItemId('he'), ...fields });
  }

  scheduleAutoSave();
  closeHostedModal();
  renderScheduleTab();
  renderPersonalItineraryTab();
}

function removeHostedEvent(id) {
  const personal = state.planner?.personal;
  if (!personal) return;
  personal.hostedEvents = hostedList().filter((x) => x.id !== id);
  scheduleAutoSave();
  renderScheduleTab();
  renderPersonalItineraryTab();
}

// ── Wiring ────────────────────────────────────────────────────────────────────

export function wireSchedulePanel() {
  registerViewSurface('schedule', renderScheduleTab);
  const panel = document.getElementById('plannerSchedulePanel');
  if (panel) {
    document
      .getElementById('scheduleAddEventBtn')
      ?.addEventListener('click', () => openHostedModal());
    document
      .getElementById('scheduleEmptyAddBtn')
      ?.addEventListener('click', () => openHostedModal());

    panel.addEventListener('click', (e) => {
      const cal = e.target.closest('.sch-cal');
      if (cal) {
        const he = hostedList().find((x) => x.id === cal.dataset.heId);
        const calEvent = he && hostedCalEvent(he);
        if (calEvent) openCalendarMenu(cal, calEvent, { id: he.id, filenameBase: he.title });
        return;
      }
      const rm = e.target.closest('.sch-remove');
      if (rm) {
        removeHostedEvent(rm.dataset.heId);
        return;
      }
      const edit = e.target.closest('.sch-edit');
      if (edit) {
        openHostedModal(edit.dataset.heId);
        return;
      }
    });

    panel.addEventListener('keydown', (e) => {
      const t = e.target.closest('.sch-title[role="button"]');
      if (t && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        openHostedModal(t.dataset.heId);
      }
    });
  }

  // Modal wiring (bound once at boot).
  const modal = document.getElementById('hostedEventModal');
  if (!modal) return;
  document.getElementById('hostedEventModalClose')?.addEventListener('click', closeHostedModal);
  document.getElementById('hostedEventSave')?.addEventListener('click', saveHostedEvent);
  document.getElementById('hostedEventDelete')?.addEventListener('click', () => {
    if (_heId) removeHostedEvent(_heId);
    closeHostedModal();
  });
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeHostedModal();
  });
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeHostedModal();
  });
  document.getElementById('heAnchorSelect')?.addEventListener('change', (e) => {
    applyAnchor(e.target.value);
  });
  document.getElementById('heAssignChips')?.addEventListener('click', (e) => {
    const chip = e.target.closest('.pl-chip');
    if (!chip) return;
    chip.setAttribute(
      'aria-pressed',
      chip.getAttribute('aria-pressed') === 'true' ? 'false' : 'true',
    );
    updateChipHint();
  });
}

// Static shell for this tab panel — injected into #plannerSchedulePanel at boot.
export function schedulePanelHtml() {
  return `
          <section>
            <div class="pln-section__head">
              <div>
                <p class="pln-eyebrow">Your programme</p>
                <h2 class="pln-section__title">Events you're hosting</h2>
              </div>
              <div class="sch-head-actions">
                <a id="scheduleOfficialLink" class="sch-link hidden" href="./index.html" target="_blank" rel="noopener">Official schedule</a>
                <button id="scheduleAddEventBtn" type="button" class="pl-add-btn">Host an event</button>
              </div>
            </div>

            <div id="scheduleList" class="sch-days"></div>
            <div id="scheduleEmpty" class="jrn-empty">
              <p class="jrn-empty-t">Run your own programme</p>
              <p class="jrn-empty-s">Schedule the events you're hosting during the conference — an in-booth demo, a customer meeting, a side session — each pinned to a programme slot or a time of your own. They'll show on your Itinerary and export to calendars.</p>
              <button type="button" id="scheduleEmptyAddBtn" class="jrn-empty-btn">Host your first event</button>
            </div>
          </section>
        `;
}
