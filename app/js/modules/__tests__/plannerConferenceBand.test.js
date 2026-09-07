import { describe, it, expect } from 'vitest';
import {
  conferenceSpanDays,
  conferenceName,
  conferenceLegendChip,
  personTicketDays,
  conferenceSpanDaysMulti,
  conferenceNamesMulti,
} from '../plannerConferenceBand.js';

describe('multi-event conference helpers', () => {
  const events = [
    {
      meta: {
        designation: 'DrupalCon',
        year: '2026',
        startDate: '2026-09-28',
        endDate: '2026-09-29',
      },
    },
    {
      meta: { designation: 'Summit', year: '2026', startDate: '2026-09-29', endDate: '2026-09-30' },
    },
  ];

  it('conferenceSpanDaysMulti unions all events days, sorted & de-duped', () => {
    expect(conferenceSpanDaysMulti(events)).toEqual(['2026-09-28', '2026-09-29', '2026-09-30']);
  });

  it('conferenceSpanDaysMulti of one event equals conferenceSpanDays of it', () => {
    expect(conferenceSpanDaysMulti([events[0]])).toEqual(conferenceSpanDays(events[0].meta));
  });

  it('conferenceNamesMulti joins distinct names with " + "', () => {
    expect(conferenceNamesMulti(events)).toBe('DrupalCon 2026 + Summit 2026');
    expect(conferenceNamesMulti([])).toBe('Conference');
  });
});

describe('personTicketDays', () => {
  const span = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01'];

  it('is empty when the person has no ticket (caller handles any fallback)', () => {
    expect([...personTicketDays('__me__', [], span)]).toEqual([]);
    expect([
      ...personTicketDays('__me__', [{ assignedTo: 'other', days: ['2026-09-28'] }], span),
    ]).toEqual([]);
  });

  it("returns a dated ticket's days UNCLAMPED (non-conference days survive)", () => {
    const tickets = [{ assignedTo: '__me__', days: ['2026-09-28', '2026-09-27'] }]; // 27th is outside span
    const set = personTicketDays('__me__', tickets, span);
    expect(set.has('2026-09-28')).toBe(true);
    expect(set.has('2026-09-27')).toBe(true); // kept, so it can be shown in a distinct colour
  });

  it('treats an undated ticket as the full conference span, and unions multiple tickets', () => {
    const tickets = [
      { assignedTo: 'm1', days: ['2026-09-28'] },
      { assignedTo: 'm1', days: ['2026-10-01'] },
    ];
    expect([...personTicketDays('m1', tickets, span)].sort()).toEqual(['2026-09-28', '2026-10-01']);
    expect([...personTicketDays('m1', [{ assignedTo: 'm1' }], span)]).toEqual(span); // undated → full
  });
});

describe('conferenceSpanDays', () => {
  it('lists the inclusive day span from the event meta', () => {
    expect(
      conferenceSpanDays({ startDate: '2026-09-28T07:00:00Z', endDate: '2026-10-01T16:00:00Z' }),
    ).toEqual(['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01']);
  });
  it('returns [] with no event / no start date', () => {
    expect(conferenceSpanDays(undefined)).toEqual([]);
    expect(conferenceSpanDays({ location: 'x' })).toEqual([]);
  });
  it('falls back to a single day when only startDate is set', () => {
    expect(conferenceSpanDays({ startDate: '2026-09-28' })).toEqual(['2026-09-28']);
  });
});

describe('conferenceName', () => {
  it('joins designation + year, else defaults', () => {
    expect(conferenceName({ designation: 'DrupalCon', year: 2026 })).toBe('DrupalCon 2026');
    expect(conferenceName({})).toBe('Conference');
  });
});

describe('conferenceLegendChip', () => {
  it('renders a named legend chip with a swatch when there is a span', () => {
    const html = conferenceLegendChip(['2026-09-28'], 'DrupalCon 2026');
    expect(html).toContain('DrupalCon 2026');
    // The chip is the product's, and the colour is a token — asserting a
    // literal hex is what tied this test to the old amber pill.
    expect(html).toContain('pl-legend__swatch');
    expect(html).toContain('var(--brand-1-ink)');
  });
  it('is empty when there is no span', () => {
    expect(conferenceLegendChip([], 'DrupalCon 2026')).toBe('');
  });
});
