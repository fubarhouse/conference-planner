// Global settings modal (dashboard) — default currency/mode plus quick edit of
// the account-wide personal contacts and team members. Extracted from planner.js:
// state and the two sub-modal openers are injected via initGlobalSettings();
// storage/modal/field helpers are imported directly.

import { escapeHtml as esc } from './utils.js';
import { loadGlobal, saveGlobal } from './plannerStorage.js';
import { showModal, hideModal } from './modal.js';
import { CURRENCIES } from './plannerFields.js';
import { loadConfig as refreshS3Config } from './s3Settings.js';

// ── Injected planner collaborators ────────────────────────────────────────────
let state;
let openPersonalContactModal;
let openTeamMemberModal;

export function initGlobalSettings(deps) {
  ({ state, openPersonalContactModal, openTeamMemberModal } = deps);
}

let _globalSettingsWired = false;
export function wireGlobalSettingsModal() {
  if (_globalSettingsWired) return;
  _globalSettingsWired = true;

  const modal = document.getElementById('globalSettingsModal');
  const closeBtn = document.getElementById('globalSettingsClose');
  const doneBtn = document.getElementById('globalSettingsDone');
  const currencyEl = document.getElementById('globalSettingsCurrency');
  const modeEl = document.getElementById('globalSettingsMode');
  if (!modal) return;

  // Up to two initials from a name, for the gold monogram avatar.
  function monogram(name) {
    const parts = String(name || '?')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    return (
      (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : parts[0]?.slice(0, 2)) || '?'
    )
      .toUpperCase()
      .slice(0, 2);
  }

  function personCard(person, editClass, sub) {
    return `<button type="button" class="gs-person ${editClass}${person.enabled === false ? ' gs-person--off' : ''}" data-id="${esc(person.id)}" aria-label="Edit ${esc(person.name || 'person')}">
      <span class="gs-mono">${esc(monogram(person.name))}</span>
      <span class="gs-person-main">
        <span class="gs-person-name">${esc(person.name || 'Unnamed')}</span>
        ${sub ? `<span class="gs-person-sub">${esc(sub)}</span>` : ''}
      </span>
      <i class="fas fa-pen-to-square gs-person-go" aria-hidden="true"></i>
    </button>`;
  }

  function renderGlobalContactsList() {
    const list = document.getElementById('globalSettingsContactsList');
    if (!list) return;
    const contacts = state.global?.personalContacts || loadGlobal().personalContacts || [];
    list.innerHTML = contacts.length
      ? contacts.map((c) => personCard(c, 'global-contact-edit', c.phone)).join('')
      : '<p class="gs-none">No companions yet.</p>';
  }

  function renderGlobalTeamList() {
    const list = document.getElementById('globalSettingsTeamList');
    if (!list) return;
    const members = state.global?.teamMembers || loadGlobal().teamMembers || [];
    list.innerHTML = members.length
      ? members.map((m) => personCard(m, 'global-member-edit', m.role)).join('')
      : '<p class="gs-none">No team members yet.</p>';
  }

  // Companions / Team can each be toggled off — the content is preserved, the
  // column body is just hidden (so you show only what's relevant to this account).
  function applyPeopleToggle(which, on) {
    const toggle = document.getElementById(
      which === 'companions' ? 'gsShowCompanions' : 'gsShowTeam',
    );
    const body = document.getElementById(
      which === 'companions' ? 'gsCompanionsBody' : 'gsTeamBody',
    );
    if (toggle) toggle.checked = on;
    if (body) body.classList.toggle('hidden', !on);
  }

  function openGlobalSettings() {
    // Ensure state.global is loaded (needed by sub-modals)
    if (!state.global) state.global = loadGlobal();
    const g = state.global;
    if (currencyEl) {
      currencyEl.innerHTML = CURRENCIES.map(
        (c) =>
          `<option value="${c}"${c === (g.defaultCurrency || 'AUD') ? ' selected' : ''}>${c}</option>`,
      ).join('');
    }
    if (modeEl) modeEl.value = g.defaultMode || 'personal';
    applyPeopleToggle('companions', g.gsShowCompanions !== false);
    applyPeopleToggle('team', g.gsShowTeam !== false);
    renderGlobalContactsList();
    renderGlobalTeamList();
    refreshS3Config(); // re-check S3 on every open so the banner is never stale
    showModal('globalSettingsModal', undefined);
  }

  // Section on/off toggles — persist to global + show/hide the column body.
  function wirePeopleToggle(id, key, which) {
    document.getElementById(id)?.addEventListener('change', (e) => {
      const g = loadGlobal();
      g[key] = e.target.checked;
      saveGlobal(g);
      if (state.global) state.global[key] = e.target.checked;
      applyPeopleToggle(which, e.target.checked);
    });
  }
  wirePeopleToggle('gsShowCompanions', 'gsShowCompanions', 'companions');
  wirePeopleToggle('gsShowTeam', 'gsShowTeam', 'team');

  // Refresh lists whenever a sub-modal closes and we return to this modal
  const subModalIds = ['personalContactModal', 'teamMemberModal'];
  subModalIds.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    new MutationObserver(() => {
      if (el.classList.contains('hidden') && !modal.classList.contains('hidden')) {
        state.global = loadGlobal();
        renderGlobalContactsList();
        renderGlobalTeamList();
      }
    }).observe(el, { attributes: true, attributeFilter: ['class'] });
  });

  document.addEventListener('click', (e) => {
    if (e.target.closest('#dashboardSettingsBtn')) {
      openGlobalSettings();
      return;
    }
    const cBtn = e.target.closest('.global-contact-edit');
    if (cBtn) {
      openPersonalContactModal(cBtn.dataset.id);
      return;
    }
    const mBtn = e.target.closest('.global-member-edit');
    if (mBtn) {
      openTeamMemberModal(mBtn.dataset.id);
      return;
    }
    if (e.target.closest('#globalSettingsAddContactBtn')) {
      openPersonalContactModal(null);
      return;
    }
    if (e.target.closest('#globalSettingsAddMemberBtn')) {
      openTeamMemberModal(null);
      return;
    }
  });

  currencyEl?.addEventListener('change', () => {
    const g = loadGlobal();
    g.defaultCurrency = currencyEl.value;
    saveGlobal(g);
    if (state.global) state.global.defaultCurrency = currencyEl.value;
  });
  modeEl?.addEventListener('change', () => {
    const g = loadGlobal();
    g.defaultMode = modeEl.value;
    saveGlobal(g);
    if (state.global) state.global.defaultMode = modeEl.value;
  });

  function closeModal() {
    hideModal('globalSettingsModal');
  }
  closeBtn?.addEventListener('click', closeModal);
  doneBtn?.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal && !modal.classList.contains('hidden')) closeModal();
  });
}
