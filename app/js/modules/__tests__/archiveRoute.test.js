// The archive speaks two address forms, and for a long time it only knew one.
//
// Served, `/archive/person/x` is right. Deployed as plain files — a supported
// deployment — it is wrong twice: the breadcrumb's `<a href="/archive">` points
// at the host root rather than at the page, and every pushState mints an
// address that 404s on reload. The schedule and planner were converted to the
// two-form pattern; the archive was the one section left behind.
//
// Round trip is the property that matters: what archiveHref builds,
// parseArchiveRoute must read back — in BOTH forms.
import { describe, it, expect } from 'vitest';
import { usePathRouting, parseArchiveRoute, archiveHref, ARCHIVE_TABS } from '../archiveRoute.js';

describe('usePathRouting', () => {
  it('is true only for the served section address', () => {
    expect(usePathRouting('/archive')).toBe(true);
    expect(usePathRouting('/archive/person/gabor')).toBe(true);
    expect(usePathRouting('/archive.html')).toBe(false);
    expect(usePathRouting('/site/archive.html')).toBe(false);
    expect(usePathRouting('/')).toBe(false);
    expect(usePathRouting('')).toBe(false);
  });

  it('is not fooled by a deeper path that merely contains the word', () => {
    // A static site at /project/archive.html must NOT be read as path routing.
    expect(usePathRouting('/project/archive/person/x')).toBe(false);
  });
});

describe('the static form never emits a host-absolute address', () => {
  // The whole point: on a static host the app may live at any depth, so every
  // address it builds has to be relative to the page.
  const views = [
    { view: 'home' },
    { view: 'tab', tab: 'videos' },
    { view: 'sessions', key: 'layout builder' },
    { view: 'source', key: 'events/drupalcon/eu/2024-barcelona' },
    { view: 'debuts', year: 2019 },
    { view: 'topic', key: 'accessibility', year: 2024 },
    { view: 'drill', kind: 'person', key: 'gabor-hojtsy' },
  ];
  it.each(views)('$view', (view) => {
    const href = archiveHref(view, { pathRouting: false });
    expect(href.startsWith('./archive.html')).toBe(true);
    expect(href.startsWith('/')).toBe(false);
  });

  it('and the path form always does', () => {
    for (const view of views) {
      expect(archiveHref(view, { pathRouting: true }).startsWith('/archive')).toBe(true);
    }
  });
});

describe('round trip', () => {
  const cases = [
    { view: 'home' },
    ...ARCHIVE_TABS.map((tab) => ({ view: 'tab', tab })),
    { view: 'sessions', key: 'layout builder', mode: 'exact' },
    { view: 'sessions', key: 'ai', mode: 'contains' },
    { view: 'source', key: 'events/drupalcon/eu/2024-barcelona' },
    { view: 'debuts', year: '2019' },
    { view: 'topic', key: 'accessibility', year: '2024' },
    { view: 'drill', kind: 'person', key: 'gabor-hojtsy' },
    { view: 'drill', kind: 'sponsor', key: 'acquia' },
    { view: 'drill', kind: 'year', key: '2024' },
  ];

  for (const pathRouting of [true, false]) {
    it.each(cases)(`${pathRouting ? 'path' : 'query'} form: $view $kind`, (want) => {
      const href = archiveHref(want, { pathRouting });
      const [pathname, search] = href.replace(/^\./, '').split('?');
      const got = parseArchiveRoute({ pathname, search: search || '' });
      expect(got.view).toBe(want.view);
      if (want.tab) expect(got.tab).toBe(want.tab);
      if (want.kind) expect(got.kind).toBe(want.kind);
      if (want.key !== undefined) expect(got.key).toBe(String(want.key));
      if (want.year !== undefined) expect(String(got.year)).toBe(String(want.year));
      if (want.mode) expect(got.mode).toBe(want.mode);
    });
  }
});

describe('parsing details that have bitten before', () => {
  it('keeps a slash inside a source key', () => {
    // A dataset path is the key, and it has slashes in it.
    const got = parseArchiveRoute({ pathname: '/archive/source/events/drupalcon/eu/2024-x' });
    expect(got.view).toBe('source');
    expect(got.key).toBe('events/drupalcon/eu/2024-x');
  });

  it('reads a topic as a term/year PAIR, taking the year off the end', () => {
    const got = parseArchiveRoute({ pathname: '/archive/topic/layout-builder/2024' });
    expect(got).toMatchObject({ view: 'topic', key: 'layout-builder', year: '2024' });
  });

  it('defaults the match mode to whole words', () => {
    // Only the non-default reading is ever written down, so absence means exact.
    expect(parseArchiveRoute({ pathname: '/archive/sessions/ai' }).mode).toBe('exact');
    expect(
      parseArchiveRoute({ pathname: '/archive/sessions/ai', search: '?match=contains' }).mode,
    ).toBe('contains');
  });

  it('treats a bare section address as home in either form', () => {
    expect(parseArchiveRoute({ pathname: '/archive' }).view).toBe('home');
    expect(parseArchiveRoute({ pathname: '/archive/' }).view).toBe('home');
    expect(parseArchiveRoute({ pathname: '/archive.html' }).view).toBe('home');
  });

  it('ignores a tab it does not know rather than rendering nothing', () => {
    expect(parseArchiveRoute({ pathname: '/archive.html', search: '?tab=nonsense' }).view).toBe(
      'home',
    );
  });

  it('does not mistake a one-segment drill for a tab', () => {
    // /archive/person with no key is not a record — it must not open one.
    expect(parseArchiveRoute({ pathname: '/archive/person' }).view).toBe('home');
  });
});
