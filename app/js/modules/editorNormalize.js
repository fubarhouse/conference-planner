// @ts-check
// Generic field normalizers for the editor — pure coercions shared across the
// event-meta, media, and session forms. No DOM or editor state, so they are
// unit-tested directly; callers in editor.js apply them to the live dataset.

import { normalizeString } from './utils.js';

// Coerce a URL field into an array of normalized strings. A single string
// becomes a one-element array (or empty when blank); arrays are mapped through.
/**
 * @param {*} value
 * @returns {string[]}
 */
export function normalizeUrlArray(value) {
  if (Array.isArray(value)) return value.map((v) => normalizeString(v));
  const s = normalizeString(value);
  return s ? [s] : [];
}

// Split a newline/comma-separated field into trimmed, non-empty tokens.
/**
 * @param {*} value
 * @returns {string[]}
 */
export function parseMultiValue(value) {
  return String(value || '')
    .split(/\n|,/)
    .map((v) => v.trim())
    .filter(Boolean);
}

// Drop the derived `summary`/`description` fields from every dataset item so they
// are regenerated rather than persisted. Mutates the passed dataset in place.
/**
 * @param {*} dataset
 * @returns {void}
 */
export function stripSummaryFields(dataset) {
  if (!dataset || !Array.isArray(dataset.items)) return;
  dataset.items.forEach((/** @type {*} */ item) => {
    if (!item || typeof item !== 'object') return;
    if (Object.prototype.hasOwnProperty.call(item, 'summary')) delete item.summary;
    if (Object.prototype.hasOwnProperty.call(item, 'description')) delete item.description;
  });
}

// Coerce a raw Flickr media block into canonical shape; enabled unless explicitly false.
/**
 * @param {*} [raw]
 * @returns {object}
 */
export function normalizeFlickrObject(raw = null) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const enabled = !(
    input.enabled === false || String(input.enabled || '').toLowerCase() === 'false'
  );
  return {
    enabled,
    provider: normalizeString(input.provider),
    groupUrl: normalizeString(input.groupUrl),
    image: normalizeString(input.image),
    imageAlt: normalizeString(input.imageAlt),
  };
}

// Coerce a raw event logo block into canonical shape, parsing the boolean flags.
/**
 * @param {*} [raw]
 * @returns {object}
 */
export function normalizeLogoObject(raw = null) {
  const input = raw && typeof raw === 'object' ? raw : {};
  return {
    image: normalizeString(input.image),
    imageAlt: normalizeString(input.imageAlt),
    usePlate: input.usePlate === true || String(input.usePlate || '').toLowerCase() === 'true',
    logoDisabled:
      input.logoDisabled === true || String(input.logoDisabled || '').toLowerCase() === 'true',
    faIcon: normalizeString(input.faIcon),
  };
}
