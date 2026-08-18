import { describe, it, expect } from 'vitest';
import { activeDayIndex } from '../scheduleDayNav.js';

// Four days starting at these document offsets.
const TOPS = [400, 3200, 6100, 9000];

describe('activeDayIndex', () => {
  it('is the last day that has started', () => {
    expect(activeDayIndex(TOPS, 3300)).toBe(1);
    expect(activeDayIndex(TOPS, 6100)).toBe(2);
    expect(activeDayIndex(TOPS, 12000)).toBe(3);
  });

  it('claims a day the moment its heading reaches the line, not after', () => {
    expect(activeDayIndex(TOPS, 3199)).toBe(0);
    expect(activeDayIndex(TOPS, 3200)).toBe(1);
  });

  it('shows the first day while the page header is still on screen', () => {
    expect(activeDayIndex(TOPS, 0)).toBe(0);
  });

  it('has no answer when there are no days', () => {
    expect(activeDayIndex([], 500)).toBe(-1);
    expect(activeDayIndex(undefined, 500)).toBe(-1);
  });

  it('handles a single day', () => {
    expect(activeDayIndex([400], 9000)).toBe(0);
  });
});
