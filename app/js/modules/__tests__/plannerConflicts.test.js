import { describe, it, expect } from 'vitest';
import { detectPersonalConflicts, accommodationGaps } from '../plannerConflicts.js';

describe('detectPersonalConflicts', () => {
  it('returns no conflicts for an empty or missing personal record', () => {
    expect(detectPersonalConflicts(undefined)).toEqual([]);
    expect(detectPersonalConflicts({})).toEqual([]);
  });

  it('flags return travel that precedes outbound arrival', () => {
    const conflicts = detectPersonalConflicts({
      outboundLegs: [{ date: '2026-03-10', arriveDate: '2026-03-11' }],
      returnLegs: [{ date: '2026-03-10' }],
    });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].sev).toBe('error');
    expect(conflicts[0].msg).toMatch(/Return travel .* is before outbound arrives/);
  });

  it('warns about nights with no accommodation inside the trip window', () => {
    const conflicts = detectPersonalConflicts({
      outboundLegs: [{ date: '2026-03-10', arriveDate: '2026-03-10' }],
      returnLegs: [{ date: '2026-03-13' }],
      accommodations: [{ name: 'Hotel', checkIn: '2026-03-10', checkOut: '2026-03-12' }],
    });
    const gap = conflicts.find((c) => c.sev === 'warning');
    expect(gap).toBeDefined();
    expect(gap.msg).toMatch(/1 night without accommodation: 2026-03-12/);
  });

  it('reports no gap when accommodation covers the whole trip window', () => {
    const conflicts = detectPersonalConflicts({
      outboundLegs: [{ date: '2026-03-10', arriveDate: '2026-03-10' }],
      returnLegs: [{ date: '2026-03-13' }],
      accommodations: [{ name: 'Hotel', checkIn: '2026-03-10', checkOut: '2026-03-13' }],
    });
    expect(conflicts).toEqual([]);
  });

  it('resolves the "me" stay dates from assignments over the base accommodation', () => {
    const conflicts = detectPersonalConflicts({
      outboundLegs: [{ date: '2026-03-10', arriveDate: '2026-03-10' }],
      returnLegs: [{ date: '2026-03-12' }],
      accommodations: [
        {
          name: 'Hotel',
          checkIn: '2026-01-01', // base dates would leave a gap...
          checkOut: '2026-01-02',
          assignments: [{ memberId: '__me__', checkIn: '2026-03-10', checkOut: '2026-03-12' }],
        },
      ],
    });
    // ...but the __me__ assignment covers 03-10 & 03-11, so no gap.
    expect(conflicts).toEqual([]);
  });

  it('counts multiple uncovered nights and samples them', () => {
    const conflicts = detectPersonalConflicts({
      outboundLegs: [{ date: '2026-03-10', arriveDate: '2026-03-10' }],
      returnLegs: [{ date: '2026-03-15' }],
      accommodations: [{ name: 'Hotel', checkIn: '2026-03-10', checkOut: '2026-03-11' }],
    });
    const gap = conflicts.find((c) => c.sev === 'warning');
    expect(gap.msg).toMatch(/4 nights without accommodation: 2026-03-11, 2026-03-12 \+2 more/);
  });

  it('does not flag transit nights during a multi-leg outbound journey', () => {
    // Fly out over two days (first leg lands 10-08, final leg lands 10-10), then a
    // hotel from arrival until the return. Nights 10-08 & 10-09 are in transit.
    const conflicts = detectPersonalConflicts({
      outboundLegs: [
        { date: '2026-10-07', arriveDate: '2026-10-08' },
        { date: '2026-10-09', arriveDate: '2026-10-10' },
      ],
      returnLegs: [{ date: '2026-10-14' }],
      accommodations: [{ name: 'Hotel', checkIn: '2026-10-10', checkOut: '2026-10-14' }],
    });
    expect(conflicts.find((c) => /without accommodation/.test(c.msg))).toBeUndefined();
  });

  it('treats an overnight flight within the trip as covering that night', () => {
    const twoStays = {
      outboundLegs: [{ date: '2026-10-05', arriveDate: '2026-10-05' }],
      returnLegs: [{ date: '2026-10-12' }],
      accommodations: [
        { name: 'Hotel A', checkIn: '2026-10-05', checkOut: '2026-10-08' },
        { name: 'Hotel B', checkIn: '2026-10-09', checkOut: '2026-10-12' },
      ],
    };
    // Without the red-eye, the night of 10-08 is a gap...
    expect(
      detectPersonalConflicts(twoStays).find((c) => /without accommodation/.test(c.msg))?.msg,
    ).toMatch(/2026-10-08/);
    // ...but an overnight leg (depart 10-08, land 10-09) covers it.
    const withRedeye = detectPersonalConflicts({
      ...twoStays,
      outboundLegs: [...twoStays.outboundLegs, { date: '2026-10-08', arriveDate: '2026-10-09' }],
    });
    expect(withRedeye.find((c) => /without accommodation/.test(c.msg))).toBeUndefined();
  });

  it('names the offending entity + field for a malformed date, no runaway warning', () => {
    // The reported bug: a corrupt arrival date ('2-09-23') sorted as the earliest
    // and blew the per-night loop out to ~739,253 iterations.
    const conflicts = detectPersonalConflicts({
      outboundLegs: [
        { mode: 'flight', from: 'MEL', to: 'NRT', date: '2023-09-23', arriveDate: '2-09-23' },
      ],
      returnLegs: [{ date: '2023-09-25' }],
      accommodations: [{ name: 'Hotel', checkIn: '2023-09-23', checkOut: '2023-09-24' }],
    });
    const bad = conflicts.find((c) => c.sev === 'error' && /not a valid date/.test(c.msg));
    // Identifies which leg, direction, route, and field.
    expect(bad.msg).toMatch(/Outbound flight \(MEL → NRT\) — arrival date "2-09-23"/);
    // No absurd nights warning — the arrival falls back to the valid leg date.
    const gap = conflicts.find((c) => /without accommodation/.test(c.msg));
    expect(gap?.msg ?? '').not.toMatch(/\d{5,} nights?/);
  });

  it('names the accommodation for a bad check-in/out date', () => {
    const conflicts = detectPersonalConflicts({
      accommodations: [{ name: 'Grand Hotel', checkIn: '2026-13-40', checkOut: '2026-03-15' }],
    });
    const bad = conflicts.find((c) => /not a valid date/.test(c.msg));
    expect(bad.msg).toMatch(/"Grand Hotel" — check-in "2026-13-40"/);
  });

  it('dedupes identical entity/field/value combinations', () => {
    const conflicts = detectPersonalConflicts({
      outboundLegs: [{ date: 'x1' }, { date: 'x1' }],
    });
    expect(conflicts.filter((c) => /not a valid date/.test(c.msg))).toHaveLength(1);
  });
});

describe('accommodationGaps', () => {
  it('returns each uncovered night with the check-out that fills its run', () => {
    // Arrive 03-10, leave 03-15; hotel only covers 03-10 → 03-11. Nights 03-11,
    // 03-12, 03-13, 03-14 are one contiguous gap ending at departure 03-15.
    const gaps = accommodationGaps({
      outboundLegs: [{ date: '2026-03-10', arriveDate: '2026-03-10' }],
      returnLegs: [{ date: '2026-03-15' }],
      accommodations: [{ name: 'Hotel', checkIn: '2026-03-10', checkOut: '2026-03-11' }],
    });
    expect(gaps.map((g) => g.date)).toEqual([
      '2026-03-11',
      '2026-03-12',
      '2026-03-13',
      '2026-03-14',
    ]);
    // Every night in the run suggests the same run-ending check-out.
    expect(gaps.every((g) => g.checkOut === '2026-03-15')).toBe(true);
  });

  it('splits two separate gap runs with their own check-outs', () => {
    // Covered 03-11 only → gap 03-10 (run ends 03-11) and gap 03-12/03-13 (ends 03-14).
    const gaps = accommodationGaps({
      outboundLegs: [{ date: '2026-03-10', arriveDate: '2026-03-10' }],
      returnLegs: [{ date: '2026-03-14' }],
      accommodations: [{ name: 'Hotel', checkIn: '2026-03-11', checkOut: '2026-03-12' }],
    });
    expect(gaps).toEqual([
      { date: '2026-03-10', checkOut: '2026-03-11' },
      { date: '2026-03-12', checkOut: '2026-03-14' },
      { date: '2026-03-13', checkOut: '2026-03-14' },
    ]);
  });

  it('returns [] when there is no gap', () => {
    expect(
      accommodationGaps({
        outboundLegs: [{ date: '2026-03-10', arriveDate: '2026-03-10' }],
        returnLegs: [{ date: '2026-03-13' }],
        accommodations: [{ name: 'Hotel', checkIn: '2026-03-10', checkOut: '2026-03-13' }],
      }),
    ).toEqual([]);
  });
});
