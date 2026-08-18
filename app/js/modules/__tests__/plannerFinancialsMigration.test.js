import { describe, it, expect, beforeEach } from 'vitest';
import { migrateFinancialsToReceipts, migratePersonalTravelToLineItem } from '../plannerStorage.js';
import { initSummary, buildEventBudgetData, buildPersonalBudgetData } from '../plannerSummary.js';

// A fixed category set, returned for both 'org' and 'personal' modes.
const CATS = [
  { id: 'travel', name: 'Travel' },
  { id: 'accommodation', name: 'Accommodation' },
  { id: 'tickets', name: 'Tickets' },
  { id: 'swag', name: 'Swag' },
  { id: 'team', name: 'Team' },
  { id: 'misc', name: 'Misc' },
];

beforeEach(() => {
  initSummary({
    state: { global: { teamMembers: [{ id: 'm1', name: 'Alice' }] } },
    fetchEventDates: () => {},
    getEventBudgetCategories: () => CATS,
    getVisibleTabs: () => [],
    isPlannerEntry: () => false,
    toWednesdayOfWeek: () => {},
    _eventDates: {},
  });
});

// Sum every category's actual — the number the migration must preserve.
const totalActual = (cats) => Object.values(cats).reduce((sum, c) => sum + (c.actual || 0), 0);

describe('migrateFinancialsToReceipts', () => {
  it('preserves the personal summary’s actual totals across migration', () => {
    const before = () => ({
      mode: 'personal',
      personal: {
        currency: 'AUD',
        tickets: [{ id: 't1', name: 'Pass', unitPrice: '50', quantity: '2' }],
        accommodations: [
          {
            id: 'a1',
            name: 'Hotel',
            budgetActual: '640',
            assignments: [{ memberId: '__me__', budgetActual: '300' }],
          },
        ],
        itinerary: [{ id: 'i1', title: 'Tour', budget: '40', actual: '40' }],
      },
    });

    const pre = buildPersonalBudgetData(before());
    const migrated = migrateFinancialsToReceipts(before());
    const post = buildPersonalBudgetData(migrated);

    expect(totalActual(post)).toBeCloseTo(totalActual(pre), 2);
  });

  it('preserves the org summary’s actual totals across migration', () => {
    const before = () => ({
      mode: 'sponsor',
      org: {
        sponsorCurrency: 'AUD',
        teamAssignments: [{ memberId: 'm1', budgetActual: '450' }],
        swag: [{ name: 'Shirts', actual: '120' }],
        itinerary: [{ id: 'oi1', title: 'Dinner', actual: '80' }],
        tickets: [{ id: 'ot1', name: 'Booth pass', unitPrice: '20', quantity: '3' }],
      },
    });

    const pre = buildEventBudgetData(before());
    const migrated = migrateFinancialsToReceipts(before());
    const post = buildEventBudgetData(migrated);

    expect(totalActual(post)).toBeCloseTo(totalActual(pre), 2);
  });

  it('creates one linked receipt per costed entity and clears its cost fields', () => {
    const planner = migrateFinancialsToReceipts({
      mode: 'personal',
      personal: {
        currency: 'AUD',
        tickets: [{ id: 't1', name: 'Pass', unitPrice: '50', quantity: '2' }],
        itinerary: [{ id: 'i1', title: 'Tour', budget: '40', actual: '40' }],
      },
    });
    // Two receipts (one ticket, one itinerary item), each linked.
    expect(planner.receipts).toHaveLength(2);
    const ticket = planner.personal.tickets[0];
    const itin = planner.personal.itinerary[0];
    expect(ticket.receiptId).toBeTruthy();
    expect(itin.receiptId).toBeTruthy();
    // Cost fields cleared off the entity; the receipt carries the amount.
    expect(ticket.unitPrice).toBeUndefined();
    expect(itin.actual).toBeUndefined();
    expect(ticket.quantity).toBe('2'); // descriptive field kept
    const ticketReceipt = planner.receipts.find((r) => r.id === ticket.receiptId);
    expect(ticketReceipt.amount).toBe('100'); // 50 × 2
    expect(ticketReceipt.category).toBe('tickets');
    // Originals stashed for recovery.
    expect(planner._preMigrationFinancials).toHaveLength(2);
  });

  it('skips entities already linked or with no cost (idempotent-safe on re-run)', () => {
    const planner = {
      mode: 'personal',
      personal: {
        tickets: [
          { id: 't1', name: 'Free', unitPrice: '0', quantity: '1' }, // no cost
          { id: 't2', name: 'Linked', unitPrice: '50', quantity: '1', receiptId: 'rc-existing' },
        ],
      },
      receipts: [{ id: 'rc-existing', amount: '50', category: 'tickets' }],
    };
    migrateFinancialsToReceipts(planner);
    // No new receipts created; the pre-linked one still has its unitPrice untouched.
    expect(planner.receipts).toHaveLength(1);
    expect(planner.personal.tickets[1].unitPrice).toBe('50');
  });
});

describe('migratePersonalTravelToLineItem (v6)', () => {
  it('turns the My-travel lump into a Travel line item + linked receipt, preserving totals', () => {
    const before = () => ({
      mode: 'personal',
      personal: {
        currency: 'AUD',
        budget: '1000',
        budgetActual: '850',
        purchaseDate: '2025-05-01',
      },
    });
    const pre = buildPersonalBudgetData(before());
    const migrated = migratePersonalTravelToLineItem(before());
    const post = buildPersonalBudgetData(migrated);

    // Travel category budget + actual are unchanged after the lump becomes a line item.
    expect(post.travel.budget).toBeCloseTo(pre.travel.budget, 2);
    expect(post.travel.actual).toBeCloseTo(pre.travel.actual, 2);

    // The lump is gone; a Travel budget item + a linked receipt now carry the values.
    expect(migrated.personal.budget).toBeUndefined();
    expect(migrated.personal.budgetActual).toBeUndefined();
    const item = migrated.personal.budgetItems.find((i) => i.name === 'Travel');
    expect(item).toBeTruthy();
    expect(item.budget).toBe('1000');
    const receipt = migrated.receipts.find((r) => r.budgetItemId === item.id);
    expect(receipt.amount).toBe('850');
    expect(receipt.category).toBe('travel');
    expect(migrated._preMigrationFinancials.some((s) => s.kind === 'my-travel-lump')).toBe(true);
  });

  it('creates only a line item (no receipt) when there is a budget but no actual', () => {
    const migrated = migratePersonalTravelToLineItem({
      mode: 'personal',
      personal: { currency: 'EUR', budget: '500' },
    });
    expect(migrated.personal.budgetItems).toHaveLength(1);
    expect(migrated.receipts ?? []).toHaveLength(0);
  });

  it('just drops empty lump fields when there is nothing to migrate', () => {
    const migrated = migratePersonalTravelToLineItem({
      mode: 'personal',
      personal: { currency: 'AUD', budget: '', budgetActual: '' },
    });
    expect(migrated.personal.budgetItems ?? []).toHaveLength(0);
    expect(migrated.personal.budget).toBeUndefined();
  });
});
