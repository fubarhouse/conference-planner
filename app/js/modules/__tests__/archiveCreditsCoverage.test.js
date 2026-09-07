// The credits coverage line has to be counted in the SAME scope as the ranking
// it sits above. It used to read the archive-wide pair straight off the payload,
// so filtering to DrupalSouth left "credits captured for 28 of 84 events" over a
// list built from 4 DrupalSouth events out of 16.
import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => {
  globalThis.document ??= {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
  };
});

const { creditsCoverage } = await import('../archiveDashboard.js');

const events = [
  { file: 'a.json', series: 'DrupalSouth', year: 2024 },
  { file: 'b.json', series: 'DrupalSouth', year: 2025 },
  { file: 'c.json', series: 'DrupalCon', year: 2025 },
];
const people = [
  {
    username: 'davesparks',
    role: 'organiser',
    detail: [{ file: 'a.json', series: 'DrupalSouth', year: 2024 }],
  },
  {
    username: 'davesparks',
    role: 'volunteer',
    detail: [{ file: 'a.json', series: 'DrupalSouth', year: 2024 }],
  },
  {
    username: 'jct321',
    role: 'organiser',
    detail: [{ file: 'c.json', series: 'DrupalCon', year: 2025 }],
  },
];

describe('creditsCoverage', () => {
  it('counts the whole archive when nothing is filtered', () => {
    expect(creditsCoverage({ events, people })).toEqual({ withCredits: 2, events: 3 });
  });

  it('counts an event once however many roles were credited at it', () => {
    // davesparks organised AND volunteered at a.json. That is one credited event.
    const ds = creditsCoverage({ events, people, inScope: (e) => e.series === 'DrupalSouth' });
    expect(ds).toEqual({ withCredits: 1, events: 2 });
  });

  it('narrows to the active facet', () => {
    expect(creditsCoverage({ events, people, inScope: (e) => e.series === 'DrupalCon' })).toEqual({
      withCredits: 1,
      events: 1,
    });
  });

  it('reports an honest zero for a scope with no credits captured', () => {
    expect(creditsCoverage({ events, people, inScope: (e) => e.year === 2025 })).toEqual({
      withCredits: 1,
      events: 2,
    });
    expect(creditsCoverage({ events, people, inScope: () => false })).toEqual({
      withCredits: 0,
      events: 0,
    });
  });

  it('survives missing data rather than throwing mid-render', () => {
    expect(creditsCoverage({})).toEqual({ withCredits: 0, events: 0 });
    expect(creditsCoverage({ events: null, people: [{ detail: null }] })).toEqual({
      withCredits: 0,
      events: 0,
    });
  });
});
