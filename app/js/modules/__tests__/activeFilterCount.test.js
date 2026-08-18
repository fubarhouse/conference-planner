import { describe, it, expect } from 'vitest';
import { activeFilterCount } from '../filters.js';

// Each control's "not filtering" value: '' for the selects that offer All, and
// the literal 'all' for the selection mode.
const NONE = { date: '', track: '', keyword: '', selectionMode: 'all' };

describe('activeFilterCount', () => {
  it('is zero when nothing is narrowing the list', () => {
    expect(activeFilterCount(NONE)).toBe(0);
    expect(activeFilterCount({})).toBe(0);
    expect(activeFilterCount()).toBe(0);
  });

  it('counts each control that is narrowing', () => {
    expect(activeFilterCount({ ...NONE, date: '2025-10-15' })).toBe(1);
    expect(activeFilterCount({ ...NONE, track: 'Keynote' })).toBe(1);
    expect(activeFilterCount({ ...NONE, keyword: 'drupal' })).toBe(1);
    expect(activeFilterCount({ ...NONE, selectionMode: 'selected' })).toBe(1);
  });

  it('adds them up', () => {
    expect(
      activeFilterCount({
        date: '2025-10-15',
        track: 'Keynote',
        keyword: 'ai',
        selectionMode: 'unselected',
      }),
    ).toBe(4);
  });

  it('does not count whitespace as a keyword', () => {
    expect(activeFilterCount({ ...NONE, keyword: '   ' })).toBe(0);
  });

  it('treats a missing selection mode as unfiltered', () => {
    expect(activeFilterCount({ ...NONE, selectionMode: undefined })).toBe(0);
  });
});
