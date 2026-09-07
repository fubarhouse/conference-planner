// "% of peak" indexes every community series against its own best year. A series
// with ONE year of data is therefore always exactly 100% — which is how the chart
// came to report that 2024 was the peak volunteer year, when what actually
// happened is that 2024 (Singapore) is the only event whose credits are captured.
// A percentage over a denominator of one is not a finding, so those series sit out
// the peak view; this pins the count the rule is decided on.
import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => {
  globalThis.document ??= {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
  };
});

const { yearsWithData } = await import('../archiveDashboard.js');

const plottableUnderPeak = (byYear) => yearsWithData(byYear) >= 2;

describe('yearsWithData', () => {
  it('counts only years that carry a number', () => {
    expect(yearsWithData({ 2023: 5, 2024: 19 })).toBe(2);
    expect(yearsWithData({ 2023: 0, 2024: 19 })).toBe(1);
    expect(yearsWithData({})).toBe(0);
    expect(yearsWithData(undefined)).toBe(0);
  });

  it('marks a single-year series as unplottable under % of peak', () => {
    // Singapore 2024's 19 volunteers, alone in the archive.
    expect(plottableUnderPeak({ 2024: 19 })).toBe(false);
    // Attendance, spread over the years, indexes to something meaningful.
    expect(plottableUnderPeak({ 2019: 1200, 2024: 2437, 2025: 1800 })).toBe(true);
  });

  it('does not rescue a one-year series just because the number is big', () => {
    expect(plottableUnderPeak({ 2024: 2437 })).toBe(false);
  });
});
