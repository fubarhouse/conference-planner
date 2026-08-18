// How many people were on the programme for the FIRST time.
//
// The metric is deliberately scope-relative: filter to DrupalSouth and a "first
// time" is a first time at DrupalSouth. Archive-wide firsts shown under a filter
// would report debuts in years the filtered series never ran.
import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => {
  globalThis.document ??= {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
  };
});

const { newVsReturning, slotLengthByStatus, bracketByStatus } =
  await import('../archiveDashboard.js');

const speaker = (name, years, series = 'DrupalCon') => ({
  name,
  detail: years.map((year) => ({ year, series })),
});

describe('newVsReturning', () => {
  it('counts a debut in the first year and a return after it', () => {
    const { byYear } = newVsReturning([speaker('A', [2023, 2024, 2025])]);
    expect(byYear[2023]).toEqual({ first: 1, returning: 0 });
    expect(byYear[2024]).toEqual({ first: 0, returning: 1 });
    expect(byYear[2025]).toEqual({ first: 0, returning: 1 });
  });

  it('counts one debut however many times someone spoke that year', () => {
    const twice = { name: 'A', detail: [{ year: 2024 }, { year: 2024 }] };
    expect(newVsReturning([twice]).byYear[2024]).toEqual({ first: 1, returning: 0 });
  });

  it('adds people up across a year', () => {
    const { byYear } = newVsReturning([
      speaker('A', [2023, 2024]),
      speaker('B', [2024]),
      speaker('C', [2024]),
    ]);
    expect(byYear[2024]).toEqual({ first: 2, returning: 1 });
  });

  it('is scope-relative: a first time WITHIN the filter', () => {
    // Spoke at DrupalCon in 2019, then DrupalSouth in 2024. Filtered to
    // DrupalSouth, 2024 is their first — because that is the question being asked.
    const person = {
      name: 'A',
      detail: [
        { year: 2019, series: 'DrupalCon' },
        { year: 2024, series: 'DrupalSouth' },
      ],
    };
    const all = newVsReturning([person]).byYear;
    expect(all[2019]).toEqual({ first: 1, returning: 0 });
    expect(all[2024]).toEqual({ first: 0, returning: 1 });

    const south = newVsReturning([person], (e) => e.series === 'DrupalSouth').byYear;
    expect(south[2024]).toEqual({ first: 1, returning: 0 });
    expect(south[2019]).toBeUndefined();
  });

  it('ignores rows with no year rather than bucketing them at zero', () => {
    const messy = { name: 'A', detail: [{ year: null }, { year: 2024 }] };
    expect(newVsReturning([messy]).byYear).toEqual({ 2024: { first: 1, returning: 0 } });
  });

  it('is exhaustive: the two halves are the whole cast, so shares reach 100%', () => {
    // The guarantee the Share % view rests on. It held in the metric all along —
    // what did not was the tooltip, which divided by that year's SESSIONS instead
    // of its cast and reported 55% + 43% = 98.3%.
    const { byYear } = newVsReturning([
      speaker('A', [2023, 2024]),
      speaker('B', [2024]),
      speaker('C', [2024]),
      speaker('D', [2024, 2025]),
    ]);
    const { first, returning } = byYear[2024];
    expect(first + returning).toBe(4); // every speaker active in 2024, counted once
    expect((first / (first + returning)) * 100 + (returning / (first + returning)) * 100).toBe(100);
  });

  it('survives empty input', () => {
    expect(newVsReturning([]).byYear).toEqual({});
    expect(newVsReturning(null).byYear).toEqual({});
    expect(newVsReturning([{ name: 'A' }]).byYear).toEqual({});
  });
});

describe('newVsReturning on a non-speaker population', () => {
  it('answers sponsor loyalty from the same shape', () => {
    // Sponsors carry the same per-event detail rows, so "was this their first
    // year?" is the same question asked of organisations. They were briefly a
    // fifth line on the population chart, which was a category error: one company
    // backing three events is not three of anything a headcount measures.
    const sponsors = [
      { title: 'Acquia', detail: [{ year: 2023 }, { year: 2024 }] },
      { title: 'Newco', detail: [{ year: 2024 }] },
    ];
    const { byYear } = newVsReturning(sponsors);
    expect(byYear[2023]).toEqual({ first: 1, returning: 0 });
    expect(byYear[2024]).toEqual({ first: 1, returning: 1 });
  });
});

describe('slotLengthByStatus', () => {
  const at = (year, n, minutes, series = 'DrupalCon') => ({ year, n, minutes, series });

  it('averages over SLOTS, not people', () => {
    // One speaker, two sessions that year: 60 + 30 over two slots = 45.
    const s = { name: 'A', detail: [at(2024, 2, 90)] };
    expect(slotLengthByStatus([s])[2024].first).toBe(45);
  });

  it('splits a year by whether it was that speaker’s first', () => {
    const rows = slotLengthByStatus([
      { name: 'A', detail: [at(2023, 1, 60), at(2024, 1, 30)] }, // returning in 2024
      { name: 'B', detail: [at(2024, 1, 90)] }, // first in 2024
    ]);
    expect(rows[2024]).toEqual({ first: 90, returning: 30 });
  });

  it('ignores sessions with no recorded duration instead of scoring them zero', () => {
    // A 0 here would read as "much shorter talks that year", which is a claim the
    // data does not support — it only says the length was never recorded.
    const s = { name: 'A', detail: [at(2024, 1, 60), at(2024, 3, 0)] };
    expect(slotLengthByStatus([s])[2024].first).toBe(60);
  });

  it('reports 0 for a group with nothing in it, not NaN', () => {
    const rows = slotLengthByStatus([{ name: 'A', detail: [at(2024, 1, 60)] }]);
    expect(rows[2024].returning).toBe(0);
  });

  it('honours the scope when deciding what counts as a first year', () => {
    const person = {
      name: 'A',
      detail: [at(2019, 1, 60, 'DrupalCon'), at(2024, 1, 30, 'DrupalSouth')],
    };
    const south = slotLengthByStatus([person], (e) => e.series === 'DrupalSouth');
    expect(south[2024]).toEqual({ first: 30, returning: 0 });
  });

  it('survives empty input', () => {
    expect(slotLengthByStatus([])).toEqual({});
    expect(slotLengthByStatus(null)).toEqual({});
  });
});

describe('bracketByStatus', () => {
  const at = (year, lengths, series = 'DrupalCon') => ({ year, lengths, series });

  it('splits each bracket by whether it was the speaker’s first year', () => {
    const rows = bracketByStatus([
      { name: 'A', detail: [at(2023, { hour: 1 }), at(2024, { hour: 2, short: 1 })] },
      { name: 'B', detail: [at(2024, { hour: 1 })] },
    ]);
    expect(rows[2023].hour).toEqual({ first: 1, returning: 0 });
    expect(rows[2024].hour).toEqual({ first: 1, returning: 2 });
    expect(rows[2024].short).toEqual({ first: 0, returning: 1 });
  });

  it('counts slots, so two hour-slots at one event are two', () => {
    const rows = bracketByStatus([{ name: 'A', detail: [at(2024, { hour: 2 })] }]);
    expect(rows[2024].hour.first).toBe(2);
  });

  it('leaves a bracket out entirely rather than reporting it as zero', () => {
    const rows = bracketByStatus([{ name: 'A', detail: [at(2024, { hour: 1 })] }]);
    expect(rows[2024].lightning).toBeUndefined();
  });

  it('is scope-relative, like the other two', () => {
    const person = {
      name: 'A',
      detail: [at(2019, { hour: 1 }, 'DrupalCon'), at(2024, { short: 1 }, 'DrupalSouth')],
    };
    const south = bracketByStatus([person], (e) => e.series === 'DrupalSouth');
    expect(south[2024].short).toEqual({ first: 1, returning: 0 });
  });

  it('omits a year entirely when no length was recorded in it', () => {
    // Not `{2024: {}}` — an empty year would draw a panel row of zeros and claim
    // the sessions were short, when the truth is that nobody recorded a duration.
    expect(bracketByStatus([{ name: 'A', detail: [{ year: 2024, n: 1 }] }])).toEqual({});
    expect(bracketByStatus([])).toEqual({});
  });
});
