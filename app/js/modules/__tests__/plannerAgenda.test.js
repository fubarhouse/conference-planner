import { describe, it, expect } from 'vitest';
import { buildDayItinerary } from '../plannerAgenda.js';

const fmtTime = (iso) => iso.slice(11, 16); // deterministic HH:mm, no locale/timezone

describe('buildDayItinerary', () => {
  it('returns an empty array when there is no personal record', () => {
    expect(buildDayItinerary({ personal: undefined, fmtTime })).toEqual([]);
  });

  it('groups travel, accommodation and itinerary items by date and sorts days', () => {
    const personal = {
      outboundLegs: [{ date: '2026-03-10', departTime: '08:00', from: 'SYD', to: 'SIN' }],
      accommodations: [{ name: 'Hotel', checkIn: '2026-03-10', checkOut: '2026-03-12' }],
      itinerary: [{ id: 'i1', date: '2026-03-11', time: '19:00', title: 'Dinner' }],
    };
    const days = buildDayItinerary({ personal, fmtTime });
    expect(days.map((d) => d.date)).toEqual(['2026-03-10', '2026-03-11', '2026-03-12']);
    // Day 1 has both the outbound leg and the check-in.
    const day1 = days[0].events;
    expect(day1.map((e) => e.type).sort()).toEqual(['accom', 'travel']);
  });

  it('fills in blank days between the first and last dated signal (free days)', () => {
    const personal = {
      // A signal on the 10th and another on the 13th — the 11th and 12th are blank.
      itinerary: [
        { id: 'a', date: '2026-03-10', title: 'Arrive' },
        { id: 'b', date: '2026-03-13', title: 'Tour' },
      ],
    };
    const days = buildDayItinerary({ personal, fmtTime });
    expect(days.map((d) => d.date)).toEqual([
      '2026-03-10',
      '2026-03-11',
      '2026-03-12',
      '2026-03-13',
    ]);
    // The in-between days exist but carry no events (rendered as "nothing planned").
    expect(days[1].events).toEqual([]);
    expect(days[2].events).toEqual([]);
  });

  it('includes local "getting around" legs, labelled Around', () => {
    const personal = {
      showLocalTravel: true,
      localLegs: [
        {
          id: 'll1',
          mode: 'train',
          date: '2026-03-11',
          from: 'Hotel',
          to: 'Venue',
          departTime: '09:00',
        },
      ],
    };
    const days = buildDayItinerary({ personal, fmtTime });
    expect(days[0].events[0]).toMatchObject({ type: 'travel', label: 'Around: Hotel → Venue' });
  });

  it('omits local legs when the getting-around toggle is off (default)', () => {
    const personal = {
      localLegs: [{ id: 'll1', mode: 'train', date: '2026-03-11', from: 'Hotel', to: 'Venue' }],
    };
    expect(buildDayItinerary({ personal, fmtTime })).toEqual([]);
  });

  it('adds a separate arrival-day entry for an overnight leg', () => {
    const personal = {
      outboundLegs: [
        {
          date: '2026-03-10',
          arriveDate: '2026-03-11',
          departTime: '23:00',
          arriveTime: '06:00',
          to: 'LHR',
        },
      ],
    };
    const days = buildDayItinerary({ personal, fmtTime });
    expect(days.map((d) => d.date)).toEqual(['2026-03-10', '2026-03-11']);
    expect(days[1].events[0].label).toBe('Arrives: LHR');
  });

  it('adds cruise/waypoint stops (ports of call) as dated events', () => {
    const personal = {
      accommodations: [
        {
          name: 'Ship',
          type: 'waypoints',
          checkIn: '2026-03-10',
          checkOut: '2026-03-14',
          stops: [
            { date: '2026-03-10', location: 'Home Port' }, // embark day — deduped
            { date: '2026-03-12', location: 'Mystery Island' },
            { date: '2026-03-13', location: 'Port Vila' },
            { date: '2026-03-14', location: 'Home Port' }, // disembark day — deduped
          ],
        },
      ],
    };
    const days = buildDayItinerary({ personal, fmtTime });
    const byDate = Object.fromEntries(days.map((d) => [d.date, d]));
    expect(byDate['2026-03-12'].events.map((e) => e.label)).toContain('Port: Mystery Island');
    expect(byDate['2026-03-13'].events[0].label).toBe('Port: Port Vila');
    // Embark/disembark stops (on the check-in/out days) are not repeated as ports.
    expect(byDate['2026-03-10'].events.map((e) => e.label)).not.toContain('Port: Home Port');
    expect(byDate['2026-03-14'].events.map((e) => e.label)).not.toContain('Port: Home Port');
  });

  it('adds the associated conference as a banner on each of its days', () => {
    const eventMeta = {
      designation: 'DrupalCon',
      year: 2026,
      location: 'Vienna',
      startDate: '2026-09-24T00:00:00Z',
      endDate: '2026-09-26T00:00:00Z',
    };
    const days = buildDayItinerary({ personal: {}, eventMeta, isConference: true, fmtTime });
    expect(days.map((d) => d.date)).toEqual(['2026-09-24', '2026-09-25', '2026-09-26']);
    expect(days[0].events[0]).toMatchObject({ type: 'conference', label: 'DrupalCon 2026' });
  });

  it('adds a banner per event when several conferences are attached', () => {
    const events = [
      {
        meta: {
          designation: 'DrupalCon',
          year: 2026,
          location: 'Vienna',
          startDate: '2026-09-24',
          endDate: '2026-09-25',
        },
      },
      {
        meta: {
          designation: 'Summit',
          year: 2026,
          location: 'Vienna',
          startDate: '2026-09-25',
          endDate: '2026-09-26',
        },
      },
    ];
    const days = buildDayItinerary({ personal: {}, events, isConference: true, fmtTime });
    expect(days.map((d) => d.date)).toEqual(['2026-09-24', '2026-09-25', '2026-09-26']);
    // The overlap day (09-25) carries both conference banners.
    const labels = days
      .find((d) => d.date === '2026-09-25')
      .events.filter((e) => e.type === 'conference')
      .map((e) => e.label);
    expect(labels).toEqual(['DrupalCon 2026', 'Summit 2026']);
  });

  it('omits the conference banner when the trip is not a conference', () => {
    const eventMeta = { designation: 'DrupalCon', startDate: '2026-09-24T00:00:00Z' };
    expect(buildDayItinerary({ personal: {}, eventMeta, isConference: false, fmtTime })).toEqual(
      [],
    );
  });

  it('surfaces only opted-in dated tickets (mine / unassigned) as itinerary entries', () => {
    const personal = {
      tickets: [
        {
          id: 'k1',
          name: 'Workshop',
          assignedTo: '__me__',
          days: ['2026-03-11'],
          showOnItinerary: true,
        },
        { id: 'k2', name: 'Concert', days: ['2026-03-12'], showOnItinerary: true }, // unassigned → mine
        { id: 'k5', name: 'Conference pass', assignedTo: '__me__', days: ['2026-03-11'] }, // not opted in → skip
        { id: 'k3', name: 'No days', assignedTo: '__me__', days: [], showOnItinerary: true }, // undated → skip
        {
          id: 'k4',
          name: "Sam's pass",
          assignedTo: 'c_sam',
          days: ['2026-03-11'],
          showOnItinerary: true,
        }, // not mine → skip
      ],
    };
    const days = buildDayItinerary({ personal, fmtTime });
    const byDate = Object.fromEntries(days.map((d) => [d.date, d]));
    expect(byDate['2026-03-11'].events.map((e) => e.label)).toEqual(['Workshop']);
    expect(byDate['2026-03-12'].events[0]).toMatchObject({ type: 'ticket', label: 'Concert' });
    const allLabels = days.flatMap((d) => d.events).map((e) => e.label);
    expect(allLabels).not.toContain('Conference pass'); // opt-in off
    expect(allLabels).not.toContain('No days');
    expect(allLabels).not.toContain("Sam's pass");
  });

  it('sorts events within a day, floating sortTime entries appropriately', () => {
    const personal = {
      accommodations: [{ name: 'Hotel', checkIn: '2026-03-10' }], // sortTime 23:59 → last
      itinerary: [{ id: 'i1', date: '2026-03-10', time: '09:00', title: 'Breakfast' }],
    };
    const [day] = buildDayItinerary({ personal, fmtTime });
    expect(day.events.map((e) => e.type)).toEqual(['item', 'accom']);
  });

  it('resolves tracked sessions against allSessions using the given fmtTime', () => {
    const personal = { trackedSessions: [{ sessionId: 's1' }] };
    const allSessions = [
      { id: 's1', startTime: '2026-03-10T14:30:00Z', title: 'Keynote', location: 'Hall A' },
    ];
    const [day] = buildDayItinerary({ personal, allSessions, timezone: 'UTC', fmtTime });
    expect(day.events[0]).toMatchObject({ type: 'session', label: 'Keynote', time: '14:30' });
  });
});
