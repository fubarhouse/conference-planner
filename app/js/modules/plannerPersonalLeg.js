// Personal leg modal — the personal-trip travel-leg editor (mode/times/waypoints/
// receipt link) and its receipt-status helpers. Extracted from planner.js: the
// modal instance is built in initPersonalLeg() (after createModal is injected);
// shared helpers are imported directly.

import { buildSelectOptions } from './plannerFields.js';
import { TRAVEL_MODES, TRAVEL_STATUSES } from './plannerTravel.js';
import { renderReceiptsTab } from './plannerReceipts.js';
import {
  renderEntityReceiptStatus,
  createReceiptForEntity,
  linkEntityReceipt,
  unlinkEntityReceipt,
  linkedReceipt,
  openReceiptPicker,
} from './plannerEntityReceipt.js';
import { renderPersonalTab } from './plannerPersonal.js';

// ── Injected planner collaborators ────────────────────────────────────────────
let state;
let scheduleAutoSave;
let createModal;
let autoArriveDate;
let setActiveTab;
let _personalLegModal;

export function initPersonalLeg(deps) {
  ({ state, scheduleAutoSave, createModal, autoArriveDate, setActiveTab } = deps);
  _personalLegModal = createModal('personalLegModal', {
    onSave: savePersonalLeg,
    onDelete: () => {
      const { direction, id } = _personalLeg;
      if (!direction || !id) return;
      const personal = state.planner.personal;
      if (!personal) return;
      const list = legListFor(direction);
      const i = list.findIndex((l) => l.id === id);
      if (i !== -1) list.splice(i, 1);
      scheduleAutoSave();
    },
    onClose: () => {
      _personalLeg = { direction: null, id: null };
      renderPersonalTab();
    },
  });
}

let _personalLeg = { direction: null, id: null };

// The leg list for a direction: outbound / return / local ("getting around" —
// trains, taxis, cable cars while you're in the area).
function legListFor(direction) {
  const p = state.planner.personal;
  if (!p) return [];
  if (direction === 'return') return (p.returnLegs ??= []);
  if (direction === 'local') return (p.localLegs ??= []);
  return (p.outboundLegs ??= []);
}

function savePersonalLeg() {
  const { direction, id } = _personalLeg;
  if (!direction || !id) return;
  const personal = state.planner.personal;
  if (!personal) return;
  const legs = legListFor(direction);
  const leg = legs.find((l) => l.id === id);
  if (!leg) return;
  leg.mode = document.getElementById('personalLegModalMode')?.value || 'flight';
  leg.status = document.getElementById('personalLegModalStatus')?.value || '';
  leg.date = document.getElementById('personalLegModalDate')?.value || '';
  leg.arriveDate = document.getElementById('personalLegModalArriveDate')?.value || '';
  leg.ref = document.getElementById('personalLegModalRef')?.value || '';
  leg.from = document.getElementById('personalLegModalFrom')?.value || '';
  leg.to = document.getElementById('personalLegModalTo')?.value || '';
  leg.departTime = document.getElementById('personalLegModalDepartTime')?.value || '';
  leg.arriveTime = document.getElementById('personalLegModalArriveTime')?.value || '';
  leg.arriveTz = document.getElementById('personalLegModalArriveTz')?.value || '';
  leg.confirmation = document.getElementById('personalLegModalConfirmation')?.value || '';
  scheduleAutoSave();
}

export function openPersonalLegModal(direction, legId) {
  const legs = legListFor(direction);
  const leg = legs.find((l) => l.id === legId);
  if (!leg) return;
  _personalLeg = { direction, id: legId };
  document.getElementById('personalLegModalTitle').textContent =
    direction === 'outbound'
      ? 'Outbound Leg'
      : direction === 'return'
        ? 'Return Leg'
        : 'Local Trip';
  const modeSelect = document.getElementById('personalLegModalMode');
  if (modeSelect) {
    modeSelect.innerHTML = Object.entries(TRAVEL_MODES)
      .map(
        ([val, { label }]) =>
          `<option value="${val}"${leg.mode === val ? ' selected' : ''}>${label}</option>`,
      )
      .join('');
  }
  const statusSelect = document.getElementById('personalLegModalStatus');
  if (statusSelect) {
    statusSelect.innerHTML = buildSelectOptions(TRAVEL_STATUSES, leg.status || '');
  }
  document.getElementById('personalLegModalDate').value = leg.date || '';
  const arriveDateEl = document.getElementById('personalLegModalArriveDate');
  if (arriveDateEl) arriveDateEl.value = leg.arriveDate || '';
  document.getElementById('personalLegModalRef').value = leg.ref || '';
  document.getElementById('personalLegModalFrom').value = leg.from || '';
  document.getElementById('personalLegModalTo').value = leg.to || '';
  document.getElementById('personalLegModalDepartTime').value = leg.departTime || '';
  document.getElementById('personalLegModalArriveTime').value = leg.arriveTime || '';
  const arriveTzEl = document.getElementById('personalLegModalArriveTz');
  if (arriveTzEl) arriveTzEl.value = leg.arriveTz || '';
  document.getElementById('personalLegModalConfirmation').value = leg.confirmation || '';
  renderPersonalLegReceiptStatus(leg);
  _personalLegModal.open('personalLegModalFrom');
}

function renderPersonalLegReceiptStatus(leg) {
  renderEntityReceiptStatus(document.getElementById('personalLegReceiptStatus'), {
    receipt: linkedReceipt(state.planner, leg),
    idPrefix: 'personalLeg',
    emptyLabel: 'No receipt linked',
    showLink: true, // a leg's booking/proof lives on its linked receipt
    showAmount: false, // travel receipts are created without an amount
  });
}

function createReceiptForPersonalLeg() {
  const { direction, id } = _personalLeg;
  if (!direction || !id) return;
  const legs = legListFor(direction);
  const leg = legs?.find((l) => l.id === id);
  if (!leg) return;

  const modeLabel = TRAVEL_MODES[leg.mode]?.label.replace(/^\S+\s/, '') || leg.mode;
  const route = [leg.from, leg.to].filter(Boolean).join(' → ');
  const name = [modeLabel, route].filter(Boolean).join(route ? ': ' : '') || 'Travel receipt';

  createReceiptForEntity(state.planner, leg, {
    name,
    date: leg.date || '',
    category: 'travel',
  });

  scheduleAutoSave();
  renderPersonalLegReceiptStatus(leg);
  renderReceiptsTab();
}

export function wirePersonalLegModal() {
  _personalLegModal.wire();

  const modal = document.getElementById('personalLegModal');
  if (!modal) return;

  modal.addEventListener('click', (e) => {
    if (e.target.closest('#personalLegLinkReceiptBtn')) {
      const { direction, id } = _personalLeg;
      if (!direction || !id) return;
      const leg = legListFor(direction)?.find((l) => l.id === id);
      if (!leg) return;
      openReceiptPicker(state.planner, {
        onPick: (rid) => {
          linkEntityReceipt(leg, rid);
          scheduleAutoSave();
          renderPersonalLegReceiptStatus(leg);
          renderReceiptsTab();
        },
        onCreate: () => createReceiptForPersonalLeg(),
      });
      return;
    }
    if (e.target.closest('#personalLegCreateReceiptBtn')) {
      createReceiptForPersonalLeg();
      return;
    }
    if (e.target.closest('#personalLegViewReceiptBtn')) {
      const { direction, id } = _personalLeg;
      if (!direction || !id) return;
      const legs = legListFor(direction);
      const leg = legs?.find((l) => l.id === id);
      _personalLegModal.close();
      setActiveTab('receipts');
      setTimeout(() => {
        const el = leg?.receiptId
          ? document.querySelector(`details[data-receipt-id="${leg.receiptId}"]`)
          : null;
        el?.setAttribute('open', '');
        el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 50);
      return;
    }
    if (e.target.closest('#personalLegUnlinkReceiptBtn')) {
      const { direction, id } = _personalLeg;
      if (!direction || !id) return;
      const legs = legListFor(direction);
      const leg = legs?.find((l) => l.id === id);
      if (leg) {
        unlinkEntityReceipt(leg);
        scheduleAutoSave();
        renderPersonalLegReceiptStatus(leg);
      }
      return;
    }
  });

  ['personalLegModalDate', 'personalLegModalDepartTime', 'personalLegModalArriveTime'].forEach(
    (id) => {
      document.getElementById(id)?.addEventListener('change', () => {
        const departDate = document.getElementById('personalLegModalDate')?.value || '';
        const departTime = document.getElementById('personalLegModalDepartTime')?.value || '';
        const arriveTime = document.getElementById('personalLegModalArriveTime')?.value || '';
        const arriveDateEl = document.getElementById('personalLegModalArriveDate');
        if (arriveDateEl && !arriveDateEl.value) {
          const computed = autoArriveDate(departDate, departTime, arriveTime);
          if (computed) arriveDateEl.value = computed;
        }
        savePersonalLeg();
      });
    },
  );
}
