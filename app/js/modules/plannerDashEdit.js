// Dashboard planner edit modal — rename a saved planner and change (or unlink)
// its associated event, persisting to localStorage and the API. Extracted from
// planner.js: the shared event-options loader, the per-event date cache, and the
// dashboard re-render are injected via initDashEdit(); storage/modal/util helpers
// are imported directly.

import { escapeHtml as esc } from './utils.js';
import { showModal, hideModal } from './modal.js';
import { getPlannerKey, readJson, writeJson, readText, STORAGE_KEYS } from './plannerStorage.js';

// ── Injected planner collaborators ────────────────────────────────────────────
let _loadEventOptions;
let _eventDates;
let renderTripDashboard;

export function initDashEdit(deps) {
  ({ _loadEventOptions, _eventDates, renderTripDashboard } = deps);
}

let _dashEditSlug = null;
let _dashEditEventFile = null; // current working value (may differ from saved)
let _dashEditEventListCache = null;

export async function openDashboardPlannerEdit(slug, name, eventFile, eventLabel) {
  _dashEditSlug = slug;
  _dashEditEventFile = eventFile || '';

  const nameInput = document.getElementById('dashboardEditName');
  const slugInput = document.getElementById('dashboardEditSlug');
  const pill = document.getElementById('dashboardEditEventPill');
  const pillLabel = document.getElementById('dashboardEditEventPillLabel');
  const searchDiv = document.getElementById('dashboardEditEventSearch');
  const searchInput = document.getElementById('dashboardEditEventInput');
  const resultsDiv = document.getElementById('dashboardEditEventResults');
  const modal = document.getElementById('dashboardPlannerEditModal');

  if (nameInput) nameInput.value = name || '';
  if (slugInput) slugInput.value = slug ? (slug.endsWith('.json') ? slug : `${slug}.json`) : '';

  // Always reload the event list — ensures past events (enabled:false) are included
  _dashEditEventListCache = null;
  _loadEventOptions().then((list) => {
    _dashEditEventListCache = list;
  });

  function showEventPill(file, label) {
    _dashEditEventFile = file;
    if (pillLabel) pillLabel.textContent = label || file;
    pill?.classList.remove('hidden');
    pill?.classList.add('flex');
    searchDiv?.classList.add('hidden');
    if (searchInput) searchInput.value = '';
    if (resultsDiv) {
      resultsDiv.innerHTML = '';
      resultsDiv.classList.add('hidden');
    }
  }

  function showEventSearch() {
    _dashEditEventFile = '';
    pill?.classList.add('hidden');
    pill?.classList.remove('flex');
    searchDiv?.classList.remove('hidden');
  }

  // Store helpers on the modal element so wireDashboardPlannerEditModal can access them
  if (modal) {
    modal._showEventPill = showEventPill;
    modal._showEventSearch = showEventSearch;
  }

  if (eventFile) {
    // Resolve a human-readable label from the event list
    const list = _dashEditEventListCache || (await _loadEventOptions());
    _dashEditEventListCache = list;
    const found = list.find((e) => e.file === eventFile);
    showEventPill(eventFile, found?.label || eventLabel || eventFile);
  } else {
    showEventSearch();
  }

  showModal('dashboardPlannerEditModal', 'dashboardEditName');
}

let _dashEditModalWired = false;

export function wireDashboardPlannerEditModal() {
  if (_dashEditModalWired) return;
  _dashEditModalWired = true;
  const modal = document.getElementById('dashboardPlannerEditModal');
  const nameInput = document.getElementById('dashboardEditName');
  const pill = document.getElementById('dashboardEditEventPill');
  const pillLabel = document.getElementById('dashboardEditEventPillLabel');
  const unlinkBtn = document.getElementById('dashboardEditEventUnlink');
  const searchDiv = document.getElementById('dashboardEditEventSearch');
  const searchInput = document.getElementById('dashboardEditEventInput');
  const resultsDiv = document.getElementById('dashboardEditEventResults');
  const saveBtn = document.getElementById('dashboardEditSave');
  const cancelBtn = document.getElementById('dashboardEditCancel');
  const closeBtn = document.getElementById('dashboardEditClose');
  if (!modal) return;

  function closeModal() {
    hideModal('dashboardPlannerEditModal');
  }

  function renderDashEditResults(events, q) {
    if (!resultsDiv) return;
    const filtered = q
      ? events.filter(
          (e) =>
            e.label.toLowerCase().includes(q.toLowerCase()) ||
            e.file.toLowerCase().includes(q.toLowerCase()),
        )
      : events;
    if (!filtered.length) {
      resultsDiv.innerHTML = `<p class="text-sm pl-ink-2 px-3 py-4 text-center">${q ? 'No events match.' : 'No events found.'}</p>`;
    } else {
      resultsDiv.innerHTML = filtered
        .map(
          (ev) =>
            `<button type="button" class="dash-edit-event-pick flex w-full items-center gap-2 px-3 py-2.5 text-sm pl-ink-1 text-left transition-colors"
          data-file="${esc(ev.file)}" data-label="${esc(ev.label)}">
          <i class="fas fa-calendar pl-ink-2 text-xs w-4 text-center flex-shrink-0"></i>
          <span class="flex-1 min-w-0 truncate">${esc(ev.label)}</span>
        </button>`,
        )
        .join('');
    }
    resultsDiv.classList.remove('hidden');
  }

  searchInput?.addEventListener('focus', async () => {
    const events = _dashEditEventListCache || (await _loadEventOptions());
    _dashEditEventListCache = events;
    renderDashEditResults(events, searchInput.value.trim());
  });
  searchInput?.addEventListener('input', async () => {
    const events = _dashEditEventListCache || (await _loadEventOptions());
    _dashEditEventListCache = events;
    renderDashEditResults(events, searchInput.value.trim());
  });
  resultsDiv?.addEventListener('click', (e) => {
    const btn = e.target.closest('.dash-edit-event-pick');
    if (!btn) return;
    _dashEditEventFile = btn.dataset.file;
    if (pillLabel) pillLabel.textContent = btn.dataset.label;
    pill?.classList.remove('hidden');
    pill?.classList.add('flex');
    searchDiv?.classList.add('hidden');
    if (searchInput) searchInput.value = '';
    if (resultsDiv) {
      resultsDiv.innerHTML = '';
      resultsDiv.classList.add('hidden');
    }
  });

  unlinkBtn?.addEventListener('click', () => {
    _dashEditEventFile = '';
    pill?.classList.add('hidden');
    pill?.classList.remove('flex');
    searchDiv?.classList.remove('hidden');
    if (searchInput) searchInput.value = '';
    if (resultsDiv) {
      resultsDiv.innerHTML = '';
      resultsDiv.classList.add('hidden');
    }
  });

  saveBtn?.addEventListener('click', async () => {
    const slug = _dashEditSlug;
    if (!slug) {
      closeModal();
      return;
    }
    const name = nameInput?.value.trim();
    const key = getPlannerKey(slug);
    const data = readJson(key, {});
    if (name) data._displayName = name;
    data._eventFile = _dashEditEventFile || '';
    data._lastModified = new Date().toISOString();
    writeJson(key, data);
    // Invalidate date cache so renderTripDashboard always re-fetches for the new association
    if (_dashEditEventFile) {
      _eventDates.delete(_dashEditEventFile);
    }
    // Persist to disk if API available
    try {
      const base = (readText(STORAGE_KEYS.editorApiEndpoint) || '').replace(/\/$/, '');
      if (base) {
        const filename = slug.endsWith('.json') ? slug : `${slug}.json`;
        await fetch(`${base}/api/planner/${filename}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
      }
    } catch {
      /* best effort */
    }
    closeModal();
    await renderTripDashboard();
  });

  cancelBtn?.addEventListener('click', closeModal);
  closeBtn?.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal && !modal.classList.contains('hidden')) closeModal();
  });
}
