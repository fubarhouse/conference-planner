// Tracked Sessions for the planner — sessions a user flags from the schedule
// (personal + sponsor contexts), the reason/notes modal, session search, and the
// auto-add of sponsored sessions. Extracted from planner.js: planner-internal
// collaborators (including the createModal factory) are supplied via
// initTrackedSessions(); shared utilities are imported directly.

import { escapeHtml as esc, parseSponsorIds } from './utils.js';
import { showModal } from './modal.js';
import { makeItemId } from './plannerStorage.js';

// ── Injected planner collaborators ────────────────────────────────────────────
let state;
let scheduleAutoSave;
let fmtTime;
let createModal;
let _trackedModal;

export function initTrackedSessions(deps) {
  ({ state, scheduleAutoSave, fmtTime, createModal } = deps);
  _trackedModal = createModal('trackedSessionModal', {
    onClose: () => {
      _trackedSessionCtx = null;
      _trackedSessionId = null;
    },
  });
}

const TRACKED_REASONS = [
  { value: 'presenting', label: 'Presenting / speaking', icon: 'fa-microphone' },
  { value: 'followup', label: 'Follow up', icon: 'fa-bookmark' },
  { value: 'other', label: 'Other', icon: 'fa-tag' },
];

let _trackedSessionCtx = null; // 'sponsor' | 'personal'
let _trackedSessionId = null; // string ID when editing, null when adding

export function syncSponsoredSessions() {
  const sponsorId = state.planner?.org?.sponsorId;
  if (!sponsorId) return;
  const tracked = (state.planner.org.trackedSessions ??= []);
  const autoAdded = (state.planner.org.autoAddedSponsoredSessions ??= []);
  const trackedIds = new Set(tracked.map((t) => t.sessionId));
  const autoSet = new Set(autoAdded);
  let changed = false;
  for (const session of state.allSessions) {
    if (!parseSponsorIds(session.sponsorIds).includes(sponsorId)) continue;
    if (trackedIds.has(session.id)) continue;
    if (autoSet.has(session.id)) continue; // user removed it — don't re-add
    tracked.push({
      id: makeItemId('ts'),
      sessionId: session.id,
      sessionTitle: session.title || '',
      sessionTime: session.startTime || '',
      reason: 'presenting',
      customReason: '',
      notes: '',
    });
    autoAdded.push(session.id);
    trackedIds.add(session.id);
    autoSet.add(session.id);
    changed = true;
  }
  if (changed) {
    scheduleAutoSave();
    renderTrackedSessions('sponsor');
  }
}

function getTrackedList(ctx) {
  if (ctx === 'sponsor') return (state.planner.org.trackedSessions ??= []);
  if (ctx === 'personal') return (state.planner.personal.trackedSessions ??= []);
  return [];
}

function trackedSessionCardHtml(ts, ctx) {
  const reasonObj = TRACKED_REASONS.find((r) => r.value === ts.reason);
  const reasonLabel = ts.reason === 'other' ? ts.customReason || 'Other' : reasonObj?.label || '';
  const icon = reasonObj?.icon || 'fa-tag';
  const badgeClass =
    ts.reason === 'presenting'
      ? 'bg-blue-50 text-blue-600'
      : ts.reason === 'followup'
        ? 'bg-amber-50 text-amber-600'
        : 'bg-gray-100 text-gray-500';
  const subtitle = [ts.sessionTime ? fmtTime(ts.sessionTime) : '', ts.notes ? ts.notes : '']
    .filter(Boolean)
    .join(' · ');
  return `<div class="flex items-center gap-2 py-2 px-3 pl-bordered pl-surface" data-ts-id="${esc(ts.id)}">
    <div class="flex-1 min-w-0">
      <div class="flex items-center gap-2 flex-wrap min-w-0">
        <p class="text-sm font-medium pl-ink-0 truncate">${esc(ts.sessionTitle || 'Untitled session')}</p>
        ${reasonLabel ? `<span class="inline-flex items-center gap-1 px-1.5 py-px rounded text-[0.65rem] font-medium flex-shrink-0 ${badgeClass}"><i class="fas ${esc(icon)} text-[0.55rem]"></i>${esc(reasonLabel)}</span>` : ''}
      </div>
      ${subtitle ? `<p class="text-xs pl-ink-2 truncate mt-0.5">${esc(subtitle)}</p>` : ''}
    </div>
    <button type="button" class="edit-tracked-session-btn flex-shrink-0 h-7 w-7 inline-flex items-center justify-center border pl-rule rounded-md pl-ink-2 transition-colors"
      data-ts-ctx="${esc(ctx)}" data-ts-id="${esc(ts.id)}" aria-label="Edit tracked session: ${esc(ts.sessionTitle || 'session')}">
      <i class="fas fa-pen-to-square text-[0.65rem]" aria-hidden="true"></i>
    </button>
  </div>`;
}

export function renderTrackedSessions(ctx) {
  const listId = ctx === 'sponsor' ? 'sponsorTrackedSessionsList' : 'personalTrackedSessionsList';
  const emptyId =
    ctx === 'sponsor' ? 'sponsorTrackedSessionsEmpty' : 'personalTrackedSessionsEmpty';
  const countId = ctx === 'sponsor' ? 'sponsorTrackedCount' : 'personalTrackedCount';
  const listEl = document.getElementById(listId);
  const emptyEl = document.getElementById(emptyId);
  const countEl = document.getElementById(countId);
  if (!listEl) return;
  const list = getTrackedList(ctx);
  listEl.innerHTML = list.map((ts) => trackedSessionCardHtml(ts, ctx)).join('');
  emptyEl?.classList.toggle('hidden', list.length > 0);
  if (countEl) {
    countEl.textContent = list.length;
    countEl.classList.toggle('hidden', list.length === 0);
  }
}

function openTrackedSessionModal(ctx, tsId, sessionOverride) {
  _trackedSessionCtx = ctx;
  _trackedSessionId = tsId || null;

  const modal = document.getElementById('trackedSessionModal');
  if (!modal) return;

  const list = getTrackedList(ctx);
  const existing = tsId ? list.find((ts) => ts.id === tsId) : null;
  const session =
    sessionOverride ||
    (existing ? state.allSessions.find((s) => s.id === existing.sessionId) : null);

  const infoTitleEl = document.getElementById('trackedSessionInfoTitle');
  const infoTimeEl = document.getElementById('trackedSessionInfoTime');
  if (infoTitleEl) infoTitleEl.textContent = existing?.sessionTitle || session?.title || '';
  if (infoTimeEl)
    infoTimeEl.textContent = existing?.sessionTime
      ? fmtTime(existing.sessionTime)
      : session
        ? fmtTime(session.startTime)
        : '';

  modal.dataset.sessionId = existing?.sessionId || session?.id || '';
  modal.dataset.sessionTitle = existing?.sessionTitle || session?.title || '';
  modal.dataset.sessionTime = existing?.sessionTime || session?.startTime || '';

  const reason = existing?.reason || 'followup';
  modal.querySelectorAll('input[name="trackedSessionReason"]').forEach((r) => {
    r.checked = r.value === reason;
  });

  const customEl = document.getElementById('trackedSessionCustomReason');
  if (customEl) {
    customEl.value = existing?.customReason || '';
    customEl.classList.toggle('hidden', reason !== 'other');
  }

  const notesEl = document.getElementById('trackedSessionNotes');
  if (notesEl) notesEl.value = existing?.notes || '';

  const delBtn = document.getElementById('trackedSessionDeleteBtn');
  if (delBtn) delBtn.classList.toggle('invisible', !existing);

  showModal('trackedSessionModal');
}

function closeTrackedSessionModal() {
  _trackedModal.close();
}

function saveTrackedSession() {
  const ctx = _trackedSessionCtx;
  const tsId = _trackedSessionId;
  const modal = document.getElementById('trackedSessionModal');
  if (!modal || !ctx) return;

  const list = getTrackedList(ctx);
  const reason =
    modal.querySelector('input[name="trackedSessionReason"]:checked')?.value || 'other';
  const customReason = document.getElementById('trackedSessionCustomReason')?.value.trim() || '';
  const notes = document.getElementById('trackedSessionNotes')?.value.trim() || '';

  if (tsId) {
    const existing = list.find((ts) => ts.id === tsId);
    if (existing) Object.assign(existing, { reason, customReason, notes });
  } else {
    list.push({
      id: makeItemId('ts'),
      sessionId: modal.dataset.sessionId,
      sessionTitle: modal.dataset.sessionTitle,
      sessionTime: modal.dataset.sessionTime,
      reason,
      customReason,
      notes,
    });
  }

  renderTrackedSessions(ctx);
  scheduleAutoSave();
  closeTrackedSessionModal();
}

export function wireTrackedSessionModal() {
  const modal = document.getElementById('trackedSessionModal');
  if (!modal) return;

  _trackedModal.wire();

  document.getElementById('trackedSessionSaveBtn')?.addEventListener('click', saveTrackedSession);

  document.getElementById('trackedSessionDeleteBtn')?.addEventListener('click', () => {
    const ctx = _trackedSessionCtx;
    const tsId = _trackedSessionId;
    if (!ctx || !tsId) return;
    const list = getTrackedList(ctx);
    const idx = list.findIndex((ts) => ts.id === tsId);
    if (idx !== -1) list.splice(idx, 1);
    renderTrackedSessions(ctx);
    scheduleAutoSave();
    closeTrackedSessionModal();
  });

  modal.addEventListener('change', (e) => {
    if (e.target.name === 'trackedSessionReason') {
      const customEl = document.getElementById('trackedSessionCustomReason');
      if (customEl) customEl.classList.toggle('hidden', e.target.value !== 'other');
    }
  });
}

export function wireTrackedSessionSearch(ctx) {
  const searchInputId =
    ctx === 'sponsor' ? 'sponsorSessionSearchInput' : 'personalSessionSearchInput';
  const searchResultsId =
    ctx === 'sponsor' ? 'sponsorSessionSearchResults' : 'personalSessionSearchResults';
  const listId = ctx === 'sponsor' ? 'sponsorTrackedSessionsList' : 'personalTrackedSessionsList';

  const searchInput = document.getElementById(searchInputId);
  const searchResults = document.getElementById(searchResultsId);
  const listEl = document.getElementById(listId);

  searchInput?.addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    if (!q || !searchResults) {
      searchResults?.classList.add('hidden');
      return;
    }

    const tracked = new Set(getTrackedList(ctx).map((ts) => ts.sessionId));
    const matches = state.allSessions
      .filter((s) => s.title?.toLowerCase().includes(q) || s.location?.toLowerCase().includes(q))
      .slice(0, 25);

    if (!matches.length) {
      searchResults.innerHTML = '<p class="pl-hint px-3 py-2">No sessions found.</p>';
    } else {
      searchResults.innerHTML = matches
        .map((s) => {
          const already = tracked.has(s.id);
          return `<button type="button" class="tracked-session-result w-full text-left px-3 py-2 transition-colors text-sm ${already ? 'opacity-50 cursor-default' : 'hover:bg-gray-50'}" data-session-id="${esc(s.id)}" ${already ? 'disabled' : ''}>
          <p class="pl-ink-0 truncate">${esc(s.title)}</p>
          <p class="text-xs pl-ink-2">${esc(fmtTime(s.startTime))}${s.location ? ` · ${esc(s.location)}` : ''}${already ? ' · Already tracked' : ''}</p>
        </button>`;
        })
        .join('');
    }
    searchResults.classList.remove('hidden');
  });

  searchResults?.addEventListener('click', (e) => {
    const btn = e.target.closest('.tracked-session-result');
    if (!btn || btn.disabled) return;
    const session = state.allSessions.find((s) => s.id === btn.dataset.sessionId);
    if (!session) return;
    searchResults.innerHTML = '';
    searchResults.classList.add('hidden');
    if (searchInput) searchInput.value = '';
    openTrackedSessionModal(ctx, null, session);
  });

  listEl?.addEventListener('click', (e) => {
    const btn = e.target.closest('.edit-tracked-session-btn');
    if (btn) openTrackedSessionModal(btn.dataset.tsCtx, btn.dataset.tsId);
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest(`#${searchInputId}`) && !e.target.closest(`#${searchResultsId}`)) {
      searchResults?.classList.add('hidden');
    }
  });
}
