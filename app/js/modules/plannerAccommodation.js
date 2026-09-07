// Accommodation modal (sponsor/team) + small org-tab card helpers — the team
// accommodation member/stay sections and modal opener, plus checklist-item and
// swag card HTML used by the org tab. Extracted from planner.js: planner-internal
// collaborators are injected via initAccommodation(); shared helpers imported.

import { escapeHtml as esc } from './utils.js';
import { showModal, touchDevice } from './modal.js';
import { formatAmount } from './plannerFields.js';
import { renderWaypointStops, toggleWaypointStopsSection } from './plannerOrg.js';
import { linkedReceipt } from './plannerEntityReceipt.js';

// ── Injected planner collaborators ────────────────────────────────────────────
let state;
let renderOrgAccomReceiptStatus;
let renderAccomStayReceiptStatus;

export function initAccommodation(deps) {
  ({ state, renderOrgAccomReceiptStatus, renderAccomStayReceiptStatus } = deps);
}

export function renderAccomMembersSection(acc) {
  const allAssignments = state.planner.org.teamAssignments || [];
  const noMembersEl = document.getElementById('accomNoMembers');
  const wrapper = document.getElementById('accomMemberStaysWrapper');
  const select = document.getElementById('accomMemberSelect');

  if (!allAssignments.length) {
    noMembersEl?.classList.remove('hidden');
    wrapper?.classList.add('hidden');
    return;
  }
  noMembersEl?.classList.add('hidden');
  wrapper?.classList.remove('hidden');

  const prevValue = select?.value || '';
  const assignedIds = new Set((acc.assignments || []).map((s) => s.memberId));

  if (select) {
    select.innerHTML =
      `<option value="">— Select to view or add —</option>` +
      allAssignments
        .map((a) => {
          const m = state.global?.teamMembers.find((tm) => tm.id === a.memberId);
          if (!m) return '';
          return `<option value="${esc(m.id)}"${prevValue === m.id ? ' selected' : ''}>${esc(m.name || 'Unnamed')}${assignedIds.has(m.id) ? ' ✓' : ''}</option>`;
        })
        .filter(Boolean)
        .join('');
  }

  if (prevValue && select?.value === prevValue) {
    loadMemberStayFields(acc, prevValue);
  } else {
    document.getElementById('accomMemberFields')?.classList.add('hidden');
    const removeBtn = document.getElementById('accomRemoveMemberBtn');
    if (removeBtn) removeBtn.classList.add('opacity-0', 'pointer-events-none');
  }
}

export function loadMemberStayFields(acc, memberId) {
  const stay = (acc.assignments || []).find((s) => s.memberId === memberId) || {};
  const hasStay = !!(acc.assignments || []).find((s) => s.memberId === memberId);
  const fields = document.getElementById('accomMemberFields');
  const removeBtn = document.getElementById('accomRemoveMemberBtn');

  fields?.classList.remove('hidden');
  if (removeBtn) {
    if (hasStay) removeBtn.classList.remove('opacity-0', 'pointer-events-none');
    else removeBtn.classList.add('opacity-0', 'pointer-events-none');
  }

  const isWaypoints = acc.type === 'waypoints';
  document.getElementById('accomMemberCheckInRow')?.classList.toggle('hidden', isWaypoints);
  document.getElementById('accomMemberCheckOutRow')?.classList.toggle('hidden', isWaypoints);

  const checkIn = document.getElementById('accomMemberCheckIn');
  const checkOut = document.getElementById('accomMemberCheckOut');
  if (checkIn) checkIn.value = isWaypoints ? acc.checkIn || '' : stay.checkIn || '';
  if (checkOut) checkOut.value = isWaypoints ? acc.checkOut || '' : stay.checkOut || '';
  renderAccomStayReceiptStatus?.(acc, memberId);
}

export function openAccommodationModal(id) {
  const modal = document.getElementById('accommodationModal');
  if (!modal) return;
  const acc = (state.planner.org.accommodations || []).find((a) => a.id === id);
  if (!acc) return;

  modal.dataset.accomId = id;
  const accomType = acc.type || 'accommodation';
  const typeEl = document.getElementById('accomType');
  if (typeEl) typeEl.value = accomType;
  document.getElementById('accommodationModalTitle').textContent =
    accomType === 'waypoints' ? 'Waypoint' : 'Accommodation';
  document.getElementById('accomName').value = acc.name || '';
  document.getElementById('accomAddress').value = acc.address || '';
  const accomCoordsEl = document.getElementById('accomCoords');
  if (accomCoordsEl) accomCoordsEl.value = acc.coords || '';
  document.getElementById('accomConfirmation').value = acc.confirmation || '';
  document.getElementById('accomNotes').value = acc.notes || '';

  toggleWaypointStopsSection(accomType === 'waypoints', 'accomWaypointStopsSection');
  renderWaypointStops(acc.stops, 'accomWaypointStopsList', 'accomWaypointStopsEmpty');

  renderOrgAccomReceiptStatus(acc);
  renderAccomMembersSection(acc);

  showModal('accommodationModal');
  if (!touchDevice()) modal.querySelector('input')?.focus();
}

export function checklistItemHtml(item, listType) {
  const hasDate = listType === 'deliverables';
  return `
    <div class="flex items-center gap-2 p-2 rounded border pl-rule pl-surface group" data-${listType}-id="${esc(item.id)}">
      <input type="checkbox" class="h-4 w-4 rounded flex-shrink-0" data-${listType}-id="${esc(item.id)}" data-${listType}-field="done" ${item.done ? 'checked' : ''}>
      <input type="text" data-${listType}-id="${esc(item.id)}" data-${listType}-field="label" value="${esc(item.label)}"
        placeholder="Item…"
        class="flex-1 h-8 border-0 border-b pl-rule-none hover:pl-rule focus:pl-rule focus:ring-0 pl-surface-none text-sm ${item.done ? 'line-through pl-ink-2' : 'pl-ink-0'} px-1 transition-colors">
      ${hasDate ? `<input type="date" data-${listType}-id="${esc(item.id)}" data-${listType}-field="dueDate" value="${esc(item.dueDate || '')}" class="h-8 rounded pl-rule text-xs pl-surface px-2 pl-ink-2 w-32">` : ''}
      <button type="button" class="delete-${listType}-btn flex-shrink-0 pl-ink-2 hover-req transition-colors opacity-0 group-hover:opacity-100 transition-opacity duration-150" data-${listType}-id="${esc(item.id)}" aria-label="Remove ${esc(item.label || listType + ' item')}">
        <i class="fas fa-times text-xs" aria-hidden="true"></i>
      </button>
    </div>`;
}

export function swagCardHtml(item) {
  const fmt = (n) => (n ? formatAmount(parseFloat(n)) : null);
  const qty = parseInt(item.quantity, 10);
  const returned = item.returned != null ? parseInt(item.returned, 10) : NaN;
  // Cost now lives on the linked receipt (if any).
  const receipt = linkedReceipt(state.planner, item);
  const cost = receipt?.amount ? fmt(receipt.amount) : null;
  const hasBudget = !!cost;
  const subtitle = cost ? `${receipt.currency || 'AUD'} ${cost}` : '';
  const distributed = !isNaN(qty) && !isNaN(returned) ? qty - returned : NaN;
  const qtyBadge = !isNaN(qty) && qty > 0 ? `<span class="pl-rowcard-badge">×${qty}</span>` : '';
  const retBadge = !isNaN(returned)
    ? `<span class="pl-rowcard-badge pl-rowcard-badge--ret" title="${!isNaN(distributed) ? `${distributed} distributed` : ''}">↩ ${returned}</span>`
    : '';
  // Whole body opens the swag editor (which owns details + delete); the done
  // checkbox and qty/returned badges stay on the row.
  return `<div class="pl-rowcard${item.done ? ' is-done' : ''}" data-swag-id="${esc(item.id)}">
    <input type="checkbox" class="ckl-check swag-done-check" data-swag-id="${esc(item.id)}" ${item.done ? 'checked' : ''} aria-label="Mark ${esc(item.name || 'swag item')} as completed">
    <button type="button" class="pl-rowcard-body edit-swag-btn" data-swag-id="${esc(item.id)}" aria-label="Edit ${esc(item.name || 'swag item')}">
      <span class="pl-rowcard-title">${esc(item.name || 'Untitled swag item')}</span>
      ${hasBudget ? `<span class="pl-rowcard-meta"><span>${esc(subtitle)}</span></span>` : ''}
    </button>
    <div class="pl-rowcard-acts">${qtyBadge}${retBadge}</div>
  </div>`;
}
