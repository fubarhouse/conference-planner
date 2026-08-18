// One person, one search row, one address.
//
// The archive stores a human in two unrelated places: `items[].speakers` (a free
// display string) and `event.community.people` (a profile slug, once per role).
// Search used to emit a row per source, and the credit rows were addressed by
// slug while the person page is keyed on the canonical name — so the curated
// people, the ones whose slug HAS been mapped to a real name, got a dead page.
import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => {
  globalThis.document ??= {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
  };
});

const { peopleSearchHits } = await import('../archiveDashboard.js');

const ev = (year, label) => ({ year, label });

// Karl speaks under his display name and volunteers under /u/fubarhouse, which
// curation has mapped onto "Karl Hepworth".
const speakers = [{ name: 'Karl Hepworth', appearances: 6, events: 6 }];
const credits = [
  {
    username: 'fubarhouse',
    name: 'Karl Hepworth',
    role: 'volunteer',
    detail: [
      ev(2024, 'DrupalSouth Community Day Canberra 2024'),
      ev(2025, 'DrupalSouth Melbourne 2025'),
    ],
  },
];

describe('peopleSearchHits', () => {
  it('merges speaking and credits into one row', () => {
    const rows = peopleSearchHits({ speakers, credits, term: 'karl' });
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toBe('6 talks · 6 events · 2 events as volunteer');
  });

  it('addresses the row by canonical name, not by profile slug', () => {
    // The page is keyed on the name; handing it "fubarhouse" opened nothing.
    const [row] = peopleSearchHits({ speakers, credits, term: 'karl' });
    expect(row.key).toBe('Karl Hepworth');
  });

  it('finds a person by their slug and still shows their talks', () => {
    const rows = peopleSearchHits({ speakers, credits, term: 'fubarhouse' });
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe('Karl Hepworth');
    expect(rows[0].meta).toContain('6 talks');
  });

  it('keeps both roles on one row when someone organised and volunteered', () => {
    const both = [
      { username: 'davesparks', name: 'Dave Sparks', role: 'organiser', detail: [ev(2022, 'A')] },
      {
        username: 'davesparks',
        name: 'Dave Sparks',
        role: 'volunteer',
        detail: [ev(2022, 'A'), ev(2023, 'B')],
      },
    ];
    const rows = peopleSearchHits({ speakers: [], credits: both, term: 'dave' });
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toBe('1 event as organiser · 2 events as volunteer');
  });

  it('drops a person whose credits are all outside the current scope', () => {
    // Nothing to show on the page, so the row would be a dead end.
    const rows = peopleSearchHits({
      speakers: [],
      credits,
      term: 'karl',
      inScope: (e) => e.year === 1999,
    });
    expect(rows).toEqual([]);
  });

  it('keeps a speaker with no credits at all', () => {
    const rows = peopleSearchHits({ speakers, credits: [], term: 'karl' });
    expect(rows).toEqual([
      { key: 'Karl Hepworth', label: 'Karl Hepworth', meta: '6 talks · 6 events' },
    ]);
  });

  it('falls back to the slug when a credit has no display name', () => {
    const rows = peopleSearchHits({
      speakers: [],
      credits: [{ username: 'p_stampy', role: 'organiser', detail: [ev(2025, 'A')] }],
      term: 'stampy',
    });
    expect(rows[0].key).toBe('p_stampy');
  });
});
