import { describe, it, expect } from 'vitest';
import {
  buildDatasetOptionLabel,
  getDatasetGroupName,
  isEditorDatasetFile,
  validateDatasetSchema,
  buildDatasetGroupingRecord,
  buildDatasetGroupingFallback,
  mergeDateIntoIso,
} from '../editorDataset.js';

describe('mergeDateIntoIso', () => {
  it('preserves the previous time-of-day (and offset) when only the date changes', () => {
    expect(mergeDateIntoIso('2026-11-14', '2026-11-11T09:00:00Z')).toBe('2026-11-14T09:00:00Z');
    expect(mergeDateIntoIso('2026-11-14', '2026-11-11T09:30:00+13:00')).toBe(
      '2026-11-14T09:30:00+13:00',
    );
  });
  it('defaults to UTC midnight when there is no previous time', () => {
    expect(mergeDateIntoIso('2026-11-14', '')).toBe('2026-11-14T00:00:00Z');
    expect(mergeDateIntoIso('2026-11-14', '2026-11-11')).toBe('2026-11-14T00:00:00Z');
  });
  it('clears the field for an empty date', () => {
    expect(mergeDateIntoIso('', '2026-11-11T09:00:00Z')).toBe('');
  });
});

describe('buildDatasetOptionLabel', () => {
  it('joins designation, year and location from meta', () => {
    expect(
      buildDatasetOptionLabel('f.json', {
        designation: 'DrupalCon',
        year: '2026',
        location: 'Vienna',
      }),
    ).toBe('DrupalCon 2026 Vienna');
  });

  it('skips blank meta parts', () => {
    expect(
      buildDatasetOptionLabel('f.json', { designation: 'DrupalCon', year: '', location: 'Vienna' }),
    ).toBe('DrupalCon Vienna');
  });

  it('uses the fallback label when meta is empty, then the file', () => {
    expect(buildDatasetOptionLabel('data/f.json', {}, 'Fallback Label')).toBe('Fallback Label');
    expect(buildDatasetOptionLabel('data/f.json', null)).toBe('data/f.json');
  });
});

describe('getDatasetGroupName', () => {
  it('returns the designation, or "Other" when unset', () => {
    expect(getDatasetGroupName({ designation: 'DrupalCon' })).toBe('DrupalCon');
    expect(getDatasetGroupName({})).toBe('Other');
    expect(getDatasetGroupName(null)).toBe('Other');
  });
});

describe('isEditorDatasetFile', () => {
  it('accepts .json files other than the index manifest', () => {
    expect(isEditorDatasetFile('data/2026-vienna.json')).toBe(true);
    expect(isEditorDatasetFile('Event.JSON')).toBe(true);
  });

  it('rejects the index manifest and non-json names', () => {
    expect(isEditorDatasetFile('index.json')).toBe(false);
    expect(isEditorDatasetFile('readme.md')).toBe(false);
    expect(isEditorDatasetFile('')).toBe(false);
    expect(isEditorDatasetFile(null)).toBe(false);
  });
});

describe('validateDatasetSchema', () => {
  it('passes for a minimally-shaped dataset', () => {
    expect(() => validateDatasetSchema({ event: {}, items: [] })).not.toThrow();
  });

  it('throws with the file name for each missing/invalid part', () => {
    expect(() => validateDatasetSchema(null, 'a.json')).toThrow(/a\.json is not a dataset object/);
    expect(() => validateDatasetSchema([], 'a.json')).toThrow(/not a dataset object/);
    expect(() => validateDatasetSchema({ items: [] }, 'a.json')).toThrow(/missing a valid "event"/);
    expect(() => validateDatasetSchema({ event: {} }, 'a.json')).toThrow(/missing a valid "items"/);
  });
});

describe('buildDatasetGroupingRecord', () => {
  it('builds a full record from event meta', () => {
    const rec = buildDatasetGroupingRecord(
      'data/f.json',
      {
        designation: 'DrupalCon',
        year: '2026',
        location: 'Vienna',
        region: 'EU',
        venue: 'Hall',
        startDate: '2026-01-01',
        endDate: '2026-01-03',
      },
      'Manifest Label',
    );
    expect(rec).toEqual({
      file: 'data/f.json',
      group: 'DrupalCon',
      label: 'DrupalCon 2026 Vienna',
      enabled: true,
      designation: 'DrupalCon',
      location: 'Vienna',
      year: '2026',
      region: 'EU',
      venue: 'Hall',
      startDate: '2026-01-01',
      endDate: '2026-01-03',
    });
  });

  it('marks a record disabled only when enabled is explicitly false', () => {
    expect(buildDatasetGroupingRecord('f.json', { enabled: false }).enabled).toBe(false);
    expect(buildDatasetGroupingRecord('f.json', {}).enabled).toBe(true);
  });
});

describe('buildDatasetGroupingFallback', () => {
  it('produces an Other-grouped record using the fallback label', () => {
    const rec = buildDatasetGroupingFallback('data/bad.json', 'Bad Label');
    expect(rec).toMatchObject({
      file: 'data/bad.json',
      group: 'Other',
      label: 'Bad Label',
      enabled: true,
    });
    expect(rec.designation).toBe('');
  });

  it('falls back to the file name when no label is given', () => {
    expect(buildDatasetGroupingFallback('data/bad.json').label).toBe('data/bad.json');
  });
});
