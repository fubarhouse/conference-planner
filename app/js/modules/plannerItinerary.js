// Itinerary tab — per-day itinerary items for personal trips and per-team-member
// event days, plus the org event-itinerary list and its add/edit modal. Extracted
// from planner.js: planner-internal collaborators are injected via initItinerary();
// storage/modal/notify/util helpers are imported directly.

import { escapeHtml as esc } from './utils.js';
import { showModal, hideModal } from './modal.js';
import { makeItemId } from './plannerStorage.js';
import { showUndoToast } from './notify.js';
import { currencyOptions, parseBudget, formatAmount } from './plannerFields.js';
import { emptyStateP, removeIconBtn } from './renderKit.js';
import {
  renderEntityReceiptStatus,
  createReceiptForEntity,
  unlinkEntityReceipt,
  linkedReceipt,
} from './plannerEntityReceipt.js';
import {
  itineraryItemToCalEvent,
  legToCalEvent,
  accommodationToCalEvent,
} from './plannerCalendar.js';
import { openCalendarMenu } from './plannerCalendarUi.js';
import { parseLatLon } from './plannerOrg.js';
import { loadLeaflet } from './plannerMap.js';
import { TRAVEL_MODES, travelIcon } from './plannerTravel.js';
import {
  setViewMode,
  registerViewSurface,
  rerenderViewSurface,
  renderSurfaceView,
  groupEventsByDay,
} from './plannerCalendarView.js';

// ── Injected planner collaborators ────────────────────────────────────────────
let state;
let scheduleAutoSave;
let localDateStr;
let renderSummaryTab;
let getTimezone;
let openPersonalItineraryItemModal;
let openPersonalAccomModal;
let openPersonalLegModal;
let renderPersonalItinerary;
let renderPersonalItineraryTab;
let _openCalendarExportModal;
let renderPersonalTab;
let renderItineraryWeather;
let setActiveTab;
let renderReceiptsTab;
let openReceiptModal;

export function initItinerary(deps) {
  ({
    state,
    scheduleAutoSave,
    localDateStr,
    renderSummaryTab,
    getTimezone,
    openPersonalItineraryItemModal,
    openPersonalAccomModal,
    openPersonalLegModal,
    renderPersonalItinerary,
    renderPersonalItineraryTab,
    renderPersonalTab,
    renderItineraryWeather,
    setActiveTab,
    renderReceiptsTab,
    openReceiptModal,
  } = deps);
  // Injected rather than imported: plannerImportExport owns the feed modal, and
  // reaching for it directly would add an import edge between two feature
  // modules that the DI convention exists to avoid.
  _openCalendarExportModal = deps.openCalendarExportModal;
}

// Currency-prefixed amount shown on itinerary/org-event cards. Pure — exported
// for reuse by both list renderers and for unit testing.
export function fmtAmt(n, cur) {
  return `${esc(cur || 'AUD')} ${formatAmount(parseBudget(n))}`;
}

// The add/edit form's static fields, resolved once. The markup is fixed in
// planner.html, so one cached map beats re-querying these ids across the
// reset/open/edit paths and documents the form's DOM contract in one place.
let _els = null;
function els() {
  return (_els ??= {
    addForm: document.getElementById('itineraryAddForm'),
    title: document.getElementById('itineraryFormTitle'),
    time: document.getElementById('itineraryFormTime'),
    location: document.getElementById('itineraryFormLocation'),
    notes: document.getElementById('itineraryFormNotes'),
    budget: document.getElementById('itineraryFormBudget'),
    actual: document.getElementById('itineraryFormActual'),
    purchaseDate: document.getElementById('itineraryFormPurchaseDate'),
    currency: document.getElementById('itineraryFormCurrency'),
    editId: document.getElementById('itineraryFormEditId'),
    orgDate: document.getElementById('itineraryOrgDate'),
  });
}

// Populate the shared add/edit form from an existing item. Callers handle the
// context-specific bits (org date, focus) around this.
function fillItineraryForm(item) {
  const e = els();
  e.editId.value = item.id;
  e.title.value = item.title || '';
  e.time.value = item.time || '';
  e.location.value = item.location || '';
  e.notes.value = item.notes || '';
  e.budget.value = item.budget || '';
  e.actual.value = item.actual || '';
  if (e.purchaseDate) e.purchaseDate.value = item.purchaseDate || '';
  if (e.currency) e.currency.innerHTML = currencyOptions(item.currency || 'AUD');
}

export function makeItineraryItem(memberId, date) {
  const currency =
    state.planner?.mode === 'sponsor'
      ? state.planner?.org?.sponsorCurrency || 'AUD'
      : state.planner?.personal?.currency || 'AUD';
  return {
    id: makeItemId('it'),
    memberId,
    memberIds: [],
    date,
    time: '',
    title: '',
    location: '',
    coords: '', // optional "lat, lon" — pins the item exactly on the map
    receiptId: '', // optional link to a receipt that carries this item's actual cost
    notes: '',
    budget: '',
    actual: '',
    purchaseDate: '',
    currency,
    done: false,
  };
}

// Assignable people for a personal itinerary item: Me first, then trip companions
// and trip-local companions. Ids match item.memberIds ('__me__' for Me, otherwise
// a contact / localCompanion id). Empty memberIds on an item means "Everyone".
export function personalAssignablePeople() {
  const p = state.planner?.personal || {};
  const contacts = state.global?.personalContacts || [];
  const locals = p.localCompanions || [];
  const meId = p.meContactId || '__me__';
  // Resolve a name, or null when the contact can't be found (matching
  // companionCardHtml, which hides trip contacts that aren't loaded).
  const resolve = (id) =>
    contacts.find((c) => c.id === id)?.name || locals.find((lc) => lc.id === id)?.name || null;

  const meName = meId !== '__me__' && resolve(meId);
  const people = [{ id: meId, name: meName ? `${meName} (me)` : 'Me' }];
  const seen = new Set([meId]);
  (p.tripAssignments || []).forEach((a) => {
    const name = a.memberId && resolve(a.memberId);
    if (name && !seen.has(a.memberId)) {
      seen.add(a.memberId);
      people.push({ id: a.memberId, name });
    }
  });
  locals.forEach((lc) => {
    if (!seen.has(lc.id)) {
      seen.add(lc.id);
      people.push({ id: lc.id, name: lc.name || 'Unnamed' });
    }
  });
  return people;
}

// Resolve a set of assignee ids to compact display info (initial + full name) for
// avatars/chips. Unknown ids are dropped (e.g. a companion later removed).
export function personalAssigneeChips(memberIds) {
  if (!Array.isArray(memberIds) || !memberIds.length) return [];
  const people = personalAssignablePeople();
  return memberIds
    .map((id) => people.find((pp) => pp.id === id))
    .filter(Boolean)
    .map((pp) => ({ id: pp.id, name: pp.name, initial: (pp.name.trim()[0] || '?').toUpperCase() }));
}

export function renderItineraryTab() {
  const container = document.getElementById('itineraryGrid');
  if (!container) return;

  const { teamAssignments = [] } = state.planner.org;
  const itinerary = state.planner.org.memberItinerary || [];

  if (!teamAssignments.length) {
    container.innerHTML =
      '<p class="tg-note">Assign team members in the <strong>Org</strong> tab to see the itinerary grid.</p>';
    return;
  }

  // Derive date range from stored inputs, or event/leg/itinerary dates
  const startInput = document.getElementById('itineraryStartDate');
  const endInput = document.getElementById('itineraryEndDate');
  let startStr = startInput?.value || '';
  let endStr = endInput?.value || '';

  if (!startStr || !endStr) {
    const eventDates = state.allSessions.map((s) => s.startTime.slice(0, 10)).sort();
    const legDates = teamAssignments
      .flatMap((a) => [
        ...(a.outboundLegs || []).map((l) => l.date),
        ...(a.returnLegs || []).map((l) => l.date),
      ])
      .filter(Boolean)
      .sort();
    const itemDates = itinerary
      .map((i) => i.date)
      .filter(Boolean)
      .sort();
    const all = [...eventDates, ...legDates, ...itemDates].filter(Boolean).sort();
    if (all.length) {
      const first = new Date(all[0] + 'T00:00:00');
      first.setDate(first.getDate() - 1);
      const last = new Date(all[all.length - 1] + 'T00:00:00');
      last.setDate(last.getDate() + 1);
      startStr = startStr || localDateStr(first);
      endStr = endStr || localDateStr(last);
      if (startInput && !startInput.value) startInput.value = startStr;
      if (endInput && !endInput.value) endInput.value = endStr;
    }
  }

  // Fallback: use org timeline dates if still unresolved
  if (!startStr || !endStr) {
    const orgTimeline = state.planner.org?.timeline || {};
    if (!startStr && orgTimeline.startDate) {
      startStr = orgTimeline.startDate;
      if (startInput && !startInput.value) startInput.value = startStr;
    }
    if (!endStr && orgTimeline.endDate) {
      endStr = orgTimeline.endDate;
      if (endInput && !endInput.value) endInput.value = endStr;
    }
  }

  if (!startStr || !endStr) {
    container.innerHTML =
      '<p class="tg-note">Set a date range above, or set one in the Org → Timeline section.</p>';
    return;
  }

  const days = [];
  const cur = new Date(startStr + 'T00:00:00');
  const end = new Date(endStr + 'T00:00:00');
  if (cur > end || (end - cur) / 86400000 > 90) {
    container.innerHTML = '<p class="tg-note">Date range is invalid or exceeds 90 days.</p>';
    return;
  }
  while (cur <= end) {
    days.push(localDateStr(cur));
    cur.setDate(cur.getDate() + 1);
  }

  const todayStr = localDateStr(new Date());
  const eventDaySet = new Set(
    state.allSessions.map((s) =>
      new Date(s.startTime).toLocaleDateString('en-CA', { timeZone: getTimezone() }),
    ),
  );

  const headerCells = days
    .map((day) => {
      const isToday = day === todayStr;
      const isEvent = eventDaySet.has(day);
      const d = new Date(day + 'T00:00:00');
      const wk = d.toLocaleDateString(undefined, { weekday: 'short' });
      const dt = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      const cls = [
        'tg-day',
        isToday ? 'tg-day--today' : '',
        isEvent && !isToday ? 'tg-day--event' : '',
      ]
        .filter(Boolean)
        .join(' ');
      return `<th class="${cls}"><span class="tg-day-wk">${esc(wk)}</span><span class="tg-day-dt">${esc(dt)}</span><span class="itin-wx-col" data-wx-day="${esc(day)}"></span></th>`;
    })
    .join('');

  const rows = teamAssignments
    .map((assignment) => {
      const member = state.global?.teamMembers.find((m) => m.id === assignment.memberId);
      if (!member) return '';
      const initial = member.name?.trim()?.[0]?.toUpperCase() || '?';
      const cells = days
        .map((day) => {
          const items = itinerary
            .filter((i) => i.memberId === assignment.memberId && i.date === day)
            .sort((a, b) => (a.time || '').localeCompare(b.time || ''));
          const isToday = day === todayStr;
          const isEvent = eventDaySet.has(day);
          const cellCls = [
            'tg-cell',
            isToday ? 'tg-cell--today' : '',
            isEvent && !isToday ? 'tg-cell--event' : '',
          ]
            .filter(Boolean)
            .join(' ');
          const pills = items
            .map(
              (item) =>
                `<span class="tg-pill${item.done ? ' tg-pill--done' : ''} itinerary-cell-item" data-item-id="${esc(item.id)}" title="${esc(item.title)}">${esc(item.title)}</span>`,
            )
            .join('');
          return `<td class="${cellCls} itinerary-cell" data-member-id="${esc(assignment.memberId)}" data-date="${esc(day)}">${pills || '<span class="tg-add" aria-hidden="true">+</span>'}</td>`;
        })
        .join('');
      return `<tr><td class="tg-member"><span class="tg-member-in"><span class="pl-avatar">${esc(initial)}</span><span class="tg-member-name">${esc(member.name || 'Unnamed')}</span></span></td>${cells}</tr>`;
    })
    .filter(Boolean)
    .join('');

  container.innerHTML = `<div class="tg-wrap"><table class="tg"><thead><tr><th class="tg-corner">Team</th>${headerCells}</tr></thead><tbody>${rows}</tbody></table></div>`;
  renderItineraryWeather(); // per-day weather chips on the team-grid headers
}

function renderItineraryDayItems(memberId, date) {
  const container = document.getElementById('itineraryDayItems');
  if (!container) return;
  const modal = document.getElementById('itineraryDayModal');
  const isPersonal = modal?.dataset.ctx === 'personal';
  const pool = isPersonal
    ? state.planner.personal?.itinerary || []
    : state.planner.org.memberItinerary || [];
  const items = pool
    .filter((i) => (isPersonal ? i.date === date : i.memberId === memberId && i.date === date))
    .sort((a, b) => (a.time || '').localeCompare(b.time || ''));

  if (!items.length) {
    container.innerHTML = emptyStateP('No items yet. Click Add item to start.');
    return;
  }
  container.innerHTML = items
    .map((item) => {
      const hasBudget = item.budget !== '' && item.budget !== undefined;
      const hasActual = item.actual !== '' && item.actual !== undefined;
      const over = hasActual && hasBudget && parseBudget(item.actual) > parseBudget(item.budget);
      // Whole body opens the editor (drops the redundant pen); checkbox, calendar,
      // and delete stay as one-tap quick actions on the row.
      return `
    <div class="itin-item${item.done ? ' itin-item--done' : ''}" data-itinerary-item-id="${esc(item.id)}">
      <input type="checkbox" class="ckl-check itin-item-check itinerary-done-check" data-item-id="${esc(item.id)}" ${item.done ? 'checked' : ''} aria-label="Mark '${esc(item.title || 'item')}' as done">
      <button type="button" class="itin-item-body itinerary-edit-btn" data-item-id="${esc(item.id)}" aria-label="Edit '${esc(item.title || 'item')}'">
        <span class="itin-item-title">${esc(item.title)}</span>
        <span class="itin-item-meta">
          ${item.time ? `<span><i class="fas fa-clock" aria-hidden="true"></i>${esc(item.time)}</span>` : ''}
          ${item.location ? `<span><i class="fas fa-location-dot" aria-hidden="true"></i>${esc(item.location)}</span>` : ''}
          ${hasBudget ? `<span><i class="fas fa-wallet" aria-hidden="true"></i>Budget ${fmtAmt(item.budget, item.currency)}</span>` : ''}
          ${hasActual ? `<span class="${over ? 'is-over' : ''}"><i class="fas fa-coins" aria-hidden="true"></i>Actual ${fmtAmt(item.actual, item.currency)}</span>` : ''}
          ${item.notes ? `<span class="itin-item-note">${esc(item.notes)}</span>` : ''}
        </span>
      </button>
      <div class="itin-item-acts">
      <button type="button" class="pl-iconbtn itinerary-cal-btn" data-item-id="${esc(item.id)}" aria-label="Add '${esc(item.title || 'item')}' to a calendar" title="Add to calendar">
        <i class="fas fa-calendar-plus" aria-hidden="true"></i>
      </button>
      ${removeIconBtn({ hook: 'itinerary-delete-btn', data: `data-item-id="${esc(item.id)}"`, label: `Delete '${esc(item.title || 'item')}'` })}
      </div>
    </div>`;
    })
    .join('');
}

function closeItineraryDayModal() {
  const modal = document.getElementById('itineraryDayModal');
  if (!modal) return;
  const ctx = modal.dataset.ctx;
  hideModal('itineraryDayModal');
  modal.dataset.ctx = '';
  // Personal itinerary shows in three vertical places: the Gantt + the mobile
  // overview agenda (both via renderPersonalTimeline) and the Itinerary tab.
  if (ctx === 'personal') {
    renderPersonalItinerary();
    renderPersonalItineraryTab();
  } else if (ctx === 'org') renderOrgItinerary();
  else renderItineraryTab();
}

function _resetItineraryForm() {
  const e = els();
  e.title.value = '';
  e.time.value = '';
  e.location.value = '';
  e.notes.value = '';
  e.budget.value = '';
  e.actual.value = '';
  e.editId.value = '';
  if (e.currency) {
    const defaultCurr =
      state.planner?.mode === 'sponsor'
        ? state.planner?.org?.sponsorCurrency || 'AUD'
        : state.planner?.personal?.currency || 'AUD';
    e.currency.innerHTML = currencyOptions(defaultCurr);
  }
  // Receipt linking needs a saved item to attach to — hide the section until then.
  document.getElementById('itineraryFormReceiptSection')?.classList.add('hidden');
  // Default: show the cost inputs (personal day-items / member itineraries use them);
  // openOrgEventModal hides them for org events, which record cost on a receipt.
  document.getElementById('itineraryFormCostSection')?.classList.remove('hidden');
}

// The Receipt block in the org-event form — shown only when editing an existing
// org.itinerary item (a new item must be saved first). The item's actual moves to
// the linked receipt (see buildEventBudgetData).
function renderOrgEventReceiptStatus(item) {
  const section = document.getElementById('itineraryFormReceiptSection');
  if (section) section.classList.toggle('hidden', !item);
  if (!item) return;
  renderEntityReceiptStatus(document.getElementById('itineraryFormReceiptStatus'), {
    receipt: linkedReceipt(state.planner, item),
    idPrefix: 'itineraryForm',
    canLink: true,
  });
}

// The org.itinerary item the form is currently editing (org ctx + a saved editId).
function _currentOrgEvent() {
  const modal = document.getElementById('itineraryDayModal');
  if (modal?.dataset.ctx !== 'org') return null;
  const editId = document.getElementById('itineraryFormEditId')?.value || '';
  if (!editId) return null;
  return (state.planner.org?.itinerary || []).find((i) => i.id === editId) || null;
}

// Create a receipt for the org event and open it so cost/details are entered on the
// receipt (the single home for money). Closes the event modal to avoid stacking.
function createReceiptForOrgEvent() {
  const item = _currentOrgEvent();
  if (!item) return;
  const e = els();
  const receipt = createReceiptForEntity(state.planner, item, {
    name: e.title.value.trim() || item.title || 'Team event',
    date: e.orgDate?.value || item.date || '',
    currency: state.planner?.org?.sponsorCurrency || 'AUD',
    category: 'team',
  });
  scheduleAutoSave();
  renderReceiptsTab?.();
  closeItineraryDayModal();
  openReceiptModal?.(receipt.id);
}

export function openOrgEventModal(id = null) {
  const modal = document.getElementById('itineraryDayModal');
  if (!modal) return;
  modal.dataset.ctx = 'org';
  modal.dataset.memberId = '';
  modal.dataset.date = '';

  const titleEl = document.getElementById('itineraryDayModalTitle');
  const subtitleEl = document.getElementById('itineraryDayModalSubtitle');
  if (titleEl) titleEl.textContent = 'Team Event';
  if (subtitleEl) subtitleEl.textContent = id ? 'Edit event' : 'Add an org-level itinerary item';

  document.getElementById('itineraryFormMemberRow')?.classList.add('hidden');
  document.getElementById('itineraryOrgDateRow')?.classList.remove('hidden');
  document.getElementById('addItineraryItemBtn')?.classList.add('hidden');

  const form = document.getElementById('itineraryAddForm');
  if (form) form.classList.remove('hidden');
  document.getElementById('itineraryDayItems').innerHTML = '';

  _resetItineraryForm();
  // Org events record cost on a linked receipt — hide the inline cost inputs.
  document.getElementById('itineraryFormCostSection')?.classList.add('hidden');

  const item = id ? (state.planner.org?.itinerary || []).find((i) => i.id === id) : null;
  if (item) {
    fillItineraryForm(item);
    els().orgDate.value = item.date || '';
  }
  // Show the Receipt section for a saved item; hide it for a brand-new one (save first).
  renderOrgEventReceiptStatus(item);

  showModal('itineraryDayModal', 'itineraryFormTitle');
}

function orgEventRowHtml(item) {
  // Cost now lives on the linked receipt (if any).
  const receipt = linkedReceipt(state.planner, item);
  const hasActual = !!receipt?.amount;
  const dateLabel = item.date
    ? new Date(item.date + 'T00:00:00').toLocaleDateString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      })
    : '';
  return `<div class="flex items-start gap-2 py-1.5 px-2.5 rounded-md border pl-rule pl-surface">
      <input type="checkbox" class="mt-0.5 h-4 w-4 rounded flex-shrink-0 org-event-done-check" data-event-id="${esc(item.id)}" ${item.done ? 'checked' : ''} aria-label="Mark '${esc(item.title || 'event')}' as done">
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-1.5 flex-wrap">
          <span class="text-sm font-medium ${item.done ? 'line-through text-gray-500' : 'text-gray-700'} truncate">${esc(item.title || 'Team Event')}</span>
        </div>
        <div class="flex gap-3 text-xs mt-0.5 flex-wrap">
          ${dateLabel ? `<span class="pl-ink-2"><i class="fas fa-calendar-day text-[0.6rem] mr-0.5"></i>${esc(dateLabel)}${item.time ? ' · ' + esc(item.time) : ''}</span>` : ''}
          ${item.location ? `<span class="pl-ink-2"><i class="fas fa-location-dot text-[0.6rem] mr-0.5"></i>${esc(item.location)}</span>` : ''}
          ${hasActual ? `<span class="pl-ink-2"><i class="fas fa-receipt text-[0.6rem] mr-0.5"></i><span class="tabular-nums pl-ink-1">${fmtAmt(receipt.amount, receipt.currency)}</span></span>` : ''}
        </div>
      </div>
      <button type="button" class="org-event-cal-btn h-7 w-7 flex items-center justify-center rounded-md border pl-rule pl-ink-2 hover:pl-accent transition-colors flex-shrink-0" data-event-id="${esc(item.id)}" aria-label="Add ${esc(item.title || 'event')} to a calendar" title="Add to calendar">
        <i class="fas fa-calendar-plus text-[0.65rem]" aria-hidden="true"></i>
      </button>
      <button type="button" class="edit-org-event-btn h-7 w-7 flex items-center justify-center rounded-md border pl-rule pl-ink-2 transition-colors flex-shrink-0" data-event-id="${esc(item.id)}" aria-label="Edit ${esc(item.title || 'event')}">
        <i class="fas fa-pen-to-square text-[0.65rem]" aria-hidden="true"></i>
      </button>
      <button type="button" class="delete-org-event-btn h-7 w-7 flex items-center justify-center rounded-md border pl-rule pl-ink-2 hover-req transition-colors flex-shrink-0" data-event-id="${esc(item.id)}" aria-label="Delete ${esc(item.title || 'event')}">
        <i class="fas fa-times text-xs" aria-hidden="true"></i>
      </button>
    </div>`;
}

export function renderOrgItinerary() {
  const items = (state.planner.org?.itinerary || []).slice().sort((a, b) => {
    if (a.date !== b.date) return (a.date || '').localeCompare(b.date || '');
    return (a.time || '').localeCompare(b.time || '');
  });
  document.getElementById('orgEventsEmpty')?.classList.toggle('hidden', items.length > 0);
  const evs = items.map((it) => ({
    date: it.date,
    time: it.time || '',
    icon: 'fas fa-users',
    label: it.title || 'Team Event',
    sub: it.location || '',
    type: 'orgevent',
    id: it.id,
    done: it.done,
  }));
  renderSurfaceView('orgEventsList', 'org', {
    hasItems: items.length > 0,
    days: groupEventsByDay(evs),
    listHtml: items.map(orgEventRowHtml).join(''),
    // Org events open their own editor (not the read-only detail modal); reuse the
    // existing `.edit-org-event-btn` delegate so no new wiring is needed.
    calOpts: {
      chipOpen: (ev) => ({ cls: 'edit-org-event-btn', attrs: `data-event-id="${esc(ev.id)}"` }),
    },
  });
}

// ── Itinerary detail (read-only view) modal ─────────────────────────────────
// One modal reused for every agenda entry type — travel legs, stays, sessions,
// tickets, hosted events, and your own items. Renders a consistent mono detail
// sheet, a zoomed-in mini-map when coordinates exist, and (for editable entries)
// an Edit button that opens that entry's own editor. Read-only otherwise.
let _ivMap = null; // Leaflet map instance while the modal is open
let _ivArmTimer = null; // reverts the Remove button's armed (confirm) state

function _fmtNiceDate(iso) {
  if (!iso) return '';
  const d = new Date(String(iso).slice(0, 10) + 'T12:00:00');
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
function _fmtHM(hhmm) {
  if (!hhmm) return '';
  const [h, m] = String(hhmm).split(':').map(Number);
  if (Number.isNaN(h)) return String(hhmm);
  const am = h < 12;
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${am ? 'AM' : 'PM'}`;
}
function _timeRange(t, end) {
  if (!t) return '';
  return end ? `${_fmtHM(t)} – ${_fmtHM(end)}` : _fmtHM(t);
}
function _dot(parts) {
  return parts.filter(Boolean).map(esc).join(' · ');
}
function _avatarsHtml(avatars) {
  return `<span class="pl-avatars">${avatars
    .map((a) => `<span class="pl-avatar" title="${esc(a.name)}">${esc(a.initial)}</span>`)
    .join('')}</span>`;
}
// One label/value row. `value` is pre-built HTML (caller escapes); empty ⇒ dropped.
function _ivRow(label, value, icon) {
  if (!value) return '';
  return `<div class="iv-row"><span class="iv-label">${icon ? `<i class="${icon}" aria-hidden="true"></i>` : ''}${esc(label)}</span><span class="iv-value">${value}</span></div>`;
}

// Resolve an agenda-row payload into a normalised detail descriptor, or null.
function resolveItineraryDetail(p) {
  const personal = state.planner?.personal || {};
  const tz = getTimezone();

  if (p.type === 'item') {
    const it = (personal.itinerary || []).find((x) => x.id === p.id);
    if (!it) return null;
    const av = personalAssigneeChips(it.memberIds || []);
    return {
      eyebrow: 'Your plan',
      icon: 'fas fa-calendar-check',
      title: it.title || 'Itinerary item',
      rows: [
        _ivRow('Date', esc(_fmtNiceDate(it.date)), 'fas fa-calendar-day'),
        _ivRow('Time', it.time ? esc(_timeRange(it.time, it.endTime)) : 'All day', 'fas fa-clock'),
        _ivRow('Where', esc(it.location || ''), 'fas fa-location-dot'),
        _ivRow('Who', av.length ? _avatarsHtml(av) : '', 'fas fa-user-group'),
      ],
      notes: it.notes || '',
      coords: parseLatLon(it.coords),
      calEvent: itineraryItemToCalEvent(it, { timezone: tz }),
      edit: () => openPersonalItineraryItemModal(it.id, it.date),
      editLabel: 'Edit plan',
      remove: () => _removePersonalItemById(it.id),
      removeLabel: 'Remove plan',
    };
  }

  if (p.type === 'travel') {
    const list =
      p.legDir === 'return'
        ? personal.returnLegs
        : p.legDir === 'local'
          ? personal.localLegs
          : personal.outboundLegs;
    const leg = (list || []).find((l) => l.id === p.legId);
    if (!leg) return null;
    const dirLabel =
      p.legDir === 'return'
        ? 'Return travel'
        : p.legDir === 'local'
          ? 'Getting around'
          : 'Outbound travel';
    const modeLabel = (TRAVEL_MODES[leg.mode]?.label || leg.mode || 'Travel').replace(/^\S+\s/, '');
    const route = [leg.from, leg.to].filter(Boolean).join(' → ');
    return {
      eyebrow: dirLabel,
      icon: travelIcon(leg.mode || 'flight', p.legDir === 'return'),
      title: route || modeLabel,
      rows: [
        _ivRow('Mode', esc(modeLabel), 'fas fa-route'),
        _ivRow(
          'Depart',
          _dot([_fmtNiceDate(leg.date), _fmtHM(leg.departTime)]),
          'fas fa-plane-departure',
        ),
        _ivRow(
          'Arrive',
          _dot([_fmtNiceDate(leg.arriveDate || ''), _fmtHM(leg.arriveTime)]),
          'fas fa-location-dot',
        ),
        _ivRow('Ref', esc(leg.ref || ''), 'fas fa-hashtag'),
        _ivRow('Booking', esc(leg.confirmation || ''), 'fas fa-ticket'),
        _ivRow('Status', esc(leg.status || ''), 'fas fa-circle-info'),
      ],
      notes: leg.notes || '',
      coords: null,
      calEvent: legToCalEvent(leg, { direction: p.legDir }),
      edit: () => openPersonalLegModal(p.legDir, leg.id),
      editLabel: 'Edit leg',
      remove: () => _removePersonalLegById(leg.id, p.legDir),
      removeLabel: 'Remove leg',
    };
  }

  if (p.type === 'accom') {
    const a = (personal.accommodations || []).find((x) => x.id === p.accomId);
    if (!a) return null;
    const meStay = (a.assignments || []).find((s) => s.memberId === '__me__');
    const checkIn = meStay?.checkIn || a.checkIn;
    const checkOut = meStay?.checkOut || a.checkOut;
    return {
      eyebrow: 'Stay',
      icon: 'fas fa-bed',
      title: a.name || 'Accommodation',
      rows: [
        _ivRow('Check-in', esc(_fmtNiceDate(checkIn)), 'fas fa-right-to-bracket'),
        _ivRow('Check-out', esc(_fmtNiceDate(checkOut)), 'fas fa-right-from-bracket'),
        _ivRow('Address', esc(a.address || ''), 'fas fa-location-dot'),
        _ivRow('Booking', esc(a.confirmation || ''), 'fas fa-ticket'),
      ],
      notes: a.notes || '',
      coords: parseLatLon(a.coords),
      calEvent: accommodationToCalEvent({
        name: a.name,
        checkIn,
        checkOut,
        location: a.address,
      }),
      edit: () => openPersonalAccomModal(a.id),
      editLabel: 'Edit stay',
      remove: () => _removePersonalAccomById(a.id),
      removeLabel: 'Remove stay',
    };
  }

  if (p.type === 'session') {
    const s = (state.allSessions || []).find((x) => x.id === p.sessionId);
    if (!s) return null;
    const track = Array.isArray(s.track) ? s.track.join(', ') : s.track || '';
    const when = s.startTime
      ? new Date(s.startTime).toLocaleString(undefined, {
          timeZone: tz,
          weekday: 'short',
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
        })
      : '';
    return {
      eyebrow: 'Session',
      icon: 'fas fa-microphone-lines',
      title: s.title || 'Session',
      rows: [
        _ivRow('When', esc(when), 'fas fa-clock'),
        _ivRow('Where', esc(s.location || ''), 'fas fa-location-dot'),
        _ivRow('Track', esc(track), 'fas fa-layer-group'),
      ],
      notes: s.description || s.abstract || '',
      coords: null,
      calEvent: null,
      edit: null,
    };
  }

  if (p.type === 'ticket') {
    const t = (personal.tickets || []).find((x) => x.id === p.ticketId);
    if (!t) return null;
    const days = (t.days || []).map((d) => _fmtNiceDate(d)).join(', ');
    return {
      eyebrow: 'Ticket',
      icon: 'fas fa-ticket',
      title: t.name || 'Ticket',
      rows: [
        _ivRow('Status', esc(t.status || ''), 'fas fa-circle-info'),
        _ivRow('Valid', esc(days), 'fas fa-calendar-day'),
      ],
      notes: t.notes || '',
      coords: null,
      calEvent: null,
      edit: () => setActiveTab('tickets'),
      editLabel: 'Open in Tickets',
    };
  }

  if (p.type === 'hosted') {
    const he = (personal.hostedEvents || []).find((x) => x.id === p.id);
    if (!he) return null;
    const av = personalAssigneeChips(he.memberIds || []);
    return {
      eyebrow: 'Hosted event',
      icon: 'fas fa-bullhorn',
      title: he.title || 'Hosted event',
      rows: [
        _ivRow('Date', esc(_fmtNiceDate(he.date)), 'fas fa-calendar-day'),
        _ivRow('Time', he.time ? esc(_timeRange(he.time, he.endTime)) : 'All day', 'fas fa-clock'),
        _ivRow('Where', esc(he.location || ''), 'fas fa-location-dot'),
        _ivRow('Alongside', esc(he.anchorTitle || ''), 'fas fa-diagram-project'),
        _ivRow('Who', av.length ? _avatarsHtml(av) : '', 'fas fa-user-group'),
        _ivRow('Guests', esc(he.guests || ''), 'fas fa-user-tag'),
      ],
      notes: he.description || '',
      coords: null,
      calEvent: itineraryItemToCalEvent(
        {
          title: he.title,
          date: he.date,
          time: he.time,
          endTime: he.endTime,
          location: he.location,
          notes: he.description,
        },
        { timezone: tz },
      ),
      edit: () => setActiveTab('schedule'),
      editLabel: 'Edit on My Schedule',
    };
  }

  return null;
}

function renderIvMap(coords) {
  loadLeaflet(() => {
    const L = window.L;
    const el = document.getElementById('ivMap');
    if (!L || !el) return;
    if (_ivMap) {
      _ivMap.remove();
      _ivMap = null;
    }
    // `keyboard:false` drops the container's tabindex so it can't take focus (which
    // otherwise paints a blue focus outline around the map in real browsers).
    _ivMap = L.map(el, {
      zoomControl: false,
      attributionControl: false,
      scrollWheelZoom: false,
      keyboard: false,
    });
    // The same muted CartoDB basemap the Map tab uses (theme-aware) — raw OSM
    // tiles render motorways in bold blue, which clashed with the design.
    const slug = document.body.classList.contains('theme-dark') ? 'dark_all' : 'light_all';
    L.tileLayer(`https://{s}.basemaps.cartocdn.com/${slug}/{z}/{x}/{y}{r}.png`, {
      subdomains: 'abcd',
      maxZoom: 19,
    }).addTo(_ivMap);
    _ivMap.setView(coords, 15);
    // A gold ring marker — no external icon image, on-brand. `interactive:false`
    // stops it drawing a blue focus outline on the SVG path when clicked.
    L.circleMarker(coords, {
      radius: 8,
      color: '#b06f12',
      weight: 3,
      fillColor: '#e2ac57',
      fillOpacity: 0.85,
      interactive: false,
    }).addTo(_ivMap);
    // The map div was hidden until now — recompute its size once laid out.
    setTimeout(() => _ivMap && _ivMap.invalidateSize(), 80);
  });
}

function closeItineraryView() {
  hideModal('itineraryViewModal');
  if (_ivMap) {
    _ivMap.remove();
    _ivMap = null;
  }
}

// ── Remove-from-detail-modal helpers ──────────────────────────────────────────
// Each mutates personal state, saves, re-renders the whole personal tab, and
// offers an Undo — matching the app's established delete-safety idiom.
function _removePersonalLegById(legId, legDir) {
  const personal = state.planner?.personal;
  if (!personal) return;
  const key =
    legDir === 'return' ? 'returnLegs' : legDir === 'local' ? 'localLegs' : 'outboundLegs';
  const list = personal[key] || [];
  const snapshot = list.find((l) => l.id === legId);
  personal[key] = list.filter((l) => l.id !== legId);
  scheduleAutoSave();
  renderPersonalTab();
  if (snapshot)
    showUndoToast(snapshot.from ? `${snapshot.from}→${snapshot.to}` : 'Travel leg', () => {
      const p = state.planner.personal;
      p[key] = [...(p[key] || []), snapshot];
      scheduleAutoSave();
      renderPersonalTab();
    });
}
function _removePersonalAccomById(accomId) {
  const personal = state.planner?.personal;
  if (!personal) return;
  const list = personal.accommodations || [];
  const snapshot = list.find((a) => a.id === accomId);
  personal.accommodations = list.filter((a) => a.id !== accomId);
  scheduleAutoSave();
  renderPersonalTab();
  if (snapshot)
    showUndoToast(snapshot.name || 'Accommodation', () => {
      const p = state.planner.personal;
      p.accommodations = [...(p.accommodations || []), snapshot];
      scheduleAutoSave();
      renderPersonalTab();
    });
}
function _removePersonalItemById(itemId) {
  const personal = state.planner?.personal;
  if (!personal) return;
  const list = personal.itinerary || [];
  const snapshot = list.find((i) => i.id === itemId);
  personal.itinerary = list.filter((i) => i.id !== itemId);
  scheduleAutoSave();
  renderPersonalTab();
  if (snapshot)
    showUndoToast(snapshot.title || 'Item', () => {
      const p = state.planner.personal;
      p.itinerary = [...(p.itinerary || []), snapshot];
      scheduleAutoSave();
      renderPersonalTab();
    });
}

function openItineraryDetail(payload) {
  const d = resolveItineraryDetail(payload);
  const modal = document.getElementById('itineraryViewModal');
  if (!d || !modal) return;

  document.getElementById('ivBadge').innerHTML =
    `<i class="${esc(d.icon)}" aria-hidden="true"></i>`;
  document.getElementById('ivEyebrow').textContent = d.eyebrow;
  document.getElementById('ivTitle').textContent = d.title;
  document.getElementById('ivDetails').innerHTML = d.rows.filter(Boolean).join('');

  const notesEl = document.getElementById('ivNotes');
  if (d.notes) {
    notesEl.innerHTML = `<span class="iv-notes-label">Notes</span><span class="iv-notes-body">${esc(d.notes).replace(/\n/g, '<br>')}</span>`;
    notesEl.classList.remove('hidden');
  } else {
    notesEl.classList.add('hidden');
  }

  const calBtn = document.getElementById('ivCalBtn');
  if (d.calEvent) {
    calBtn.classList.remove('hidden');
    calBtn.onclick = () =>
      openCalendarMenu(calBtn, d.calEvent, {
        id: payload.id || payload.legId || payload.accomId || 'entry',
        filenameBase: d.calEvent.title,
      });
  } else {
    calBtn.classList.add('hidden');
    calBtn.onclick = null;
  }

  const editBtn = document.getElementById('ivEditBtn');
  if (d.edit) {
    editBtn.classList.remove('hidden');
    document.getElementById('ivEditLabel').textContent = d.editLabel || 'Edit';
    editBtn.onclick = () => {
      closeItineraryView();
      d.edit();
    };
  } else {
    editBtn.classList.add('hidden');
    editBtn.onclick = null;
  }

  // Remove: a two-step inline confirm (click → "Confirm remove?" → click) so a
  // destructive action can't fire on a single stray tap, then delete + Undo toast.
  const removeBtn = document.getElementById('ivRemoveBtn');
  const removeLabel = document.getElementById('ivRemoveLabel');
  clearTimeout(_ivArmTimer);
  removeBtn.classList.remove('is-armed');
  if (d.remove) {
    removeBtn.classList.remove('hidden');
    if (removeLabel) removeLabel.textContent = d.removeLabel || 'Remove';
    removeBtn.onclick = () => {
      if (!removeBtn.classList.contains('is-armed')) {
        removeBtn.classList.add('is-armed');
        if (removeLabel) removeLabel.textContent = 'Confirm remove?';
        _ivArmTimer = setTimeout(() => {
          removeBtn.classList.remove('is-armed');
          if (removeLabel) removeLabel.textContent = d.removeLabel || 'Remove';
        }, 3500);
        return;
      }
      clearTimeout(_ivArmTimer);
      closeItineraryView();
      d.remove();
    };
  } else {
    removeBtn.classList.add('hidden');
    removeBtn.onclick = null;
  }

  const mapWrap = document.getElementById('ivMapWrap');
  if (d.coords) {
    mapWrap.classList.remove('hidden');
    renderIvMap(d.coords);
  } else {
    mapWrap.classList.add('hidden');
    if (_ivMap) {
      _ivMap.remove();
      _ivMap = null;
    }
  }

  showModal('itineraryViewModal');
}

export function wireItineraryPanel() {
  // Register the itinerary-like surfaces so the shared toggle handler can re-render
  // the right one (renderPersonalItineraryTab is injected; renderOrgItinerary local).
  registerViewSurface('itinerary', renderPersonalItineraryTab);
  registerViewSurface('org', renderOrgItinerary);

  // Subscribe opens the trip's calendar-feed surface — the same modal the
  // Actions menu reaches, so there is one place that mints and lists feeds
  // rather than two that can disagree. Wired before the modal guard below,
  // which returns early on surfaces that have no day modal.
  document
    .getElementById('itinerarySubscribeBtn')
    ?.addEventListener('click', () => _openCalendarExportModal?.());

  // Modal wiring (shared by personal tab itinerary)
  const modal = document.getElementById('itineraryDayModal');
  if (!modal) return;

  function getModalCtx() {
    return { memberId: modal.dataset.memberId, date: modal.dataset.date };
  }

  document.getElementById('addItineraryItemBtn')?.addEventListener('click', () => {
    const form = document.getElementById('itineraryAddForm');
    if (form) {
      form.classList.remove('hidden');
      document.getElementById('itineraryFormTitle')?.focus();
    }
    _resetItineraryForm();
  });

  document.getElementById('itineraryFormCancel')?.addEventListener('click', () => {
    document.getElementById('itineraryAddForm')?.classList.add('hidden');
  });

  function _readItineraryBudgetFields() {
    return {
      budget: document.getElementById('itineraryFormBudget')?.value || '',
      actual: document.getElementById('itineraryFormActual')?.value || '',
      purchaseDate: document.getElementById('itineraryFormPurchaseDate')?.value || '',
      currency: document.getElementById('itineraryFormCurrency')?.value || 'AUD',
    };
  }

  function _applyItineraryBudgetFields(item) {
    const f = _readItineraryBudgetFields();
    item.budget = f.budget;
    item.actual = f.actual;
    item.purchaseDate = f.purchaseDate;
    item.currency = f.currency;
  }

  document.getElementById('itineraryFormSave')?.addEventListener('click', () => {
    const titleEl = document.getElementById('itineraryFormTitle');
    const title = titleEl?.value.trim();
    if (!title) {
      titleEl?.focus();
      return;
    }

    const ctx = modal.dataset.ctx;
    const isPersonal = ctx === 'personal';
    const isOrg = ctx === 'org';

    // Determine member + date depending on mode
    let memberId = '',
      date = '';
    if (isOrg) {
      date = document.getElementById('itineraryOrgDate')?.value || '';
      if (!date) {
        document.getElementById('itineraryOrgDate')?.focus();
        return;
      }
    } else {
      const memberRow = document.getElementById('itineraryFormMemberRow');
      const isStandalone = !memberRow?.classList.contains('hidden');
      const dateRowVisible = !document
        .getElementById('itineraryOrgDateRow')
        ?.classList.contains('hidden');
      if (isStandalone) {
        memberId = document.getElementById('itineraryFormMember')?.value || '';
        date = document.getElementById('itineraryFormDate')?.value || '';
        if (!memberId) {
          document.getElementById('itineraryFormMember')?.focus();
          return;
        }
        if (!date) {
          document.getElementById('itineraryFormDate')?.focus();
          return;
        }
      } else if (dateRowVisible) {
        // Personal add with an explicit date (from the empty state / tab button)
        date = document.getElementById('itineraryOrgDate')?.value || '';
        if (!date) {
          document.getElementById('itineraryOrgDate')?.focus();
          return;
        }
        memberId = '';
      } else {
        const c = getModalCtx();
        memberId = c.memberId;
        date = c.date;
      }
    }

    const targetArr = isPersonal
      ? (state.planner.personal.itinerary ??= [])
      : isOrg
        ? (state.planner.org.itinerary ??= [])
        : (state.planner.org.memberItinerary ??= []);

    const editId = document.getElementById('itineraryFormEditId')?.value || '';
    if (editId) {
      const item = targetArr.find((i) => i.id === editId);
      if (item) {
        item.title = title;
        item.time = document.getElementById('itineraryFormTime').value;
        item.location = document.getElementById('itineraryFormLocation').value;
        item.notes = document.getElementById('itineraryFormNotes').value;
        if (isOrg) item.date = date;
        _applyItineraryBudgetFields(item);
      }
    } else {
      const item = makeItineraryItem(isPersonal || isOrg ? null : memberId, date);
      item.title = title;
      item.time = document.getElementById('itineraryFormTime').value;
      item.location = document.getElementById('itineraryFormLocation').value;
      item.notes = document.getElementById('itineraryFormNotes').value;
      _applyItineraryBudgetFields(item);
      targetArr.push(item);
    }
    document.getElementById('itineraryAddForm')?.classList.add('hidden');
    // One-off adds (org, member-standalone, or personal add-with-date) close the
    // modal; the per-day manager stays open and just refreshes its item list.
    const memberStandalone = !document
      .getElementById('itineraryFormMemberRow')
      ?.classList.contains('hidden');
    const personalDateAdd =
      isPersonal && !document.getElementById('itineraryOrgDateRow')?.classList.contains('hidden');
    if (isOrg || memberStandalone || personalDateAdd) {
      closeItineraryDayModal();
    } else {
      renderItineraryDayItems(isPersonal ? '' : memberId, date);
    }
    scheduleAutoSave();
    if (state.activeTab === 'summary') renderSummaryTab();
  });

  // Item done / edit / delete
  modal.addEventListener('change', (e) => {
    if (e.target.classList.contains('itinerary-done-check')) {
      const id = e.target.dataset.itemId;
      const isPersonal = modal.dataset.ctx === 'personal';
      const pool = isPersonal
        ? state.planner.personal?.itinerary || []
        : state.planner.org.memberItinerary || [];
      const item = pool.find((i) => i.id === id);
      if (item) {
        item.done = e.target.checked;
        renderItineraryDayItems(isPersonal ? '' : modal.dataset.memberId, modal.dataset.date);
        scheduleAutoSave();
      }
    }
  });

  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeItineraryDayModal();
      return;
    }

    if (e.target.closest('#itineraryFormCreateReceiptBtn')) {
      createReceiptForOrgEvent();
      return;
    }
    if (e.target.closest('#itineraryFormViewReceiptBtn')) {
      const item = _currentOrgEvent();
      closeItineraryDayModal();
      setActiveTab?.('receipts');
      setTimeout(() => {
        const el = item?.receiptId
          ? document.querySelector(`details[data-receipt-id="${item.receiptId}"]`)
          : null;
        el?.setAttribute('open', '');
        el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 50);
      return;
    }
    if (e.target.closest('#itineraryFormUnlinkReceiptBtn')) {
      const item = _currentOrgEvent();
      if (item) {
        unlinkEntityReceipt(item);
        scheduleAutoSave();
        renderOrgEventReceiptStatus(item);
      }
      return;
    }

    const calBtn = e.target.closest('.itinerary-cal-btn');
    if (calBtn) {
      const id = calBtn.dataset.itemId;
      const isPersonal = modal.dataset.ctx === 'personal';
      const pool = isPersonal
        ? state.planner.personal?.itinerary || []
        : state.planner.org.memberItinerary || [];
      const item = pool.find((i) => i.id === id);
      const calEvent = itineraryItemToCalEvent(item, { timezone: getTimezone() });
      if (calEvent) openCalendarMenu(calBtn, calEvent, { id, filenameBase: calEvent.title });
      return;
    }

    const editBtn = e.target.closest('.itinerary-edit-btn');
    if (editBtn) {
      const id = editBtn.dataset.itemId;
      const isPersonal = modal.dataset.ctx === 'personal';
      const pool = isPersonal
        ? state.planner.personal?.itinerary || []
        : state.planner.org.memberItinerary || [];
      const item = pool.find((i) => i.id === id);
      if (!item) return;
      const form = els().addForm;
      if (form) form.classList.remove('hidden');
      fillItineraryForm(item);
      els().title?.focus();
      return;
    }

    const delBtn = e.target.closest('.itinerary-delete-btn');
    if (delBtn) {
      const id = delBtn.dataset.itemId;
      const isPersonal = modal.dataset.ctx === 'personal';
      const list = isPersonal
        ? state.planner.personal.itinerary || []
        : state.planner.org.memberItinerary || [];
      const snapshot = list.find((i) => i.id === id);
      if (isPersonal) {
        state.planner.personal.itinerary = (state.planner.personal.itinerary || []).filter(
          (i) => i.id !== id,
        );
      } else {
        state.planner.org.memberItinerary = (state.planner.org.memberItinerary || []).filter(
          (i) => i.id !== id,
        );
      }
      renderItineraryDayItems(isPersonal ? '' : modal.dataset.memberId, modal.dataset.date);
      scheduleAutoSave();
      if (state.activeTab === 'summary') renderSummaryTab();
      if (snapshot)
        showUndoToast(snapshot.title || 'Itinerary item', () => {
          if (isPersonal)
            state.planner.personal.itinerary = [
              ...(state.planner.personal.itinerary || []),
              snapshot,
            ];
          else
            state.planner.org.memberItinerary = [
              ...(state.planner.org.memberItinerary || []),
              snapshot,
            ];
          renderItineraryDayItems(isPersonal ? '' : modal.dataset.memberId, modal.dataset.date);
          scheduleAutoSave();
        });
      return;
    }
  });

  document
    .getElementById('itineraryDayModalClose')
    ?.addEventListener('click', closeItineraryDayModal);
  document
    .getElementById('itineraryDayModalDone')
    ?.addEventListener('click', closeItineraryDayModal);

  // Vertical day agenda CRUD entry points. Delegated at document level so it
  // covers both places the agenda renders: the Itinerary tab (#itineraryDayList)
  // and the mobile overview (#personalTimelineAgenda). A per-day "+" and tapping
  // an item row both open the day manager; the empty-state button adds fresh.
  document.addEventListener('click', (e) => {
    // Add-to-calendar on an agenda item row — checked before the row handler so
    // it doesn't also open the item editor.
    const calItem = e.target.closest('.agenda-item-cal-btn');
    if (calItem) {
      e.stopPropagation();
      const id = calItem.dataset.agendaItemId;
      const item = (state.planner.personal?.itinerary || []).find((i) => i.id === id);
      const calEvent = itineraryItemToCalEvent(item, { timezone: getTimezone() });
      if (calEvent) openCalendarMenu(calItem, calEvent, { id, filenameBase: calEvent.title });
      return;
    }
    // Add-to-calendar on a travel-leg row (outbound / return / getting-around).
    const calLeg = e.target.closest('.agenda-leg-cal-btn');
    if (calLeg) {
      e.stopPropagation();
      const { legId, legDir } = calLeg.dataset;
      const personal = state.planner.personal || {};
      const list =
        legDir === 'return'
          ? personal.returnLegs || []
          : legDir === 'local'
            ? personal.localLegs || []
            : personal.outboundLegs || [];
      const leg = list.find((l) => l.id === legId);
      const calEvent = leg && legToCalEvent(leg, { direction: legDir });
      if (calEvent) openCalendarMenu(calLeg, calEvent, { id: legId, filenameBase: calEvent.title });
      return;
    }
    const addDay = e.target.closest('.agenda-day-add');
    if (addDay) {
      openPersonalItineraryItemModal(null, addDay.dataset.agendaDay);
      return;
    }
    // View-mode toggle (List / Calendar) — persist per-surface, then re-render via
    // the registered surface renderer (works for every itinerary-like surface).
    const seg = e.target.closest('.pl-viewseg[data-view-mode]');
    if (seg) {
      setViewMode(seg.dataset.viewSurface, seg.dataset.viewMode);
      rerenderViewSurface(seg.dataset.viewSurface);
      return;
    }
    // Any moment row / list card / calendar chip opens its read-only detail view
    // (Edit + Remove + Add-to-calendar live inside the modal, not on the row).
    const viewRow = e.target.closest(
      '.jrn-moment[data-view-type], .pl-open[data-view-type], .cal-ev[data-view-type]',
    );
    if (viewRow) {
      const ds = viewRow.dataset;
      openItineraryDetail({
        type: ds.viewType,
        id: ds.viewId,
        day: ds.viewDay,
        legId: ds.viewLegId,
        legDir: ds.viewLegDir,
        accomId: ds.viewAccomId,
        sessionId: ds.viewSessionId,
        ticketId: ds.viewTicketId,
      });
      return;
    }
    const addItem = e.target.closest('.agenda-add-item');
    if (addItem) {
      openPersonalItineraryItemModal();
      return;
    }
  });

  // Itinerary detail (view) modal — close via ×, backdrop, or Escape.
  document.getElementById('ivClose')?.addEventListener('click', closeItineraryView);
  document.getElementById('itineraryViewModal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeItineraryView();
  });
  document.addEventListener('keydown', (e) => {
    const vm = document.getElementById('itineraryViewModal');
    if (e.key === 'Escape' && vm && !vm.classList.contains('hidden')) closeItineraryView();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal && !modal.classList.contains('hidden'))
      closeItineraryDayModal();
  });
}

// Static shell for this tab panel — injected into #plannerItineraryPanel at boot (#7 co-location).
export function itineraryPanelHtml() {
  return `
          <section>
            <div class="pln-section__head">
              <div>
                <p class="pln-eyebrow">Day by day</p>
                <h2 class="pln-section__title">Itinerary</h2>
              </div>
              <div class="pln-section__actions">
                <!-- In the HEAD, not in #itineraryDayList: that div is replaced
                     wholesale when the List/Calendar toggle flips, so anything
                     inside it exists in one view only. Subscribe belongs to the
                     itinerary itself, so it lives with the heading and is
                     present in both views by construction. -->
                <button type="button" id="itinerarySubscribeBtn" class="pl-add-btn pl-add-btn--quiet">Subscribe</button>
                <button type="button" class="agenda-add-item pl-add-btn">Add item</button>
              </div>
            </div>
            <div id="itineraryDayList"></div>
          </section>
        `;
}
