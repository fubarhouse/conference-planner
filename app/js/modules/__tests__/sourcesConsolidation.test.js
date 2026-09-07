import { describe, expect, it } from 'vitest';

import {
  calendarFeedStatus,
  classifyUrl,
  leadingUrl,
  sessionVideosBySource,
  setCalendarFeed,
  sourceLastUsed,
  sourcesOverview,
  strayEventUrls,
} from '../sources.js';

globalThis.document ??= { getElementById: () => null, querySelector: () => null };

const { fileStray, filterSources, sortSources, triage } = await import('../editorSources.js');

const CAPTURE =
  'https://web.archive.org/web/20130826155852/http://lanyrd.com/2013/drupalgov/schedule/';

describe('sourceLastUsed — the most recent thing that says this source is good', () => {
  it('reports a capture date when that is all there is', () => {
    expect(sourceLastUsed({ via: { provider: 'wayback', timestamp: '20130826155852' } })).toEqual({
      date: '2013-08-26',
      basis: 'captured',
    });
  });

  it('prefers a later human check over an older capture', () => {
    const source = {
      via: { provider: 'wayback', timestamp: '20130826155852' },
      verifiedAt: '2026-08-30',
      verifiedBy: 'human',
    };
    expect(sourceLastUsed(source)).toEqual({ date: '2026-08-30', basis: 'verified' });
  });

  it('does not let an old check outrank a newer retrieval', () => {
    const source = { verifiedAt: '2024-01-01', retrievedAt: '2026-05-05' };
    expect(sourceLastUsed(source)).toEqual({ date: '2026-05-05', basis: 'retrieved' });
  });

  it('breaks a same-day tie in favour of the stronger claim', () => {
    const source = { verifiedAt: '2026-05-05', retrievedAt: '2026-05-05' };
    expect(sourceLastUsed(source).basis).toBe('verified');
  });

  it('accepts a datetime and reduces it to the day', () => {
    expect(sourceLastUsed({ retrievedAt: '2026-05-05T11:22:33Z' }).date).toBe('2026-05-05');
  });

  it('calls an undatable source never dated rather than guessing', () => {
    expect(sourceLastUsed({ url: 'https://a.test/' })).toEqual({ date: null, basis: 'unknown' });
    expect(sourceLastUsed({ retrievedAt: 'sometime in 2013' }).basis).toBe('unknown');
  });
});

describe('classifyUrl', () => {
  it('reads the kind off the path', () => {
    expect(classifyUrl('https://drupaljam.nl/sponsors')).toBe('sponsors');
    expect(classifyUrl('https://drupaljam.nl/program')).toBe('schedule');
    expect(classifyUrl('https://example.test/en/infos/accomodation')).toBe('venue');
    expect(classifyUrl('https://example.test/speakers')).toBe('speaker');
    expect(classifyUrl('https://example.test/')).toBe('other');
  });

  it('keeps the Association page with the organisers, not the venues', () => {
    expect(classifyUrl('https://www.drupal.org/association/drupalcon/locations')).toBe('community');
  });
});

describe('leadingUrl — attendance figures cite a URL followed by prose', () => {
  it('takes the address out of a sentence', () => {
    expect(leadingUrl("https://www.drupalcampitaly.it/2025 — the edition's own recap")).toBe(
      'https://www.drupalcampitaly.it/2025',
    );
  });

  it('leaves sentence punctuation behind', () => {
    expect(leadingUrl('https://a.test/report, as reported')).toBe('https://a.test/report');
  });

  it('returns null when the value is a person rather than a page', () => {
    expect(leadingUrl('Told to us by the organisers')).toBeNull();
  });
});

const dataset = () => ({
  event: {
    website: 'https://camp.test/',
    scheduleURLs: ['https://camp.test/programme'],
    other_urls: ['https://camp.test/sponsors', 'https://camp.test/travel'],
    community: { url: 'https://www.drupal.org/community/events/camp-2026' },
    attendance: { count: 200, source: 'https://camp.test/recap — reported at close' },
    // The artefacts the dataset points AT. These are never sources.
    videoPlaylist: 'https://youtube.com/playlist?list=x',
    flickr: { groupUrl: 'https://flickr.com/groups/camp' },
    sponsors: [{ title: 'Acme', link: 'https://acme.test/' }],
    sources: [{ id: 'camp-programme', kind: 'schedule', url: 'https://camp.test/programme' }],
  },
  items: [{ title: 'Talk', link: 'https://camp.test/s/1', sourceIds: ['camp-programme'] }],
});

describe('strayEventUrls — URLs the registry has never heard of', () => {
  it('finds the ones outside the registry and proposes a kind for each', () => {
    const strays = strayEventUrls(dataset());
    expect(strays.map((s) => [s.url, s.kind, s.mode])).toEqual([
      ['https://camp.test/sponsors', 'sponsors', 'move'],
      ['https://camp.test/travel', 'venue', 'move'],
      ['https://camp.test/', 'other', 'copy'],
      ['https://www.drupal.org/community/events/camp-2026', 'community', 'copy'],
      ['https://camp.test/recap', 'stats', 'copy'],
    ]);
  });

  it('leaves out a URL the registry already has', () => {
    const urls = strayEventUrls(dataset()).map((s) => s.url);
    expect(urls).not.toContain('https://camp.test/programme');
  });

  it('never treats recordings, photo albums, session links or sponsor links as sources', () => {
    const urls = strayEventUrls(dataset()).map((s) => s.url);
    expect(urls).not.toContain('https://youtube.com/playlist?list=x');
    expect(urls).not.toContain('https://flickr.com/groups/camp');
    expect(urls).not.toContain('https://camp.test/s/1');
    expect(urls).not.toContain('https://acme.test/');
  });

  it('reports nothing for a dataset that is not loaded', () => {
    expect(strayEventUrls(null)).toEqual([]);
  });
});

describe('fileStray — move the fields that only hold URLs, copy the ones the app reads', () => {
  it('drains other_urls, because a filed URL edited in two places drifts', () => {
    const data = dataset();
    const stray = strayEventUrls(data)[0];
    const source = fileStray(data, stray, stray.kind);
    expect(source.url).toBe('https://camp.test/sponsors');
    expect(source.kind).toBe('sponsors');
    expect(data.event.other_urls).toEqual(['https://camp.test/travel']);
  });

  it('leaves website in place, because the app links to it', () => {
    const data = dataset();
    const stray = strayEventUrls(data).find((s) => s.field === 'website');
    fileStray(data, stray, stray.kind);
    expect(data.event.website).toBe('https://camp.test/');
    expect(data.event.sources.map((s) => s.url)).toContain('https://camp.test/');
  });

  it('honours a kind the editor overrode on the row', () => {
    const data = dataset();
    const stray = strayEventUrls(data)[1];
    expect(fileStray(data, stray, 'community').kind).toBe('community');
  });

  it('files every stray without an index shifting out from under it', () => {
    const data = dataset();
    for (const stray of strayEventUrls(data)) fileStray(data, stray, stray.kind);
    expect(data.event.other_urls).toEqual([]);
    expect(strayEventUrls(data)).toEqual([]);
    expect(new Set(data.event.sources.map((s) => s.id)).size).toBe(data.event.sources.length);
  });

  it('does nothing to a dataset that is not loaded', () => {
    expect(
      fileStray(null, { url: 'https://a.test/', field: 'website', mode: 'copy' }, 'other'),
    ).toBeNull();
  });
});

describe('sourcesOverview', () => {
  it('counts what a person still owes the register', () => {
    const o = sourcesOverview(dataset());
    expect(o.total).toBe(1);
    expect(o.cited).toBe(1);
    expect(o.undated).toBe(1);
    expect(o.strays).toBe(5);
    expect(o.attention).toBeGreaterThan(0);
  });

  it('reports the span of last-used dates, capture stamps included', () => {
    const data = dataset();
    data.event.sources = [
      { id: 'a', kind: 'schedule', url: 'https://a.test/', retrievedAt: '2026-01-02' },
      {
        id: 'b',
        kind: 'sessions',
        url: 'https://b.test/',
        via: { provider: 'wayback', timestamp: '20130826155852', captureUrl: CAPTURE },
      },
    ];
    const o = sourcesOverview(data);
    expect([o.from, o.to]).toEqual(['2013-08-26', '2026-01-02']);
    expect(o.undated).toBe(0);
  });

  it('survives an event with no sources at all', () => {
    const o = sourcesOverview({ event: {} });
    expect(o).toMatchObject({ total: 0, from: null, to: null });
  });
});

const rows = [
  { id: 'sched', kind: 'schedule', url: 'https://camp.test/programme', retrievedAt: '2026-01-01' },
  { id: 'ses-1', kind: 'sessions', url: 'https://camp.test/s/1' },
  { id: 'spon', kind: 'sponsors', title: 'Told at close', via: { provider: 'stated' } },
];
const reach = new Map([
  ['sched', 40],
  ['ses-1', 1],
]);

describe('filterSources — finding one row among a hundred and sixty-nine', () => {
  it('matches on url, title and id', () => {
    const base = { kind: 'all', attentionOnly: false };
    expect(filterSources(rows, reach, { ...base, query: 'programme' })).toHaveLength(1);
    expect(filterSources(rows, reach, { ...base, query: 'told at' })).toHaveLength(1);
    expect(filterSources(rows, reach, { ...base, query: 'ses-' })).toHaveLength(1);
  });

  it('narrows to one kind', () => {
    const found = filterSources(rows, reach, { query: '', kind: 'sessions', attentionOnly: false });
    expect(found.map((r) => r.source.id)).toEqual(['ses-1']);
  });

  it('keeps the original index so edits hit the right row', () => {
    const found = filterSources(rows, reach, { query: 'spon', kind: 'all', attentionOnly: false });
    expect(found[0].index).toBe(2);
  });

  it('shows only the rows that still owe someone something', () => {
    // All three do: none carries a verification stamp, two are undated, and the
    // sponsor source is cited by nothing.
    const found = filterSources(rows, reach, { query: '', kind: 'all', attentionOnly: true });
    expect(found.map((r) => r.source.id)).toEqual(['sched', 'ses-1', 'spon']);
  });

  it('drops a row once it is dated, cited and signed off', () => {
    const done = [{ ...rows[0], verifiedAt: '2026-02-02', verifiedBy: 'human' }, ...rows.slice(1)];
    const found = filterSources(done, reach, { query: '', kind: 'all', attentionOnly: true });
    expect(found.map((r) => r.source.id)).toEqual(['ses-1', 'spon']);
  });
});

describe('sortSources', () => {
  const wrapped = rows.map((source, index) => ({ source, index }));

  it('puts the most-cited first', () => {
    expect(sortSources(wrapped, reach, 'reach')[0].source.id).toBe('sched');
  });

  it('sorts by last used and buries the undated', () => {
    const order = sortSources(wrapped, reach, 'date').map((r) => r.source.id);
    expect(order[0]).toBe('sched');
    expect(order.slice(1).sort()).toEqual(['ses-1', 'spon']);
  });

  it('leaves the list alone when grouping by kind', () => {
    expect(sortSources(wrapped, reach, 'kind').map((r) => r.source.id)).toEqual([
      'sched',
      'ses-1',
      'spon',
    ]);
  });
});

describe('triage', () => {
  it('clears a dated, cited, verified source', () => {
    const source = {
      id: 'a',
      kind: 'schedule',
      url: 'https://a.test/',
      verifiedAt: '2026-01-01',
      verifiedBy: 'human',
    };
    expect(triage(source, 5).needsWork).toBe(false);
  });

  it('flags one nothing cites', () => {
    const source = {
      id: 'a',
      kind: 'schedule',
      url: 'https://a.test/',
      verifiedAt: '2026-01-01',
      verifiedBy: 'human',
    };
    expect(triage(source, 0)).toMatchObject({ orphan: true, needsWork: true });
  });

  it('flags one nobody dated', () => {
    const source = {
      id: 'a',
      kind: 'schedule',
      url: 'https://a.test/',
      verifiedBy: 'policy',
      verifiedAt: '',
    };
    expect(triage(source, 3).undated).toBe(true);
  });
});

describe('setCalendarFeed', () => {
  it('creates the object on first use', () => {
    const event = {};
    setCalendarFeed(event, { ics: 'https://a.test/s.ics' });
    expect(event.calendarFeed).toEqual({ ics: 'https://a.test/s.ics' });
  });

  it('trims what it stores', () => {
    const event = {};
    setCalendarFeed(event, { ics: '  https://a.test/s.ics  ' });
    expect(event.calendarFeed.ics).toBe('https://a.test/s.ics');
  });

  it('keeps the fields it was not asked about', () => {
    const event = { calendarFeed: { ics: 'https://a.test/s.ics', note: 'weekly' } };
    setCalendarFeed(event, { json: 'https://a.test/s.json' });
    expect(event.calendarFeed).toEqual({
      ics: 'https://a.test/s.ics',
      note: 'weekly',
      json: 'https://a.test/s.json',
    });
  });

  it('drops a field cleared to empty rather than storing a blank', () => {
    const event = { calendarFeed: { ics: 'https://a.test/s.ics', json: 'https://a.test/s.json' } };
    setCalendarFeed(event, { json: '' });
    expect(event.calendarFeed).toEqual({ ics: 'https://a.test/s.ics' });
  });

  it('removes the object entirely once nothing is left in it', () => {
    const event = { calendarFeed: { ics: 'https://a.test/s.ics' } };
    expect(setCalendarFeed(event, { ics: '' })).toBeNull();
    expect('calendarFeed' in event).toBe(false);
  });

  it('does not let the job timestamps keep an emptied feed alive', () => {
    const event = { calendarFeed: { ics: 'https://a.test/s.ics', checkedAt: '2026-08-30' } };
    setCalendarFeed(event, { ics: '' });
    expect('calendarFeed' in event).toBe(false);
  });

  it('revokes auto-update when the feed it applied to is cleared', () => {
    const event = { calendarFeed: { ics: 'https://a.test/s.ics', autoUpdate: true, note: 'x' } };
    setCalendarFeed(event, { ics: '' });
    // A permission over a feed cannot outlive the feed: left set, it would come
    // back into force the moment somebody pasted a new address in.
    expect(event.calendarFeed).toEqual({ note: 'x' });
  });

  it('leaves nothing behind when the last field goes', () => {
    const event = { calendarFeed: { ics: 'https://a.test/s.ics', autoUpdate: true } };
    setCalendarFeed(event, { ics: '' });
    expect('calendarFeed' in event).toBe(false);
  });

  it('refuses to write the fields the job owns', () => {
    const event = { calendarFeed: { ics: 'https://a.test/s.ics' } };
    setCalendarFeed(event, { checkedAt: '2020-01-01', importedAt: '2020-01-01' });
    expect(event.calendarFeed).toEqual({ ics: 'https://a.test/s.ics' });
  });

  it('does nothing without an event', () => {
    expect(setCalendarFeed(null, { ics: 'https://a.test/s.ics' })).toBeNull();
  });
});

describe('calendarFeedStatus — what a job would do, before it does it', () => {
  it('says there is nothing to check without an ICS url', () => {
    expect(calendarFeedStatus({}).state).toBe('none');
    expect(calendarFeedStatus({ json: 'https://a.test/s.json' }).state).toBe('none');
  });

  it('reports rather than applies by default', () => {
    const s = calendarFeedStatus({ ics: 'https://a.test/s.ics' });
    expect(s.state).toBe('report');
    expect(s.message).toMatch(/reported, not applied/);
    expect(s.message).toMatch(/Never checked yet/);
  });

  it('states plainly when a job may rewrite the dataset', () => {
    const s = calendarFeedStatus({ ics: 'https://a.test/s.ics', autoUpdate: true });
    expect(s.state).toBe('auto');
    expect(s.message).toMatch(/APPLIED/);
  });

  it('carries the job timestamps into the sentence', () => {
    const s = calendarFeedStatus({
      ics: 'https://a.test/s.ics',
      checkedAt: '2026-08-30T04:00:00Z',
      importedAt: '2026-07-01T00:00:00Z',
    });
    expect(s.message).toContain('Last checked 2026-08-30');
    expect(s.message).toContain('Last import 2026-07-01');
  });
});

describe('the calendar feed joins the register without leaving its field', () => {
  const withFeed = () => {
    const data = dataset();
    data.event.calendarFeed = { ics: 'https://a.test/s.ics', json: 'https://a.test/s.json' };
    return data;
  };

  it('offers both feed urls for filing, as schedule sources that stay in place', () => {
    const feeds = strayEventUrls(withFeed()).filter((s) => s.field.startsWith('calendarFeed'));
    expect(feeds.map((s) => [s.url, s.kind, s.mode])).toEqual([
      ['https://a.test/s.ics', 'schedule', 'copy'],
      ['https://a.test/s.json', 'schedule', 'copy'],
    ]);
  });

  it('leaves the field alone when filed — the job reads the field, not the register', () => {
    const data = withFeed();
    for (const stray of strayEventUrls(data)) fileStray(data, stray, stray.kind);
    expect(data.event.calendarFeed).toEqual({
      ics: 'https://a.test/s.ics',
      json: 'https://a.test/s.json',
    });
    expect(strayEventUrls(data)).toEqual([]);
  });
});

describe('sessionVideosBySource — the recording gap, seen from the register', () => {
  const data = {
    items: [
      { title: 'A', sourceIds: ['s1'], video_url: 'https://youtu.be/a' },
      { title: 'B', sourceIds: ['s2'] },
      { title: 'C', sourceIds: ['s3'], video_url: '   ' },
      { title: 'D', sourceIds: ['s4'], video_url: 'https://youtu.be/d' },
      { title: 'E', sourceIds: ['s4'] },
    ],
  };

  it('links the recording of a session read off that page', () => {
    expect(sessionVideosBySource(data).get('s1')).toEqual({
      total: 1,
      withVideo: 1,
      url: 'https://youtu.be/a',
    });
  });

  it('reports a page whose session was never recorded', () => {
    expect(sessionVideosBySource(data).get('s2')).toEqual({ total: 1, withVideo: 0, url: null });
  });

  it('does not count whitespace as a recording', () => {
    expect(sessionVideosBySource(data).get('s3').withVideo).toBe(0);
  });

  it('counts a page cited by several sessions', () => {
    expect(sessionVideosBySource(data).get('s4')).toMatchObject({ total: 2, withVideo: 1 });
  });

  it('knows nothing about a source no item cites', () => {
    expect(sessionVideosBySource(data).get('nope')).toBeUndefined();
  });

  it('survives a dataset with no items', () => {
    expect(sessionVideosBySource({}).size).toBe(0);
  });
});
