// The archive masthead's one line of arithmetic. It read "20 years of the
// community · 2007–2026", which is a contradiction: that range spans 20 calendar
// years but only 19 have elapsed. The line counts anniversaries now, and is
// derived so it stays true when 2027 lands.
import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => {
  globalThis.document ??= {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
  };
});

const { communitySubtitle } = await import('../archiveDashboard.js');

describe('communitySubtitle', () => {
  it('counts elapsed years, not the width of the range', () => {
    // 2007 → 2026 is 19 years. The range still reads 2007–2026, because that is
    // what the archive covers; the two are different facts about the same data.
    expect(communitySubtitle({ min: 2007, max: 2026, elapsed: 19 })).toBe(
      '19 years of the community · 2007–2026',
    );
  });

  it('grows on its own when a year is added', () => {
    // The whole point: adding 2027 must not need this string edited.
    expect(communitySubtitle({ min: 2007, max: 2027, elapsed: 20 })).toBe(
      '20 years of the community · 2007–2027',
    );
  });

  it('says "1 year", not "1 years"', () => {
    expect(communitySubtitle({ min: 2025, max: 2026, elapsed: 1 })).toBe(
      '1 year of the community · 2025–2026',
    );
  });

  it('does not count to zero when the archive holds a single year', () => {
    // A first year has no anniversary yet, so it states the year instead.
    expect(communitySubtitle({ min: 2026, max: 2026, elapsed: 0 })).toBe('The community in 2026');
  });

  it('returns null with no data, so the page keeps its static line', () => {
    expect(communitySubtitle(null)).toBe(null);
    expect(communitySubtitle(undefined)).toBe(null);
  });
});
