import { describe, it, expect } from 'vitest';
import {
  SPONSOR_TABS_BASE,
  PERSONAL_TABS_BASE,
  visibleTabsOrdered,
  visibleTabs,
} from '../plannerTabs.js';

describe('visibleTabsOrdered', () => {
  it('defaults to the full base set for the mode, in base order', () => {
    const personal = visibleTabsOrdered('personal', {});
    expect(personal).toEqual([...PERSONAL_TABS_BASE]);
    const sponsor = visibleTabsOrdered('sponsor', {});
    expect(sponsor).toEqual([...SPONSOR_TABS_BASE]);
  });

  it("preserves the saved order's relative sequence, slotting unordered tabs in by base position", () => {
    const planner = { personal: { tabOrder: ['budget', 'notes'] } };
    const ordered = visibleTabsOrdered('personal', planner);
    // budget still comes before notes — the user's relative choice is kept…
    expect(ordered.indexOf('budget')).toBeLessThan(ordered.indexOf('notes'));
    // …and a new base tab lands next to its neighbour (split after budget).
    expect(ordered[ordered.indexOf('budget') + 1]).toBe('split');
    // every base tab still present exactly once
    expect(new Set(ordered)).toEqual(PERSONAL_TABS_BASE);
    expect(ordered.length).toBe(PERSONAL_TABS_BASE.size);
  });

  it('slots a NEW base tab next to its neighbour even when a custom order predates it', () => {
    // A saved order from before 'checklists'/'split' existed (mirrors a real user).
    const legacyOrder = [
      'personal',
      'itinerary',
      'map',
      'companions',
      'tasks',
      'budget',
      'receipts',
      'tickets',
      'documents',
      'summary',
    ];
    const ordered = visibleTabsOrdered('personal', { personal: { tabOrder: legacyOrder } });
    // The user's arranged tabs keep their relative order…
    const kept = ordered.filter((t) => legacyOrder.includes(t));
    expect(kept).toEqual(legacyOrder);
    // …and the new tabs land right after their base neighbour, not dumped at the end.
    expect(ordered[ordered.indexOf('tasks') + 1]).toBe('checklists');
    expect(ordered[ordered.indexOf('budget') + 1]).toBe('split');
    expect(ordered[ordered.length - 1]).not.toBe('split'); // not stranded at the very end
    expect(new Set(ordered)).toEqual(PERSONAL_TABS_BASE);
  });

  it('drops disabled tabs', () => {
    const planner = { personal: { disabledTabs: ['budget', 'map'] } };
    const ordered = visibleTabsOrdered('personal', planner);
    expect(ordered).not.toContain('budget');
    expect(ordered).not.toContain('map');
  });

  it('hides conference-only tabs (notes, contacts) when isConference is false', () => {
    const ordered = visibleTabsOrdered('personal', { isConference: false });
    expect(ordered).not.toContain('notes');
    expect(ordered).not.toContain('contacts');
    expect(ordered).toContain('budget'); // non-conference tab still present
  });

  it('ignores stored-order entries that are not in the base set', () => {
    const planner = { sponsor: {}, org: { tabOrder: ['personal', 'sponsor'] } };
    const ordered = visibleTabsOrdered('sponsor', planner);
    expect(ordered).not.toContain('personal'); // not a sponsor-base tab
    expect(ordered[0]).toBe('sponsor');
  });
});

describe('visibleTabs', () => {
  it('is the ordered set plus settings', () => {
    const set = visibleTabs('personal', {});
    expect(set.has('settings')).toBe(true);
    expect(set.has('budget')).toBe(true);
    expect(set.size).toBe(PERSONAL_TABS_BASE.size + 1);
  });
});
