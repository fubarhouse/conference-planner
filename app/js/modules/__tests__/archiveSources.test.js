import { describe, expect, it } from 'vitest';
import {
  claimSentence,
  registryGroupsHtml,
  sessionEntries,
  sourceDrillPath,
  sourceRows,
  sourceTotals,
  sourceTrendSvg,
} from '../archiveDashboard.js';
import { provenanceSummary } from '../../../../scripts/lib/archiveInsights.js';

describe('provenanceSummary', () => {
  const dataset = () => ({
    event: {
      sources: [
        {
          id: 'wb',
          kind: 'schedule',
          url: 'http://gone.test/schedule',
          retrievedAt: '2026-04-27',
          via: {
            provider: 'wayback',
            timestamp: '20130826155852',
            captureUrl: 'https://web.archive.org/web/20130826155852/http://gone.test/schedule',
          },
        },
        { id: 'sess', kind: 'sessions', url: 'http://gone.test/a' },
        {
          id: 'told',
          kind: 'stats',
          title: 'Reported by the organisers',
          via: { provider: 'stated' },
        },
      ],
    },
    items: [
      { link: 'http://gone.test/a', sourceIds: ['sess'] },
      { sourceIds: ['wb'] },
      { title: 'uncited' },
    ],
  });

  it('separates the source tier from the strength of the claim', () => {
    const p = provenanceSummary(dataset());
    // One session cites its own page, one cites the schedule; the uncited row
    // is not counted at all rather than counted as weak.
    expect(p.cited).toBe(2);
    expect(p.exact).toBe(1);
  });

  it('flags archive.org and dates the earliest capture', () => {
    const p = provenanceSummary(dataset());
    expect(p.wayback).toBe(1);
    expect(p.oldestCapture).toBe('2013-08-26');
  });

  it('counts stated and undated sources', () => {
    const p = provenanceSummary(dataset());
    expect(p.stated).toBe(1);
    expect(p.undated).toBe(2); // the sessions page and the stated source
  });

  it('carries a bibliography so the view needs no second request', () => {
    const p = provenanceSummary(dataset());
    expect(p.list).toHaveLength(3);
    // No captureUrl per source: the view links the original address and carries
    // one standing note about archive.org, so a second URL each paid for nothing.
    expect(p.list.every((x) => !('captureUrl' in x))).toBe(true);
    expect(p.list.find((s) => s.id === 'told')).toMatchObject({
      stated: true,
      title: 'Reported by the organisers',
      url: null,
    });
  });

  it('reports an event with no sources as empty rather than throwing', () => {
    expect(provenanceSummary({ event: {}, items: [] })).toMatchObject({ count: 0, cited: 0 });
  });
});

describe('sourceRows', () => {
  const yearEvents = {
    2015: [{ label: 'B', startDate: '2015-06-01', sources: { count: 2 } }],
    2019: [{ label: 'A', startDate: '2019-06-01', sources: { count: 5 } }],
  };

  it('orders newest first, by when the event ran', () => {
    expect(sourceRows(yearEvents).map((r) => r.label)).toEqual(['A', 'B']);
  });

  it('respects the shared scope filter', () => {
    const rows = sourceRows(yearEvents, (e) => e.year === 2015);
    expect(rows.map((r) => r.label)).toEqual(['B']);
  });

  it('keeps events that record no provenance, so the gap is visible', () => {
    const rows = sourceRows({ 2020: [{ label: 'C', startDate: '2020-01-01' }] });
    expect(rows).toHaveLength(1);
    expect(rows[0].sources).toBeNull();
  });
});

describe('references — the measure that compares across events', () => {
  it('counts every distinct page an event points at, not just the registry', () => {
    const p = provenanceSummary({
      event: {
        sources: [{ id: 'a', kind: 'schedule', url: 'http://x.test/schedule' }],
        flickr: { groupUrl: 'http://flickr.test/album' },
      },
      items: [
        { link: 'http://x.test/s/1', video_url: 'http://yt.test/1' },
        { link: 'http://x.test/s/2' },
      ],
    });
    expect(p.count).toBe(1); // one registered source
    expect(p.references).toBe(5); // schedule + 2 sessions + 1 video + 1 album
  });

  it('counts a page once even when it is both registered and linked', () => {
    // The captured-session case: the page is a recorded source AND the address
    // its session links to. One page, one reference.
    const p = provenanceSummary({
      event: { sources: [{ id: 'a', kind: 'sessions', url: 'http://x.test/s/1' }] },
      items: [{ link: 'http://x.test/s/1' }],
    });
    expect(p.references).toBe(1);
  });

  it('does not let capture method inflate an event', () => {
    // Same event, recorded two ways: every session page registered (as a
    // capture-scraped event has) versus none (as a live-scraped one has).
    const links = Array.from({ length: 20 }, (_, i) => ({ link: `http://x.test/s/${i}` }));
    const captured = provenanceSummary({
      event: {
        sources: links.map((l, i) => ({ id: `s${i}`, kind: 'sessions', url: l.link })),
      },
      items: links,
    });
    const live = provenanceSummary({ event: { sources: [] }, items: links });
    expect(captured.count).toBe(20);
    expect(live.count).toBe(0); // registry size differs tenfold…
    expect(captured.references).toBe(live.references); // …references do not
  });
});

describe('sourceTotals', () => {
  const rows = [
    {
      label: 'A',
      sources: {
        count: 4,
        wayback: 3,
        stated: 1,
        tiers: { accepted: 2, live: 2 },
        exact: 10,
        cited: 20,
        oldestCapture: '2013-08-26',
      },
    },
    {
      label: 'B',
      sources: {
        count: 2,
        wayback: 0,
        stated: 0,
        tiers: { accepted: 2 },
        exact: 0,
        cited: 30,
        oldestCapture: null,
      },
    },
    { label: 'C', sources: null },
  ];

  it('counts events that use archive.org, not sources', () => {
    // One event is one story a reader can follow; four captures inside it are not
    // four stories.
    expect(sourceTotals(rows).waybackEvents).toBe(1);
  });

  it('reports the exact share across all citations, not an average of averages', () => {
    // 10 exact of 50 cited = 20%. Averaging the two events' rates (50% and 0%)
    // would say 25% and weight a small event like a large one.
    expect(sourceTotals(rows).exactPct).toBe(20);
  });

  it('reports how many sessions can be checked at their own page', () => {
    // The headline figure. Registry citations measure how thoroughly the
    // backfill ran; this measures whether a reader can actually go and look.
    const withPages = [
      {
        label: 'A',
        sources: { count: 1, tiers: {}, ownPage: 60, sessions: 66, cited: 66, exact: 0 },
      },
      {
        label: 'B',
        sources: { count: 1, tiers: {}, ownPage: 0, sessions: 34, cited: 34, exact: 0 },
      },
    ];
    const t = sourceTotals(withPages);
    expect(t.ownPage).toBe(60);
    expect(t.sessions).toBe(100);
    expect(t.ownPagePct).toBe(60);
    // …and it is emphatically not the registry figure, which is 0 here.
    expect(t.exactPct).toBe(0);
  });

  it('counts sources nobody has checked', () => {
    expect(sourceTotals(rows).unchecked).toBe(2);
  });

  it('surfaces events with no provenance rather than dropping them', () => {
    expect(sourceTotals(rows).noSources).toBe(1);
    expect(sourceTotals(rows).events).toBe(3);
  });

  it('takes the earliest capture across the scope', () => {
    expect(sourceTotals(rows).oldestCapture).toBe('2013-08-26');
  });

  it('handles an empty scope', () => {
    expect(sourceTotals([])).toMatchObject({ events: 0, sources: 0, exactPct: 0 });
  });
});

describe('sourceDrillPath', () => {
  // The archive speaks two address forms and reads the live location to choose,
  // so each expectation has to say which deployment it is describing.
  const at = (pathname, run) => {
    const had = 'location' in globalThis;
    const was = had ? globalThis.location : undefined;
    globalThis.location = { pathname, search: '', origin: '' };
    try {
      run();
    } finally {
      if (had) globalThis.location = was;
      else delete globalThis.location;
    }
  };

  it('drops the .json and escapes the path', () => {
    at('/archive', () =>
      expect(sourceDrillPath('drupaljam/2019-utrecht.json')).toBe(
        '/archive/source/drupaljam%2F2019-utrecht',
      ),
    );
  });

  it('tolerates a missing file', () => {
    at('/archive', () => expect(sourceDrillPath()).toBe('/archive/source/'));
  });

  it('stays relative to the page when deployed as plain files', () => {
    // A host-absolute path would 404 on reload, and on a project site it points
    // at the wrong origin entirely.
    at('/repo/archive.html', () =>
      expect(sourceDrillPath('drupaljam/2019-utrecht.json')).toBe(
        './archive.html?source=drupaljam%2F2019-utrecht',
      ),
    );
  });
});

describe('claimSentence', () => {
  it('says what an event DOES hold when it has no session list', () => {
    // "This event records no sessions" read as a broken record. An archive of
    // 28 talks on video is not empty.
    const line = claimSentence({ sessions: 0 }, { videos: 28, photos: 1 });
    expect(line).toMatch(/28 recordings/);
    expect(line).toMatch(/photo album/);
  });

  it('makes no claim that anything was LOST when there are no sessions', () => {
    // "survives" was being said about live events whose schedule simply has not
    // been imported yet — a gap in this archive, not in history.
    for (const line of [
      claimSentence({ sessions: 0 }, {}),
      claimSentence({ sessions: 0 }, { videos: 3 }),
    ]) {
      expect(line).not.toMatch(/surviv/i);
      expect(line).toMatch(/yet/);
    }
  });

  it('says nothing at all about how many sessions have a page of their own', () => {
    // Plenty of conferences never publish per-session pages — the schedule IS
    // the record, and it is in the list below. A ratio framed that as a
    // shortfall, and measured our scraping rather than their archive.
    for (const p of [
      { sessions: 72, ownPage: 46 },
      { sessions: 72, ownPage: 72 },
      { sessions: 72, ownPage: 0 },
    ]) {
      expect(claimSentence(p)).toBe('');
    }
  });
});

describe('sourceTrendSvg', () => {
  const rows = [
    { year: 2010, sources: { count: 34, wayback: 33, sessions: 44, sponsorCount: 14 } },
    { year: 2015, sources: { count: 7, wayback: 6, sessions: 400, sponsorCount: 120 } },
    { year: 2024, sources: { count: 3, wayback: 0, sessions: 500, sponsorCount: 200 } },
  ];

  it('plots ONE series — two measures of different scale is the classic misread', () => {
    const svg = sourceTrendSvg(rows);
    expect(svg.match(/<polyline/g)).toHaveLength(1);
    expect(svg).not.toContain('obs-st-legend'); // one series names itself
  });

  it('plots the material, not our sourcing method', () => {
    const svg = sourceTrendSvg(rows);
    // 500 + 200 is the peak year; the source COUNT (34) spikes in 2010 purely
    // because that year was scraped from captures with a page per session.
    expect(svg).toMatch(/text-anchor="[a-z]+">700</);
    expect(svg).not.toMatch(/archive\.org/i);
    expect(svg).not.toMatch(/>34</);
  });

  it('labels only the peak, never every point', () => {
    const svg = sourceTrendSvg(rows);
    expect(svg.match(/>700</g)).toHaveLength(1);
    expect(svg).not.toContain('>58<'); // 44 + 14, the first year, left unlabelled
  });

  it('refuses to draw a trend from a single year', () => {
    expect(sourceTrendSvg([rows[0]])).toBe('');
  });

  it('draws nothing when the scope has no sourced records', () => {
    expect(
      sourceTrendSvg([
        { year: 2010, sources: null },
        { year: 2011, sources: null },
      ]),
    ).toBe('');
  });

  it('describes itself, and its peak, for a screen reader', () => {
    expect(sourceTrendSvg(rows)).toMatch(
      /aria-label="Sessions and sponsors citing a source, per year, 2010 to 2024\. Peak 700 in 2024\./,
    );
  });
});

describe('registryGroupsHtml', () => {
  const src = (i, kind) => ({ id: `s${i}`, kind, url: `http://x.test/${kind}/${i}` });

  it('collapses a long group rather than making the reader scroll past it', () => {
    const html = registryGroupsHtml(Array.from({ length: 28 }, (_, i) => src(i, 'sponsors')));
    expect(html).toContain('<details');
    expect(html).toContain('<summary');
    expect(html).toContain('Sponsor listings');
  });

  it('leaves a short group open — three schedule pages are not a wall', () => {
    const html = registryGroupsHtml([src(1, 'schedule'), src(2, 'schedule'), src(3, 'schedule')]);
    expect(html).not.toContain('<details');
    expect(html).toContain('Schedule pages');
  });

  it('groups by kind, so the label is said once per group', () => {
    const html = registryGroupsHtml([src(1, 'schedule'), src(2, 'schedule'), src(3, 'sponsors')]);
    expect(html.match(/Schedule pages/g)).toHaveLength(1);
    expect(html.match(/Sponsor listings/g)).toHaveLength(1);
  });
});

describe('session pages sit in one place, whatever the scrape did', () => {
  // Real talk titles on purpose: "Opening" and "Closing" are agenda words, so
  // naming a fixture that way silently tests the wrong path.
  const items = [
    { title: 'Decoupled Drupal in practice', link: 'http://x.test/s/1' },
    { title: 'Migrating a newsroom', link: 'http://x.test/s/2' },
  ];

  it('never puts session pages in the registry section', () => {
    // The whole bug: an event scraped from captures had its sessions under
    // "What this event was built from", while every live-scraped event had
    // them under "Where its records point".
    const html = registryGroupsHtml([
      { id: 'a', kind: 'schedule', url: 'http://x.test/schedule' },
      { id: 'b', kind: 'sessions', url: 'http://x.test/s/1' },
    ]);
    expect(html).toContain('Schedule pages');
    expect(html).not.toContain('Session pages');
  });

  it('produces the same list whether the pages were registered or not', () => {
    const captured = sessionEntries(
      items,
      items.map((i, n) => ({ id: `s${n}`, kind: 'sessions', url: i.link })),
    );
    const live = sessionEntries(items, []);
    expect(captured).toEqual(live);
    expect(captured.map((e) => e.href)).toEqual(['http://x.test/s/1', 'http://x.test/s/2']);
  });

  it('lists a captured page whose session has since left the dataset', () => {
    const out = sessionEntries(items, [
      { id: 'ghost', kind: 'sessions', url: 'http://x.test/s/9', title: 'Withdrawn talk' },
    ]);
    expect(out).toHaveLength(3);
    expect(out[2]).toEqual({ href: 'http://x.test/s/9', text: 'Withdrawn talk' });
  });

  it('drops a session page already shown as another kind of source', () => {
    const out = sessionEntries(items, [], (url) => url !== 'http://x.test/s/1');
    expect(out.map((e) => e.href)).toEqual(['http://x.test/s/2']);
  });

  it('skips sessions with no page of their own', () => {
    expect(sessionEntries([{ title: 'No link' }], [])).toEqual([]);
  });
});

describe('agenda items are not sessions', () => {
  const items = [
    { title: 'Opening keynote', link: 'http://x.test/s/1' },
    { title: 'Lunch', link: 'http://x.test/s/lunch' },
    { title: 'Coffee break', link: 'http://x.test/s/coffee' },
    { title: 'Registration', link: 'http://x.test/s/reg', isAgendaItem: true },
    { title: 'Rethinking Event Registration', link: 'http://x.test/s/2' },
  ];

  it('keeps lunch and registration out of the session pages list', () => {
    expect(sessionEntries(items, []).map((e) => e.text)).toEqual([
      'Opening keynote',
      'Rethinking Event Registration',
    ]);
  });

  it('lists them separately rather than dropping them — they are still record', () => {
    expect(sessionEntries(items, [], () => true, { agenda: true }).map((e) => e.text)).toEqual([
      'Lunch',
      'Coffee break',
      'Registration',
    ]);
  });

  it('never puts a registered session source in the agenda list', () => {
    const out = sessionEntries(
      items,
      [{ id: 'a', kind: 'sessions', url: 'http://x.test/s/9', title: 'A talk' }],
      () => true,
      { agenda: true },
    );
    expect(out.every((e) => e.href !== 'http://x.test/s/9')).toBe(true);
  });

  it('counts them apart in the summary', () => {
    const p = provenanceSummary({ event: { sources: [] }, items });
    expect(p.sessions).toBe(2);
    expect(p.agenda).toBe(3);
  });
});
