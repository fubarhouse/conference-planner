// The API token for SINGLE-USER (session) mode.
//
// Multi-user mode keeps a token hash on each user row. Session mode has no user
// table — one password, one identity — so there was nowhere to put a hash and
// the token endpoints simply returned 501. That left the only deployment shape
// most people actually run unable to use its own API, which is backwards: the
// question a token answers ("is this caller allowed?") is exactly as meaningful
// with one account as with ten.
//
// OPEN MODE STAYS UNSUPPORTED, deliberately. There is no identity to bind a
// token to, every request is already a synthetic admin, and minting one would
// manufacture a credential for a server that does not check credentials —
// security theatre that leaks if copied to a server that does.
//
// Storage is a file OUTSIDE app/. That is not a stylistic choice: app/ is
// served by express.static, so a hash written inside it would be one
// path-traversal bug away from being downloadable. (Private state has since
// moved out of app/ as well — see lib/roots.js — but this file predates that and
// the reasoning is unchanged.) Default is the repo root, overridable with
// API_TOKEN_FILE for read-only deployments.

import crypto from 'crypto';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Never inside app/ — see the note above. */
export const TOKEN_FILE = process.env.API_TOKEN_FILE?.trim() || join(HERE, '..', '.api-token.json');

/** 32 bytes = 256 bits, matching lib/users.js and lib/feedTokens.js. */
const TOKEN_BYTES = 32;

/** @param {string} token */
export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** A new secret. Returned once; only its hash is ever written. */
export function mintToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

/**
 * The stored record, or null when no token has been issued.
 * @returns {{hash: string, createdAt: string}|null}
 */
export function readToken() {
  try {
    if (!existsSync(TOKEN_FILE)) return null;
    const rec = JSON.parse(readFileSync(TOKEN_FILE, 'utf8'));
    return typeof rec?.hash === 'string' && rec.hash ? rec : null;
  } catch {
    // A corrupt file must read as "no token", never as "any token".
    return null;
  }
}

/**
 * Issue a token, replacing any existing one.
 * @returns {string} the plaintext, which is not recoverable afterwards
 */
export function issueToken() {
  const token = mintToken();
  writeFileSync(
    TOKEN_FILE,
    JSON.stringify({ hash: hashToken(token), createdAt: new Date().toISOString() }, null, 2),
    { mode: 0o600 },
  );
  return token;
}

/** Drop the token. Safe to call when none exists. */
export function revokeToken() {
  try {
    rmSync(TOKEN_FILE, { force: true });
  } catch {
    /* nothing to revoke */
  }
}

/**
 * Does this bearer token match the stored one?
 *
 * Compares HASHES under timingSafeEqual: equal-length inputs regardless of what
 * the caller sent, so the comparison cannot leak the secret's length or a
 * prefix through timing.
 *
 * @param {string} token
 */
export function verifyToken(token) {
  const rec = readToken();
  if (!rec || !token) return false;
  const a = Buffer.from(hashToken(token), 'hex');
  const b = Buffer.from(rec.hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
