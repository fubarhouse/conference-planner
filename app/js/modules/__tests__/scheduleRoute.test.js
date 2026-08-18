import { describe, it, expect } from 'vitest';
import {
  usePathRouting,
  parseScheduleRoute,
  scheduleHref,
  scheduleFeedUrl,
  scheduleCrumbs,
  FEED_FILE,
} from '../scheduleRoute.js';
import { scheduleSlug, fileForSlug, slugForFile } from '../scheduleSlug.js';

const CATALOG = [
  {
    file: 'events/drupalsouth/2026-wellington.json',
    event: { designation: 'DrupalSouth', year: '2026', location: 'Wellington' },
  },
  {
    file: 'events/drupalcon/eu/2025-vienna.json',
    event: { designation: 'DrupalCon', year: '2025', location: 'Vienna' },
  },
  { file: 'events/odd/one.json', event: {} },
];

describe('scheduleSlug', () => {
  it('is designation + year + location, slugified', () => {
    expect(scheduleSlug(CATALOG[0])).toBe('drupalsouth-2026-wellington');
    expect(scheduleSlug(CATALOG[1])).toBe('drupalcon-2025-vienna');
  });

  it('falls back to the dataset path when there is no usable metadata', () => {
    expect(scheduleSlug(CATALOG[2])).toBe('events-odd-one');
  });

  it('round-trips a slug to its file and back', () => {
    const slug = scheduleSlug(CATALOG[1]);
    expect(fileForSlug(slug, CATALOG)).toBe(CATALOG[1].file);
    expect(slugForFile(CATALOG[1].file, CATALOG)).toBe(slug);
  });

  it('returns null for a slug nothing matches', () => {
    expect(fileForSlug('not-a-real-event', CATALOG)).toBeNull();
    expect(fileForSlug('', CATALOG)).toBeNull();
  });
});

describe('usePathRouting', () => {
  it('is true only under /schedules', () => {
    expect(usePathRouting('/schedules')).toBe(true);
    expect(usePathRouting('/schedules/drupalsouth-2026-wellington')).toBe(true);
    expect(usePathRouting('/index.html')).toBe(false);
    expect(usePathRouting('/planner/trip')).toBe(false);
    expect(usePathRouting('')).toBe(false);
  });
});

describe('parseScheduleRoute', () => {
  it('reads the slug from the path', () => {
    expect(parseScheduleRoute({ pathname: '/schedules/drupalcon-2025-vienna' })).toEqual({
      slug: 'drupalcon-2025-vienna',
      file: null,
      view: 'schedule',
    });
  });

  it('treats the bare section as the selection screen', () => {
    expect(parseScheduleRoute({ pathname: '/schedules' }).view).toBe('browse');
    expect(parseScheduleRoute({ pathname: '/schedules/' }).view).toBe('browse');
  });

  it('recognises the feed under both its names', () => {
    for (const tail of [FEED_FILE, 'subscribe']) {
      const r = parseScheduleRoute({ pathname: `/schedules/vienna/${tail}` });
      expect(r).toEqual({ slug: 'vienna', file: null, view: 'feed' });
    }
  });

  it('reads the query form when there is no path', () => {
    expect(parseScheduleRoute({ pathname: '/index.html', search: '?id=vienna' }).slug).toBe(
      'vienna',
    );
    expect(parseScheduleRoute({ pathname: '/index.html', search: '?browse=1' }).view).toBe(
      'browse',
    );
  });

  it('keeps a dataset FILE in the query — it cannot be a path segment', () => {
    const r = parseScheduleRoute({ search: '?event=events/ddd/2025-leuven.json' });
    expect(r.file).toBe('events/ddd/2025-leuven.json');
    expect(r.slug).toBeNull();
  });

  it('lets the path win over the query', () => {
    const r = parseScheduleRoute({ pathname: '/schedules/from-path', search: '?id=from-query' });
    expect(r.slug).toBe('from-path');
  });
});

describe('scheduleHref', () => {
  it('builds paths when path routing is on', () => {
    expect(scheduleHref('vienna', { pathRouting: true })).toBe('/schedules/vienna');
    expect(scheduleHref(null, { pathRouting: true })).toBe('/schedules');
    expect(scheduleHref('vienna', { pathRouting: true, feed: true })).toBe(
      `/schedules/vienna/${FEED_FILE}`,
    );
  });

  it('builds the query form for static hosting', () => {
    expect(scheduleHref('vienna', { pathRouting: false })).toBe('./index.html?id=vienna');
    expect(scheduleHref(null, { pathRouting: false })).toBe('./index.html');
  });

  it('keeps the existing query feed endpoint when served statically', () => {
    expect(scheduleHref('vienna', { pathRouting: false, feed: true })).toBe(
      './schedule.ics?id=vienna',
    );
  });

  it('carries extra params through both forms', () => {
    expect(scheduleHref('v', { pathRouting: true, params: { theme: 'dark' } })).toBe(
      '/schedules/v?theme=dark',
    );
    expect(scheduleHref('v', { pathRouting: false, params: { theme: 'dark' } })).toContain(
      'theme=dark',
    );
  });
});

describe('scheduleFeedUrl', () => {
  it('is a webcal:// URL so a calendar client takes it directly', () => {
    expect(scheduleFeedUrl('vienna', { origin: 'https://example.org', pathRouting: true })).toBe(
      `webcal://example.org/schedules/vienna/${FEED_FILE}`,
    );
  });

  it('falls back to a relative href with no origin', () => {
    expect(scheduleFeedUrl('vienna', { origin: '', pathRouting: true })).toBe(
      `/schedules/vienna/${FEED_FILE}`,
    );
  });
});

describe('scheduleCrumbs', () => {
  it('is Home → Schedules at the root, with no link on the last crumb', () => {
    const trail = scheduleCrumbs({});
    expect(trail.map((c) => c.label)).toEqual(['Home', 'Schedules']);
    expect(trail.at(-1).href).toBeUndefined();
  });

  it('adds the schedule, and links the section once it is not last', () => {
    const trail = scheduleCrumbs({ slug: 'v', name: 'Vienna 2025' });
    expect(trail.map((c) => c.label)).toEqual(['Home', 'Schedules', 'Vienna 2025']);
    expect(trail[1].href).toBeTruthy();
  });
});
