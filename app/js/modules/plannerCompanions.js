// Companions tab — trip-local companions (add/edit/delete + travel), rendered
// alongside the global trip-assignment companions. Extracted from planner.js:
// planner-internal collaborators (incl. the shared assignment renders/openers)
// are injected via initCompanions(); storage/modal/util helpers are imported
// directly.

import { escapeHtml as esc } from './utils.js';
import { showModal, hideModal } from './modal.js';
import { makeItemId } from './plannerStorage.js';
import { showUndoToast } from './notify.js';
import { renderPersonalAccomList } from './plannerPersonal.js';
import { openPersonDetail } from './plannerPersonDetail.js';
import { makeTripAssignment, openPersonalContactModal } from './plannerAssignments.js';

// ── Injected planner collaborators ────────────────────────────────────────────
let state;
let scheduleAutoSave;
let openLocalCompanionAssignmentModal;
let renderPersonalCompanionsSection;

export function initCompanions(deps) {
  ({ state, scheduleAutoSave, openLocalCompanionAssignmentModal, renderPersonalCompanionsSection } =
    deps);
}

function makeLocalCompanion() {
  return {
    id: makeItemId('lc'),
    name: '',
    phone: '',
    notes: '',
    outboundLegs: [],
    returnLegs: [],
    budget: '',
    budgetActual: '',
    currency: '',
  };
}

export function localCompanionCardHtml(lc) {
  const accomNames = (state.planner.personal?.accommodations || [])
    .filter((acc) => (acc.assignments || []).some((a) => a.memberId === lc.id))
    .map((acc) => acc.name || 'Unnamed')
    .join(', ');
  const meta = [lc.phone, accomNames].filter(Boolean).join(' · ');
  return `
    <div class="cmp-row" data-local-companion-id="${esc(lc.id)}">
      <span class="cmp-mono">${esc(monogram(lc.name))}</span>
      <div class="cmp-main">
        <p class="cmp-name">${esc(lc.name || 'Unnamed')}</p>
        ${meta ? `<p class="cmp-meta">${esc(meta)}</p>` : ''}
      </div>
      <span class="cmp-tag">One-off</span>
      <span class="cmp-acts">
        <button type="button" class="cmp-act view-companion-btn" data-person-id="${esc(lc.id)}" aria-label="View ${esc(lc.name || 'companion')}">Details</button>
        <button type="button" class="cmp-act local-companion-flights-btn" data-local-companion-id="${esc(lc.id)}" aria-label="Travel for ${esc(lc.name || 'companion')}">Travel</button>
        <button type="button" class="cmp-act edit-local-companion-btn" data-local-companion-id="${esc(lc.id)}" aria-label="Edit ${esc(lc.name || 'companion')}">Edit</button>
        <button type="button" class="cmp-act cmp-act--del delete-local-companion-btn" data-local-companion-id="${esc(lc.id)}" aria-label="Remove ${esc(lc.name || 'companion')}">Remove</button>
      </span>
    </div>`;
}

// A one/two-letter monogram from a name.
function monogram(name) {
  const src = (name || '?').trim();
  const parts = src.split(/\s+/).filter(Boolean);
  return ((parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : src.slice(0, 2)) || '?')
    .toUpperCase()
    .slice(0, 2);
}

function meCardHtml(personal, contacts, locals, meId) {
  let meName = 'Me';
  let isDefault = true;
  if (meId) {
    const c = contacts.find((x) => x.id === meId) || locals.find((x) => x.id === meId);
    if (c) {
      meName = c.name || 'Me';
      isDefault = false;
    }
  }
  const opt = (id, name, suffix = '') =>
    `<option value="${esc(id)}"${id === meId ? ' selected' : ''}>${esc(name || 'Unnamed')}${suffix}</option>`;
  const options =
    `<option value=""${!meId ? ' selected' : ''}>Me (default)</option>` +
    contacts.map((c) => opt(c.id, c.name)).join('') +
    locals.map((lc) => opt(lc.id, lc.name, ' (this trip)')).join('');
  return `<div class="cmp-me">
    <span class="cmp-me-mono">${esc(isDefault ? 'ME' : monogram(meName))}</span>
    <div class="cmp-me-body">
      <span class="cmp-me-eyebrow">You on this trip</span>
      <p class="cmp-me-name">${esc(meName)}</p>
      <span class="cmp-me-pick"><span class="cmp-me-pick-label">You are</span>
        <select id="cmpMeSelect" class="cmp-me-select" aria-label="Choose who you are">${options}</select>
      </span>
    </div>
  </div>`;
}

function contactRowHtml(c, on) {
  const meta = [c.phone, c.notes].filter(Boolean).join(' · ');
  return `<div class="cmp-row${on ? ' cmp-row--on' : ''}" data-contact-id="${esc(c.id)}">
    <span class="cmp-mono">${esc(monogram(c.name))}</span>
    <div class="cmp-main">
      <p class="cmp-name">${esc(c.name || 'Unnamed')}</p>
      ${meta ? `<p class="cmp-meta">${esc(meta)}</p>` : ''}
    </div>
    <span class="cmp-acts">
      ${on ? `<button type="button" class="cmp-act view-companion-btn" data-person-id="${esc(c.id)}" aria-label="View trip details for ${esc(c.name || 'contact')}">Details</button>` : ''}
      <button type="button" class="cmp-act cmp-contact-edit" data-contact-id="${esc(c.id)}" aria-label="Edit ${esc(c.name || 'contact')}">Edit</button>
    </span>
    <span class="cmp-toggle-wrap"><span class="cmp-toggle-label">On trip</span>
      <input type="checkbox" class="pl-toggle cmp-toggle" data-contact-id="${esc(c.id)}" ${on ? 'checked' : ''} aria-label="Include ${esc(c.name || 'contact')} on this trip"></span>
  </div>`;
}

export function renderCompanionsTab() {
  const personal = state.planner.personal || {};
  const meId = personal.meContactId || null;
  const contacts = state.global?.personalContacts || [];
  const locals = personal.localCompanions || [];
  const assignedIds = new Set((personal.tripAssignments || []).map((a) => a.memberId));

  const meEl = document.getElementById('cmpMe');
  if (meEl) meEl.innerHTML = meCardHtml(personal, contacts, locals, meId);

  const listEl = document.getElementById('cmpContactsList');
  if (listEl) {
    const roster = contacts.filter((c) => c.id !== meId);
    document.getElementById('cmpContactsEmpty')?.classList.toggle('hidden', roster.length > 0);
    listEl.innerHTML = roster.map((c) => contactRowHtml(c, assignedIds.has(c.id))).join('');
  }

  const localsEl = document.getElementById('companionsTabList');
  if (localsEl) {
    const roster = locals.filter((lc) => lc.id !== meId);
    document.getElementById('companionsTabEmpty')?.classList.toggle('hidden', roster.length > 0);
    localsEl.innerHTML = roster.map(localCompanionCardHtml).join('');
  }
}

// Open the shared read-only detail modal for a companion. Handles both a
// trip-local companion (data lives on the companion object) and a global
// trip-assignment companion (identity from the contact, travel/budget from the
// assignment). Their shared associations — stays, tickets, itinerary — live on
// the personal record and are keyed by the same person id.
export function openCompanionDetail(personId) {
  const personal = state.planner.personal || {};
  const local = (personal.localCompanions || []).find((x) => x.id === personId);
  const assignment = (personal.tripAssignments || []).find((a) => a.memberId === personId);
  if (!local && !assignment) return;

  const contact = assignment
    ? (state.global?.personalContacts || []).find((c) => c.id === personId)
    : null;
  const src = local || assignment; // travel legs + simple budget live here

  const legs = [
    ...(src.outboundLegs || []).map((l) => ({ ...l, dir: 'outbound' })),
    ...(src.returnLegs || []).map((l) => ({ ...l, dir: 'return' })),
  ];
  const stays = (personal.accommodations || [])
    .map((acc) => {
      const st = (acc.assignments || []).find((s) => s.memberId === personId);
      if (!st) return null;
      return {
        name: acc.name,
        checkIn: st.checkIn || acc.checkIn,
        checkOut: st.checkOut || acc.checkOut,
      };
    })
    .filter(Boolean);
  const tickets = (personal.tickets || [])
    .filter((t) => t.assignedTo === personId || t.purchasedBy === personId)
    .map((t) => ({
      name: t.name,
      status: t.status,
      relation: t.assignedTo === personId ? 'assigned' : 'purchased by',
    }));
  const itinerary = (personal.itinerary || []).filter(
    (i) => Array.isArray(i.memberIds) && i.memberIds.includes(personId),
  );
  const budget =
    src.budget || src.budgetActual
      ? {
          mode: 'simple',
          budget: src.budget,
          actual: src.budgetActual,
          currency: src.currency || personal.currency || '',
        }
      : { mode: 'none' };

  openPersonDetail({
    name: local ? local.name : contact?.name || 'Companion',
    subtitle: local ? '' : [contact?.role, contact?.org].filter(Boolean).join(' · '),
    badges: local ? [{ text: 'This trip', tone: 'blue' }] : [],
    phone: local ? local.phone : contact?.phone,
    notes: local ? local.notes : contact?.notes,
    legs,
    stays,
    tickets,
    itinerary,
    budget,
  });
}

let _localCompanionId = null;

function openLocalCompanionModal(id) {
  _localCompanionId = id;
  const lc = id ? (state.planner.personal?.localCompanions || []).find((x) => x.id === id) : null;
  document.getElementById('localCompanionModalTitle').textContent = id
    ? 'Edit Companion'
    : 'Add Companion';
  document.getElementById('localCompanionName').value = lc?.name || '';
  document.getElementById('localCompanionPhone').value = lc?.phone || '';
  document.getElementById('localCompanionNotes').value = lc?.notes || '';
  document.getElementById('localCompanionModalDelete')?.classList.toggle('hidden', !id);
  showModal('localCompanionModal', 'localCompanionName');
}

function saveLocalCompanion() {
  const personal = state.planner.personal;
  if (!personal) return;
  const name = document.getElementById('localCompanionName')?.value.trim() || '';
  const phone = document.getElementById('localCompanionPhone')?.value.trim() || '';
  const notes = document.getElementById('localCompanionNotes')?.value.trim() || '';
  personal.localCompanions = personal.localCompanions || [];
  if (_localCompanionId) {
    const lc = personal.localCompanions.find((x) => x.id === _localCompanionId);
    if (lc) Object.assign(lc, { name, phone, notes });
  } else {
    personal.localCompanions.push({ ...makeLocalCompanion(), name, phone, notes });
  }
  scheduleAutoSave();
  hideModal('localCompanionModal');
  _localCompanionId = null;
  renderCompanionsTab();
  renderPersonalAccomList();
}

function deleteLocalCompanion(id) {
  const personal = state.planner.personal;
  if (!personal) return;
  const snapshot = (personal.localCompanions || []).find((x) => x.id === id);
  const snapAccomAssns = (personal.accommodations || []).map((acc) => ({
    id: acc.id,
    a: [...(acc.assignments || [])],
  }));
  personal.localCompanions = (personal.localCompanions || []).filter((x) => x.id !== id);
  (personal.accommodations || []).forEach((acc) => {
    acc.assignments = (acc.assignments || []).filter((a) => a.memberId !== id);
  });
  scheduleAutoSave();
  hideModal('localCompanionModal');
  _localCompanionId = null;
  renderCompanionsTab();
  renderPersonalAccomList();
  if (snapshot)
    showUndoToast(snapshot.name || 'Companion', () => {
      const p = state.planner.personal;
      p.localCompanions = [...(p.localCompanions || []), snapshot];
      snapAccomAssns.forEach(({ id: aId, a }) => {
        const acc = (p.accommodations || []).find((x) => x.id === aId);
        if (acc) acc.assignments = a;
      });
      renderCompanionsTab();
      renderPersonalAccomList();
      scheduleAutoSave();
    });
}

export function wireCompanionsPanel() {
  const panel = document.getElementById('plannerCompanionsPanel');
  if (!panel) return;

  document
    .getElementById('addLocalCompanionBtn')
    ?.addEventListener('click', () => openLocalCompanionModal(null));
  document
    .getElementById('cmpAddContactBtn')
    ?.addEventListener('click', () => openPersonalContactModal(null));

  panel.addEventListener('click', (e) => {
    // View — shared read-only detail (works for both local + global companions).
    const viewBtn = e.target.closest('.view-companion-btn');
    if (viewBtn) {
      openCompanionDetail(viewBtn.dataset.personId);
      return;
    }
    const flightsBtn = e.target.closest('.local-companion-flights-btn');
    if (flightsBtn) {
      openLocalCompanionAssignmentModal(flightsBtn.dataset.localCompanionId);
      return;
    }
    const editBtn = e.target.closest('.edit-local-companion-btn');
    if (editBtn) {
      openLocalCompanionModal(editBtn.dataset.localCompanionId);
      return;
    }
    const delBtn = e.target.closest('.delete-local-companion-btn');
    if (delBtn) {
      deleteLocalCompanion(delBtn.dataset.localCompanionId);
      return;
    }
    // Edit a saved (global) contact via the shared personal-contact modal.
    const editContact = e.target.closest('.cmp-contact-edit');
    if (editContact) {
      openPersonalContactModal(editContact.dataset.contactId);
      return;
    }
  });

  // Include toggles (who can have assigned items on this trip) + the "Me" picker.
  panel.addEventListener('change', (e) => {
    const toggle = e.target.closest('.cmp-toggle');
    if (toggle) {
      const cid = toggle.dataset.contactId;
      const personal = state.planner.personal;
      if (!personal) return;
      personal.tripAssignments = personal.tripAssignments || [];
      const on = toggle.checked;
      const already = personal.tripAssignments.some((a) => a.memberId === cid);
      if (on && !already) {
        personal.tripAssignments.push(makeTripAssignment(cid));
      } else if (!on && already) {
        personal.tripAssignments = personal.tripAssignments.filter((a) => a.memberId !== cid);
      }
      scheduleAutoSave();
      renderCompanionsTab();
      renderPersonalCompanionsSection();
      return;
    }
    if (e.target.id === 'cmpMeSelect') {
      const personal = state.planner.personal;
      if (!personal) return;
      personal.meContactId = e.target.value || null;
      scheduleAutoSave();
      renderCompanionsTab();
      renderPersonalCompanionsSection();
    }
  });

  // Local companion modal wiring
  document.getElementById('localCompanionModalClose')?.addEventListener('click', () => {
    hideModal('localCompanionModal');
    _localCompanionId = null;
  });
  document.getElementById('localCompanionModalDone')?.addEventListener('click', saveLocalCompanion);
  document.getElementById('localCompanionModalDelete')?.addEventListener('click', () => {
    if (_localCompanionId) deleteLocalCompanion(_localCompanionId);
  });
  document.getElementById('localCompanionModal')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      saveLocalCompanion();
    }
    if (e.key === 'Escape') {
      hideModal('localCompanionModal');
      _localCompanionId = null;
    }
  });
}

// Static shell for this tab panel — injected into #plannerCompanionsPanel at boot (#7 co-location).
export function companionsPanelHtml() {
  return `
          <section>
            <div class="pln-section__head">
              <div>
                <p class="pln-eyebrow">Who's coming</p>
                <h2 class="pln-section__title">Companions</h2>
              </div>
            </div>

            <div id="cmpMe"></div>

            <div class="cmp-section">
              <div class="doc-divider">
                <span>Your people</span>
                <button type="button" id="cmpAddContactBtn" class="cmp-act cmp-act--always" aria-label="Add a contact">Add contact</button>
              </div>
              <div id="cmpContactsList" class="cmp-list"></div>
              <p id="cmpContactsEmpty" class="cmp-none hidden">No saved contacts yet — add someone to bring along.</p>
            </div>

            <div class="cmp-section">
              <div class="doc-divider">
                <span>Just this trip</span>
                <button type="button" id="addLocalCompanionBtn" class="cmp-act cmp-act--always" aria-label="Add a one-off companion">Add companion</button>
              </div>
              <div id="companionsTabList" class="cmp-list"></div>
              <p id="companionsTabEmpty" class="cmp-none">No one-off companions — add a traveller who isn't in your contacts.</p>
            </div>
          </section>
        `;
}
