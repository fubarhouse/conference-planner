import { describe, it, expect } from 'vitest';
import { findCollection, collectionKeys, resolveArray, ensureArray } from '../resourceRegistry.js';

describe('resourceRegistry', () => {
  it('registers sponsors on the dataset domain and planner collections', () => {
    expect(findCollection('dataset', 'sponsors')?.pointer).toEqual(['event', 'sponsors']);
    expect(findCollection('planner', 'personal/outbound-legs')?.pointer).toEqual([
      'personal',
      'outboundLegs',
    ]);
    expect(findCollection('dataset', 'personal/outbound-legs')).toBeNull();
    expect(collectionKeys('planner')).toContain('org/swag');
  });

  it('resolveArray navigates to the array or returns null', () => {
    const doc = { personal: { outboundLegs: [1, 2] }, org: {} };
    expect(resolveArray(doc, ['personal', 'outboundLegs'])).toEqual([1, 2]);
    expect(resolveArray(doc, ['org', 'swag'])).toBeNull();
    expect(resolveArray(doc, ['missing', 'x'])).toBeNull();
  });

  it('ensureArray creates intermediate objects and the array', () => {
    const doc = {};
    const arr = ensureArray(doc, ['org', 'swag']);
    arr.push({ id: 'x' });
    expect(doc.org.swag).toEqual([{ id: 'x' }]);
  });
});
