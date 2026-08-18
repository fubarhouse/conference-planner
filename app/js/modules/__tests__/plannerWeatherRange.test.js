import { describe, it, expect } from 'vitest';
import { unionTripRange } from '../plannerWeather.js';

describe('unionTripRange', () => {
  it('covers the WHOLE trip — the Rotterdam case (arrive early, leave late)', () => {
    // Conference 28 Sep–01 Oct, but the trip runs 22 Sep → 10 Oct via legs/itinerary.
    const r = unionTripRange('2026-09-28', '2026-10-01', {
      start: '2026-09-22',
      end: '2026-10-10',
    });
    expect(r).toEqual({ start: '2026-09-22', end: '2026-10-10' });
  });

  it('keeps the event window when the trip fits inside it', () => {
    const r = unionTripRange('2026-09-28', '2026-10-01', {
      start: '2026-09-29',
      end: '2026-09-30',
    });
    expect(r).toEqual({ start: '2026-09-28', end: '2026-10-01' });
  });

  it('falls back to the trip span when there is no event window', () => {
    const r = unionTripRange('', '', { start: '2026-09-22', end: '2026-10-10' });
    expect(r).toEqual({ start: '2026-09-22', end: '2026-10-10' });
  });

  it('extends only one edge when the trip overruns one side', () => {
    // Leave late only: end extends past the conference, start unchanged.
    expect(unionTripRange('2026-09-28', '2026-10-01', { end: '2026-10-10' })).toEqual({
      start: '2026-09-28',
      end: '2026-10-10',
    });
    // Arrive early only.
    expect(unionTripRange('2026-09-28', '2026-10-01', { start: '2026-09-22' })).toEqual({
      start: '2026-09-22',
      end: '2026-10-01',
    });
  });

  it('defaults end to start when only a single date is known', () => {
    expect(unionTripRange('2026-09-28', '', {})).toEqual({
      start: '2026-09-28',
      end: '2026-09-28',
    });
    expect(unionTripRange('', '', {})).toEqual({ start: '', end: '' });
  });
});
