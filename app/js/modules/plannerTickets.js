// Tickets tab for the planner — conference-ticket records (personal + org/team
// contexts), the add/edit modal, and status badges. Extracted from planner.js
// via the plannerReceipts contract: planner-internal collaborators are supplied
// once via initTickets(); shared field/format + storage/modal helpers are
// imported directly.

import { escapeHtml as esc } from './utils.js';
import { showModal, hideModal } from './modal.js';
import { makeItemId } from './plannerStorage.js';
import { buildSelectOptions, parseBudget, formatAmount } from './plannerFields.js';
import { conferenceSpanDays } from './plannerConferenceBand.js';
import {
  renderEntityReceiptStatus,
  createReceiptForEntity,
  unlinkEntityReceipt,
  linkedReceipt,
} from './plannerEntityReceipt.js';

// ── Injected planner collaborators ────────────────────────────────────────────
let state;
let scheduleAutoSave;
let renderSummaryTab;
let renderReceiptsTab;
let setActiveTab;
let getMeLabel;
let openReceiptModal;

export function initTickets(deps) {
  ({
    state,
    scheduleAutoSave,
    renderSummaryTab,
    renderReceiptsTab,
    setActiveTab,
    getMeLabel,
    openReceiptModal,
  } = deps);
}

const TICKET_STATUSES = [
  { value: 'planned', label: 'Planned' },
  { value: 'pending-purchase', label: 'Pending Purchase' },
  { value: 'purchased', label: 'Purchased' },
  { value: 'assigned', label: 'Assigned' },
  { value: 'cancelled', label: 'Cancelled' },
];

const TICKET_STATUS_CLASSES = {
  planned: 'bg-gray-100 text-gray-600',
  'pending-purchase': 'bg-yellow-100 text-yellow-700',
  purchased: 'bg-blue-100 text-blue-700',
  assigned: 'bg-emerald-100 text-emerald-700',
  cancelled: 'bg-red-100 text-red-700',
};

let _ticketCtx = null;
let _ticketId = null;

function getTicketList(ctx) {
  if (ctx === 'personal') return (state.planner.personal.tickets ??= []);
  return (state.planner.org.tickets ??= []);
}

export function ticketStatusBadge(status) {
  if (!status) return '';
  const entry = TICKET_STATUSES.find((s) => s.value === status);
  if (!entry) return '';
  const cls = TICKET_STATUS_CLASSES[status] || 'bg-gray-100 text-gray-600';
  return `<span class="text-[0.6rem] px-1.5 py-px rounded-full font-medium flex-shrink-0 ${cls}">${esc(entry.label)}</span>`;
}

function _ticketPeopleForCtx(ctx) {
  if (ctx === 'personal') {
    const meContactId = state.planner.personal?.meContactId || null;
    const contacts = (state.global?.personalContacts || []).filter((c) => c.id !== meContactId);
    const locals = (state.planner.personal?.localCompanions || []).filter(
      (lc) => lc.id !== meContactId,
    );
    return [
      { id: '__me__', name: getMeLabel() },
      ...contacts.map((c) => ({ id: c.id, name: c.name || 'Unnamed' })),
      ...locals.map((lc) => ({ id: lc.id, name: `${lc.name || 'Unnamed'} (this trip)` })),
    ];
  }
  return (state.global?.teamMembers || []).map((m) => ({ id: m.id, name: m.name || 'Unnamed' }));
}

function _resolvePerson(id, ctx) {
  if (!id) return null;
  if (id === '__me__' && ctx === 'personal') return { name: getMeLabel() };
  if (ctx === 'personal') {
    const c = (state.global?.personalContacts || []).find((x) => x.id === id);
    if (c) return { name: c.name || 'Unnamed' };
    const lc = (state.planner.personal?.localCompanions || []).find((x) => x.id === id);
    return lc ? { name: lc.name || 'Unnamed' } : null;
  }
  const m = (state.global?.teamMembers || []).find((x) => x.id === id);
  return m ? { name: m.name || 'Unnamed' } : null;
}

export function renderTicketsTab() {
  const mode = state.planner?.mode || 'personal';
  const ctx = mode === 'sponsor' ? 'org' : 'personal';
  const container = document.getElementById('ticketsList');
  const empty = document.getElementById('ticketsEmptyState');
  const addBtn = document.getElementById('addTicketBtn');
  if (!container) return;

  const tickets = getTicketList(ctx);

  if (addBtn) {
    addBtn.dataset.ticketCtx = ctx;
  }

  if (!tickets.length) {
    container.innerHTML = '';
    empty?.classList.remove('hidden');
    return;
  }
  empty?.classList.add('hidden');

  const fmt = (n) => formatAmount(parseBudget(n));
  const statusLabel = (s) => TICKET_STATUSES.find((x) => x.value === s)?.label || 'Planned';

  container.innerHTML = tickets
    .map((t) => {
      const assignedMember = _resolvePerson(t.assignedTo, ctx);
      const purchasedMember = _resolvePerson(t.purchasedBy, ctx);
      const qty = t.quantity || 1;
      const status = t.status || 'planned';
      // Cost now lives on the linked receipt (if any).
      const receipt = linkedReceipt(state.planner, t);
      const costLabel = receipt?.amount
        ? `${receipt.currency || 'AUD'} ${fmt(receipt.amount)}`
        : '';
      const validity = _ticketDayRange(t.days);
      const initial = assignedMember?.name?.trim()?.[0]?.toUpperCase() || '';

      return `<button type="button" class="tkt edit-ticket-btn${status === 'cancelled' ? ' tkt--cancelled' : ''}"
        data-ticket-id="${esc(t.id)}" data-ticket-ctx="${esc(ctx)}" aria-label="Edit ${esc(t.name || 'ticket')}">
      <span class="tkt-body">
        <span class="tkt-top">
          <span class="tkt-name">${esc(t.name || 'Unnamed ticket')}</span>
          <span class="tkt-status tkt-status--${esc(status)}">${esc(statusLabel(status))}</span>
        </span>
        ${
          assignedMember
            ? `<span class="tkt-holder"><span class="pl-avatar">${esc(initial)}</span><span class="tkt-holder-name">${esc(assignedMember.name)}</span></span>`
            : ''
        }
        <span class="tkt-meta">
          ${validity ? `<span><span class="tkt-meta-lbl">Valid</span>${esc(validity)}</span>` : ''}
          ${costLabel ? `<span class="tkt-cost">${esc(costLabel)}</span>` : ''}
          ${purchasedMember ? `<span><span class="tkt-meta-lbl">Paid by</span>${esc(purchasedMember.name)}</span>` : ''}
        </span>
      </span>
      <span class="tkt-stub">
        <span class="tkt-qty">×${esc(String(qty))}</span>
        <span class="tkt-admit">Admit</span>
      </span>
    </button>`;
    })
    .join('');
}

// A ticket's validity window from its selected days: "Mar 12 – Mar 14 · 3 days".
function _ticketDayRange(days) {
  const ds = (days || []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (!ds.length) return '';
  const fmtD = (s) =>
    new Date(`${s}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const uniq = new Set(ds).size;
  const range =
    ds[0] === ds[ds.length - 1] ? fmtD(ds[0]) : `${fmtD(ds[0])} – ${fmtD(ds[ds.length - 1])}`;
  return `${range} · ${uniq} day${uniq === 1 ? '' : 's'}`;
}

function openTicketModal(ctx, id = null) {
  _ticketCtx = ctx;
  _ticketId = id;
  const ticket = id ? getTicketList(ctx).find((t) => t.id === id) : null;
  const people = _ticketPeopleForCtx(ctx);
  const memberOptions =
    `<option value="">—</option>` +
    people.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');

  document.getElementById('ticketModalTitle').textContent = id ? 'Edit Ticket' : 'Add Ticket';
  document.getElementById('ticketName').value = ticket?.name || '';
  document.getElementById('ticketQuantity').value = ticket?.quantity ?? 1;
  document.getElementById('ticketNotes').value = ticket?.notes || '';

  const statusEl = document.getElementById('ticketStatus');
  if (statusEl) {
    statusEl.innerHTML = buildSelectOptions(TICKET_STATUSES, ticket?.status || 'planned');
  }

  const assignedEl = document.getElementById('ticketAssignedTo');
  if (assignedEl) {
    assignedEl.innerHTML = memberOptions;
    if (ticket?.assignedTo) assignedEl.value = ticket.assignedTo;
  }

  const purchasedEl = document.getElementById('ticketPurchasedBy');
  if (purchasedEl) {
    purchasedEl.innerHTML = memberOptions;
    if (ticket?.purchasedBy) purchasedEl.value = ticket.purchasedBy;
  }

  _populateTicketDays(ticket?.days || []);
  const showItinEl = /** @type {HTMLInputElement|null} */ (
    document.getElementById('ticketShowOnItinerary')
  );
  if (showItinEl) showItinEl.checked = !!ticket?.showOnItinerary;

  renderTicketReceiptStatus(ticket);
  document.getElementById('ticketModalDelete')?.classList.toggle('hidden', !id);
  showModal('ticketModal', 'ticketName');
}

// The Receipt block in the ticket modal — uses the shared entity-receipt mechanism.
// When a receipt is linked, the ticket's cost comes from that receipt (see
// buildPersonalBudgetData / buildEventBudgetData). A brand-new (unsaved) ticket must
// be saved first so the receipt has something to attach to.
function renderTicketReceiptStatus(ticket) {
  renderEntityReceiptStatus(document.getElementById('ticketReceiptStatus'), {
    receipt: linkedReceipt(state.planner, ticket),
    idPrefix: 'ticket',
    canLink: !!_ticketId,
    unsavedHint: 'Save this ticket first to move its cost to a receipt.',
  });
}

// Create a receipt for the ticket and open it so cost/details are entered on the
// receipt (the single home for money). Closes the ticket modal to avoid stacking.
function createReceiptForTicket() {
  if (!_ticketCtx || !_ticketId) return;
  const ticket = getTicketList(_ticketCtx).find((t) => t.id === _ticketId);
  if (!ticket) return;
  const defaultCurr =
    _ticketCtx === 'personal'
      ? state.planner.personal?.currency || 'AUD'
      : state.planner.org?.sponsorCurrency || 'AUD';
  const receipt = createReceiptForEntity(state.planner, ticket, {
    name: document.getElementById('ticketName')?.value.trim() || ticket.name || 'Ticket',
    currency: defaultCurr,
    category: 'tickets',
  });
  scheduleAutoSave();
  renderReceiptsTab?.();
  closeTicketModal();
  openReceiptModal?.(receipt.id);
}

// The chip style for a given (selected?, conference-day?) state. Amber = a
// conference day; slate = a ticketed day outside the conference.
function _chipStyle(on, isConf) {
  if (!on) return 'background:#fff;border-color:#d1d5db;color:#6b7280';
  return isConf
    ? 'background:#fef3c7;border-color:#f59e0b;color:#b45309'
    : 'background:#f1f5f9;border-color:#64748b;color:#475569';
}

// Every day of the trip (conference span ∪ leg/accommodation/itinerary dates ∪
// the ticket's own days), enumerated contiguously so a ticket can cover any day —
// not just conference days.
function _tripDaySpan(ctx, selectedDays) {
  const dates = [];
  const push = (d) => {
    const s = d && String(d).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) dates.push(s);
  };
  conferenceSpanDays(state.eventMeta).forEach((d) => dates.push(d));
  (selectedDays || []).forEach(push);
  if (ctx === 'personal') {
    const p = state.planner.personal || {};
    [...(p.outboundLegs || []), ...(p.returnLegs || [])].forEach((l) => {
      push(l.date);
      push(l.arriveDate);
    });
    (p.accommodations || []).forEach((a) => {
      push(a.checkIn);
      push(a.checkOut);
      (a.assignments || []).forEach((s) => {
        push(s.checkIn);
        push(s.checkOut);
      });
      (a.stops || []).forEach((cl) => push(cl.date));
    });
    (p.itinerary || []).forEach((it) => push(it.date));
  } else {
    const o = state.planner.org || {};
    (o.teamAssignments || []).forEach((ta) => {
      [...(ta.outboundLegs || []), ...(ta.returnLegs || [])].forEach((l) => {
        push(l.date);
        push(l.arriveDate);
      });
    });
    (o.accommodations || []).forEach((a) => {
      (a.assignments || []).forEach((s) => {
        push(s.checkIn);
        push(s.checkOut);
      });
      (a.stops || []).forEach((cl) => push(cl.date));
    });
    (o.itinerary || []).forEach((it) => push(it.date));
  }
  if (!dates.length) return [];
  dates.sort();
  const out = [];
  const cur = new Date(`${dates[0]}T00:00:00`);
  const end = new Date(`${dates[dates.length - 1]}T00:00:00`);
  let guard = 0;
  while (cur <= end && guard++ < 45) {
    const m = String(cur.getMonth() + 1).padStart(2, '0');
    const dd = String(cur.getDate()).padStart(2, '0');
    out.push(`${cur.getFullYear()}-${m}-${dd}`);
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

// Render a toggle chip per trip day; pre-select the ticket's days. Conference days
// carry an amber dot (slate otherwise) so they're distinguishable at a glance.
function _populateTicketDays(selectedDays) {
  const wrap = document.getElementById('ticketDaysWrap');
  const daysEl = document.getElementById('ticketDays');
  if (!wrap || !daysEl) return;
  const tripDays = _tripDaySpan(_ticketCtx, selectedDays);
  if (!tripDays.length) {
    wrap.classList.add('hidden');
    daysEl.innerHTML = '';
    return;
  }
  wrap.classList.remove('hidden');
  const confSet = new Set(conferenceSpanDays(state.eventMeta));
  const selected = new Set(selectedDays);
  daysEl.innerHTML = tripDays
    .map((d) => {
      const on = selected.has(d);
      const isConf = confSet.has(d);
      const label = new Date(`${d}T12:00:00`).toLocaleDateString(undefined, {
        weekday: 'short',
        day: 'numeric',
      });
      const dot = `<span style="display:inline-block;width:5px;height:5px;border-radius:50%;background:${isConf ? '#f59e0b' : '#94a3b8'};margin-right:5px;vertical-align:middle"></span>`;
      return `<button type="button" class="ticket-day-chip text-xs px-2.5 py-1 rounded-full border font-medium transition-colors" data-day="${d}" data-conf="${isConf ? '1' : '0'}" aria-pressed="${on}" style="${_chipStyle(on, isConf)}">${dot}${label}</button>`;
    })
    .join('');
}

function saveTicket() {
  if (!_ticketCtx) return;
  const list = getTicketList(_ticketCtx);
  const name = document.getElementById('ticketName')?.value.trim() || '';
  const quantity = parseInt(document.getElementById('ticketQuantity')?.value, 10) || 1;
  const status = document.getElementById('ticketStatus')?.value || 'planned';
  const assignedTo = document.getElementById('ticketAssignedTo')?.value || '';
  const purchasedBy = document.getElementById('ticketPurchasedBy')?.value || '';
  const notes = document.getElementById('ticketNotes')?.value.trim() || '';
  // Selected conference days (empty = full conference; the timeline falls back).
  const days = [
    ...document.querySelectorAll('#ticketDays .ticket-day-chip[aria-pressed="true"]'),
  ].map((b) => b.dataset.day);
  // Opt-in: standalone events (workshop, gala) can appear on the day agenda, while
  // conference passes stay off it (the conference banner already covers those days).
  const showOnItinerary = !!document.getElementById('ticketShowOnItinerary')?.checked;

  if (_ticketId) {
    const t = list.find((x) => x.id === _ticketId);
    if (t)
      Object.assign(t, {
        name,
        quantity,
        status,
        assignedTo,
        purchasedBy,
        notes,
        days,
        showOnItinerary,
      });
  } else {
    const newTicket = {
      id: makeItemId('tk'),
      name,
      quantity,
      status,
      assignedTo,
      purchasedBy,
      notes,
      days,
      showOnItinerary,
      receiptId: '',
    };
    list.push(newTicket);
    _ticketId = newTicket.id;
  }
  scheduleAutoSave();
}

function closeTicketModal() {
  const ctx = _ticketCtx;
  _ticketCtx = null;
  _ticketId = null;
  hideModal('ticketModal');
  if (ctx) renderTicketsTab();
  if (state.activeTab === 'summary') renderSummaryTab();
}

export function wireTicketsPanel() {
  const panel = document.getElementById('plannerTicketsPanel');
  if (!panel) return;

  document.getElementById('addTicketBtn')?.addEventListener('click', (e) => {
    const ctx =
      e.currentTarget.dataset.ticketCtx || (state.planner?.mode === 'sponsor' ? 'org' : 'personal');
    openTicketModal(ctx);
  });

  panel.addEventListener('click', (e) => {
    const editBtn = e.target.closest('.edit-ticket-btn');
    if (editBtn) {
      openTicketModal(editBtn.dataset.ticketCtx, editBtn.dataset.ticketId);
      return;
    }
  });

  // Toggle a trip-day chip in the ticket modal.
  document.getElementById('ticketDays')?.addEventListener('click', (e) => {
    const chip = e.target.closest('.ticket-day-chip');
    if (!chip) return;
    const on = chip.getAttribute('aria-pressed') !== 'true';
    chip.setAttribute('aria-pressed', String(on));
    chip.style.cssText = _chipStyle(on, chip.dataset.conf === '1');
  });

  const modal = document.getElementById('ticketModal');
  if (!modal) return;

  document.getElementById('ticketModalClose')?.addEventListener('click', closeTicketModal);
  document.getElementById('ticketModalDone')?.addEventListener('click', () => {
    saveTicket();
    closeTicketModal();
  });
  document.getElementById('ticketModalDelete')?.addEventListener('click', () => {
    if (!_ticketCtx || !_ticketId) return;
    const list = getTicketList(_ticketCtx);
    const idx = list.findIndex((t) => t.id === _ticketId);
    if (idx !== -1) list.splice(idx, 1);
    scheduleAutoSave();
    closeTicketModal();
  });
  modal.addEventListener('click', (e) => {
    if (e.target.closest('#ticketCreateReceiptBtn')) {
      createReceiptForTicket();
      return;
    }
    if (e.target.closest('#ticketViewReceiptBtn')) {
      const ticket =
        _ticketCtx && _ticketId ? getTicketList(_ticketCtx).find((t) => t.id === _ticketId) : null;
      closeTicketModal();
      setActiveTab?.('receipts');
      setTimeout(() => {
        const el = ticket?.receiptId
          ? document.querySelector(`details[data-receipt-id="${ticket.receiptId}"]`)
          : null;
        el?.setAttribute('open', '');
        el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 50);
      return;
    }
    if (e.target.closest('#ticketUnlinkReceiptBtn')) {
      const ticket =
        _ticketCtx && _ticketId ? getTicketList(_ticketCtx).find((t) => t.id === _ticketId) : null;
      if (ticket) {
        unlinkEntityReceipt(ticket);
        scheduleAutoSave();
        renderTicketReceiptStatus(ticket);
      }
      return;
    }
    if (e.target === modal) closeTicketModal();
  });
}

// Static shell for this tab panel — injected into #plannerTicketsPanel at boot (#7 co-location).
export function ticketsPanelHtml() {
  return `
          <section>
            <div class="pln-section__head">
              <div>
                <p class="pln-eyebrow">Who's admitted</p>
                <h2 class="pln-section__title">Tickets</h2>
              </div>
              <button id="addTicketBtn" type="button" class="pl-add-btn">Add ticket</button>
            </div>
            <div id="ticketsList" class="tkt-list"></div>
            <div id="ticketsEmptyState" class="jrn-empty">
              <p class="jrn-empty-t">No tickets yet</p>
              <p class="jrn-empty-s">Track conference passes and workshop seats — who's admitted, and for which days.</p>
            </div>
          </section>
        `;
}
