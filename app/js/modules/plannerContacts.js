// Contacts tab for the planner — the key/general contact grid, the add/edit
// modal, and delete-with-undo. Extracted from planner.js following the same
// contract as plannerNotes.js / plannerTasks.js: planner-internal collaborators
// (shared state + autosave) are supplied once via initContacts(); shared
// utilities and storage helpers are imported directly.

import { escapeHtml as esc } from './utils.js';
import { showModal, hideModal } from './modal.js';
import { showUndoToast } from './notify.js';
import { makeItemId } from './plannerStorage.js';

// ── Injected planner collaborators ────────────────────────────────────────────
let state;
let scheduleAutoSave;

export function initContacts(deps) {
  ({ state, scheduleAutoSave } = deps);
}

const CONTACT_TYPES = {
  organiser: {
    label: 'Organiser',
    color: 'bg-violet-100 text-violet-700',
    border: 'border-l-violet-300',
  },
  media: { label: 'Media', color: 'bg-teal-100 text-teal-700', border: 'border-l-teal-300' },
  partner: { label: 'Partner', color: 'bg-amber-100 text-amber-700', border: 'border-l-amber-300' },
  vip: { label: 'VIP', color: 'bg-rose-100 text-rose-700', border: 'border-l-rose-300' },
};

// A monogram of up to two initials from the name (or org).
function contactMonogram(contact) {
  const src = (contact.name || contact.org || '?').trim();
  const parts = src.split(/\s+/).filter(Boolean);
  const initials = (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : src.slice(0, 2))
    .toUpperCase()
    .slice(0, 2);
  return initials || '?';
}

function contactCardHtml(contact) {
  const typeInfo = contact.type ? CONTACT_TYPES[contact.type] : null;
  const name = contact.name || contact.org || 'New contact';
  const org = contact.name && contact.org ? contact.org : '';
  const meta = [contact.email, contact.whereMet].filter(Boolean).join(' · ');
  const typeTag = typeInfo
    ? `<span class="cnt-type cnt-type--${esc(contact.type)}">${esc(typeInfo.label)}</span>`
    : '';
  const flag = contact.followUp
    ? '<span class="cnt-flag" title="Follow up" aria-label="Marked to follow up">Follow up</span>'
    : '';
  // The whole card opens the contact editor (which owns Edit + Delete); the
  // split-by-type grid and the follow-up flag/edge are preserved.
  return `
    <button type="button" class="cnt-card pl-open edit-contact-btn${contact.followUp ? ' cnt-card--flag' : ''}" data-contact-id="${esc(contact.id)}" aria-label="Edit ${esc(contact.name || 'contact')}">
      <span class="cnt-mono">${esc(contactMonogram(contact))}</span>
      <div class="cnt-main">
        <p class="cnt-name">${esc(name)}${org ? ` <span class="cnt-org">· ${esc(org)}</span>` : ''}</p>
        ${meta ? `<p class="cnt-meta">${esc(meta)}</p>` : ''}
      </div>
      ${typeTag}${flag}
      <span class="pl-open-go" aria-hidden="true">&rsaquo;</span>
    </button>`;
}

export function renderContactsTab() {
  const list = document.getElementById('contactsList');
  const empty = document.getElementById('contactsEmptyState');
  if (!list) return;
  const contacts = state.planner.contacts;
  empty?.classList.toggle('hidden', contacts.length > 0);

  const key = contacts.filter((c) => c.type && CONTACT_TYPES[c.type]);
  const general = contacts.filter((c) => !c.type || !CONTACT_TYPES[c.type]);

  if (!key.length) {
    list.className = 'cnt-list';
    list.innerHTML = general.map(contactCardHtml).join('');
    return;
  }

  list.className = 'cnt-grid cnt-grid--split';
  const colHtml = (title, items) => `
    <div>
      <div class="cnt-col-title"><span>${esc(title)}</span><span class="cnt-col-n">${items.length}</span></div>
      <div class="cnt-list">
        ${items.length ? items.map(contactCardHtml).join('') : '<p class="cnt-none">None yet</p>'}
      </div>
    </div>`;
  list.innerHTML = colHtml('Key contacts', key) + colHtml('General', general);
}

let _contactModalId = null;

function openContactModal(id) {
  _contactModalId = id;
  const contact = id ? state.planner.contacts.find((c) => c.id === id) : null;
  document.getElementById('contactModalTitle').textContent = id ? 'Edit Contact' : 'Add Contact';
  document.getElementById('contactName').value = contact?.name || '';
  document.getElementById('contactOrg').value = contact?.org || '';
  document.getElementById('contactEmail').value = contact?.email || '';
  document.getElementById('contactLinkedin').value = contact?.linkedin || '';
  document.getElementById('contactType').value = contact?.type || '';
  document.getElementById('contactWhereMet').value = contact?.whereMet || '';
  document.getElementById('contactNotes').value = contact?.notes || '';
  document.getElementById('contactFollowUp').checked = contact?.followUp || false;
  document.getElementById('contactModalDelete')?.classList.toggle('hidden', !id);
  showModal('contactModal', 'contactName');
}

function saveContactModal() {
  const isNew = !_contactModalId;
  const id = _contactModalId || makeItemId('c');
  const data = {
    id,
    name: document.getElementById('contactName').value.trim(),
    org: document.getElementById('contactOrg').value.trim(),
    email: document.getElementById('contactEmail').value.trim(),
    linkedin: document.getElementById('contactLinkedin').value.trim(),
    type: document.getElementById('contactType').value,
    whereMet: document.getElementById('contactWhereMet').value.trim(),
    notes: document.getElementById('contactNotes').value.trim(),
    followUp: document.getElementById('contactFollowUp').checked,
  };
  if (isNew) {
    state.planner.contacts.unshift(data);
  } else {
    const idx = state.planner.contacts.findIndex((c) => c.id === id);
    if (idx !== -1) state.planner.contacts[idx] = data;
  }
  closeContactModal();
  renderContactsTab();
  scheduleAutoSave();
}

function closeContactModal() {
  hideModal('contactModal');
  _contactModalId = null;
}

function deleteContact(id) {
  const snapshot = state.planner.contacts.find((c) => c.id === id);
  if (!snapshot) return;
  state.planner.contacts = state.planner.contacts.filter((c) => c.id !== id);
  renderContactsTab();
  scheduleAutoSave();
  showUndoToast(snapshot.name || snapshot.org || 'Contact', () => {
    state.planner.contacts = [...state.planner.contacts, snapshot];
    renderContactsTab();
    scheduleAutoSave();
  });
}

export function wireContactsPanel() {
  const panel = document.getElementById('plannerContactsPanel');
  if (!panel) return;

  panel.addEventListener('click', (e) => {
    const editBtn = e.target.closest('.edit-contact-btn');
    if (editBtn) {
      openContactModal(editBtn.dataset.contactId);
      return;
    }
  });

  document.getElementById('addContactBtn')?.addEventListener('click', () => openContactModal(null));

  // Contact modal wiring
  document.getElementById('contactModalClose')?.addEventListener('click', closeContactModal);
  document.getElementById('contactModalDone')?.addEventListener('click', saveContactModal);
  document.getElementById('contactModalDelete')?.addEventListener('click', () => {
    if (_contactModalId) {
      deleteContact(_contactModalId);
      closeContactModal();
    }
  });
  document.getElementById('contactModal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeContactModal();
  });
  document.getElementById('contactModal')?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeContactModal();
  });
}

// Static shell for this tab panel — injected into #plannerContactsPanel at boot (#7 co-location).
export function contactsPanelHtml() {
  return `
          <section>
            <div class="pln-section__head">
              <div>
                <p class="pln-eyebrow">People you met</p>
                <h2 class="pln-section__title">Contacts</h2>
              </div>
              <button id="addContactBtn" type="button" class="pl-add-btn">Add contact</button>
            </div>
            <div id="contactsList" class="cnt-list"></div>
            <div id="contactsEmptyState" class="hidden jrn-empty">
              <p class="jrn-empty-t">No one recorded yet</p>
              <p class="jrn-empty-s">Save the people you meet — organisers, partners, that dev with the great pipeline talk — and flag who to follow up with.</p>
            </div>
          </section>
        `;
}
