import { describe, expect, it } from 'vitest';
import {
  deriveSourceId,
  isWaybackUrl,
  looksLikeUrl,
  makeSource,
  parseWaybackUrl,
  sourceFromInput,
  summarizeSources,
  validateDatasetSources,
  validateSource,
  waybackTimestampToIso,
} from '../sources.js';

// The shape actually stored in cache/wayback/*/raw/urls.json.
const CAPTURE =
  'https://web.archive.org/web/20130826155852/http://lanyrd.com/2013/drupalgov/schedule/';

describe('parseWaybackUrl', () => {
  it('splits a capture into timestamp and original url', () => {
    expect(parseWaybackUrl(CAPTURE)).toEqual({
      timestamp: '20130826155852',
      originalUrl: 'http://lanyrd.com/2013/drupalgov/schedule/',
    });
  });

  it('tolerates archive modifiers on the timestamp', () => {
    const parsed = parseWaybackUrl(
      'https://web.archive.org/web/20160101000000id_/https://a.test/x',
    );
    expect(parsed).toEqual({ timestamp: '20160101000000', originalUrl: 'https://a.test/x' });
  });

  it('accepts short timestamps', () => {
    expect(parseWaybackUrl('https://web.archive.org/web/2013/http://a.test/')?.timestamp).toBe(
      '2013',
    );
  });

  it('returns null for a live url and for non-strings', () => {
    expect(parseWaybackUrl('https://drupaljam.nl/program')).toBeNull();
    expect(parseWaybackUrl(undefined)).toBeNull();
    expect(isWaybackUrl('https://drupaljam.nl/program')).toBe(false);
  });
});

describe('waybackTimestampToIso', () => {
  it('formats a full stamp', () => {
    expect(waybackTimestampToIso('20130826155852')).toBe('2013-08-26');
  });

  it('clamps a short stamp to a real date rather than 2013-00-00', () => {
    expect(waybackTimestampToIso('2013')).toBe('2013-01-01');
    expect(waybackTimestampToIso('201308')).toBe('2013-08-01');
  });

  it('rejects nonsense', () => {
    expect(waybackTimestampToIso('nope')).toBeNull();
    expect(waybackTimestampToIso(undefined)).toBeNull();
  });
});

describe('makeSource', () => {
  it('puts the original url in url and the wrapper in via', () => {
    const source = makeSource({
      id: 'lanyrd-schedule',
      kind: 'schedule',
      url: CAPTURE,
      retrievedAt: '2026-04-28',
    });
    expect(source.url).toBe('http://lanyrd.com/2013/drupalgov/schedule/');
    expect(source.via).toEqual({
      provider: 'wayback',
      timestamp: '20130826155852',
      captureUrl: CAPTURE,
    });
  });

  it('leaves via absent for a live fetch', () => {
    const source = makeSource({
      id: 'drupaljam-program',
      kind: 'schedule',
      url: 'https://drupaljam.nl/program',
      retrievedAt: '2026-08-23',
    });
    expect(source.via).toBeUndefined();
    expect(source.url).toBe('https://drupaljam.nl/program');
  });

  it('omits empty optional fields rather than storing undefined', () => {
    expect(Object.keys(makeSource({ id: 'x', kind: 'other', url: 'https://a.test/' }))).toEqual([
      'id',
      'kind',
      'url',
    ]);
  });
});

describe('sourceFromInput — a URL if it is one, otherwise text', () => {
  it('makes a url source from a url', () => {
    const source = sourceFromInput({ value: 'https://drupal.org/x', kind: 'stats' });
    expect(source.url).toBe('https://drupal.org/x');
    expect(source.via).toBeUndefined();
  });

  it('makes a stated source from a sentence, carrying the text', () => {
    const source = sourceFromInput({
      value: 'Attendance reported by the organisers at the closing session',
      kind: 'stats',
    });
    expect(source.via).toEqual({ provider: 'stated' });
    expect(source.title).toBe('Attendance reported by the organisers at the closing session');
    expect(source.url).toBeUndefined();
    expect(validateSource(source, 0)).toEqual([]);
  });

  it('does not promote a bare host to https — that would invent a claim', () => {
    const source = sourceFromInput({ value: 'drupal.org/community', kind: 'community' });
    expect(source.via).toEqual({ provider: 'stated' });
    expect(source.url).toBeUndefined();
    expect(looksLikeUrl('drupal.org/community')).toBe(false);
  });

  it('still splits a wayback wrapper when handed one', () => {
    const source = sourceFromInput({ value: CAPTURE, kind: 'schedule' });
    expect(source.url).toBe('http://lanyrd.com/2013/drupalgov/schedule/');
    expect(source.via.provider).toBe('wayback');
  });

  it('returns null for blank input', () => {
    expect(sourceFromInput({ value: '   ', kind: 'stats' })).toBeNull();
  });

  it('derives distinct ids for two different statements', () => {
    const a = sourceFromInput({ value: 'Reported by the organisers', kind: 'stats' });
    const b = sourceFromInput({
      value: 'Counted from the badge list',
      kind: 'stats',
      taken: [a.id],
    });
    expect(a.id).not.toBe(b.id);
  });
});

describe('validateSource — stated sources', () => {
  it('rejects a stated source with no text to show', () => {
    const source = { id: 's', kind: 'stats', via: { provider: 'stated' } };
    expect(validateSource(source, 0)[0]).toMatch(/needs a title/);
  });

  it('rejects a stated source that also carries a url', () => {
    const source = {
      id: 's',
      kind: 'stats',
      title: 'Told to me',
      url: 'https://a.test/',
      via: { provider: 'stated' },
    };
    expect(validateSource(source, 0)[0]).toMatch(/carry no url/);
  });
});

describe('deriveSourceId', () => {
  it('derives a readable id from host and last path segment', () => {
    expect(deriveSourceId('https://drupaljam.nl/program/community-day', 'schedule')).toBe(
      'drupaljam-community-day',
    );
  });

  it('derives from the original url, not the wayback wrapper', () => {
    expect(deriveSourceId(CAPTURE, 'schedule')).toBe('lanyrd-schedule');
  });

  it('suffixes on collision instead of overwriting', () => {
    const first = deriveSourceId('https://drupaljam.nl/program', 'schedule');
    expect(deriveSourceId('https://drupaljam.nl/program', 'schedule', [first])).toBe(`${first}-2`);
  });

  it('falls back to the kind when there is no usable url', () => {
    expect(deriveSourceId(undefined, 'sponsors')).toBe('sponsors');
    expect(deriveSourceId('not a url', 'video')).toBe('video');
  });
});

describe('validateSource', () => {
  const valid = { id: 's', kind: 'schedule', url: 'https://a.test/', retrievedAt: '2026-01-01' };

  it('accepts a well-formed source', () => {
    expect(validateSource(valid, 0)).toEqual([]);
  });

  it('rejects an unknown kind', () => {
    expect(validateSource({ ...valid, kind: 'schedual' }, 0)[0]).toMatch(/unknown kind/);
  });

  it('accepts a missing retrievedAt — unknown is the truth for much of the archive', () => {
    expect(validateSource({ ...valid, retrievedAt: undefined }, 0)).toEqual([]);
  });

  it('rejects a retrievedAt that is present but unparseable', () => {
    expect(validateSource({ ...valid, retrievedAt: 'soon' }, 0)[0]).toMatch(/unparseable/);
  });

  it('rejects a wayback wrapper stored in url', () => {
    expect(validateSource({ ...valid, url: CAPTURE }, 0)[0]).toMatch(/Wayback wrapper/);
  });

  it('requires either a url or a via', () => {
    expect(validateSource({ id: 's', kind: 'other', retrievedAt: '2026-01-01' }, 0)[0]).toMatch(
      /needs a url or a via/,
    );
  });

  it('flags a stored timestamp that disagrees with the capture url', () => {
    const drifted = {
      ...valid,
      via: { provider: 'wayback', timestamp: '19990101000000', captureUrl: CAPTURE },
    };
    expect(validateSource(drifted, 0)[0]).toMatch(/disagrees with captureUrl/);
  });

  it('rejects an unknown via provider', () => {
    const source = { ...valid, via: { provider: 'telepathy' } };
    expect(validateSource(source, 0)[0]).toMatch(/unknown via.provider/);
  });
});

describe('validateDatasetSources', () => {
  const dataset = () => ({
    event: {
      sources: [
        { id: 'a', kind: 'schedule', url: 'https://a.test/', retrievedAt: '2026-01-01' },
        { id: 'b', kind: 'sponsors', url: 'https://b.test/', retrievedAt: '2026-01-02' },
      ],
      sponsors: [{ id: 'rtl', sourceIds: ['b'] }],
      sourceIds: ['a'],
    },
    items: [{ title: 'one', sourceIds: ['a'] }, { title: 'two' }],
  });

  it('reports a clean dataset as clean', () => {
    expect(validateDatasetSources(dataset()).problems).toEqual([]);
  });

  it('counts records with no sourceIds', () => {
    expect(validateDatasetSources(dataset()).unsourced).toEqual({
      items: 1,
      sponsors: 0,
      people: 0,
      event: false,
    });
  });

  it('catches a dangling reference — the failure that breaks nothing visible', () => {
    const d = dataset();
    d.items[0].sourceIds = ['ghost'];
    expect(validateDatasetSources(d).problems[0]).toMatch(/unknown id ghost/);
  });

  it('lists sources nothing points at', () => {
    const d = dataset();
    d.event.sponsors = [];
    expect(validateDatasetSources(d).unreferenced).toEqual(['b']);
  });

  it('catches duplicate ids', () => {
    const d = dataset();
    d.event.sources[1].id = 'a';
    expect(validateDatasetSources(d).problems.some((p) => /duplicate id a/.test(p))).toBe(true);
  });

  it('rejects a non-array sourceIds', () => {
    const d = dataset();
    d.items[1].sourceIds = 'a';
    expect(validateDatasetSources(d).problems[0]).toMatch(/not an array/);
  });

  it('reports undated sources as coverage rather than as problems', () => {
    const d = dataset();
    delete d.event.sources[0].retrievedAt;
    const result = validateDatasetSources(d);
    expect(result.problems).toEqual([]);
    expect(result.undated).toEqual(['a']);
  });

  it('treats a dataset with no sources at all as fully unsourced, not invalid', () => {
    const result = validateDatasetSources({ event: {}, items: [{ title: 'x' }] });
    expect(result.problems).toEqual([]);
    expect(result.unsourced).toEqual({ items: 1, sponsors: 0, people: 0, event: true });
  });
});

describe('summarizeSources', () => {
  it('summarises kinds, wayback use and the date range', () => {
    const summary = summarizeSources({
      event: {
        sources: [
          {
            id: 'a',
            kind: 'schedule',
            retrievedAt: '2026-04-28',
            via: { provider: 'wayback', timestamp: '20130826155852' },
          },
          { id: 'b', kind: 'schedule', retrievedAt: '2026-01-02' },
          { id: 'c', kind: 'video', retrievedAt: '2026-08-23' },
        ],
      },
    });
    expect(summary).toEqual({
      count: 3,
      kinds: { schedule: 2, video: 1 },
      wayback: true,
      stated: 0,
      oldestCapture: '2013-08-26',
      retrievedFrom: '2026-01-02',
      retrievedTo: '2026-08-23',
    });
  });

  it('handles a dataset with no sources', () => {
    expect(summarizeSources({ event: {} })).toEqual({
      count: 0,
      kinds: {},
      wayback: false,
      stated: 0,
      oldestCapture: null,
      retrievedFrom: null,
      retrievedTo: null,
    });
  });
});
