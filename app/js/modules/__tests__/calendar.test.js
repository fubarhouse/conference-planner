import { describe, it, expect } from 'vitest';
// The schedule download now shares the calendar builders with the subscription feed
// (DRY). Its logic lives in plannerCalendar.js — these tests cover the shared
// session→calEvent mapper + the rich VEVENT it produces for a downloaded schedule.
import {
  scheduleSessionsToCalEvents,
  buildIcsCalendar,
  googleCalendarUrl,
} from '../plannerCalendar.js';

const session = {
  id: 'keynote-1',
  title: 'Driesnote',
  startTime: '2026-10-01T09:00:00Z',
  endTime: '2026-10-01T10:00:00Z',
  location: 'Hall A',
  link: 'https://example.com/s/keynote-1',
  track: 'Keynotes',
  speakers: ['Dries Buytaert'],
  full_description: 'The opening keynote.',
};
const opts = {
  timezone: 'Europe/Amsterdam',
  place: 'Ahoy, Rotterdam',
  coords: { lat: 51.9, lon: 4.48 },
  uidBase: 'events/eu/2026-rotterdam.json',
};

describe('scheduleSessionsToCalEvents', () => {
  it('composes "room · venue, city" and attaches the event map coords', () => {
    const [ev] = scheduleSessionsToCalEvents([session], opts);
    expect(ev.location).toBe('Hall A · Ahoy, Rotterdam');
    expect(ev.geo).toEqual({ lat: 51.9, lon: 4.48, label: 'Hall A · Ahoy, Rotterdam' });
    expect(ev.uid).toBe('session-keynote-1@events/eu/2026-rotterdam.json');
  });

  it('builds a rich description (abstract + speaker + track + link)', () => {
    const [ev] = scheduleSessionsToCalEvents([session], opts);
    expect(ev.description).toContain('The opening keynote.');
    expect(ev.description).toContain('Speaker: Dries Buytaert');
    expect(ev.description).toContain('Track: Keynotes');
    expect(ev.description).toContain('https://example.com/s/keynote-1');
    expect(ev.url).toBe('https://example.com/s/keynote-1');
  });

  it("prefers a session's own coords over the event's", () => {
    const [ev] = scheduleSessionsToCalEvents([{ ...session, latitude: 1, longitude: 2 }], opts);
    expect(ev.geo).toMatchObject({ lat: 1, lon: 2 });
  });

  it('omits geo when neither the session nor the event has coords', () => {
    const [ev] = scheduleSessionsToCalEvents([session], { ...opts, coords: null });
    expect(ev.geo).toBeUndefined();
  });
});

describe('downloaded schedule .ics (buildIcsCalendar over the mapped events)', () => {
  const ics = buildIcsCalendar(scheduleSessionsToCalEvents([session], opts), {
    calName: 'DrupalCon Rotterdam 2026',
    uidFor: (ev) => ev.uid,
    alarmMinutes: 10,
  });

  it('wraps a VCALENDAR with the name and the shared UID', () => {
    expect(ics.startsWith('BEGIN:VCALENDAR')).toBe(true);
    expect(ics.trimEnd().endsWith('END:VCALENDAR')).toBe(true);
    expect(ics).toContain('X-WR-CALNAME:DrupalCon Rotterdam 2026');
    expect(ics).toContain('UID:session-keynote-1@events/eu/2026-rotterdam.json');
  });

  it('emits UTC times, LOCATION, URL, GEO, the Apple map pin, and a VALARM', () => {
    expect(ics).toContain('DTSTART:20261001T090000Z');
    expect(ics).toContain('LOCATION:Hall A · Ahoy\\, Rotterdam');
    expect(ics).toContain('URL:https://example.com/s/keynote-1');
    expect(ics).toContain('GEO:51.9;4.48');
    expect(ics).toContain('X-APPLE-STRUCTURED-LOCATION');
    expect(ics).toContain('BEGIN:VALARM');
    expect(ics).toContain('TRIGGER:-PT10M');
  });
});

describe('googleCalendarUrl (schedule "add to Google")', () => {
  it('carries the rich description + composed location', () => {
    const [ev] = scheduleSessionsToCalEvents([session], opts);
    const url = googleCalendarUrl(ev);
    // URLSearchParams encodes spaces as '+' — normalise before asserting.
    const decoded = decodeURIComponent(url).replace(/\+/g, ' ');
    expect(url).toContain('calendar.google.com');
    expect(decoded).toContain('Track: Keynotes');
    expect(decoded).toContain('Hall A · Ahoy, Rotterdam');
  });
});
