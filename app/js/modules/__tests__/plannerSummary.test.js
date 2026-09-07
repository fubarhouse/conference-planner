import { describe, it, expect, beforeEach } from 'vitest';
import {
  initSummary,
  buildEventBudgetData,
  buildPersonalBudgetData,
  budgetHealthCounts,
} from '../plannerSummary.js';

// A fixed category set, returned for both 'org' and 'personal' modes.
const CATS = [
  { id: 'travel', name: 'Travel' },
  { id: 'accommodation', name: 'Accommodation' },
  { id: 'tickets', name: 'Tickets' },
  { id: 'swag', name: 'Swag' },
  { id: 'team', name: 'Team' },
  { id: 'misc', name: 'Misc' },
];

let state;

beforeEach(() => {
  state = { global: { teamMembers: [] } };
  initSummary({
    state,
    fetchEventDates: () => {},
    getEventBudgetCategories: () => CATS,
    getVisibleTabs: () => [],
    isPlannerEntry: () => false,
    toWednesdayOfWeek: () => {},
    _eventDates: {},
  });
});

describe('buildPersonalBudgetData', () => {
  it('maps personal travel budget/actual onto the travel category', () => {
    const cats = buildPersonalBudgetData({ personal: { budget: '100', budgetActual: '80' } });
    expect(cats.travel.budget).toBe(100);
    expect(cats.travel.actual).toBe(80);
    expect(cats.travel.items).toContainEqual({
      label: 'My travel',
      budget: 100,
      actual: 80,
      curr: 'AUD',
      date: '',
    });
  });

  it('the "My travel" line uses the trip currency', () => {
    const cats = buildPersonalBudgetData({
      personal: { currency: 'EUR', budget: '100', budgetActual: '80' },
    });
    expect(cats.travel.items.find((i) => i.label === 'My travel').curr).toBe('EUR');
  });

  it('carries each record’s purchaseDate onto its cats item as `date` (for per-day FX)', () => {
    const cats = buildPersonalBudgetData({
      personal: {
        currency: 'AUD',
        tickets: [{ name: 'Pass', unitPrice: '50', quantity: '1', purchaseDate: '2025-04-01' }],
        accommodations: [
          { name: 'Hotel', budget: '200', currency: 'EUR', purchaseDate: '2025-03-15' },
        ],
        itinerary: [
          {
            title: 'Excursion',
            budget: '40',
            actual: '40',
            currency: 'EUR',
            purchaseDate: '2025-06-10',
          },
        ],
        budgetItems: [
          {
            id: 'bi1',
            name: 'Dinner',
            category: 'misc',
            budget: '30',
            actual: '30',
            currency: 'EUR',
            purchaseDate: '2025-05-20',
          },
        ],
      },
    });
    expect(cats.tickets.items.find((i) => i.label === 'Pass').date).toBe('2025-04-01');
    expect(cats.accommodation.items.find((i) => i.label === 'Hotel').date).toBe('2025-03-15');
    expect(cats.misc.items.find((i) => i.label === 'Excursion').date).toBe('2025-06-10');
    expect(cats.misc.items.find((i) => i.label === 'Dinner').date).toBe('2025-05-20');
  });

  it('costs tickets as unitPrice × quantity', () => {
    const cats = buildPersonalBudgetData({
      personal: { tickets: [{ name: 'Pass', unitPrice: '50', quantity: '2' }] },
    });
    expect(cats.tickets.actual).toBe(100);
  });

  it('prefers linked receipts over the entered actual for a budget item', () => {
    const cats = buildPersonalBudgetData({
      personal: { budgetItems: [{ id: 'bi1', category: 'misc', budget: '200', actual: '999' }] },
      receipts: [
        { budgetItemId: 'bi1', amount: '30' },
        { budgetItemId: 'bi1', amount: '20' },
      ],
    });
    expect(cats.misc.actual).toBe(50); // 30 + 20, not the 999 entered actual
    expect(cats.misc.budget).toBe(200);
  });

  it('ignores a line item’s stale manual actual when it has no receipt (budget-only)', () => {
    // Mirrors the "Flights" line item: budget + a leftover actual, but no linked receipt.
    const cats = buildPersonalBudgetData({
      personal: {
        currency: 'AUD',
        budgetItems: [
          { id: 'bi1', name: 'Flights', category: 'travel', budget: '2800', actual: '2800' },
        ],
      },
    });
    expect(cats.travel.budget).toBe(2800); // planned budget still shows
    expect(cats.travel.actual).toBe(0); // no receipt → unspent, NOT the stale 2800
  });

  it('takes an itinerary item’s actual from its linked receipt, counted once (no double)', () => {
    const cats = buildPersonalBudgetData({
      personal: {
        currency: 'AUD',
        itinerary: [{ id: 'it1', title: 'Museum', budget: '100', actual: '999', receiptId: 'rc1' }],
      },
      // The linked receipt carries the real actual; its own currency/date apply.
      receipts: [{ id: 'rc1', category: 'misc', amount: '75', currency: 'AUD' }],
    });
    // budget stays from the item; actual comes from the receipt (75), NOT 999+75.
    expect(cats.misc.budget).toBe(100);
    expect(cats.misc.actual).toBe(75);
    // The receipt is not ALSO listed as an unlinked receipt.
    expect(cats.misc.receipts).toHaveLength(0);
  });

  it('categorises an itinerary item by its linked receipt’s category (not always Misc)', () => {
    const cats = buildPersonalBudgetData({
      personal: {
        currency: 'AUD',
        itinerary: [{ id: 'it1', title: 'Workshop', budget: '100', receiptId: 'rc1' }],
      },
      // Receipt re-categorised to Tickets → the whole item moves to Tickets.
      receipts: [{ id: 'rc1', category: 'tickets', amount: '75', currency: 'AUD' }],
    });
    expect(cats.tickets.budget).toBe(100);
    expect(cats.tickets.actual).toBe(75);
    expect(cats.misc.budget).toBe(0);
    expect(cats.misc.actual).toBe(0);
  });

  it('still counts an itinerary item’s own actual when it has no linked receipt', () => {
    const cats = buildPersonalBudgetData({
      personal: { currency: 'AUD', itinerary: [{ id: 'it1', title: 'Tour', actual: '60' }] },
    });
    expect(cats.misc.actual).toBe(60);
  });

  it('counts unlinked receipts toward their category actual and lists them for drilldown', () => {
    const cats = buildPersonalBudgetData({
      receipts: [{ category: 'travel', amount: '40', name: 'Taxi', currency: 'AUD' }],
    });
    expect(cats.travel.actual).toBe(40); // unlinked receipt is a real cost → counts
    expect(cats.travel.receipts).toContainEqual({
      label: 'Taxi',
      amount: 40,
      currency: 'AUD',
      date: '',
    });
  });

  it('does not double-count linked receipts (they count via their budget item)', () => {
    const cats = buildPersonalBudgetData({
      personal: {
        budgetItems: [{ id: 'bi1', category: 'accommodation', budget: '0', actual: '999' }],
      },
      receipts: [
        { budgetItemId: 'bi1', category: 'accommodation', amount: '600', currency: 'AUD' },
      ],
    });
    // 600 from the linked receipt (via the budget item), NOT 600 + 600.
    expect(cats.accommodation.actual).toBe(600);
    expect(cats.accommodation.receipts).toHaveLength(0);
  });

  it('counts an accommodation receipt toward the accommodation category', () => {
    const cats = buildPersonalBudgetData({
      personal: { accommodations: [{ id: 'a1', name: 'Nara Hotel' }] },
      receipts: [{ category: 'accommodation', amount: '640', name: 'Hotel', currency: 'AUD' }],
    });
    expect(cats.accommodation.actual).toBe(640);
  });

  it("counts the traveller's own stay cost when the accommodation-level cost is blank", () => {
    const cats = buildPersonalBudgetData({
      personal: {
        accommodations: [
          {
            id: 'a1',
            name: 'Nara Hotel',
            budget: '',
            budgetActual: '',
            assignments: [
              { memberId: '__me__', budget: '600', budgetActual: '640', currency: 'AUD' },
              { memberId: 'c1', budget: '500', budgetActual: '500', currency: 'AUD' }, // companion — not mine
            ],
          },
        ],
      },
    });
    expect(cats.accommodation.budget).toBe(600);
    expect(cats.accommodation.actual).toBe(640); // only my stay, not the companion's
  });

  it('does not double-count when both the stay and the accommodation-level cost are set', () => {
    const cats = buildPersonalBudgetData({
      personal: {
        accommodations: [
          {
            id: 'a1',
            name: 'Nara Hotel',
            budget: '600',
            budgetActual: '640',
            assignments: [
              { memberId: '__me__', budget: '600', budgetActual: '640', currency: 'AUD' },
            ],
          },
        ],
      },
    });
    // Stay preferred over accommodation-level; counted once, not 1280.
    expect(cats.accommodation.actual).toBe(640);
  });

  it('falls back to the accommodation-level cost when there is no personal stay', () => {
    const cats = buildPersonalBudgetData({
      personal: {
        accommodations: [{ id: 'a1', name: 'Nara Hotel', budget: '600', budgetActual: '640' }],
      },
    });
    expect(cats.accommodation.actual).toBe(640);
  });

  it('applies a personal category budget target (set on the Budget tab)', () => {
    const cats = buildPersonalBudgetData({
      personal: { currency: 'AUD', categoryBudgets: { travel: '2000' } },
    });
    expect(cats.travel.budget).toBe(2000);
  });

  it('a category budget target overrides the summed line-item budgets', () => {
    const cats = buildPersonalBudgetData({
      personal: {
        currency: 'AUD',
        categoryBudgets: { travel: '3000' },
        budgetItems: [{ id: 'bi1', category: 'travel', budget: '2800' }],
      },
    });
    expect(cats.travel.budget).toBe(3000); // target wins over the 2800 item budget
  });

  it('an empty category budget leaves the line-item budgets intact', () => {
    const cats = buildPersonalBudgetData({
      personal: {
        currency: 'AUD',
        categoryBudgets: { travel: '' },
        budgetItems: [{ id: 'bi1', category: 'travel', budget: '2800' }],
      },
    });
    expect(cats.travel.budget).toBe(2800);
  });

  it('ignores a category budget keyed to a removed category (no Misc bleed)', () => {
    // 'education' is not in CATS (e.g. the user removed that category). Its orphaned
    // budget must not fall through into Misc.
    const cats = buildPersonalBudgetData({
      personal: { currency: 'AUD', categoryBudgets: { education: '4500' } },
    });
    expect(cats.education).toBeUndefined();
    expect(cats.misc.budget).toBe(0);
  });

  it('applies the currency conversion function to every amount', () => {
    const double = (n) => n * 2;
    const cats = buildPersonalBudgetData(
      { personal: { budget: '100', budgetActual: '80' } },
      double,
    );
    expect(cats.travel.budget).toBe(200);
    expect(cats.travel.actual).toBe(160);
  });

  it('sources a linked ticket’s actual from its receipt (not unitPrice×qty), counted once', () => {
    const cats = buildPersonalBudgetData({
      personal: {
        currency: 'AUD',
        tickets: [{ id: 'tk1', name: 'Pass', unitPrice: '50', quantity: '2', receiptId: 'rc1' }],
      },
      receipts: [{ id: 'rc1', category: 'tickets', amount: '90', currency: 'AUD' }],
    });
    expect(cats.tickets.actual).toBe(90); // the receipt (90), NOT unitPrice×qty (100), and not 190
    expect(cats.tickets.receipts).toHaveLength(0); // receipt not double-counted as unlinked
  });

  it('sources a linked accommodation stay’s actual from its receipt', () => {
    const cats = buildPersonalBudgetData({
      personal: {
        accommodations: [
          {
            id: 'a1',
            name: 'Hotel',
            assignments: [{ memberId: '__me__', receiptId: 'rc1' }],
          },
        ],
      },
      receipts: [{ id: 'rc1', category: 'accommodation', amount: '640', currency: 'AUD' }],
    });
    expect(cats.accommodation.actual).toBe(640);
    expect(cats.accommodation.receipts).toHaveLength(0);
  });
});

describe('budgetHealthCounts (loose vs strict budgets)', () => {
  // travel: budgeted + over; tickets: budgeted + on track; misc: spend, NO budget set.
  const cats = {
    travel: { label: 'Travel', budget: 500, actual: 600 },
    tickets: { label: 'Tickets', budget: 400, actual: 100 },
    misc: { label: 'Misc', budget: 0, actual: 240 },
  };

  it('loose mode: a 0-budget category is unconfigured — not overspend', () => {
    const r = budgetHealthCounts(cats, false);
    expect(r.totalBudget).toBe(900); // 500 + 400 (misc's 0 excluded)
    expect(r.budgetedActual).toBe(700); // 600 + 100
    expect(r.unbudgetedActual).toBe(240); // misc, informational
    expect(r.spentForVerdict).toBe(700); // verdict ignores unbudgeted spend
    expect(r.nOver).toBe(1); // only travel
    expect(r.nUnbudgeted).toBe(1); // misc
    expect(r.nOk).toBe(1); // tickets
    // 700 spent of 900 budgeted → not over overall.
    expect(r.overBudget).toBe(false);
  });

  it('strict mode: a 0-budget category with spend counts as over', () => {
    const r = budgetHealthCounts(cats, true);
    expect(r.spentForVerdict).toBe(940); // 700 budgeted + 240 unbudgeted
    expect(r.nOver).toBe(2); // travel + misc
    expect(r.nUnbudgeted).toBe(0);
    expect(r.overBudget).toBe(true); // 940 > 900
  });

  it('treats a negative budget (credit/allowance) as configured, not unconfigured', () => {
    const r = budgetHealthCounts({ edu: { label: 'Edu', budget: -700, actual: -700 } }, false);
    expect(r.totalBudget).toBe(-700);
    expect(r.unbudgetedActual).toBe(0); // negative budget is NOT unbudgeted
    expect(r.nUnbudgeted).toBe(0);
  });
});

describe('buildEventBudgetData', () => {
  it('sums team-assignment actuals into travel and applies category budgets', () => {
    state.global.teamMembers = [{ id: 'm1', name: 'Alice' }];
    const cats = buildEventBudgetData({
      org: {
        teamAssignments: [{ memberId: 'm1', budget: '500', budgetActual: '450', currency: 'AUD' }],
        categoryBudgets: { travel: '1000' },
      },
    });
    expect(cats.travel.actual).toBe(450);
    expect(cats.travel.budget).toBe(1000);
    expect(cats.travel.items).toContainEqual({
      label: 'Alice',
      budget: 500,
      actual: 450,
      date: '',
    });
  });

  it('sources a linked team-assignment / swag actual from the receipt, counted once', () => {
    state.global.teamMembers = [{ id: 'm1', name: 'Alice' }];
    const cats = buildEventBudgetData({
      org: {
        teamAssignments: [
          { memberId: 'm1', budgetActual: '999', currency: 'AUD', receiptId: 'rc1' },
        ],
        swag: [{ name: 'Shirts', actual: '999', currency: 'AUD', receiptId: 'rc2' }],
      },
      receipts: [
        { id: 'rc1', category: 'travel', amount: '450', currency: 'AUD' },
        { id: 'rc2', category: 'swag', amount: '120', currency: 'AUD' },
      ],
    });
    expect(cats.travel.actual).toBe(450); // receipt, not 999
    expect(cats.swag.actual).toBe(120); // receipt, not 999
    // Neither receipt double-counted as unlinked.
    expect(cats.travel.receipts).toHaveLength(0);
    expect(cats.swag.receipts).toHaveLength(0);
  });

  it('restricts to one member and skips org-wide category budgets when filtered', () => {
    state.global.teamMembers = [
      { id: 'm1', name: 'Alice' },
      { id: 'm2', name: 'Bob' },
    ];
    const cats = buildEventBudgetData(
      {
        org: {
          teamAssignments: [
            { memberId: 'm1', budgetActual: '450' },
            { memberId: 'm2', budgetActual: '300' },
          ],
          categoryBudgets: { travel: '1000' },
        },
      },
      'm1',
    );
    expect(cats.travel.actual).toBe(450); // Bob's 300 excluded
    expect(cats.travel.budget).toBe(0); // category budgets are org-wide only
  });

  it('costs org tickets as unitPrice × quantity', () => {
    const cats = buildEventBudgetData({
      org: { tickets: [{ name: 'Conf pass', unitPrice: '20', quantity: '3' }] },
    });
    expect(cats.tickets.actual).toBe(60);
  });
});
