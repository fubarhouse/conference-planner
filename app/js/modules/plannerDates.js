// @ts-check
// Pure date helpers for the planner. No DOM or planner state — the event
// timezone-aware formatters (fmtDate/fmtTime/groupByDate) stay in planner.js
// because they read the active event's timezone. planner.js injects these into
// the feature modules that need them.

// The Wednesday of the same Mon–Sun week as `dateStr` (YYYY-MM-DD). Used as a
// stable weekly bucket for the summary chart time axis.
/**
 * @param {string} dateStr
 * @returns {string} YYYY-MM-DD
 */
export function toWednesdayOfWeek(dateStr) {
  const d = new Date(dateStr.length === 10 ? `${dateStr}T00:00:00Z` : dateStr);
  const offset = 3 - d.getUTCDay(); // range [-3..3]; gives Wednesday of the same Mon-Sun week
  const wed = new Date(d);
  wed.setUTCDate(d.getUTCDate() + offset);
  return wed.toISOString().slice(0, 10);
}

// The arrival date for a travel leg that lands the next day: returns the day
// after `departDate` when the arrival time is earlier than departure, else ''.
/**
 * @param {string} departDate
 * @param {string} departTime
 * @param {string} arriveTime
 * @returns {string}
 */
export function autoArriveDate(departDate, departTime, arriveTime) {
  if (!departDate || !departTime || !arriveTime) return '';
  if (arriveTime >= departTime) return '';
  const d = new Date(departDate + 'T12:00:00');
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

// Local (not UTC) YYYY-MM-DD for a Date, used when iterating calendar days.
/**
 * @param {Date} d
 * @returns {string} YYYY-MM-DD
 */
export function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
