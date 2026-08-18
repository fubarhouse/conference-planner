import { describe, it, expect, vi, beforeEach } from 'vitest';

// sessionStorage stub (node env)
const store = new Map();
vi.stubGlobal('sessionStorage', {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
});
beforeEach(() => store.clear());

const { hasUnlockGrace, grantUnlockGrace, verifyPassword, guardPlannerLock } =
  await import('../plannerLock.js');

describe('unlock grace', () => {
  it('grantUnlockGrace makes hasUnlockGrace true; expired timestamps are false', () => {
    expect(hasUnlockGrace('trip-a')).toBe(false);
    grantUnlockGrace('trip-a');
    expect(hasUnlockGrace('trip-a')).toBe(true);
    // Force an expired window.
    store.set('__plannerUnlock_v1__trip-a', String(Date.now() - 1000));
    expect(hasUnlockGrace('trip-a')).toBe(false);
  });

  it('grace is per-slug', () => {
    grantUnlockGrace('trip-a');
    expect(hasUnlockGrace('trip-b')).toBe(false);
  });
});

describe('verifyPassword', () => {
  const json = (body, status = 200) => ({
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
  });

  it('ok:true on a { ok:true } JSON response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ ok: true })),
    );
    expect(await verifyPassword('pw')).toEqual({ ok: true });
  });

  it("reason 'bad' on a { ok:false } JSON response", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ ok: false }, 401)),
    );
    expect(await verifyPassword('pw')).toEqual({ ok: false, reason: 'bad' });
  });

  it("reason 'unreachable' on an auth error payload (expired session)", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: 'Unauthorized' }, 401)),
    );
    expect(await verifyPassword('pw')).toEqual({ ok: false, reason: 'unreachable' });
  });

  it("reason 'rate' on HTTP 429", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ ok: false }, 429)),
    );
    expect(await verifyPassword('pw')).toEqual({ ok: false, reason: 'rate' });
  });

  it("reason 'unreachable' on a non-JSON (redirect/404) response", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        status: 200,
        headers: { get: () => 'text/html' },
        json: async () => ({}),
      })),
    );
    expect(await verifyPassword('pw')).toEqual({ ok: false, reason: 'unreachable' });
  });

  it("reason 'unreachable' when fetch throws (offline)", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    expect(await verifyPassword('pw')).toEqual({ ok: false, reason: 'unreachable' });
  });
});

describe('guardPlannerLock (non-blocking)', () => {
  it('returns false (no cover) when the planner is not locked', () => {
    expect(guardPlannerLock({ planner: {}, slug: 'x' })).toBe(false);
  });

  it('returns false for a locked planner within its grace window', () => {
    grantUnlockGrace('trip-a');
    expect(guardPlannerLock({ planner: { locked: true }, slug: 'trip-a' })).toBe(false);
  });

  it('does not block in a non-DOM environment (returns true, no UI)', () => {
    // The gate must be synchronous and never await/throw — so boot (and persistence)
    // can proceed regardless. With no document it simply no-ops the overlay.
    delete globalThis.document;
    expect(guardPlannerLock({ planner: { locked: true }, slug: 'trip-locked' })).toBe(true);
  });
});
