import { describe, it, expect } from 'vitest';
import {
  normalizeSponsorId,
  normalizeSponsorObject,
  normalizeSponsorCollection,
} from '../editorSponsors.js';

describe('normalizeSponsorId', () => {
  it('slugifies the given value', () => {
    expect(normalizeSponsorId('Acme Corp!')).toBe('acme-corp');
  });

  it('falls back to the title when value is empty', () => {
    expect(normalizeSponsorId('', 'Big Sponsor')).toBe('big-sponsor');
  });

  it('returns an empty string when nothing is provided', () => {
    expect(normalizeSponsorId('')).toBe('');
    expect(normalizeSponsorId(undefined)).toBe('');
  });
});

describe('normalizeSponsorObject', () => {
  it('fills defaults for a bare object', () => {
    const s = normalizeSponsorObject({ title: 'Acme' });
    expect(s).toMatchObject({
      id: 'acme',
      title: 'Acme',
      tier: '',
      row: 1,
      priority: 100,
      image: '',
      link: '',
      enabled: true,
    });
  });

  it('uses the fallback title when none is given and derives the id from it', () => {
    const s = normalizeSponsorObject({}, 'Sponsor 3');
    expect(s.title).toBe('Sponsor 3');
    expect(s.id).toBe('sponsor-3');
  });

  it('coerces row to an integer and defaults invalid rows to 1', () => {
    expect(normalizeSponsorObject({ title: 'A', row: '2' }).row).toBe(2);
    expect(normalizeSponsorObject({ title: 'A', row: 'abc' }).row).toBe(1);
  });

  it('treats enabled as true unless explicitly false', () => {
    expect(normalizeSponsorObject({ title: 'A', enabled: false }).enabled).toBe(false);
    expect(normalizeSponsorObject({ title: 'A', enabled: 'false' }).enabled).toBe(false);
    expect(normalizeSponsorObject({ title: 'A', enabled: true }).enabled).toBe(true);
    expect(normalizeSponsorObject({ title: 'A' }).enabled).toBe(true);
  });

  it('handles non-object input without throwing', () => {
    const s = normalizeSponsorObject(null, 'Fallback');
    expect(s.title).toBe('Fallback');
    expect(s.id).toBe('fallback');
  });
});

describe('normalizeSponsorCollection', () => {
  it('normalizes each entry and numbers missing titles', () => {
    const list = normalizeSponsorCollection([{ title: 'Acme' }, {}]);
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe('acme');
    expect(list[1].title).toBe('Sponsor 2');
  });

  it('returns an empty array for non-array input', () => {
    expect(normalizeSponsorCollection(null)).toEqual([]);
    expect(normalizeSponsorCollection(undefined)).toEqual([]);
    expect(normalizeSponsorCollection('nope')).toEqual([]);
  });
});
