import { describe, it, expect } from 'vitest';
import {
  addFeed,
  findFeed,
  hashToken,
  listFeeds,
  mintToken,
  revokeAllFeeds,
  revokeFeed,
  touchFeed,
  FEEDS_KEY,
} from '../feedTokens.js';

describe('mintToken', () => {
  it('is 256 bits of hex', () => {
    const t = mintToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 200 }, () => mintToken()));
    expect(seen.size).toBe(200);
  });
});

describe('addFeed', () => {
  it('returns the token once and stores only its hash', () => {
    const planner = {};
    const { token, entry } = addFeed(planner, { label: 'Phone' });
    const stored = planner[FEEDS_KEY][0];
    expect(stored.hash).toBe(hashToken(token));
    expect(JSON.stringify(planner)).not.toContain(token);
    expect(entry).not.toHaveProperty('hash');
    expect(entry.label).toBe('Phone');
  });

  it('adds subscriptions side by side rather than replacing', () => {
    const planner = {};
    addFeed(planner, { label: 'Phone' });
    addFeed(planner, { label: 'Laptop' });
    expect(planner[FEEDS_KEY]).toHaveLength(2);
    expect(listFeeds(planner).map((f) => f.label)).toEqual(['Phone', 'Laptop']);
  });

  it('caps a silly label', () => {
    const planner = {};
    const { entry } = addFeed(planner, { label: 'x'.repeat(500) });
    expect(entry.label.length).toBe(60);
  });
});

describe('findFeed', () => {
  it('matches the token it minted, and nothing else', () => {
    const planner = {};
    const { token, entry } = addFeed(planner, { label: 'Phone' });
    expect(findFeed(planner, token)?.id).toBe(entry.id);
    expect(findFeed(planner, mintToken())).toBeNull();
    expect(findFeed(planner, '')).toBeNull();
  });

  it('keeps every other subscription working when one is revoked', () => {
    const planner = {};
    const a = addFeed(planner, { label: 'Phone' });
    const b = addFeed(planner, { label: 'Laptop' });
    expect(revokeFeed(planner, a.entry.id)).toBe(true);
    expect(findFeed(planner, a.token)).toBeNull();
    expect(findFeed(planner, b.token)?.id).toBe(b.entry.id);
  });

  it('survives a malformed or truncated hash without throwing', () => {
    const planner = {
      [FEEDS_KEY]: [
        { id: 'x', hash: 'short' },
        { id: 'y', hash: null },
      ],
    };
    expect(() => findFeed(planner, mintToken())).not.toThrow();
    expect(findFeed(planner, mintToken())).toBeNull();
  });

  it('has nothing to find on a planner with no subscriptions', () => {
    expect(findFeed({}, mintToken())).toBeNull();
    expect(findFeed(null, mintToken())).toBeNull();
  });
});

describe('revokeFeed', () => {
  it('reports whether it removed anything', () => {
    const planner = {};
    const { entry } = addFeed(planner);
    expect(revokeFeed(planner, 'not-an-id')).toBe(false);
    expect(revokeFeed(planner, entry.id)).toBe(true);
    expect(planner[FEEDS_KEY]).toHaveLength(0);
  });

  it('clears them all when the planner itself goes', () => {
    const planner = {};
    addFeed(planner);
    addFeed(planner);
    expect(revokeAllFeeds(planner)).toBe(2);
    expect(planner[FEEDS_KEY]).toEqual([]);
  });
});

describe('touchFeed', () => {
  it('records when and what, but never an address', () => {
    const planner = {};
    const { entry } = addFeed(planner);
    touchFeed(planner, entry.id, 'ICSAgent/1.0 (macOS)', '2026-08-13T10:00:00.000Z');
    const stored = planner[FEEDS_KEY][0];
    expect(stored.lastUsedAt).toBe('2026-08-13T10:00:00.000Z');
    expect(stored.lastAgent).toBe('ICSAgent');
    expect(JSON.stringify(stored)).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });

  it('only asks to be saved once an hour, since calendars poll constantly', () => {
    const planner = {};
    const { entry } = addFeed(planner);
    expect(touchFeed(planner, entry.id, 'A', '2026-08-13T10:00:00.000Z')).toBe(true);
    expect(touchFeed(planner, entry.id, 'A', '2026-08-13T10:05:00.000Z')).toBe(false);
    expect(touchFeed(planner, entry.id, 'A', '2026-08-13T11:30:00.000Z')).toBe(true);
  });

  it('saves immediately when the client changes — that is the interesting case', () => {
    const planner = {};
    const { entry } = addFeed(planner);
    touchFeed(planner, entry.id, 'Apple', '2026-08-13T10:00:00.000Z');
    expect(touchFeed(planner, entry.id, 'curl', '2026-08-13T10:01:00.000Z')).toBe(true);
  });

  it('ignores an unknown id', () => {
    expect(touchFeed({}, 'nope')).toBe(false);
  });
});
