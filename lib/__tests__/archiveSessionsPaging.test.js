// Paging the session results.
//
// The list was capped at 200 with no way past it, which made a broad search
// unreadable AND made the breakdown look wrong: the tallies count every match,
// so a speaker credited with 15 could show up once in the visible page. The cap
// stays — the fix is being able to ask for the next page.
//
// What must NOT page: `total`, the trend chart and the breakdown. They are
// answers about the whole result set at every offset.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchSessions } from '../archiveSessions.js';

let dir;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'archive-paging-'));
  await mkdir(join(dir, 'events'), { recursive: true });
  const items = Array.from({ length: 5 }, (_, n) => ({
    title: `Testing session ${n + 1}`,
    full_description: 'All about testing.',
    speakers: n < 3 ? ['Ada Lovelace'] : ['Grace Hopper'],
    startTime: `2025-01-0${n + 1}T09:00:00Z`,
  }));
  await writeFile(
    join(dir, 'events', 'demo.json'),
    JSON.stringify({
      event: {
        designation: 'DemoCon',
        location: 'Utrecht',
        year: '2025',
        regionCode: 'EUR',
        country: 'NL',
      },
      items,
    }),
  );
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('searchSessions match mode', () => {
  it('matches whole words by DEFAULT', async () => {
    // "test" must not reach inside "Testing". Substring matching is the more
    // surprising rule, so it is the one you have to ask for.
    const d = await searchSessions(dir, 'test');
    expect(d.mode).toBe('exact');
    expect(d.total).toBe(0);
  });

  it('still offers substring matching on request', async () => {
    const d = await searchSessions(dir, 'test', { mode: 'contains' });
    expect(d.mode).toBe('contains');
    expect(d.total).toBe(5);
  });

  it('treats an unknown mode as the default rather than as contains', async () => {
    const d = await searchSessions(dir, 'test', { mode: 'fuzzy' });
    expect(d.mode).toBe('exact');
    expect(d.total).toBe(0);
  });
});

describe('searchSessions paging', () => {
  it('returns the first page by default, newest first', async () => {
    const d = await searchSessions(dir, 'testing', { limit: 2 });
    expect(d.total).toBe(5);
    expect(d.offset).toBe(0);
    expect(d.results.map((r) => r.title)).toEqual(['Testing session 5', 'Testing session 4']);
  });

  it('slices the next page at an offset, with no overlap', async () => {
    const d = await searchSessions(dir, 'testing', { limit: 2, offset: 2 });
    expect(d.offset).toBe(2);
    expect(d.results.map((r) => r.title)).toEqual(['Testing session 3', 'Testing session 2']);
  });

  it('keeps total, breakdown and trend whole-archive at every offset', async () => {
    const first = await searchSessions(dir, 'testing', { limit: 2 });
    const last = await searchSessions(dir, 'testing', { limit: 2, offset: 4 });
    expect(last.total).toBe(first.total);
    expect(last.byYear).toEqual(first.byYear);
    expect(last.breakdown).toEqual(first.breakdown);
    // Ada spoke at 3 of the 5, and that is true on page 3 as much as page 1 —
    // even though only ONE result is on the page being returned.
    expect(last.results).toHaveLength(1);
    expect(last.breakdown.speakers).toContainEqual({ name: 'Ada Lovelace', count: 3, total: 3 });
  });

  it('runs off the end without error', async () => {
    const d = await searchSessions(dir, 'testing', { offset: 9999 });
    expect(d.results).toEqual([]);
    expect(d.total).toBe(5);
  });

  it('treats a negative offset as the start', async () => {
    const d = await searchSessions(dir, 'testing', { limit: 1, offset: -10 });
    expect(d.offset).toBe(0);
    expect(d.results).toHaveLength(1);
  });
});
