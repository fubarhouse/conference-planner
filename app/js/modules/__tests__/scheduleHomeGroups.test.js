// The browse home splits events into what is still to come and what has already
// happened. The split has one subtlety worth pinning: a multi-day conference is
// still "upcoming" on its middle day, so the boundary is the END date, not the
// start. Getting that wrong moves a running event into Past the morning it opens.
//
// The rendering is DOM work and is not tested here; these cover the pure parts
// through the module's public render, with a stubbed document.
import { describe, it, expect, beforeEach } from 'vitest';

globalThis.document ??= {
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
};

const { initScheduleHome, __test } = await import('../scheduleHome.js');

const day = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-06-15T12:00:00Z');

function evt(over = {}) {
  return {
    file: 'events/x.json',
    category: 'drupalcamp',
    designation: 'DrupalCamp',
    location: 'Gent',
    year: '2026',
    region: 'Belgium',
    startDate: '2026-06-01T09:00:00Z',
    endDate: '2026-06-02T17:00:00Z',
    ...over,
  };
}

describe('past/upcoming boundary', () => {
  beforeEach(() => initScheduleHome({ getEvents: () => [], getDefaultFile: () => '' }));

  it('keeps a conference upcoming on its middle day', () => {
    // Runs 14–17 June; "now" is the 15th. It has started and has not finished.
    const running = evt({ startDate: '2026-06-14T09:00:00Z', endDate: '2026-06-17T17:00:00Z' });
    expect(__test.isPast(running, NOW)).toBe(false);
  });

  it('keeps a one-day event upcoming until the day is over', () => {
    const today = evt({ startDate: '2026-06-15T09:00:00Z', endDate: '2026-06-15T17:00:00Z' });
    expect(__test.isPast(today, NOW)).toBe(false);
  });

  it('moves it to past once the end date is behind us', () => {
    const finished = evt({ startDate: '2026-06-01T09:00:00Z', endDate: '2026-06-02T17:00:00Z' });
    expect(__test.isPast(finished, NOW)).toBe(true);
  });

  it('falls back to the start date when there is no end', () => {
    expect(__test.isPast(evt({ endDate: '', startDate: '2020-01-01T09:00:00Z' }), NOW)).toBe(true);
    expect(__test.isPast(evt({ endDate: '', startDate: '2030-01-01T09:00:00Z' }), NOW)).toBe(false);
  });

  it('treats an undated record as upcoming rather than ancient', () => {
    // A dataset with no dates is far more likely to be a draft than a memory,
    // and burying it at the bottom of Past is how it stays unnoticed.
    expect(__test.isPast(evt({ startDate: '', endDate: '' }), NOW)).toBe(false);
    expect(__test.isPast(evt({ startDate: 'not-a-date', endDate: '' }), NOW)).toBe(false);
  });

  it('is not fooled by a date one day either side of now', () => {
    expect(__test.isPast(evt({ endDate: new Date(NOW - 3 * day).toISOString() }), NOW)).toBe(true);
    expect(__test.isPast(evt({ endDate: new Date(NOW + day).toISOString() }), NOW)).toBe(false);
  });
});

describe('series grouping', () => {
  // An event's NAME and the series it BELONGS to are separate facts, and the
  // browse filter must group by the second while the card shows the first.
  // The mapping is a curation decision resolved into catalog.json at build
  // time — see scripts/lib/buildCatalog.js and its Go twin.
  it('groups by the resolved series, not the marketed name', () => {
    const communityDay = evt({ designation: 'DrupalSouth Community Day', series: 'DrupalSouth' });
    const downunder = evt({ designation: 'Drupal Downunder', series: 'DrupalSouth' });
    expect(__test.seriesOf(communityDay)).toBe('DrupalSouth');
    expect(__test.seriesOf(downunder)).toBe('DrupalSouth');
  });

  it('falls back to the marketed name when no mapping exists', () => {
    // The normal case for 199 of 214 events — and the ONLY case in a static
    // build, where there is no private ledger to resolve against.
    expect(__test.seriesOf(evt({ designation: 'DrupalCamp Ruhr', series: undefined }))).toBe(
      'DrupalCamp Ruhr',
    );
  });

  it('falls back again to the category when there is no designation either', () => {
    expect(__test.seriesOf({ category: 'Other' })).toBe('Other');
    expect(__test.seriesOf({})).toBe('');
  });
});
