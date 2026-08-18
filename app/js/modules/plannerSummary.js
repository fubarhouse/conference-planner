// Summary tab — the This-Event and All-Events budget summaries. Owns its own UI
// state (display currency, global filter), the per-event budget aggregation
// (buildEventBudgetData / buildPersonalBudgetData), Chart.js charts with
// historical-FX conversion, budget-health bars, the rate notice, and the
// category/member drilldown modals plus panel wiring. Extracted from planner.js:
// planner-internal collaborators are injected via initSummary(); field/currency/
// storage/modal helpers are imported directly. Chart is a global (eslint config).

import { escapeHtml as esc } from './utils.js';

// Chart.js paints to a canvas, so it needs a concrete colour — a `var(--x)`
// string means nothing to a 2D context. Read the token off the document at
// draw time, so the charts follow light/dark like everything else.
function chartColor(name, fallback = '#1a1e1b') {
  if (typeof getComputedStyle === 'undefined') return fallback;
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none';
  probe.style.color = `var(${name})`;
  document.body.appendChild(probe);
  const v = getComputedStyle(probe).color;
  probe.remove();
  return v || fallback;
}
import { parseBudget, formatAmount } from './plannerFields.js';
import {
  buildConvFn,
  fetchRates,
  ratesLoadedFor,
  hasRate,
  getRateEntry,
  getRateEntryByKey,
  ensureRatesForDates,
  clampRateDate,
} from './currency.js';
import { showModal, hideModal } from './modal.js';
import { GLOBAL_KEY, STORAGE_PREFIX, listKeys, readJson } from './plannerStorage.js';
import { renderBudgetBreakdownInto } from './plannerPersonal.js';

// ── Injected planner collaborators ────────────────────────────────────────────
let state;
let fetchEventDates;
let getEventBudgetCategories;
let getVisibleTabs;
let isPlannerEntry;
let toWednesdayOfWeek;
let scheduleAutoSave;
let _eventDates;

export function initSummary(deps) {
  ({
    state,
    fetchEventDates,
    getEventBudgetCategories,
    getVisibleTabs,
    isPlannerEntry,
    toWednesdayOfWeek,
    scheduleAutoSave,
    _eventDates,
  } = deps);
}

const _globalSummaryFilter = { start: '', end: '', hidden: new Set(), person: '' };

// Mirrors the persisted per-planner roll-up currency (`planner.displayCurrency`);
// '' = as-entered (falls back to the trip currency). Synced from the planner at
// the top of each render and written back when the "Display in" selector changes.
let _summaryCurrency = '';
let _primaryDisplayCurrency = ''; // detected primary currency from current planner data
let _currentRenderDate = ''; // event start date used in the current This Event render
let _displayApprox = false; // This-Event totals were converted (mixed currencies) → show ≈

function _showRateNotice(error, rateKey = '') {
  const notice = document.getElementById('summaryRateNotice');
  const text = document.getElementById('summaryRateNoticeText');
  if (!notice || !text) return;
  if (!_summaryCurrency) {
    notice.classList.add('hidden');
    return;
  }
  notice.classList.remove('hidden');
  const key = rateKey || `${_summaryCurrency}:current`;
  const cached = getRateEntryByKey(key);
  if (error || !cached) {
    text.textContent = error
      ? `Could not fetch exchange rates for ${_summaryCurrency} — values shown as entered. Check your connection and try again.`
      : `Exchange rates for ${_summaryCurrency} not loaded — values shown as entered.`;
  } else {
    const isHistorical = !key.endsWith(':current');
    const dateLabel = isHistorical
      ? `${cached.rateDate} (event date)`
      : cached.rateDate || 'latest available';
    text.textContent =
      `Values shown as approximate ${_summaryCurrency} equivalents using ECB rates from ${dateLabel}. ` +
      `Currencies outside ECB coverage are shown as-entered. Suitable for budgeting; use actual transaction rates for formal bookkeeping.`;
  }
}

const _charts = {};

function destroyCharts(...keys) {
  keys.forEach((k) => {
    if (_charts[k]) {
      _charts[k].destroy();
      delete _charts[k];
    }
  });
}

// Actual spend for a budget item: the sum of its linked receipts (each converted
// from its own currency), or the item's own entered actual when none are linked.
function itemActual(planner, item, iCurr, cvt) {
  // Actual comes ONLY from linked receipts. A legacy manual `actual` (entered before
  // the budget-item cost inputs were retired) is intentionally ignored — so a
  // budget-only line item with no receipt reads as unspent (Actual —), not fully spent.
  const linked = (planner.receipts || []).filter((r) => r.budgetItemId === item.id);
  return linked.reduce(
    (s, r) => s + cvt(parseBudget(r.amount), r.currency || iCurr, r.date || item.purchaseDate),
    0,
  );
}

// An entity's actual cost + native currency/date. When the entity links a receipt
// (`entity.receiptId`), its cost is taken from that receipt (converted at the
// receipt's own currency/date) — cost has moved to Receipts. Otherwise it falls
// back to the entity's own fields (backward-compatible for un-migrated data).
// Returns { actual, curr, date } already converted via `cvt`.
function entityCost(planner, entity, ownActual, ownCurr, ownDate, cvt) {
  const r = entity?.receiptId
    ? (planner.receipts || []).find((x) => x.id === entity.receiptId)
    : null;
  if (r) {
    return {
      actual: cvt(parseBudget(r.amount), r.currency || ownCurr, r.date),
      curr: r.currency || ownCurr,
      date: r.date || '',
      category: r.category || '',
    };
  }
  return {
    actual: cvt(parseBudget(ownActual), ownCurr, ownDate),
    curr: ownCurr,
    date: ownDate || '',
    category: '',
  };
}

// Receipt ids referenced by an entity's `receiptId` whose summary block sources its
// actual from that receipt — those must be excluded from the unlinked-receipt tally
// to avoid double-counting. Covers every consolidated entity type (itinerary,
// tickets, accommodation + per-member stays, team assignments, swag). Travel legs
// are NOT here: their receipts have no owning summary line, so they count as
// unlinked-travel (their intended behaviour).
function linkedReceiptIds(planner) {
  const ids = new Set();
  const p = planner.personal || {};
  const o = planner.org || {};
  const scan = (arr) => (arr || []).forEach((e) => e?.receiptId && ids.add(e.receiptId));
  scan(p.itinerary);
  scan(o.itinerary);
  scan(p.tickets);
  scan(o.tickets);
  scan(o.teamAssignments);
  scan(o.swag);
  [...(p.accommodations || []), ...(o.accommodations || [])].forEach((a) => {
    if (a?.receiptId) ids.add(a.receiptId);
    (a.assignments || []).forEach((s) => s?.receiptId && ids.add(s.receiptId));
  });
  return ids;
}

// Unlinked receipts are a real cost with no other record of them, so they count
// toward their category's actual (converted to the display currency) AND appear
// in the drilldown's "as entered" list. Receipts already accounted for elsewhere
// are skipped: those tied to a budget item (via `budgetItemId`) or to a
// consolidated entity (via the entity's `receiptId`) — adding them again would
// double-count.
function addUnlinkedReceipts(planner, cats, cvt = (n) => n) {
  const entLinked = linkedReceiptIds(planner);
  (planner.receipts || []).forEach((r) => {
    if (r.budgetItemId || entLinked.has(r.id)) return;
    const cat = r.category || 'misc';
    const amt = parseBudget(r.amount);
    if (!amt) return;
    const target = cats[cat === 'waypoints' ? 'accommodation' : cat] || cats.misc;
    target.actual += cvt(amt, r.currency || 'AUD', r.date);
    target.receipts.push({
      label: r.name || 'Receipt',
      amount: amt,
      currency: r.currency || '',
      date: r.date || '',
    });
  });
}

export function buildEventBudgetData(planner, filterMemberId = null, conv = null) {
  const cvt = conv ?? ((n) => n);
  const activeCats = getEventBudgetCategories('org');
  const cats = Object.fromEntries(
    activeCats.map((c) => [c.id, { label: c.name, budget: 0, actual: 0, items: [], receipts: [] }]),
  );
  if (!cats.misc) cats.misc = { label: 'Misc', budget: 0, actual: 0, items: [], receipts: [] };
  const org = planner.org || {};

  // Team assignments → travel (actual only; budget comes from categoryBudgets)
  (org.teamAssignments || []).forEach((a) => {
    if (filterMemberId && a.memberId !== filterMemberId) return;
    const m = state.global?.teamMembers.find((tm) => tm.id === a.memberId);
    const aCurr = a.currency || 'AUD';
    const b = cvt(parseBudget(a.budget), aCurr, a.purchaseDate);
    const { actual: ac, date } = entityCost(planner, a, a.budgetActual, aCurr, a.purchaseDate, cvt);
    const tCat = cats.travel || cats.misc;
    tCat.actual += ac;
    if (b || ac) tCat.items.push({ label: m?.name || 'Unnamed', budget: b, actual: ac, date });
  });

  // Accommodation stays → accommodation (actual only)
  (org.accommodations || []).forEach((acc) => {
    (acc.assignments || []).forEach((stay) => {
      if (filterMemberId && stay.memberId !== filterMemberId) return;
      const m = state.global?.teamMembers.find((tm) => tm.id === stay.memberId);
      const sCurr = stay.currency || 'AUD';
      const sDate = stay.purchaseDate || acc.purchaseDate || '';
      const b = cvt(parseBudget(stay.budget), sCurr, sDate);
      const { actual: ac, date } = entityCost(planner, stay, stay.budgetActual, sCurr, sDate, cvt);
      const aCat = cats.accommodation || cats.misc;
      aCat.actual += ac;
      if (b || ac)
        aCat.items.push({
          label: `${m?.name || 'Unnamed'} @ ${acc.name || 'Accommodation'}`,
          budget: b,
          actual: ac,
          date,
        });
    });
  });

  // Org-level itinerary events (actual only)
  if (!filterMemberId) {
    (org.itinerary || []).forEach((item) => {
      const iCurr = item.currency || 'AUD';
      const b = cvt(parseBudget(item.budget), iCurr, item.purchaseDate);
      const { actual: ac, date } = entityCost(
        planner,
        item,
        item.actual,
        iCurr,
        item.purchaseDate,
        cvt,
      );
      if (!b && !ac) return;
      const tmCat = cats.team || cats.misc;
      tmCat.actual += ac;
      if (b || ac)
        tmCat.items.push({
          label: item.title || 'Team event',
          budget: b,
          actual: ac,
          date,
          isManual: true,
        });
    });
  }

  // The following are org-wide, not member-specific
  if (!filterMemberId) {
    (org.swag || []).forEach((item) => {
      const iCurr = item.currency || 'AUD';
      const b = cvt(parseBudget(item.budget), iCurr);
      const { actual: ac } = entityCost(planner, item, item.actual, iCurr, '', cvt);
      const swCat = cats.swag || cats.misc;
      swCat.actual += ac;
      if (b || ac) swCat.items.push({ label: item.name || 'Swag item', budget: b, actual: ac });
    });

    (org.tickets || []).forEach((t) => {
      const tCurr = t.currency || 'AUD';
      const qty = parseBudget(t.quantity) || 1;
      const { actual: cost, date } = entityCost(
        planner,
        t,
        parseBudget(t.unitPrice) * qty,
        tCurr,
        t.purchaseDate,
        cvt,
      );
      if (!cost) return;
      const tkCat = cats.tickets || cats.misc;
      tkCat.actual += cost;
      tkCat.items.push({ label: t.name || 'Ticket', budget: 0, actual: cost, date });
    });

    (org.budgetItems || []).forEach((item) => {
      // Planned amounts are in the org's currency (per-item currency was retired).
      const iCurr = item.currency || org.sponsorCurrency || 'AUD';
      const cat = item.category || 'misc';
      const b = cvt(parseBudget(item.budget), iCurr, item.purchaseDate);
      const ac = itemActual(planner, item, iCurr, cvt);
      const target = cats[cat === 'waypoints' ? 'accommodation' : cat] || cats.misc;
      target.actual += ac;
      if (b || ac)
        target.items.push({
          label: item.name || 'Budget item',
          budget: b,
          actual: ac,
          date: item.purchaseDate || '',
          isManual: true,
        });
    });

    // Apply category-level budget targets (set in Budget tab, keyed by category ID).
    // Only apply to a live category — a budget keyed to a removed/unknown category is
    // orphaned data and must NOT fall through into Misc.
    const catBudgets = org.categoryBudgets || {};
    const orgCurr = org.sponsorCurrency || 'AUD';
    Object.entries(catBudgets).forEach(([catId, amt]) => {
      const target = cats[catId];
      if (!target) return;
      target.budget = cvt(parseBudget(String(amt)), orgCurr);
    });
  }

  // Budget items assigned to a specific member
  if (filterMemberId) {
    (org.budgetItems || [])
      .filter((item) => item.memberId === filterMemberId)
      .forEach((item) => {
        const iCurr = item.currency || 'AUD';
        const cat = item.category || 'misc';
        const b = cvt(parseBudget(item.budget), iCurr, item.purchaseDate);
        const ac = itemActual(planner, item, iCurr, cvt);
        const target = cats[cat === 'waypoints' ? 'accommodation' : cat] || cats.misc;
        target.actual += ac;
        if (b || ac)
          target.items.push({
            label: item.name || 'Budget item',
            budget: b,
            actual: ac,
            date: item.purchaseDate || '',
            isManual: true,
          });
      });
  }

  // Tickets associated to member (assigned or purchased by)
  if (filterMemberId) {
    const memberTickets = [...(org.tickets || []), ...(planner.personal?.tickets || [])].filter(
      (t) => t.assignedTo === filterMemberId || t.purchasedBy === filterMemberId,
    );
    memberTickets.forEach((t) => {
      const tCurr = t.currency || 'AUD';
      const qty = parseBudget(t.quantity) || 1;
      const { actual: cost, date } = entityCost(
        planner,
        t,
        parseBudget(t.unitPrice) * qty,
        tCurr,
        t.purchaseDate,
        cvt,
      );
      if (!cost) return;
      const tkCat = cats.tickets || cats.misc;
      tkCat.actual += cost;
      tkCat.items.push({ label: t.name || 'Ticket', budget: 0, actual: cost, date });
    });
  }

  addUnlinkedReceipts(planner, cats, cvt);

  return cats;
}

// My share of each shared expense (equal split among the sharers that include me),
// converted to the primary currency. Pure — consumed by buildPersonalBudgetData so
// Shared-costs entries flow into the personal Summary/Budget totals.
export function mySplitShares(planner, conv = null) {
  const cvt = conv ?? ((n) => n);
  const out = [];
  for (const e of planner.personal?.splitExpenses || []) {
    const shares = (e.sharedWith || []).filter(Boolean);
    if (!shares.includes('me')) continue; // 'me' = the synthetic self id in splitExpenses
    const actual = cvt((Number(e.amount) || 0) / shares.length, e.currency || 'AUD');
    if (!actual) continue;
    out.push({ category: e.category || '', label: e.description || 'Shared expense', actual });
  }
  return out;
}

export function buildPersonalBudgetData(planner, conv = null) {
  const cvt = conv ?? ((n) => n);
  const activeCats = getEventBudgetCategories('personal');
  const cats = Object.fromEntries(
    activeCats.map((c) => [c.id, { label: c.name, budget: 0, actual: 0, items: [], receipts: [] }]),
  );
  if (!cats.misc) cats.misc = { label: 'Misc', budget: 0, actual: 0, items: [], receipts: [] };
  const personal = planner.personal || {};
  const pCurr = personal.currency || 'AUD';

  const tDate = personal.travelPurchaseDate || '';
  const tb = cvt(parseBudget(personal.budget), pCurr, tDate);
  const ta = cvt(parseBudget(personal.budgetActual), pCurr, tDate);
  const tCat = cats.travel || cats.misc;
  tCat.budget += tb;
  tCat.actual += ta;
  if (tb || ta)
    tCat.items.push({ label: 'My travel', budget: tb, actual: ta, curr: pCurr, date: tDate });

  (personal.accommodations || []).forEach((acc) => {
    // A hotel's cost can be recorded in two places: the accommodation-level
    // budget/actual (global), or the traveller's own per-night stay
    // (`__me__` assignment — individual). Look at both, but prefer the stay when
    // it carries a cost, so the same accommodation is never double-counted.
    const meStay = (acc.assignments || []).find((s) => s.memberId === '__me__');
    // Prefer the traveller's own stay when it carries a cost OR links a receipt.
    const src = meStay && (meStay.budget || meStay.budgetActual || meStay.receiptId) ? meStay : acc;
    const aCurr = src.currency || acc.currency || 'AUD';
    const aDate0 = src.purchaseDate || acc.purchaseDate || '';
    const ab = cvt(parseBudget(src.budget), aCurr, aDate0);
    const {
      actual: aa,
      curr,
      date,
    } = entityCost(planner, src, src.budgetActual, aCurr, aDate0, cvt);
    const aCat = cats.accommodation || cats.misc;
    aCat.budget += ab;
    aCat.actual += aa;
    if (ab || aa)
      aCat.items.push({ label: acc.name || 'Accommodation', budget: ab, actual: aa, curr, date });
  });

  (personal.tickets || []).forEach((t) => {
    const tCurr = t.currency || 'AUD';
    const qty = parseBudget(t.quantity) || 1;
    const {
      actual: cost,
      curr,
      date,
    } = entityCost(planner, t, parseBudget(t.unitPrice) * qty, tCurr, t.purchaseDate, cvt);
    if (!cost) return;
    const tkCat = cats.tickets || cats.misc;
    tkCat.actual += cost;
    tkCat.items.push({ label: t.name || 'Ticket', budget: 0, actual: cost, curr, date });
  });

  // Personal itinerary items with budget. When an item is linked to a receipt, its
  // actual is taken from that receipt (converted at the receipt's own date/currency)
  // rather than the item's `actual` field — cost management has moved to Receipts.
  // The planned `budget` still comes from the item.
  (personal.itinerary || []).forEach((item) => {
    const iCurr = item.currency || pCurr;
    const b = cvt(parseBudget(item.budget), iCurr, item.purchaseDate);
    const {
      actual: ac,
      curr,
      date,
      category,
    } = entityCost(planner, item, item.actual, iCurr, item.purchaseDate, cvt);
    if (!b && !ac) return;
    // Category follows the linked receipt when present (cost management lives on the
    // receipt); a bare itinerary item with no receipt defaults to Misc.
    const target = cats[category === 'waypoints' ? 'accommodation' : category] || cats.misc;
    target.budget += b;
    target.actual += ac;
    if (b || ac)
      target.items.push({
        label: item.title || 'Itinerary item',
        budget: b,
        actual: ac,
        curr,
        date,
        isManual: true,
      });
  });

  // Manual budget items (personal)
  (personal.budgetItems || []).forEach((item) => {
    // Budget-item planned amounts are entered in the trip currency (the per-item
    // currency field was retired); actuals come from each receipt's own currency.
    const iCurr = item.currency || pCurr;
    const cat = item.category || 'misc';
    const b = cvt(parseBudget(item.budget), iCurr, item.purchaseDate);
    const ac = itemActual(planner, item, iCurr, cvt);
    const target = cats[cat === 'waypoints' ? 'accommodation' : cat] || cats.misc;
    target.budget += b;
    target.actual += ac;
    if (b || ac)
      target.items.push({
        label: item.name || 'Budget item',
        budget: b,
        actual: ac,
        curr: iCurr,
        date: item.purchaseDate || '',
        isManual: true,
      });
  });

  // Category-level budget targets (set on the Budget tab, keyed by category ID). An
  // explicit target is the category's planned budget — it overrides the sum of that
  // category's line-item budgets (mirrors the org/sponsor behaviour).
  const catBudgets = personal.categoryBudgets || {};
  Object.entries(catBudgets).forEach(([catId, amt]) => {
    const s = String(amt ?? '').trim();
    if (s === '') return;
    // Only apply to a live category. A budget keyed to a removed/unknown category is
    // orphaned data — ignore it rather than dumping it into Misc.
    const target = cats[catId];
    if (!target) return;
    target.budget = cvt(parseBudget(s), pCurr);
  });

  // My share of shared expenses (from the Shared costs tab) counts as personal
  // spend, categorised by the expense's budget category.
  for (const s of mySplitShares(planner, conv)) {
    const target = cats[s.category] || cats.misc;
    target.actual += s.actual;
    target.items.push({
      label: `${s.label} (my share)`,
      budget: 0,
      actual: s.actual,
      curr: pCurr,
      isManual: true,
    });
  }

  addUnlinkedReceipts(planner, cats, cvt);

  return cats;
}

export function renderSummaryTab() {
  // The roll-up currency is the persisted per-planner preference; keep the module
  // mirror and the "Display in" selector in step with it on every render.
  _summaryCurrency = state.planner?.displayCurrency || '';
  const curSel = document.getElementById('summaryCurrencySelect');
  if (curSel && curSel.value !== _summaryCurrency) curSel.value = _summaryCurrency;

  const activeToggle = document.getElementById('summaryThisEvent')?.classList.contains('hidden')
    ? 'all'
    : 'this';
  if (activeToggle === 'all') {
    renderSummaryAllEvents();
  } else {
    renderSummaryThisEvent();
  }
}

// Ensure exchange rates for the This-Event display target are cached, then
// re-render so converted totals can appear. No-op once loaded (so no loop).
// Purchase/receipt dates across the planner — the extra rate days a per-date
// conversion needs beyond the event date. Covers every record that carries an
// optional purchaseDate (budget items, tickets, accommodation stays, travel
// assignments) plus receipts (their own date).
function plannerItemDates(planner) {
  const p = planner || {};
  const personal = p.personal || {};
  const org = p.org || {};
  const dates = [];
  const push = (d) => d && dates.push(d);

  [...(personal.budgetItems || []), ...(org.budgetItems || [])].forEach((i) =>
    push(i.purchaseDate),
  );
  [...(personal.tickets || []), ...(org.tickets || [])].forEach((t) => push(t.purchaseDate));
  [...(personal.itinerary || []), ...(org.itinerary || [])].forEach((i) => push(i.purchaseDate));
  (org.teamAssignments || []).forEach((a) => push(a.purchaseDate));
  push(personal.travelPurchaseDate);
  [...(personal.accommodations || []), ...(org.accommodations || [])].forEach((acc) => {
    push(acc.purchaseDate);
    (acc.assignments || []).forEach((s) => push(s.purchaseDate));
  });
  (p.receipts || []).forEach((r) => push(r.date));
  return dates;
}

function ensureThisEventRates(target) {
  if (!target) return;
  const date = _currentRenderDate || '';
  if (!hasRate(target, date)) {
    fetchRates(target, date)
      .then(() => renderSummaryTab())
      .catch(() => {});
  }
  ensureRatesForDates(target, plannerItemDates(state.planner), renderSummaryTab);
}

// Inline itemised breakdown under Budget Health. Built from NATIVE cats (no
// converter) so each line shows the currency it was entered in; the renderer
// converts only the grand total. Hidden when there's nothing to itemise.
function renderSummaryBreakdown(cats, currency) {
  const wrap = document.getElementById('summaryBudgetBreakdownWrap');
  const hasItems = Object.values(cats).some(
    (c) => (c.items || []).length || (c.receipts || []).length,
  );
  wrap?.classList.toggle('hidden', !hasItems);
  // `cats` is already rolled up into `currency` (built with a conv fn upstream), so the
  // breakdown reads category budgets/actuals directly — no per-item conversion here.
  if (hasItems) renderBudgetBreakdownInto('summaryBudgetBreakdown', cats, currency);
}

// Distinct palette for the spend-by-category donut (personal summary).
const SPEND_DONUT_COLORS = [
  '#3b82f6',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#ec4899',
  '#14b8a6',
  '#6b7280',
];

// Personal-only visualisations: a ranked "Top expenses" list and a spend-by-category
// doughnut. `cats` is already converted to the display currency; `conv` converts the
// raw unlinked-receipt amounts to match. Hides itself (and tears down the chart) when
// there's nothing to show or in sponsor mode (which passes {}).
function renderPersonalSpendViz(cats, conv, target, converting) {
  const container = document.getElementById('summaryPersonalViz');
  const listEl = document.getElementById('summaryTopExpenses');
  if (!container || !listEl) {
    destroyCharts('spendDonut');
    return;
  }
  const cv = (amt, curr, date) =>
    conv ? conv(parseBudget(amt), curr || target, date) : parseBudget(amt);
  const money = (n) =>
    converting
      ? `≈${formatAmount(n)} ${target}`
      : target
        ? `${target} ${formatAmount(n)}`
        : formatAmount(n);

  const rows = [];
  const catActual = [];
  for (const c of Object.values(cats)) {
    (c.items || []).forEach((it) => {
      if (it.actual > 0) rows.push({ label: it.label, cat: c.label, amount: it.actual });
    });
    (c.receipts || []).forEach((r) => {
      const a = cv(r.amount, r.currency, r.date);
      if (a > 0) rows.push({ label: r.label || 'Receipt', cat: c.label, amount: a });
    });
    if (c.actual > 0) catActual.push({ label: c.label, amount: c.actual });
  }

  if (!rows.length) {
    container.classList.add('hidden');
    destroyCharts('spendDonut');
    return;
  }
  container.classList.remove('hidden');

  const top = rows.sort((a, b) => b.amount - a.amount).slice(0, 6);
  listEl.className = 'smy-exps';
  listEl.innerHTML = top
    .map(
      (r, i) => `
      <div class="smy-exp">
        <span class="smy-exp-rank">${i + 1}</span>
        <span class="smy-exp-name" title="${esc(r.label)}">${esc(r.label)}</span>
        <span class="smy-exp-cat">${esc(r.cat)}</span>
        <span class="smy-exp-amt">${esc(money(r.amount))}</span>
      </div>`,
    )
    .join('');

  destroyCharts('spendDonut');
  const canvas = document.getElementById('summarySpendDonut');
  const donutCats = catActual.slice().sort((a, b) => b.amount - a.amount);
  if (canvas && donutCats.length && typeof Chart !== 'undefined') {
    _charts.spendDonut = new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels: donutCats.map((c) => c.label),
        datasets: [
          {
            data: donutCats.map((c) => c.amount),
            backgroundColor: donutCats.map(
              (_, i) => SPEND_DONUT_COLORS[i % SPEND_DONUT_COLORS.length],
            ),
            borderWidth: 2,
            borderColor: '#fff',
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '62%',
        plugins: {
          legend: { position: 'right', labels: { boxWidth: 10, font: { size: 10 }, padding: 8 } },
          tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${money(ctx.parsed)}` } },
        },
      },
    });
  }
}

// Pure budget-health verdict. Splits actual into budgeted vs unbudgeted and tallies
// each category. In LOOSE mode (default) a category with no budget set (budget 0) is
// unconfigured — its spend is informational, excluded from the over/remaining verdict.
// In STRICT mode a 0 budget is a hard limit, so any spend there is over. `cats` amounts
// are assumed to be in one (display) currency. Exported for unit testing.
export function budgetHealthCounts(cats, strict) {
  let budgetedActual = 0,
    unbudgetedActual = 0,
    totalBudget = 0,
    nOver = 0,
    nAtRisk = 0,
    nOk = 0,
    nUnbudgeted = 0;
  for (const c of Object.values(cats)) {
    if (c.budget === 0 && c.actual === 0) continue; // inactive category
    // Only a budget of exactly 0 is "unconfigured"; a negative budget (a credit/
    // allowance) is a real, configured target and counts toward the budgeted totals.
    if (c.budget !== 0) {
      budgetedActual += c.actual;
      totalBudget += c.budget;
    } else {
      unbudgetedActual += c.actual;
    }
    const catOver = c.actual > c.budget && c.budget > 0;
    const isUnbudgeted = c.budget === 0 && c.actual !== 0;
    if (catOver || (isUnbudgeted && strict)) nOver++;
    else if (isUnbudgeted && !strict) nUnbudgeted++;
    else if (c.budget > 0 && (c.actual / c.budget) * 100 >= 70) nAtRisk++;
    else nOk++;
  }
  const spentForVerdict = strict ? budgetedActual + unbudgetedActual : budgetedActual;
  const overBudget = spentForVerdict > totalBudget && totalBudget > 0;
  return {
    totalBudget,
    budgetedActual,
    unbudgetedActual,
    spentForVerdict,
    overBudget,
    nOver,
    nAtRisk,
    nOk,
    nUnbudgeted,
  };
}

function renderBudgetHealth(cats, totalBudget, totalActual, primaryCurr = '') {
  const el = document.getElementById('summaryBudgetHealth');
  if (!el) return;

  const activeCats = Object.entries(cats).filter(([, c]) => c.budget !== 0 || c.actual !== 0);
  if (!activeCats.length) {
    el.innerHTML = '';
    return;
  }

  // Loose (default) vs strict budget management.
  const strict = !!state.planner?.strictBudget;
  const counts = budgetHealthCounts(cats, strict);
  const { unbudgetedActual, spentForVerdict, overBudget, nOver, nAtRisk, nOk, nUnbudgeted } =
    counts;

  const fmt = (n) => {
    const s = formatAmount(n);
    if (_displayApprox) return `≈${s} ${primaryCurr}`;
    return primaryCurr ? `${primaryCurr} ${s}` : s;
  };

  // Sort worst-first so the most critical categories appear at the top
  const sorted = activeCats.slice().sort(([, a], [, b]) => {
    const pA = a.budget > 0 ? a.actual / a.budget : a.actual !== 0 ? Infinity : 0;
    const pB = b.budget > 0 ? b.actual / b.budget : b.actual !== 0 ? Infinity : 0;
    return pB - pA;
  });

  // Budget health is a three-band state, so it runs on the status ramp: on
  // track is the brand accent, at risk is warn, over is bad, unbudgeted is
  // plain ink. Returned as CSS variable expressions — these land in `style`
  // attributes, where the browser resolves them (unlike the map's SVG
  // attributes, which need a concrete value).
  const healthColor = (c) => {
    const rawPct = c.budget > 0 ? (c.actual / c.budget) * 100 : 0;
    const catOver = c.actual > c.budget && c.budget > 0;
    const isUnbudgeted = c.budget === 0 && c.actual !== 0;
    if (catOver || (isUnbudgeted && strict)) return 'var(--status-bad)';
    if (isUnbudgeted) return 'var(--ink-2)';
    return rawPct >= 70 ? 'var(--status-warn)' : 'var(--brand-1-ink)';
  };

  const catRows = sorted
    .map(([, c]) => {
      const rawPct = c.budget > 0 ? (c.actual / c.budget) * 100 : 0;
      const barPct = Math.min(rawPct, 100);
      const catOver = c.actual > c.budget && c.budget > 0;
      const isUnbudgeted = c.budget === 0 && c.actual !== 0;
      const catColor = healthColor(c);
      const remaining = c.budget - c.actual;
      const remainHtml = catOver
        ? `<b style="color:var(--status-bad)">${fmt(Math.abs(remaining))} over</b>`
        : isUnbudgeted
          ? strict
            ? `<b style="color:var(--status-warn)">unbudgeted</b>`
            : `${fmt(c.actual)} · no budget`
          : `<b>${fmt(remaining)}</b> left`;
      const pctBadge =
        c.budget > 0
          ? // The percentage takes the band's colour as INK. It used to also
            // wear a tinted pill, built by appending an alpha suffix to the hex
            // — a trick that only works on literals, and one more filled shape.
            `<span class="smy-hrow-pct" style="color:${catColor}">${rawPct.toFixed(0)}%</span>`
          : `<span class="smy-hrow-pct" style="color:var(--ink-2)">—</span>`;
      return `<div class="smy-hrow">
        <span class="smy-hrow-name">${esc(c.label)}</span>
        <span class="smy-hrow-track">${c.budget > 0 ? `<span class="smy-hrow-fill" style="width:${barPct.toFixed(1)}%;background:${catColor}"></span>` : ''}</span>
        ${pctBadge}
        <span class="smy-hrow-remain">${remainHtml}</span>
      </div>`;
    })
    .join('');

  // Verdict from the pure helper: loose = budgeted spend vs budget (unbudgeted is a note).
  const budgetTotal = counts.totalBudget;
  const remaining = budgetTotal - spentForVerdict;
  const pct = budgetTotal > 0 ? Math.min((spentForVerdict / budgetTotal) * 100, 100) : 0;
  const barColor = overBudget
    ? 'var(--status-bad)'
    : pct >= 70
      ? 'var(--status-warn)'
      : 'var(--brand-1-ink)';
  const unbudgetedNote =
    !strict && unbudgetedActual ? ` · +${fmt(unbudgetedActual)} unbudgeted` : '';

  const totalLine =
    budgetTotal !== 0
      ? `Spent <b>${fmt(spentForVerdict)}</b> of <b>${fmt(budgetTotal)}</b> ${
          overBudget
            ? `<span class="over">(${fmt(Math.abs(remaining))} over)</span>`
            : `(${fmt(remaining)} remaining)`
        }${unbudgetedNote}`
      : `Net <b>${fmt(totalActual)}</b>`;

  const dot = (color, label) => `<span class="smy-dot" style="--d:${color}">${label}</span>`;
  const statusDots = [
    nOver ? dot('var(--status-bad)', `${nOver} over`) : '',
    nAtRisk ? dot('var(--status-warn)', `${nAtRisk} at risk`) : '',
    nOk ? dot('var(--brand-1-ink)', `${nOk} on track`) : '',
    nUnbudgeted ? dot('var(--ink-2)', `${nUnbudgeted} no budget`) : '',
  ]
    .filter(Boolean)
    .join('');

  el.innerHTML = `
    <div class="smy-health">
      <div class="smy-health-head">
        <span class="smy-health-eyebrow">Budget health</span>
        <span class="smy-dots">${statusDots}</span>
      </div>
      <p class="smy-health-total">${totalLine}</p>
      ${budgetTotal > 0 ? `<div class="smy-hrow-track" style="height:9px;margin-top:0.6rem"><span class="smy-hrow-fill" style="width:${pct.toFixed(1)}%;background:${barColor}"></span></div>` : ''}
      ${sorted.length ? `<div class="smy-health-rows">${catRows}</div>` : ''}
    </div>`;
}

function renderSummaryThisEvent() {
  const statsGrid = document.getElementById('summaryStatsGrid');
  if (!statsGrid) return;

  // Determine the event date for historical FX rate lookup
  _currentRenderDate = clampRateDate(state.eventMeta?.startDate?.slice(0, 10) || '');

  const mode = state.planner?.mode || 'personal';
  const isPersonal = mode === 'personal';
  const visibleTabs = getVisibleTabs(mode);

  document
    .getElementById('summaryMemberChartSection')
    ?.classList.toggle('hidden', isPersonal || !visibleTabs.has('team'));

  const tasks = visibleTabs.has('tasks') ? state.planner.tasks || [] : [];
  const contacts = visibleTabs.has('contacts') ? state.planner.contacts || [] : [];
  const notes = visibleTabs.has('notes') ? state.planner.sessionNotes || {} : {};
  const receipts = visibleTabs.has('receipts') ? state.planner.receipts || [] : [];

  const tasksDone = tasks.filter((t) => t.done).length;
  const tasksOpen = tasks.filter((t) => !t.done).length;
  const contactCount = contacts.length;
  const notedCount = Object.values(notes).filter((n) => n.notes || n.rating || n.attended).length;
  const receiptCount = receipts.length;
  const receiptTotal = receipts.reduce((s, r) => s + parseBudget(r.amount), 0);

  function statCard(label, value, sub) {
    return `<div class="smy-stat">
      <p class="smy-stat-lbl">${esc(label)}</p>
      <p class="smy-stat-val">${esc(String(value))}</p>
      ${sub ? `<p class="smy-stat-sub">${esc(sub)}</p>` : ''}
    </div>`;
  }

  function renderCategoryChart(cats) {
    const conv = buildConvFn(_summaryCurrency, _currentRenderDate);
    destroyCharts('category');
    const catCanvas = document.getElementById('budgetCategoryChart');
    const activeCats = Object.entries(cats).filter(([, c]) => c.budget > 0 || c.actual > 0);
    if (catCanvas && activeCats.length && typeof Chart !== 'undefined') {
      const fmtChartVal = (v) => {
        const s = formatAmount(v);
        return conv && _summaryCurrency
          ? `≈${s} ${_summaryCurrency}`
          : _primaryDisplayCurrency
            ? `${_primaryDisplayCurrency} ${s}`
            : s;
      };
      // Categories with spend but no budget target use a sentinel (110) so the bar renders
      // just past the 100% reference line in amber, making unbudgeted spend visible.
      const utilData = activeCats.map(([, c]) =>
        c.budget > 0
          ? parseFloat(((c.actual / c.budget) * 100).toFixed(1))
          : c.actual > 0
            ? 110
            : null,
      );
      const looseBudget = !state.planner?.strictBudget;
      const bgColors = activeCats.map(([, c]) => {
        // Loose mode: unbudgeted spend is neutral grey, not amber "over".
        if (c.budget === 0 && c.actual > 0)
          return looseBudget ? 'rgba(156,163,175,0.75)' : 'rgba(180,83,9,0.85)';
        const p = c.budget > 0 ? (c.actual / c.budget) * 100 : 0;
        return p >= 100
          ? 'rgba(220,38,38,0.8)'
          : p >= 70
            ? 'rgba(180,83,9,0.85)'
            : 'rgba(176,111,18,0.85)';
      });
      const bdrColors = activeCats.map(([, c]) => {
        if (c.budget === 0 && c.actual > 0) return '#b45309';
        const p = c.budget > 0 ? (c.actual / c.budget) * 100 : 0;
        // Canvas, not CSS — Chart.js paints pixels, so these resolve now.
        return p >= 100
          ? chartColor('--status-bad')
          : p >= 70
            ? chartColor('--status-warn')
            : chartColor('--brand-1-ink');
      });
      const refLine = {
        id: 'budgetLine',
        afterDraw(chart) {
          const { ctx, chartArea, scales } = chart;
          if (!scales.x) return;
          const x = scales.x.getPixelForValue(100);
          if (x < chartArea.left || x > chartArea.right) return;
          ctx.save();
          ctx.strokeStyle = 'rgba(107,114,128,0.45)';
          ctx.lineWidth = 1.5;
          ctx.setLineDash([5, 4]);
          ctx.beginPath();
          ctx.moveTo(x, chartArea.top);
          ctx.lineTo(x, chartArea.bottom);
          ctx.stroke();
          ctx.restore();
        },
      };
      _charts.category = new Chart(catCanvas, {
        type: 'bar',
        data: {
          labels: activeCats.map(([, c]) => c.label),
          datasets: [
            {
              label: '% of budget used',
              data: utilData,
              backgroundColor: bgColors,
              borderColor: bdrColors,
              borderWidth: 1,
            },
          ],
        },
        options: {
          indexAxis: 'y',
          responsive: true,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                title: (items) => activeCats[items[0].dataIndex][1].label,
                label: (ctx) => {
                  const [, c] = activeCats[ctx.dataIndex];
                  if (c.budget === 0 && c.actual > 0) {
                    return [
                      `  Actual: ${fmtChartVal(c.actual)}`,
                      `  No budget target set`,
                      `  Click to drill down`,
                    ];
                  }
                  const lines = [`  Actual: ${fmtChartVal(c.actual)}`];
                  if (c.budget > 0) {
                    lines.push(`  Budget: ${fmtChartVal(c.budget)}`);
                    const rem = c.budget - c.actual;
                    lines.push(
                      rem >= 0
                        ? `  Left:   ${fmtChartVal(rem)}`
                        : `  Over:   ${fmtChartVal(Math.abs(rem))}`,
                    );
                  }
                  lines.push('  Click to drill down');
                  return lines;
                },
              },
            },
          },
          aspectRatio: activeCats.length > 5 ? 1.8 : 2.5,
          scales: { x: { min: 0, suggestedMax: 115, ticks: { callback: (v) => `${v}%` } } },
          onClick(_, elements) {
            if (!elements.length) return;
            const [key] = activeCats[elements[0].index];
            openDrilldown(key, cats[key]);
          },
        },
        plugins: [refLine],
      });
    } else if (catCanvas) {
      catCanvas.getContext('2d').clearRect(0, 0, catCanvas.width, catCanvas.height);
    }
  }

  if (isPersonal) {
    const personal = state.planner.personal || {};
    const allLegs = [...(personal.outboundLegs || []), ...(personal.returnLegs || [])];
    const totalLegs = allLegs.length;
    const unconfirmedLegs = allLegs.filter(
      (l) => l.status !== 'confirmed' && l.status !== 'cancelled',
    ).length;
    let accomNights = 0;
    (personal.accommodations || []).forEach((acc) => {
      // Dates may live on the traveller's own stay (`__me__`) or on the
      // accommodation itself — mirror the itinerary and look at both.
      const meStay = (acc.assignments || []).find((s) => s.memberId === '__me__');
      const checkIn = meStay?.checkIn || acc.checkIn;
      const checkOut = meStay?.checkOut || acc.checkOut;
      if (checkIn && checkOut) {
        const n = Math.round((new Date(checkOut) - new Date(checkIn)) / 86400000);
        if (n > 0) accomNights += n;
      }
    });
    const personalItinerary = personal.itinerary || [];
    const itinDone = personalItinerary.filter((i) => i.done).length;
    const itinOpen = personalItinerary.filter((i) => !i.done).length;
    const tickets = personal.tickets || [];
    const ticketsPending = tickets.filter(
      (t) => t.status !== 'cancelled' && t.status !== 'assigned',
    ).length;

    const primaryCurr = personal.currency || 'AUD';
    _primaryDisplayCurrency = primaryCurr;
    // Roll totals up into the planner's preferred display currency (falls back to
    // the trip currency). Per-line native amounts still show in the planner-page
    // breakdown; here the totals just need one honest currency.
    const target = _summaryCurrency || primaryCurr;
    const conv = buildConvFn(target, _currentRenderDate);
    const cats = buildPersonalBudgetData(state.planner, conv);
    let totalBudget = 0,
      totalActual = 0;
    Object.values(cats).forEach((c) => {
      totalBudget += c.budget;
      totalActual += c.actual;
    });
    const hasBudgetData = Object.values(cats).some((c) => c.budget !== 0 || c.actual !== 0);
    const mixed = Object.values(cats).some((c) =>
      (c.items || []).some((it) => it.curr && it.curr !== target),
    );
    // Show the "≈" approximation marker only when a real conversion happens — a
    // mixed-currency trip, or a display currency different from the native one.
    const converting = !!conv && (mixed || target !== primaryCurr);
    _displayApprox = converting;
    ensureThisEventRates(target);
    const fmtStat = (n) =>
      converting
        ? `≈${formatAmount(n)} ${target}`
        : `${primaryCurr} ${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
    _showRateNotice(
      false,
      _summaryCurrency ? `${_summaryCurrency}:${_currentRenderDate || 'current'}` : '',
    );

    statsGrid.innerHTML = [
      statCard(
        'Travel legs',
        totalLegs,
        unconfirmedLegs ? `${unconfirmedLegs} unconfirmed` : 'all confirmed',
      ),
      statCard('Nights', accomNights),
      visibleTabs.has('tickets')
        ? statCard(
            'Tickets',
            tickets.length,
            ticketsPending ? `${ticketsPending} pending` : tickets.length ? 'all done' : '',
          )
        : '',
      visibleTabs.has('tasks')
        ? statCard('Tasks', tasksDone + ' / ' + (tasksDone + tasksOpen), `${tasksOpen} open`)
        : '',
      statCard('Itinerary', itinDone + ' / ' + (itinDone + itinOpen), `${itinOpen} open`),
      visibleTabs.has('contacts') ? statCard('Contacts', contactCount) : '',
      visibleTabs.has('notes') ? statCard('Sessions noted', notedCount) : '',
      visibleTabs.has('receipts')
        ? statCard('Receipts', receiptCount, receiptTotal ? receiptTotal.toLocaleString() : '')
        : '',
      visibleTabs.has('budget') && hasBudgetData ? statCard('My budget', fmtStat(totalBudget)) : '',
      visibleTabs.has('budget') && hasBudgetData ? statCard('My actual', fmtStat(totalActual)) : '',
    ]
      .filter(Boolean)
      .join('');

    renderBudgetHealth(
      visibleTabs.has('budget') ? cats : {},
      visibleTabs.has('budget') ? totalBudget : 0,
      visibleTabs.has('budget') ? totalActual : 0,
      target,
    );
    renderSummaryBreakdown(visibleTabs.has('budget') ? cats : {}, target);
    renderCategoryChart(visibleTabs.has('budget') ? cats : {});
    renderPersonalSpendViz(visibleTabs.has('budget') ? cats : {}, conv, target, converting);
    destroyCharts('member');
    return;
  }

  // ── Sponsor mode ─────────────────────────────────────────────────────────────
  const org = state.planner.org;
  const assignments = org.teamAssignments || [];
  const accommodations = org.accommodations || [];

  const memberCount = assignments.length;
  const allOrgLegs = assignments.flatMap((a) => [
    ...(a.outboundLegs || []),
    ...(a.returnLegs || []),
  ]);
  const totalLegs = allOrgLegs.length;
  const unconfirmedLegs = allOrgLegs.filter(
    (l) => l.status !== 'confirmed' && l.status !== 'cancelled',
  ).length;
  const totalNights = accommodations.reduce(
    (sum, acc) =>
      sum +
      (acc.assignments || []).reduce((s2, a) => {
        if (!a.checkIn || !a.checkOut) return s2;
        const n = Math.round((new Date(a.checkOut) - new Date(a.checkIn)) / 86400000);
        return s2 + (n > 0 ? n : 0);
      }, 0),
    0,
  );
  const itinerary = state.planner.org.memberItinerary || [];
  const itinDone = itinerary.filter((i) => i.done).length;
  const itinOpen = itinerary.filter((i) => !i.done).length;
  const orgTickets = org.tickets || [];
  const orgTicketsPending = orgTickets.filter(
    (t) => t.status !== 'cancelled' && t.status !== 'assigned',
  ).length;

  const primaryCurr = org.sponsorCurrency || 'AUD';
  _primaryDisplayCurrency = primaryCurr;
  // Roll totals up into the planner's preferred display currency (falls back to
  // the sponsor currency). (Same as the personal summary above.)
  const target = _summaryCurrency || primaryCurr;
  const conv = buildConvFn(target, _currentRenderDate);
  const cats = buildEventBudgetData(state.planner, null, conv);
  let totalBudget = 0,
    totalActual = 0;
  Object.values(cats).forEach((c) => {
    totalBudget += c.budget;
    totalActual += c.actual;
  });
  const hasBudgetData = Object.values(cats).some((c) => c.budget !== 0 || c.actual !== 0);
  const mixed = Object.values(cats).some((c) =>
    (c.items || []).some((it) => it.curr && it.curr !== target),
  );
  const converting = !!conv && (mixed || target !== primaryCurr);
  _displayApprox = converting;
  ensureThisEventRates(target);
  const fmtStat = (n) =>
    converting
      ? `≈${formatAmount(n)} ${target}`
      : `${primaryCurr} ${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  _showRateNotice(
    false,
    _summaryCurrency ? `${_summaryCurrency}:${_currentRenderDate || 'current'}` : '',
  );

  statsGrid.innerHTML = [
    visibleTabs.has('team') ? statCard('Members', memberCount) : '',
    statCard(
      'Travel legs',
      totalLegs,
      unconfirmedLegs ? `${unconfirmedLegs} unconfirmed` : totalLegs ? 'all confirmed' : '',
    ),
    statCard('Nights', totalNights),
    visibleTabs.has('tickets')
      ? statCard(
          'Tickets',
          orgTickets.length,
          orgTicketsPending ? `${orgTicketsPending} pending` : orgTickets.length ? 'all done' : '',
        )
      : '',
    visibleTabs.has('tasks')
      ? statCard('Tasks', tasksDone + ' / ' + (tasksDone + tasksOpen), `${tasksOpen} open`)
      : '',
    statCard('Itinerary', itinDone + ' / ' + (itinDone + itinOpen), `${itinOpen} open`),
    visibleTabs.has('contacts') ? statCard('Contacts', contactCount) : '',
    visibleTabs.has('notes') ? statCard('Sessions noted', notedCount) : '',
    visibleTabs.has('receipts')
      ? statCard('Receipts', receiptCount, receiptTotal ? receiptTotal.toLocaleString() : '')
      : '',
    visibleTabs.has('budget') && hasBudgetData
      ? statCard('Total budget', fmtStat(totalBudget))
      : '',
    visibleTabs.has('budget') && hasBudgetData
      ? statCard('Total actual', fmtStat(totalActual))
      : '',
  ]
    .filter(Boolean)
    .join('');

  renderBudgetHealth(
    visibleTabs.has('budget') ? cats : {},
    visibleTabs.has('budget') ? totalBudget : 0,
    visibleTabs.has('budget') ? totalActual : 0,
    target,
  );
  renderSummaryBreakdown(visibleTabs.has('budget') ? cats : {}, target);
  renderCategoryChart(visibleTabs.has('budget') ? cats : {});
  // The top-expenses/donut visualisations are personal-only.
  document.getElementById('summaryPersonalViz')?.classList.add('hidden');
  destroyCharts('spendDonut');

  // ── Per-member chart ─────────────────────────────────────────────────────────
  destroyCharts('member');
  if (!visibleTabs.has('team')) return;
  const memberCanvas = document.getElementById('budgetMemberChart');
  const memberData = assignments
    .map((a) => {
      const m = state.global?.teamMembers.find((tm) => tm.id === a.memberId);
      const aCurr = a.currency || 'AUD';
      const b = (conv ?? ((n) => n))(parseBudget(a.budget), aCurr);
      const ac = (conv ?? ((n) => n))(parseBudget(a.budgetActual), aCurr);
      let accomB = 0,
        accomAc = 0;
      (org.accommodations || []).forEach((acc) => {
        const stay = (acc.assignments || []).find((s) => s.memberId === a.memberId);
        if (stay) {
          const sCurr = stay.currency || 'AUD';
          accomB += (conv ?? ((n) => n))(parseBudget(stay.budget), sCurr);
          accomAc += (conv ?? ((n) => n))(parseBudget(stay.budgetActual), sCurr);
        }
      });
      let ticketAc = 0;
      (org.tickets || []).forEach((t) => {
        if (t.assignedTo !== a.memberId && t.purchasedBy !== a.memberId) return;
        const tCurr = t.currency || 'AUD';
        const qty = parseBudget(t.quantity) || 1;
        ticketAc += (conv ?? ((n) => n))(parseBudget(t.unitPrice) * qty, tCurr);
      });
      let assignedAc = 0;
      (org.budgetItems || [])
        .filter((item) => item.memberId === a.memberId)
        .forEach((item) => {
          const iCurr = item.currency || 'AUD';
          const linked = (state.planner.receipts || []).filter((r) => r.budgetItemId === item.id);
          assignedAc += linked.length
            ? linked.reduce(
                (s, r) => s + (conv ?? ((n) => n))(parseBudget(r.amount), r.currency || iCurr),
                0,
              )
            : (conv ?? ((n) => n))(parseBudget(item.actual), iCurr);
        });
      return {
        name: m?.name || 'Unnamed',
        budget: b + accomB,
        actual: ac + accomAc + ticketAc + assignedAc,
        memberId: a.memberId,
        memberBudget: b,
        memberActual: ac,
        accomBudget: accomB,
        accomActual: accomAc,
        ticketActual: ticketAc,
        assignedActual: assignedAc,
      };
    })
    .filter((d) => d.budget || d.actual);

  if (memberCanvas && memberData.length && typeof Chart !== 'undefined') {
    const fmtMemberVal = (v) => {
      const s = formatAmount(v);
      return conv && _summaryCurrency ? `≈${s} ${_summaryCurrency}` : `${primaryCurr} ${s}`;
    };
    const mUtilData = memberData.map((d) =>
      d.budget > 0 ? parseFloat(((d.actual / d.budget) * 100).toFixed(1)) : null,
    );
    const mBgColors = memberData.map((d) => {
      const p = d.budget > 0 ? (d.actual / d.budget) * 100 : 0;
      return p >= 100
        ? 'rgba(220,38,38,0.8)'
        : p >= 70
          ? 'rgba(180,83,9,0.85)'
          : 'rgba(79,70,229,0.8)';
    });
    const mBdrColors = memberData.map((d) => {
      const p = d.budget > 0 ? (d.actual / d.budget) * 100 : 0;
      return p >= 100
        ? chartColor('--status-bad')
        : p >= 70
          ? chartColor('--status-warn')
          : chartColor('--viz-7');
    });
    const memberRefLine = {
      id: 'memberBudgetLine',
      afterDraw(chart) {
        const { ctx, chartArea, scales } = chart;
        if (!scales.x) return;
        const x = scales.x.getPixelForValue(100);
        if (x < chartArea.left || x > chartArea.right) return;
        ctx.save();
        ctx.strokeStyle = 'rgba(107,114,128,0.45)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(x, chartArea.top);
        ctx.lineTo(x, chartArea.bottom);
        ctx.stroke();
        ctx.restore();
      },
    };
    _charts.member = new Chart(memberCanvas, {
      type: 'bar',
      data: {
        labels: memberData.map((d) => d.name),
        datasets: [
          {
            label: '% of budget used',
            data: mUtilData,
            backgroundColor: mBgColors,
            borderColor: mBdrColors,
            borderWidth: 1,
          },
        ],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (items) => memberData[items[0].dataIndex].name,
              label: (ctx) => {
                const d = memberData[ctx.dataIndex];
                const lines = [`  Actual: ${fmtMemberVal(d.actual)}`];
                if (d.budget > 0) {
                  lines.push(`  Budget: ${fmtMemberVal(d.budget)}`);
                  const rem = d.budget - d.actual;
                  lines.push(
                    rem >= 0
                      ? `  Left:   ${fmtMemberVal(rem)}`
                      : `  Over:   ${fmtMemberVal(Math.abs(rem))}`,
                  );
                }
                lines.push('  Click to drill down');
                return lines;
              },
            },
          },
        },
        aspectRatio: memberData.length > 5 ? 1.8 : 2.5,
        scales: { x: { min: 0, suggestedMax: 115, ticks: { callback: (v) => `${v}%` } } },
        onClick(_, elements) {
          if (!elements.length) return;
          const d = memberData[elements[0].index];
          openMemberDrilldown(d, state.planner);
        },
      },
      plugins: [memberRefLine],
    });
  } else if (memberCanvas) {
    memberCanvas.getContext('2d').clearRect(0, 0, memberCanvas.width, memberCanvas.height);
  }
}

async function renderSummaryAllEvents() {
  const container = document.getElementById('summaryAllEvents');
  if (!container) return;

  // ── Step 1: Gather raw planner metadata from localStorage ───────────────────
  const rawPlanners = [];
  for (const key of listKeys(STORAGE_PREFIX)) {
    if (key === GLOBAL_KEY) continue;
    const slug = key.slice(STORAGE_PREFIX.length);
    const data = readJson(key, {});
    if (!isPlannerEntry(slug, data)) continue;
    rawPlanners.push({ data, slug });
  }

  // ── Step 2: Pre-fetch event start dates for all planners with event files ───
  await Promise.all(
    rawPlanners
      .filter((p) => p.data._eventFile && !_eventDates.has(p.data._eventFile))
      .map((p) => fetchEventDates(p.data._eventFile)),
  );

  // ── Step 3: Pre-fetch historical rates for each unique event date ────────────
  if (_summaryCurrency) {
    const uniqueDates = [
      ...new Set(
        rawPlanners
          .map((p) =>
            clampRateDate(p.data._eventFile ? _eventDates.get(p.data._eventFile)?.start || '' : ''),
          )
          .filter(Boolean),
      ),
    ];
    await Promise.all(uniqueDates.map((d) => fetchRates(_summaryCurrency, d).catch(() => null)));
    // Also load current rates as fallback for events without a known date
    await fetchRates(_summaryCurrency, '').catch(() => null);
  }

  // ── Step 4: Build per-event budget data using date-appropriate rates ─────────
  const rawEvents = rawPlanners
    .map(({ data, slug }) => {
      const label = data._displayName || (data._eventFile || slug).replace('.json', '');
      const plannerMode = data.mode === 'individual' ? 'personal' : data.mode || 'personal';
      const eventDate = clampRateDate(
        data._eventFile ? _eventDates.get(data._eventFile)?.start || '' : '',
      );
      const conv = buildConvFn(_summaryCurrency, eventDate);

      let budget = 0,
        actual = 0,
        catData = {};
      if (plannerMode === 'sponsor') {
        const cats = buildEventBudgetData(data, null, conv);
        Object.values(cats).forEach((c) => {
          budget += c.budget;
          actual += c.actual;
        });
        catData = cats;
      } else {
        const cats = buildPersonalBudgetData(data, conv);
        Object.values(cats).forEach((c) => {
          budget += c.budget;
          actual += c.actual;
        });
        catData = cats;
      }

      const yearMatch = (label + ' ' + (data._eventFile || slug)).match(/\b(20\d{2})\b/);
      const eventYear = yearMatch ? parseInt(yearMatch[1], 10) : 0;
      return {
        label,
        slug,
        mode: plannerMode,
        budget,
        actual,
        catData,
        eventFile: data._eventFile || '',
        eventYear,
        rawPlanner: data,
        eventDate,
      };
    })
    .filter((e) => e.budget > 0 || e.actual > 0);

  // Update rate notice — show historical note if any event used a dated rate
  if (_summaryCurrency) {
    const anyHistorical = rawEvents.some(
      (e) => e.eventDate && hasRate(_summaryCurrency, e.eventDate),
    );
    const anyLoaded = ratesLoadedFor(_summaryCurrency);
    const notice = document.getElementById('summaryRateNotice');
    const text = document.getElementById('summaryRateNoticeText');
    if (notice && text) {
      notice.classList.remove('hidden');
      if (!anyLoaded) {
        text.textContent = `Exchange rates for ${_summaryCurrency} not loaded — values shown as entered.`;
      } else if (anyHistorical) {
        text.textContent =
          `Values shown as approximate ${_summaryCurrency} equivalents using historical ECB rates for each event's date. ` +
          `Currencies outside ECB coverage are shown as-entered. Suitable for budgeting; use actual transaction rates for formal bookkeeping.`;
      } else {
        const cur = getRateEntry(_summaryCurrency);
        text.textContent =
          `Values shown as approximate ${_summaryCurrency} equivalents using ECB rates from ${cur?.rateDate || 'latest available'}. ` +
          `Currencies outside ECB coverage are shown as-entered. Suitable for budgeting; use actual transaction rates for formal bookkeeping.`;
      }
    }
  } else {
    document.getElementById('summaryRateNotice')?.classList.add('hidden');
  }

  // Sort chronologically by event year, then alphabetically within the same year
  rawEvents.sort((a, b) => {
    const ya = a.eventYear || 9999;
    const yb = b.eventYear || 9999;
    if (ya !== yb) return ya - yb;
    return a.label.localeCompare(b.label);
  });

  const { start, end, hidden, person } = _globalSummaryFilter;
  const startYear = start ? parseInt(start.slice(0, 4), 10) : null;
  const endYear = end ? parseInt(end.slice(0, 4), 10) : null;

  // 1. Date range filter
  const dateFiltered = rawEvents.filter((e) => {
    if (e.eventYear > 0) {
      if (startYear !== null && e.eventYear < startYear) return false;
      if (endYear !== null && e.eventYear > endYear) return false;
    }
    return true;
  });

  // 2. Person filter — '' = everyone, 'me' = personal only, 'sponsor' = all sponsor, memberId = sponsor for that member
  let allEvents;
  if (!person) {
    allEvents = dateFiltered;
  } else if (person === 'me') {
    allEvents = dateFiltered.filter((e) => e.mode === 'personal');
  } else if (person === 'sponsor') {
    allEvents = dateFiltered.filter((e) => e.mode === 'sponsor');
  } else {
    allEvents = dateFiltered
      .filter((e) => {
        if (e.mode !== 'sponsor') return false;
        const org = e.rawPlanner.org || {};
        return (
          (org.teamAssignments || []).some((a) => a.memberId === person) ||
          (org.accommodations || []).some((acc) =>
            (acc.assignments || []).some((s) => s.memberId === person),
          )
        );
      })
      .map((e) => {
        const eConv = buildConvFn(_summaryCurrency, e.eventDate || '');
        const cats = buildEventBudgetData(e.rawPlanner, person, eConv);
        let b = 0,
          a = 0;
        Object.values(cats).forEach((c) => {
          b += c.budget;
          a += c.actual;
        });
        return { ...e, budget: b, actual: a, catData: cats };
      });
  }

  // 3. Per-event visibility toggle (manual hide/show via chart pills)
  const events = allEvents.filter((e) => !hidden.has(e.slug));

  // Keep "View as" dropdown in sync with current state (team members may vary per render)
  const personSelect = document.getElementById('globalPersonFilter');
  if (personSelect) {
    const teamMembers = state.global?.teamMembers || [];
    personSelect.innerHTML =
      `<option value="">All planners</option>` +
      `<option value="me"${person === 'me' ? ' selected' : ''}>Personal only</option>` +
      `<option value="sponsor"${person === 'sponsor' ? ' selected' : ''}>Sponsor only</option>` +
      (teamMembers.length
        ? `<optgroup label="Sponsor — by person">` +
          teamMembers
            .map(
              (m) =>
                `<option value="${esc(m.id)}"${m.id === person ? ' selected' : ''}>${esc(m.name || 'Unnamed')}${m.role ? ` — ${esc(m.role)}` : ''}</option>`,
            )
            .join('') +
          `</optgroup>`
        : '');
  }

  // Render event toggle pills (drawn from date-filtered set so users can un-hide)
  const filterEl = document.getElementById('globalChartEventFilter');
  if (filterEl) {
    if (allEvents.length > 1) {
      filterEl.style.display = 'flex';
      filterEl.innerHTML = allEvents
        .map((e) => {
          const isHidden = hidden.has(e.slug);
          return `<label class="smy-filter-pill${isHidden ? ' is-off' : ''}">
          <input type="checkbox" class="sr-only" ${isHidden ? '' : 'checked'} data-slug="${esc(e.slug)}">
          <span class="smy-filter-dot" aria-hidden="true"></span>
          <span>${esc(e.label)}</span>
        </label>`;
        })
        .join('');
      filterEl.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
        cb.addEventListener('change', (ev) => {
          const slug = ev.target.dataset.slug;
          if (ev.target.checked) _globalSummaryFilter.hidden.delete(slug);
          else _globalSummaryFilter.hidden.add(slug);
          renderSummaryAllEvents();
        });
      });
    } else {
      filterEl.style.display = 'none';
      filterEl.innerHTML = '';
    }
  }

  const totalBudget = events.reduce((s, e) => s + e.budget, 0);
  const totalActual = events.reduce((s, e) => s + e.actual, 0);
  const variance = totalBudget - totalActual;
  const over = variance < 0;

  // The same tile the per-event scoreboard uses — there is no reason the
  // all-events view should have its own.
  function statCard(label, value, sub) {
    return `<div class="smy-stat">
      <p class="smy-stat-lbl">${esc(label)}</p>
      <p class="smy-stat-val">${esc(String(value))}</p>
      ${sub ? `<p class="smy-stat-sub">${esc(sub)}</p>` : ''}
    </div>`;
  }

  // True if any rates are loaded for the target currency (at least one event will be converted)
  const isConverting = !!(_summaryCurrency && ratesLoadedFor(_summaryCurrency));

  const fmtN = (n) => {
    if (!n) return '—';
    const s = formatAmount(n);
    return isConverting ? `≈${s} ${_summaryCurrency}` : s;
  };
  const asEnteredSub = isConverting ? null : 'as entered';

  const statsRow = document.getElementById('globalSummaryStatsRow');
  if (statsRow) {
    statsRow.innerHTML = [
      statCard('Events tracked', events.length),
      statCard('Total budget', fmtN(totalBudget), asEnteredSub),
      statCard('Total actual', fmtN(totalActual), asEnteredSub),
      totalBudget
        ? `<div class="smy-stat smy-stat--verdict ${over ? 'is-over' : 'is-ok'}">
            <p class="smy-stat-lbl">${over ? 'Over budget' : 'Remaining'}</p>
            <p class="smy-stat-val">${fmtN(Math.abs(variance))}</p>
            ${asEnteredSub ? `<p class="smy-stat-sub">${asEnteredSub}</p>` : ''}
          </div>`
        : '',
    ]
      .filter(Boolean)
      .join('');
  }

  // Per-event breakdown table — improved design
  const tableEl = document.getElementById('globalEventTable');
  if (tableEl) {
    if (!rawEvents.length) {
      tableEl.innerHTML = '<p class="smy-empty">No planner data found.</p>';
    } else if (!events.length) {
      tableEl.innerHTML = '<p class="smy-empty">No events match the current filters.</p>';
    } else {
      const pfx = isConverting ? '≈' : '';
      const sfx = isConverting ? ` ${_summaryCurrency}` : '';
      const fmt = (n) => (n ? `${pfx}${formatAmount(n)}${sfx}` : '—');
      const currLabel = isConverting ? ` (≈${_summaryCurrency})` : ' (as entered)';
      tableEl.innerHTML = `
        <table class="smy-tbl">
          <thead>
            <tr>
              <th>Event</th>
              <th class="smy-col-mode">Mode</th>
              <th class="is-num">Budget${currLabel}</th>
              <th class="is-num">Actual${currLabel}</th>
              <th class="is-num smy-col-var">Variance${currLabel}</th>
            </tr>
          </thead>
          <tbody>
            ${events
              .map((e) => {
                const v = e.budget - e.actual;
                const rowOver = v < 0 && e.budget;
                const isThis = e.slug === state.plannerKey;
                return `<tr class="${isThis ? 'is-here' : ''}">
                <td class="is-name">
                  <div class="flex items-start gap-1.5">
                    ${isThis ? '<span class="smy-here" aria-label="This event"></span>' : ''}
                    <div>
                      <span class="${isThis ? 'font-medium' : ''}">${esc(e.label)}</span>
                      <span class="smy-tbl-sub">${e.eventFile ? esc(e.eventFile.replace('.json', '')) : '<i>no schedule</i>'}</span>
                    </div>
                  </div>
                </td>
                <td class="smy-col-mode">
                  <span class="smy-mode${e.mode === 'sponsor' ? ' smy-mode--sponsor' : ''}">${esc(e.mode)}</span>
                </td>
                <td class="is-num">${fmt(e.budget)}</td>
                <td class="is-num ${rowOver ? 'is-over' : ''}">${fmt(e.actual)}</td>
                <td class="is-num smy-col-var">
                  ${
                    e.budget || e.actual
                      ? `<span class="smy-var ${v < 0 ? 'smy-var--over' : v > 0 ? 'smy-var--under' : ''}">
                        ${v !== 0 ? `<span class="smy-dir" aria-hidden="true">${v < 0 ? '▲' : '▼'}</span>` : ''}
                        ${fmt(Math.abs(v))}
                      </span>`
                      : '—'
                  }
                </td>
              </tr>`;
              })
              .join('')}
          </tbody>
          ${
            events.length > 1
              ? `
          <tfoot>
            <tr>
              <td>Total</td>
              <td class="smy-col-mode"></td>
              <td class="is-num">${fmt(totalBudget)}</td>
              <td class="is-num ${totalActual > totalBudget && totalBudget ? 'is-over' : ''}">${fmt(totalActual)}</td>
              <td class="is-num smy-col-var">
                <span class="smy-var ${over ? 'smy-var--over' : 'smy-var--under'}">
                  <span class="smy-dir" aria-hidden="true">${over ? '▲' : '▼'}</span>
                  ${fmt(Math.abs(variance))}
                </span>
              </td>
            </tr>
          </tfoot>`
              : ''
          }
        </table>`;
    }
  }

  // Aggregated category totals
  const catTotals = {};
  events.forEach((e) => {
    Object.entries(e.catData).forEach(([k, c]) => {
      if (!catTotals[k]) catTotals[k] = { label: c.label, budget: 0, actual: 0 };
      catTotals[k].budget += c.budget;
      catTotals[k].actual += c.actual;
    });
  });
  const activeCats = Object.entries(catTotals).filter(([, c]) => c.budget > 0 || c.actual > 0);
  const catEl = document.getElementById('globalCategoryBreakdown');
  if (catEl) {
    if (activeCats.length) {
      const catPfx = isConverting ? '≈' : '';
      const catSfx = isConverting ? ` ${_summaryCurrency}` : '';
      const catCurrLabel = isConverting ? ` (≈${_summaryCurrency})` : ' (as entered)';
      const fmt = (n) => (n ? `${catPfx}${formatAmount(n)}${catSfx}` : '—');
      catEl.innerHTML = `
        <div class="smy-catgrid">
          <span class="smy-catgrid-h">Category</span>
          <span class="smy-catgrid-h is-num">Budget${catCurrLabel}</span>
          <span class="smy-catgrid-h is-num">Actual${catCurrLabel}</span>
          ${activeCats
            .map(
              ([, c]) => `
            <span class="smy-catgrid-name">${esc(c.label)}</span>
            <span class="smy-catgrid-num">${fmt(c.budget)}</span>
            <span class="smy-catgrid-num ${c.actual > c.budget && c.budget ? 'is-over' : ''}">${fmt(c.actual)}</span>
          `,
            )
            .join('')}
        </div>`;
    } else {
      catEl.innerHTML = '';
    }
  }

  // Chart — fetch real event dates, group by Wednesday of each event week
  const chartEvents = events.filter((e) => e.budget > 0 || e.actual > 0);

  // Fetch start dates in parallel (cached after first load, fast on repeat renders)
  await Promise.all(
    chartEvents
      .filter((e) => e.eventFile && !_eventDates.has(e.eventFile))
      .map((e) => fetchEventDates(e.eventFile)),
  );

  // Group events that share the same event-week Wednesday into one data point
  const dateGroups = new Map();
  chartEvents.forEach((e) => {
    const wed = e.eventFile ? (_eventDates.get(e.eventFile)?.wednesday ?? null) : null;
    // Fall back to mid-year Wednesday when no event file date is available
    const key = wed ?? (e.eventYear ? toWednesdayOfWeek(`${e.eventYear}-07-01`) : 'unknown');
    if (!dateGroups.has(key)) dateGroups.set(key, { wed: key, budget: 0, actual: 0, events: [] });
    const g = dateGroups.get(key);
    g.budget += e.budget;
    g.actual += e.actual;
    g.events.push(e);
  });

  const groups = [...dateGroups.values()].sort((a, b) => a.wed.localeCompare(b.wed));

  const fmtWedLabel = (wedStr) => {
    if (!wedStr || wedStr === 'unknown') return 'Unknown date';
    const d = new Date(`${wedStr}T00:00:00Z`);
    return d.toLocaleDateString('en', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
  };

  destroyCharts('global');
  const canvas = document.getElementById('globalBudgetChart');
  // Chart.js is a CDN global. A chart that cannot draw must not take the whole
  // planner down at boot — which is exactly what happened offline, where the
  // library never arrives and `new Chart` threw straight through `init()`.
  if (!canvas || typeof Chart === 'undefined') return;

  if (groups.length) {
    const globalCurrLabel = isConverting ? ` (≈${_summaryCurrency})` : ' (as entered)';
    const fmt2 = (n) => {
      if (!n) return '—';
      const s = formatAmount(n);
      return isConverting ? `≈${s} ${_summaryCurrency}` : s;
    };
    _charts.global = new Chart(canvas, {
      type: 'line',
      data: {
        labels: groups.map((g) => fmtWedLabel(g.wed)),
        datasets: [
          {
            label: `Budget${globalCurrLabel}`,
            data: groups.map((g) => g.budget),
            borderColor: '#3b82f6',
            backgroundColor: 'rgba(59,130,246,0.1)',
            tension: 0.3,
            fill: true,
            pointRadius: 5,
            pointHoverRadius: 7,
          },
          {
            label: `Actual${globalCurrLabel}`,
            data: groups.map((g) => g.actual),
            borderColor: '#10b981',
            backgroundColor: 'rgba(16,185,129,0.1)',
            tension: 0.3,
            fill: true,
            pointRadius: 5,
            pointHoverRadius: 7,
          },
        ],
      },
      options: {
        responsive: true,
        aspectRatio: 4,
        plugins: {
          legend: { position: 'top' },
          tooltip: {
            callbacks: {
              label: (ctx) => ` ${ctx.dataset.label?.split(' (')[0] ?? ''}: ${fmt2(ctx.parsed.y)}`,
              afterBody: (items) => {
                const g = groups[items[0]?.dataIndex];
                if (!g || g.events.length <= 1) return [];
                const lines = ['', 'Events at this point:'];
                g.events.forEach((e) => {
                  lines.push(`  ${e.label}`);
                  lines.push(`    Budget: ${fmt2(e.budget)}  ·  Actual: ${fmt2(e.actual)}`);
                });
                return lines;
              },
            },
          },
        },
        scales: { y: { beginAtZero: true, ticks: { callback: (v) => fmt2(v) } } },
      },
    });
  } else {
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}

function openDrilldown(catKey, catData) {
  const modal = document.getElementById('summaryDrilldownModal');
  const title = document.getElementById('drilldownTitle');
  const content = document.getElementById('drilldownContent');
  if (!modal || !content) return;

  if (title) title.textContent = catData.label;

  const _convD = buildConvFn(_summaryCurrency, _currentRenderDate);
  const pfx = _convD && _summaryCurrency ? '≈' : '';
  const sfx =
    _convD && _summaryCurrency
      ? ` ${_summaryCurrency}`
      : _primaryDisplayCurrency
        ? ` ${_primaryDisplayCurrency}`
        : '';
  const currHdr =
    _convD && _summaryCurrency
      ? ` (≈${_summaryCurrency})`
      : _primaryDisplayCurrency
        ? ` (${_primaryDisplayCurrency})`
        : ' (as entered)';
  const fmt = (n) => (n ? `${pfx}${formatAmount(n)}${sfx}` : '—');

  let html = '';

  // Line items
  if (catData.items.length) {
    html += `<div class="mb-4">
      <p class="smy-subhead">Line items</p>
      <table class="smy-tbl">
        <thead><tr>
          <th>Item</th>
          <th class="is-num">Budget${currHdr}</th>
          <th class="is-num">Actual${currHdr}</th>
        </tr></thead>
        <tbody>${catData.items
          .map(
            (item) => `
          <tr>
            <td class="is-name">${esc(item.label)}</td>
            <td class="is-num">${fmt(item.budget)}</td>
            <td class="is-num ${item.actual > item.budget && item.budget ? 'is-over' : ''}">${fmt(item.actual)}</td>
          </tr>`,
          )
          .join('')}
        </tbody>
        <tfoot><tr>
          <td>Total</td>
          <td class="is-num">${fmt(catData.budget)}</td>
          <td class="is-num ${catData.actual > catData.budget && catData.budget ? 'is-over' : ''}">${fmt(catData.actual)}</td>
        </tr></tfoot>
      </table>
    </div>`;
  }

  // Receipts (shown in original currency — not converted, as they are reference records)
  if (catData.receipts.length) {
    html += `<div>
      <p class="smy-subhead">Receipts (as entered)</p>
      <table class="smy-tbl">
        <thead><tr>
          <th>Description</th>
          <th>Date</th>
          <th class="is-num">Amount</th>
        </tr></thead>
        <tbody>${catData.receipts
          .map(
            (r) => `
          <tr>
            <td class="is-name">${esc(r.label)}</td>
            <td class="is-date">${esc(r.date)}</td>
            <td class="is-num">${formatAmount(r.amount)} ${esc(r.currency)}</td>
          </tr>`,
          )
          .join('')}
        </tbody>
        <tfoot><tr>
          <td colspan="2">Total receipts</td>
          <td class="is-num">${formatAmount(catData.receipts.reduce((s, r) => s + r.amount, 0))}</td>
        </tr></tfoot>
      </table>
    </div>`;
  }

  if (!html) html = '<p class="smy-empty">No data recorded for this category.</p>';

  content.innerHTML = html;
  showModal('summaryDrilldownModal');
}

function openMemberDrilldown(memberData, planner) {
  const modal = document.getElementById('summaryDrilldownModal');
  const title = document.getElementById('drilldownTitle');
  const content = document.getElementById('drilldownContent');
  if (!modal || !content) return;

  if (title) title.textContent = memberData.name;

  const _convM = buildConvFn(_summaryCurrency, _currentRenderDate);
  const cvt = _convM ?? ((n) => n);
  const pfx = _convM && _summaryCurrency ? '≈' : '';
  const sfx =
    _convM && _summaryCurrency
      ? ` ${_summaryCurrency}`
      : _primaryDisplayCurrency
        ? ` ${_primaryDisplayCurrency}`
        : '';
  const currHdr =
    _convM && _summaryCurrency
      ? ` (≈${_summaryCurrency})`
      : _primaryDisplayCurrency
        ? ` (${_primaryDisplayCurrency})`
        : ' (as entered)';
  const fmt = (n) => (n ? `${pfx}${formatAmount(n)}${sfx}` : '—');

  const org = planner.org || {};

  // Accommodation stays for this member (apply conversion)
  const stays = [];
  (org.accommodations || []).forEach((acc) => {
    const stay = (acc.assignments || []).find((s) => s.memberId === memberData.memberId);
    if (stay) {
      const sCurr = stay.currency || 'AUD';
      stays.push({
        property: acc.name || 'Accommodation',
        budget: cvt(parseBudget(stay.budget), sCurr),
        actual: cvt(parseBudget(stay.budgetActual), sCurr),
      });
    }
  });

  const memberTicketRows = (org.tickets || [])
    .filter((t) => t.assignedTo === memberData.memberId || t.purchasedBy === memberData.memberId)
    .map((t) => {
      const tCurr = t.currency || 'AUD';
      const qty = parseBudget(t.quantity) || 1;
      const cost = cvt(parseBudget(t.unitPrice) * qty, tCurr);
      return { label: `Ticket: ${t.name || 'Ticket'}`, budget: 0, actual: cost };
    })
    .filter((r) => r.actual);

  const assignedItemRows = (org.budgetItems || [])
    .filter((item) => item.memberId === memberData.memberId)
    .map((item) => {
      const iCurr = item.currency || 'AUD';
      const b = cvt(parseBudget(item.budget), iCurr);
      const linked = (planner.receipts || []).filter((r) => r.budgetItemId === item.id);
      const ac = linked.length
        ? linked.reduce((s, r) => s + cvt(parseBudget(r.amount), r.currency || iCurr), 0)
        : cvt(parseBudget(item.actual), iCurr);
      return { label: item.name || 'Budget item', budget: b, actual: ac };
    })
    .filter((r) => r.budget || r.actual);

  const rows = [
    {
      label: 'Travel allocation',
      budget: memberData.memberBudget,
      actual: memberData.memberActual,
    },
    ...stays.map((s) => ({
      label: `Accommodation: ${s.property}`,
      budget: s.budget,
      actual: s.actual,
    })),
    ...memberTicketRows,
    ...assignedItemRows,
  ].filter((r) => r.budget || r.actual);

  let html = `<table class="smy-tbl">
    <thead><tr>
      <th>Category</th>
      <th class="is-num">Budget${currHdr}</th>
      <th class="is-num">Actual${currHdr}</th>
    </tr></thead>
    <tbody>${rows
      .map(
        (r) => `
      <tr>
        <td class="is-name">${esc(r.label)}</td>
        <td class="is-num">${fmt(r.budget)}</td>
        <td class="is-num ${r.actual > r.budget && r.budget ? 'is-over' : ''}">${fmt(r.actual)}</td>
      </tr>`,
      )
      .join('')}
    </tbody>
    <tfoot><tr>
      <td>Total</td>
      <td class="is-num">${fmt(memberData.budget)}</td>
      <td class="is-num ${memberData.actual > memberData.budget && memberData.budget ? 'is-over' : ''}">${fmt(memberData.actual)}</td>
    </tr></tfoot>
  </table>`;

  if (!rows.length) html = '<p class="smy-empty">No budget data for this member.</p>';

  content.innerHTML = html;
  showModal('summaryDrilldownModal');
}

function _updateGlobalFilterClearBtn() {
  const btn = document.getElementById('globalFilterClear');
  if (!btn) return;
  const active =
    _globalSummaryFilter.start || _globalSummaryFilter.end || _globalSummaryFilter.person;
  btn.classList.toggle('hidden', !active);
}

export function wireSummaryPanel() {
  // This/All toggle
  document.getElementById('summaryToggleThis')?.addEventListener('click', () => {
    document.getElementById('summaryThisEvent')?.classList.remove('hidden');
    document.getElementById('summaryAllEvents')?.classList.add('hidden');
    document.getElementById('summaryToggleThis')?.classList.add('is-active');
    document.getElementById('summaryToggleAll')?.classList.remove('is-active');
    renderSummaryThisEvent();
  });
  document.getElementById('summaryToggleAll')?.addEventListener('click', () => {
    document.getElementById('summaryAllEvents')?.classList.remove('hidden');
    document.getElementById('summaryThisEvent')?.classList.add('hidden');
    document.getElementById('summaryToggleAll')?.classList.add('is-active');
    document.getElementById('summaryToggleThis')?.classList.remove('is-active');
    if (!_globalSummaryFilter.person) {
      const mode = state.planner?.mode || 'personal';
      _globalSummaryFilter.person = mode === 'sponsor' ? 'sponsor' : 'me';
      const p = document.getElementById('globalPersonFilter');
      if (p) p.value = _globalSummaryFilter.person;
      _updateGlobalFilterClearBtn();
    }
    renderSummaryAllEvents();
  });

  // Date range filters
  document.getElementById('globalFilterStart')?.addEventListener('input', (e) => {
    _globalSummaryFilter.start = e.target.value;
    _updateGlobalFilterClearBtn();
    renderSummaryAllEvents();
  });
  document.getElementById('globalFilterEnd')?.addEventListener('input', (e) => {
    _globalSummaryFilter.end = e.target.value;
    _updateGlobalFilterClearBtn();
    renderSummaryAllEvents();
  });

  // Currency selector — destroy all charts and fully re-render both sub-tabs on change
  document.getElementById('summaryCurrencySelect')?.addEventListener('change', async (e) => {
    _summaryCurrency = e.target.value;
    // Persist the choice as the planner's preferred roll-up currency.
    if (state.planner) state.planner.displayCurrency = _summaryCurrency;
    scheduleAutoSave?.();
    destroyCharts('category', 'member', 'global');

    if (_summaryCurrency) {
      const notice = document.getElementById('summaryRateNotice');
      const text = document.getElementById('summaryRateNoticeText');
      if (notice && text) {
        notice.classList.remove('hidden');
        text.textContent = 'Fetching exchange rates…';
      }
      // Fetch rates for the current event's date first so This Event renders immediately;
      // All Events will fetch its own per-event historical rates when it renders.
      const eventDate = clampRateDate(state.eventMeta?.startDate?.slice(0, 10) || '');
      try {
        await fetchRates(_summaryCurrency, eventDate);
      } catch (err) {
        reportError('summary rate fetch', err);
        _showRateNotice(true);
      }
    } else {
      _showRateNotice(false);
    }

    renderSummaryThisEvent();
    renderSummaryAllEvents();
  });

  // View-as person filter
  document.getElementById('globalPersonFilter')?.addEventListener('change', (e) => {
    _globalSummaryFilter.person = e.target.value;
    _updateGlobalFilterClearBtn();
    renderSummaryAllEvents();
  });

  // Clear all active filters
  document.getElementById('globalFilterClear')?.addEventListener('click', () => {
    _globalSummaryFilter.start = '';
    _globalSummaryFilter.end = '';
    _globalSummaryFilter.person = '';
    const s = document.getElementById('globalFilterStart');
    const f = document.getElementById('globalFilterEnd');
    const p = document.getElementById('globalPersonFilter');
    if (s) s.value = '';
    if (f) f.value = '';
    if (p) p.value = '';
    _updateGlobalFilterClearBtn();
    renderSummaryAllEvents();
  });

  // Drilldown modal close
  const drillModal = document.getElementById('summaryDrilldownModal');
  document.getElementById('drilldownModalClose')?.addEventListener('click', closeDrilldown);
  drillModal?.addEventListener('click', (e) => {
    if (e.target === drillModal) closeDrilldown();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drillModal && !drillModal.classList.contains('hidden'))
      closeDrilldown();
  });
}

function closeDrilldown() {
  hideModal('summaryDrilldownModal');
}

// Static shell for this tab panel — injected into #plannerSummaryPanel at boot (#7 co-location).
export function summaryPanelHtml() {
  return `
          <section>
            <!-- Header + controls -->
            <div class="pln-section__head">
              <div>
                <p class="pln-eyebrow">How the trip adds up</p>
                <h2 class="pln-section__title">Summary</h2>
              </div>
              <div class="smy-controls">
                <label class="smy-cur">
                  Display in
                  <select id="summaryCurrencySelect">
                    <option value="">As entered</option>
                    <option value="AUD">AUD</option>
                    <option value="CAD">CAD</option>
                    <option value="CHF">CHF</option>
                    <option value="EUR">EUR</option>
                    <option value="GBP">GBP</option>
                    <option value="INR">INR</option>
                    <option value="JPY">JPY</option>
                    <option value="NZD">NZD</option>
                    <option value="SGD">SGD</option>
                    <option value="USD">USD</option>
                  </select>
                </label>
                <div class="smy-seg" role="group" aria-label="Summary scope">
                  <button id="summaryToggleThis" type="button" class="smy-seg-btn is-active">This event</button>
                  <button id="summaryToggleAll" type="button" class="smy-seg-btn">All events</button>
                </div>
              </div>
            </div>
            <!-- Rate notice — shown by JS when a target currency is active -->
            <div id="summaryRateNotice" class="hidden smy-notice" style="margin-bottom:1.1rem">
              <span id="summaryRateNoticeText"></span>
            </div>

            <!-- This Event -->
            <div id="summaryThisEvent" class="space-y-5">
              <div id="summaryStatsGrid" class="smy-stats"></div>
              <div id="summaryBudgetHealth"></div>
              <div id="summaryBudgetBreakdownWrap" class="hidden">
                <div class="doc-divider"><span>Line items</span></div>
                <div id="summaryBudgetBreakdown"></div>
              </div>
              <div class="flex gap-4 min-w-0 flex-col sm:flex-row">
                <div class="smy-chart-card flex-1 min-w-0">
                  <div class="doc-divider" style="margin-bottom:0.6rem"><span>By category</span>
                    <span class="smy-legend" style="margin-left:auto"><span class="smy-leg" style="--d:var(--brand-1-ink)">&lt;70%</span><span class="smy-leg" style="--d:var(--status-warn)">70–99%</span><span class="smy-leg" style="--d:var(--status-bad)">over</span></span>
                  </div>
                  <canvas id="budgetCategoryChart" height="120"></canvas>
                </div>
                <div id="summaryMemberChartSection" class="smy-chart-card flex-1 min-w-0">
                  <div class="doc-divider" style="margin-bottom:0.6rem"><span>By team member</span>
                    <span class="smy-legend" style="margin-left:auto"><span class="smy-leg" style="--d:var(--brand-1-ink)">&lt;70%</span><span class="smy-leg" style="--d:var(--status-warn)">70–99%</span><span class="smy-leg" style="--d:var(--status-bad)">over</span></span>
                  </div>
                  <canvas id="budgetMemberChart" height="120"></canvas>
                </div>
              </div>

              <!-- Personal-only visualisations: top expenses + spend-by-category donut -->
              <div id="summaryPersonalViz" class="hidden flex flex-col sm:flex-row gap-4 min-w-0">
                <div class="smy-chart-card flex-1 min-w-0">
                  <div class="doc-divider" style="margin-bottom:0.7rem"><span>Top expenses</span></div>
                  <div id="summaryTopExpenses" class="smy-exps"></div>
                </div>
                <div class="smy-chart-card flex-1 min-w-0">
                  <div class="doc-divider" style="margin-bottom:0.7rem"><span>Spend by category</span></div>
                  <div class="relative" style="max-width:260px;margin:0 auto"><canvas id="summarySpendDonut" height="200"></canvas></div>
                </div>
              </div>
            </div>

            <!-- All Events (hidden by default) -->
            <div id="summaryAllEvents" class="hidden space-y-5">
              <!-- Filters: date range + view-as person -->
              <div class="smy-filter">
                <span class="smy-filter-lbl">Filter</span>
                <label>From <input type="month" id="globalFilterStart"></label>
                <label>To <input type="month" id="globalFilterEnd"></label>
                <label>View as
                  <select id="globalPersonFilter">
                    <option value="">All planners</option>
                    <option value="me">Personal only</option>
                    <option value="sponsor">Sponsor only</option>
                  </select>
                </label>
                <button id="globalFilterClear" type="button" class="hidden set-btn">Clear</button>
              </div>

              <div id="globalSummaryStatsRow" class="smy-stats"></div>

              <!-- Per-event breakdown table -->
              <div>
                <div class="doc-divider"><span>Per-event breakdown</span></div>
                <div id="globalEventTable"></div>
              </div>

              <!-- Category totals across all events -->
              <div id="globalCategoryBreakdown" class="smy-panel"></div>

              <!-- Budget vs Actual Over Time chart -->
              <div class="smy-chart-card">
                <div class="doc-divider" style="margin-bottom:0.6rem"><span>Budget vs actual over time</span></div>
                <div id="globalChartEventFilter" style="display:none;flex-wrap:wrap;gap:0.375rem;margin-bottom:0.75rem"></div>
                <canvas id="globalBudgetChart"></canvas>
              </div>
            </div>
          </section>
        `;
}
