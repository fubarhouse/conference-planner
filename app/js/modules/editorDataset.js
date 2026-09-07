// @ts-check
// Dataset metadata helpers for the editor's home/open screens — deriving a
// display label, grouping name, and grouping record from a dataset's `event`
// block, plus dataset-file recognition and shape validation. Pure: the
// manifest-label fallback (which reads the editor's live event catalog) is passed
// in by the caller as `fallbackLabel`, so these can be unit-tested directly.

import { normalizeString } from './utils.js';

// Combine a date-only value (from an <input type="date">, "YYYY-MM-DD") with the
// time/zone of the previous ISO value, producing a full RFC3339 date-time — the
// event schema requires `date-time`, so writing the bare date would fail
// validation. The previous time-of-day (and any offset) is preserved; when there
// isn't one, it defaults to UTC midnight. An empty date clears the field.
/**
 * @param {string} dateValue - "YYYY-MM-DD" (or '')
 * @param {string} [prevIso] - the existing value, e.g. "2026-11-11T09:00:00Z"
 * @returns {string}
 */
export function mergeDateIntoIso(dateValue, prevIso = '') {
  if (!dateValue) return '';
  const m = String(prevIso).match(/T(.+)$/);
  return `${dateValue}T${m ? m[1] : '00:00:00Z'}`;
}

// Human label for a dataset option: "<designation> <year> <location>" from the
// event meta, else the caller-provided fallback (manifest label), else the file.
/**
 * @param {string} file
 * @param {*} [eventMeta]
 * @param {string} [fallbackLabel]
 * @returns {string}
 */
export function buildDatasetOptionLabel(file, eventMeta = null, fallbackLabel = '') {
  const designation = normalizeString(eventMeta?.designation);
  const year = normalizeString(eventMeta?.year);
  const location = normalizeString(eventMeta?.location);
  const fromMeta = [designation, year, location].filter(Boolean).join(' ').trim();
  return fromMeta || fallbackLabel || file;
}

// Grouping bucket for a dataset — its designation, or "Other" when unset.
/**
 * @param {*} [eventMeta]
 * @returns {string}
 */
export function getDatasetGroupName(eventMeta = null) {
  const designation = normalizeString(eventMeta?.designation);
  return designation || 'Other';
}

/**
 * A dataset's path relative to the DATA ROOT, as the server's routes want it.
 *
 * `state.file` is not one thing. Opened through the API it is the catalog's own
 * form and already carries `events/`; opened from a local folder, or freshly
 * created and never saved, it is a bare filename. Anything talking to a server
 * route has to say which it has, and prefixing unconditionally produces
 * `events/events/…`, which is a 404 that reads like a missing dataset rather
 * than like a bug in the caller.
 *
 * Returns '' for a file that is not in the archive yet, so a caller can say so
 * rather than send a path that cannot resolve.
 *
 * @param {*} file
 * @returns {string}
 */
export function datasetDocPath(file) {
  const normalized = String(file || '')
    .trim()
    .replace(/^\/+/, '');
  // Tested on the BASENAME: `isEditorDatasetFile` excludes the index manifest
  // by comparing the whole string, which only catches a bare `index.json` and
  // lets `events/index.json` through.
  if (!isEditorDatasetFile(normalized.split('/').pop())) return '';
  if (normalized.startsWith('events/')) return normalized;
  // A path with directories but no `events/` root is a local-folder checkout of
  // the same tree; a bare filename has never been filed anywhere.
  return normalized.includes('/') ? `events/${normalized}` : '';
}

// True for a loadable dataset file (a .json that isn't the index manifest).
/**
 * @param {*} name
 * @returns {boolean}
 */
export function isEditorDatasetFile(name) {
  const normalized = String(name || '')
    .trim()
    .toLowerCase();
  return normalized.endsWith('.json') && normalized !== 'index.json';
}

// Throw a descriptive error unless `dataset` has the minimum editable shape.
/**
 * @param {*} dataset
 * @param {string} [file]
 * @returns {void}
 */
export function validateDatasetSchema(dataset, file = 'dataset') {
  if (!dataset || typeof dataset !== 'object' || Array.isArray(dataset)) {
    throw new Error(`${file} is not a dataset object.`);
  }
  if (!dataset.event || typeof dataset.event !== 'object' || Array.isArray(dataset.event)) {
    throw new Error(`${file} is missing a valid "event" object.`);
  }
  if (!Array.isArray(dataset.items)) {
    throw new Error(`${file} is missing a valid "items" array.`);
  }
}

// Grouping record for one dataset from its `event` metadata. Shared by both load
// strategies so the two paths cannot drift apart.
/**
 * @param {string} file
 * @param {*} eventMeta
 * @param {string} [fallbackLabel]
 * @returns {object}
 */
export function buildDatasetGroupingRecord(file, eventMeta, fallbackLabel = '') {
  return {
    file,
    group: getDatasetGroupName(eventMeta),
    label: buildDatasetOptionLabel(file, eventMeta, fallbackLabel),
    enabled: eventMeta.enabled !== false,
    designation: normalizeString(eventMeta.designation),
    location: normalizeString(eventMeta.location),
    year: normalizeString(eventMeta.year),
    region: normalizeString(eventMeta.region),
    venue: normalizeString(eventMeta.venue),
    startDate: eventMeta.startDate || '',
    endDate: eventMeta.endDate || '',
  };
}

// Fallback record for an unreadable/invalid dataset.
/**
 * @param {string} file
 * @param {string} [fallbackLabel]
 * @returns {object}
 */
export function buildDatasetGroupingFallback(file, fallbackLabel = '') {
  return {
    file,
    group: 'Other',
    label: fallbackLabel || file,
    enabled: true,
    designation: '',
    location: '',
    year: '',
    region: '',
    venue: '',
    startDate: '',
    endDate: '',
  };
}
