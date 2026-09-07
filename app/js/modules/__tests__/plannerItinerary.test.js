import { describe, it, expect, beforeEach } from 'vitest';
import {
  initItinerary,
  fmtAmt,
  makeItineraryItem,
  personalAssignablePeople,
  personalAssigneeChips,
} from '../plannerItinerary.js';

let state;

beforeEach(() => {
  state = { planner: { mode: 'personal', personal: {}, org: {} }, global: {} };
  initItinerary({
    state,
    scheduleAutoSave: () => {},
    localDateStr: () => '',
    renderSummaryTab: () => {},
    getTimezone: () => 'UTC',
    openPersonalItineraryItemModal: () => {},
    renderPersonalItinerary: () => {},
    renderPersonalItineraryTab: () => {},
  });
});

describe('fmtAmt', () => {
  it('formats an amount with its currency and two decimals', () => {
    expect(fmtAmt(1234.5, 'USD')).toBe('USD 1,234.50');
  });

  it('defaults to AUD and treats blank as zero', () => {
    expect(fmtAmt('', undefined)).toBe('AUD 0.00');
  });

  it('escapes the currency label', () => {
    expect(fmtAmt(10, '<x>')).toBe('&lt;x&gt; 10.00');
  });
});

describe('makeItineraryItem', () => {
  it('creates a blank item with an id and the personal currency', () => {
    state.planner.personal.currency = 'EUR';
    const item = makeItineraryItem('m1', '2026-01-02');
    expect(typeof item.id).toBe('string');
    expect(item.id.length).toBeGreaterThan(0);
    expect(item).toMatchObject({
      memberId: 'm1',
      memberIds: [],
      date: '2026-01-02',
      title: '',
      currency: 'EUR',
      done: false,
    });
  });

  it('uses the sponsor currency in sponsor mode', () => {
    state.planner.mode = 'sponsor';
    state.planner.org.sponsorCurrency = 'GBP';
    expect(makeItineraryItem('m1', '2026-01-02').currency).toBe('GBP');
  });

  it('falls back to AUD when no currency is set', () => {
    expect(makeItineraryItem(null, '2026-01-02').currency).toBe('AUD');
  });
});

describe('personalAssignablePeople', () => {
  beforeEach(() => {
    state.global.personalContacts = [
      { id: 'c1', name: 'Alice' },
      { id: 'c2', name: 'Bob' },
    ];
    state.planner.personal = {
      meContactId: 'c1',
      tripAssignments: [{ memberId: 'c2' }, { memberId: 'c1' }],
      localCompanions: [{ id: 'l1', name: 'Local Larry' }],
    };
  });

  it('lists Me first, then trip contacts and local companions, deduped', () => {
    const people = personalAssignablePeople();
    expect(people.map((p) => p.id)).toEqual(['c1', 'c2', 'l1']);
    expect(people[0].name).toBe('Alice (me)');
    expect(people[1].name).toBe('Bob');
    expect(people[2].name).toBe('Local Larry');
  });

  it('labels Me generically when the me-contact is unresolved', () => {
    state.planner.personal.meContactId = '__me__';
    expect(personalAssignablePeople()[0]).toEqual({ id: '__me__', name: 'Me' });
  });
});

describe('personalAssigneeChips', () => {
  beforeEach(() => {
    state.global.personalContacts = [{ id: 'c2', name: 'Bob' }];
    state.planner.personal = {
      meContactId: '__me__',
      tripAssignments: [{ memberId: 'c2' }], // c2 must be assigned to be resolvable
      localCompanions: [{ id: 'l1', name: 'local larry' }],
    };
  });

  it('returns initial + name chips and drops unknown ids', () => {
    const chips = personalAssigneeChips(['c2', 'zzz', 'l1']);
    expect(chips).toEqual([
      { id: 'c2', name: 'Bob', initial: 'B' },
      { id: 'l1', name: 'local larry', initial: 'L' },
    ]);
  });

  it('returns an empty array for empty or non-array input', () => {
    expect(personalAssigneeChips([])).toEqual([]);
    expect(personalAssigneeChips(null)).toEqual([]);
  });
});
