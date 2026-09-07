// Builds the personal day-by-day agenda: travel legs, accommodation check
// in/out, tracked sessions, and personal itinerary items, grouped by date and
// sorted within each day. Pure — planner.js passes the personal record, the
// event sessions, the event timezone, and its timezone-aware `fmtTime`.

import { travelIcon } from './plannerTravel.js';
import { conferenceSpanDays, conferenceName } from './plannerConferenceBand.js';
import { accommodationGaps } from './plannerConflicts.js';

/**
 * @param {object} deps
 * @param {*} deps.personal - state.planner.personal (or undefined)
 * @param {any[]} [deps.allSessions] - all event sessions (for tracked sessions)
 * @param {string} [deps.timezone] - event timezone for date bucketing
 * @param {(iso: string) => string} deps.fmtTime - formats a session start time
 * @param {*} [deps.eventMeta] - the primary associated event (single-event callers)
 * @param {{ meta: any }[]} [deps.events] - all associated events (multi-event: a banner per event)
 * @param {boolean} [deps.isConference] - whether this trip is a conference (top-level planner flag)
 * @returns {{ date: string, label: string, events: any[] }[]}
 */
export function buildDayItinerary({
  personal,
  allSessions = [],
  timezone,
  fmtTime,
  eventMeta,
  events,
  isConference,
}) {
  if (!personal) return [];

  /** @type {Record<string, any[]>} */
  const days = {};
  const addDay = (date, event) => {
    if (!date) return;
    (days[date] ??= []).push(event);
  };

  // Each associated conference (when applicable) gets a banner on every one of its
  // days, so the event(s) show up in the day-by-day plan even before you track
  // sessions. A trip may span several co-located conferences.
  if (isConference !== false) {
    const metas = (events && events.length ? events.map((e) => e.meta) : [eventMeta]).filter(
      Boolean,
    );
    for (const meta of metas) {
      const name = conferenceName(meta);
      for (const date of conferenceSpanDays(meta)) {
        addDay(date, {
          time: '',
          sortTime: '00:00',
          icon: 'fas fa-users',
          label: name,
          sub: meta.location || '',
          type: 'conference',
        });
      }
    }
  }

  // Travel legs — outbound, return, and (opt-in) local "getting around" trips
  [
    ...(personal.outboundLegs || []).map((l) => ({ l, dir: 'Outbound', code: 'outbound' })),
    ...(personal.returnLegs || []).map((l) => ({ l, dir: 'Return', code: 'return' })),
    ...(personal.showLocalTravel ? personal.localLegs || [] : []).map((l) => ({
      l,
      dir: 'Around',
      code: 'local',
    })),
  ].forEach(({ l, dir, code }) => {
    const icon = travelIcon(l.mode, dir === 'Return'); // direction-aware, matching the timeline
    if (l.date)
      addDay(l.date, {
        time: l.departTime || '',
        icon,
        label: `${dir}: ${l.from || '?'} → ${l.to || '?'}`,
        sub: l.confirmation ? `Ref: ${l.confirmation}` : l.status || '',
        type: 'travel',
        legId: l.id, // enables the "add to calendar" button on the itinerary
        legDir: code, // 'outbound' | 'return' | 'local' — matches legToCalEvent resolution
      });
    if (l.arriveDate && l.arriveDate !== l.date)
      addDay(l.arriveDate, {
        time: l.arriveTime || '',
        icon: 'fas fa-location-dot',
        label: `Arrives: ${l.to || '?'}`,
        sub: '',
        type: 'travel',
      });
  });

  // Accommodation
  (personal.accommodations || []).forEach((a) => {
    const meStay = (a.assignments || []).find((s) => s.memberId === '__me__');
    const checkIn = meStay?.checkIn || a.checkIn;
    const checkOut = meStay?.checkOut || a.checkOut;
    if (checkIn)
      addDay(checkIn, {
        time: '',
        sortTime: '23:59',
        icon: 'fas fa-bed',
        label: `Check-in: ${a.name || 'Accommodation'}`,
        sub: a.address || '',
        type: 'accom',
        accomId: a.id,
      });
    if (checkOut)
      addDay(checkOut, {
        time: '',
        sortTime: '00:00',
        icon: 'fas fa-suitcase-rolling',
        label: `Check-out: ${a.name || 'Accommodation'}`,
        sub: '',
        type: 'accom',
        accomId: a.id,
      });
    // Waypoints / ports of call along a multi-stop stay (e.g. a cruise). Skip the
    // embark/disembark stops that fall on the check-in/out days — those are already
    // shown by the check-in/out rows, so only the intermediate ports remain.
    const boarding = String(checkIn || '').slice(0, 10);
    const leaving = String(checkOut || '').slice(0, 10);
    (a.stops || []).forEach((s) => {
      const date = String(s.date || '').slice(0, 10);
      if (!date || date === boarding || date === leaving) return;
      addDay(date, {
        time: s.time || '',
        icon: 'fas fa-anchor',
        label: `Port: ${s.location || 'Stop'}`,
        sub: s.notes || '',
        type: 'accom',
        accomId: a.id,
      });
    });
  });

  // Tracked sessions
  (personal.trackedSessions || []).forEach((ts) => {
    const sess = allSessions.find((s) => s.id === ts.sessionId);
    if (!sess?.startTime) return;
    const date = new Date(sess.startTime).toLocaleDateString('en-CA', { timeZone: timezone });
    addDay(date, {
      time: fmtTime(sess.startTime),
      icon: 'fas fa-microphone-lines',
      label: sess.title,
      sub: sess.location || '',
      type: 'session',
      sessionId: ts.sessionId,
    });
  });

  // Tickets you hold, shown on each of their dated days — but only when explicitly
  // opted in (`showOnItinerary`). This keeps conference passes off the agenda (the
  // conference banner already covers those days) while letting standalone events
  // like a workshop or gala surface.
  (personal.tickets || [])
    .filter(
      (t) =>
        t.showOnItinerary &&
        (!t.assignedTo || t.assignedTo === '__me__') &&
        Array.isArray(t.days) &&
        t.days.length,
    )
    .forEach((t) => {
      t.days.forEach((date) => {
        addDay(String(date).slice(0, 10), {
          time: '',
          sortTime: '00:30',
          icon: 'fas fa-ticket',
          label: t.name || 'Ticket',
          sub: '',
          type: 'ticket',
          ticketId: t.id,
        });
      });
    });

  // Hosted events — things you run during the conference (booth demos, customer
  // meetings), often scheduled alongside a programme session. Managed on the My
  // Schedule tab; surfaced here (read-only) so they sit on the day-by-day plan.
  (personal.hostedEvents || []).forEach((he) => {
    if (!he.date) return;
    addDay(he.date, {
      id: he.id,
      time: he.time || '',
      icon: 'fas fa-bullhorn',
      label: he.title || 'Hosted event',
      sub: [he.location, he.anchorTitle ? `alongside ${he.anchorTitle}` : '']
        .filter(Boolean)
        .join(' · '),
      type: 'hosted',
      memberIds: he.memberIds || [],
      done: !!he.done,
    });
  });

  // Personal itinerary items
  (personal.itinerary || []).forEach((item) => {
    if (!item.date) return;
    addDay(item.date, {
      id: item.id,
      time: item.time || '',
      icon: 'fas fa-calendar-check',
      label: item.title || 'Event',
      sub: item.location || '',
      type: 'item',
      memberIds: item.memberIds || [],
      done: !!item.done,
    });
  });

  // Nights inside the trip with no accommodation booked — a placeholder row so the
  // gap is visible in the day view, with a CTA to add a stay covering it.
  accommodationGaps(personal).forEach(({ date, checkOut }) => {
    addDay(date, {
      time: '',
      sortTime: '23:58', // near the bottom of the day, above a check-in row
      icon: 'fas fa-bed',
      label: 'No accommodation booked',
      type: 'gap',
      checkIn: date,
      checkOut,
    });
  });

  // Fill in every day between the first and last dated signal, so a day with nothing
  // planned still appears (rendered as a free day) — a continuous day-by-day view
  // rather than one that silently skips blanks.
  const active = Object.keys(days).sort();
  if (active.length) {
    const cur = new Date(active[0] + 'T12:00:00');
    const end = new Date(active[active.length - 1] + 'T12:00:00');
    let guard = 0;
    while (cur <= end && guard++ < 800) {
      const iso = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(
        cur.getDate(),
      ).padStart(2, '0')}`;
      days[iso] ??= [];
      cur.setDate(cur.getDate() + 1);
    }
  }

  return Object.keys(days)
    .sort()
    .map((date) => ({
      date,
      label: new Date(date + 'T12:00:00').toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      }),
      events: days[date].sort((a, b) =>
        (a.sortTime || a.time || '99:99') < (b.sortTime || b.time || '99:99') ? -1 : 1,
      ),
    }));
}
