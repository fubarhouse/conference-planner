import { describe, it, expect } from 'vitest';
import { toWednesdayOfWeek, autoArriveDate, localDateStr } from '../plannerDates.js';

describe('toWednesdayOfWeek', () => {
  it('returns the Wednesday of the same Mon–Sun week', () => {
    // 2026-01-01 is a Thursday → Wednesday of that week is 2025-12-31.
    expect(toWednesdayOfWeek('2026-01-01')).toBe('2025-12-31');
    // 2026-01-05 is a Monday → Wednesday is 2026-01-07.
    expect(toWednesdayOfWeek('2026-01-05')).toBe('2026-01-07');
  });

  it('is idempotent on a Wednesday', () => {
    expect(toWednesdayOfWeek('2026-01-07')).toBe('2026-01-07');
  });

  it('accepts a full ISO timestamp', () => {
    expect(toWednesdayOfWeek('2026-01-07T15:30:00Z')).toBe('2026-01-07');
  });
});

describe('autoArriveDate', () => {
  it('returns the next day when arrival is earlier than departure (overnight)', () => {
    expect(autoArriveDate('2026-03-10', '23:00', '06:00')).toBe('2026-03-11');
  });

  it('returns empty when arrival is same-day (>= departure)', () => {
    expect(autoArriveDate('2026-03-10', '08:00', '11:00')).toBe('');
  });

  it('returns empty when any field is missing', () => {
    expect(autoArriveDate('', '23:00', '06:00')).toBe('');
    expect(autoArriveDate('2026-03-10', '', '06:00')).toBe('');
    expect(autoArriveDate('2026-03-10', '23:00', '')).toBe('');
  });
});

describe('localDateStr', () => {
  it('formats a Date as local YYYY-MM-DD with zero-padding', () => {
    expect(localDateStr(new Date(2026, 0, 5))).toBe('2026-01-05'); // Jan = month 0
    expect(localDateStr(new Date(2026, 11, 31))).toBe('2026-12-31');
  });
});
