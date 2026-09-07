// Item kind and cancellation.
//
// `track` says what an item is ABOUT; `kind` says what it IS. The two must stay
// apart — a "Social" track would put the pub quiz into the topic vocabulary and
// the track filter, which is the failure sessionKind.js exists to prevent. And
// `cancelled` is orthogonal to both: a cancelled workshop is still a workshop.
//
// Node env, no jsdom — these are pure functions.
import { describe, it, expect } from 'vitest';
import { itemKind, isCancelled, countsAsSession } from '../sessionKind.js';

describe('itemKind', () => {
  it('defaults to session, and reads the four kinds', () => {
    expect(itemKind({ title: 'Keynote' })).toBe('session');
    for (const k of ['session', 'workshop', 'social', 'agenda']) {
      expect(itemKind({ title: 'x', kind: k })).toBe(k);
    }
  });

  it('ignores a kind it does not recognise rather than trusting it', () => {
    // A typo must not silently become a new category.
    expect(itemKind({ title: 'Keynote', kind: 'workshopp' })).toBe('session');
    expect(itemKind({ title: 'Lunch', kind: 'nonsense' })).toBe('agenda');
  });

  it('accepts kind case-insensitively', () => {
    expect(itemKind({ title: 'x', kind: 'Workshop' })).toBe('workshop');
    expect(itemKind({ title: 'x', kind: 'SOCIAL' })).toBe('social');
  });

  it('honours the older isAgendaItem spelling in BOTH directions', () => {
    // Most of the archive predates `kind`; it must keep working.
    expect(itemKind({ title: 'Anything', isAgendaItem: true })).toBe('agenda');
    expect(itemKind({ title: 'Lunch', isAgendaItem: false })).toBe('session');
  });

  it('lets kind win over isAgendaItem when both are set', () => {
    expect(itemKind({ title: 'Sprint', kind: 'workshop', isAgendaItem: true })).toBe('workshop');
  });

  it('falls back to the title heuristic when nothing is declared', () => {
    expect(itemKind({ title: 'Morning Tea' })).toBe('agenda');
    expect(itemKind({ title: 'Rethinking Event Registration' })).toBe('session');
  });
});

describe('countsAsSession', () => {
  it('counts talks and workshops as programme', () => {
    // A sprint or a summit is real content someone turned up for.
    expect(countsAsSession({ kind: 'session' })).toBe(true);
    expect(countsAsSession({ kind: 'workshop' })).toBe(true);
  });

  it('does not count social events or logistics', () => {
    // They belong on the schedule, but counting them inflates every total.
    expect(countsAsSession({ kind: 'social' })).toBe(false);
    expect(countsAsSession({ kind: 'agenda' })).toBe(false);
  });

  it('never counts a cancelled item, whatever its kind', () => {
    for (const k of ['session', 'workshop', 'social', 'agenda']) {
      expect(countsAsSession({ kind: k, cancelled: true })).toBe(false);
    }
  });

  it('still works for the pre-kind datasets', () => {
    expect(countsAsSession({ title: 'Lunch' })).toBe(false);
    expect(countsAsSession({ title: 'Drupal 8 Initiatives' })).toBe(true);
    expect(countsAsSession({ title: 'Lunch', isAgendaItem: false })).toBe(true);
  });
});

describe('isCancelled', () => {
  it('is true only for an explicit boolean true', () => {
    expect(isCancelled({ cancelled: true })).toBe(true);
    expect(isCancelled({ cancelled: false })).toBe(false);
    expect(isCancelled({})).toBe(false);
    expect(isCancelled(null)).toBe(false);
    // A truthy string is a data error, not a cancellation.
    expect(isCancelled({ cancelled: 'yes' })).toBe(false);
  });
});
