import { describe, it, expect, beforeEach, vi } from 'vitest';

// filterEvents reads from state.selectedEvents and state.eventMeta, but
// only via the filterEvents signature — we pass filter options directly.
// We still need state to be importable; patch eventMeta so utils.getLocalDate
// doesn't throw if it's ever called indirectly.
import state from '../state.js';
state.eventMeta = { timezone: 'UTC' };

// filters.js calls displayEvents, updateDownloadButton and announceStatus which
// need the DOM. We only import and test filterEvents (the pure core).
import { filterEvents } from '../filters.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeSession(overrides = {}) {
  return {
    id: `session-${Math.random()}`,
    title: 'Default Title',
    full_description: 'Default description.',
    location: 'Room A',
    track: ['DevOps'],
    speakers: ['Alice'],
    startTime: '2025-07-10T09:00:00Z',
    ...overrides,
  };
}

const sessions = [
  makeSession({ id: 's1', title: 'Intro to Drupal', track: ['Frontend'], location: 'Hall 1', speakers: ['Alice'], startTime: '2025-07-10T09:00:00Z', full_description: 'Drupal basics.' }),
  makeSession({ id: 's2', title: 'DevOps Pipelines', track: ['DevOps'], location: 'Room B', speakers: ['Bob'], startTime: '2025-07-10T14:00:00Z', full_description: 'CI/CD with Drupal.' }),
  makeSession({ id: 's3', title: 'Accessibility Deep Dive', track: ['Frontend', 'UX'], location: 'Hall 1', speakers: ['Carol'], startTime: '2025-07-11T09:00:00Z', full_description: 'WCAG guidelines.' }),
];

beforeEach(() => {
  state.selectedEvents = new Set(['s1']);
});

// ── No filters ────────────────────────────────────────────────────────────────

describe('filterEvents — no filters', () => {
  it('returns all sessions when no filter is set', () => {
    expect(filterEvents(sessions, {})).toHaveLength(3);
  });

  it('returns empty array for empty input', () => {
    expect(filterEvents([], {})).toHaveLength(0);
  });
});

// ── Keyword filter ────────────────────────────────────────────────────────────

describe('filterEvents — keyword', () => {
  it('matches on title', () => {
    const r = filterEvents(sessions, { keyword: 'Drupal' });
    expect(r.map((s) => s.id)).toContain('s1');
  });

  it('matches on full_description', () => {
    const r = filterEvents(sessions, { keyword: 'CI/CD' });
    expect(r.map((s) => s.id)).toContain('s2');
  });

  it('matches on location', () => {
    const r = filterEvents(sessions, { keyword: 'Hall 1' });
    expect(r.map((s) => s.id)).toEqual(expect.arrayContaining(['s1', 's3']));
  });

  it('matches on speaker name', () => {
    const r = filterEvents(sessions, { keyword: 'Carol' });
    expect(r.map((s) => s.id)).toEqual(['s3']);
  });

  it('matches on track', () => {
    const r = filterEvents(sessions, { keyword: 'DevOps' });
    expect(r.map((s) => s.id)).toContain('s2');
  });

  it('is case-insensitive', () => {
    expect(filterEvents(sessions, { keyword: 'drupal' })).toHaveLength(
      filterEvents(sessions, { keyword: 'Drupal' }).length
    );
  });

  it('returns empty when no session matches', () => {
    expect(filterEvents(sessions, { keyword: 'zzznomatch' })).toHaveLength(0);
  });
});

// ── Date filter ───────────────────────────────────────────────────────────────

describe('filterEvents — date', () => {
  it('filters to sessions starting on the given UTC date', () => {
    const r = filterEvents(sessions, { date: '2025-07-10' });
    expect(r.map((s) => s.id)).toEqual(expect.arrayContaining(['s1', 's2']));
    expect(r.map((s) => s.id)).not.toContain('s3');
  });

  it('returns all when date is empty', () => {
    expect(filterEvents(sessions, { date: '' })).toHaveLength(3);
  });
});

// ── Track filter ──────────────────────────────────────────────────────────────

describe('filterEvents — track', () => {
  it('filters to sessions in the given track', () => {
    const r = filterEvents(sessions, { track: 'Frontend' });
    expect(r.map((s) => s.id)).toEqual(expect.arrayContaining(['s1', 's3']));
    expect(r.map((s) => s.id)).not.toContain('s2');
  });

  it('matches multi-track sessions when the track is one of their tracks', () => {
    const r = filterEvents(sessions, { track: 'UX' });
    expect(r.map((s) => s.id)).toEqual(['s3']);
  });
});

// ── Selection filter ──────────────────────────────────────────────────────────

describe('filterEvents — selectionMode', () => {
  it("'selected' returns only sessions in selectedEvents", () => {
    const r = filterEvents(sessions, { selectionMode: 'selected' });
    expect(r.map((s) => s.id)).toEqual(['s1']);
  });

  it("'unselected' returns sessions not in selectedEvents", () => {
    const r = filterEvents(sessions, { selectionMode: 'unselected' });
    expect(r.map((s) => s.id)).toEqual(expect.arrayContaining(['s2', 's3']));
    expect(r.map((s) => s.id)).not.toContain('s1');
  });

  it("'all' returns everything regardless of selection state", () => {
    expect(filterEvents(sessions, { selectionMode: 'all' })).toHaveLength(3);
  });
});

// ── Combined filters ──────────────────────────────────────────────────────────

describe('filterEvents — combined', () => {
  it('applies date AND keyword together', () => {
    // s1 is on July 10 and title is 'Intro to Drupal'; s2 is July 10 but title/desc don't contain 'Intro'
    const r = filterEvents(sessions, { date: '2025-07-10', keyword: 'Intro' });
    expect(r.map((s) => s.id)).toEqual(['s1']);
  });

  it('returns empty when combined filters match nothing', () => {
    const r = filterEvents(sessions, { date: '2025-07-11', keyword: 'DevOps' });
    expect(r).toHaveLength(0);
  });
});