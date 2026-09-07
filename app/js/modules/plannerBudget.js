// Budget cluster — event budget categories, per-context budget items (+ modal),
// the sponsor/personal budget tabs, and category management. The lynchpin the
// receipt/document/org/personal/summary code reads; kept cycle-free by importing
// only pure helpers and taking everything else via initBudget() injection.

import { escapeHtml as esc } from './utils.js';
import {
  parseBudget,
  formatAmount,
  buildSelectOptions,
  currencyOptions,
  plannerDisplayCurrency,
} from './plannerFields.js';
import { emptyStateP } from './renderKit.js';
import { makeItemId } from './plannerStorage.js';
import { buildConvFn, fetchRates, hasRate, clampRateDate } from './currency.js';

// ── Injected planner collaborators ────────────────────────────────────────────
let state;
let scheduleAutoSave;
let createModal;
let renderSummaryTab;
let renderSponsorBudgetBreakdown;
let renderPersonalBudgetBreakdown;
let buildEventBudgetData;
let buildPersonalBudgetData;
let renderReceiptsTab;
let openReceiptModal;
let setActiveTab;

// Created in initBudget once the createModal factory has been injected (a
// top-level `createModal(...)` would run before injection and throw).
let _budgetItemModal;

export function initBudget(deps) {
  ({
    state,
    scheduleAutoSave,
    createModal,
    renderSummaryTab,
    renderSponsorBudgetBreakdown,
    renderPersonalBudgetBreakdown,
    buildEventBudgetData,
    buildPersonalBudgetData,
    renderReceiptsTab,
    openReceiptModal,
    setActiveTab,
  } = deps);

  _budgetItemModal = createModal('budgetItemModal', {
    onSave: saveBudgetItem,
    onDelete: () => {
      if (!_budgetItemCtx || !_budgetItemId) return;
      const list = getBudgetItemList(_budgetItemCtx);
      const idx = list.findIndex((i) => i.id === _budgetItemId);
      if (idx !== -1) list.splice(idx, 1);
      // Clear stale references so linked receipts aren't lost from accounting
      (state.planner.receipts || []).forEach((r) => {
        if (r.budgetItemId === _budgetItemId) r.budgetItemId = '';
      });
      scheduleAutoSave();
    },
    onClose: afterBudgetItemClose,
  });
}

let _budgetItemCtx = null; // 'personal' | 'sponsor'
let _budgetItemId = null;

function getBudgetItemList(ctx) {
  if (ctx === 'personal') return (state.planner.personal.budgetItems ??= []);
  return (state.planner.org.budgetItems ??= []);
}

let _defaultBudgetCategories = [
  { id: 'travel', name: 'Travel' },
  { id: 'accommodation', name: 'Accommodation' },
  { id: 'food', name: 'Food & Drink' },
  { id: 'customer', name: 'Customer' },
  { id: 'team', name: 'Team' },
  { id: 'tickets', name: 'Tickets' },
  { id: 'swag', name: 'Swag' },
  { id: 'sponsor', name: 'Sponsor' },
  { id: 'marketing', name: 'Marketing' },
  { id: 'misc', name: 'Misc' },
];

export function getEventBudgetCategories(mode) {
  const stored =
    mode === 'personal'
      ? state.planner?.personal?.budgetCategories || []
      : state.planner?.org?.budgetCategories || [];
  return stored.length ? stored : _defaultBudgetCategories;
}

export function budgetCatList(mode) {
  return getEventBudgetCategories(mode).map((c) => ({ value: c.id, label: c.name }));
}

function BUDGET_ITEM_CATS_PERSONAL() {
  return budgetCatList('personal');
}
function BUDGET_ITEM_CATS_SPONSOR() {
  return budgetCatList('org');
}

// Returns budget categories for the active mode as { value, label } pairs.
// Used by receipts, documents, and any other place that should stay in sync
// with the event's configured budget categories.
export function getActiveBudgetCategoryOptions() {
  const mode = state.planner?.mode || 'personal';
  return getEventBudgetCategories(mode === 'sponsor' ? 'org' : 'personal').map((c) => ({
    value: c.id,
    label: c.name,
  }));
}

// Compact "3 Sep 2025" for a YYYY-MM-DD purchase date (noon-anchored to dodge
// timezone rollback). Falls back to the raw string if it isn't a clean ISO date.
function fmtShortDate(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function renderBudgetItems(ctx) {
  // One destination each now. The personal list used to render into the Planner
  // tab as well; that copy is gone, so this reads the Budget tab's own ids.
  const containerIds = ctx === 'personal' ? ['personalBudgetTabItems'] : ['sponsorBudgetItems'];
  // The filter is the Budget tab's own input. It was pointed at the Planner
  // tab's box, so typing in the box next to this list re-rendered it using a
  // DIFFERENT field's value — the visible filter did nothing.
  const filterId = ctx === 'personal' ? 'personalBudgetTabFilter' : 'sponsorBudgetItemFilter';
  const container = document.getElementById(containerIds[0]);
  if (!container) return;

  const filterQ = (document.getElementById(filterId)?.value || '').trim().toLowerCase();
  const allItems = getBudgetItemList(ctx);
  const cats = ctx === 'personal' ? BUDGET_ITEM_CATS_PERSONAL() : BUDGET_ITEM_CATS_SPONSOR();
  const fmt = (n) => formatAmount(parseBudget(n));

  const resolveMember = (memberId) =>
    memberId ? (state.global?.teamMembers || []).find((m) => m.id === memberId)?.name || '' : '';

  const items = filterQ
    ? allItems.filter((item) => {
        const catLabel =
          cats.find((c) => c.value === item.category)?.label || item.category || 'misc';
        const memberName = resolveMember(item.memberId);
        return (
          (item.name || '').toLowerCase().includes(filterQ) ||
          catLabel.toLowerCase().includes(filterQ) ||
          memberName.toLowerCase().includes(filterQ)
        );
      })
    : allItems;

  const setHtml = (html) =>
    containerIds.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = html;
    });

  if (!allItems.length) {
    setHtml(emptyStateP('No items added yet.'));
    return;
  }

  if (!items.length) {
    setHtml(emptyStateP('No items match the filter.'));
    return;
  }

  setHtml(
    items
      .map((item) => {
        const catLabel =
          cats.find((c) => c.value === item.category)?.label || item.category || 'Misc';
        const memberName = resolveMember(item.memberId);
        const b = parseBudget(item.budget);
        const cur = item.currency || plannerDisplayCurrency(state.planner);
        const linked = (state.planner.receipts || []).filter((r) => r.budgetItemId === item.id);
        const receiptTotal = linked.reduce((s, r) => s + parseBudget(r.amount), 0);
        // Actual now comes only from linked receipts (Pattern A).
        const effectiveActual = receiptTotal;
        const over = b > 0 && effectiveActual > b;
        const bSet = item.budget !== '' && item.budget != null;
        // The whole card opens the budget-item editor (which owns cost + receipts +
        // delete); no separate edit button. Reuses the existing .edit-budget-item-btn
        // click hook so wiring is unchanged.
        return `<button type="button" class="bdg-item pl-open edit-budget-item-btn"
        data-bi-ctx="${esc(ctx)}" data-bi-id="${esc(item.id)}" aria-label="Edit ${esc(item.name || 'item')}">
      <div class="bdg-item-main">
        <p class="bdg-item-name">
          <span>${esc(item.name || 'Budget item')}</span>
          <span class="bdg-tag">${esc(catLabel)}</span>
          ${item.purchaseDate ? `<span class="bdg-tag" title="Purchase date">${esc(fmtShortDate(item.purchaseDate))}</span>` : ''}
          ${memberName ? `<span class="bdg-tag bdg-tag--who">${esc(memberName)}</span>` : ''}
        </p>
        <p class="bdg-item-nums">
          ${bSet ? `<span>Budget <b>${esc(cur)} ${fmt(b)}</b></span>` : ''}
          ${
            linked.length
              ? `<span>Actual · ${linked.length} receipt${linked.length !== 1 ? 's' : ''} <b class="${over ? 'is-over' : ''}">${esc(cur)} ${fmt(receiptTotal)}</b></span>`
              : ''
          }
          ${!bSet && !linked.length ? `<span class="bdg-item-none">${esc(cur)} —</span>` : ''}
        </p>
      </div>
      <span class="pl-open-go" aria-hidden="true">&rsaquo;</span>
    </button>`;
      })
      .join(''),
  );
}

// The budget-item modal's fields, resolved once. The modal markup is fixed in
// planner.html, so a single cached map beats re-querying ~20 ids per open/save
// and documents the modal's DOM contract in one place.
let _els = null;
function els() {
  return (_els ??= {
    title: document.getElementById('budgetItemModalTitle'),
    name: document.getElementById('budgetItemName'),
    category: document.getElementById('budgetItemCategory'),
    currency: document.getElementById('budgetItemCurrency'),
    budget: document.getElementById('budgetItemBudget'),
    notes: document.getElementById('budgetItemNotes'),
    assignedRow: document.getElementById('budgetItemAssignedToRow'),
    assignedTo: document.getElementById('budgetItemAssignedTo'),
    delete: document.getElementById('budgetItemModalDelete'),
  });
}

function openBudgetItemModal(ctx, id = null) {
  _budgetItemCtx = ctx;
  _budgetItemId = id;
  const m = els();

  const cats = ctx === 'personal' ? BUDGET_ITEM_CATS_PERSONAL() : BUDGET_ITEM_CATS_SPONSOR();
  const item = id ? getBudgetItemList(ctx).find((i) => i.id === id) : null;
  if (m.category) m.category.innerHTML = buildSelectOptions(cats, item?.category || '');

  // Currency for the planned budget amount (actual comes from each receipt's own
  // currency). Defaults to the trip's roll-up currency for a new line item.
  if (m.currency)
    m.currency.innerHTML = currencyOptions(item?.currency || plannerDisplayCurrency(state.planner));

  // "Assigned to" — sponsor mode only, populated from event team assignments
  const isSponsor = ctx === 'sponsor';
  if (m.assignedRow) m.assignedRow.classList.toggle('hidden', !isSponsor);
  if (isSponsor && m.assignedTo) {
    const assignedIds = new Set((state.planner.org?.teamAssignments || []).map((a) => a.memberId));
    const members = (state.global?.teamMembers || []).filter(
      (mem) => mem.enabled !== false && assignedIds.has(mem.id),
    );
    m.assignedTo.innerHTML =
      `<option value="">— Unassigned —</option>` +
      members
        .map(
          (mem) =>
            `<option value="${esc(mem.id)}"${mem.id === (item?.memberId || '') ? ' selected' : ''}>${esc(mem.name)}${mem.role ? ` (${esc(mem.role)})` : ''}</option>`,
        )
        .join('');
  }

  m.title.textContent = id ? 'Edit Budget Item' : 'Add Budget Item';
  m.name.value = item?.name || '';
  m.budget.value = item?.budget || '';
  m.notes.value = item?.notes || '';

  m.budget?.classList.remove('!border-red-400');
  renderBudgetItemReceiptStatus();
  m.delete?.classList.toggle('hidden', !id);
  _budgetItemModal.open('budgetItemName');
}

// The Receipts block in the budget-item modal — budget items aggregate MANY receipts
// (Pattern A: actual = sum of linked receipts via receipt.budgetItemId). Shows the
// linked count + total and a Create-receipt button. A brand-new (unsaved) item must be
// saved first so receipts have an item id to attach to.
function renderBudgetItemReceiptStatus() {
  const container = document.getElementById('budgetItemReceiptStatus');
  if (!container) return;
  if (!_budgetItemId) {
    container.innerHTML =
      '<span class="text-xs pl-ink-2 italic">Save this item first to add receipts.</span>';
    return;
  }
  const linked = (state.planner.receipts || []).filter((r) => r.budgetItemId === _budgetItemId);
  const cur = plannerDisplayCurrency(state.planner);
  const total = linked.reduce((s, r) => s + parseBudget(r.amount), 0);
  const summary = linked.length
    ? `<span class="bdg-item-nums">${linked.length} receipt${linked.length !== 1 ? 's' : ''} · ${esc(cur)} ${formatAmount(total)}</span>`
    : '<span class="text-xs pl-ink-2 italic">No receipts yet</span>';
  const createBtn = `<button type="button" id="budgetItemCreateReceiptBtn" class="set-btn">Create receipt</button>`;
  const viewBtn = linked.length
    ? `<button type="button" id="budgetItemViewReceiptsBtn" class="h-8 px-3 border pl-rule rounded-md pl-hint transition-colors">View in Receipts</button>`
    : '';
  container.innerHTML = `${summary}<span class="flex-1"></span>${createBtn}${viewBtn}`;
}

// Create a receipt pre-linked to this budget item (Pattern A) and open it so cost is
// entered on the receipt. Closes the budget-item modal to avoid modal stacking.
function createReceiptForBudgetItem() {
  if (!_budgetItemCtx || !_budgetItemId) return;
  const item = getBudgetItemList(_budgetItemCtx).find((i) => i.id === _budgetItemId);
  if (!item) return;
  const receipt = {
    id: makeItemId('rc'),
    name: item.name || 'Budget item',
    date: '',
    amount: '',
    currency: item.currency || plannerDisplayCurrency(state.planner),
    category: item.category || 'misc',
    budgetItemId: item.id,
    filePath: '',
    fileLabel: '',
    notes: '',
  };
  state.planner.receipts = [...(state.planner.receipts || []), receipt];
  scheduleAutoSave();
  renderReceiptsTab();
  _budgetItemModal.close();
  openReceiptModal?.(receipt.id);
}

function saveBudgetItem() {
  if (!_budgetItemCtx) return;
  const list = getBudgetItemList(_budgetItemCtx);
  const m = els();
  const name = m.name?.value.trim() || '';
  const category = m.category?.value || 'misc';
  const currency = m.currency?.value || plannerDisplayCurrency(state.planner);
  const budget = m.budget?.value || '';
  const notes = m.notes?.value.trim() || '';
  const memberId = _budgetItemCtx === 'sponsor' ? m.assignedTo?.value || '' : '';

  if (_budgetItemId) {
    const item = list.find((i) => i.id === _budgetItemId);
    if (item) Object.assign(item, { name, category, currency, budget, notes, memberId });
  } else {
    const newItem = { id: makeItemId('bi'), name, category, currency, budget, notes, memberId };
    list.push(newItem);
    _budgetItemId = newItem.id;
  }
  scheduleAutoSave();
}

function afterBudgetItemClose() {
  const ctx = _budgetItemCtx;
  _budgetItemCtx = null;
  _budgetItemId = null;
  if (!ctx) return;
  renderBudgetItems(ctx);
  if (ctx === 'personal') renderPersonalBudgetBreakdown();
  else renderSponsorBudgetBreakdown();
  renderBudgetTab(); // main budget pane's category rows (actuals move between categories)
  renderReceiptsTab();
  if (state.activeTab === 'summary') renderSummaryTab();
}

export function wireBudgetItemsPanel() {
  // Validate the required Budget amount before the modal's own Done handler fires
  document.getElementById('budgetItemModalDone')?.addEventListener('click', (e) => {
    const budgetEl = document.getElementById('budgetItemBudget');
    if (budgetEl?.value === '') {
      budgetEl.classList.add('!border-red-400');
      budgetEl.focus();
      e.stopImmediatePropagation();
    }
  });

  // Receipt controls inside the budget-item modal (Pattern A: many receipts → one item)
  document.getElementById('budgetItemModal')?.addEventListener('click', (e) => {
    if (e.target.closest('#budgetItemCreateReceiptBtn')) {
      createReceiptForBudgetItem();
      return;
    }
    if (e.target.closest('#budgetItemViewReceiptsBtn')) {
      _budgetItemModal.close();
      setActiveTab?.('receipts');
    }
  });

  _budgetItemModal.wire();

  document
    .getElementById('addSponsorBudgetItemBtn')
    ?.addEventListener('click', () => openBudgetItemModal('sponsor'));

  document
    .getElementById('sponsorBudgetItemFilter')
    ?.addEventListener('input', () => renderBudgetItems('sponsor'));

  // Edit delegation — sponsor budget items list
  document.getElementById('sponsorBudgetItems')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.edit-budget-item-btn');
    if (btn) openBudgetItemModal(btn.dataset.biCtx, btn.dataset.biId);
  });
}

export function renderBudgetCategoryManager(mode) {
  const containerId =
    mode === 'personal' ? 'personalBudgetCategoryList' : 'sponsorBudgetCategoryList';
  const container = document.getElementById(containerId);
  if (!container) return;
  const cats = getEventBudgetCategories(mode);
  container.innerHTML = cats
    .map(
      (c) => `
    <div class="bdg-catchip" data-cat-id="${esc(c.id)}" data-cat-mode="${mode}">
      <span class="flex-1">${esc(c.name)}</span>
      <button type="button" class="remove-budget-cat-btn bdg-catchip__x" data-cat-id="${esc(c.id)}" data-cat-mode="${mode}" aria-label="Remove ${esc(c.name)} category">&times;</button>
    </div>`,
    )
    .join('');
}

export function addBudgetCategory(mode, name) {
  if (!name.trim()) return;
  const id = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
  const cats = getEventBudgetCategories(mode);
  if (cats.find((c) => c.id === id)) return;
  const stored =
    mode === 'personal'
      ? (state.planner.personal.budgetCategories ??= [])
      : (state.planner.org.budgetCategories ??= []);
  // If using defaults, copy them in first, then append
  if (!stored.length) stored.push(..._defaultBudgetCategories.map((c) => ({ ...c })));
  stored.push({ id, name: name.trim() });
  scheduleAutoSave();
  renderBudgetCategoryManager(mode);
}

// ── Shared budget-row markup ──────────────────────────────────────────────────
// One source of truth for the per-category rows and the actual/remaining
// indicator, used by both the personal and sponsor budget tabs (and by the live
// indicator update). Pure string builders — no DOM, so unit-testable.

const fmtBudget = (n) => (n ? formatAmount(n) : '—');

// The actual + remaining figures shown on the right of each category row. When
// `approx` (the trip mixes currencies, so the actual was converted) a leading ≈
// flags that the figure is an approximate trip-currency equivalent.
// A category's spend meter + mono actual/remaining line. The gold fill grows to
// the target and turns red once overspent — the Budget page's signature.
export function budgetIndicatorHtml(actual, budgetNum, approx = false) {
  const a = approx ? '≈' : '';
  const hasTarget = budgetNum > 0;
  const over = hasTarget && actual > budgetNum;
  const pct = hasTarget ? Math.min((actual / budgetNum) * 100, 100) : 0;
  const remain = hasTarget ? budgetNum - actual : null;
  const meter = `<div class="bdg-meter${over ? ' bdg-meter--over' : ''}${hasTarget ? '' : ' bdg-meter--empty'}"><span class="bdg-meter-fill" style="width:${pct}%"></span></div>`;
  const actualStr = `<span class="bdg-actual${over ? ' is-over' : ''}">${actual ? a : ''}${fmtBudget(actual)}</span>`;
  let remainStr;
  if (remain === null) remainStr = `<span class="bdg-remain is-none">no target</span>`;
  else if (over)
    remainStr = `<span class="bdg-remain is-over">${a}${fmtBudget(Math.abs(remain))} over</span>`;
  else remainStr = `<span class="bdg-remain is-ok">${a}${fmtBudget(Math.abs(remain))} left</span>`;
  return `${meter}<span class="bdg-nums">${actualStr}${remainStr}</span>`;
}

// The section health summary — total committed vs total target, one big meter.
export function budgetSummaryHtml(actual, target, currency, approx = false) {
  const a = approx ? '≈' : '';
  const hasTarget = target > 0;
  const over = hasTarget && actual > target;
  const pct = hasTarget ? Math.min((actual / target) * 100, 100) : 0;
  const remain = hasTarget ? target - actual : null;
  const foot =
    remain === null
      ? `<div class="bdg-summary-foot is-none">Set category targets to track budget health</div>`
      : over
        ? `<div class="bdg-summary-foot is-over">Over budget by ${a}${fmtBudget(Math.abs(remain))}</div>`
        : `<div class="bdg-summary-foot is-ok">${a}${fmtBudget(Math.abs(remain))} remaining</div>`;
  return `<div class="bdg-summary${over ? ' is-over' : ''}">
      <div class="bdg-summary-top">
        <span class="bdg-summary-label">Committed</span>
        <span class="bdg-summary-amt">${esc(currency)} ${a}${fmtBudget(actual)}${hasTarget ? ` <span class="bdg-summary-of">of ${a}${fmtBudget(target)}</span>` : ''}</span>
      </div>
      <div class="bdg-meter bdg-meter--lg${over ? ' bdg-meter--over' : ''}${hasTarget ? '' : ' bdg-meter--empty'}"><span class="bdg-meter-fill" style="width:${pct}%"></span></div>
      ${foot}
    </div>`;
}

// Sum a category-actuals map + a category-budgets map into { actual, target }.
function budgetTotals(cats, catActuals, catBudgets) {
  let actual = 0;
  let target = 0;
  for (const c of cats) {
    actual += catActuals[c.id]?.actual || 0;
    target += parseBudget(catBudgets[c.id] || '');
  }
  return { actual, target };
}

// Build category actuals converted to the trip currency at the event date, and
// report whether any conversion actually happened (mixed currencies). Kicks off
// a rate fetch + re-render when the rates aren't cached yet.
function convertedCatActuals(mode, currency, rerender) {
  const rateDate = clampRateDate(state?.eventMeta?.startDate?.slice(0, 10) || '');
  if (currency && !hasRate(currency, rateDate)) {
    fetchRates(currency, rateDate)
      .then(() => rerender())
      .catch(() => {});
  }
  const conv = buildConvFn(currency, rateDate);
  const cats =
    mode === 'personal'
      ? buildPersonalBudgetData(state.planner, conv)
      : buildEventBudgetData(state.planner, null, conv);
  const mixed =
    !!conv &&
    Object.values(cats).some((c) => (c.items || []).some((it) => it.curr && it.curr !== currency));
  return { cats, mixed };
}

// Header + one row per category. `inputClass` distinguishes the personal vs
// sponsor input (each has its own wireBudgetPanel handler); `indicator` adds the
// data-cat-indicator hook that only the sponsor tab updates live.
export function budgetCategoryRowsHtml({
  cats,
  currency,
  catBudgets,
  catActuals,
  inputClass,
  indicator = false,
  approx = false,
}) {
  return (
    `<div class="bdg-cats">` +
    cats
      .map((c) => {
        const budgetVal = catBudgets[c.id] || '';
        const actual = catActuals[c.id]?.actual || 0;
        const budgetNum = parseBudget(budgetVal);
        return `<div class="bdg-cat">
        <div class="bdg-cat-head">
          <span class="bdg-cat-name">${esc(c.name)}</span>
          <label class="bdg-input" title="Target for ${esc(c.name)}">
            <span class="bdg-input-cur">${esc(currency)}</span>
            <input type="number" min="0" step="0.01" placeholder="0.00"
              class="${inputClass}" data-cat-id="${esc(c.id)}" value="${esc(budgetVal)}">
          </label>
        </div>
        <div class="bdg-cat-track"${indicator ? ` data-cat-indicator="${esc(c.id)}"` : ''}>
          ${budgetIndicatorHtml(actual, budgetNum, approx)}
        </div>
      </div>`;
      })
      .join('') +
    `</div>`
  );
}

function renderPersonalBudgetTab() {
  const personal = state.planner.personal;
  const currency = plannerDisplayCurrency(state.planner);

  const catsEl = document.getElementById('personalBudgetCategoryRows');
  if (catsEl) {
    const { cats: catActuals, mixed } = convertedCatActuals(
      'personal',
      currency,
      renderPersonalBudgetTab,
    );
    const cats = getEventBudgetCategories('personal');
    const catBudgets = personal.categoryBudgets || {};
    catsEl.innerHTML = budgetCategoryRowsHtml({
      cats,
      currency,
      catBudgets,
      catActuals,
      inputClass: 'personal-budget-cat-input',
      approx: mixed,
    });
    const sumEl = document.getElementById('personalBudgetSummary');
    if (sumEl) {
      const { actual, target } = budgetTotals(cats, catActuals, catBudgets);
      sumEl.innerHTML = budgetSummaryHtml(actual, target, currency, mixed);
    }
  }

  renderBudgetItems('personal');
  renderPersonalBudgetBreakdown();
}

export function renderBudgetTab() {
  const mode = state.planner.mode || 'personal';
  const strictToggle = document.getElementById('budgetStrictToggle');
  if (strictToggle) strictToggle.checked = !!state.planner.strictBudget;
  document.getElementById('budgetSponsorSection')?.classList.toggle('hidden', mode !== 'sponsor');
  document.getElementById('budgetPersonalSection')?.classList.toggle('hidden', mode !== 'personal');
  if (mode === 'personal') {
    renderPersonalBudgetTab();
    return;
  }

  const org = state.planner.org;
  const currency = org.sponsorCurrency || 'AUD';

  // Overall budget header fields
  const budgetEl = document.getElementById('orgSponsorBudget');
  const actualEl = document.getElementById('orgSponsorActual');
  const currencyEl = document.getElementById('orgSponsorCurrency');
  if (budgetEl) budgetEl.value = org.sponsorBudget || '';
  if (actualEl) actualEl.value = org.sponsorActual || '';
  if (currencyEl) currencyEl.innerHTML = currencyOptions(currency);

  // Per-category budget rows + the section health summary
  const catsEl = document.getElementById('budgetCategoryRows');
  if (catsEl) {
    const { cats: catActuals, mixed } = convertedCatActuals('org', currency, renderBudgetTab);
    const cats = getEventBudgetCategories('org');
    const catBudgets = org.categoryBudgets || {};
    catsEl.innerHTML = budgetCategoryRowsHtml({
      cats,
      currency,
      catBudgets,
      catActuals, // actual-only (budgets come from categoryBudgets)
      inputClass: 'budget-cat-input',
      indicator: true,
      approx: mixed,
    });
    const sumEl = document.getElementById('budgetSummary');
    if (sumEl) {
      const { actual, target } = budgetTotals(cats, catActuals, catBudgets);
      sumEl.innerHTML = budgetSummaryHtml(actual, target, currency, mixed);
    }
  }

  // Budget line items
  renderBudgetItems('sponsor');
  renderSponsorBudgetBreakdown();
}

function _updateCatBudgetIndicator(catId, budgetVal) {
  const el = document.querySelector(`[data-cat-indicator="${catId}"]`);
  if (!el) return;
  const currency = state.planner?.org?.sponsorCurrency || 'AUD';
  const { cats, mixed } = convertedCatActuals('org', currency, renderBudgetTab);
  const actual = cats[catId]?.actual || 0;
  el.innerHTML = budgetIndicatorHtml(actual, parseBudget(budgetVal), mixed);
}

export function wireBudgetPanel() {
  const panel = document.getElementById('plannerBudgetPanel');
  if (!panel) return;

  // Strict-budget toggle — a per-planner setting. Loose (default): a 0/unset budget
  // isn't overspend. Re-render the budget breakdowns + summary so it takes effect.
  panel.addEventListener('change', (e) => {
    if (e.target.id === 'budgetStrictToggle') {
      state.planner.strictBudget = e.target.checked;
      scheduleAutoSave();
      renderPersonalBudgetBreakdown();
      renderSponsorBudgetBreakdown();
      renderBudgetTab();
      if (state.activeTab === 'summary') renderSummaryTab();
    }
  });

  panel.addEventListener('input', (e) => {
    // Sponsor overall budget
    if (e.target.id === 'orgSponsorBudget') {
      state.planner.org.sponsorBudget = e.target.value;
      scheduleAutoSave();
      return;
    }
    if (e.target.id === 'orgSponsorActual') {
      state.planner.org.sponsorActual = e.target.value;
      scheduleAutoSave();
      return;
    }

    // Sponsor category budget inputs
    const catInput = e.target.closest('.budget-cat-input');
    if (catInput) {
      const catId = catInput.dataset.catId;
      (state.planner.org.categoryBudgets ??= {})[catId] = catInput.value;
      scheduleAutoSave();
      _updateCatBudgetIndicator(catId, catInput.value);
      if (state.activeTab === 'summary') renderSummaryTab();
      return;
    }

    // Personal category budget inputs
    const pCatInput = e.target.closest('.personal-budget-cat-input');
    if (pCatInput) {
      const catId = pCatInput.dataset.catId;
      (state.planner.personal.categoryBudgets ??= {})[catId] = pCatInput.value;
      scheduleAutoSave();
      renderPersonalBudgetBreakdown();
      if (state.activeTab === 'summary') renderSummaryTab();
      return;
    }

    // Personal budget item filter (budget tab)
    if (e.target.id === 'personalBudgetTabFilter') {
      renderBudgetItems('personal');
      return;
    }
  });

  panel.addEventListener('change', (e) => {
    if (e.target.id === 'orgSponsorCurrency') {
      state.planner.org.sponsorCurrency = e.target.value;
      scheduleAutoSave();
      renderBudgetTab();
      renderSponsorBudgetBreakdown();
      if (state.activeTab === 'summary') renderSummaryTab();
      return;
    }
  });

  // Personal budget tab: Add item button
  panel.addEventListener('click', (e) => {
    if (e.target.closest('#addPersonalBudgetTabItemBtn')) {
      openBudgetItemModal('personal');
      return;
    }
    const editBtn = e.target.closest('.edit-budget-item-btn');
    if (editBtn && editBtn.dataset.biCtx === 'personal') {
      openBudgetItemModal('personal', editBtn.dataset.biId);
      return;
    }
  });
}

// Override the default budget categories from the seeded global config.
export function setDefaultBudgetCategories(cats) {
  _defaultBudgetCategories = cats;
}

export function removeBudgetCategory(mode, catId) {
  const stored =
    mode === 'personal'
      ? (state.planner.personal.budgetCategories ??= [])
      : (state.planner.org.budgetCategories ??= []);
  if (!stored.length) stored.push(..._defaultBudgetCategories.map((c) => ({ ...c })));
  const idx = stored.findIndex((c) => c.id === catId);
  if (idx !== -1) stored.splice(idx, 1);
  // Prune the category's budget target too, or it lingers as orphaned data and the
  // summary would otherwise dump it into Misc.
  const budgets =
    mode === 'personal'
      ? state.planner.personal.categoryBudgets
      : state.planner.org.categoryBudgets;
  if (budgets && Object.prototype.hasOwnProperty.call(budgets, catId)) delete budgets[catId];
  scheduleAutoSave();
  renderBudgetCategoryManager(mode);
}

// Static shell for this tab panel — injected into #plannerBudgetPanel at boot (#7 co-location).
export function budgetPanelHtml() {
  return `
          <section>
            <div class="pln-section__head">
              <div>
                <p class="pln-eyebrow">What it costs</p>
                <h2 class="pln-section__title">Budget</h2>
              </div>
              <label class="bdg-strict" title="When off, a category with no budget set is treated as unconfigured — its spend is never flagged as over budget. When on, a 0 budget is a hard limit.">
                <span>Strict</span>
                <input type="checkbox" id="budgetStrictToggle" class="pl-toggle">
              </label>
            </div>

            <!-- Sponsor budget section -->
            <div id="budgetSponsorSection" class="space-y-6">
              <!-- Overall event budget -->
              <div class="space-y-3">
                <div class="doc-divider"><span>Overall event budget</span></div>
                <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <label class="editor-form-field">
                    <span class="editor-field-label">Currency</span>
                    <select id="orgSponsorCurrency" class="pl-field"></select>
                  </label>
                  <label class="editor-form-field">
                    <span class="editor-field-label">Total budget</span>
                    <input type="number" min="0" step="0.01" id="orgSponsorBudget" placeholder="0.00" class="pl-field">
                  </label>
                  <label class="editor-form-field">
                    <span class="editor-field-label">Total actual</span>
                    <input type="number" min="0" step="0.01" id="orgSponsorActual" placeholder="0.00" class="pl-field">
                  </label>
                </div>
              </div>
              <!-- Per-category budget targets -->
              <div class="space-y-3">
                <div class="doc-divider"><span>Category budgets</span></div>
                <div id="budgetSummary"></div>
                <div id="budgetCategoryRows"></div>
              </div>
              <!-- Budget line items -->
              <div class="space-y-2">
                <div class="doc-divider"><span>Line items</span>
                  <button id="addSponsorBudgetItemBtn" type="button" class="pl-act" style="margin-left:auto" aria-label="Add budget item">Add item</button>
                </div>
                <div class="bdg-filter">
                  <input type="text" id="sponsorBudgetItemFilter" placeholder="Filter by name, category or person…">
                </div>
                <div id="sponsorBudgetItems" class="bdg-items"></div>
              </div>
              <!-- Budget breakdown (item-level drilldown) -->
              <div id="sponsorBudgetBreakdown" class="hidden pt-2 pl-divide text-xs"></div>
            </div>

            <!-- Personal budget section -->
            <div id="budgetPersonalSection" class="hidden space-y-6">
              <!-- Per-category budget targets -->
              <div class="space-y-3">
                <div class="doc-divider"><span>Category budgets</span></div>
                <div id="personalBudgetSummary"></div>
                <div id="personalBudgetCategoryRows"></div>
              </div>
              <!-- Budget line items -->
              <div class="space-y-2">
                <div class="doc-divider"><span>Line items</span>
                  <button id="addPersonalBudgetTabItemBtn" type="button" class="pl-act" style="margin-left:auto" aria-label="Add budget item">Add item</button>
                </div>
                <div class="bdg-filter">
                  <input type="text" id="personalBudgetTabFilter" placeholder="Filter by name, category or person…">
                </div>
                <div id="personalBudgetTabItems" class="bdg-items"></div>
              </div>
              <!-- Budget breakdown -->
              <div id="personalBudgetTabBreakdown" class="hidden pt-2 pl-divide text-xs"></div>
            </div>
          </section>
        `;
}
