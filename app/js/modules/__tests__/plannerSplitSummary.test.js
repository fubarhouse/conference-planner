import { describe, it, expect, vi } from 'vitest';

vi.stubGlobal('localStorage', {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  length: 0,
  key: () => null,
});
globalThis.document ??= { getElementById: () => null, querySelector: () => null };

const { mySplitShares } = await import('../plannerSummary.js');

describe('mySplitShares — Shared costs feeding the Summary', () => {
  it('returns my equal share, categorised, for expenses I share in', () => {
    const planner = {
      personal: {
        splitExpenses: [
          // one of 3 sharers on 60 → 20, category travel
          {
            id: 'a',
            description: 'Taxi',
            amount: 60,
            currency: 'AUD',
            category: 'travel',
            sharedWith: ['me', 'x', 'y'],
          },
          // I'm not a sharer → excluded
          {
            id: 'b',
            description: 'Solo',
            amount: 30,
            currency: 'AUD',
            category: '',
            sharedWith: ['x', 'y'],
          },
          // no category → empty string (falls back to Misc in the summary)
          {
            id: 'c',
            description: 'Snacks',
            amount: 10,
            currency: 'USD',
            category: '',
            sharedWith: ['me', 'x'],
          }, // → 5
        ],
      },
    };
    expect(mySplitShares(planner)).toEqual([
      { category: 'travel', label: 'Taxi', actual: 20 },
      { category: '', label: 'Snacks', actual: 5 },
    ]);
  });

  it('applies the currency conversion function', () => {
    const planner = {
      personal: {
        splitExpenses: [
          { id: 'a', amount: 100, currency: 'USD', category: '', sharedWith: ['me', 'x'] },
        ],
      },
    };
    const conv = (n, cur) => (cur === 'USD' ? n * 1.5 : n); // 50 → 75
    expect(mySplitShares(planner, conv)).toEqual([
      { category: '', label: 'Shared expense', actual: 75 },
    ]);
  });

  it('is empty when there are no shared expenses', () => {
    expect(mySplitShares({ personal: {} })).toEqual([]);
  });
});
