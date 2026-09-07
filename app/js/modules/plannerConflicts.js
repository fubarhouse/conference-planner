// Detects scheduling problems in a personal trip: return travel that precedes
// outbound arrival, invalid accommodation date ranges, and nights within the
// trip window that have no accommodation booked. Pure — planner.js passes the
// personal record and renders the returned {sev, msg} list.

import { localDateStr } from './plannerDates.js';

// A well-formed calendar date: 'YYYY-MM-DD' that round-trips through Date (so a
// corrupt value like '2-09-23' or '2026-13-40' is rejected). Guards every place
// that does date arithmetic — a bad date would otherwise sort as the earliest and
// blow the per-night loop out to hundreds of thousands of iterations.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function okDate(s) {
  if (typeof s !== 'string' || !ISO_DATE.test(s)) return false;
  const d = new Date(s + 'T12:00:00');
  return !Number.isNaN(d.getTime()) && localDateStr(d) === s;
}
// Prefer a leg's arrival date, but only when it's itself a valid date.
const arriveOrDate = (l) => (okDate(l.arriveDate) ? l.arriveDate : l.date);

// The nights inside the destination-stay window that have no accommodation booked
// (and aren't covered by overnight travel). Each entry carries `checkOut` — the
// date its contiguous gap run ends — so a single booking can fill the whole run.
// Shared by the conflict warning and the itinerary/banner "Add stay" CTAs.
/**
 * @param {*} personal - state.planner.personal (or undefined)
 * @returns {{ date: string, checkOut: string }[]}
 */
export function accommodationGaps(personal) {
  if (!personal) return [];
  const outLegs = [...(personal.outboundLegs || [])]
    .filter((l) => okDate(l.date))
    .sort((a, b) => (a.date > b.date ? 1 : -1));
  const retLegs = [...(personal.returnLegs || [])]
    .filter((l) => okDate(l.date))
    .sort((a, b) => (a.date > b.date ? 1 : -1));
  const accomsResolved = (personal.accommodations || [])
    .map((a) => {
      const meStay = (a.assignments || []).find((s) => s.memberId === '__me__');
      return {
        checkIn: meStay?.checkIn || a.checkIn || '',
        checkOut: meStay?.checkOut || a.checkOut || '',
      };
    })
    .filter(({ checkIn, checkOut }) => okDate(checkIn) && okDate(checkOut) && checkIn < checkOut);
  if (!accomsResolved.length || !outLegs.length || !retLegs.length) return [];

  const covered = new Set();
  const addNights = (from, to) => {
    const d = new Date(from + 'T12:00:00');
    const end = new Date(to + 'T12:00:00');
    while (d < end) {
      covered.add(localDateStr(d));
      d.setDate(d.getDate() + 1);
    }
  };
  accomsResolved.forEach(({ checkIn, checkOut }) => addNights(checkIn, checkOut));
  // Overnight travel legs (depart one day, arrive a later day) cover their transit
  // nights — no accommodation is needed while flying or between flights.
  [...outLegs, ...retLegs].forEach((l) => {
    if (okDate(l.date) && okDate(l.arriveDate) && l.date < l.arriveDate)
      addNights(l.date, l.arriveDate);
  });

  // Window where accommodation is actually needed = the destination stay: from the
  // LAST outbound arrival to the FIRST return departure.
  const firstArrival = arriveOrDate(outLegs[outLegs.length - 1]);
  const lastDeparture = retLegs[0].date;
  if (!okDate(firstArrival) || !okDate(lastDeparture) || firstArrival >= lastDeparture) return [];

  const nights = [];
  const d = new Date(firstArrival + 'T12:00:00');
  const end = new Date(lastDeparture + 'T12:00:00');
  while (d < end) {
    nights.push(localDateStr(d));
    d.setDate(d.getDate() + 1);
  }
  // Group uncovered nights into contiguous runs; each night's suggested check-out
  // is the day the run ends (the next covered night, or the departure date).
  const gaps = [];
  for (let i = 0; i < nights.length;) {
    if (covered.has(nights[i])) {
      i += 1;
      continue;
    }
    const runStart = i;
    while (i < nights.length && !covered.has(nights[i])) i += 1;
    const runCheckOut = i < nights.length ? nights[i] : lastDeparture;
    for (let j = runStart; j < i; j += 1) gaps.push({ date: nights[j], checkOut: runCheckOut });
  }
  return gaps;
}

/**
 * @param {*} personal - state.planner.personal (or undefined)
 * @returns {{ sev: 'error' | 'warning', msg: string }[]}
 */
export function detectPersonalConflicts(personal) {
  if (!personal) return [];
  const conflicts = [];

  // Surface any malformed travel/accommodation dates — named by the entity and
  // field they're on — so the user can go straight to the offending record rather
  // than seeing nonsensical downstream warnings.
  const seen = new Set();
  const noteBad = (v, where, field) => {
    if (!v || okDate(v)) return;
    const key = `${where}|${field}|${v}`;
    if (seen.has(key)) return;
    seen.add(key);
    conflicts.push({
      sev: 'error',
      msg: `${where} — ${field} "${v}" is not a valid date (expected YYYY-MM-DD)`,
    });
  };
  const legLabel = (l, dir) => {
    const route = [l.from, l.to].filter(Boolean).join(' → ');
    const mode = l.mode ? l.mode.charAt(0).toUpperCase() + l.mode.slice(1) : 'travel';
    return `${dir} ${mode.toLowerCase()}${route ? ` (${route})` : l.ref ? ` (${l.ref})` : ''}`;
  };
  (personal.outboundLegs || []).forEach((l) => {
    noteBad(l.date, legLabel(l, 'Outbound'), 'departure date');
    noteBad(l.arriveDate, legLabel(l, 'Outbound'), 'arrival date');
  });
  (personal.returnLegs || []).forEach((l) => {
    noteBad(l.date, legLabel(l, 'Return'), 'departure date');
    noteBad(l.arriveDate, legLabel(l, 'Return'), 'arrival date');
  });
  (personal.accommodations || []).forEach((a) => {
    const nm = `"${a.name || 'Accommodation'}"`;
    noteBad(a.checkIn, nm, 'check-in');
    noteBad(a.checkOut, nm, 'check-out');
    (a.stops || []).forEach((s) =>
      noteBad(s.date, `${nm} waypoint "${s.location || 'stop'}"`, 'date'),
    );
    (a.assignments || []).forEach((s) => {
      noteBad(s.checkIn, nm, 'check-in');
      noteBad(s.checkOut, nm, 'check-out');
    });
  });

  const outLegs = [...(personal.outboundLegs || [])]
    .filter((l) => okDate(l.date))
    .sort((a, b) => (a.date > b.date ? 1 : -1));
  const retLegs = [...(personal.returnLegs || [])]
    .filter((l) => okDate(l.date))
    .sort((a, b) => (a.date > b.date ? 1 : -1));

  if (outLegs.length && retLegs.length) {
    const lastOutDate = arriveOrDate(outLegs[outLegs.length - 1]);
    const firstRetDate = retLegs[0].date;
    if (lastOutDate && firstRetDate && firstRetDate < lastOutDate) {
      conflicts.push({
        sev: 'error',
        msg: `Return travel (${firstRetDate}) is before outbound arrives (${lastOutDate})`,
      });
    }
  }

  // Accommodation date ranges that are inverted (check-out not after check-in).
  (personal.accommodations || []).forEach((a) => {
    const meStay = (a.assignments || []).find((s) => s.memberId === '__me__');
    const checkIn = meStay?.checkIn || a.checkIn || '';
    const checkOut = meStay?.checkOut || a.checkOut || '';
    if (okDate(checkIn) && okDate(checkOut) && checkIn >= checkOut) {
      conflicts.push({
        sev: 'error',
        msg: `"${a.name || 'Accommodation'}" check-out (${checkOut}) is not after check-in (${checkIn})`,
      });
    }
  });

  // Nights inside the destination window with no accommodation booked.
  const gaps = accommodationGaps(personal);
  if (gaps.length) {
    const dates = gaps.map((g) => g.date);
    const sample =
      dates.slice(0, 2).join(', ') + (dates.length > 2 ? ` +${dates.length - 2} more` : '');
    conflicts.push({
      sev: 'warning',
      msg: `${dates.length} night${dates.length > 1 ? 's' : ''} without accommodation: ${sample}`,
    });
  }

  return conflicts;
}
