import { describe, it, expect } from 'vitest';
import {
  legTransitions,
  meStayDates,
  locationEvents,
  accomTransitions,
  dayHops,
} from '../weather.js';

describe('meStayDates + accommodation locations', () => {
  const rotterdamHotel = {
    name: 'Postillion Hotel WTC Rotterdam',
    coords: '51.922498, 4.479171',
    checkIn: '', // top-level blank — the real dates live on the __me__ stay
    checkOut: '',
    assignments: [{ memberId: '__me__', checkIn: '2026-09-27', checkOut: '2026-10-02' }],
  };

  it('reads check-in/out from the __me__ stay, not the blank top-level fields', () => {
    expect(meStayDates(rotterdamHotel)).toEqual({ checkIn: '2026-09-27', checkOut: '2026-10-02' });
  });

  it('falls back to legacy top-level dates when there is no me-stay', () => {
    expect(meStayDates({ checkIn: '2026-09-27', checkOut: '2026-09-29' })).toEqual({
      checkIn: '2026-09-27',
      checkOut: '2026-09-29',
    });
  });

  it('emits a dated location event with the accommodation coords (no geocoding needed)', () => {
    const ev = locationEvents({ accommodations: [rotterdamHotel] });
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      date: '2026-09-27',
      location: 'Postillion Hotel WTC Rotterdam',
      coords: { lat: 51.922498, lon: 4.479171 },
    });
  });

  it('detects a same-day stay-to-stay transition from me-stay dates', () => {
    const t = accomTransitions({
      accommodations: [
        { name: 'Hotel Hortus', assignments: [{ memberId: '__me__', checkOut: '2026-09-27' }] },
        rotterdamHotel,
      ],
    });
    expect(t.get('2026-09-27')).toEqual({
      from: 'Hotel Hortus',
      to: 'Postillion Hotel WTC Rotterdam',
    });
  });
});

describe('legTransitions', () => {
  it('flags a simple travel day (leave one city, arrive another)', () => {
    const t = legTransitions({
      outboundLegs: [{ date: '2026-09-22', arriveDate: '2026-09-22', from: 'CBR', to: 'MEL' }],
    });
    expect(t.get('2026-09-22')).toEqual({ from: 'CBR', to: 'MEL' });
  });

  it('drops the transit airport on a multi-hop day (origin → terminal)', () => {
    // Sep 23: MEL→DOH (arrives 23) then DOH→AMS (arrives 23). DOH is transit.
    const t = legTransitions({
      outboundLegs: [
        { date: '2026-09-22', arriveDate: '2026-09-23', from: 'MEL', to: 'DOH' },
        { date: '2026-09-23', arriveDate: '2026-09-23', from: 'DOH', to: 'AMS' },
      ],
    });
    expect(t.get('2026-09-23')).toEqual({ from: 'MEL', to: 'AMS' });
  });

  it('handles the return multi-hop day (DOH → CBR, dropping SYD transit)', () => {
    const t = legTransitions({
      returnLegs: [
        { date: '2026-10-09', arriveDate: '2026-10-10', from: 'DOH', to: 'SYD' },
        { date: '2026-10-10', from: 'SYD', to: 'CBR' },
      ],
    });
    expect(t.get('2026-10-10')).toEqual({ from: 'DOH', to: 'CBR' });
  });

  it('ignores a leg with no movement or missing dates', () => {
    expect(
      legTransitions({ outboundLegs: [{ from: 'AMS', to: 'AMS', date: '2026-09-23' }] }).size,
    ).toBe(0);
    expect(legTransitions({ outboundLegs: [{ from: 'A', to: 'B' }] }).size).toBe(0); // no date
    expect(legTransitions({}).size).toBe(0);
  });
});

describe('dayHops (full travel-day sequences)', () => {
  it('a three-location day: DOH → AMS → Oldenzaal (overnight origin MEL dropped)', () => {
    const h = dayHops({
      outboundLegs: [
        { date: '2026-09-22', arriveDate: '2026-09-23', from: 'MEL', to: 'DOH' }, // overnight
        { date: '2026-09-23', arriveDate: '2026-09-23', from: 'DOH', to: 'AMS' },
      ],
      accommodations: [
        { name: "Henk's Place", assignments: [{ memberId: '__me__', checkIn: '2026-09-23' }] },
      ],
    });
    expect(h.get('2026-09-23')?.map((x) => x.name)).toEqual(['DOH', 'AMS', "Henk's Place"]);
  });

  it('prepends the origin when the first leg departs that same day (CBR → MEL)', () => {
    const h = dayHops({
      outboundLegs: [{ date: '2026-09-22', arriveDate: '2026-09-22', from: 'CBR', to: 'MEL' }],
    });
    expect(h.get('2026-09-22')?.map((x) => x.name)).toEqual(['CBR', 'MEL']);
  });

  it('omits single-location days', () => {
    const h = dayHops({
      accommodations: [
        { name: 'Hotel', assignments: [{ memberId: '__me__', checkIn: '2026-09-25' }] },
      ],
    });
    expect(h.has('2026-09-25')).toBe(false);
  });
});

describe('dayHops — itinerary excursions (day trips)', () => {
  const munich = { name: 'Munich (AirBnB)', address: 'Munich', coords: '48.14, 11.56' };
  it('renders an excursion as base → excursion → base', () => {
    const h = dayHops({
      accommodations: [
        {
          ...munich,
          assignments: [{ memberId: '__me__', checkIn: '2026-10-02', checkOut: '2026-10-04' }],
        },
      ],
      itinerary: [
        { date: '2026-10-03', location: '', title: 'Dachau trip', coords: '48.26, 11.43' },
      ],
    });
    const names = h.get('2026-10-03')?.map((x) => x.name);
    expect(names).toEqual(['Munich', 'Dachau trip', 'Munich']);
  });

  it('skips an excursion that is at your base city', () => {
    const h = dayHops({
      accommodations: [
        {
          name: "Matt's",
          address: 'Zurich',
          coords: '47.37, 8.55',
          assignments: [{ memberId: '__me__', checkIn: '2026-10-04', checkOut: '2026-10-07' }],
        },
      ],
      itinerary: [{ date: '2026-10-05', location: 'Zurich', title: 'Hike', coords: '' }],
    });
    expect(h.has('2026-10-05')).toBe(false);
  });

  it('combines an excursion with a same-day base move (Munich → Dachau → Munich → Zurich)', () => {
    const h = dayHops({
      accommodations: [
        {
          address: 'Munich',
          coords: '48.14, 11.56',
          assignments: [{ memberId: '__me__', checkIn: '2026-10-02', checkOut: '2026-10-04' }],
        },
        {
          address: 'Zurich',
          coords: '47.37, 8.55',
          assignments: [{ memberId: '__me__', checkIn: '2026-10-04', checkOut: '2026-10-07' }],
        },
      ],
      itinerary: [{ date: '2026-10-04', location: 'Dachau', coords: '48.26, 11.43' }],
    });
    expect(h.get('2026-10-04')?.map((x) => x.name)).toEqual([
      'Munich',
      'Dachau',
      'Munich',
      'Zurich',
    ]);
  });
});
