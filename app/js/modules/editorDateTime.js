// @ts-check
// UTC ⇆ timezone-local datetime conversion for the editor's session time fields.
// The form edits wall-clock times in the event's timezone; sessions store UTC
// ISO strings. These functions are pure and deterministic given a timezone, so
// the tricky DST-reconciliation is unit-tested directly. The editor keeps its own
// `safeTimezone`/`buildTimezoneList` (which drive the timezone <select>); here an
// invalid or empty zone simply falls back to UTC.

/**
 * @typedef {{ year: number, month: number, day: number, hour: number, minute: number, second?: number }} LocalParts
 */

/** @type {Map<string, Intl.DateTimeFormat>} */
const _dtfCache = new Map();

/** @param {string} [timeZone] */
function getFormatter(timeZone) {
  const tz = timeZone || 'UTC';
  const cached = _dtfCache.get(tz);
  if (cached) return cached;
  /** @type {Intl.DateTimeFormatOptions} */
  const options = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  };
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone: tz, ...options });
  } catch {
    // Unknown timezone → fall back to UTC (matches the editor's safeTimezone).
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', ...options });
  }
  _dtfCache.set(tz, formatter);
  return formatter;
}

/**
 * @param {number} utcMs
 * @param {string} [timeZone]
 * @returns {LocalParts}
 */
function getLocalPartsFromUtcMs(utcMs, timeZone) {
  const parts = getFormatter(timeZone).formatToParts(new Date(utcMs));
  /** @type {Record<string, string>} */
  const mapped = {};
  for (const part of parts) {
    if (part.type !== 'literal') mapped[part.type] = part.value;
  }
  return {
    year: Number(mapped.year || 0),
    month: Number(mapped.month || 0),
    day: Number(mapped.day || 0),
    hour: Number(mapped.hour || 0),
    minute: Number(mapped.minute || 0),
    second: Number(mapped.second || 0),
  };
}

/**
 * @param {LocalParts} parts
 * @returns {number}
 */
function localPartsToWallMs(parts) {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second || 0,
  );
}

// UTC ISO string → `YYYY-MM-DDTHH:mm` wall-clock value in the given timezone.
/**
 * @param {string} iso
 * @param {string} [timeZone]
 * @returns {string}
 */
export function utcIsoToLocalInput(iso, timeZone) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const p = getLocalPartsFromUtcMs(date.getTime(), timeZone);
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${String(p.year).padStart(4, '0')}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

// Parse a `YYYY-MM-DDTHH:mm` datetime-local value into calendar parts, or null.
/**
 * @param {*} value
 * @returns {LocalParts | null}
 */
export function parseLocalInput(value) {
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!m) return null;
  return {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
    second: 0,
  };
}

// Wall-clock value in a timezone → UTC ISO string. Iterates a few times to settle
// on the UTC instant whose local rendering matches the desired wall time (handles
// DST offsets without a timezone database).
/**
 * @param {string} localValue
 * @param {string} [timeZone]
 * @returns {string}
 */
export function localInputToUtcIso(localValue, timeZone) {
  const desired = parseLocalInput(localValue);
  if (!desired) return '';
  const desiredWallMs = localPartsToWallMs(desired);
  let utcMs = desiredWallMs;

  for (let i = 0; i < 4; i += 1) {
    const actualLocal = getLocalPartsFromUtcMs(utcMs, timeZone);
    const actualWallMs = localPartsToWallMs(actualLocal);
    const diff = actualWallMs - desiredWallMs;
    if (diff === 0) break;
    utcMs -= diff;
  }

  return new Date(utcMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
