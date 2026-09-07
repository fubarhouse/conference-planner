// Session length, the field nobody read.
//
// Every one of the archive's 6,930 items stores `P<n>M` and nothing else, so this
// parses exactly that shape. Guessing at anything else would quietly inflate a
// headline number ("6,905 hours of programme"), which is worse than reporting 0.
import { describe, it, expect } from 'vitest';
import { sessionMinutes } from '../archiveInsights.js';

describe('sessionMinutes', () => {
  it('reads the archive’s one duration format', () => {
    expect(sessionMinutes({ duration: 'P45M' })).toBe(45);
    expect(sessionMinutes({ duration: 'P570M' })).toBe(570);
    expect(sessionMinutes({ duration: 'p60m' })).toBe(60);
  });

  it('tolerates surrounding whitespace', () => {
    expect(sessionMinutes({ duration: '  P30M ' })).toBe(30);
  });

  it('returns 0 for anything it was not built to read', () => {
    // Better a visibly missing hour than a silently wrong one.
    for (const duration of ['PT1H', 'P1DT2H', '45', '45m', 'PM', '', null, undefined])
      expect(sessionMinutes({ duration }), String(duration)).toBe(0);
  });

  it('returns 0 for a missing item', () => {
    expect(sessionMinutes(null)).toBe(0);
    expect(sessionMinutes({})).toBe(0);
  });
});
