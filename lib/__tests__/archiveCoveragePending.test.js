// Some gaps are not gaps yet.
//
// A conference six weeks away has no recordings, no final headcount and no photo
// album — and reporting those as missing put future events at the top of a
// worklist nobody could action, with a score dragged down by facts that cannot
// exist. Those three checks wait for the event; everything else applies the moment
// a programme is published.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCoverage } from '../archiveCoverage.js';

let dir;

const dataset = (endDate) => ({
  event: {
    designation: 'DemoCon',
    location: 'Utrecht',
    year: endDate.slice(0, 4),
    startDate: `${endDate.slice(0, 8)}01T09:00:00Z`,
    endDate,
    venue: 'Jaarbeurs',
    latitude: 52.08,
    longitude: 5.1,
    sponsors: [{ id: 's', title: 'S' }],
  },
  items: [
    {
      title: 'A talk',
      startTime: `${endDate.slice(0, 10)}T09:00:00Z`,
      duration: 'P45M',
      full_description: 'About something.',
      speakers: ['A Speaker'],
      track: ['main'],
      link: 'https://example.test/a-talk',
      video_url: '',
    },
  ],
});

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'coverage-pending-'));
  await mkdir(join(dir, 'events'), { recursive: true });
  await writeFile(
    join(dir, 'events', 'future.json'),
    JSON.stringify(dataset('2026-12-01T17:00:00Z')),
  );
  await writeFile(
    join(dir, 'events', 'past.json'),
    JSON.stringify(dataset('2026-01-15T17:00:00Z')),
  );
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

const find = (cov, name) => cov.events.find((e) => e.file.endsWith(name));
const check = (ev, key) => ev.checks.find((c) => c.key === key);

describe('checks that wait for the event', () => {
  it('marks recordings, attendance and photos pending before the event ends', async () => {
    const cov = await buildCoverage(dir, undefined, { today: '2026-08-17' });
    const ev = find(cov, 'future.json');
    expect(ev.pending.sort()).toEqual(['Attendance', 'Photo album', 'Recordings']);
    for (const key of ['videos', 'attendance', 'photos']) {
      expect(check(ev, key).pending, key).toBe(true);
      expect(check(ev, key).open, key).toBe(false);
    }
  });

  it('counts them as gaps once the event has happened', async () => {
    const cov = await buildCoverage(dir, undefined, { today: '2026-08-17' });
    const ev = find(cov, 'past.json');
    expect(ev.pending).toEqual([]);
    for (const key of ['videos', 'attendance', 'photos']) {
      expect(check(ev, key).open, key).toBe(true);
    }
  });

  it('scores a future event only on what can be answered today', async () => {
    const cov = await buildCoverage(dir, undefined, { today: '2026-08-17' });
    // Same data, different dates: the future one must score HIGHER, because the
    // three unanswerable checks are left out of its average rather than counted 0.
    expect(find(cov, 'future.json').score).toBeGreaterThan(find(cov, 'past.json').score);
    // 88%, not 100%: community credits are still counted, because a drupal.org
    // event page lists organisers BEFORE the event — that one is answerable now,
    // and the fixture has none. Only the three post-event checks are excluded.
    expect(find(cov, 'future.json').score).toBe(88);
  });

  it('treats the last day of the event as still pending', async () => {
    // The album goes up after the closing session, not during it.
    const cov = await buildCoverage(dir, undefined, { today: '2026-12-01' });
    expect(find(cov, 'future.json').pending).toContain('Recordings');
  });

  it('applies the checks to an event with no dates at all', async () => {
    // Undated means unknown, not forthcoming — an undated record is usually an old
    // one, and hiding its gaps would hide the worst-kept datasets in the archive.
    await writeFile(
      join(dir, 'events', 'undated.json'),
      JSON.stringify({ event: { designation: 'X' }, items: [] }),
    );
    const cov = await buildCoverage(dir, undefined, { today: '2026-08-17' });
    expect(find(cov, 'undated.json').pending).toEqual([]);
  });
});
