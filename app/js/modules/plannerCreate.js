// Create Planner modal (dashboard) — the "new trip" flow: name the planner,
// optionally attach an event via search, then create + navigate to it. Extracted
// from planner.js: state and the shared event-options loader are injected via
// initCreatePlanner(); storage/modal/util helpers are imported directly.

import { escapeHtml as esc, slugify } from './utils.js';
import { plannerHref } from './plannerRoute.js';
import { showModal, hideModal } from './modal.js';
import { loadPlanner, savePlanner } from './plannerStorage.js';
import { currencyOptions, getDefaultCurrency } from './plannerFields.js';

// ── Injected planner collaborators ────────────────────────────────────────────
let state;
let _loadEventOptions;

export function initCreatePlanner(deps) {
  ({ state, _loadEventOptions } = deps);
}

export let openCreatePlannerModal = () => {};

export function wireCreatePlannerModal() {
  const modal = document.getElementById('createPlannerModal');
  const nameInput = document.getElementById('createPlannerName');
  const createBtn = document.getElementById('createPlannerConfirmBtn');
  const closeBtn = document.getElementById('createPlannerModalClose');

  openCreatePlannerModal = function () {
    if (!modal) return;
    if (nameInput) nameInput.value = '';
    showModal('createPlannerModal', 'createPlannerName');
  };

  function closeCreateModal() {
    hideModal('createPlannerModal');
  }

  document
    .getElementById('newPlannerBtnNoEvent')
    ?.addEventListener('click', () => openCreatePlannerModal());
  closeBtn?.addEventListener('click', closeCreateModal);
  document.getElementById('createPlannerModalClose2')?.addEventListener('click', closeCreateModal);
  modal?.addEventListener('click', (e) => {
    if (e.target === modal) closeCreateModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal && !modal.classList.contains('hidden')) closeCreateModal();
  });

  // ── Event search within create modal ────────────────────────────────────────
  let _createSelectedEvent = null; // { file, label }
  const eventInput = document.getElementById('createPlannerEventInput');
  const eventResults = document.getElementById('createPlannerEventResults');
  const eventPill = document.getElementById('createPlannerEventPill');
  const eventPillLbl = document.getElementById('createPlannerEventPillLabel');
  const eventClear = document.getElementById('createPlannerEventClear');
  const eventSearch = document.getElementById('createPlannerEventSearch');

  function setCreateEvent(ev) {
    _createSelectedEvent = ev;
    if (ev) {
      if (eventPillLbl) eventPillLbl.textContent = ev.label;
      eventPill?.classList.remove('hidden');
      eventPill?.classList.add('flex');
      eventSearch?.classList.add('hidden');
      // Auto-fill name if blank
      if (nameInput && !nameInput.value.trim()) nameInput.value = ev.label;
    } else {
      eventPill?.classList.add('hidden');
      eventPill?.classList.remove('flex');
      eventSearch?.classList.remove('hidden');
      if (eventInput) eventInput.value = '';
      if (eventResults) {
        eventResults.innerHTML = '';
        eventResults.classList.add('hidden');
      }
    }
  }

  function renderCreateEventResults(events, q) {
    if (!eventResults) return;
    const filtered = q
      ? events.filter(
          (e) =>
            e.label.toLowerCase().includes(q.toLowerCase()) ||
            e.file.toLowerCase().includes(q.toLowerCase()),
        )
      : events;
    if (!filtered.length) {
      eventResults.innerHTML = `<p class="text-sm pl-ink-2 px-3 py-4 text-center">${q ? 'No events match.' : 'No events found.'}</p>`;
    } else {
      eventResults.innerHTML = filtered
        .map(
          (ev) =>
            `<button type="button" class="create-event-pick-btn flex w-full items-center gap-2 px-3 py-2.5 text-sm pl-ink-1 text-left transition-colors"
          data-file="${esc(ev.file)}" data-label="${esc(ev.label)}">
          <i class="fas fa-calendar pl-ink-2 text-xs w-4 text-center flex-shrink-0"></i>
          <span class="flex-1 min-w-0 truncate">${esc(ev.label)}</span>
        </button>`,
        )
        .join('');
    }
    eventResults.classList.remove('hidden');
  }

  let _createEventListCache = null;
  async function loadCreateEventList() {
    if (_createEventListCache) return _createEventListCache;
    _createEventListCache = await _loadEventOptions();
    return _createEventListCache;
  }

  eventInput?.addEventListener('focus', async () => {
    const events = await loadCreateEventList();
    renderCreateEventResults(events, eventInput.value.trim());
  });
  eventInput?.addEventListener('input', async () => {
    const events = await loadCreateEventList();
    renderCreateEventResults(events, eventInput.value.trim());
  });
  eventResults?.addEventListener('click', (e) => {
    const btn = e.target.closest('.create-event-pick-btn');
    if (!btn) return;
    setCreateEvent({ file: btn.dataset.file, label: btn.dataset.label });
  });
  eventClear?.addEventListener('click', () => setCreateEvent(null));

  // ── Feature selection (mode + optional features) ────────────────────────────
  // These map straight onto the same planner fields the Settings tab edits, so a
  // planner starts life already configured. Everything remains changeable later.
  const modePersonal = document.getElementById('createPlannerModePersonal');
  const modeSponsor = document.getElementById('createPlannerModeSponsor');
  const conferenceToggle = document.getElementById('createPlannerConference');
  const localTravelToggle = document.getElementById('createPlannerLocalTravel');
  const financialToggle = document.getElementById('createPlannerFinancial');
  const weatherToggle = document.getElementById('createPlannerWeather');
  const currencySelect = document.getElementById('createPlannerCurrency');

  function resetCreateFeatures() {
    const defaultMode = state.global?.defaultMode || 'personal';
    if (modePersonal) modePersonal.checked = defaultMode !== 'sponsor';
    if (modeSponsor) modeSponsor.checked = defaultMode === 'sponsor';
    if (conferenceToggle) conferenceToggle.checked = true; // conferences are the common case
    if (localTravelToggle) localTravelToggle.checked = false; // opt-in, matches Settings default
    if (financialToggle) financialToggle.checked = true; // on by default (money tabs are core)
    if (weatherToggle) weatherToggle.checked = false; // off by default, matching the seed
    // Roll-up currency defaults to the user's global default currency.
    if (currencySelect) currencySelect.innerHTML = currencyOptions(getDefaultCurrency());
  }

  // Reset event selection + feature defaults when the modal opens
  const origOpen = openCreatePlannerModal;
  openCreatePlannerModal = function () {
    setCreateEvent(null);
    resetCreateFeatures();
    origOpen();
  };

  createBtn?.addEventListener('click', () => {
    const name = nameInput?.value.trim();
    if (!name) {
      nameInput?.focus();
      return;
    }
    const slug = `planner-${slugify(name) || 'planner'}`;
    const newPlanner = loadPlanner(slug);
    newPlanner._displayName = name;
    newPlanner.mode = modeSponsor?.checked ? 'sponsor' : 'personal';
    newPlanner.isConference = conferenceToggle ? conferenceToggle.checked : true;
    const chosenCurrency = currencySelect?.value || getDefaultCurrency();
    newPlanner.displayCurrency = chosenCurrency;
    // The trip-currency selector was retired; seed the per-context currency (the
    // default for new receipts/line items) from the chosen roll-up currency so new
    // entries don't fall back to a stale AUD.
    (newPlanner.personal ??= {}).currency = chosenCurrency;
    (newPlanner.org ??= {}).sponsorCurrency = chosenCurrency;
    newPlanner.personal.showLocalTravel = !!localTravelToggle?.checked;

    // Weather + Financial map onto the existing per-planner tab-visibility list
    // (`disabledTabs`) — the same switch the Settings "Tab order & visibility"
    // panel edits — so there's no new state to maintain. Toggling here just seeds
    // which of those tabs a planner starts with.
    const container = newPlanner.mode === 'sponsor' ? newPlanner.org : newPlanner.personal;
    const disabled = new Set(container.disabledTabs || []);
    const setTab = (tab, enabled) => (enabled ? disabled.delete(tab) : disabled.add(tab));
    // Sponsor mode has no personal receipts/split tabs; only disable what exists.
    const financialTabs =
      newPlanner.mode === 'sponsor'
        ? ['budget', 'summary']
        : ['budget', 'receipts', 'split', 'summary'];
    setTab('weather', !!weatherToggle?.checked);
    financialTabs.forEach((tab) => setTab(tab, financialToggle ? financialToggle.checked : true));
    container.disabledTabs = [...disabled];

    if (_createSelectedEvent?.file) newPlanner._eventFile = _createSelectedEvent.file;
    savePlanner(slug, newPlanner);
    closeCreateModal();
    location.href = plannerHref(slug);
  });

  nameInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') createBtn?.click();
  });
}
