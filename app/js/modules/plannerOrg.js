// Org tab + shared trip-rendering helpers — travel-leg cards, assignment cards,
// accommodation cards, waypoint-stop rows and their drag-drop, the multi-member
// timeline, and the org tab render. These render helpers are consumed across the
// assignment / accommodation / leg modals, so they are exported broadly.
// Extracted from planner.js: planner-internal collaborators are injected via
// initOrg(); shared field/travel/storage/renderKit helpers are imported directly.

import { escapeHtml as esc } from './utils.js';
import { makeItemId } from './plannerStorage.js';
import { buildSelectOptions, currencyOptions } from './plannerFields.js';
import { removeIconBtn, emptyStateP } from './renderKit.js';
import { linkedReceipt } from './plannerEntityReceipt.js';
import { renderOrgItinerary, renderItineraryTab } from './plannerItinerary.js';
import { renderTrackedSessions } from './plannerTrackedSessions.js';
import { openMapPicker } from './mapPicker.js';
import {
  conferenceName,
  conferenceSpanDaysMulti,
  conferenceNamesMulti,
  conferenceLegendChip,
  personTicketDays,
  CONFERENCE_ROW_ACCENT,
  TICKET_ROW_ACCENT,
} from './plannerConferenceBand.js';
import {
  TRAVEL_MODES,
  TRAVEL_STATUSES,
  TIMELINE_COLORS,
  travelStatusBadge,
  travelIcon,
  sortLegs,
  accomCellBg,
} from './plannerTravel.js';

// ── Injected planner collaborators ────────────────────────────────────────────
let state;
let scheduleAutoSave;
let getTimezone;
let localDateStr;
let checklistItemHtml;
let renderBudgetItems;
let renderSponsorBudgetBreakdown;
let swagCardHtml;
let syncEventTitleField;

export function initOrg(deps) {
  ({
    state,
    scheduleAutoSave,
    getTimezone,
    localDateStr,
    checklistItemHtml,
    renderBudgetItems,
    renderSponsorBudgetBreakdown,
    swagCardHtml,
    syncEventTitleField,
  } = deps);
}

function legCardHtml(leg, direction) {
  const modeOptions = Object.entries(TRAVEL_MODES)
    .map(
      ([val, { label }]) =>
        `<option value="${val}"${leg.mode === val ? ' selected' : ''}>${label}</option>`,
    )
    .join('');
  const statusOptions = buildSelectOptions(TRAVEL_STATUSES, leg.status || '');
  const d = direction;
  const li = esc(leg.id);
  const icon = travelIcon(leg.mode || 'flight', direction === 'return');
  // A labelled input field, so every box says what it holds.
  const input = (field, type, placeholder = '', title = '') =>
    `<input type="${type}" data-leg-id="${li}" data-direction="${d}" data-leg-field="${field}"${
      title ? ` title="${title}"` : ''
    } value="${esc(leg[field] || '')}" placeholder="${placeholder}" class="pl-legedit-input">`;
  const field = (label, inner, wide = false) =>
    `<label class="pl-legedit-field${wide ? ' pl-legedit-field--wide' : ''}"><span class="pl-legedit-label">${label}</span>${inner}</label>`;
  // Optional destination timezone — recorded so the arrival time reads as local
  // to where you land. Uses the shared #tzList datalist for type-ahead.
  const tzInput = `<input type="text" list="tzList" data-leg-id="${li}" data-direction="${d}" data-leg-field="arriveTz" value="${esc(leg.arriveTz || '')}" placeholder="Optional — e.g. Europe/Amsterdam" class="pl-legedit-input">`;
  return `
    <div class="pl-legedit" data-leg-id="${li}" data-direction="${d}">
      <div class="pl-legedit-top">
        <span class="pl-legedit-badge" aria-hidden="true"><i class="${icon}"></i></span>
        <select data-leg-id="${li}" data-direction="${d}" data-leg-field="mode"
          class="pl-legedit-input pl-legedit-select" aria-label="Mode of travel">${modeOptions}</select>
        <select data-leg-id="${li}" data-direction="${d}" data-leg-field="status"
          class="pl-legedit-input pl-legedit-select" aria-label="Booking status">${statusOptions}</select>
        ${removeIconBtn({ hook: 'remove-leg-btn', data: `data-leg-id="${li}" data-direction="${d}"`, label: 'Remove leg', extraClass: 'pl-legedit-remove ml-auto' })}
      </div>
      <div class="pl-legedit-route">
        ${field('From', input('from', 'text', 'e.g. SYD'))}
        <span class="pl-legedit-arrow" aria-hidden="true">→</span>
        ${field('To', input('to', 'text', 'e.g. SIN'))}
      </div>
      <div class="pl-legedit-grid">
        ${field('Departs', input('date', 'date'))}
        ${field('Departs at', input('departTime', 'time'))}
        ${field('Arrives', input('arriveDate', 'date', '', 'Arrival date (auto-filled if arrive time wraps past midnight)'))}
        ${field('Arrives at', input('arriveTime', 'time'))}
        ${field('Arrival timezone', tzInput, true)}
        ${field('Reference', input('ref', 'text', 'Flight / booking no.'))}
        ${field('Confirmation', input('confirmation', 'text', 'Confirmation #'))}
      </div>
      <div class="pl-legedit-receipt">
        <span class="pl-legedit-label">Receipt</span>
        ${(() => {
          const rc = linkedReceipt(state.planner, leg);
          return rc
            ? `<span class="text-xs pl-ink-1 truncate flex-1">${esc(rc.name || 'Receipt')}</span>
        <button type="button" class="leg-unlink-receipt-btn pl-legedit-attach" data-leg-id="${li}" data-direction="${d}" aria-label="Unlink receipt"></button>`
            : `<span class="pl-hint italic flex-1">No receipt linked</span>
        <button type="button" class="leg-link-receipt-btn pl-legedit-attach" data-leg-id="${li}" data-direction="${d}">Link</button>
        <button type="button" class="leg-create-receipt-btn pl-legedit-attach" data-leg-id="${li}" data-direction="${d}">Create</button>`;
        })()}
      </div>
    </div>`;
}

export function personalLegRowHtml(leg, direction) {
  const modeLabel = (TRAVEL_MODES[leg.mode || 'flight'] || TRAVEL_MODES.other).label.replace(
    /^\S+\s*/,
    '',
  );
  const from = leg.from || '';
  const to = leg.to || '';
  const fmtDate = (d) =>
    new Date(d + 'T12:00:00').toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  const date = leg.date
    ? leg.arriveDate && leg.arriveDate !== leg.date
      ? `${fmtDate(leg.date)} → ${fmtDate(leg.arriveDate)}`
      : fmtDate(leg.date)
    : '';
  const ref = leg.ref || '';
  const li = esc(leg.id);
  const viewLabel = `View ${direction} leg${from || to ? ': ' + from + (from && to ? ' to ' + to : '') : ''}`;
  // The route is drawn, not punctuated. Two terminals with a rule between them
  // that spans whatever width the row has, the mode named above it — the shape
  // of the journey rather than an arrow character between two strings.
  const route =
    from || to
      ? `<span class="pl-leg-route">
          <span class="pl-leg-end">${esc(from) || '—'}</span>
          <span class="pl-path"><span class="pl-path__mode">${esc(modeLabel)}</span></span>
          <span class="pl-leg-end">${esc(to) || '—'}</span>
        </span>`
      : `<span class="pl-leg-route pl-leg-route--empty">New ${esc(modeLabel.toLowerCase())} leg</span>`;
  const meta =
    date || ref
      ? `<div class="pl-leg-meta">${esc(date)}${date && ref ? ' · ' : ''}${ref ? `<span class="pl-code">${esc(ref)}</span>` : ''}</div>`
      : `<div class="pl-leg-meta" style="color:var(--text-3)">Open to add details</div>`;
  // The whole row is one calm click target that opens the read-only detail modal;
  // Edit / Remove / Add-to-calendar live inside it (data-view-* is read by the
  // shared handler in plannerItinerary's wireItineraryPanel).
  return `
    <button type="button" class="pl-leg pl-open" data-view-type="travel" data-view-leg-id="${li}" data-view-leg-dir="${direction}" aria-label="${esc(viewLabel)}">
      <div class="min-w-0">${route}${meta}</div>
      <div class="pl-acts">
        ${travelStatusBadge(leg.status)}
        <span class="pl-open-go" aria-hidden="true">&rsaquo;</span>
      </div>
    </button>`;
}

export function renderAssignmentLegsInModal(assignment) {
  const empty = emptyStateP('No legs yet. Click Add leg to start.');
  const outEl = document.getElementById('assignmentOutboundLegs');
  const retEl = document.getElementById('assignmentReturnLegs');
  const sortedOut = sortLegs(assignment.outboundLegs || []);
  const sortedRet = sortLegs(assignment.returnLegs || []);
  if (outEl)
    outEl.innerHTML = sortedOut.length
      ? sortedOut.map((l) => legCardHtml(l, 'outbound')).join('')
      : empty;
  if (retEl)
    retEl.innerHTML = sortedRet.length
      ? sortedRet.map((l) => legCardHtml(l, 'return')).join('')
      : empty;
}

function assignmentCardHtml(assignment) {
  const member = state.global?.teamMembers.find((m) => m.id === assignment.memberId);
  if (!member) return '';
  const accomNames = (state.planner.org.accommodations || [])
    .filter((acc) =>
      acc.assignments?.some((a) => a.memberId === assignment.memberId && (a.checkIn || a.checkOut)),
    )
    .map((acc) => acc.name || 'Unnamed')
    .join(', ');
  const outLegs = assignment.outboundLegs || [];
  const retLegs = assignment.returnLegs || [];
  const firstOut = outLegs.find((l) => l.date);
  const firstRet = retLegs.find((l) => l.date);
  const badges = [
    firstOut &&
      `<span title="Outbound from ${esc(firstOut.from || '?')}, ${outLegs.length} leg${outLegs.length !== 1 ? 's' : ''}">${outLegs.length > 1 ? `×${outLegs.length}` : 'Outbound'}</span>`,
    firstRet &&
      `<span title="Return from ${esc(firstRet.from || '?')}, ${retLegs.length} leg${retLegs.length !== 1 ? 's' : ''}">${retLegs.length > 1 ? `×${retLegs.length}` : 'Return'}</span>`,
    (() => {
      // Cost now lives on the linked receipt (org team-assignment travel).
      const r = linkedReceipt(state.planner, assignment);
      return r?.amount
        ? `<span>${esc(r.amount)}${r.currency ? ` ${esc(r.currency)}` : ''}</span>`
        : '';
    })(),
    accomNames && `<span>${esc(accomNames)}</span>`,
  ]
    .filter(Boolean)
    .join('');
  // Whole body opens the assignment editor; Remove stays on the row (the editor
  // has no delete of its own).
  return `
    <div class="pl-rowcard" data-assignment-id="${esc(assignment.memberId)}">
      <button type="button" class="pl-rowcard-body edit-assignment-btn" data-member-id="${esc(assignment.memberId)}" aria-label="Edit assignment for ${esc(member.name || 'member')}">
        <span class="pl-rowcard-title">${esc(member.name || 'Unnamed')}</span>
        <span class="pl-rowcard-meta">
          ${member.role ? `<span>${esc(member.role)}</span>` : ''}
          ${badges}
        </span>
      </button>
      <div class="pl-rowcard-acts">
        ${removeIconBtn({ hook: 'remove-assignment-btn', data: `data-member-id="${esc(assignment.memberId)}"`, label: `Remove ${esc(member.name || 'member')} from event` })}
      </div>
    </div>`;
}

export function accomTypeIcon(type) {
  return type === 'waypoints' ? 'fas fa-ship' : 'fas fa-bed';
}

export function makeWaypointStop() {
  return { id: makeItemId('cl'), location: '', coords: '', date: '', time: '', notes: '' };
}

// Parse a "lat, lon" string to [lat, lon], else null (LOCODEs / place names skip).
export function parseLatLon(str) {
  const m = String(str || '').match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lon = parseFloat(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [lat, lon] : null;
}

// The conference venue as a picker reference marker, so accommodation/waypoint
// locations can be placed relative to it. Null when there's no conference (e.g. a
// personal cruise trip) or no known venue.
function _conferenceReference() {
  const meta = state?.eventMeta || {};
  if (state?.planner?.isConference === false) return null;
  const venue = meta.venue || '';
  const city = meta.location || '';
  const coords = meta.coords || '';
  if (!coords && !venue && !city) return null;
  return {
    coords,
    query: venue ? `${venue}${city ? `, ${city}` : ''}` : city,
    label: conferenceName(meta) || venue || city || 'Conference',
  };
}

// Open the shared picker for a coords <input>, seeding it from the current value
// and a name/address query, and writing "lat, lon" back (firing `input` so the
// owning modal's save logic runs).
function _pickInto(coordsInput, { title, searchPlaceholder, query, reference }) {
  if (!coordsInput) return;
  const pt = parseLatLon(coordsInput.value);
  openMapPicker({
    title,
    searchPlaceholder,
    reference,
    lat: pt ? pt[0] : null,
    lon: pt ? pt[1] : null,
    query: query || (pt ? '' : coordsInput.value) || '',
    onConfirm: (la, lo) => {
      coordsInput.value = `${la}, ${lo}`;
      coordsInput.dispatchEvent(new Event('input', { bubbles: true }));
    },
  });
}

// One delegated handler for every "pick on map" button — waypoint rows and the
// personal/sponsor accommodation modals. Reused across all coordinate fields.
let _pickersWired = false;
export function initMapCoordPickers() {
  if (_pickersWired || typeof document === 'undefined') return;
  _pickersWired = true;
  document.addEventListener('click', (e) => {
    const wpBtn = e.target.closest?.('.pick-waypoint-coords-btn');
    if (wpBtn) {
      const row = wpBtn.closest('.pl-wpstop');
      _pickInto(row?.querySelector('[data-stop-field="coords"]'), {
        title: 'Pick waypoint location',
        searchPlaceholder: 'Search a port, place or address…',
        query: row?.querySelector('[data-stop-field="location"]')?.value || '',
        reference: _conferenceReference(),
      });
      return;
    }
    const acBtn = e.target.closest?.('#accomPickLocationBtn, #personalAccomModalPickLocationBtn');
    if (acBtn) {
      const p = acBtn.id === 'personalAccomModalPickLocationBtn';
      const id = (n) => document.getElementById(p ? `personalAccomModal${n}` : `accom${n}`);
      _pickInto(id('Coords'), {
        title: 'Pick accommodation location',
        searchPlaceholder: 'Search a hotel, address or place…',
        query: [id('Name')?.value, id('Address')?.value].filter(Boolean).join(', '),
        reference: _conferenceReference(),
      });
      return;
    }
    // Personal itinerary item — pin an activity's location on the map.
    if (e.target.closest?.('#personalItinPickLocationBtn')) {
      _pickInto(document.getElementById('personalItinCoords'), {
        title: 'Pick location',
        searchPlaceholder: 'Search a place or address…',
        query: [
          document.getElementById('personalItinTitle')?.value,
          document.getElementById('personalItinLocation')?.value,
        ]
          .filter(Boolean)
          .join(', '),
        reference: _conferenceReference(),
      });
    }
  });
}

function waypointStopRowHtml(leg) {
  return `<div class="pl-wpstop group" draggable="true" data-stop-id="${esc(leg.id)}">
    <span class="pl-wpstop-marker waypoint-stop-drag-handle" title="Drag to reorder" aria-label="Drag to reorder"></span>
    <div class="pl-wpstop-body">
      <div class="flex items-center gap-2">
        <input type="text"
          class="flex-1 min-w-0 h-8 px-2 rounded border pl-rule-none hover:pl-rule focus:pl-rule focus:ring-0 pl-surface-none text-sm font-medium pl-placeholder drupal-blue-focus"
          placeholder="Port / waypoint name" data-stop-field="location" value="${esc(leg.location || '')}">
        <div class="pl-wpstop-reorder" aria-hidden="false">
          <button type="button" class="move-waypoint-stop-up-btn pl-iconbtn" data-stop-id="${esc(leg.id)}" aria-label="Move earlier"></button>
          <button type="button" class="move-waypoint-stop-down-btn pl-iconbtn" data-stop-id="${esc(leg.id)}" aria-label="Move later"></button>
        </div>
        ${removeIconBtn({ hook: 'remove-waypoint-stop-btn', label: 'Remove waypoint', extraClass: 'opacity-0 group-hover:opacity-100 transition-opacity duration-150' })}
      </div>
      <div class="pl-wpstop-meta">
        <input type="date" class="h-7 rounded border pl-rule text-xs pl-surface px-1.5"
          data-stop-field="date" value="${esc(leg.date || '')}">
        <input type="time" class="h-7 rounded border pl-rule text-xs pl-surface px-1.5"
          data-stop-field="time" value="${esc(leg.time || '')}">
        <div class="waypoint-coords-wrapper flex items-center gap-1.5 px-2 py-1 rounded pl-surface border pl-rule focus-within:pl-rule transition-colors">
          <input type="text"
            class="flex-1 min-w-0 h-4 border-0 pl-surface-none text-[0.7rem] pl-ink-2 pl-placeholder focus:outline-none focus:pl-ink-1"
            placeholder="LOCODE, lat,lon, or place name…" data-stop-field="coords" value="${esc(leg.coords || '')}">
          <button type="button" class="pick-waypoint-coords-btn flex-shrink-0 pl-ink-2 hover:pl-accent transition-colors" aria-label="Pick location on map" title="Pick on map"></button>
        </div>
      </div>
    </div>
  </div>`;
}

export function renderWaypointStops(legs, listId, emptyId) {
  const list = document.getElementById(listId);
  const empty = document.getElementById(emptyId);
  if (!list) return;
  list.innerHTML = (legs || []).map(waypointStopRowHtml).join('');
  if (empty) empty.classList.toggle('hidden', (legs || []).length > 0);
}

export function toggleWaypointStopsSection(isWaypoints, sectionId) {
  document.getElementById(sectionId)?.classList.toggle('hidden', !isWaypoints);
}

export function wireWaypointStopsDragDrop(listId, emptyId, getAccFn) {
  const list = document.getElementById(listId);
  if (!list) return;
  let _dragged = null;
  let _fromHandle = false;

  // Drag is restricted to the anchor handle so the row's inputs stay usable. We
  // can't check this from the dragstart target: browsers fire dragstart on the
  // draggable row itself, not on the child handle you grabbed — so a
  // `closest('.waypoint-stop-drag-handle')` there always misses and blocks every
  // drag. Record whether the press landed on the handle at mousedown instead.
  list.addEventListener('mousedown', (e) => {
    _fromHandle = !!e.target.closest('.waypoint-stop-drag-handle');
  });

  list.addEventListener('dragstart', (e) => {
    if (!_fromHandle) {
      e.preventDefault();
      return;
    }
    const row = e.target.closest('[data-stop-id]');
    if (!row) return;
    _dragged = row.dataset.stopId;
    row.classList.add('tab-drag-source');
    e.dataTransfer.effectAllowed = 'move';
  });

  list.addEventListener(
    'dragend',
    () => {
      _dragged = null;
      _fromHandle = false;
      list
        .querySelectorAll('.tab-drag-source, .settings-drop-before, .settings-drop-after')
        .forEach((el) =>
          el.classList.remove('tab-drag-source', 'settings-drop-before', 'settings-drop-after'),
        );
    },
    { passive: true },
  );

  list.addEventListener('dragover', (e) => {
    if (!_dragged) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const target = e.target.closest('[data-stop-id]');
    list
      .querySelectorAll('.settings-drop-before, .settings-drop-after')
      .forEach((el) => el.classList.remove('settings-drop-before', 'settings-drop-after'));
    if (target && target.dataset.stopId !== _dragged) {
      const rect = target.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      target.classList.add(before ? 'settings-drop-before' : 'settings-drop-after');
    }
  });

  list.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!_dragged) return;
    const target = e.target.closest('[data-stop-id]');
    if (!target || target.dataset.stopId === _dragged) return;
    const acc = getAccFn();
    if (!acc) return;
    const legs = acc.stops || [];
    const from = legs.findIndex((l) => l.id === _dragged);
    const to = legs.findIndex((l) => l.id === target.dataset.stopId);
    if (from === -1 || to === -1) return;
    const rect = target.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    const newLegs = [...legs];
    const [moved] = newLegs.splice(from, 1);
    const insertAt = before ? to - (from < to ? 1 : 0) : to + (from > to ? 1 : 0);
    newLegs.splice(Math.max(0, insertAt), 0, moved);
    acc.stops = newLegs;
    renderWaypointStops(acc.stops, listId, emptyId);
    scheduleAutoSave();
  });

  // Reorder arrows — shown only on touch, where HTML5 drag events don't fire.
  list.addEventListener('click', (e) => {
    const upBtn = e.target.closest('.move-waypoint-stop-up-btn');
    const downBtn = e.target.closest('.move-waypoint-stop-down-btn');
    if (!upBtn && !downBtn) return;
    const legId = (upBtn || downBtn).dataset.stopId;
    const acc = getAccFn();
    if (!acc) return;
    const legs = acc.stops || [];
    const idx = legs.findIndex((l) => l.id === legId);
    if (idx === -1) return;
    const swap = upBtn ? idx - 1 : idx + 1;
    if (swap < 0 || swap >= legs.length) return;
    const newLegs = [...legs];
    [newLegs[idx], newLegs[swap]] = [newLegs[swap], newLegs[idx]];
    acc.stops = newLegs;
    renderWaypointStops(acc.stops, listId, emptyId);
    scheduleAutoSave();
  });
}

function accommodationCardHtml(acc, colorIdx) {
  const col = TIMELINE_COLORS[colorIdx % TIMELINE_COLORS.length];
  const stayNames = (acc.assignments || [])
    .filter((a) => a.checkIn || a.checkOut)
    .map((a) => {
      const m = state.global?.teamMembers.find((tm) => tm.id === a.memberId);
      return m?.name || null;
    })
    .filter(Boolean);
  // Timeline colour is meaningful (matches this stay's band on the org timeline),
  // so it stays as the card's left-rail + icon tint. Body opens the editor; the
  // calendar + remove quick actions stay on the row.
  return `
    <div class="pl-rowcard" style="border-left:3px solid ${col.border}" data-accom-id="${esc(acc.id)}">
      <i class="${accomTypeIcon(acc.type)} pl-rowcard-ic" style="color:${col.border}" aria-hidden="true"></i>
      <button type="button" class="pl-rowcard-body edit-accommodation-btn" data-accom-id="${esc(acc.id)}" aria-label="Edit ${esc(acc.name || 'accommodation')}">
        <span class="pl-rowcard-title">${esc(acc.name || (acc.type === 'waypoints' ? 'New Waypoint' : 'New Accommodation'))}</span>
        <span class="pl-rowcard-meta">
          ${acc.address ? `<span>${esc(acc.address)}</span>` : ''}
          ${stayNames.length ? `<span>${esc(stayNames.join(', '))}</span>` : ''}
          ${acc.budget || acc.budgetActual ? `<span>${acc.budget ? esc(acc.budget) : ''}${acc.budgetActual ? ` / ${esc(acc.budgetActual)}` : ''}${acc.currency ? ` ${esc(acc.currency)}` : ''}</span>` : ''}
        </span>
      </button>
      <div class="pl-rowcard-acts">
        <button type="button" class="pl-iconbtn accommodation-cal-btn" data-accom-id="${esc(acc.id)}" aria-label="Add ${esc(acc.name || 'accommodation')} to a calendar" title="Add to calendar">
        </button>
        ${removeIconBtn({ hook: 'delete-accommodation-btn', data: `data-accom-id="${esc(acc.id)}"`, label: `Remove ${esc(acc.name || 'accommodation')}` })}
      </div>
    </div>`;
}

export function renderTimeline() {
  const container = document.getElementById('orgTimeline');
  if (!container) return;

  const { teamAssignments = [], accommodations = [], timeline = {} } = state.planner.org;

  if (!teamAssignments.length) {
    container.innerHTML =
      '<p class="pl-hint py-2">Assign team members to this event to see the timeline.</p>';
    return;
  }

  // Determine date range — use stored or derive from event + flight dates
  let startStr = timeline.startDate;
  let endStr = timeline.endDate;

  if (!startStr || !endStr) {
    const eventDates = state.allSessions.map((s) => s.startTime.slice(0, 10)).sort();
    const flightDates = teamAssignments
      .flatMap((a) => [
        ...(a.outboundLegs || []).map((l) => l.date),
        ...(a.returnLegs || []).map((l) => l.date),
        // legacy compat
        a.flightOut?.date,
        a.flightReturn?.date,
      ])
      .filter(Boolean)
      .sort();
    // Accommodation stays (per-member assignments + waypoint stops) so a stay that
    // runs past the last flight — incl. its checkout day — isn't cut off.
    const accomDates = accommodations.flatMap((a) => [
      ...(a.assignments || []).flatMap((s) => [s.checkIn, s.checkOut]),
      ...(a.stops || []).map((cl) => cl.date),
    ]);
    // Every associated conference's own span, so each indicator has columns to sit in.
    const confDates =
      state.planner?.isConference !== false ? conferenceSpanDaysMulti(state.events) : [];
    // Ticket days, so a ticketed day (incl. outside the conference) has a column.
    const ticketDates = (state.planner.org?.tickets || []).flatMap((t) =>
      Array.isArray(t.days) ? t.days : [],
    );
    const all = [...eventDates, ...flightDates, ...accomDates, ...confDates, ...ticketDates]
      .filter(Boolean)
      .sort();
    if (!all.length) {
      container.innerHTML =
        '<p class="pl-hint py-2">Set a date range above or add flight dates to see the timeline.</p>';
      return;
    }
    const first = new Date(all[0] + 'T00:00:00');
    first.setDate(first.getDate() - 1);
    const last = new Date(all[all.length - 1] + 'T00:00:00');
    last.setDate(last.getDate() + 1);
    startStr = startStr || localDateStr(first);
    endStr = endStr || localDateStr(last);
  }

  // Build day list
  const days = [];
  const cur = new Date(startStr + 'T00:00:00');
  const end = new Date(endStr + 'T00:00:00');
  if (cur > end || (end - cur) / 86400000 > 90) {
    container.innerHTML = '<p class="pl-hint py-2">Date range is invalid or exceeds 90 days.</p>';
    return;
  }
  while (cur <= end) {
    days.push(localDateStr(cur));
    cur.setDate(cur.getDate() + 1);
  }

  // Populate inputs if derived
  const si = document.getElementById('timelineStartDate');
  const ei = document.getElementById('timelineEndDate');
  if (si && !si.value) si.value = startStr;
  if (ei && !ei.value) ei.value = endStr;

  const eventDaySet = new Set(
    state.allSessions.map((s) =>
      new Date(s.startTime).toLocaleDateString('en-CA', { timeZone: getTimezone() }),
    ),
  );
  // Every associated conference's own span — highlights its days, accents the first
  // member's (flights + accommodation) row, and names the events in the legend.
  const confSpan =
    state.planner?.isConference !== false ? conferenceSpanDaysMulti(state.events) : [];
  confSpan.forEach((d) => eventDaySet.add(d));
  const confChip = conferenceLegendChip(confSpan, conferenceNamesMulti(state.events));
  // The global conference indicator lives in the header (an amber underline under
  // the conference dates); per-member ticket accents ride each row.
  // Per-member ticket days drive each row's accent: amber on conference days, slate
  // on ticketed non-conference days. The first member falls back to the full span
  // when they hold no ticket, so the indicator is present before tickets are dated.
  const confSpanSet = new Set(confSpan);
  const ticketList = state.planner.org?.tickets || [];
  const hasTicket = (pid) => ticketList.some((t) => t && t.assignedTo === pid);
  const bandFor = (pid, isPrimary = false) =>
    hasTicket(pid)
      ? personTicketDays(pid, ticketList, confSpan)
      : new Set(isPrimary ? confSpan : []);
  const rowAccent = (band, day) =>
    band.has(day) ? (confSpanSet.has(day) ? CONFERENCE_ROW_ACCENT : TICKET_ROW_ACCENT) : '';
  const todayStr = localDateStr(new Date());
  const colorMap = Object.fromEntries(
    accommodations.map((a, i) => [a.id, TIMELINE_COLORS[i % TIMELINE_COLORS.length]]),
  );

  function dayAccomMap(memberId) {
    const primary = {}; // main stay (checkIn through day before checkOut)
    const checkouts = {}; // accommodation being checked out of on that day

    accommodations.forEach((acc) => {
      const ma = acc.assignments?.find((a) => a.memberId === memberId);
      if (!ma?.checkIn || !ma?.checkOut) return;
      // Mark the checkout day separately
      checkouts[ma.checkOut] = acc;
      // Fill primary from checkIn up to (but not including) checkOut day
      const d = new Date(ma.checkIn + 'T00:00:00');
      const e = new Date(ma.checkOut + 'T00:00:00');
      e.setDate(e.getDate() - 1);
      while (d <= e) {
        primary[localDateStr(d)] = acc;
        d.setDate(d.getDate() + 1);
      }
    });

    // Merge: a checkout day that also has a primary (new checkin) → split cell
    const map = {};
    const allDays = new Set([...Object.keys(primary), ...Object.keys(checkouts)]);
    allDays.forEach((day) => {
      const inAccom = primary[day];
      const outAccom = checkouts[day];
      if (inAccom && outAccom && inAccom.id !== outAccom.id) {
        map[day] = { accom: inAccom, splitAccom: outAccom, kind: 'split' }; // left=checkout, right=checkin
      } else if (inAccom) {
        map[day] = { accom: inAccom, splitAccom: null, kind: 'stay' };
      } else {
        map[day] = { accom: outAccom, splitAccom: null, kind: 'checkout' };
      }
    });
    return map;
  }

  const headerCells = days
    .map((day) => {
      const isEvent = eventDaySet.has(day);
      const isToday = day === todayStr;
      const label = new Date(day + 'T00:00:00').toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
      });
      const cls = isToday ? 'tl-head-today' : isEvent ? 'tl-head-event' : 'tl-head-normal';
      // Subtle amber underline marks the conference span right in the header.
      const confHead = confSpanSet.has(day) ? 'border-bottom:2px solid #f59e0b;' : '';
      return `<th style="min-width:68px;${confHead}" class="${cls} text-center text-[0.65rem] px-1 py-2 whitespace-nowrap pl-divide-l">${label}${isToday ? '<br>' : ''}</th>`;
    })
    .join('');

  const rows = teamAssignments
    .map((assignment, memberIdx) => {
      const member = state.global?.teamMembers.find((m) => m.id === assignment.memberId);
      if (!member) return '';
      const dam = dayAccomMap(assignment.memberId);
      // This member's ticket days: their days, or full span if they're the first
      // member (fallback) — otherwise no band.
      const bandM = bandFor(assignment.memberId, memberIdx === 0);

      // Build day→legs arrays (all legs, sorted chronologically by departure time)
      const outDayLegs = {};
      const retDayLegs = {};
      (assignment.outboundLegs || [])
        .filter((l) => l.date)
        .forEach((l) => {
          (outDayLegs[l.date] ??= []).push({ mode: l.mode || 'other', time: l.departTime || '' });
        });
      (assignment.returnLegs || [])
        .filter((l) => l.date)
        .forEach((l) => {
          (retDayLegs[l.date] ??= []).push({ mode: l.mode || 'other', time: l.departTime || '' });
        });
      // Legacy compat
      if (assignment.flightOut?.date)
        (outDayLegs[assignment.flightOut.date] ??= []).push({ mode: 'flight', time: '' });
      if (assignment.flightReturn?.date)
        (retDayLegs[assignment.flightReturn.date] ??= []).push({ mode: 'flight', time: '' });
      Object.values(outDayLegs).forEach((legs) =>
        legs.sort((a, b) => a.time.localeCompare(b.time)),
      );
      Object.values(retDayLegs).forEach((legs) =>
        legs.sort((a, b) => a.time.localeCompare(b.time)),
      );

      const cells = days
        .map((day) => {
          const dayInfo = dam[day];
          const accom = dayInfo?.accom || null;
          const splitAccom = dayInfo?.splitAccom || null;
          const outLegs = outDayLegs[day] || [];
          const retLegs = retDayLegs[day] || [];
          const isEvent = eventDaySet.has(day);
          const isToday = day === todayStr;
          const cellCls =
            accom || splitAccom ? '' : isToday ? 'tl-cell-today' : isEvent ? 'tl-cell-event' : '';
          // Per-member accent along the top of the row on their ticket days.
          const confTop = rowAccent(bandM, day);
          const bgStyle =
            accomCellBg({
              color: accom ? colorMap[accom.id] : undefined,
              splitColor: splitAccom ? colorMap[splitAccom.id] : undefined,
              kind: dayInfo?.kind,
            }) + confTop;

          let content = '';
          if (outLegs.length || retLegs.length) {
            const hasBoth = outLegs.length && retLegs.length;
            const color = hasBoth ? '#7c3aed' : outLegs.length ? '#2563eb' : '#059669';
            const tip = hasBoth
              ? `${esc(member.name)} outbound + return`
              : outLegs.length
                ? `${esc(member.name)} outbound`
                : `${esc(member.name)} return`;
            const icons = [
              ...outLegs.map(
                (l) =>
                  `<i class="${travelIcon(l.mode, false)}" style="color:${color};font-size:0.62rem"></i>`,
              ),
              ...retLegs.map(
                (l) =>
                  `<i class="${travelIcon(l.mode, true)}"  style="color:${color};font-size:0.62rem"></i>`,
              ),
            ].join('');
            content = `<span class="inline-flex flex-wrap justify-center gap-1" title="${tip}">${icons}</span>`;
          }

          return `<td style="${bgStyle}" class="${cellCls} text-center px-1 py-2 pl-divide-l">${content}</td>`;
        })
        .join('');
      return `<tr class="pl-divide"><td class="text-xs font-medium pl-ink-1 pr-3 py-2 whitespace-nowrap pl-divide-r" style="min-width:90px">${esc(member.name || 'Unnamed')}</td>${cells}</tr>`;
    })
    .filter(Boolean)
    .join('');

  const legend =
    confChip +
    accommodations
      .map((acc, i) => {
        const c = TIMELINE_COLORS[i % TIMELINE_COLORS.length];
        return `<span class="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full font-medium" style="background:${c.bg};color:${c.text};border:1px solid ${c.border}"><i class="${accomTypeIcon(acc.type)} text-[0.6rem]"></i>${esc(acc.name || 'Unnamed')}</span>`;
      })
      .join('');

  container.innerHTML = rows
    ? `<div class="tl-scroll overflow-x-auto pl-bordered"><table class="min-w-full text-sm" style="border-collapse:collapse"><thead class="pl-surface-2"><tr><th class="text-left text-xs font-semibold pl-ink-2 pr-3 py-2 whitespace-nowrap pl-divide-r" style="min-width:90px">Member</th>${headerCells}</tr></thead><tbody>${rows}</tbody></table></div>${legend ? `<div class="flex flex-wrap gap-2 mt-3">${legend}</div>` : ''}`
    : '<p class="pl-hint py-2">No valid team assignments to display.</p>';
}

export function refreshAssignMemberSelect() {
  const sel = document.getElementById('assignMemberSelect');
  if (!sel) return;
  const assignedIds = new Set((state.planner.org.teamAssignments || []).map((a) => a.memberId));
  const available = (state.global?.teamMembers || []).filter((m) => !assignedIds.has(m.id));
  sel.innerHTML =
    `<option value="">＋ Assign team member…</option>` +
    available
      .map(
        (m) =>
          `<option value="${esc(m.id)}">${esc(m.name || 'Unnamed')}${m.role ? ` — ${esc(m.role)}` : ''}</option>`,
      )
      .join('');
  sel.parentElement?.classList.toggle('hidden', (state.global?.teamMembers || []).length === 0);
}

export function renderOrgTab() {
  const org = state.planner.org;

  syncEventTitleField('plannerSponsorTitle', 'plannerSponsorTitleHint');

  const boothInfo = document.getElementById('orgBoothInfo');
  const boothNotes = document.getElementById('orgBoothNotes');
  if (boothInfo) boothInfo.value = org.boothInfo || '';
  if (boothNotes) boothNotes.value = org.boothNotes || '';

  const sponsorBudgetEl = document.getElementById('orgSponsorBudget');
  const sponsorActualEl = document.getElementById('orgSponsorActual');
  const sponsorCurrencyEl = document.getElementById('orgSponsorCurrency');
  if (sponsorBudgetEl) sponsorBudgetEl.value = org.sponsorBudget || '';
  if (sponsorActualEl) sponsorActualEl.value = org.sponsorActual || '';
  if (sponsorCurrencyEl)
    sponsorCurrencyEl.innerHTML = currencyOptions(org.sponsorCurrency || 'AUD');

  const teamList = document.getElementById('orgTeamList');
  const teamEmpty = document.getElementById('orgTeamEmpty');
  if (teamList) {
    teamList.innerHTML = (org.teamAssignments || [])
      .map(assignmentCardHtml)
      .filter(Boolean)
      .join('');
    teamEmpty?.classList.toggle('hidden', (org.teamAssignments || []).length > 0);
  }
  refreshAssignMemberSelect();

  const accomList = document.getElementById('orgAccommodationsList');
  const accomEmpty = document.getElementById('orgAccommodationsEmpty');
  if (accomList) {
    accomList.innerHTML = (org.accommodations || [])
      .map((acc, i) => accommodationCardHtml(acc, i))
      .join('');
    accomEmpty?.classList.toggle('hidden', (org.accommodations || []).length > 0);
  }

  const swagList = document.getElementById('orgSwagList');
  const swagEmpty = document.getElementById('orgSwagEmpty');
  if (swagList) {
    swagList.innerHTML = (org.swag || []).map((item) => swagCardHtml(item)).join('');
    swagEmpty?.classList.toggle('hidden', (org.swag || []).length > 0);
  }

  const delivList = document.getElementById('orgDeliverablesList');
  const delivEmpty = document.getElementById('orgDeliverablesEmpty');
  if (delivList) {
    delivList.innerHTML = (org.deliverables || [])
      .map((item) => checklistItemHtml(item, 'deliverables'))
      .join('');
    delivEmpty?.classList.toggle('hidden', (org.deliverables || []).length > 0);
  }

  renderTimeline();
  renderItineraryTab();
  renderOrgItinerary();
  renderTrackedSessions('sponsor');
  renderBudgetItems('sponsor');
  renderSponsorBudgetBreakdown();
}

// Static shell for this tab panel — injected into #plannerSponsorPanel at boot (#7 co-location).
export function sponsorPanelHtml() {
  return `
          <section>
            <div data-wx-summary></div>
            <div class="pln-section__head">
              <div>
                <p class="pln-eyebrow">This event</p>
                <h2 class="pln-section__title">Planner</h2>
              </div>
            </div>
            <div class="mb-6 space-y-1">
              <label class="editor-form-field">
                <span class="editor-field-label">Event name</span>
                <input type="text" id="plannerSponsorTitle" placeholder="e.g. DrupalCon Prague 2026"
                  class="pl-field disabled:pl-ink-2 disabled:cursor-not-allowed">
              </label>
              <p id="plannerSponsorTitleHint" class="hidden pl-hint pl-0.5">Inherited from the associated schedule — disassociate to override</p>
            </div>
            <div class="space-y-7">

              <!-- Row: Booth + Event Team -->
              <div data-collapse="org-booth">
                <h3 class="doc-divider" style="margin-bottom:0.9rem"><span>Booth &amp; team</span></h3>
                <div class="grid grid-cols-1 lg:grid-cols-2 gap-6" data-collapse-body="org-booth">

                <!-- Booth info -->
                <div class="space-y-3">
                  <p class="org-sub">Booth / table</p>
                  <label class="editor-form-field">
                    <span class="editor-field-label">Booth / table info</span>
                    <input type="text" id="orgBoothInfo" placeholder="Table number, position, hall…" class="pl-field">
                  </label>
                  <label class="editor-form-field">
                    <span class="editor-field-label">Notes</span>
                    <textarea id="orgBoothNotes" rows="4" class="pl-textarea mt-1" placeholder="Setup instructions, contacts, requirements…"></textarea>
                  </label>
                </div>

                <!-- Event Team -->
                <div class="space-y-3">
                  <div class="flex items-center justify-between gap-3">
                    <p class="org-sub" style="margin-bottom:0">Event team</p>
                    <select id="assignMemberSelect" class="set-input flex-1 min-w-0 cursor-pointer" style="height:2rem;font-size:var(--fs-xs)">
                      <option value="">＋ Assign team member…</option>
                    </select>
                  </div>
                  <div id="orgTeamList" class="space-y-2"></div>
                  <p id="orgTeamEmpty" class="hidden text-xs pl-ink-2 py-2">No members assigned yet. Add members in the <strong>Team</strong> tab, then use the dropdown above to assign them.</p>
                </div>
              </div>
              </div><!-- /org-booth collapse body -->

              <!-- Accommodations -->
              <div class="space-y-3" data-collapse="org-accommodations">
                <div class="flex items-center justify-between gap-3">
                  <h3 class="doc-divider"><span>Accommodations</span></h3>
                  <button id="addAccommodationBtn" type="button" class="set-btn flex-shrink-0">Add</button>
                </div>
                <div data-collapse-body="org-accommodations" class="space-y-2">
                  <div id="orgAccommodationsList" class="space-y-2"></div>
                  <p id="orgAccommodationsEmpty" class="hidden text-xs pl-ink-2 py-2">No accommodations added. Use <strong>Add</strong> to track hotels, ship cabins, or other lodging for the team.</p>
                </div>
              </div>

              <!-- Timeline -->
              <div class="space-y-3" data-collapse="org-timeline">
                <div class="flex items-center justify-between flex-wrap gap-3">
                  <h3 class="doc-divider"><span>Timeline</span></h3>
                  <div class="flex items-center gap-3 text-xs pl-ink-2 flex-wrap">
                    <label class="flex items-center gap-1.5">
                      From
                      <input type="date" id="timelineStartDate" class="pl-field">
                    </label>
                    <label class="flex items-center gap-1.5">
                      To
                      <input type="date" id="timelineEndDate" class="pl-field">
                    </label>
                  </div>
                </div>
                <div data-collapse-body="org-timeline">
                  <div id="orgTimeline"></div>
                </div>
              </div>

              <!-- Team itinerary — who is doing what, by day. The timeline above
                   answers "where is everyone"; this answers "what are they doing".
                   It reads org.memberItinerary, and a cell opens that member's day. -->
              <div class="space-y-3" data-collapse="org-member-itinerary">
                <div class="flex items-center justify-between gap-3">
                  <h3 class="doc-divider"><span>Team itinerary</span></h3>
                  <div class="flex items-center gap-2 flex-shrink-0">
                    <label class="pl-label" for="itineraryStartDate">From</label>
                    <input type="date" id="itineraryStartDate" class="pl-field">
                    <label class="pl-label" for="itineraryEndDate">To</label>
                    <input type="date" id="itineraryEndDate" class="pl-field">
                  </div>
                </div>
                <div data-collapse-body="org-member-itinerary">
                  <div id="itineraryGrid"></div>
                </div>
              </div>

              <!-- Team Events (Org Itinerary) -->
              <div class="space-y-3" data-collapse="org-events">
                <div class="flex items-center justify-between gap-3">
                  <h3 class="doc-divider"><span>Team events</span></h3>
                  <button id="addOrgEventBtn" type="button" class="set-btn flex-shrink-0">Add</button>
                </div>
                <div data-collapse-body="org-events" class="space-y-2">
                  <div id="orgEventsList" class="space-y-2"></div>
                  <p id="orgEventsEmpty" class="hidden text-xs pl-ink-2 py-2">No team events yet. Use <strong>Add</strong> to schedule dinners, meetings, or group activities.</p>
                </div>
              </div>

              <!-- Row: Swag + Deliverables -->
              <div data-collapse="org-swag">
                <h3 class="doc-divider" style="margin-bottom:0.9rem"><span>Swag &amp; deliverables</span></h3>
                <div class="grid grid-cols-1 lg:grid-cols-2 gap-6" data-collapse-body="org-swag">

                <!-- Swag -->
                <div class="space-y-3">
                  <div class="flex items-center justify-between">
                    <p class="org-sub" style="margin-bottom:0">Swag</p>
                    <button id="addSwagBtn" type="button" class="set-btn flex-shrink-0">Add</button>
                  </div>
                  <div id="orgSwagList" class="space-y-2"></div>
                  <p id="orgSwagEmpty" class="hidden text-xs pl-ink-2 py-2">No swag items yet. Use <strong>Add</strong> to track quantities, budgets, and distribution.</p>
                </div>

                <!-- Deliverables -->
                <div class="space-y-3">
                  <div class="flex items-center justify-between">
                    <p class="org-sub" style="margin-bottom:0">Requirements</p>
                    <button id="addDeliverableBtn" type="button" class="set-btn flex-shrink-0">Add</button>
                  </div>
                  <div id="orgDeliverablesList" class="space-y-2"></div>
                  <p id="orgDeliverablesEmpty" class="hidden text-xs pl-ink-2 py-2">No deliverables yet. Use <strong>Add</strong> to track sponsor requirements and due dates.</p>
                </div>

              </div>
              </div><!-- /org-swag collapse body -->

              <!-- Tracked Sessions (Sponsor) -->
              <div id="sponsorTrackedSessionsSection" data-collapse="org-tracked" class="space-y-3">
                <h3 class="doc-divider"><span>Tracked sessions</span><span id="sponsorTrackedCount" class="doc-divider-n hidden"></span></h3>
                <div data-collapse-body="org-tracked" class="space-y-3">
                  <div class="relative">
                    <input type="text" id="sponsorSessionSearchInput" placeholder="Search sessions to track…"
                      class="h-9 w-full rounded-md pl-rule drupal-blue-focus text-sm pl-surface pl-8 pr-3"
                      autocomplete="off">
                  </div>
                  <div id="sponsorSessionSearchResults" class="hidden rounded-md border pl-rule pl-surface text-sm overflow-hidden max-h-48 overflow-y-auto"></div>
                  <div id="sponsorTrackedSessionsList" class="space-y-2"></div>
                  <p id="sponsorTrackedSessionsEmpty" class="hidden pl-hint py-2">No sessions tracked yet. Search above to add one.</p>
                </div>
              </div>

            </div>
          </section>
        `;
}
