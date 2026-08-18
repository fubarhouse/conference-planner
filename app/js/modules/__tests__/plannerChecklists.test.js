import { describe, it, expect } from 'vitest';
import { listProgress, overallProgress, templatesFor } from '../plannerChecklists.js';

describe('listProgress', () => {
  it('counts done/total and percent', () => {
    expect(listProgress([{ done: true }, { done: false }, { done: true }])).toEqual({
      done: 2,
      total: 3,
      pct: 67,
    });
  });
  it('is zero-safe for an empty or missing list', () => {
    expect(listProgress([])).toEqual({ done: 0, total: 0, pct: 0 });
    expect(listProgress(undefined)).toEqual({ done: 0, total: 0, pct: 0 });
  });
});

describe('overallProgress', () => {
  it('aggregates across lists', () => {
    const lists = [
      { items: [{ done: true }, { done: true }] },
      { items: [{ done: false }, { done: false }] },
    ];
    expect(overallProgress(lists)).toEqual({ done: 2, total: 4, pct: 50 });
  });
  it('handles no lists', () => {
    expect(overallProgress([])).toEqual({ done: 0, total: 0, pct: 0 });
  });
});

describe('templatesFor', () => {
  it('returns org templates for sponsor mode and personal otherwise', () => {
    expect(templatesFor('sponsor').some((t) => t.title === 'Booth kit')).toBe(true);
    expect(templatesFor('personal').some((t) => t.title === 'Packing')).toBe(true);
  });
  it('every template item is a non-empty string', () => {
    for (const mode of ['personal', 'sponsor']) {
      for (const tpl of templatesFor(mode)) {
        expect(tpl.title).toBeTruthy();
        expect(tpl.items.length).toBeGreaterThan(0);
        expect(tpl.items.every((s) => typeof s === 'string' && s.length)).toBe(true);
      }
    }
  });
});
