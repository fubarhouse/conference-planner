// Calendar feed tokens.
//
// A calendar client polls unattended: it cannot log in, cannot carry a session
// cookie and cannot refresh anything. So a subscribable URL IS a credential,
// and the only question is how good a credential it is. This module makes it a
// proper one.
//
// The scheme mirrors the API tokens in lib/users.js, which already got this
// right: 256 bits from the server's CSPRNG, and only a SHA-256 hash is stored.
// The plaintext is returned once, at creation, and is not recoverable
// afterwards — so a leaked planner file, or a leaked S3 object, exposes no live
// subscription. The previous scheme stored a client-generated UUID in plaintext
// in the planner, and fell back to `Math.random()` outside a secure context.
//
// Tokens are PER SUBSCRIPTION rather than per planner. That is what makes
// show-once acceptable: losing a link is not a crisis, because minting another
// does not disturb the devices already subscribed, and revoking the laptop does
// not unsubscribe the phone. It also means `lastUsedAt` describes one device,
// which is what turns it into a leak detector rather than a curiosity.

import crypto from 'crypto';

/** Where the subscription list lives on a planner (or on global settings). */
export const FEEDS_KEY = '_feeds';

/** Bytes of entropy per token. 32 = 256 bits, the same as lib/users.js. */
const TOKEN_BYTES = 32;

/**
 * @typedef {object} FeedEntry
 * @property {string} id          - public identifier, safe to show and to log
 * @property {string} label       - what the reader called it ("Phone")
 * @property {string} hash        - sha256 of the token; never the token itself
 * @property {string} createdAt
 * @property {string|null} lastUsedAt
 * @property {string|null} lastAgent - coarse client name, for spotting misuse
 */

/** @param {string} token */
export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** A new secret. Returned to the caller once and never stored in this form. */
export function mintToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

/**
 * Every subscription on a record, without secrets — safe to render.
 *
 * @param {Record<string, any>|null} owner - a planner, or global settings
 * @returns {Array<Omit<FeedEntry,'hash'>>}
 */
export function listFeeds(owner) {
  const feeds = Array.isArray(owner?.[FEEDS_KEY]) ? owner[FEEDS_KEY] : [];
  return feeds.map(({ hash: _hash, ...safe }) => safe);
}

/**
 * Add a subscription. Mutates `owner` and returns the plaintext token, which is
 * the only moment it exists in this form.
 *
 * @param {Record<string, any>} owner
 * @param {{label?: string, now?: string}} [opts]
 * @returns {{token: string, entry: Omit<FeedEntry,'hash'>}}
 */
export function addFeed(owner, { label = '', now = new Date().toISOString() } = {}) {
  if (!owner || typeof owner !== 'object') throw new Error('No record to add a feed to');
  const token = mintToken();
  /** @type {FeedEntry} */
  const entry = {
    id: crypto.randomUUID(),
    label: String(label || 'Calendar').slice(0, 60),
    hash: hashToken(token),
    createdAt: now,
    lastUsedAt: null,
    lastAgent: null,
  };
  const feeds = Array.isArray(owner[FEEDS_KEY]) ? owner[FEEDS_KEY] : [];
  owner[FEEDS_KEY] = [...feeds, entry];
  const { hash: _hash, ...safe } = entry;
  return { token, entry: safe };
}

/**
 * Remove a subscription by its public id.
 *
 * @returns {boolean} whether anything was removed
 */
export function revokeFeed(owner, id) {
  const feeds = Array.isArray(owner?.[FEEDS_KEY]) ? owner[FEEDS_KEY] : [];
  const kept = feeds.filter((f) => f.id !== id);
  if (kept.length === feeds.length) return false;
  owner[FEEDS_KEY] = kept;
  return true;
}

/** Remove every subscription — used when the thing they point at is deleted. */
export function revokeAllFeeds(owner) {
  const count = Array.isArray(owner?.[FEEDS_KEY]) ? owner[FEEDS_KEY].length : 0;
  if (owner) owner[FEEDS_KEY] = [];
  return count;
}

/**
 * The subscription a token belongs to, or null.
 *
 * Compared in constant time over the HASHES: they are fixed-length hex, so
 * `timingSafeEqual` never sees a length mismatch and cannot leak through an
 * early return. Comparing raw tokens of attacker-controlled length would.
 *
 * @param {Record<string, any>|null} owner
 * @param {string} token
 * @returns {FeedEntry|null}
 */
export function findFeed(owner, token) {
  const feeds = Array.isArray(owner?.[FEEDS_KEY]) ? owner[FEEDS_KEY] : [];
  if (!token || !feeds.length) return null;
  const want = Buffer.from(hashToken(token), 'utf8');
  for (const feed of feeds) {
    if (typeof feed?.hash !== 'string' || feed.hash.length !== want.length) continue;
    if (crypto.timingSafeEqual(Buffer.from(feed.hash, 'utf8'), want)) return feed;
  }
  return null;
}

/**
 * Record that a subscription was polled. Deliberately keeps a coarse client
 * name and NOT an IP address: "Apple Calendar, last seen Tuesday" is enough to
 * notice a token being used from somewhere it should not be, without the
 * product accumulating a location history of its reader.
 *
 * @returns {boolean} whether the record changed enough to be worth saving
 */
export function touchFeed(owner, id, userAgent = '', now = new Date().toISOString()) {
  const feeds = Array.isArray(owner?.[FEEDS_KEY]) ? owner[FEEDS_KEY] : [];
  const feed = feeds.find((f) => f.id === id);
  if (!feed) return false;
  const agent = String(userAgent || '')
    .split('/')[0]
    .slice(0, 40);
  // Calendars poll every few minutes; rewriting the planner (and its S3 object)
  // that often would be absurd. An hour's resolution is plenty to spot misuse.
  const last = feed.lastUsedAt ? Date.parse(feed.lastUsedAt) : 0;
  const changed = !last || Date.parse(now) - last > 60 * 60 * 1000 || feed.lastAgent !== agent;
  feed.lastUsedAt = now;
  feed.lastAgent = agent || feed.lastAgent;
  return changed;
}
