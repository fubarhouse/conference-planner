import { describe, it, expect } from 'vitest';
import { computeNowNext } from '../nowNext.js';

const S = (id, start, end) => ({ id, title: id, startTime: start, endTime: end });

const sessions = [
  S('a', '2026-10-01T09:00:00Z', '2026-10-01T10:00:00Z'),
  S('b', '2026-10-01T09:00:00Z', '2026-10-01T09:45:00Z'), // concurrent with a
  S('c', '2026-10-01T10:00:00Z', '2026-10-01T11:00:00Z'),
  S('d', '2026-10-01T10:00:00Z', '2026-10-01T10:30:00Z'), // concurrent with c
  S('e', '2026-10-01T14:00:00Z', '2026-10-01T15:00:00Z'),
];

const at = (iso) => Date.parse(iso);

describe('computeNowNext', () => {
  it('returns everything on now (incl. concurrent) and the soonest next slot', () => {
    const { onNow, upNext, nextStartMs } = computeNowNext(sessions, at('2026-10-01T09:20:00Z'));
    expect(onNow.map((s) => s.id).sort()).toEqual(['a', 'b']);
    expect(upNext.map((s) => s.id).sort()).toEqual(['c', 'd']);
    expect(nextStartMs).toBe(at('2026-10-01T10:00:00Z'));
  });

  it('excludes a session whose end has passed from on-now', () => {
    // 09:50 — b ended at 09:45, a still running until 10:00
    const { onNow } = computeNowNext(sessions, at('2026-10-01T09:50:00Z'));
    expect(onNow.map((s) => s.id)).toEqual(['a']);
  });

  it('before the event: nothing on now, first session is up next', () => {
    const { onNow, upNext, nextStartMs } = computeNowNext(sessions, at('2026-10-01T08:00:00Z'));
    expect(onNow).toEqual([]);
    expect(upNext.map((s) => s.id).sort()).toEqual(['a', 'b']);
    expect(nextStartMs).toBe(at('2026-10-01T09:00:00Z'));
  });

  it('after the last session: nothing on now, no next slot', () => {
    const { onNow, upNext, nextStartMs } = computeNowNext(sessions, at('2026-10-01T16:00:00Z'));
    expect(onNow).toEqual([]);
    expect(upNext).toEqual([]);
    expect(nextStartMs).toBeNull();
  });

  it('skips sessions with unparseable times, and treats missing end as not-on-now', () => {
    const messy = [
      S('bad', 'not-a-date', 'also-bad'),
      { id: 'noend', title: 'noend', startTime: '2026-10-01T09:00:00Z' },
    ];
    const { onNow, upNext } = computeNowNext(messy, at('2026-10-01T09:30:00Z'));
    expect(onNow).toEqual([]); // noend has no parseable end → not counted as live
    expect(upNext).toEqual([]); // noend started in the past, bad is unparseable
  });

  it('is a no-op on empty/nullish input', () => {
    expect(computeNowNext([], Date.now())).toEqual({ onNow: [], upNext: [], nextStartMs: null });
    expect(computeNowNext(null, Date.now())).toEqual({ onNow: [], upNext: [], nextStartMs: null });
  });
});
