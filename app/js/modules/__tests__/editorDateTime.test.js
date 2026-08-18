import { describe, it, expect } from 'vitest';
import { utcIsoToLocalInput, parseLocalInput, localInputToUtcIso } from '../editorDateTime.js';

describe('parseLocalInput', () => {
  it('parses a valid datetime-local value into parts', () => {
    expect(parseLocalInput('2026-03-08T14:30')).toEqual({
      year: 2026,
      month: 3,
      day: 8,
      hour: 14,
      minute: 30,
      second: 0,
    });
  });

  it('returns null for malformed or empty input', () => {
    expect(parseLocalInput('')).toBeNull();
    expect(parseLocalInput('2026-03-08')).toBeNull();
    expect(parseLocalInput('not a date')).toBeNull();
    expect(parseLocalInput(null)).toBeNull();
  });
});

describe('utcIsoToLocalInput', () => {
  it('renders UTC unchanged', () => {
    expect(utcIsoToLocalInput('2026-01-01T09:00:00Z', 'UTC')).toBe('2026-01-01T09:00');
  });

  it('applies a fixed (non-DST) offset', () => {
    // Singapore is UTC+8 year-round.
    expect(utcIsoToLocalInput('2026-01-01T09:00:00Z', 'Asia/Singapore')).toBe('2026-01-01T17:00');
  });

  it('falls back to UTC for an unknown timezone', () => {
    expect(utcIsoToLocalInput('2026-01-01T09:00:00Z', 'Not/AZone')).toBe('2026-01-01T09:00');
  });

  it('returns empty for missing or invalid iso', () => {
    expect(utcIsoToLocalInput('', 'UTC')).toBe('');
    expect(utcIsoToLocalInput('garbage', 'UTC')).toBe('');
  });
});

describe('localInputToUtcIso', () => {
  it('converts a UTC wall time to the same UTC instant', () => {
    expect(localInputToUtcIso('2026-01-01T09:00', 'UTC')).toBe('2026-01-01T09:00:00Z');
  });

  it('converts a fixed-offset wall time back to UTC', () => {
    expect(localInputToUtcIso('2026-01-01T17:00', 'Asia/Singapore')).toBe('2026-01-01T09:00:00Z');
  });

  it('returns empty for an unparseable value', () => {
    expect(localInputToUtcIso('2026-01-01', 'UTC')).toBe('');
    expect(localInputToUtcIso('', 'UTC')).toBe('');
  });
});

describe('DST round-trip (America/New_York)', () => {
  // The conversion must be a stable inverse across DST boundaries: rendering a UTC
  // instant to local and back must reproduce the original wall-clock value.
  it.each(['2026-01-15T10:30', '2026-07-15T10:30'])('round-trips %s', (local) => {
    const iso = localInputToUtcIso(local, 'America/New_York');
    expect(utcIsoToLocalInput(iso, 'America/New_York')).toBe(local);
  });
});
