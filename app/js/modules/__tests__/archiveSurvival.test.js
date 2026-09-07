// "What survives" is three readings over one year axis, and the only thing that
// can go wrong quietly is the scaling: a count row and a percentage row share a
// column idiom but not a maximum, and a year with no programme must not be
// drawn as a full bar.
import { describe, it, expect } from 'vitest';
import { survivalChart, canShowSurvival } from '../archiveDashboard.js';

/** @param {object} over */
const year = (over) => ({
  year: 2016,
  events: 3,
  sessions: 100,
  described: 90,
  videos: 40,
  albums: 2,
  ...over,
});

describe('survivalChart', () => {
  it('shows description coverage as a share, not a count', () => {
    const html = survivalChart([year({ sessions: 200, described: 50 })]);
    expect(html).toContain('>25%<');
    // The count belongs in the tooltip, where the denominator is visible.
    expect(html).toContain('50 of 200 sessions described');
  });

  it('scales each row to its own maximum, so galleries stay visible beside sessions', () => {
    // One year with 9904 sessions and 2 albums: on a shared scale the album bar
    // would round to nothing. Each row is scaled independently, so the only
    // album year is a full-height bar in its own row.
    const html = survivalChart([
      year({ year: 2015, sessions: 9904, described: 9000, videos: 4000, albums: 0 }),
      year({ year: 2016, sessions: 10, described: 5, videos: 1, albums: 2 }),
    ]);
    const albumBars = [...html.matchAll(/obs-ybar--albums" style="height:([\d.]+)%/g)].map((m) =>
      Number(m[1]),
    );
    expect(albumBars).toEqual([2, 100]);
  });

  it('draws an empty year as an empty column rather than a full one', () => {
    // 0/0 sessions must not become NaN or 100%.
    const html = survivalChart([
      year({ year: 2021, events: 0, sessions: 0, described: 0, videos: 0, albums: 0 }),
    ]);
    expect(html).toContain('obs-ycol--empty');
    expect(html).not.toContain('NaN');
    expect(html).toContain('height:2%');
  });

  it('does not offer a drill into a year the archive has nothing for', () => {
    const empty = survivalChart([
      year({ events: 0, sessions: 0, described: 0, videos: 0, albums: 0 }),
    ]);
    expect(empty).not.toContain('data-drill');
    const full = survivalChart([year({})]);
    expect(full).toContain('data-drill="year"');
  });

  it('reports all three figures in every tooltip, so a year reads across', () => {
    const html = survivalChart([year({ videos: 0, albums: 1 })]);
    expect(html).toContain('90 of 100 sessions described · 0 recordings · 1 gallery');
  });

  it('pluralises the gallery count', () => {
    expect(survivalChart([year({ albums: 3 })])).toContain('3 galleries');
    expect(survivalChart([year({ albums: 1 })])).toContain('1 gallery');
  });
});

// The faceted path is a separate summation: the payload's year totals are
// archive-wide, so under a series or region filter the three figures have to be
// re-derived from the in-scope events or the chart reports the whole archive.
describe('survivalChart under a facet', () => {
  it('reads the re-summed year rows, not the archive-wide ones', () => {
    // What computeView() produces for a filtered scope: same shape, smaller
    // numbers. If the chart were reading the payload's totals it would draw the
    // unfiltered figures here.
    const scoped = [{ year: 2016, events: 1, sessions: 20, described: 10, videos: 4, albums: 1 }];
    const html = survivalChart(scoped);
    expect(html).toContain('>50%<');
    expect(html).toContain('10 of 20 sessions described · 4 recordings · 1 gallery');
  });

  it('survives a scope with events but no programme', () => {
    // An event whose sessions were never recorded: real event, nothing to show.
    const html = survivalChart([
      { year: 2016, events: 2, sessions: 0, described: 0, videos: 0, albums: 1 },
    ]);
    expect(html).not.toContain('NaN');
    expect(html).toContain('0 of 0 sessions described');
    // The gallery is still real and still counted.
    expect(html).toContain('1 gallery');
  });
});

// A payload older than these fields can answer nothing, and must not be allowed
// to answer zero. This is the difference between "no recordings that year" and
// "this server cannot tell you", and only the second is a reason to hide the
// chart.
describe('canShowSurvival', () => {
  it('accepts rows that carry the fields, including genuine zeros', () => {
    expect(canShowSurvival([{ year: 2007, sessions: 90, described: 0, videos: 0 }])).toBe(true);
  });

  it('rejects rows from a payload that predates them', () => {
    // What an older server's yearEvents rows sum to: sessions but no survival.
    expect(canShowSurvival([{ year: 2016, events: 15, sessions: 693 }])).toBe(false);
    expect(canShowSurvival([])).toBe(false);
    expect(canShowSurvival(undefined)).toBe(false);
  });

  it('rejects a half-answer rather than drawing it', () => {
    // described present, videos absent — the row cannot fill the chart.
    expect(canShowSurvival([{ year: 2016, sessions: 10, described: 5 }])).toBe(false);
  });
});
