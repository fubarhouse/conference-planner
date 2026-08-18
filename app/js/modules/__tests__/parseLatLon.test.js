import { describe, it, expect } from 'vitest';
import { parseLatLon } from '../plannerOrg.js';

describe('parseLatLon', () => {
  it('parses a "lat, lon" string (with or without spaces)', () => {
    expect(parseLatLon('-41.2865, 174.7762')).toEqual([-41.2865, 174.7762]);
    expect(parseLatLon('51.9,4.5')).toEqual([51.9, 4.5]);
  });
  it('returns null for LOCODEs, place names, and blanks', () => {
    expect(parseLatLon('NZWLG')).toBeNull();
    expect(parseLatLon('Te Papa, Wellington')).toBeNull();
    expect(parseLatLon('')).toBeNull();
    expect(parseLatLon(null)).toBeNull();
  });
  it('rejects out-of-range coordinates', () => {
    expect(parseLatLon('120, 200')).toBeNull();
    expect(parseLatLon('-91, 10')).toBeNull();
  });
});
