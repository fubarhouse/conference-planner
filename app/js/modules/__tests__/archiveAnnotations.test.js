import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  annotationColor,
  annotationMarks,
  annotationsByYear,
  annotationsInSpan,
  nextColor,
  PALETTE_SIZE,
  getAnnotation,
  listAnnotations,
  normaliseAnnotation,
  removeAnnotation,
  saveAnnotation,
  toggleAnnotation,
  yearPos,
  yearRangeLabel,
  MAX_LABEL,
  MAX_NOTE,
} from '../archiveAnnotations.js';

// Node env, no jsdom: a Map standing in for localStorage is the whole of what
// the module touches, and the CustomEvent dispatch is guarded on `document`.
function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
    _map: map,
  };
}

beforeEach(() => {
  globalThis.localStorage = fakeStorage();
});

describe('normaliseAnnotation', () => {
  it('defaults a missing end year to the start year', () => {
    expect(normaliseAnnotation({ label: 'COVID', from: 2020 })).toMatchObject({
      from: 2020,
      to: 2020,
    });
  });

  it('accepts a range entered backwards', () => {
    expect(normaliseAnnotation({ label: 'x', from: 2021, to: 2019 })).toMatchObject({
      from: 2019,
      to: 2021,
    });
  });

  it('refuses a note with no label', () => {
    expect(normaliseAnnotation({ label: '   ', from: 2020 })).toBeNull();
  });

  it('refuses a year that is not one', () => {
    expect(normaliseAnnotation({ label: 'x', from: 'soon' })).toBeNull();
    expect(normaliseAnnotation({ label: 'x', from: 202 })).toBeNull();
    expect(normaliseAnnotation({ label: 'x', from: 20200 })).toBeNull();
  });

  it('truncates rather than refusing over-long text', () => {
    const a = normaliseAnnotation({ label: 'l'.repeat(200), from: 2020, note: 'n'.repeat(900) });
    expect(a.label).toHaveLength(MAX_LABEL);
    expect(a.note).toHaveLength(MAX_NOTE);
  });

  it('mints an id when there is none', () => {
    expect(normaliseAnnotation({ label: 'x', from: 2020 }).id).toBeTruthy();
  });
});

describe('the store', () => {
  it('round-trips a note and keeps the list in year order', () => {
    saveAnnotation({ label: 'Later', from: 2022 });
    saveAnnotation({ label: 'COVID', from: 2020, to: 2021, note: 'The years it stopped.' });
    expect(listAnnotations().map((a) => a.label)).toEqual(['COVID', 'Later']);
  });

  it('updates in place when the id already exists', () => {
    const a = saveAnnotation({ label: 'COVID', from: 2020 });
    saveAnnotation({ id: a.id, label: 'COVID-19', from: 2020, to: 2021 });
    const list = listAnnotations();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ label: 'COVID-19', to: 2021 });
  });

  it('reports whether a delete removed anything', () => {
    const a = saveAnnotation({ label: 'x', from: 2020 });
    expect(removeAnnotation('nope')).toBe(false);
    expect(removeAnnotation(a.id)).toBe(true);
    expect(listAnnotations()).toEqual([]);
    expect(getAnnotation(a.id)).toBeNull();
  });

  it('returns null for input it will not store', () => {
    expect(saveAnnotation({ label: '', from: 2020 })).toBeNull();
    expect(listAnnotations()).toEqual([]);
  });

  // A corrupt entry must cost that one note, not the whole list.
  it('drops unusable rows and keeps the rest', () => {
    globalThis.localStorage.setItem(
      'archive.annotations.v1',
      JSON.stringify([{ label: 'good', from: 2020 }, { from: 2019 }, null, 'nope']),
    );
    expect(listAnnotations().map((a) => a.label)).toEqual(['good']);
  });

  it('survives storage holding something that is not a list', () => {
    globalThis.localStorage.setItem('archive.annotations.v1', '{"nope":true}');
    expect(listAnnotations()).toEqual([]);
    globalThis.localStorage.setItem('archive.annotations.v1', 'not json');
    expect(listAnnotations()).toEqual([]);
  });

  it('does not throw when there is no storage at all', () => {
    // @ts-expect-error deliberately removing the API
    delete globalThis.localStorage;
    expect(listAnnotations()).toEqual([]);
    expect(saveAnnotation({ label: 'x', from: 2020 })).toBeNull();
  });

  it('announces every mutation once', () => {
    const dispatch = vi.fn();
    globalThis.document = { dispatchEvent: dispatch };
    saveAnnotation({ label: 'x', from: 2020 });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0].type).toBe('archive:annotations');
    delete globalThis.document;
  });
});

describe('colour', () => {
  it('resolves a slot to the shared scale, and anything else to the neutral', () => {
    expect(annotationColor({ color: 0 })).toBe('var(--viz-1)');
    expect(annotationColor({ color: PALETTE_SIZE - 1 })).toBe(`var(--viz-${PALETTE_SIZE})`);
    expect(annotationColor({ color: null })).toBe('var(--viz-overflow)');
    expect(annotationColor({ color: PALETTE_SIZE })).toBe('var(--viz-overflow)');
    expect(annotationColor()).toBe('var(--viz-overflow)');
  });

  it('takes the lowest free slot, so deleting one does not repaint the rest', () => {
    expect(nextColor([])).toBe(0);
    expect(nextColor([{ color: 0 }, { color: 2 }])).toBe(1);
  });

  it('falls back to the neutral once the scale is exhausted', () => {
    const full = Array.from({ length: PALETTE_SIZE }, (_, i) => ({ color: i }));
    expect(nextColor(full)).toBeNull();
  });

  it('assigns a colour on create and keeps it across an edit', () => {
    const a = saveAnnotation({ label: 'COVID', from: 2020 });
    expect(a.color).toBe(0);
    const b = saveAnnotation({ label: 'Later', from: 2024 });
    expect(b.color).toBe(1);
    // An edit that carries no colour must not re-derive one.
    const edited = saveAnnotation({ id: b.id, label: 'Later still', from: 2024 });
    expect(edited.color).toBe(1);
  });

  it('honours a colour the reader picked', () => {
    // FormData hands numbers over as strings.
    expect(saveAnnotation({ label: 'x', from: 2020, color: '7' }).color).toBe(7);
  });

  it('keeps the freed slot available after a delete', () => {
    const a = saveAnnotation({ label: 'one', from: 2020 });
    saveAnnotation({ label: 'two', from: 2021 });
    removeAnnotation(a.id);
    expect(nextColor()).toBe(0);
    // …and the survivor kept its own.
    expect(listAnnotations()[0].color).toBe(1);
  });

  it('gives a note stored before colour existed the neutral, not a crash', () => {
    globalThis.localStorage.setItem(
      'archive.annotations.v1',
      JSON.stringify([{ id: 'old', from: 2020, to: 2020, label: 'legacy', note: '' }]),
    );
    const [a] = listAnnotations();
    expect(a.color).toBeNull();
    expect(annotationColor(a)).toBe('var(--viz-overflow)');
  });
});

describe('visibility', () => {
  it('defaults to shown', () => {
    expect(saveAnnotation({ label: 'x', from: 2020 }).hidden).toBe(false);
  });

  it('flips, persists, and reports the new state', () => {
    const a = saveAnnotation({ label: 'x', from: 2020 });
    expect(toggleAnnotation(a.id)).toBe(true);
    expect(getAnnotation(a.id).hidden).toBe(true);
    expect(toggleAnnotation(a.id)).toBe(false);
    expect(getAnnotation(a.id).hidden).toBe(false);
  });

  it('says so when there is no such note', () => {
    expect(toggleAnnotation('nope')).toBeNull();
  });

  // Hiding is not deleting.
  it('keeps a hidden note in the rail’s list and out of the charts', () => {
    const a = saveAnnotation({ label: 'x', from: 2020, note: 'still here' });
    toggleAnnotation(a.id);
    expect(listAnnotations()).toHaveLength(1);
    expect(listAnnotations()[0].note).toBe('still here');
    expect(annotationsInSpan(2000, 2030)).toEqual([]);
    expect(annotationsByYear().size).toBe(0);
  });

  it('survives an edit without being switched back on', () => {
    const a = saveAnnotation({ label: 'x', from: 2020 });
    toggleAnnotation(a.id);
    const edited = saveAnnotation({ ...getAnnotation(a.id), label: 'renamed' });
    expect(edited.hidden).toBe(true);
  });

  // The form sends a checkbox as the string "on".
  it('reads the form’s own truthiness', () => {
    expect(normaliseAnnotation({ label: 'x', from: 2020, hidden: 'on' }).hidden).toBe(true);
    expect(normaliseAnnotation({ label: 'x', from: 2020, hidden: 'true' }).hidden).toBe(true);
    expect(normaliseAnnotation({ label: 'x', from: 2020, hidden: undefined }).hidden).toBe(false);
  });
});

describe('annotationsInSpan', () => {
  const list = [
    { id: 'a', from: 2019, to: 2022, label: 'wide', note: '' },
    { id: 'b', from: 2005, to: 2006, label: 'before', note: '' },
    { id: 'c', from: 2021, to: 2021, label: 'point', note: '' },
  ];

  it('clips to the plotted span rather than dropping the note', () => {
    const rows = annotationsInSpan(2020, 2021, list);
    expect(rows.map((r) => r.label)).toEqual(['wide', 'point']);
    expect(rows[0]).toMatchObject({ from: 2020, to: 2021, clipped: true });
    expect(rows[1].clipped).toBe(false);
  });

  it('drops notes wholly outside the span', () => {
    expect(annotationsInSpan(2020, 2026, list).map((r) => r.id)).toEqual(['a', 'c']);
  });
});

describe('yearRangeLabel', () => {
  it('says one year as one year', () => {
    expect(yearRangeLabel({ from: 2020, to: 2020 })).toBe('2020');
    expect(yearRangeLabel({ from: 2020, to: 2021 })).toBe('2020–2021');
  });
});

// The sources trend plots years by INDEX into a list that skips empty years, so
// a year between two entries has no index of its own.
describe('yearPos', () => {
  const years = [2016, 2019, 2022];

  it('returns the exact index for a year that is plotted', () => {
    expect(yearPos(years, 2016)).toBe(0);
    expect(yearPos(years, 2019)).toBe(1);
    expect(yearPos(years, 2022)).toBe(2);
  });

  it('interpolates a year that fell in a gap', () => {
    expect(yearPos(years, 2020)).toBeCloseTo(1 + 1 / 3, 5);
    expect(yearPos(years, 2021)).toBeCloseTo(1 + 2 / 3, 5);
  });

  it('clamps outside the list', () => {
    expect(yearPos(years, 1990)).toBe(0);
    expect(yearPos(years, 2099)).toBe(2);
    expect(yearPos([], 2020)).toBe(0);
  });
});

describe('annotationMarks', () => {
  const opts = { x: (y) => (y - 2000) * 10, top: 0, bottom: 100, min: 2000, max: 2030 };

  it('draws nothing when there is nothing to draw', () => {
    expect(annotationMarks({ ...opts, list: [] })).toBe('');
  });

  it('draws a band and two rules for a range', () => {
    const svg = annotationMarks({
      ...opts,
      list: [{ id: 'a', from: 2020, to: 2021, label: 'COVID', note: 'stopped', color: 2 }],
    });
    expect(svg).toContain('<rect class="obs-ann-band" x="200.0"');
    expect(svg).toContain('width="10.0"');
    expect(svg.match(/obs-ann-rule/g)).toHaveLength(2);
    expect(svg).toContain('COVID · 2020–2021 — stopped');
  });

  it('paints the band and both rules in the note’s own hue', () => {
    const svg = annotationMarks({
      ...opts,
      list: [{ id: 'a', from: 2020, to: 2021, label: 'x', note: '', color: 4 }],
    });
    expect(svg.match(/fill:var\(--viz-5\)/g)).toHaveLength(1);
    expect(svg.match(/stroke:var\(--viz-5\)/g)).toHaveLength(2);
  });

  // The words live in the tooltip now; the plot carries no text at all.
  it('puts no text on the plot', () => {
    const svg = annotationMarks({
      ...opts,
      list: [{ id: 'a', from: 2020, to: 2021, label: 'COVID', note: 'stopped', color: 4 }],
    });
    expect(svg).not.toContain('<text');
  });

  it('still names the note for assistive tech and native hover', () => {
    const svg = annotationMarks({
      ...opts,
      list: [{ id: 'a', from: 2020, to: 2021, label: 'COVID', note: 'stopped', color: 4 }],
    });
    expect(svg).toContain('role="img"');
    expect(svg).toContain('aria-label="Note: COVID · 2020–2021 — stopped"');
    expect(svg).toContain('<title>COVID · 2020–2021 — stopped</title>');
  });

  it('gives a colourless note the neutral rather than no fill at all', () => {
    const svg = annotationMarks({
      ...opts,
      list: [{ id: 'a', from: 2020, to: 2021, label: 'x', note: '', color: null }],
    });
    expect(svg).toContain('fill:var(--viz-overflow)');
  });

  it('draws a single rule and no band for one year', () => {
    const svg = annotationMarks({
      ...opts,
      list: [{ id: 'a', from: 2020, to: 2020, label: 'x', note: '' }],
    });
    expect(svg).not.toContain('obs-ann-band');
    expect(svg.match(/obs-ann-rule/g)).toHaveLength(1);
  });

  it('draws nothing for a note that is switched off', () => {
    const list = [
      { id: 'a', from: 2020, to: 2021, label: 'off', note: '', hidden: true },
      { id: 'b', from: 2024, to: 2024, label: 'on', note: '' },
    ];
    const svg = annotationMarks({ ...opts, list });
    expect(svg).not.toContain('off');
    expect(svg).toContain('on');
    expect(svg.match(/obs-ann-rule/g)).toHaveLength(1);
  });

  it('escapes what the reader typed', () => {
    const svg = annotationMarks({
      ...opts,
      list: [{ id: 'a', from: 2020, to: 2020, label: '<script>x</script>', note: '"q"' }],
    });
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
  });

  it('draws nothing into a box with no height', () => {
    const list = [{ id: 'a', from: 2020, to: 2021, label: 'x', note: '' }];
    expect(annotationMarks({ ...opts, bottom: 0, list })).toBe('');
  });
});

describe('annotationsByYear', () => {
  it('expands a range into every year it covers', () => {
    const map = annotationsByYear([{ id: 'a', from: 2020, to: 2022, label: 'x', note: '' }]);
    expect([...map.keys()]).toEqual([2020, 2021, 2022]);
    expect(map.get(2021)[0].label).toBe('x');
  });

  it('collects two notes on the same year', () => {
    const map = annotationsByYear([
      { id: 'a', from: 2020, to: 2020, label: 'one', note: '' },
      { id: 'b', from: 2019, to: 2021, label: 'two', note: '' },
    ]);
    expect(map.get(2020).map((a) => a.label)).toEqual(['one', 'two']);
  });
});
