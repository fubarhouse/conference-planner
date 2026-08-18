// @ts-check
// A schedule's public identity.
//
// The slug is `<designation> <year> <location>` slugified —
// `drupalsouth-2026-wellington` — derived from the catalog entry, not stored in
// it. That rule already existed inside events.js; it lives here because the
// SERVER needs it too now: `/schedules/<slug>/calendar.ics` has to resolve a
// slug to a dataset file without a browser, and two copies of an identity rule
// is how two things start disagreeing about what a thing is called.
//
// Pure, no DOM, no fs — the server passes the catalog in.

import { slugify } from './utils.js';

/**
 * @typedef {{file: string, event?: Record<string, any>}} CatalogItem
 */

/**
 * The slug for one catalog entry. Falls back to the dataset path when an entry
 * has no usable metadata, so every dataset is addressable even mid-import.
 *
 * @param {CatalogItem|null|undefined} item
 * @returns {string}
 */
export function scheduleSlug(item) {
  const meta = item?.event || {};
  const fromMeta = slugify([meta.designation, meta.year, meta.location].filter(Boolean).join(' '));
  if (fromMeta) return fromMeta;
  return slugify(String(item?.file || '').replace(/\.json$/i, ''));
}

/**
 * Resolve a slug to its dataset file.
 *
 * @param {string} slug
 * @param {CatalogItem[]} catalog
 * @returns {string|null} the dataset file, or null when nothing matches
 */
export function fileForSlug(slug, catalog = []) {
  const want = slugify(slug);
  if (!want) return null;
  const match = catalog.find((item) => scheduleSlug(item) === want);
  return match?.file || null;
}

/**
 * The slug for a dataset file — the inverse, for building links from state.
 *
 * @param {string} file
 * @param {CatalogItem[]} catalog
 * @returns {string}
 */
export function slugForFile(file, catalog = []) {
  const match = catalog.find((item) => item.file === file);
  return match ? scheduleSlug(match) : '';
}
