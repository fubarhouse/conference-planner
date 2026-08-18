// Receipts tab for the planner — receipt records, the add/edit modal (including
// file attachment), and delete-with-undo. Extracted from planner.js following
// the plannerNotes/plannerTasks/plannerContacts contract: planner-internal
// collaborators are supplied once via initReceipts(); shared field/format helpers
// and storage/modal utilities are imported directly.

import { escapeHtml as esc } from './utils.js';
import { showModal, hideModal } from './modal.js';
import { showUndoToast } from './notify.js';
import { makeItemId } from './plannerStorage.js';
import {
  currencyOptions,
  getDefaultCurrency,
  buildSelectOptions,
  syncModalFile,
  parseBudget,
  formatAmount,
} from './plannerFields.js';

// ── Injected planner collaborators ────────────────────────────────────────────
let state;
let scheduleAutoSave;
let renderListPanel;
let getActiveBudgetCategoryOptions;
let renderPersonalBudgetBreakdown;
let renderSponsorBudgetBreakdown;
let renderBudgetItems;
let renderDocumentsTab;
let uploadOrReadFile;
let deleteUploadedFile;
let syncReceipt;
let renderBudgetTab;
let renderSummaryTab;

export function initReceipts(deps) {
  ({
    state,
    scheduleAutoSave,
    renderListPanel,
    getActiveBudgetCategoryOptions,
    renderPersonalBudgetBreakdown,
    renderSponsorBudgetBreakdown,
    renderBudgetItems,
    renderDocumentsTab,
    uploadOrReadFile,
    deleteUploadedFile,
    syncReceipt,
    renderBudgetTab,
    renderSummaryTab,
  } = deps);
}

// Re-render every surface a receipt change can affect: the receipts list, the budget
// breakdowns + budget tab (category actuals), budget items (linked totals), the
// documents list (attachments), and the summary when it's the active tab.
function refreshAfterReceiptChange() {
  renderReceiptsTab();
  renderPersonalBudgetBreakdown();
  renderSponsorBudgetBreakdown();
  renderBudgetItems('personal');
  renderBudgetItems('sponsor');
  renderBudgetTab?.();
  renderDocumentsTab?.();
  if (state.activeTab === 'summary') renderSummaryTab?.();
}

export function makeReceipt() {
  const currency =
    state.planner?.mode === 'sponsor'
      ? state.planner?.org?.sponsorCurrency || 'AUD'
      : state.planner?.personal?.currency || 'AUD';
  return {
    id: makeItemId('rc'),
    name: '',
    date: '',
    amount: '',
    currency,
    category: 'misc',
    budgetItemId: '',
    filePath: '',
    fileLabel: '',
    notes: '',
  };
}

function budgetItemDropdownOptions(selectedId) {
  // Scope to the active mode's budget items — a personal receipt shouldn't offer
  // org budget items (and vice versa).
  const isOrg = (state.planner?.mode || 'personal') === 'sponsor';
  const items =
    (isOrg ? state.planner?.org?.budgetItems : state.planner?.personal?.budgetItems) || [];
  const opt = (i) =>
    `<option value="${esc(i.id)}"${selectedId === i.id ? ' selected' : ''}>${esc(i.name || 'Budget item')}</option>`;
  return ['<option value="">— No budget item —</option>', ...items.map(opt)].join('');
}

// A ledger line: date · name + category code · right-aligned mono amount · a
// gold clip when a copy is attached. The whole row is the edit affordance.
function receiptCardHtml(receipt) {
  const catLabel =
    getActiveBudgetCategoryOptions().find((c) => c.value === receipt.category)?.label ||
    receipt.category ||
    '';
  const d = receipt.date ? new Date(receipt.date + 'T00:00:00') : null;
  const dateStr =
    d && !Number.isNaN(d.getTime())
      ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
      : '—';
  const amt =
    receipt.amount !== '' && receipt.amount != null
      ? formatAmount(parseBudget(receipt.amount))
      : '';
  const documented = !!receipt.filePath;
  return `
    <button type="button" class="rcpt-row edit-receipt-btn" data-receipt-id="${esc(receipt.id)}" aria-label="Edit ${esc(receipt.name || 'receipt')}">
      <span class="rcpt-date">${esc(dateStr)}</span>
      <span class="rcpt-main">
        <span class="rcpt-name">${esc(receipt.name || 'Untitled')}</span>
        ${catLabel ? `<span class="rcpt-cat">${esc(catLabel)}</span>` : ''}
      </span>
      <span class="rcpt-amt">${amt ? `${esc(amt)}<span class="rcpt-cur">${esc(receipt.currency || '')}</span>` : '<span class="rcpt-amt-none">—</span>'}</span>
      <span class="rcpt-doc rcpt-doc--${documented ? 'yes' : 'no'}" title="${documented ? 'Copy attached' : 'No copy attached'}">${documented ? 'Copy' : '&mdash;'}</span>
    </button>`;
}

// The receipt-stub statement: per-currency totals (no fake conversion for a
// mixed-currency trip) + how many entries still need a copy attached.
function statementHtml(receipts) {
  const byCur = {};
  for (const r of receipts) {
    const c = String(r.currency || '').trim() || '—';
    byCur[c] = (byCur[c] || 0) + parseBudget(r.amount);
  }
  const totals = Object.entries(byCur)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  const totalHtml = totals.length
    ? totals
        .map(
          ([c, v]) =>
            `<span class="rcpt-total">${esc(formatAmount(v))}<span class="rcpt-cur">${esc(c)}</span></span>`,
        )
        .join('<span class="rcpt-dot">·</span>')
    : `<span class="rcpt-total rcpt-amt-none">—</span>`;
  const n = receipts.length;
  const doc = receipts.filter((r) => r.filePath).length;
  const missing = n - doc;
  const meta = [
    `${n} receipt${n === 1 ? '' : 's'}`,
    doc ? `<b>${doc}</b> documented` : '',
    missing ? `${missing} to attach` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return `
    <div class="rcpt-statement">
      <div class="rcpt-stmt-label">Total spent</div>
      <div class="rcpt-totals">${totalHtml}</div>
      <div class="rcpt-meta">${meta}</div>
    </div>`;
}

let _receiptModalId = null;
let _receiptModalFilePath = '';
let _receiptModalFileLabel = '';

export function openReceiptModal(id) {
  _receiptModalId = id;
  const receipt = id ? (state.planner.receipts || []).find((r) => r.id === id) : null;
  document.getElementById('receiptModalTitle').textContent = id ? 'Edit Receipt' : 'Add Receipt';
  document.getElementById('receiptModalName').value = receipt?.name || '';
  document.getElementById('receiptModalDate').value = receipt?.date || '';
  document.getElementById('receiptModalAmount').value = receipt?.amount || '';
  document.getElementById('receiptModalNotes').value = receipt?.notes || '';
  document.getElementById('receiptModalCurrency').innerHTML = currencyOptions(
    receipt?.currency || getDefaultCurrency(),
  );
  document.getElementById('receiptModalCategory').innerHTML = buildSelectOptions(
    getActiveBudgetCategoryOptions(),
    receipt?.category || '',
  );
  document.getElementById('receiptModalBudgetItem').innerHTML = budgetItemDropdownOptions(
    receipt?.budgetItemId || '',
  );
  _receiptModalFilePath = receipt?.filePath || '';
  _receiptModalFileLabel = receipt?.fileLabel || '';
  syncModalFile(
    _receiptModalFilePath,
    _receiptModalFileLabel,
    'receiptModalFileLabel',
    'receiptModalRemoveFileBtn',
  );
  document.getElementById('receiptModalDelete')?.classList.toggle('hidden', !id);
  showModal('receiptModal', 'receiptModalName');
}

function saveReceiptModal() {
  const isNew = !_receiptModalId;
  const id = _receiptModalId || makeItemId('rc');
  const data = {
    id,
    name: document.getElementById('receiptModalName').value.trim(),
    date: document.getElementById('receiptModalDate').value,
    amount: document.getElementById('receiptModalAmount').value.trim(),
    currency: document.getElementById('receiptModalCurrency').value,
    category: document.getElementById('receiptModalCategory').value,
    budgetItemId: document.getElementById('receiptModalBudgetItem').value,
    notes: document.getElementById('receiptModalNotes').value.trim(),
    filePath: _receiptModalFilePath,
    fileLabel: _receiptModalFileLabel,
  };
  if (isNew) {
    state.planner.receipts = [...(state.planner.receipts || []), data];
  } else {
    const idx = (state.planner.receipts || []).findIndex((r) => r.id === id);
    if (idx !== -1) state.planner.receipts[idx] = data;
  }
  syncReceipt?.('upsert', data); // best-effort per-collection API sync (Phase 4)
  closeReceiptModal();
  refreshAfterReceiptChange();
  scheduleAutoSave();
}

function closeReceiptModal() {
  hideModal('receiptModal');
  _receiptModalId = null;
  _receiptModalFilePath = '';
  _receiptModalFileLabel = '';
}

export function renderReceiptsTab() {
  const receipts = state.planner.receipts || [];
  renderListPanel('receiptsList', 'receiptsEmptyState', receipts, receiptCardHtml);
  const stmt = document.getElementById('receiptsStatement');
  if (stmt) {
    stmt.classList.toggle('hidden', receipts.length === 0);
    stmt.innerHTML = receipts.length ? statementHtml(receipts) : '';
  }
}

export function wireReceiptsPanel() {
  document.getElementById('plannerReceiptsPanel')?.addEventListener('click', (e) => {
    if (e.target.closest('.rcpt-add')) {
      openReceiptModal(null);
      return;
    }
    const editBtn = e.target.closest('.edit-receipt-btn');
    if (editBtn) {
      openReceiptModal(editBtn.dataset.receiptId);
      return;
    }
  });

  // Receipt modal controls
  document.getElementById('receiptModalClose')?.addEventListener('click', closeReceiptModal);
  document.getElementById('receiptModalDone')?.addEventListener('click', saveReceiptModal);
  document.getElementById('receiptModal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeReceiptModal();
  });

  document.getElementById('receiptModalDelete')?.addEventListener('click', () => {
    if (!_receiptModalId) return;
    const id = _receiptModalId;
    const snapshot = (state.planner.receipts || []).find((r) => r.id === id);
    if (!snapshot) return;
    state.planner.receipts = (state.planner.receipts || []).filter((r) => r.id !== id);
    syncReceipt?.('delete', { id }); // best-effort per-collection API sync (Phase 4)
    closeReceiptModal();
    refreshAfterReceiptChange();
    scheduleAutoSave();
    // Clean up the stored file after the undo window closes, so an undo keeps it.
    const fileCleanup = snapshot.filePath
      ? setTimeout(() => deleteUploadedFile?.(snapshot.filePath), 6000)
      : null;
    showUndoToast(snapshot.name || 'Receipt', () => {
      if (fileCleanup) clearTimeout(fileCleanup);
      state.planner.receipts = [...(state.planner.receipts || []), snapshot];
      syncReceipt?.('upsert', snapshot); // undo → re-create on the server
      refreshAfterReceiptChange();
      scheduleAutoSave();
    });
  });

  document.getElementById('receiptModalAttachBtn')?.addEventListener('click', () => {
    const fi = document.getElementById('receiptFileInput');
    if (fi) {
      fi.dataset.target = 'receiptModal';
      fi.click();
    }
  });

  document.getElementById('receiptModalRemoveFileBtn')?.addEventListener('click', () => {
    _receiptModalFilePath = '';
    _receiptModalFileLabel = '';
    syncModalFile(
      _receiptModalFilePath,
      _receiptModalFileLabel,
      'receiptModalFileLabel',
      'receiptModalRemoveFileBtn',
    );
  });

  document.getElementById('receiptFileInput')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const target = e.target.dataset.target;

    if (target === 'receiptModal') {
      try {
        const desiredName = document.getElementById('receiptModalName')?.value || '';
        const { path, label } = await uploadOrReadFile(file, 'receipts', desiredName);
        _receiptModalFilePath = path;
        _receiptModalFileLabel = label;
        syncModalFile(
          _receiptModalFilePath,
          _receiptModalFileLabel,
          'receiptModalFileLabel',
          'receiptModalRemoveFileBtn',
        );
      } catch (err) {
        window.alert(err.message);
      }
    } else {
      // Legacy path: file attach from outside modal (e.g. personal leg receipt creation)
      const rid = e.target.dataset.receiptId;
      const receipt = (state.planner.receipts || []).find((r) => r.id === rid);
      if (receipt) {
        try {
          const { path, label } = await uploadOrReadFile(file, 'receipts', receipt.name || '');
          receipt.filePath = path;
          receipt.fileLabel = label;
          renderReceiptsTab();
          renderDocumentsTab();
          scheduleAutoSave();
        } catch (err) {
          window.alert(err.message);
        }
      }
    }
    e.target.value = '';
  });
}

// Static shell for this tab panel — injected into #plannerReceiptsPanel at boot (#7 co-location).
export function receiptsPanelHtml() {
  return `
          <section>
            <div class="pln-section__head">
              <div>
                <p class="pln-eyebrow">Every cost</p>
                <h2 class="pln-section__title">Receipts</h2>
              </div>
              <button id="addReceiptBtn" type="button" class="rcpt-add pl-add-btn">Add receipt</button>
            </div>
            <div id="receiptsStatement" class="hidden"></div>
            <div id="receiptsList" class="rcpt-ledger"></div>
            <div id="receiptsEmptyState" class="hidden jrn-empty">
              <p class="jrn-empty-t">No spending recorded yet</p>
              <p class="jrn-empty-s">Every cost on the trip lives here. Add a receipt to start the statement.</p>
              <button type="button" class="rcpt-add jrn-empty-btn">Add the first receipt</button>
            </div>
            <input id="receiptFileInput" type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" class="sr-only">
            <input id="personalLegFileInput" type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" class="sr-only">
            <input id="legFileInput" type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" class="sr-only">
            <input id="personalAccomFileInput" type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" class="sr-only">
            <input id="accomFileInput" type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" class="sr-only">
            <input id="docFileInput" type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.doc,.docx,.xls,.xlsx,.ppt,.pptx" class="sr-only">
          </section>
        `;
}
