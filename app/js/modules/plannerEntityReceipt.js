// Shared "receipt link" mechanism — the one way any planner entity (travel leg,
// itinerary item, ticket, accommodation stay, …) delegates its cost to a linked
// receipt. Extracted from the travel-leg + itinerary integrations so every entity
// uses the same Create-receipt / View-in-Receipts / Unlink flow and the same
// entity→receipt link (`entity.receiptId`).
//
// Deliberately DOM-light and state-light: callers pass the container element, the
// current entity, and the planner; button ids follow `${idPrefix}CreateReceiptBtn`
// / `ViewReceiptBtn` / `UnlinkReceiptBtn` / `AttachBtn` so existing delegated click
// handlers keep working unchanged.

import { escapeHtml as esc } from './utils.js';
import { fileDisplayName } from './plannerFields.js';
import { makeReceipt } from './plannerReceipts.js';

/**
 * Render the receipt-status block for an entity modal.
 * @param {HTMLElement|null} container
 * @param {object} opts
 * @param {object|null} [opts.receipt] - the linked receipt, or null
 * @param {string} opts.idPrefix - e.g. 'personalItin' | 'personalLeg'
 * @param {boolean} [opts.canLink=true] - false → entity not yet saved (show hint)
 * @param {string} [opts.unsavedHint]
 * @param {string} [opts.emptyLabel='No receipt linked']
 * @param {boolean} [opts.showAttach=false] - offer an "Attach file" button
 * @param {string} [opts.filePath=''] - a file attached to the entity (no receipt yet)
 * @param {string} [opts.fileLabel='']
 * @param {boolean} [opts.showAmount=true] - show the receipt amount in the linked row
 */
export function renderEntityReceiptStatus(container, opts) {
  if (!container) return;
  const {
    receipt = null,
    idPrefix,
    canLink = true,
    unsavedHint = 'Save this first to move its cost to a receipt.',
    emptyLabel = 'No receipt linked',
    showAttach = false,
    filePath = '',
    fileLabel = '',
    showAmount = true,
  } = opts;

  if (receipt) {
    const amt =
      showAmount && receipt.amount
        ? ` · ${esc(receipt.currency || '')} ${esc(String(receipt.amount))}`
        : '';
    container.innerHTML = `
      <i class="fas fa-link text-[0.65rem] pl-accent flex-shrink-0" aria-hidden="true"></i>
      <span class="text-xs pl-ink-1 truncate flex-1">${esc(receipt.name || 'Receipt entry')}${amt}</span>
      <button type="button" id="${idPrefix}ViewReceiptBtn"
        class="h-8 px-3 border pl-rule rounded-md text-xs pl-accent transition-colors flex-shrink-0">
        <i class="fas fa-arrow-right mr-1 text-[0.65rem]" aria-hidden="true"></i>View in Receipts
      </button>
      <button type="button" id="${idPrefix}UnlinkReceiptBtn"
        class="h-8 px-2 border pl-rule rounded-md pl-ink-2 hover-req transition-colors flex-shrink-0"
        aria-label="Unlink receipt">
        <i class="fas fa-unlink text-[0.65rem]" aria-hidden="true"></i>
      </button>`;
    return;
  }

  if (!canLink) {
    container.innerHTML = `<span class="pl-hint flex-1 italic">${esc(unsavedHint)}</span>`;
    return;
  }

  const createBtn = `<button type="button" id="${idPrefix}CreateReceiptBtn"
    class="h-8 px-3 border pl-rule rounded-md pl-hint transition-colors flex-shrink-0">
    <i class="fas fa-receipt mr-1 text-[0.65rem]" aria-hidden="true"></i>Create receipt
  </button>`;
  const linkBtn = opts.showLink
    ? `<button type="button" id="${idPrefix}LinkReceiptBtn"
    class="h-8 px-3 border pl-rule rounded-md pl-hint transition-colors flex-shrink-0">
    <i class="fas fa-link mr-1 text-[0.65rem]" aria-hidden="true"></i>Link receipt
  </button>`
    : '';

  // showLink is the new "associate an existing receipt" flow — the primary action
  // for entities whose file/proof now lives on a receipt (travel legs, stays).
  if (opts.showLink) {
    container.innerHTML = `
      <span class="text-xs pl-ink-2 flex-1 italic">${esc(emptyLabel)}</span>
      ${linkBtn}
      ${createBtn}`;
    return;
  }

  if (showAttach && filePath) {
    container.innerHTML = `
      <i class="fas fa-paperclip text-[0.65rem] pl-ink-2 flex-shrink-0" aria-hidden="true"></i>
      <span class="pl-hint truncate flex-1">${esc(fileDisplayName(filePath, fileLabel))}</span>
      <button type="button" id="${idPrefix}AttachBtn"
        class="h-8 px-3 border pl-rule rounded-md pl-hint transition-colors flex-shrink-0">
        <i class="fas fa-paperclip mr-1 text-[0.65rem]" aria-hidden="true"></i>Replace
      </button>
      ${createBtn}`;
    return;
  }

  container.innerHTML = `
    <span class="text-xs pl-ink-2 flex-1 italic">${esc(emptyLabel)}</span>
    ${
      showAttach
        ? `<button type="button" id="${idPrefix}AttachBtn"
        class="h-8 px-3 border pl-rule rounded-md pl-hint transition-colors flex-shrink-0">
        <i class="fas fa-paperclip mr-1 text-[0.65rem]" aria-hidden="true"></i>Attach file
      </button>`
        : ''
    }
    ${createBtn}`;
}

/**
 * Create a receipt seeded from an entity, push it onto the planner, and link it
 * (`entity.receiptId`). Returns the new receipt.
 * @param {object} planner - state.planner
 * @param {object} entity - the entity gaining a `receiptId`
 * @param {object} [seed] - { name, date, amount, currency, category, filePath, fileLabel }
 */
export function createReceiptForEntity(planner, entity, seed = {}) {
  const receipt = makeReceipt();
  if (seed.name) receipt.name = seed.name;
  receipt.date = seed.date || '';
  receipt.amount = seed.amount || '';
  if (seed.currency) receipt.currency = seed.currency;
  receipt.category = seed.category || 'misc';
  if (seed.filePath) receipt.filePath = seed.filePath;
  if (seed.fileLabel) receipt.fileLabel = seed.fileLabel;
  planner.receipts = [...(planner.receipts || []), receipt];
  entity.receiptId = receipt.id;
  return receipt;
}

/** Link an entity to an existing receipt by id. */
export function linkEntityReceipt(entity, receiptId) {
  if (entity) entity.receiptId = receiptId || '';
}

/** Clear an entity's receipt link. */
export function unlinkEntityReceipt(entity) {
  if (entity) entity.receiptId = '';
}

// ── Searchable "link an existing receipt" picker ─────────────────────────────
function _rcpickKey(e) {
  if (e.key === 'Escape') closeReceiptPicker();
}
export function closeReceiptPicker() {
  document.querySelector('.rcpick-overlay')?.remove();
  document.body.style.overflow = '';
  document.removeEventListener('keydown', _rcpickKey, true);
}

/**
 * Open a searchable list of the planner's receipts to associate one with an entity.
 * @param {object} planner - state.planner (source of the receipt list)
 * @param {object} handlers - { onPick(receiptId), onCreate() }
 */
export function openReceiptPicker(planner, { onPick, onCreate } = {}) {
  closeReceiptPicker();
  const receipts = planner?.receipts || [];
  const ov = document.createElement('div');
  ov.className = 'rcpick-overlay';
  ov.setAttribute('role', 'dialog');
  ov.setAttribute('aria-modal', 'true');
  ov.setAttribute('aria-label', 'Link a receipt');
  ov.innerHTML = `
    <div class="rcpick">
      <div class="rcpick-head">
        <span class="rcpick-title">Link a receipt</span>
        <button type="button" class="rcpick-close" aria-label="Close"><i class="fas fa-xmark"></i></button>
      </div>
      <div class="rcpick-search"><i class="fas fa-magnifying-glass" aria-hidden="true"></i><input type="text" class="rcpick-input" placeholder="Search receipts…" autocomplete="off"></div>
      <div class="rcpick-list"></div>
      <button type="button" class="rcpick-create"><i class="fas fa-plus" aria-hidden="true"></i>Create a new receipt instead</button>
    </div>`;
  document.body.appendChild(ov);
  document.body.style.overflow = 'hidden';

  const listEl = ov.querySelector('.rcpick-list');
  const input = ov.querySelector('.rcpick-input');
  const rowHtml = (r) => {
    const meta = [r.date, r.amount ? `${r.currency || ''} ${r.amount}`.trim() : '', r.category]
      .filter(Boolean)
      .join(' · ');
    return `<button type="button" class="rcpick-row" data-id="${esc(r.id)}"><span class="rcpick-row-name">${esc(r.name || 'Untitled receipt')}</span>${meta ? `<span class="rcpick-row-meta">${esc(meta)}</span>` : ''}</button>`;
  };
  const draw = (q) => {
    const term = q.trim().toLowerCase();
    const hits = receipts.filter(
      (r) =>
        !term ||
        (r.name || '').toLowerCase().includes(term) ||
        (r.category || '').toLowerCase().includes(term),
    );
    listEl.innerHTML = hits.length
      ? hits.map(rowHtml).join('')
      : `<p class="rcpick-empty">${receipts.length ? 'No receipts match your search.' : 'No receipts yet — create one below.'}</p>`;
  };
  draw('');
  input.addEventListener('input', () => draw(input.value));
  ov.addEventListener('click', (e) => {
    if (e.target === ov || e.target.closest('.rcpick-close')) {
      closeReceiptPicker();
      return;
    }
    const row = e.target.closest('.rcpick-row');
    if (row) {
      closeReceiptPicker();
      onPick?.(row.dataset.id);
      return;
    }
    if (e.target.closest('.rcpick-create')) {
      closeReceiptPicker();
      onCreate?.();
    }
  });
  document.addEventListener('keydown', _rcpickKey, true);
  setTimeout(() => input.focus(), 30);
}

/** The receipt referenced by an entity's `receiptId`, or null. */
export function linkedReceipt(planner, entity) {
  return entity?.receiptId
    ? (planner?.receipts || []).find((r) => r.id === entity.receiptId) || null
    : null;
}
