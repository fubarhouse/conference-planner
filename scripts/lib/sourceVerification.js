// @ts-check
// Which sources to go and check, in the order worth checking them.
//
// The archive's stated intention is that every fact be traceable. Coverage
// reaching 100% does not deliver that — it says every record cites something,
// not that what it cites has been looked at. This module produces the worklist
// that closes the gap, and it is designed to SHRINK: marking a source
// `verifiedAt` removes it, so the same command run next month shows progress
// rather than the same wall of text.
//
// Two independent weaknesses, deliberately not averaged into one score:
//
//   evidence   how good the source is        (stated < live < captured < verified)
//   claim      how good the attribution is   (page < exact)
//
// Averaging them hides whichever is worse. A perfect Wayback capture that 300
// sessions are attached to by inference is a different problem from a live URL
// backing a single exactly-matched row, and they need different work.

import {
  attributionStrength,
  sourceConfidence,
  sourceReach,
  waybackTimestampToIso,
} from './sources.js';

/**
 * @typedef {object} SourceRow
 * @property {string} file dataset, relative to the events root
 * @property {string} id
 * @property {string} kind
 * @property {string} confidence
 * @property {string} [url]
 * @property {string} [title]
 * @property {string} [retrievedAt]
 * @property {boolean} wayback
 * @property {string|null} captureDate when archive.org saw the page
 * @property {boolean} hasCapture
 * @property {number} reach how many records cite it
 * @property {number} exact how many of those cite it by exact link match
 * @property {number} priority reach weighted by weakness
 */

// What each tier costs in priority. `stated` is weighted low NOT because such
// sources matter less but because checking one cannot improve it — spending the
// afternoon on a live URL that 300 rows depend on is the better trade.
const EVIDENCE_WEIGHT = { verified: 0, accepted: 0, captured: 1, stated: 2, live: 4 };

/**
 * Build the verification worklist for one dataset.
 *
 * @param {string} file dataset path, relative to the events root
 * @param {any} dataset
 * @returns {SourceRow[]}
 */
export function verificationRows(file, dataset) {
  const sources = Array.isArray(dataset?.event?.sources) ? dataset.event.sources : [];
  if (!sources.length) return [];
  /** @type {Map<string, any>} */
  const byId = new Map(sources.map((/** @type {any} */ s) => [s?.id, s]));
  const reach = sourceReach(dataset);

  // Which sources back an exactly-matched record, and how often.
  /** @type {Map<string, number>} */
  const exactBySource = new Map();
  for (const item of dataset?.items ?? []) {
    if (attributionStrength(item, byId) !== 'exact') continue;
    for (const id of item.sourceIds ?? []) {
      const source = byId.get(id);
      if (source?.url === String(item.link).trim()) {
        exactBySource.set(id, (exactBySource.get(id) ?? 0) + 1);
      }
    }
  }

  return sources.map((/** @type {any} */ source) => {
    const confidence = sourceConfidence(source);
    const count = reach.get(source.id) ?? 0;
    const exact = exactBySource.get(source.id) ?? 0;
    // Records resting on inference are what verification actually buys. A
    // source whose every citation is an exact match is already as good as
    // checking it would make it.
    const inferred = Math.max(0, count - exact);
    const undated = source.retrievedAt ? 0 : 1;
    return {
      file,
      id: source.id,
      kind: source.kind,
      confidence,
      url: source.url,
      title: source.title,
      retrievedAt: source.retrievedAt,
      wayback: source.via?.provider === 'wayback',
      captureDate: waybackTimestampToIso(source.via?.timestamp),
      hasCapture: Boolean(source.capture),
      reach: count,
      exact,
      priority: (inferred + 1) * (EVIDENCE_WEIGHT[confidence] ?? 3) + undated,
    };
  });
}

/**
 * Roll per-dataset rows into a whole-archive picture.
 *
 * @param {SourceRow[]} rows
 */
export function summarise(rows) {
  /** @type {Record<string, number>} */
  const byConfidence = {};
  /** @type {Record<string, number>} */
  const recordsByConfidence = {};
  let undated = 0;
  let orphans = 0;
  let exactRecords = 0;
  let attributedRecords = 0;
  // Split the `captured` tier by WHOSE copy survives. A local file is ours; a
  // Wayback capture is a dependency on another institution continuing to exist.
  // Both beat a bare URL, but they are not the same promise.
  let wayback = 0;
  let localCapture = 0;
  /** @type {string[]} */
  const captureDates = [];
  for (const row of rows) {
    if (row.wayback) wayback += 1;
    if (row.hasCapture) localCapture += 1;
    if (row.captureDate) captureDates.push(row.captureDate);
    byConfidence[row.confidence] = (byConfidence[row.confidence] ?? 0) + 1;
    recordsByConfidence[row.confidence] = (recordsByConfidence[row.confidence] ?? 0) + row.reach;
    if (!row.retrievedAt) undated += 1;
    if (!row.reach) orphans += 1;
    exactRecords += row.exact;
    attributedRecords += row.reach;
  }
  return {
    sources: rows.length,
    byConfidence,
    recordsByConfidence,
    undated,
    orphans,
    wayback,
    localCapture,
    oldestCapture: captureDates.sort()[0] ?? null,
    exactRecords,
    attributedRecords,
    // The headline number: what share of citations rest on evidence about that
    // specific record rather than on how the dataset was assembled.
    exactShare: attributedRecords ? exactRecords / attributedRecords : 0,
  };
}

/**
 * The worklist rolled up per event.
 *
 * A multi-day conference stores one source per day page, and every session
 * cites all of them — so the flat list shows the same event five times with an
 * identical record count and reads as five jobs. It is one: open that event's
 * pages, confirm they are what its sessions came from. This is the view to work
 * from; the flat list is the detail behind it.
 *
 * @param {SourceRow[]} rows
 * @param {number} [limit]
 */
export function worklistByEvent(rows, limit = 25) {
  /** @type {Map<string, {file: string, sources: number, unverified: number, records: number, exact: number, weakest: string, undated: number, priority: number}>} */
  const byEvent = new Map();
  for (const row of rows) {
    const entry = byEvent.get(row.file) ?? {
      file: row.file,
      sources: 0,
      unverified: 0,
      // Records are counted at the event's widest source rather than summed:
      // summing double-counts a session that cites four day pages.
      records: 0,
      exact: 0,
      weakest: 'verified',
      undated: 0,
      priority: 0,
    };
    entry.sources += 1;
    if (row.confidence !== 'verified' && row.confidence !== 'accepted') entry.unverified += 1;
    entry.records = Math.max(entry.records, row.reach);
    entry.exact = Math.max(entry.exact, row.exact);
    if (CONFIDENCE_ORDER[row.confidence] < CONFIDENCE_ORDER[entry.weakest]) {
      entry.weakest = row.confidence;
    }
    if (!row.retrievedAt) entry.undated += 1;
    entry.priority = Math.max(entry.priority, row.priority);
    byEvent.set(row.file, entry);
  }
  return [...byEvent.values()]
    .filter((entry) => entry.unverified > 0)
    .sort((a, b) => b.records - a.records || b.priority - a.priority)
    .slice(0, limit);
}

/** @type {Record<string, number>} */
const CONFIDENCE_ORDER = { stated: 0, live: 1, captured: 2, accepted: 3, verified: 4 };

/**
 * The worklist: unverified sources, worst-and-widest first.
 *
 * @param {SourceRow[]} rows
 * @param {number} [limit]
 */
export function worklist(rows, limit = 40) {
  return rows
    .filter((row) => row.confidence !== 'verified' && row.confidence !== 'accepted')
    .sort((a, b) => b.priority - a.priority || b.reach - a.reach || a.file.localeCompare(b.file))
    .slice(0, limit);
}
