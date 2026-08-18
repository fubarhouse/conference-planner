import { describe, it, expect } from 'vitest';
import {
  normalizeUrlArray,
  parseMultiValue,
  stripSummaryFields,
  normalizeFlickrObject,
  normalizeLogoObject,
} from '../editorNormalize.js';

describe('normalizeUrlArray', () => {
  it('wraps a single string in an array', () => {
    expect(normalizeUrlArray('https://x.test')).toEqual(['https://x.test']);
  });

  it('maps an array through normalizeString', () => {
    expect(normalizeUrlArray(['  a  ', 'b'])).toEqual(['a', 'b']);
  });

  it('returns an empty array for blank/empty input', () => {
    expect(normalizeUrlArray('')).toEqual([]);
    expect(normalizeUrlArray('   ')).toEqual([]);
    expect(normalizeUrlArray(null)).toEqual([]);
  });
});

describe('parseMultiValue', () => {
  it('splits on newlines and commas and trims', () => {
    expect(parseMultiValue('a, b\nc')).toEqual(['a', 'b', 'c']);
  });

  it('drops empty tokens', () => {
    expect(parseMultiValue('a,,\n , b')).toEqual(['a', 'b']);
  });

  it('returns an empty array for empty input', () => {
    expect(parseMultiValue('')).toEqual([]);
    expect(parseMultiValue(null)).toEqual([]);
  });
});

describe('stripSummaryFields', () => {
  it('deletes summary and description from every item', () => {
    const dataset = {
      items: [
        { id: 'a', summary: 'x', description: 'y', title: 'keep' },
        { id: 'b', summary: 'z' },
      ],
    };
    stripSummaryFields(dataset);
    expect(dataset.items[0]).toEqual({ id: 'a', title: 'keep' });
    expect('summary' in dataset.items[1]).toBe(false);
  });

  it('ignores datasets without an items array and non-object items', () => {
    expect(() => stripSummaryFields(null)).not.toThrow();
    expect(() => stripSummaryFields({})).not.toThrow();
    expect(() => stripSummaryFields({ items: [null, 'x'] })).not.toThrow();
  });
});

describe('normalizeFlickrObject', () => {
  it('fills defaults and treats enabled as true unless explicitly false', () => {
    expect(normalizeFlickrObject()).toEqual({
      enabled: true,
      provider: '',
      groupUrl: '',
      image: '',
      imageAlt: '',
    });
    expect(normalizeFlickrObject({ enabled: false }).enabled).toBe(false);
    expect(normalizeFlickrObject({ enabled: 'false' }).enabled).toBe(false);
  });

  it('normalizes provided string fields', () => {
    expect(normalizeFlickrObject({ provider: '  flickr  ' }).provider).toBe('flickr');
  });
});

describe('normalizeLogoObject', () => {
  it('parses boolean flags from booleans or strings', () => {
    expect(normalizeLogoObject({ usePlate: true, logoDisabled: 'true' })).toMatchObject({
      usePlate: true,
      logoDisabled: true,
    });
    expect(normalizeLogoObject({ usePlate: 'false' }).usePlate).toBe(false);
    expect(normalizeLogoObject()).toMatchObject({
      usePlate: false,
      logoDisabled: false,
      faIcon: '',
    });
  });
});
