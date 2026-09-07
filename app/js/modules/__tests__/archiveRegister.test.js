// The register chart plots a RATE, and a rate has three ways to mislead that a
// count does not: it can be taken over too little evidence, it can be pooled so
// that one big contributor speaks for everyone, and it can be quietly indexed
// twice. These pin all three.
//
// See tools/server/internal/archive/register.go for what the measure is, what it
// deliberately is not, and the controls the underlying trend survived.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { registerRates } from '../archiveDashboard.js';

const LEX = [
  { key: 'collective', label: 'Collective voice', note: 'n' },
  { key: 'forward', label: 'Forward-looking', note: 'n' },
  { key: 'legacy', label: 'Legacy & migration', note: 'n' },
  { key: 'strain', label: 'Strain', note: 'n' },
];

/** [year, series, region, country, words, docs, counts] */
const row = (
  year,
  counts,
  words = 1000,
  series = 'DrupalCamp',
  region = 'EMEA',
  country = 'DE',
) => [year, series, region, country, words, 20, counts];

describe('registerRates', () => {
  it('takes a MEDIAN across events, not a mean', () => {
    // The whole reason this is per-event: one large DrupalCon brought 140k words
    // in 2013, and pooling a year's text lets it speak for the year. A mean has
    // the same failure in a smaller way — one outlier drags it. The median of
    // 1, 2, 30 is 2; the mean is 11.
    const rows = [row(2015, [1, 0, 0, 0]), row(2015, [2, 0, 0, 0]), row(2015, [30, 0, 0, 0])];
    const [collective] = registerRates('energy', rows, LEX);
    expect(collective.byYear[2015]).toBe(2);
  });

  it('normalises by each event’s own word count before comparing them', () => {
    // 10 hits in 1,000 words and 40 in 4,000 are the same rate. Counting hits
    // rather than rates would make the wordier event look twice as collective.
    const rows = [row(2015, [10, 0, 0, 0], 1000), row(2015, [40, 0, 0, 0], 4000)];
    const [collective] = registerRates('energy', rows, LEX);
    expect(collective.byYear[2015]).toBe(10);
  });

  it('plots a year backed by a single event', () => {
    // This used to be excluded, on the reasoning that a median of one event is
    // that event wearing a year's label. That confuses sampling error with a
    // CENSUS: DrupalSouth is one conference a year, with thousands of words
    // behind each edition, and the old floor of two events excluded all
    // thirteen of them while admitting nothing in exchange. The evidence bar
    // lives per event (see register.go), not per year.
    const [collective] = registerRates('energy', [row(2015, [9, 0, 0, 0])], LEX);
    expect(collective.byYear[2015]).toBe(9);
    expect(collective.raw[2015]).toBe(1);
  });

  it('reports how many events each year’s figure was taken over', () => {
    // A rate with no n beside it cannot be judged, so the tooltip shows it and
    // the chart rings the single-event years.
    const rows = [row(2015, [4, 0, 0, 0]), row(2015, [6, 0, 0, 0]), row(2016, [1, 0, 0, 0])];
    const [collective] = registerRates('energy', rows, LEX);
    expect(collective.raw[2015]).toBe(2);
    expect(collective.raw[2016]).toBe(1);
  });

  it('models the DrupalSouth case: one conference a year, every year plotted', () => {
    // The regression this whole change exists for. Thirteen editions, one per
    // year, each well past the per-event evidence bar — and the series was
    // completely absent from the chart.
    const years = [2010, 2014, 2015, 2016, 2017, 2018, 2019, 2021, 2022, 2023, 2024, 2025, 2026];
    const rows = years.map((y) => row(y, [120, 60, 10, 25], 6000, 'DrupalSouth'));
    const [collective, forward] = registerRates(
      'energy',
      rows,
      LEX,
      (e) => e.series === 'DrupalSouth',
    );
    expect(Object.keys(collective.byYear)).toHaveLength(years.length);
    expect(collective.byYear[2019]).toBe(20);
    expect(forward.byYear[2019]).toBe(10);
  });

  it('honours the series / region / country filter', () => {
    const rows = [
      row(2015, [10, 0, 0, 0], 1000, 'DrupalCamp'),
      row(2015, [10, 0, 0, 0], 1000, 'DrupalCamp'),
      row(2015, [90, 0, 0, 0], 1000, 'DrupalCon'),
      row(2015, [90, 0, 0, 0], 1000, 'DrupalCon'),
    ];
    const [all] = registerRates('energy', rows, LEX);
    expect(all.byYear[2015]).toBe(50);
    const [camps] = registerRates('energy', rows, LEX, (e) => e.series === 'DrupalCamp');
    expect(camps.byYear[2015]).toBe(10);
  });

  it('plots the pair each view names, in order', () => {
    const rows = [row(2015, [1, 2, 3, 4]), row(2015, [1, 2, 3, 4])];
    expect(registerRates('energy', rows, LEX).map((s) => s.key)).toEqual(['collective', 'forward']);
    expect(registerRates('headwinds', rows, LEX).map((s) => s.key)).toEqual(['legacy', 'strain']);
    // Each series reads its OWN column — an off-by-one here would silently plot
    // the wrong lexicon under the right label.
    const [legacy, strain] = registerRates('headwinds', rows, LEX);
    expect(legacy.byYear[2015]).toBe(3);
    expect(strain.byYear[2015]).toBe(4);
  });

  it('declines rather than plotting zeroes when the payload predates the measure', () => {
    // An older server payload has no lexicons. Drawing a flat zero line would
    // assert that this community never used a collective word.
    expect(registerRates('energy', [row(2015, [1, 2, 3, 4])], [])).toEqual([]);
    expect(registerRates('energy', [], LEX)).toEqual([]);
    expect(registerRates('energy', [row(2015, [1])], [{ key: 'other', label: 'Other' }])).toEqual(
      [],
    );
  });

  it('ignores rows with no year or no words rather than dividing by zero', () => {
    const rows = [
      row(0, [5, 0, 0, 0]),
      row(2015, [5, 0, 0, 0], 0),
      row(2015, [5, 0, 0, 0]),
      row(2015, [7, 0, 0, 0]),
    ];
    const [collective] = registerRates('energy', rows, LEX);
    expect(collective.byYear[2015]).toBe(6);
    expect(Number.isFinite(collective.byYear[2015])).toBe(true);
  });

  it('is unknown-view safe', () => {
    expect(registerRates('nope', [row(2015, [1, 2, 3, 4])], LEX)).toEqual([]);
  });
});

// topicChartSvg() is module-private and reads a dozen pieces of module state, so
// these pin the wiring at the source, the same way archiveStackedViews.test.js
// does. Weaker than rendering the chart; here because the alternative is nothing.
describe('the register views are wired into the chart', () => {
  const SRC = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'archiveDashboard.js'),
    'utf8',
  );

  it('styles the register pair by POSITION, not by community key', () => {
    // The bug this replaces: register lines fell through to the community
    // branch, which looks a series up in `commAll` by key. A lexicon is not in
    // commAll, so findIndex returned -1 and both lines took slot -1 — while the
    // legend, a staticLegend, swatched them as slots 0 and 1. The chart and its
    // key disagreed.
    expect(SRC).toMatch(/lengths \|\| slots \|\| sponsorTiers \|\| stacked \|\| register/);
  });

  it('does not build the population series for a register view', () => {
    // communitySeries() walks computeView(); the register views plot none of it.
    expect(SRC).toMatch(/const commAll = community && !register \? communitySeries\(\) : \[\]/);
  });

  it('keeps register out of the "% of peak" indexing', () => {
    // These are already a rate. Indexing them against their own best year would
    // scale each line to 100% and destroy the comparison the view exists for.
    expect(SRC).toMatch(/const peak = community && v === 'peak'/);
  });

  it('offers both views under the Community subject', () => {
    expect(SRC).toMatch(/\['energy', 'Energy'\]/);
    expect(SRC).toMatch(/\['headwinds', 'Headwinds'\]/);
  });

  it('rings a single-event year only where the scope has better-supported ones', () => {
    // Under a once-a-year conference every year is a census; ringing all of them
    // would say nothing, so the marker is suppressed and the caption explains.
    expect(SRC).toMatch(/const regMixed = register &&[\s\S]{0,120}some\(\(n\) => n > 1\)/);
    expect(SRC).toMatch(/const thin = regMixed && t\.raw\?\.\[y\] === 1/);
  });

  it('says plainly in the caption that this is not sentiment', () => {
    // The measure is defensible; calling it sentiment would not be. If this
    // disclaimer goes, the chart starts making a claim the data cannot support
    // — so the caption may be shortened, but not past this clause.
    expect(SRC).toMatch(/Language, not sentiment/);
  });
});
