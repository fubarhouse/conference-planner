import { describe, expect, it } from 'vitest';
import { summarise, verificationRows, worklist } from '../sourceVerification.js';
import { attributionStrength, autoVerifiable, sourceConfidence, sourceReach } from '../sources.js';

const CAPTURE =
  'https://web.archive.org/web/20130826155852/http://lanyrd.com/2013/drupalgov/schedule/';

describe('sourceConfidence', () => {
  const base = { id: 's', kind: 'schedule', url: 'https://a.test/' };

  it('ranks a human-verified source top, whatever else it has', () => {
    expect(sourceConfidence({ ...base, verifiedAt: '2026-08-23' })).toBe('verified');
  });

  it('treats a local capture or a wayback capture as surviving evidence', () => {
    expect(sourceConfidence({ ...base, capture: 'cache/x.html' })).toBe('captured');
    expect(sourceConfidence({ ...base, via: { provider: 'wayback', captureUrl: CAPTURE } })).toBe(
      'captured',
    );
  });

  it('treats a bare url as depending on the page still existing', () => {
    expect(sourceConfidence(base)).toBe('live');
  });

  it('keeps stated sources in their own tier — checking cannot promote them', () => {
    expect(
      sourceConfidence({
        id: 's',
        kind: 'stats',
        title: 'Told at close',
        via: { provider: 'stated' },
      }),
    ).toBe('stated');
  });
});

describe('autoVerifiable — what policy may accept without a person', () => {
  const of = (kind, extra = {}) => ({ id: 's', kind, url: 'https://a.test/', ...extra });

  it('accepts the structural and self-evident kinds', () => {
    for (const kind of ['video', 'photos', 'schedule', 'sessions', 'sponsors', 'other']) {
      expect(autoVerifiable(of(kind))).toBe(true);
    }
  });

  it('accepts a sponsor listing, which says nothing about the tiers on it', () => {
    // The page being real is a fact about the SOURCE. Whether a sponsor sits in
    // the right tier is a fact about the RECORD, and stays unaffected — a
    // sponsor attributed to a schedule page by fallback still reports `page`.
    expect(autoVerifiable(of('sponsors'))).toBe(true);
    const byId = new Map([['sched', { id: 'sched', kind: 'schedule', url: 'https://a.test/s' }]]);
    expect(attributionStrength({ sourceIds: ['sched'] }, byId)).toBe('page');
  });

  it('never accepts claims about people or numbers', () => {
    for (const kind of ['stats', 'community', 'venue', 'speaker']) {
      expect(autoVerifiable(of(kind))).toBe(false);
    }
  });

  it('never accepts a stated source, whatever its kind', () => {
    expect(
      autoVerifiable({
        id: 's',
        kind: 'schedule',
        title: 'Told to me',
        via: { provider: 'stated' },
      }),
    ).toBe(false);
  });

  it('never accepts a source with no url to stand behind', () => {
    expect(autoVerifiable({ id: 's', kind: 'schedule' })).toBe(false);
  });
});

describe('policy acceptance is not human verification', () => {
  it('reports a policy-accepted source as accepted, never as verified', () => {
    const source = { id: 's', kind: 'schedule', url: 'https://a.test/', verifiedAt: '2026-08-23' };
    expect(sourceConfidence({ ...source, verifiedBy: 'policy' })).toBe('accepted');
    expect(sourceConfidence({ ...source, verifiedBy: 'human' })).toBe('verified');
  });

  it('drops accepted sources off the worklist without calling them verified', () => {
    const rows = verificationRows('x.json', {
      event: {
        sources: [
          {
            id: 'sched',
            kind: 'schedule',
            url: 'http://x.test/s',
            verifiedAt: '2026-08-23',
            verifiedBy: 'policy',
          },
          { id: 'spon', kind: 'sponsors', url: 'http://x.test/sponsors' },
        ],
        sponsors: [{ sourceIds: ['spon'] }],
      },
      items: [{ sourceIds: ['sched'] }],
    });
    expect(worklist(rows).map((r) => r.id)).toEqual(['spon']);
    expect(summarise(rows).byConfidence).toMatchObject({ accepted: 1, live: 1 });
  });
});

describe('attributionStrength', () => {
  const byId = new Map([
    ['session-a', { id: 'session-a', kind: 'sessions', url: 'http://lanyrd.com/a/' }],
    ['sched', { id: 'sched', kind: 'schedule', url: 'http://lanyrd.com/schedule/' }],
  ]);

  it('is exact when the record’s own link is the source address', () => {
    expect(
      attributionStrength({ link: 'http://lanyrd.com/a/', sourceIds: ['session-a'] }, byId),
    ).toBe('exact');
  });

  it('is page-level when the record cites the schedule it came off', () => {
    expect(attributionStrength({ link: 'http://lanyrd.com/a/', sourceIds: ['sched'] }, byId)).toBe(
      'page',
    );
  });

  it('is page-level when the record has no link of its own', () => {
    expect(attributionStrength({ sourceIds: ['sched'] }, byId)).toBe('page');
  });

  it('is none when nothing is cited', () => {
    expect(attributionStrength({ link: 'http://lanyrd.com/a/' }, byId)).toBe('none');
  });
});

describe('sourceReach', () => {
  it('counts every kind of record that can cite a source', () => {
    const reach = sourceReach({
      event: {
        sourceIds: ['a'],
        attendance: { sourceIds: ['b'] },
        community: { sourceIds: ['c'], people: [{ sourceIds: ['c'] }, { sourceIds: ['c'] }] },
        sponsors: [{ sourceIds: ['a'] }],
      },
      items: [{ sourceIds: ['a'] }, { sourceIds: ['a'] }],
    });
    expect(reach.get('a')).toBe(4); // event + sponsor + 2 items
    expect(reach.get('b')).toBe(1);
    expect(reach.get('c')).toBe(3); // community + 2 people
  });
});

describe('verificationRows', () => {
  const dataset = () => ({
    event: {
      sources: [
        { id: 'sched', kind: 'schedule', url: 'http://x.test/schedule' },
        { id: 'sess-a', kind: 'sessions', url: 'http://x.test/a', capture: 'cache/a.html' },
        { id: 'done', kind: 'other', url: 'http://x.test/', verifiedAt: '2026-08-01' },
      ],
      sourceIds: ['done'],
    },
    items: [
      { title: 'a', link: 'http://x.test/a', sourceIds: ['sess-a'] },
      { title: 'b', sourceIds: ['sched'] },
      { title: 'c', sourceIds: ['sched'] },
    ],
  });

  it('separates exact citations from page-level ones', () => {
    const rows = verificationRows('x.json', dataset());
    const sess = rows.find((r) => r.id === 'sess-a');
    const sched = rows.find((r) => r.id === 'sched');
    expect(sess).toMatchObject({ reach: 1, exact: 1, confidence: 'captured' });
    expect(sched).toMatchObject({ reach: 2, exact: 0, confidence: 'live' });
  });

  it('ranks the wide, weak, unverified source above the narrow, captured one', () => {
    const rows = verificationRows('x.json', dataset());
    const list = worklist(rows);
    expect(list[0].id).toBe('sched');
    expect(list.map((r) => r.id)).not.toContain('done');
  });

  it('returns nothing for a dataset with no sources', () => {
    expect(verificationRows('x.json', { event: {}, items: [] })).toEqual([]);
  });
});

describe('summarise', () => {
  it('reports the exact share of citations, not of sources', () => {
    const rows = verificationRows('x.json', {
      event: {
        sources: [
          { id: 'sched', kind: 'schedule', url: 'http://x.test/s' },
          { id: 'a', kind: 'sessions', url: 'http://x.test/a' },
        ],
      },
      items: [
        { link: 'http://x.test/a', sourceIds: ['a'] },
        { sourceIds: ['sched'] },
        { sourceIds: ['sched'] },
        { sourceIds: ['sched'] },
      ],
    });
    const summary = summarise(rows);
    expect(summary.attributedRecords).toBe(4);
    expect(summary.exactRecords).toBe(1);
    expect(summary.exactShare).toBeCloseTo(0.25);
  });

  it('separates archive.org captures from local copies — different promises', () => {
    const rows = verificationRows('x.json', {
      event: {
        sources: [
          {
            id: 'wb',
            kind: 'schedule',
            url: 'http://gone.test/s',
            via: { provider: 'wayback', timestamp: '20130826155852', captureUrl: CAPTURE },
          },
          { id: 'local', kind: 'schedule', url: 'http://x.test/s', capture: 'cache/s.html' },
          { id: 'bare', kind: 'schedule', url: 'http://y.test/s' },
        ],
      },
      items: [],
    });
    const summary = summarise(rows);
    expect(summary.wayback).toBe(1);
    expect(summary.localCapture).toBe(1);
    expect(summary.oldestCapture).toBe('2013-08-26');
    // Both survive, so both are `captured` — the split is what tells them apart.
    expect(summary.byConfidence.captured).toBe(2);
    expect(summary.byConfidence.live).toBe(1);
  });

  it('counts undated and orphaned sources', () => {
    const rows = verificationRows('x.json', {
      event: {
        sources: [
          { id: 'cited', kind: 'schedule', url: 'http://x.test/', retrievedAt: '2026-01-01' },
          { id: 'orphan', kind: 'venue', url: 'http://x.test/v' },
        ],
        sourceIds: ['cited'],
      },
      items: [],
    });
    const summary = summarise(rows);
    expect(summary.undated).toBe(1);
    expect(summary.orphans).toBe(1);
  });
});
