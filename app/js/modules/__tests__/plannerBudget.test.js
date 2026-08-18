import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  initBudget,
  budgetIndicatorHtml,
  budgetCategoryRowsHtml,
  getEventBudgetCategories,
  budgetCatList,
  addBudgetCategory,
  removeBudgetCategory,
} from '../plannerBudget.js';

// The category helpers read the injected shared state and call scheduleAutoSave;
// their DOM re-render calls are no-ops here (getElementById returns null under
// the node test env and every render guards `if (!container) return`).
let state;
let saveSpy;

// No jsdom in this suite: the category renderers call document.getElementById and
// bail on a null result, so a stub that always returns null exercises the same
// guard path without a real DOM.
beforeEach(() => {
  globalThis.document ??= { getElementById: () => null, querySelector: () => null };
  state = { planner: { personal: {}, org: {} }, global: {} };
  saveSpy = vi.fn();
  initBudget({
    state,
    scheduleAutoSave: saveSpy,
    createModal: () => ({ open() {}, wire() {} }),
    renderSummaryTab: () => {},
    renderSponsorBudgetBreakdown: () => {},
    renderPersonalBudgetBreakdown: () => {},
    buildEventBudgetData: () => ({}),
    buildPersonalBudgetData: () => ({}),
    renderReceiptsTab: () => {},
    renderPersonalTab: () => {},
  });
});

describe('budgetIndicatorHtml', () => {
  it('shows an under-budget meter with the remaining figure', () => {
    const html = budgetIndicatorHtml(30, 100);
    expect(html).toContain('bdg-meter'); // the meter fill
    expect(html).not.toContain('bdg-meter--over'); // not overspent
    expect(html).toContain('width:30%'); // 30/100 filled
    expect(html).toContain('70.00 left'); // 100 - 30 remaining
    expect(html).not.toContain('is-over');
  });

  it('shows an over-budget meter with the overage figure', () => {
    const html = budgetIndicatorHtml(120, 100);
    expect(html).toContain('bdg-meter--over'); // red meter
    expect(html).toContain('bdg-actual is-over'); // actual in the over state
    expect(html).toContain('20.00 over'); // 120 - 100 over
    expect(html).toContain('width:100%'); // capped at full
  });

  it('marks the category as untargeted when no budget is set', () => {
    const html = budgetIndicatorHtml(50, 0);
    expect(html).toContain('50.00');
    expect(html).toContain('bdg-meter--empty');
    expect(html).toContain('no target');
    expect(html).not.toContain('left');
  });
});

describe('budgetCategoryRowsHtml', () => {
  const cats = [
    { id: 'travel', name: 'Travel' },
    { id: 'food', name: 'Food & Drink' },
  ];

  it('renders one input row per category with a spend meter', () => {
    const html = budgetCategoryRowsHtml({
      cats,
      currency: 'AUD',
      catBudgets: { travel: '500' },
      catActuals: { travel: { actual: 200 } },
      inputClass: 'personal-budget-cat-input',
    });
    expect((html.match(/personal-budget-cat-input/g) || []).length).toBe(2);
    expect((html.match(/bdg-meter/g) || []).length).toBeGreaterThanOrEqual(2); // one meter per row
    expect(html).toContain('value="500"');
    expect(html).toContain('AUD');
  });

  it('escapes category names', () => {
    const html = budgetCategoryRowsHtml({
      cats: [{ id: 'x', name: '<script>' }],
      currency: 'AUD',
      catBudgets: {},
      catActuals: {},
      inputClass: 'budget-cat-input',
    });
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('adds the live-update hook only when indicator is requested', () => {
    const withHook = budgetCategoryRowsHtml({
      cats,
      currency: 'AUD',
      catBudgets: {},
      catActuals: {},
      inputClass: 'budget-cat-input',
      indicator: true,
    });
    const without = budgetCategoryRowsHtml({
      cats,
      currency: 'AUD',
      catBudgets: {},
      catActuals: {},
      inputClass: 'personal-budget-cat-input',
    });
    expect(withHook).toContain('data-cat-indicator="travel"');
    expect(without).not.toContain('data-cat-indicator');
  });
});

describe('budget category management', () => {
  it('returns the defaults until custom categories are stored', () => {
    expect(getEventBudgetCategories('personal').some((c) => c.id === 'travel')).toBe(true);
    expect(budgetCatList('personal')[0]).toHaveProperty('value');
    expect(budgetCatList('personal')[0]).toHaveProperty('label');
  });

  it('seeds from defaults, appends, and persists when adding a category', () => {
    addBudgetCategory('personal', 'Venue');
    const cats = state.planner.personal.budgetCategories;
    expect(cats.some((c) => c.id === 'travel')).toBe(true); // defaults copied in
    expect(cats.some((c) => c.id === 'venue' && c.name === 'Venue')).toBe(true);
    expect(saveSpy).toHaveBeenCalled();
  });

  it('ignores blank names and duplicate ids', () => {
    addBudgetCategory('personal', '   ');
    expect(state.planner.personal.budgetCategories).toBeUndefined();
    addBudgetCategory('personal', 'Venue');
    const count = state.planner.personal.budgetCategories.length;
    addBudgetCategory('personal', 'Venue');
    expect(state.planner.personal.budgetCategories.length).toBe(count);
  });

  it('removes a category and persists', () => {
    removeBudgetCategory('personal', 'travel');
    expect(state.planner.personal.budgetCategories.some((c) => c.id === 'travel')).toBe(false);
    expect(saveSpy).toHaveBeenCalled();
  });
});
