// The two trend charts rest on one pure decision — how a flat list of events
// becomes per-year stacks — and on the invariant that a key keeps the same
// height and the same colour in every bar. Everything else is SVG around that.
import { describe, it, expect } from 'vitest';
import {
  axisStep,
  stackByYear,
  stackColor,
  stackedChartSvg,
  stackedLegend,
} from '../archiveStacks.js';

const rows = (...pairs) => pairs.map(([year, key]) => ({ year, key }));
const B = { y0: 2010, y1: 2014 };

describe('stackByYear', () => {
  it('gives every year in the range a bar, including the empty ones', () => {
    // The gaps are the story — 2020 is a hole in this archive, and a chart that
    // simply omitted the year would hide it.
    const m = stackByYear(rows([2010, 'Poland'], [2014, 'Poland']), B);
    expect(m.years.map((y) => y.year)).toEqual([2010, 2011, 2012, 2013, 2014]);
    expect(m.years.map((y) => y.total)).toEqual([1, 0, 0, 0, 1]);
  });

  it('orders segments by GLOBAL total, not by each year’s own', () => {
    // This is the invariant the chart is unreadable without: a country has to
    // sit at the same height in every bar or the eye cannot track it. Here
    // Spain out-numbers Poland in 2011 alone, but Poland leads overall and so
    // must still be the bottom segment in 2011.
    const m = stackByYear(
      rows(
        [2010, 'Poland'],
        [2010, 'Poland'],
        [2010, 'Poland'],
        [2011, 'Spain'],
        [2011, 'Spain'],
        [2011, 'Poland'],
      ),
      B,
    );
    expect(m.keys.map((k) => k.key)).toEqual(['Poland', 'Spain']);
    const y2011 = m.years.find((y) => y.year === 2011);
    expect(y2011.segs.map((s) => s.key)).toEqual(['Poland', 'Spain']);
  });

  it('breaks ties by name so colours never shuffle between renders', () => {
    const a = stackByYear(rows([2010, 'Belgium'], [2010, 'Austria']), B);
    const b = stackByYear(rows([2010, 'Austria'], [2010, 'Belgium']), B);
    expect(a.keys.map((k) => k.key)).toEqual(['Austria', 'Belgium']);
    expect(a.keys).toEqual(b.keys);
  });

  it('keeps every key rather than folding a tail into "Other"', () => {
    // Eight countries in the real archive have exactly one event, and they are
    // precisely what somebody asking "who only ever managed one camp?" wants.
    const m = stackByYear(rows([2010, 'A'], [2010, 'A'], [2011, 'B'], [2012, 'C'], [2013, 'D']), B);
    expect(m.keys.map((k) => k.key)).toEqual(['A', 'B', 'C', 'D']);
    expect(m.keys.every((k) => k.key !== 'Other')).toBe(true);
  });

  it('drops events outside the axis instead of inventing a year for them', () => {
    const m = stackByYear(
      rows([2010, 'A'], [undefined, 'A'], ['', 'A'], [1999, 'A'], [2099, 'A']),
      B,
    );
    expect(m.total).toBe(1);
    expect(m.max).toBe(1);
  });

  it('names an empty key rather than dropping the event', () => {
    const m = stackByYear([{ year: 2010, key: '' }], B);
    expect(m.keys.map((k) => k.key)).toEqual(['Unknown']);
  });

  it('reports the tallest bar, which is what the axis is scaled to', () => {
    const m = stackByYear(rows([2010, 'A'], [2010, 'B'], [2011, 'A']), B);
    expect(m.max).toBe(2);
    expect(m.total).toBe(3);
  });
});

describe('stackColor', () => {
  it('is stable for an index, so a screenshot is reproducible', () => {
    expect(stackColor(3)).toBe(stackColor(3));
  });

  it('separates neighbours, which is where a stack is read', () => {
    // Golden-angle rotation: adjacent indices are ~137° apart, never adjacent
    // hues. Segment n sits directly on top of segment n-1.
    const hue = (i) => Number(stackColor(i).match(/hsl\((\d+)/)[1]);
    for (let i = 0; i < 40; i++) {
      const d = Math.abs(hue(i) - hue(i + 1));
      expect(Math.min(d, 360 - d)).toBeGreaterThan(60);
    }
  });
});

describe('axisStep', () => {
  it('picks round gridlines and never more than six of them', () => {
    for (const max of [1, 3, 7, 12, 30, 44, 120, 900]) {
      const s = axisStep(max);
      expect(max / s).toBeLessThanOrEqual(6);
      expect(s).toBeGreaterThan(0);
    }
  });
});

describe('stackedChartSvg', () => {
  const m = stackByYear(rows([2010, 'Poland'], [2010, 'Spain'], [2011, 'Poland']), B);

  it('draws one rect per segment, not per year', () => {
    expect(stackedChartSvg(m).match(/<rect/g)).toHaveLength(3);
  });

  it('stacks segments without a gap or an overlap', () => {
    // Rounding each edge independently is how stacked bars grow hairlines
    // between segments; the top of one has to be the bottom of the next.
    const svg = stackedChartSvg(m);
    const bars = [...svg.matchAll(/<rect[^>]*y="([\d.]+)"[^>]*height="([\d.]+)"[^>]*/g)].map(
      (r) => [Number(r[1]), Number(r[2])],
    );
    // SVG y grows downward, so the FIRST segment is drawn at the bottom of the
    // stack (largest y) and each next one sits above it: segment n's bottom
    // edge is segment n-1's top edge.
    const [first, second] = bars;
    expect(second[0] + second[1]).toBeCloseTo(first[0], 1);
  });

  it('gives every segment a title, so hover explains the bar', () => {
    expect(stackedChartSvg(m)).toContain('<title>2010 · Poland · 1 event</title>');
  });

  it('marks segments clickable only when a facet is offered', () => {
    expect(stackedChartSvg(m, { facet: 'country' })).toContain('data-facet="country"');
    expect(stackedChartSvg(m)).not.toContain('data-facet');
  });

  it('says so plainly when the scope is empty', () => {
    expect(stackedChartSvg(stackByYear([], B))).toContain('No events in scope');
  });

  it('escapes a key rather than letting it into the markup', () => {
    const bad = stackByYear([{ year: 2010, key: '<img src=x onerror=1>' }], B);
    const svg = stackedChartSvg(bad, { facet: 'country' });
    expect(svg).not.toContain('<img');
    expect(svg).toContain('&lt;img');
  });
});

describe('stackedLegend', () => {
  it('lists every key with its total, biggest first', () => {
    const m = stackByYear(rows([2010, 'A'], [2010, 'A'], [2011, 'B']), B);
    const html = stackedLegend(m);
    expect(html.indexOf('>A<')).toBeLessThan(html.indexOf('>B<'));
    expect(html.match(/obs-stk-key"/g) || html.match(/class="obs-stk-key"/g)).toBeTruthy();
    expect((html.match(/data-key=/g) || []).length).toBe(2);
  });

  it('uses the same colour the chart used for that key', () => {
    const m = stackByYear(rows([2010, 'A'], [2011, 'B']), B);
    expect(stackedLegend(m)).toContain(stackColor(0));
    expect(stackedChartSvg(m)).toContain(stackColor(0));
  });
});

describe('the "in progress" marking', () => {
  it('washes every year from the current one onward', () => {
    // THE BUG THIS PREVENTS: four events in the archive have not happened yet,
    // and a part-published programme has a normal session count with a
    // depressed speaker count — furniture is published first, speaker
    // assignments last. Unmarked, the final column reads as a collapse.
    const m = stackByYear(
      [
        { year: 2016, key: 'A' },
        { year: 2026, key: 'B' },
      ],
      { y0: 2007, y1: 2026 },
    );
    const svg = stackedChartSvg(m, { now: new Date('2026-09-06T00:00:00Z') });
    expect(svg).toContain('obs-stk-prov');
    // A shade with no label is just an unexplained colour.
    expect(svg).toContain('in progress');
    expect(svg).toContain('obsStkHatch');
  });

  it('says so in the tooltip of an unfinished year, not only in the wash', () => {
    const m = stackByYear([{ year: 2026, key: 'B' }], { y0: 2007, y1: 2026 });
    expect(stackedChartSvg(m, { now: new Date('2026-09-06T00:00:00Z') })).toContain(
      'year still in progress',
    );
  });

  it('leaves a finished archive unmarked', () => {
    const m = stackByYear([{ year: 2016, key: 'A' }], { y0: 2007, y1: 2020 });
    expect(stackedChartSvg(m, { now: new Date('2026-09-06T00:00:00Z') })).not.toContain(
      'obs-stk-prov',
    );
  });
});
