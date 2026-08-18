// @ts-check
// Declarative collection registry — the heart of the nested-resource CRUD API.
//
// Instead of hand-writing routes for every planner/dataset collection, each entry
// below maps a URL sub-path (e.g. `personal/outbound-legs`) to a location inside
// its parent document (e.g. `planner.personal.outboundLegs[]`) plus how to mint an
// id for a created element. The generic handlers in lib/crudApi.js read-modify-
// write the parent document through these descriptors, so ~25 planner collections
// + dataset sponsors are covered without dozens of bespoke handlers.
//
// Excluded on purpose: event `items` (sessions) — they have no stable id, so
// per-element CRUD would need an `items[].id` schema+data migration first.

import { makeId, slugId } from './makeId.js';

/**
 * @typedef {object} CollectionDescriptor
 * @property {'dataset' | 'planner'} domain which document domain the collection lives in
 * @property {string} key URL sub-path for the collection (may contain slashes, e.g. `personal/outbound-legs`)
 * @property {string[]} pointer property path to the array within the parent document
 * @property {(item?: any) => string} mintId id generator for a newly created element
 */

// planner collection descriptor: URL key → object-array at `pointer` in the blob,
// new elements get an id via makeId(prefix).
/**
 * @param {string} key
 * @param {string[]} pointer
 * @param {string} idPrefix
 * @returns {CollectionDescriptor}
 */
function planner(key, pointer, idPrefix) {
  return { domain: 'planner', key, pointer, mintId: () => makeId(idPrefix) };
}

/** @type {CollectionDescriptor[]} */
export const REGISTRY = [
  // ── Event datasets ──────────────────────────────────────────────────────────
  // Sponsors are the only id-addressable nested collection in a dataset; sessions
  // (event.items) are intentionally excluded (no stable id).
  {
    domain: 'dataset',
    key: 'sponsors',
    pointer: ['event', 'sponsors'],
    mintId: (item) => slugId(item?.title, 'sponsor'),
  },

  // ── Planner: top-level collections ─────────────────────────────────────────
  planner('contacts', ['contacts'], 'c'),
  planner('tasks', ['tasks'], 't'),
  planner('receipts', ['receipts'], 'rc'),

  // ── Planner: personal (individual trip) collections ────────────────────────
  planner('personal/outbound-legs', ['personal', 'outboundLegs'], 'leg'),
  planner('personal/return-legs', ['personal', 'returnLegs'], 'leg'),
  planner('personal/accommodations', ['personal', 'accommodations'], 'ia'),
  planner('personal/note-list', ['personal', 'noteList'], 'note'),
  planner('personal/tracked-sessions', ['personal', 'trackedSessions'], 'ts'),
  planner('personal/itinerary', ['personal', 'itinerary'], 'it'),
  planner('personal/documents', ['personal', 'documents'], 'doc'),
  planner('personal/budget-items', ['personal', 'budgetItems'], 'bi'),
  planner('personal/tickets', ['personal', 'tickets'], 'tk'),
  planner('personal/trip-assignments', ['personal', 'tripAssignments'], 'ta'),
  planner('personal/local-companions', ['personal', 'localCompanions'], 'lc'),

  // ── Planner: org (sponsor booth) collections ───────────────────────────────
  planner('org/accommodations', ['org', 'accommodations'], 'ia'),
  planner('org/swag', ['org', 'swag'], 'item'),
  planner('org/deliverables', ['org', 'deliverables'], 'item'),
  planner('org/tracked-sessions', ['org', 'trackedSessions'], 'ts'),
  planner('org/documents', ['org', 'documents'], 'doc'),
  planner('org/budget-items', ['org', 'budgetItems'], 'bi'),
  planner('org/tickets', ['org', 'tickets'], 'tk'),
  planner('org/itinerary', ['org', 'itinerary'], 'it'),
  planner('org/member-itinerary', ['org', 'memberItinerary'], 'it'),
];

// Look up a descriptor by domain + URL sub-path. Returns null when unknown so the
// caller can 404 rather than mutate an unexpected location.
/**
 * @param {string} domain
 * @param {string} key
 * @returns {CollectionDescriptor | null}
 */
export function findCollection(domain, key) {
  return REGISTRY.find((r) => r.domain === domain && r.key === key) || null;
}

// The collection sub-paths registered for a domain (for docs / discovery).
/**
 * @param {string} domain
 * @returns {string[]}
 */
export function collectionKeys(domain) {
  return REGISTRY.filter((r) => r.domain === domain).map((r) => r.key);
}

// Navigate `pointer` into `doc`, returning the array there. Returns null (never
// throws) when the path is absent or the target isn't an array, so handlers can
// distinguish "no such collection on this document" from "empty collection".
/**
 * @param {any} doc
 * @param {string[]} pointer
 * @returns {any[] | null}
 */
export function resolveArray(doc, pointer) {
  let node = doc;
  for (const seg of pointer) {
    if (!node || typeof node !== 'object') return null;
    node = node[seg];
  }
  return Array.isArray(node) ? node : null;
}

// Ensure the array at `pointer` exists (creating intermediate objects), then
// return it. Used on create so a collection can be populated even if the parent
// document predates that field.
/**
 * @param {any} doc
 * @param {string[]} pointer
 * @returns {any[]}
 */
export function ensureArray(doc, pointer) {
  let node = doc;
  for (let i = 0; i < pointer.length - 1; i++) {
    const seg = pointer[i];
    if (!node[seg] || typeof node[seg] !== 'object') node[seg] = {};
    node = node[seg];
  }
  const last = pointer[pointer.length - 1];
  if (!Array.isArray(node[last])) node[last] = [];
  return node[last];
}
