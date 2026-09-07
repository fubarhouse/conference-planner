// @ts-check
// Session duration parsing/formatting for the editor. Sessions store an ISO-8601
// duration (`P<minutes>M`); the form shows a friendly `1h30m` value and accepts a
// range of hand-typed formats. All pure — no DOM or editor state — so the parsing
// rules are unit-tested directly. `syncAllSessionDurations` (which walks the live
// dataset) stays in editor.js and calls `syncSessionDuration` per item.

import { normalizeString } from './utils.js';

// Parse a duration written in many shapes (P90M, PT1H30M, 1h30m, "2 h 15 m",
// or a bare minute count) into whole minutes; returns null when unparseable.
/**
 * @param {*} value
 * @returns {number|null} whole minutes, or null when unparseable
 */
export function extractDurationMinutes(value) {
  const input = normalizeString(value);
  if (!input) return null;

  const directPm = input.match(/^p\s*(\d+)\s*m$/i);
  if (directPm) return Number.parseInt(directPm[1], 10);

  const isoLike = input.match(/^p?t?\s*(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m)?$/i);
  if (isoLike && (isoLike[1] || isoLike[2])) {
    const hours = isoLike[1] ? Number.parseFloat(isoLike[1]) : 0;
    const minutes = isoLike[2] ? Number.parseFloat(isoLike[2]) : 0;
    return Math.round(hours * 60 + minutes);
  }

  const compact = input.match(/^(\d+(?:\.\d+)?)h(\d+(?:\.\d+)?)m$/i);
  if (compact) {
    const hours = Number.parseFloat(compact[1]);
    const minutes = Number.parseFloat(compact[2]);
    return Math.round(hours * 60 + minutes);
  }

  const units = [...input.matchAll(/(\d+(?:\.\d+)?)\s*([hm])/gi)];
  if (units.length > 0) {
    let total = 0;
    units.forEach((match) => {
      const valueNum = Number.parseFloat(match[1]);
      if (match[2].toLowerCase() === 'h') {
        total += valueNum * 60;
      } else {
        total += valueNum;
      }
    });
    return Math.round(total);
  }

  if (/^\d+(?:\.\d+)?$/.test(input)) {
    return Math.round(Number.parseFloat(input));
  }

  return null;
}

// Minutes → friendly form value (`1h30m`, `2h`, `45m`); '' for non-positive input.
/**
 * @param {number} minutes
 * @returns {string}
 */
export function durationMinutesToHuman(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return '';
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  if (hours > 0 && rem > 0) return `${hours}h${rem}m`;
  if (hours > 0) return `${hours}h`;
  return `${rem}m`;
}

// Any stored/typed value → the friendly value shown in the duration field.
/**
 * @param {*} value
 * @returns {string}
 */
export function durationToEditorValue(value) {
  const minutes = extractDurationMinutes(value);
  if (minutes == null) return String(value || '');
  return durationMinutesToHuman(minutes);
}

// Any value → the canonical `P<minutes>M` string stored on a session.
/**
 * @param {*} value
 * @returns {string}
 */
export function durationToCanonical(value) {
  const minutes = extractDurationMinutes(value);
  if (minutes == null) return normalizeString(value);
  return `P${minutes}M`;
}

// Canonical duration derived from a session's start/end timestamps; '' when the
// pair is missing, unparseable, or non-positive.
/**
 * @param {string} [startTime]
 * @param {string} [endTime]
 * @returns {string}
 */
export function deriveSessionDurationValue(startTime, endTime) {
  if (!startTime || !endTime) return '';
  const startMs = new Date(startTime).getTime();
  const endMs = new Date(endTime).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return '';
  const minutes = Math.round((endMs - startMs) / 60000);
  if (!Number.isFinite(minutes) || minutes <= 0) return '';
  return durationToCanonical(minutes);
}

const _DURATION_RE = /^P\d+M$/;

// Reconcile a session item's stored duration: prefer the value derived from its
// start/end times, else keep an already-canonical duration, else 'P0M'. Mutates
// and returns item.duration.
/**
 * @param {{ startTime?: string, endTime?: string, duration?: string } | null} item
 * @returns {string}
 */
export function syncSessionDuration(item) {
  if (!item || typeof item !== 'object') return 'P0M';
  const derived = deriveSessionDurationValue(item.startTime, item.endTime);
  const existing = item.duration || '';
  item.duration = _DURATION_RE.test(derived)
    ? derived
    : _DURATION_RE.test(existing)
      ? existing
      : 'P0M';
  return item.duration;
}
