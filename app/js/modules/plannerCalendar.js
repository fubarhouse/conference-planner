// Pure calendar export for planner entities (itinerary items, org/team events,
// travel legs, accommodation). Every entity is first normalised into a common
// `calEvent` shape, then rendered to an .ics VEVENT or a Google Calendar URL.
//
// A calEvent may carry a `timezone` (IANA zone): its wall-clock times are then
// interpreted in that zone and emitted as absolute UTC (trailing Z), so the event
// lands at the correct real-world moment regardless of the viewer's device zone.
// With NO timezone the times stay FLOATING (no Z) — the old behaviour, kept as the
// fallback when no zone is known. All-day entities use VALUE=DATE (never zoned).
//
// calEvent shape:
//   { title, start: {date, time}, end: {date, time}|null, allDay, location,
//     description, timezone? }
// where `date` is 'YYYY-MM-DD', `time` is 'HH:MM' or '' (empty ⇒ all-day), and
// `timezone` is an IANA name (e.g. 'Europe/Amsterdam') or '' for floating.

import { TRAVEL_MODES } from './plannerTravel.js';

// Default length for a point-in-time entity (itinerary item / org event) that
// has a start time but no explicit end.
const DEFAULT_EVENT_MINUTES = 60;

const pad2 = (n) => String(n).padStart(2, '0');

function escapeIcsText(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

// 'YYYY-MM-DD' → 'YYYYMMDD'
function icsDate(date) {
  return String(date || '').replace(/-/g, '');
}

// {date:'YYYY-MM-DD', time:'HH:MM'} → floating 'YYYYMMDDTHHMMSS'
function icsDateTime({ date, time }) {
  const [h = '00', m = '00'] = String(time || '').split(':');
  return `${icsDate(date)}T${pad2(h)}${pad2(m)}00`;
}

// Add `mins` to a {date,time} using UTC arithmetic (no local-tz drift), rolling
// across midnight when needed. Returns a fresh {date, time}.
export function addMinutes({ date, time }, mins) {
  const [y, mo, d] = String(date).split('-').map(Number);
  const [h = 0, mi = 0] = String(time || '00:00')
    .split(':')
    .map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi) + mins * 60000);
  return {
    date: `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`,
    time: `${pad2(t.getUTCHours())}:${pad2(t.getUTCMinutes())}`,
  };
}

// Offset in ms that `tz` (an IANA zone) is ahead of UTC at a given UTC instant.
// Returns null if the zone is unknown, so callers can fall back to floating time.
function zoneOffsetMs(tz, instantMs) {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const map = {};
    for (const p of dtf.formatToParts(new Date(instantMs))) {
      if (p.type !== 'literal') map[p.type] = p.value;
    }
    let hour = Number(map.hour);
    if (hour === 24) hour = 0; // some engines emit '24' for midnight
    const asUtc = Date.UTC(
      Number(map.year),
      Number(map.month) - 1,
      Number(map.day),
      hour,
      Number(map.minute),
      Number(map.second),
    );
    return asUtc - instantMs;
  } catch {
    return null;
  }
}

// A wall-clock {date,time} interpreted in IANA `tz` → the absolute instant as a
// compact UTC iCal stamp 'YYYYMMDDTHHMMSSZ'. With no (or an unknown) tz it returns
// the FLOATING form 'YYYYMMDDTHHMMSS' (device-local) — preserving old behaviour so
// a trip with no known timezone still works.
function icsInstant({ date, time }, tz) {
  if (!tz) return icsDateTime({ date, time });
  const [y, mo, d] = String(date).split('-').map(Number);
  const [h = 0, mi = 0] = String(time || '00:00')
    .split(':')
    .map(Number);
  const wallAsUtc = Date.UTC(y, mo - 1, d, h, mi, 0);
  const off = zoneOffsetMs(tz, wallAsUtc);
  if (off === null) return icsDateTime({ date, time });
  const inst = new Date(wallAsUtc - off);
  return (
    `${inst.getUTCFullYear()}${pad2(inst.getUTCMonth() + 1)}${pad2(inst.getUTCDate())}` +
    `T${pad2(inst.getUTCHours())}${pad2(inst.getUTCMinutes())}${pad2(inst.getUTCSeconds())}Z`
  );
}

// The exclusive DTEND for an all-day span: iCalendar all-day DTEND is the day
// AFTER the last day, so a single-day event ends the next day and a stay ending
// on checkout is correct as-is (you leave that morning).
// Returns the compact 'YYYYMMDD' of the day after `date`.
function nextDay(date) {
  return icsDate(addMinutes({ date, time: '00:00' }, 24 * 60).date);
}

// ── Normalisers (entity → calEvent) ──────────────────────────────────────────

// Itinerary items and org/team events share one shape: title + date + optional
// time + optional location. No time ⇒ all-day.
// `timezone` (fallback, usually the trip's) makes the times absolute; an item's own
// `item.timezone` overrides it (for a stop in a different zone whose location can't
// be auto-resolved). With neither, times stay floating (device-local).
export function itineraryItemToCalEvent(item, { timezone = '' } = {}) {
  if (!item?.date) return null;
  const title = String(item.title || item.name || 'Itinerary item').trim();
  const time = String(item.time || '').trim();
  const endTime = String(item.endTime || '').trim();
  return {
    title,
    start: { date: item.date, time },
    // An explicit finishing time gives the event a real end; without one, buildVevent
    // falls back to a default duration. Only meaningful for timed (non-all-day) items.
    end: time && endTime ? { date: item.date, time: endTime } : null,
    allDay: !time,
    location: String(item.location || '').trim(),
    // Carry the item's notes/description into the event body so they land in the .ics
    // DESCRIPTION and the Google Calendar details.
    description: String(item.notes || item.description || '').trim(),
    timezone: String(item.timezone || timezone || '').trim(),
  };
}

export const orgEventToCalEvent = itineraryItemToCalEvent;

// A travel leg → a timed (or all-day) journey event. Start = departure, end =
// arrival (falling back to the departure date when no arrival date is set).
// `includeRefs` controls whether booking references (Ref / Confirmation numbers)
// go into the event body. On for a deliberate local download; OFF for the public
// subscription feed, so a leaked feed link can't expose PNRs / booking numbers.
export function legToCalEvent(leg, { direction, includeRefs = true } = {}) {
  if (!leg?.date) return null;
  const modeLabel = (TRAVEL_MODES[leg.mode]?.label || leg.mode || 'Travel')
    .replace(/^\S+\s/, '') // strip the leading emoji
    .trim();
  const route = [leg.from, leg.to].filter(Boolean).join(' → ');
  const title = route ? `${modeLabel}: ${route}` : modeLabel;
  const departTime = String(leg.departTime || '').trim();
  const arriveTime = String(leg.arriveTime || '').trim();
  const description = [
    includeRefs && leg.ref ? `Ref: ${leg.ref}` : '',
    includeRefs && leg.confirmation ? `Confirmation: ${leg.confirmation}` : '',
    direction ? `Direction: ${direction}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return {
    title,
    start: { date: leg.date, time: departTime },
    end: departTime ? { date: leg.arriveDate || leg.date, time: arriveTime || departTime } : null,
    allDay: !departTime,
    location: String(leg.from || '').trim(),
    description,
  };
}

// Accommodation → a single multi-day all-day "Stay" event spanning check-in to
// check-out. Returns null unless at least a check-in date is present.
export function accommodationToCalEvent(stay) {
  const checkIn = String(stay?.checkIn || '').trim();
  if (!checkIn) return null;
  const checkOut = String(stay?.checkOut || '').trim() || checkIn;
  const name = String(stay.name || 'Accommodation').trim();
  return {
    title: `Stay: ${name}`,
    start: { date: checkIn, time: '' },
    end: { date: checkOut, time: '' },
    allDay: true,
    location: String(stay.location || '').trim(),
    description: '',
  };
}

// A tracked programme session → calEvent. Sessions store ABSOLUTE ISO start/end
// times, so we read their wall-clock in the event's timezone and tag that zone —
// buildVevent then re-emits the correct UTC instant (the simplest adapter: no
// wall-clock guessing, the times are already unambiguous).
export function sessionToCalEvent(session, { timezone = '' } = {}) {
  if (!session?.startTime) return null;
  const toDT = (iso) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return {
      date: d.toLocaleDateString('en-CA', timezone ? { timeZone: timezone } : {}),
      time: d.toLocaleTimeString('en-GB', {
        ...(timezone ? { timeZone: timezone } : {}),
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }),
    };
  };
  const start = toDT(session.startTime);
  if (!start) return null;
  const speakers = (session.speakers || [])
    .map((sp) => (typeof sp === 'string' ? sp : sp?.name))
    .filter(Boolean);
  const link = String(session.link || '').trim();
  const video = String(session.video_url || '').trim();
  // Build a readable description: abstract, then who's speaking, track, and links —
  // so the calendar item is more than a title (full_description is the real field).
  const parts = [];
  const body = String(
    session.full_description || session.description || session.abstract || '',
  ).trim();
  if (body) parts.push(body);
  if (speakers.length)
    parts.push(`${speakers.length > 1 ? 'Speakers' : 'Speaker'}: ${speakers.join(', ')}`);
  if (session.track) parts.push(`Track: ${String(session.track).trim()}`);
  if (link) parts.push(link);
  if (video && video !== link) parts.push(`Recording: ${video}`);
  return {
    title: String(session.title || 'Session').trim(),
    start,
    end: session.endTime ? toDT(session.endTime) : null,
    allDay: false,
    location: String(session.location || '').trim(),
    description: parts.join('\n\n'),
    url: link || video,
    timezone: String(timezone || '').trim(),
  };
}

// Map raw session items → rich calEvents for a WHOLE-EVENT schedule, shared by the
// server subscription feed AND the client "export selected" download so both stay
// identical. Composes LOCATION as "room · venue, city", attaches the event's map
// coords (a session's own lat/lon wins if a dataset ever provides them), and stamps
// a stable UID (`session-<id>@<uidBase>`) so downloaded + subscribed copies of the
// same session reconcile in the calendar instead of duplicating.
export function scheduleSessionsToCalEvents(
  sessions,
  { timezone = '', place = '', coords = null, uidBase = '' } = {},
) {
  return (sessions || [])
    .map((s) => {
      const ev = sessionToCalEvent(s, { timezone });
      if (!ev) return null;
      const room = ev.location;
      // A session can be somewhere else entirely — the Splash Awards in a theatre
      // across town, a sprint in a sponsor's office. `venue` on the session says
      // so, and then the event's own place must NOT be appended: "SS Rotterdam ·
      // Rotterdam Ahoy" would name two buildings and send people to the wrong one.
      const off = s.venue && String(s.venue.name || '').trim() ? s.venue : null;
      const where = off ? [off.name, off.address].filter(Boolean).join(', ') : place;
      ev.location = [room, where].filter(Boolean).join(' · ') || room || where;
      // Coordinates follow the same rule: an offsite session uses its own, and if
      // it has none it gets NO pin. Inheriting the event's would put a map marker
      // on the wrong building with every appearance of being right — worse than
      // leaving the subscriber to search the name themselves.
      const c = off
        ? Number.isFinite(off.latitude) && Number.isFinite(off.longitude)
          ? { lat: off.latitude, lon: off.longitude }
          : null
        : Number.isFinite(s.latitude) && Number.isFinite(s.longitude)
          ? { lat: s.latitude, lon: s.longitude }
          : coords;
      if (c) ev.geo = { lat: c.lat, lon: c.lon, label: ev.location || where };
      // The venue's own page is worth carrying: a subscriber who cannot find the
      // door wants the link, not the address they already failed to find.
      if (off?.url && !ev.url) ev.url = off.url;
      if (off?.note) ev.description = [ev.description, off.note].filter(Boolean).join('\n\n');
      ev.uid = `session-${s.id || ''}@${uidBase}`;
      return ev;
    })
    .filter(Boolean);
}

// Aggregate a personal trip into calEvents for a whole-trip .ics — travel legs,
// stays, itinerary items, hosted events, and tracked sessions. `include` toggles
// each category (all on by default). Each calEvent carries a stable `uid`
// (`<entity>@<planner-uuid>`) so re-imports/subscriptions update rather than
// duplicate. Pure — the caller supplies the resolved sessions + timezone.
export function buildTripCalEvents(
  planner,
  { allSessions = [], timezone = '', include = {}, redactRefs = false } = {},
) {
  const personal = planner?.personal || {};
  const ns = planner?._id || 'planner';
  const inc = { travel: true, stays: true, items: true, hosted: true, sessions: true, ...include };
  const legOpts = (direction) => ({ direction, includeRefs: !redactRefs });
  const out = [];
  const add = (ev, uidBase) => {
    if (ev) out.push({ ...ev, uid: `${uidBase}@${ns}` });
  };

  if (inc.travel) {
    (personal.outboundLegs || []).forEach((l) =>
      add(legToCalEvent(l, legOpts('Outbound')), `leg-${l.id}`),
    );
    (personal.returnLegs || []).forEach((l) =>
      add(legToCalEvent(l, legOpts('Return')), `leg-${l.id}`),
    );
    (personal.showLocalTravel ? personal.localLegs || [] : []).forEach((l) =>
      add(legToCalEvent(l, legOpts('Local')), `leg-${l.id}`),
    );
  }
  if (inc.stays)
    (personal.accommodations || []).forEach((a) =>
      add(accommodationToCalEvent(a), `accom-${a.id}`),
    );
  if (inc.items)
    (personal.itinerary || []).forEach((it) =>
      add(itineraryItemToCalEvent(it, { timezone }), `item-${it.id}`),
    );
  if (inc.hosted)
    (personal.hostedEvents || []).forEach((he) =>
      add(
        itineraryItemToCalEvent({ ...he, notes: he.description }, { timezone }),
        `hosted-${he.id}`,
      ),
    );
  if (inc.sessions)
    (personal.trackedSessions || []).forEach((ts) => {
      const s = allSessions.find((x) => x.id === ts.sessionId);
      if (s) add(sessionToCalEvent(s, { timezone }), `session-${ts.sessionId}`);
    });

  return out;
}

// ── ICS builders ─────────────────────────────────────────────────────────────

// One VEVENT from a calEvent. `alarmMinutes > 0` embeds a local VALARM reminder.
export function buildVevent(calEvent, { uid, dtStamp, alarmMinutes = 0 } = {}) {
  const stamp = dtStamp || `${icsDateTime({ date: nowDate(), time: nowTime() })}Z`;
  const lines = ['BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${stamp}`];

  if (calEvent.allDay) {
    const endDate = calEvent.end?.date ? nextDay(calEvent.end.date) : nextDay(calEvent.start.date);
    lines.push(`DTSTART;VALUE=DATE:${icsDate(calEvent.start.date)}`);
    lines.push(`DTEND;VALUE=DATE:${endDate}`);
  } else {
    const end = calEvent.end || addMinutes(calEvent.start, DEFAULT_EVENT_MINUTES);
    const tz = calEvent.timezone;
    lines.push(`DTSTART:${icsInstant(calEvent.start, tz)}`);
    lines.push(`DTEND:${icsInstant(end, tz)}`);
  }

  lines.push(`SUMMARY:${escapeIcsText(calEvent.title)}`);
  if (calEvent.location) lines.push(`LOCATION:${escapeIcsText(calEvent.location)}`);
  if (calEvent.description) lines.push(`DESCRIPTION:${escapeIcsText(calEvent.description)}`);
  // URL value is a URI, not TEXT — don't comma/semicolon-escape it.
  if (calEvent.url) lines.push(`URL:${String(calEvent.url).replace(/[\r\n]+/g, '')}`);
  const geo = calEvent.geo;
  if (geo && Number.isFinite(geo.lat) && Number.isFinite(geo.lon)) {
    lines.push(`GEO:${geo.lat};${geo.lon}`);
    // Apple Calendar shows a real map pin from this structured-location property.
    const label = String(geo.label || calEvent.location || calEvent.title || '')
      .replace(/["\r\n]+/g, '')
      .trim();
    lines.push(
      `X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-ADDRESS="${label}";X-APPLE-RADIUS=100;X-TITLE="${label}":geo:${geo.lat},${geo.lon}`,
    );
  }
  if (alarmMinutes > 0) {
    lines.push(
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapeIcsText(calEvent.title)}`,
      `TRIGGER:-PT${Math.round(alarmMinutes)}M`,
      'END:VALARM',
    );
  }
  lines.push('END:VEVENT');
  return lines.map(foldIcsLine).join('\r\n');
}

// Fold content lines to ≤75 octets per RFC 5545 (CRLF + a leading space continues
// the line). We fold on a slightly conservative char boundary so multi-byte UTF-8
// stays safely under the octet limit for the lenient clients we target.
function foldIcsLine(line) {
  if (line.length <= 72) return line;
  const out = [];
  let rest = line;
  out.push(rest.slice(0, 72));
  rest = rest.slice(72);
  while (rest.length) {
    out.push(rest.slice(0, 71));
    rest = rest.slice(71);
  }
  return out.join('\r\n ');
}

// An iCalendar DURATION for whole minutes — `PT6H` when it divides into hours,
// else `PT90M`. Used for the subscription refresh hints.
function icsDuration(minutes) {
  const m = Math.max(1, Math.round(minutes));
  return m % 60 === 0 ? `PT${m / 60}H` : `PT${m}M`;
}

// A full VCALENDAR wrapping one or more calEvents. `uidFor(calEvent, index)`
// supplies each VEVENT's UID. `refreshMinutes > 0` adds the subscription
// auto-refresh hints (Apple/Outlook honour REFRESH-INTERVAL / X-PUBLISHED-TTL;
// Google ignores them and polls on its own schedule) — set only for the live feed.
export function buildIcsCalendar(
  calEvents,
  { calName = 'Trip', uidFor, alarmMinutes = 0, refreshMinutes = 0 } = {},
) {
  const vevents = calEvents
    .map((ev, i) => buildVevent(ev, { uid: uidFor ? uidFor(ev, i) : `${i}@planner`, alarmMinutes }))
    .join('\r\n');
  const refresh =
    refreshMinutes > 0
      ? [
          `REFRESH-INTERVAL;VALUE=DURATION:${icsDuration(refreshMinutes)}`,
          `X-PUBLISHED-TTL:${icsDuration(refreshMinutes)}`,
        ]
      : [];
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:-//conference-planner//${escapeIcsText(calName)}//EN`,
    `X-WR-CALNAME:${escapeIcsText(calName)}`,
    ...refresh,
    vevents,
    'END:VCALENDAR',
  ].join('\r\n');
}

// ── Google Calendar ──────────────────────────────────────────────────────────

// A Google Calendar "create event" URL for a single calEvent. All-day events use
// the date-only range (end exclusive, matching Google's convention).
export function googleCalendarUrl(calEvent) {
  let dates;
  if (calEvent.allDay) {
    const end = calEvent.end?.date ? nextDay(calEvent.end.date) : nextDay(calEvent.start.date);
    dates = `${icsDate(calEvent.start.date)}/${end}`;
  } else {
    const end = calEvent.end || addMinutes(calEvent.start, DEFAULT_EVENT_MINUTES);
    const tz = calEvent.timezone;
    dates = `${icsInstant(calEvent.start, tz)}/${icsInstant(end, tz)}`;
  }
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: calEvent.title || 'Event',
    dates,
  });
  if (calEvent.description) params.set('details', calEvent.description);
  if (calEvent.location) params.set('location', calEvent.location);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

// now helpers kept tiny + injectable-free; only used for DTSTAMP.
function nowDate() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}
function nowTime() {
  const d = new Date();
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}
