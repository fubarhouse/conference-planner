import { describe, it, expect } from 'vitest';
import {
  addMinutes,
  itineraryItemToCalEvent,
  legToCalEvent,
  accommodationToCalEvent,
  buildVevent,
  buildIcsCalendar,
  googleCalendarUrl,
  scheduleSessionsToCalEvents,
} from '../plannerCalendar.js';

describe('addMinutes', () => {
  it('adds within the same day', () => {
    expect(addMinutes({ date: '2027-03-04', time: '09:00' }, 60)).toEqual({
      date: '2027-03-04',
      time: '10:00',
    });
  });
  it('rolls across midnight', () => {
    expect(addMinutes({ date: '2027-03-04', time: '23:30' }, 60)).toEqual({
      date: '2027-03-05',
      time: '00:30',
    });
  });
});

describe('itineraryItemToCalEvent', () => {
  it('makes a timed event when a time is present', () => {
    const ev = itineraryItemToCalEvent({
      title: 'Dinner',
      date: '2027-03-04',
      time: '19:00',
      location: 'Cafe',
    });
    expect(ev).toMatchObject({ title: 'Dinner', allDay: false, location: 'Cafe' });
    expect(ev.start).toEqual({ date: '2027-03-04', time: '19:00' });
  });
  it('uses an explicit finishing time as the end', () => {
    const ev = itineraryItemToCalEvent({
      title: 'Workshop',
      date: '2027-03-04',
      time: '14:00',
      endTime: '16:30',
    });
    expect(ev.end).toEqual({ date: '2027-03-04', time: '16:30' });
  });
  it('resolves the timezone: item override wins over the fallback', () => {
    expect(
      itineraryItemToCalEvent(
        { title: 'x', date: '2027-03-04', time: '09:00' },
        {
          timezone: 'Europe/Amsterdam',
        },
      ).timezone,
    ).toBe('Europe/Amsterdam');
    expect(
      itineraryItemToCalEvent(
        { title: 'x', date: '2027-03-04', time: '09:00', timezone: 'Asia/Tokyo' },
        { timezone: 'Europe/Amsterdam' },
      ).timezone,
    ).toBe('Asia/Tokyo');
  });
  it('carries the item notes into the description', () => {
    const ev = itineraryItemToCalEvent({
      title: 'Workshop',
      date: '2027-03-04',
      time: '14:00',
      notes: 'Bring your laptop',
    });
    expect(ev.description).toBe('Bring your laptop');
  });
  it('has no end when only a start time is given', () => {
    const ev = itineraryItemToCalEvent({ title: 'Dinner', date: '2027-03-04', time: '19:00' });
    expect(ev.end).toBeNull();
  });
  it('ignores a finishing time on an all-day item', () => {
    const ev = itineraryItemToCalEvent({ title: 'Rest', date: '2027-03-05', endTime: '10:00' });
    expect(ev.allDay).toBe(true);
    expect(ev.end).toBeNull();
  });
  it('makes an all-day event when there is no time', () => {
    const ev = itineraryItemToCalEvent({ title: 'Rest day', date: '2027-03-05' });
    expect(ev.allDay).toBe(true);
  });
  it('returns null without a date', () => {
    expect(itineraryItemToCalEvent({ title: 'x' })).toBeNull();
  });
});

describe('legToCalEvent', () => {
  it('builds a titled journey with arrival as the end', () => {
    const ev = legToCalEvent(
      {
        mode: 'flight',
        date: '2027-03-04',
        departTime: '08:00',
        arriveDate: '2027-03-04',
        arriveTime: '11:30',
        from: 'SYD',
        to: 'NRT',
        ref: 'QF21',
      },
      { direction: 'outbound' },
    );
    expect(ev.title).toBe('Flight: SYD → NRT');
    expect(ev.allDay).toBe(false);
    expect(ev.start).toEqual({ date: '2027-03-04', time: '08:00' });
    expect(ev.end).toEqual({ date: '2027-03-04', time: '11:30' });
    expect(ev.location).toBe('SYD');
    expect(ev.description).toContain('QF21');
  });
  it('is all-day when no departure time is set', () => {
    const ev = legToCalEvent({ mode: 'train', date: '2027-03-04', from: 'A', to: 'B' }, {});
    expect(ev.allDay).toBe(true);
    expect(ev.end).toBeNull();
  });
});

describe('accommodationToCalEvent', () => {
  it('spans check-in to check-out as an all-day stay', () => {
    const ev = accommodationToCalEvent({
      name: 'Hotel Nara',
      checkIn: '2027-03-04',
      checkOut: '2027-03-07',
      location: 'Nara',
    });
    expect(ev).toMatchObject({ title: 'Stay: Hotel Nara', allDay: true, location: 'Nara' });
    expect(ev.start.date).toBe('2027-03-04');
    expect(ev.end.date).toBe('2027-03-07');
  });
  it('returns null without a check-in', () => {
    expect(accommodationToCalEvent({ name: 'x' })).toBeNull();
  });
});

describe('buildVevent', () => {
  const stamp = '20270101T000000Z';
  it('emits floating DTSTART/DTEND for a timed event, defaulting to 60 min', () => {
    const ev = itineraryItemToCalEvent({ title: 'Talk', date: '2027-03-04', time: '09:00' });
    const out = buildVevent(ev, { uid: 'a@planner', dtStamp: stamp });
    expect(out).toContain('DTSTART:20270304T090000');
    expect(out).toContain('DTEND:20270304T100000');
    expect(out).not.toContain('090000Z'); // floating, no Z
  });
  it('converts a zoned event to absolute UTC (trailing Z)', () => {
    // 2027-03-04 is before EU DST, so Amsterdam is UTC+1: 09:00 local → 08:00 UTC.
    const ev = itineraryItemToCalEvent(
      { title: 'Talk', date: '2027-03-04', time: '09:00', endTime: '10:30' },
      { timezone: 'Europe/Amsterdam' },
    );
    const out = buildVevent(ev, { uid: 'z@planner', dtStamp: stamp });
    expect(out).toContain('DTSTART:20270304T080000Z');
    expect(out).toContain('DTEND:20270304T093000Z');
  });
  it('emits VALUE=DATE with an exclusive next-day DTEND for all-day', () => {
    const ev = itineraryItemToCalEvent({ title: 'Rest', date: '2027-03-05' });
    const out = buildVevent(ev, { uid: 'b@planner', dtStamp: stamp });
    expect(out).toContain('DTSTART;VALUE=DATE:20270305');
    expect(out).toContain('DTEND;VALUE=DATE:20270306');
  });
  it('escapes commas in the summary and can add a VALARM', () => {
    const ev = itineraryItemToCalEvent({
      title: 'Lunch, then walk',
      date: '2027-03-04',
      time: '12:00',
    });
    const out = buildVevent(ev, { uid: 'c@planner', dtStamp: stamp, alarmMinutes: 15 });
    expect(out).toContain('SUMMARY:Lunch\\, then walk');
    expect(out).toContain('TRIGGER:-PT15M');
  });
});

describe('buildIcsCalendar', () => {
  it('wraps events in a VCALENDAR with per-event UIDs', () => {
    const events = [
      itineraryItemToCalEvent({ title: 'A', date: '2027-03-04', time: '09:00' }),
      accommodationToCalEvent({ name: 'H', checkIn: '2027-03-04', checkOut: '2027-03-06' }),
    ];
    const ics = buildIcsCalendar(events, {
      calName: 'My Trip',
      uidFor: (_e, i) => `u${i}@planner`,
    });
    expect(ics.startsWith('BEGIN:VCALENDAR')).toBe(true);
    expect(ics.trimEnd().endsWith('END:VCALENDAR')).toBe(true);
    expect(ics).toContain('X-WR-CALNAME:My Trip');
    expect(ics).toContain('UID:u0@planner');
    expect(ics).toContain('UID:u1@planner');
  });
});

describe('googleCalendarUrl', () => {
  it('formats a timed event range', () => {
    const ev = itineraryItemToCalEvent({
      title: 'Talk',
      date: '2027-03-04',
      time: '09:00',
      location: 'Hall',
    });
    const url = new URL(googleCalendarUrl(ev));
    expect(url.searchParams.get('dates')).toBe('20270304T090000/20270304T100000');
    expect(url.searchParams.get('text')).toBe('Talk');
    expect(url.searchParams.get('location')).toBe('Hall');
  });
  it('formats an all-day range with an exclusive end', () => {
    const ev = accommodationToCalEvent({
      name: 'H',
      checkIn: '2027-03-04',
      checkOut: '2027-03-06',
    });
    const url = new URL(googleCalendarUrl(ev));
    expect(url.searchParams.get('dates')).toBe('20270304/20270307');
  });
});

describe('a session held somewhere else', () => {
  // The Splash Awards are in a theatre across town from the conference centre. A
  // feed that says "Main Hall · Rotterdam Ahoy" for that session sends its
  // subscribers to the wrong building.
  const base = {
    id: 's1',
    title: 'The International Splash Awards',
    startTime: '2026-09-29T18:00:00Z',
    endTime: '2026-09-29T20:00:00Z',
    location: 'Ballroom',
  };
  const opts = {
    timezone: 'Europe/Amsterdam',
    place: 'Rotterdam Ahoy, Rotterdam',
    coords: { lat: 51.8858, lon: 4.4889 },
    uidBase: 'events/drupalcon/eu/2026-rotterdam.json',
  };

  it('uses the event venue when the session has none', () => {
    const [ev] = scheduleSessionsToCalEvents([base], opts);
    expect(ev.location).toBe('Ballroom · Rotterdam Ahoy, Rotterdam');
    expect(ev.geo).toEqual({ lat: 51.8858, lon: 4.4889, label: ev.location });
  });

  it('replaces the event venue rather than appending to it', () => {
    const [ev] = scheduleSessionsToCalEvents(
      [{ ...base, venue: { name: 'SS Rotterdam', address: '3e Katendrechtse Hoofd 25' } }],
      opts,
    );
    expect(ev.location).toBe('Ballroom · SS Rotterdam, 3e Katendrechtse Hoofd 25');
    expect(ev.location).not.toContain('Ahoy');
  });

  it('drops the pin entirely when an offsite venue has no coordinates', () => {
    // The event's coordinates would be a confident marker on the wrong building.
    const [ev] = scheduleSessionsToCalEvents([{ ...base, venue: { name: 'SS Rotterdam' } }], opts);
    expect(ev.geo).toBeUndefined();
  });

  it('uses the offsite coordinates when it has them', () => {
    const [ev] = scheduleSessionsToCalEvents(
      [{ ...base, venue: { name: 'SS Rotterdam', latitude: 51.8968, longitude: 4.4787 } }],
      opts,
    );
    expect(ev.geo.lat).toBe(51.8968);
    expect(ev.geo.lon).toBe(4.4787);
  });

  it('carries the venue link and its note', () => {
    const [ev] = scheduleSessionsToCalEvents(
      [
        {
          ...base,
          venue: {
            name: 'SS Rotterdam',
            url: 'https://ssrotterdam.nl',
            note: 'Ticketed separately',
          },
        },
      ],
      opts,
    );
    expect(ev.url).toBe('https://ssrotterdam.nl');
    expect(ev.description).toContain('Ticketed separately');
  });

  it('ignores a venue with a blank name, rather than losing the event venue', () => {
    const [ev] = scheduleSessionsToCalEvents([{ ...base, venue: { name: '  ' } }], opts);
    expect(ev.location).toBe('Ballroom · Rotterdam Ahoy, Rotterdam');
  });
});
