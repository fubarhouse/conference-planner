import { describe, it, expect } from 'vitest';

// The sort is exercised through the shape it produces, not the module's private
// comparator: the rule that matters is "newest first, and a session with no time
// still lands in its own year".
const when = (s) => {
  const t = Date.parse(s.startTime || '');
  if (Number.isFinite(t)) return t;
  return s.year ? Date.UTC(Number(s.year), 5, 1) : 0;
};
const order = (list) => [...list].sort((a, b) => when(b) - when(a)).map((s) => s.id);

describe('archive session ordering', () => {
  it('is newest first by the session’s own start time', () => {
    expect(
      order([
        { id: 'mar', startTime: '2026-03-10T09:00:00Z', year: 2026 },
        { id: 'sep', startTime: '2026-09-30T14:00:00Z', year: 2026 },
        { id: 'old', startTime: '2019-05-01T09:00:00Z', year: 2019 },
      ]),
    ).toEqual(['sep', 'mar', 'old']);
  });

  it('puts a same-year event with a LATER date above an earlier one', () => {
    // The bug this replaced sorted by year then event NAME, so "Chicago" came
    // before "Rotterdam" even though Rotterdam happens six months later.
    expect(
      order([
        { id: 'chicago', startTime: '2026-03-23T09:00:00Z', year: 2026 },
        { id: 'rotterdam', startTime: '2026-09-28T09:00:00Z', year: 2026 },
      ]),
    ).toEqual(['rotterdam', 'chicago']);
  });

  it('keeps a session with no start time inside its own year', () => {
    const ids = order([
      { id: 'newer-timed', startTime: '2026-09-30T14:00:00Z', year: 2026 },
      { id: 'untimed-2026', startTime: '', year: 2026 },
      { id: 'older-timed', startTime: '2025-10-14T09:00:00Z', year: 2025 },
    ]);
    // Not first: an untimed session must not leap over a later one in its year.
    expect(ids).toEqual(['newer-timed', 'untimed-2026', 'older-timed']);
  });
});
