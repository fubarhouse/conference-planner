// Personal contacts (global) + trip assignments — the account-wide personal
// contacts, their per-trip assignment/companion cards and modals, and the
// accommodation member/stay sections. Extracted from planner.js: planner-internal
// collaborators are injected via initAssignments(); storage/modal/util helpers
// are imported directly.

import { escapeHtml as esc } from './utils.js';
import { showModal, touchDevice } from './modal.js';
import { makeItemId, saveGlobal } from './plannerStorage.js';
import { currencyOptions, getDefaultCurrency } from './plannerFields.js';
import { removeIconBtn } from './renderKit.js';
import { renderAssignmentLegsInModal } from './plannerOrg.js';
import { localCompanionCardHtml, renderCompanionsTab } from './plannerCompanions.js';

// ── Injected planner collaborators ────────────────────────────────────────────
let state;
let scheduleAutoSave;
let createModal;
let getMeLabel;

let renderAssignmentReceiptStatus;

export function initAssignments(deps) {
  ({ state, scheduleAutoSave, createModal, getMeLabel, renderAssignmentReceiptStatus } = deps);
}

export function makeTripAssignment(contactId) {
  return {
    id: makeItemId('ta'),
    memberId: contactId,
    outboundLegs: [],
    returnLegs: [],
    budget: '',
    budgetActual: '',
    purchaseDate: '',
    currency: getDefaultCurrency(),
    notes: '',
  };
}

export function renderSettingsPersonalContactsSection() {
  // Populate "Me" identity select
  const meSelect = document.getElementById('settingsMeContactId');
  if (meSelect) {
    const contacts = state.global?.personalContacts || [];
    const locals = state.planner.personal?.localCompanions || [];
    const currentMe = state.planner.personal?.meContactId || '';
    meSelect.innerHTML =
      `<option value="">Me (default)</option>` +
      contacts
        .map(
          (c) =>
            `<option value="${esc(c.id)}"${c.id === currentMe ? ' selected' : ''}>${esc(c.name || 'Unnamed')}</option>`,
        )
        .join('') +
      locals
        .map(
          (lc) =>
            `<option value="${esc(lc.id)}"${lc.id === currentMe ? ' selected' : ''}>${esc(lc.name || 'Unnamed')} (this trip)</option>`,
        )
        .join('');
  }

  const el = document.getElementById('settingsPersonalContactsList');
  if (!el) return;
  const contacts = state.global?.personalContacts || [];
  const assignedIds = new Set(
    (state.planner.personal?.tripAssignments || []).map((a) => a.memberId),
  );

  if (!contacts.length) {
    el.innerHTML = '<p class="text-sm pl-ink-2 italic">No trip contacts yet. Add one below.</p>';
    return;
  }

  el.innerHTML = contacts
    .map((c) => {
      const assigned = assignedIds.has(c.id);
      return `<div class="flex items-center gap-3 py-2 px-3 pl-bordered pl-surface">
      <label class="flex items-center gap-2 flex-shrink-0 cursor-pointer" title="${assigned ? 'Remove from this trip' : 'Add to this trip'}">
        <input type="checkbox" class="settings-personal-contact-assign h-4 w-4 rounded pl-rule pl-accent drupal-blue-focus"
          data-contact-id="${esc(c.id)}" ${assigned ? 'checked' : ''}>
      </label>
      <div class="flex-1 min-w-0">
        <p class="text-sm font-medium pl-ink-0 truncate">${esc(c.name || 'Unnamed')}</p>
        ${c.notes ? `<p class="pl-hint truncate">${esc(c.notes)}</p>` : ''}
      </div>
      <button type="button" class="edit-personal-contact-btn flex-shrink-0 h-7 px-2 border pl-rule rounded text-xs pl-ink-2 transition-colors" data-contact-id="${esc(c.id)}">
        <i class="fas fa-pen-to-square text-[0.6rem]"></i>
      </button>
    </div>`;
    })
    .join('');
}

export function openPersonalContactModal(id) {
  const modal = document.getElementById('personalContactModal');
  if (!modal) return;
  const contact = id ? (state.global?.personalContacts || []).find((c) => c.id === id) : null;
  modal.dataset.contactId = id || '';
  document.getElementById('pcName').value = contact?.name || '';
  document.getElementById('pcPhone').value = contact?.phone || '';
  document.getElementById('pcNotes').value = contact?.notes || '';
  document.getElementById('personalContactModalDelete').classList.toggle('hidden', !id);
  showModal('personalContactModal', 'pcName');
}

export function wirePersonalContactModal() {
  const modal = document.getElementById('personalContactModal');
  if (!modal) return;

  function readFields() {
    return {
      name: document.getElementById('pcName').value.trim(),
      phone: document.getElementById('pcPhone').value.trim(),
      notes: document.getElementById('pcNotes').value.trim(),
    };
  }

  createModal('personalContactModal', {
    onDone: () => {
      const id = modal.dataset.contactId;
      const fields = readFields();
      state.global.personalContacts = state.global.personalContacts || [];
      if (!id) {
        state.global.personalContacts.push({ id: makeItemId('pc'), ...fields });
      } else {
        const c = state.global.personalContacts.find((x) => x.id === id);
        if (c) Object.assign(c, fields);
      }
      saveGlobal(state.global);
    },
    onDelete: () => {
      const id = modal.dataset.contactId;
      if (!id) return;
      state.global.personalContacts = (state.global.personalContacts || []).filter(
        (c) => c.id !== id,
      );
      if (state.planner.personal) {
        state.planner.personal.tripAssignments = (
          state.planner.personal.tripAssignments || []
        ).filter((a) => a.memberId !== id);
      }
      saveGlobal(state.global);
      scheduleAutoSave();
    },
    onClose: () => {
      renderSettingsPersonalContactsSection();
      renderPersonalCompanionsSection();
      renderCompanionsTab();
    },
  }).wire();
}

export function companionCardHtml(assignment) {
  const contact = (state.global?.personalContacts || []).find((c) => c.id === assignment.memberId);
  if (!contact) return '';
  const accomNames = (state.planner.personal?.accommodations || [])
    .filter((acc) =>
      (acc.assignments || []).some(
        (a) => a.memberId === assignment.memberId && (a.checkIn || a.checkOut),
      ),
    )
    .map((acc) => acc.name || 'Unnamed')
    .join(', ');
  const outLegs = assignment.outboundLegs || [];
  const retLegs = assignment.returnLegs || [];
  const firstOut = outLegs.find((l) => l.date);
  const firstRet = retLegs.find((l) => l.date);
  const badges = [
    firstOut &&
      `<span class="inline-flex items-center text-[0.65rem] px-1.5 py-0.5 rounded pl-surface-2 pl-ink-2"><i class="fas fa-plane-departure text-[0.55rem] mr-0.5"></i>${outLegs.length > 1 ? `×${outLegs.length}` : ''}</span>`,
    firstRet &&
      `<span class="inline-flex items-center text-[0.65rem] px-1.5 py-0.5 rounded pl-surface-2 pl-ink-2"><i class="fas fa-plane-arrival text-[0.55rem] mr-0.5"></i>${retLegs.length > 1 ? `×${retLegs.length}` : ''}</span>`,
    (assignment.budget || assignment.budgetActual) &&
      `<span class="inline-flex items-center text-[0.65rem] px-1.5 py-0.5 rounded pl-surface-2 pl-ink-2"><i class="fas fa-wallet text-[0.55rem] mr-0.5"></i>${assignment.budget ? esc(assignment.budget) : ''}${assignment.budgetActual ? ` / ${esc(assignment.budgetActual)}` : ''}${assignment.currency ? ` ${esc(assignment.currency)}` : ''}</span>`,
    accomNames && `<span class="text-[0.65rem] pl-ink-2">${esc(accomNames)}</span>`,
  ]
    .filter(Boolean)
    .join('');
  const initial = (contact.name || '?')[0].toUpperCase();
  return `
    <div class="flex items-center gap-3 p-3 pl-bordered pl-surface group" data-companion-id="${esc(assignment.memberId)}">
      <div class="planner-avatar flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold pl-on-ink select-none pl-surface-ink">${esc(initial)}</div>
      <div class="flex-1 min-w-0">
        <p class="text-sm font-medium pl-ink-0">${esc(contact.name || 'Unnamed')}</p>
        <div class="flex items-center gap-2 mt-0.5 flex-wrap">${badges}</div>
      </div>
      <button type="button" class="view-companion-btn h-8 px-3 border pl-rule rounded-md pl-hint transition-colors flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity duration-150" data-person-id="${esc(assignment.memberId)}" aria-label="View ${esc(contact.name || 'companion')}">
        <i class="fas fa-eye mr-1.5 text-[0.65rem]"></i>View
      </button>
      <button type="button" class="edit-companion-btn h-8 px-3 border pl-rule rounded-md pl-hint transition-colors flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity duration-150" data-companion-id="${esc(assignment.memberId)}" aria-label="Edit travel for ${esc(contact.name || 'companion')}">
        <i class="fas fa-plane mr-1.5 text-[0.65rem]"></i>Travel
      </button>
      ${removeIconBtn({ hook: 'remove-companion-btn', data: `data-companion-id="${esc(assignment.memberId)}"`, label: `Remove ${esc(contact.name || 'companion')}`, extraClass: 'opacity-0 group-hover:opacity-100 transition-opacity duration-150' })}
    </div>`;
}

export function renderPersonalCompanionsSection() {
  const section = document.getElementById('personalCompanionsSection');
  const listEl = document.getElementById('personalCompanionsList');
  const emptyEl = document.getElementById('personalCompanionsEmpty');
  const meContactId = state.planner.personal?.meContactId || null;
  const assignments = (state.planner.personal?.tripAssignments || []).filter(
    (a) => a.memberId !== meContactId,
  );
  const locals = (state.planner.personal?.localCompanions || []).filter(
    (lc) => lc.id !== meContactId,
  );
  if (!section) return;
  section.classList.toggle('hidden', assignments.length === 0 && locals.length === 0);
  if (!listEl) return;
  listEl.innerHTML =
    assignments.map(companionCardHtml).filter(Boolean).join('') +
    locals.map(localCompanionCardHtml).join('');
  emptyEl?.classList.toggle('hidden', assignments.length > 0 || locals.length > 0);
  if (state.activeTab === 'companions') renderCompanionsTab();
}

function _setAssignmentModalImportButtons() {
  const personal = state.planner.personal;
  const hasOut = (personal?.outboundLegs || []).length > 0;
  const hasRet = (personal?.returnLegs || []).length > 0;
  document.getElementById('importOutboundFromMeBtn')?.classList.toggle('hidden', !hasOut);
  document.getElementById('importReturnFromMeBtn')?.classList.toggle('hidden', !hasRet);
}

export function _hideAssignmentModalImportButtons() {
  document.getElementById('importOutboundFromMeBtn')?.classList.add('hidden');
  document.getElementById('importReturnFromMeBtn')?.classList.add('hidden');
}

export function openTripAssignmentModal(contactId) {
  const assignModal = document.getElementById('assignmentModal');
  const contact = (state.global?.personalContacts || []).find((c) => c.id === contactId);
  if (!assignModal || !contact) return;

  const assignment = (state.planner.personal?.tripAssignments || []).find(
    (a) => a.memberId === contactId,
  );
  if (!assignment) return;

  assignment.outboundLegs = assignment.outboundLegs || [];
  assignment.returnLegs = assignment.returnLegs || [];

  assignModal.dataset.ctx = 'personal';
  assignModal.dataset.memberId = contactId;

  document.getElementById('assignmentModalSubtitle').textContent = contact.name || 'Unnamed';
  renderAssignmentLegsInModal(assignment);
  _setAssignmentModalImportButtons();

  document.getElementById('assignmentBudget').value = assignment.budget || '';
  document.getElementById('assignmentActual').value = assignment.budgetActual || '';
  const assignmentPurchaseDateEl = document.getElementById('assignmentPurchaseDate');
  if (assignmentPurchaseDateEl) assignmentPurchaseDateEl.value = assignment.purchaseDate || '';
  document.getElementById('assignmentNotes').value = assignment.notes || '';
  const currencyEl = document.getElementById('assignmentCurrency');
  if (currencyEl)
    currencyEl.innerHTML = currencyOptions(
      assignment.currency || state.planner?.personal?.currency || 'AUD',
    );

  renderAssignmentReceiptStatus?.(); // hides the receipt section (personal ctx)
  showModal('assignmentModal');
  if (!touchDevice()) assignModal.querySelector('input, select')?.focus();
}

export function openLocalCompanionAssignmentModal(lcId) {
  const assignModal = document.getElementById('assignmentModal');
  const lc = (state.planner.personal?.localCompanions || []).find((x) => x.id === lcId);
  if (!assignModal || !lc) return;
  lc.outboundLegs = lc.outboundLegs || [];
  lc.returnLegs = lc.returnLegs || [];
  assignModal.dataset.ctx = 'localCompanion';
  assignModal.dataset.memberId = lcId;
  document.getElementById('assignmentModalSubtitle').textContent =
    `${lc.name || 'Unnamed'} (this trip)`;
  renderAssignmentLegsInModal(lc);
  _setAssignmentModalImportButtons();
  document.getElementById('assignmentBudget').value = lc.budget || '';
  document.getElementById('assignmentActual').value = lc.budgetActual || '';
  const lcPurchaseDateEl = document.getElementById('assignmentPurchaseDate');
  if (lcPurchaseDateEl) lcPurchaseDateEl.value = lc.purchaseDate || '';
  document.getElementById('assignmentNotes').value = lc.notes || '';
  const currencyEl = document.getElementById('assignmentCurrency');
  if (currencyEl)
    currencyEl.innerHTML = currencyOptions(
      lc.currency || state.planner?.personal?.currency || 'AUD',
    );
  renderAssignmentReceiptStatus?.(); // hides the receipt section (local-companion ctx)
  showModal('assignmentModal');
  if (!touchDevice()) assignModal.querySelector('input, select')?.focus();
}

export function renderPersonalAccomMembersSection(acc) {
  const tripAssignments = state.planner.personal?.tripAssignments || [];
  const noCompanionsEl = document.getElementById('personalAccomNoCompanions');
  const wrapper = document.getElementById('personalAccomCompanionStaysWrapper');
  const select = document.getElementById('personalAccomCompanionSelect');
  const section = document.getElementById('personalAccomCompanionSection');

  if (!section) return;
  section.classList.remove('hidden');
  noCompanionsEl?.classList.add('hidden');
  wrapper?.classList.remove('hidden');

  const prevValue = select?.value || '';
  const assignedIds = new Set((acc.assignments || []).map((s) => s.memberId));
  const contacts = state.global?.personalContacts || [];

  if (select) {
    const meCheck = assignedIds.has('__me__') ? ' ✓' : '';
    const localCompanions = state.planner.personal?.localCompanions || [];
    const meContactId = state.planner.personal?.meContactId || null;
    const companionOptions = tripAssignments
      .filter((a) => a.memberId !== meContactId)
      .map((a) => {
        const c = contacts.find((x) => x.id === a.memberId);
        if (!c) return '';
        return `<option value="${esc(c.id)}"${prevValue === c.id ? ' selected' : ''}>${esc(c.name || 'Unnamed')}${assignedIds.has(c.id) ? ' ✓' : ''}</option>`;
      })
      .filter(Boolean)
      .join('');
    const localOptions = localCompanions
      .filter((lc) => lc.id !== meContactId)
      .map(
        (lc) =>
          `<option value="${esc(lc.id)}"${prevValue === lc.id ? ' selected' : ''}>${esc(lc.name || 'Unnamed')} (this trip)${assignedIds.has(lc.id) ? ' ✓' : ''}</option>`,
      )
      .join('');
    select.innerHTML =
      `<option value="">— Select to view or add —</option>` +
      `<option value="__me__"${prevValue === '__me__' ? ' selected' : ''}>${esc(getMeLabel())}${meCheck}</option>` +
      companionOptions +
      localOptions;
  }

  if (prevValue && select?.value === prevValue) {
    loadPersonalCompanionStayFields(acc, prevValue);
  } else {
    document.getElementById('personalAccomCompanionFields')?.classList.add('hidden');
    const removeBtn = document.getElementById('personalAccomRemoveCompanionBtn');
    if (removeBtn) removeBtn.classList.add('opacity-0', 'pointer-events-none');
  }
}

export function loadPersonalCompanionStayFields(acc, contactId) {
  const stay = (acc.assignments || []).find((s) => s.memberId === contactId) || {};
  const hasStay = !!(acc.assignments || []).find((s) => s.memberId === contactId);
  const fields = document.getElementById('personalAccomCompanionFields');
  const removeBtn = document.getElementById('personalAccomRemoveCompanionBtn');

  fields?.classList.remove('hidden');
  if (removeBtn) {
    if (hasStay) removeBtn.classList.remove('opacity-0', 'pointer-events-none');
    else removeBtn.classList.add('opacity-0', 'pointer-events-none');
  }

  const isWaypoints = acc.type === 'waypoints';
  document
    .getElementById('personalAccomCompanionCheckInRow')
    ?.classList.toggle('hidden', isWaypoints);
  document
    .getElementById('personalAccomCompanionCheckOutRow')
    ?.classList.toggle('hidden', isWaypoints);

  const checkIn = document.getElementById('personalAccomCompanionCheckIn');
  const checkOut = document.getElementById('personalAccomCompanionCheckOut');
  const currency = document.getElementById('personalAccomCompanionCurrency');
  const budget = document.getElementById('personalAccomCompanionBudget');
  const actual = document.getElementById('personalAccomCompanionActual');
  const purchaseDate = document.getElementById('personalAccomCompanionPurchaseDate');
  if (checkIn) checkIn.value = isWaypoints ? acc.checkIn || '' : stay.checkIn || acc.checkIn || '';
  if (checkOut)
    checkOut.value = isWaypoints ? acc.checkOut || '' : stay.checkOut || acc.checkOut || '';
  if (currency)
    currency.innerHTML = currencyOptions(
      stay.currency || state.planner?.personal?.currency || 'AUD',
    );
  if (budget) budget.value = stay.budget || '';
  if (actual) actual.value = stay.budgetActual || '';
  if (purchaseDate) purchaseDate.value = stay.purchaseDate || '';
}
