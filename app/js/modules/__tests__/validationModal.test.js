import { describe, it, expect } from 'vitest';
import { humanizeValidationErrors } from '../validationModal.js';

describe('humanizeValidationErrors', () => {
  it('prettifies the server (pre-mapped) path and a multi-type message', () => {
    const [row] = humanizeValidationErrors([
      { path: '.personal.gpxTrack', keyword: 'type', params: { type: 'object,null' } },
    ]);
    expect(row.location).toBe('personal › gpxTrack');
    expect(row.message).toBe('should be an object or empty');
  });

  it('turns array indices into human item numbers (AJV v6 dotted path)', () => {
    const [row] = humanizeValidationErrors([
      { dataPath: '.personal.accommodations[0].id', keyword: 'type', params: { type: 'string' } },
    ]);
    expect(row.location).toBe('personal › accommodations › item 1 › id');
    expect(row.message).toBe('should be text');
  });

  it('handles AJV v7 pointer paths and required/enum/additionalProperties keywords', () => {
    const rows = humanizeValidationErrors([
      { instancePath: '/items/2', keyword: 'required', params: { missingProperty: 'title' } },
      { path: '.mode', keyword: 'enum', params: { allowedValues: ['personal', 'sponsor'] } },
      { path: '', keyword: 'additionalProperties', params: { additionalProperty: 'oops' } },
    ]);
    expect(rows[0]).toEqual({
      location: 'items › item 3',
      message: 'is missing the required field "title"',
    });
    expect(rows[1].message).toBe('should be one of: personal, sponsor');
    expect(rows[2]).toEqual({
      location: '',
      message: 'has an unexpected field "oops"',
    });
  });

  it('falls back to the raw message for unknown keywords', () => {
    const [row] = humanizeValidationErrors([{ path: '.x', keyword: 'weird', message: 'is off' }]);
    expect(row.message).toBe('is off');
  });
});
