import { describe, it, expect, vi } from 'vitest';
import {
  initEditorRelatedEvents,
  normalizeRelatedEventObject,
  normalizeRelatedEventCollection,
  catalogEventId,
  deleteRelatedEvent,
} from '../editorRelatedEvents.js';

describe('normalizeRelatedEvent* (editor)', () => {
  it('coerces an entry, defaulting relationship to Partner and slugging the id', () => {
    const out = normalizeRelatedEventObject({ name: 'DrupalJam', priority: '3' });
    expect(out).toMatchObject({
      id: 'drupaljam',
      name: 'DrupalJam',
      relationship: 'Partner',
      enabled: true,
      featured: false,
      priority: 3,
    });
  });

  it('parses the featured flag', () => {
    expect(normalizeRelatedEventObject({ name: 'X', featured: true }).featured).toBe(true);
  });

  it('collection normalizes arrays and ignores non-arrays', () => {
    expect(normalizeRelatedEventCollection(null)).toEqual([]);
    expect(normalizeRelatedEventCollection([{ name: 'A' }])).toHaveLength(1);
  });
});

describe('catalogEventId', () => {
  it('slugs designation + year + location (matches the ?id= deep link)', () => {
    expect(catalogEventId({ designation: 'DrupalJam', year: '2026', location: 'Rotterdam' })).toBe(
      'drupaljam-2026-rotterdam',
    );
  });
});

describe('deleteRelatedEvent', () => {
  it('removes the entry from the dataset and marks dirty', () => {
    const markDirty = vi.fn();
    const state = {
      dataset: {
        event: {
          relatedEvents: [
            { id: 'a', name: 'A' },
            { id: 'b', name: 'B' },
          ],
        },
      },
    };
    initEditorRelatedEvents({ state, markDirty });
    // No DOM needed: deleteRelatedEvent mutates state then re-renders (guarded no-op
    // when the list element is absent).
    globalThis.document ??= { getElementById: () => null };
    deleteRelatedEvent(0);
    expect(state.dataset.event.relatedEvents.map((e) => e.id)).toEqual(['b']);
    expect(markDirty).toHaveBeenCalledWith(true);
  });
});
