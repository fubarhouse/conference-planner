import { describe, it, expect } from 'vitest';
import {
  extractDurationMinutes,
  durationMinutesToHuman,
  durationToEditorValue,
  durationToCanonical,
  deriveSessionDurationValue,
  syncSessionDuration,
} from '../editorDuration.js';

describe('extractDurationMinutes', () => {
  it('parses the canonical P<minutes>M form', () => {
    expect(extractDurationMinutes('P90M')).toBe(90);
    expect(extractDurationMinutes('p 45 m')).toBe(45);
  });

  it('parses ISO-like PT#H#M', () => {
    expect(extractDurationMinutes('PT1H30M')).toBe(90);
    expect(extractDurationMinutes('PT2H')).toBe(120);
  });

  it('parses compact and spaced h/m forms', () => {
    expect(extractDurationMinutes('1h30m')).toBe(90);
    expect(extractDurationMinutes('2 h 15 m')).toBe(135);
  });

  it('treats a bare number as minutes', () => {
    expect(extractDurationMinutes('45')).toBe(45);
    expect(extractDurationMinutes('1.5')).toBe(2); // rounded
  });

  it('returns null for empty or unparseable input', () => {
    expect(extractDurationMinutes('')).toBeNull();
    expect(extractDurationMinutes('soon')).toBeNull();
    expect(extractDurationMinutes(null)).toBeNull();
  });
});

describe('durationMinutesToHuman', () => {
  it('formats hours and minutes', () => {
    expect(durationMinutesToHuman(90)).toBe('1h30m');
    expect(durationMinutesToHuman(120)).toBe('2h');
    expect(durationMinutesToHuman(45)).toBe('45m');
  });

  it('returns empty for non-positive or invalid input', () => {
    expect(durationMinutesToHuman(0)).toBe('');
    expect(durationMinutesToHuman(-5)).toBe('');
    expect(durationMinutesToHuman(NaN)).toBe('');
  });
});

describe('durationToEditorValue', () => {
  it('round-trips a canonical value to the friendly form', () => {
    expect(durationToEditorValue('P90M')).toBe('1h30m');
  });

  it('passes through an unparseable value unchanged', () => {
    expect(durationToEditorValue('TBD')).toBe('TBD');
    expect(durationToEditorValue('')).toBe('');
  });
});

describe('durationToCanonical', () => {
  it('produces P<minutes>M from a friendly value', () => {
    expect(durationToCanonical('1h30m')).toBe('P90M');
  });

  it('normalizes an unparseable value as a string', () => {
    expect(durationToCanonical('  weird  ')).toBe('weird');
  });
});

describe('deriveSessionDurationValue', () => {
  it('computes the canonical duration between two timestamps', () => {
    expect(deriveSessionDurationValue('2026-01-01T09:00:00Z', '2026-01-01T10:30:00Z')).toBe('P90M');
  });

  it('returns empty for missing, invalid, or non-positive ranges', () => {
    expect(deriveSessionDurationValue('', '2026-01-01T10:00:00Z')).toBe('');
    expect(deriveSessionDurationValue('bad', 'also-bad')).toBe('');
    expect(deriveSessionDurationValue('2026-01-01T10:00:00Z', '2026-01-01T09:00:00Z')).toBe('');
  });
});

describe('syncSessionDuration', () => {
  it('prefers the duration derived from start/end times', () => {
    const item = {
      startTime: '2026-01-01T09:00:00Z',
      endTime: '2026-01-01T10:00:00Z',
      duration: 'P5M',
    };
    expect(syncSessionDuration(item)).toBe('P60M');
    expect(item.duration).toBe('P60M');
  });

  it('keeps an existing canonical duration when times are absent', () => {
    const item = { duration: 'P25M' };
    expect(syncSessionDuration(item)).toBe('P25M');
  });

  it('falls back to P0M when nothing is usable', () => {
    expect(syncSessionDuration({ duration: 'nonsense' })).toBe('P0M');
    expect(syncSessionDuration(null)).toBe('P0M');
  });
});
