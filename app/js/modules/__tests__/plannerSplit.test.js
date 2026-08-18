import { describe, it, expect } from 'vitest';
import {
  splitEqually,
  computeBalances,
  minimizeTransactions,
  settleUp,
  parseAmount,
  roundMoney,
} from '../plannerSplit.js';

describe('splitEqually', () => {
  it('splits evenly when divisible', () => {
    expect(splitEqually(30, 3)).toEqual([10, 10, 10]);
  });
  it('distributes leftover cents to the front and sums exactly', () => {
    const shares = splitEqually(10, 3); // 3.34 + 3.33 + 3.33
    expect(shares).toEqual([3.34, 3.33, 3.33]);
    expect(roundMoney(shares.reduce((a, b) => a + b, 0))).toBe(10);
  });
  it('handles zero people', () => {
    expect(splitEqually(10, 0)).toEqual([]);
  });
});

describe('parseAmount', () => {
  it('accepts positive numbers, rejects junk/negatives', () => {
    expect(parseAmount('12.50')).toBe(12.5);
    expect(parseAmount('-5')).toBe(0);
    expect(parseAmount('abc')).toBe(0);
    expect(parseAmount('')).toBe(0);
  });
});

describe('computeBalances', () => {
  it('credits the payer and debits each sharer their portion', () => {
    const bal = computeBalances(
      [{ amount: 30, paidBy: 'a', sharedWith: ['a', 'b', 'c'] }],
      ['a', 'b', 'c'],
    );
    expect(bal).toEqual({ a: 20, b: -10, c: -10 });
  });
  it('ignores expenses with no payer, no sharers, or non-positive amounts', () => {
    const bal = computeBalances(
      [
        { amount: 0, paidBy: 'a', sharedWith: ['a', 'b'] },
        { amount: 10, paidBy: '', sharedWith: ['a', 'b'] },
        { amount: 10, paidBy: 'a', sharedWith: [] },
      ],
      ['a', 'b'],
    );
    expect(bal).toEqual({ a: 0, b: 0 });
  });
  it('nets multiple expenses across payers', () => {
    const bal = computeBalances(
      [
        { amount: 30, paidBy: 'a', sharedWith: ['a', 'b', 'c'] }, // a +20, b -10, c -10
        { amount: 15, paidBy: 'b', sharedWith: ['a', 'b', 'c'] }, // b +10, a -5, c -5
      ],
      ['a', 'b', 'c'],
    );
    expect(bal).toEqual({ a: 15, b: 0, c: -15 });
  });
});

describe('minimizeTransactions', () => {
  it('produces repayments that clear all balances', () => {
    const tx = minimizeTransactions({ a: 20, b: -10, c: -10 });
    expect(tx).toEqual([
      { from: 'b', to: 'a', amount: 10 },
      { from: 'c', to: 'a', amount: 10 },
    ]);
  });
  it('returns nothing when everyone is settled', () => {
    expect(minimizeTransactions({ a: 0, b: 0 })).toEqual([]);
  });
  it('uses a single transaction for a simple two-person debt', () => {
    expect(minimizeTransactions({ a: -15, b: 15 })).toEqual([{ from: 'a', to: 'b', amount: 15 }]);
  });
});

describe('settleUp', () => {
  it('settles each currency independently', () => {
    const out = settleUp(
      [
        { amount: 30, currency: 'AUD', paidBy: 'a', sharedWith: ['a', 'b'] }, // a +15, b -15
        { amount: 20, currency: 'USD', paidBy: 'b', sharedWith: ['a', 'b'] }, // b +10, a -10
      ],
      ['a', 'b'],
    );
    expect(out.AUD.transactions).toEqual([{ from: 'b', to: 'a', amount: 15 }]);
    expect(out.USD.transactions).toEqual([{ from: 'a', to: 'b', amount: 10 }]);
  });
});
