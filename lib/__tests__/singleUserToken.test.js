import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The module reads API_TOKEN_FILE at import time, so each test run needs a
// fresh module registry pointed at its own temp file.
let dir;
let mod;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'apitoken-'));
  process.env.API_TOKEN_FILE = join(dir, 'token.json');
  vi.resetModules();
  mod = await import('../singleUserToken.js');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.API_TOKEN_FILE;
});

describe('the single-user API token', () => {
  it('reads as absent before one is issued', () => {
    expect(mod.readToken()).toBeNull();
    expect(mod.verifyToken('anything')).toBe(false);
  });

  it('issues a 256-bit token and accepts it back', () => {
    const token = mod.issueToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(mod.verifyToken(token)).toBe(true);
  });

  it('never writes the token itself — only its hash', () => {
    const token = mod.issueToken();
    const onDisk = readFileSync(process.env.API_TOKEN_FILE, 'utf8');
    expect(onDisk).not.toContain(token);
    expect(JSON.parse(onDisk).hash).toBe(mod.hashToken(token));
  });

  it('writes the file owner-only', () => {
    mod.issueToken();
    // 0o600 — a token hash readable by every account on the box is a downgrade,
    // not a safeguard.
    expect(statSync(process.env.API_TOKEN_FILE).mode & 0o077).toBe(0);
  });

  it('rejects a wrong token, and one of the wrong length', () => {
    mod.issueToken();
    expect(mod.verifyToken('nope')).toBe(false);
    expect(mod.verifyToken('a'.repeat(64))).toBe(false);
    expect(mod.verifyToken('')).toBe(false);
    expect(mod.verifyToken(undefined)).toBe(false);
  });

  it('replaces the old token when a new one is issued', () => {
    const first = mod.issueToken();
    const second = mod.issueToken();
    expect(second).not.toBe(first);
    expect(mod.verifyToken(first)).toBe(false);
    expect(mod.verifyToken(second)).toBe(true);
  });

  it('stops accepting a revoked token', () => {
    const token = mod.issueToken();
    mod.revokeToken();
    expect(mod.verifyToken(token)).toBe(false);
    expect(mod.readToken()).toBeNull();
    expect(existsSync(process.env.API_TOKEN_FILE)).toBe(false);
  });

  it('revokes safely when there is nothing to revoke', () => {
    expect(() => mod.revokeToken()).not.toThrow();
  });

  it('treats a corrupt store as no token, never as any token', () => {
    // The failure mode that matters: a truncated or hand-edited file must not
    // become a wildcard.
    writeFileSync(process.env.API_TOKEN_FILE, '{ not json');
    expect(mod.readToken()).toBeNull();
    expect(mod.verifyToken('anything')).toBe(false);

    writeFileSync(process.env.API_TOKEN_FILE, JSON.stringify({ hash: '' }));
    expect(mod.readToken()).toBeNull();
    expect(mod.verifyToken('')).toBe(false);
  });

  it('keeps the store out of the served app/ tree', () => {
    // app/ is handed to express.static. A hash written there would be one
    // traversal bug from being fetched.
    expect(mod.TOKEN_FILE).not.toMatch(/[/\\]app[/\\]/);
  });
});
