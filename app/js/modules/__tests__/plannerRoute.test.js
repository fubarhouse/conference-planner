import { describe, it, expect } from 'vitest';
import { usePathRouting, parsePlannerRoute, plannerHref, plannerCrumbs } from '../plannerRoute.js';

describe('usePathRouting', () => {
  it('is on for a served /planner path', () => {
    expect(usePathRouting('/planner')).toBe(true);
    expect(usePathRouting('/planner/my-trip')).toBe(true);
    expect(usePathRouting('/planner/my-trip/budget')).toBe(true);
  });

  it('is off for the static file form, including under a sub-directory', () => {
    expect(usePathRouting('/planner.html')).toBe(false);
    expect(usePathRouting('/conference-planner/planner.html')).toBe(false);
    expect(usePathRouting('/')).toBe(false);
  });
});

describe('parsePlannerRoute', () => {
  it('reads the selection screen', () => {
    expect(parsePlannerRoute({ pathname: '/planner' })).toEqual({ key: null, tab: null });
  });

  it('reads a planner and a tab from the path', () => {
    expect(parsePlannerRoute({ pathname: '/planner/my-trip' })).toEqual({
      key: 'my-trip',
      tab: null,
    });
    expect(parsePlannerRoute({ pathname: '/planner/my-trip/budget' })).toEqual({
      key: 'my-trip',
      tab: 'budget',
    });
  });

  it('decodes segments', () => {
    expect(parsePlannerRoute({ pathname: '/planner/my%20trip' }).key).toBe('my trip');
  });

  it('reads the query form when there is no path', () => {
    expect(parsePlannerRoute({ pathname: '/planner.html', search: '?id=my-trip&tab=map' })).toEqual(
      {
        key: 'my-trip',
        tab: 'map',
      },
    );
  });

  it('still accepts the ?event= dataset filename', () => {
    expect(parsePlannerRoute({ pathname: '/planner.html', search: '?event=dc-2025.json' })).toEqual(
      {
        key: 'dc-2025.json',
        tab: null,
      },
    );
  });

  it('lets the path win, and the query fill in what the path omits', () => {
    // The path is the more specific statement about which planner this is…
    expect(parsePlannerRoute({ pathname: '/planner/a', search: '?id=b' }).key).toBe('a');
    // …but it says nothing about the tab here, so the query still counts.
    expect(parsePlannerRoute({ pathname: '/planner/a', search: '?tab=budget' }).tab).toBe('budget');
  });
});

describe('plannerHref', () => {
  it('builds paths when path routing is on', () => {
    expect(plannerHref(null, null, { pathRouting: true })).toBe('/planner');
    expect(plannerHref('my-trip', null, { pathRouting: true })).toBe('/planner/my-trip');
    expect(plannerHref('my-trip', 'budget', { pathRouting: true })).toBe('/planner/my-trip/budget');
  });

  it('builds query URLs when serving as plain files', () => {
    expect(plannerHref(null, null, { pathRouting: false })).toBe('./planner.html');
    expect(plannerHref('my-trip', null, { pathRouting: false })).toBe('./planner.html?id=my-trip');
    expect(plannerHref('my-trip', 'budget', { pathRouting: false })).toBe(
      './planner.html?id=my-trip&tab=budget',
    );
  });

  it('keeps a .json event file in the query even under path routing', () => {
    // A dot-suffixed path segment reads as a file to servers and to people.
    expect(plannerHref('dc-2025.json', 'map', { pathRouting: true })).toBe(
      '/planner.html?event=dc-2025.json&tab=map',
    );
  });

  it('round-trips: what it builds, the parser reads back', () => {
    const href = plannerHref('my-trip', 'budget', { pathRouting: true });
    const [pathname, search] = href.split('?');
    expect(parsePlannerRoute({ pathname, search: search ? `?${search}` : '' })).toEqual({
      key: 'my-trip',
      tab: 'budget',
    });
  });
});

describe('plannerCrumbs', () => {
  it('marks the selection screen as the current page', () => {
    const trail = plannerCrumbs();
    expect(trail.map((c) => c.label)).toEqual(['Home', 'Planner']);
    expect(trail[1].href).toBeUndefined();
  });

  it('links back up the trail from a tab', () => {
    const trail = plannerCrumbs({
      key: 'my-trip',
      name: 'Wellington 2026',
      tab: 'budget',
      tabLabel: 'Budget',
    });
    expect(trail.map((c) => c.label)).toEqual(['Home', 'Planner', 'Wellington 2026', 'Budget']);
    expect(trail[3].href).toBeUndefined(); // the last crumb is where you are
    expect(trail[2].href).toBeTruthy();
  });

  it('falls back to the key when a planner has no name', () => {
    expect(plannerCrumbs({ key: 'my-trip' })[2].label).toBe('my-trip');
  });
});
