// @ts-check
// Expense splitting / settle-up for the personal planner.
//
// The settle-up math (splitEqually / computeBalances / minimizeTransactions /
// settleUp) is pure and unit-tested; the DOM layer follows the planner's
// init → render → wire convention. Trip "people" are the local companions plus a
// synthetic "you" entry. Each shared expense records who paid and who shares it
// (equal split); the tab shows the minimal set of repayments to settle up.
// Multi-currency safe: expenses are grouped by currency and settled independently.
// Each expense can carry a currency and a budget category (shared with the Budget
// tab's categories).

import { currencyOptions } from './plannerFields.js';

// ── Injected planner collaborators ──────────────────────────────────────────
/** @type {any} */
let state;
/** @type {() => void} */
let scheduleAutoSave;
/** @type {(s: any) => string} */
let esc;
/** @type {(prefix?: string) => string} */
let makeItemId;
/** @type {() => string} */
let getMeLabel;
/** @type {() => Array<{value: string, label: string}>} */
let getActiveBudgetCategoryOptions;

/**
 * @param {{ state: any, scheduleAutoSave: () => void, esc: (s: any) => string,
 *   makeItemId: (prefix?: string) => string, getMeLabel: () => string,
 *   getActiveBudgetCategoryOptions: () => Array<{value: string, label: string}> }} deps
 */
export function initSplit(deps) {
  ({ state, scheduleAutoSave, esc, makeItemId, getMeLabel, getActiveBudgetCategoryOptions } = deps);
}

// ── Pure money + settle-up logic ────────────────────────────────────────────

const ME_ID = 'me';

/**
 * Round to whole cents.
 * @param {number} n
 * @returns {number}
 */
export function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Parse a money input into a finite, non-negative number.
 * @param {*} v
 * @returns {number}
 */
export function parseAmount(v) {
  const n = Number.parseFloat(String(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Split an amount equally across n people, distributing leftover cents to the
 * first few so the shares sum EXACTLY to the amount.
 * @param {number} amount
 * @param {number} n
 * @returns {number[]}
 */
export function splitEqually(amount, n) {
  if (n <= 0) return [];
  const cents = Math.round((Number(amount) || 0) * 100);
  const base = Math.floor(cents / n);
  let rem = cents - base * n;
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push((base + (rem > 0 ? 1 : 0)) / 100);
    if (rem > 0) rem--;
  }
  return out;
}

/**
 * Net balance per person: positive = they are owed, negative = they owe.
 * @param {Array<{amount:number, paidBy:string, sharedWith:string[]}>} expenses
 * @param {string[]} [people] ids to seed at zero (so uninvolved people still show)
 * @returns {Record<string, number>}
 */
export function computeBalances(expenses, people = []) {
  /** @type {Record<string, number>} */
  const bal = {};
  for (const id of people) bal[id] = 0;
  for (const e of expenses || []) {
    const shares = (e.sharedWith || []).filter(Boolean);
    const amt = Number(e.amount) || 0;
    if (!e.paidBy || !shares.length || amt <= 0) continue;
    bal[e.paidBy] = roundMoney((bal[e.paidBy] || 0) + amt);
    const portions = splitEqually(amt, shares.length);
    shares.forEach((pid, i) => {
      bal[pid] = roundMoney((bal[pid] || 0) - portions[i]);
    });
  }
  return bal;
}

/**
 * Greedy minimal repayment set derived from balances (who pays whom).
 * @param {Record<string, number>} balances
 * @returns {Array<{from:string, to:string, amount:number}>}
 */
export function minimizeTransactions(balances) {
  const debtors = [];
  const creditors = [];
  for (const [id, v] of Object.entries(balances)) {
    const r = roundMoney(v);
    if (r < -0.005) debtors.push({ id, amt: -r });
    else if (r > 0.005) creditors.push({ id, amt: r });
  }
  debtors.sort((a, b) => b.amt - a.amt);
  creditors.sort((a, b) => b.amt - a.amt);
  const tx = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = roundMoney(Math.min(debtors[i].amt, creditors[j].amt));
    if (pay > 0) tx.push({ from: debtors[i].id, to: creditors[j].id, amount: pay });
    debtors[i].amt = roundMoney(debtors[i].amt - pay);
    creditors[j].amt = roundMoney(creditors[j].amt - pay);
    if (debtors[i].amt <= 0.005) i++;
    if (creditors[j].amt <= 0.005) j++;
  }
  return tx;
}

/**
 * Full settle-up, grouped by currency.
 * @param {Array<{amount:number, currency?:string, paidBy:string, sharedWith:string[]}>} expenses
 * @param {string[]} [people]
 * @returns {Record<string, {balances:Record<string,number>, transactions:Array<{from:string,to:string,amount:number}>}>}
 */
export function settleUp(expenses, people = []) {
  /** @type {Record<string, any[]>} */
  const byCur = {};
  for (const e of expenses || []) {
    const c = e.currency || '';
    (byCur[c] ||= []).push(e);
  }
  /** @type {Record<string, {balances:Record<string,number>, transactions:any[]}>} */
  const out = {};
  for (const [cur, list] of Object.entries(byCur)) {
    const balances = computeBalances(list, people);
    out[cur] = { balances, transactions: minimizeTransactions(balances) };
  }
  return out;
}

// ── Planner-state accessors ─────────────────────────────────────────────────

// The people who can share an expense: "you" plus the local companions.
function tripPeople() {
  const me = { id: ME_ID, name: (getMeLabel && getMeLabel()) || 'You' };
  const companions = (state.planner?.personal?.localCompanions || [])
    .filter((/** @type {any} */ c) => c && c.id)
    .map((/** @type {any} */ c) => ({ id: c.id, name: c.name || 'Unnamed' }));
  return [me, ...companions];
}

// Lazily-initialised shared-expense list on the planner (permissive schema).
/** @returns {any[]} */
function getExpenses() {
  const p = state.planner.personal;
  if (!Array.isArray(p.splitExpenses)) p.splitExpenses = [];
  return p.splitExpenses;
}

function defaultCurrency() {
  return state.planner?.personal?.currency || '';
}

// <option> list for the budget categories (shared with the Budget tab), with a
// leading "No category" choice.
/** @param {string} [selectedId] */
function categoryOptionsHtml(selectedId) {
  const opts = (getActiveBudgetCategoryOptions?.() || [])
    .map(
      (o) =>
        `<option value="${esc(o.value)}" ${o.value === selectedId ? 'selected' : ''}>${esc(o.label)}</option>`,
    )
    .join('');
  return `<option value="" ${!selectedId ? 'selected' : ''}>No category</option>${opts}`;
}

/** @param {string} [id] */
function categoryLabel(id) {
  if (!id) return '';
  return (getActiveBudgetCategoryOptions?.() || []).find((o) => o.value === id)?.label || '';
}

/**
 * @param {number} amount
 * @param {string} [currency]
 * @returns {string}
 */
function fmtMoney(amount, currency) {
  return `${currency ? `${currency} ` : ''}${roundMoney(amount).toFixed(2)}`;
}

// ── Panel shell (injected by planner.js) ────────────────────────────────────

export function splitPanelHtml() {
  return `
    <section>
      <div class="pln-section__head">
        <div>
          <p class="pln-eyebrow">Who paid for what</p>
          <h2 class="pln-section__title">Shared costs</h2>
        </div>
      </div>
      <p class="wx-lede">Log what everyone chipped in and see the fewest payments to square up. People come from your <strong>Companions</strong>.</p>
      <form id="splitAddForm" class="spl-form">
        <input id="splitDesc" type="text" placeholder="What was it for?" class="spl-input spl-input--desc" required>
        <input id="splitAmount" type="number" step="0.01" min="0" placeholder="0.00" class="spl-input spl-input--amt" required>
        <select id="splitCurrency" class="spl-select" aria-label="Currency"></select>
        <select id="splitCategory" class="spl-select" aria-label="Category"></select>
        <select id="splitPaidBy" class="spl-select" aria-label="Paid by"></select>
        <button type="submit" class="pl-add-btn">Add</button>
      </form>
      <div id="splitList" class="spl-exps"></div>
      <div id="splitSettle" class="spl-settle"></div>
    </section>`;
}

// ── Render ──────────────────────────────────────────────────────────────────

/**
 * @param {Array<{id: string, name: string}>} people
 * @param {string} id
 * @returns {string}
 */
function personName(people, id) {
  return people.find((p) => p.id === id)?.name || 'Unknown';
}

function renderPaidByOptions() {
  const sel = document.getElementById('splitPaidBy');
  if (!sel) return;
  sel.innerHTML = tripPeople()
    .map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`)
    .join('');
}

// Populate the add-form's currency + category pickers (defaulting to the planner
// currency / no category).
function renderFormOptions() {
  const cur = document.getElementById('splitCurrency');
  if (cur) cur.innerHTML = currencyOptions(defaultCurrency());
  const cat = document.getElementById('splitCategory');
  if (cat) cat.innerHTML = categoryOptionsHtml('');
}

function renderExpenseList() {
  const wrap = document.getElementById('splitList');
  if (!wrap) return;
  const people = tripPeople();
  const expenses = getExpenses();
  if (!expenses.length) {
    wrap.innerHTML = `<p class="spl-none">No shared expenses yet — add one above.</p>`;
    return;
  }
  wrap.innerHTML = expenses
    .map((/** @type {any} */ e) => {
      const chips = people
        .map((p) => {
          const on = (e.sharedWith || []).includes(p.id);
          const initial = esc((p.name || '?').charAt(0).toUpperCase());
          return `<button type="button" class="pl-chip" aria-pressed="${on}" data-exp-share="${esc(e.id)}" data-pid="${esc(p.id)}"><span class="pl-chip-av">${initial}</span>${esc(p.name)}</button>`;
        })
        .join('');
      const payOpts = people
        .map(
          (p) =>
            `<option value="${esc(p.id)}" ${p.id === e.paidBy ? 'selected' : ''}>${esc(p.name)}</option>`,
        )
        .join('');
      const curOpts = currencyOptions(e.currency || '');
      const catOpts = categoryOptionsHtml(e.category);
      const catBadge = categoryLabel(e.category);
      return `<div class="spl-exp">
        <div class="spl-exp-head">
          <span class="spl-exp-desc">${esc(e.description || 'Expense')}</span>
          ${catBadge ? `<span class="spl-exp-cat">${esc(catBadge)}</span>` : ''}
          <span class="spl-exp-amt">${esc(fmtMoney(e.amount, e.currency))}</span>
          <button type="button" class="spl-exp-del pl-act pl-act--del" data-del-exp="${esc(e.id)}" aria-label="Delete expense">Remove</button>
        </div>
        <div class="spl-exp-controls">
          <span class="spl-exp-lbl">Paid by</span>
          <select class="spl-mini" data-exp-paidby="${esc(e.id)}">${payOpts}</select>
          <span class="spl-exp-lbl">Currency</span>
          <select class="spl-mini" data-exp-currency="${esc(e.id)}">${curOpts}</select>
          <span class="spl-exp-lbl">Category</span>
          <select class="spl-mini" data-exp-category="${esc(e.id)}">${catOpts}</select>
          <span class="spl-exp-lbl spl-share-lbl">Shared</span>
          ${chips}
        </div>
      </div>`;
    })
    .join('');
}

function renderSettle() {
  const wrap = document.getElementById('splitSettle');
  if (!wrap) return;
  const people = tripPeople();
  const ids = people.map((p) => p.id);
  const byCur = settleUp(getExpenses(), ids);
  const header = `<div class="doc-divider"><span>Settle up</span></div>`;

  const entries = Object.entries(byCur);
  if (!entries.length) {
    wrap.innerHTML = `${header}<p class="spl-none">Add an expense to see who owes whom.</p>`;
    return;
  }
  const multi = entries.length > 1;

  const sections = entries
    .map(([cur, { balances, transactions }]) => {
      // Net-position bars: each person's balance diverges from a centre line —
      // gold to the right = owed to them, red to the left = they owe.
      const nonZero = Object.entries(balances).filter(([, v]) => Math.abs(v) > 0.005);
      const maxAbs = nonZero.reduce((m, [, v]) => Math.max(m, Math.abs(v)), 0) || 1;
      const bars = nonZero.length
        ? `<div class="spl-bals">` +
          nonZero
            .sort((a, b) => b[1] - a[1])
            .map(([id, v]) => {
              const owed = v > 0;
              const pct = (Math.abs(v) / maxAbs) * 50; // up to half the track
              return `<div class="spl-bal">
                <span class="spl-bal-name">${esc(personName(people, id))}</span>
                <span class="spl-bal-track"><span class="spl-bal-bar ${owed ? 'spl-bal-bar--owed' : 'spl-bal-bar--owes'}" style="width:${pct}%"></span></span>
                <span class="spl-bal-amt ${owed ? 'is-owed' : 'is-owes'}">${owed ? '+' : '−'}${esc(fmtMoney(Math.abs(v), cur))}</span>
              </div>`;
            })
            .join('') +
          `</div>`
        : '';

      const tx = transactions.length
        ? transactions
            .map(
              (t) =>
                `<div class="spl-tx"><span class="spl-tx-from">${esc(personName(people, t.from))}</span><span class="spl-tx-arrow" aria-hidden="true">&rarr;</span><span class="spl-tx-to">${esc(personName(people, t.to))}</span><span class="spl-tx-amt">${esc(fmtMoney(t.amount, cur))}</span></div>`,
            )
            .join('')
        : `<div class="spl-settled">All settled up.</div>`;

      const curLabel = multi
        ? `<div class="spl-cur-lbl">${cur ? esc(cur) : 'No currency'}</div>`
        : '';
      return `<div class="spl-cur-block">${curLabel}${bars}${tx}</div>`;
    })
    .join('');

  wrap.innerHTML = `${header}${sections}`;
}

export function renderSplitTab() {
  renderPaidByOptions();
  renderFormOptions();
  renderExpenseList();
  renderSettle();
}

// ── Wire ────────────────────────────────────────────────────────────────────

export function wireSplitPanel() {
  const form = document.getElementById('splitAddForm');
  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    const descEl = /** @type {HTMLInputElement|null} */ (document.getElementById('splitDesc'));
    const amtEl = /** @type {HTMLInputElement|null} */ (document.getElementById('splitAmount'));
    const paidEl = /** @type {HTMLSelectElement|null} */ (document.getElementById('splitPaidBy'));
    const curEl = /** @type {HTMLSelectElement|null} */ (document.getElementById('splitCurrency'));
    const catEl = /** @type {HTMLSelectElement|null} */ (document.getElementById('splitCategory'));
    const amount = parseAmount(amtEl?.value);
    if (!amount) return;
    getExpenses().push({
      id: makeItemId('sx'),
      description: (descEl?.value || '').trim(),
      amount,
      currency: curEl?.value || defaultCurrency(),
      category: catEl?.value || '',
      paidBy: paidEl?.value || ME_ID,
      sharedWith: tripPeople().map((p) => p.id), // default: shared by everyone
    });
    if (descEl) descEl.value = '';
    if (amtEl) amtEl.value = '';
    scheduleAutoSave();
    renderExpenseList();
    renderSettle();
  });

  const list = document.getElementById('splitList');
  list?.addEventListener('click', (e) => {
    const del = /** @type {HTMLElement} */ (e.target).closest('[data-del-exp]');
    if (del) {
      const arr = getExpenses();
      const i = arr.findIndex((x) => x.id === del.getAttribute('data-del-exp'));
      if (i >= 0) {
        arr.splice(i, 1);
        scheduleAutoSave();
        renderExpenseList();
        renderSettle();
      }
      return;
    }
    // Toggle a participant chip (a .pl-chip button using aria-pressed).
    const chip = /** @type {HTMLElement} */ (e.target).closest('[data-exp-share]');
    if (chip) {
      const it = getExpenses().find((x) => x.id === chip.getAttribute('data-exp-share'));
      const pid = chip.getAttribute('data-pid');
      if (it && pid) {
        const set = new Set(it.sharedWith || []);
        if (set.has(pid)) set.delete(pid);
        else set.add(pid);
        it.sharedWith = [...set];
        scheduleAutoSave();
        renderExpenseList();
        renderSettle();
      }
    }
  });
  list?.addEventListener('change', (e) => {
    const target = /** @type {HTMLInputElement & HTMLSelectElement} */ (e.target);
    const exp = getExpenses();
    const paidby = target.getAttribute('data-exp-paidby');
    if (paidby) {
      const it = exp.find((x) => x.id === paidby);
      if (it) it.paidBy = target.value;
      scheduleAutoSave();
      renderSettle();
      return;
    }
    const curId = target.getAttribute('data-exp-currency');
    if (curId) {
      const it = exp.find((x) => x.id === curId);
      if (it) it.currency = target.value;
      scheduleAutoSave();
      renderExpenseList(); // amount label + settle grouping depend on currency
      renderSettle();
      return;
    }
    const catId = target.getAttribute('data-exp-category');
    if (catId) {
      const it = exp.find((x) => x.id === catId);
      if (it) it.category = target.value;
      scheduleAutoSave();
      renderExpenseList(); // refresh the category badge
    }
  });
}
