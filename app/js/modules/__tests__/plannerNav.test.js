import { describe, it, expect } from 'vitest';
import { bottomBarPrimary } from '../plannerNav.js';

describe('bottomBarPrimary', () => {
  it('returns the curated destinations for the mode when all are visible', () => {
    const ordered = ['personal', 'companions', 'itinerary', 'map', 'budget', 'summary'];
    expect(bottomBarPrimary('personal', ordered)).toEqual([
      'personal',
      'itinerary',
      'map',
      'budget',
    ]);
  });

  it('backfills from the visible order when a curated tab is hidden', () => {
    // 'map' curated but not visible → backfilled with the next visible tabs.
    const ordered = ['personal', 'itinerary', 'budget', 'summary', 'contacts'];
    const bar = bottomBarPrimary('personal', ordered);
    expect(bar).toHaveLength(4);
    expect(bar).not.toContain('map');
    expect(bar.slice(0, 3)).toEqual(['personal', 'itinerary', 'budget']); // curated & visible first
    expect(bar[3]).toBe('summary'); // first backfill from order
  });

  it('never exceeds four entries', () => {
    const ordered = ['personal', 'itinerary', 'map', 'budget', 'summary', 'contacts', 'tasks'];
    expect(bottomBarPrimary('personal', ordered)).toHaveLength(4);
  });

  it('falls back entirely to the visible order for an unknown mode', () => {
    const ordered = ['a', 'b', 'c', 'd', 'e'];
    expect(bottomBarPrimary('mystery', ordered)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('does not duplicate a tab that is both curated and early in the order', () => {
    const ordered = ['sponsor', 'team', 'budget', 'tasks', 'notes'];
    const bar = bottomBarPrimary('sponsor', ordered);
    expect(new Set(bar).size).toBe(bar.length);
  });
});
