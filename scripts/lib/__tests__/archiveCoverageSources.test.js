// Provenance gaps in the curation worklist.
//
// The Sources view shows a reader where an event's data came from; these checks
// put the same gaps in front of the person who can close them. They are ordinary
// coverage checks so they inherit everything the deck already does — snoozing,
// scoring, the fixable count — rather than becoming a second worklist with its
// own rules.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCoverage } from '../archiveCoverage.js';

let dir;

const base = (overrides = {}) => ({
  event: {
    designation: 'DemoCon',
    location: 'Utrecht',
    year: '2020',
    startDate: '2020-06-01T09:00:00Z',
    endDate: '2020-06-02T17:00:00Z',
    venue: 'Jaarbeurs',
    latitude: 52.08,
    longitude: 5.1,
    ...overrides,
  },
  items: [
    {
      title: 'A talk',
      startTime: '2020-06-01T09:00:00Z',
      duration: 'P45M',
      sourceIds: ['sched'],
      ...(overrides.__item || {}),
    },
  ],
});

const write = (name, data) => writeFile(join(dir, 'events', name), JSON.stringify(data));
// Match on the separator too: `events/unlisted.json`.endsWith(`listed.json`) is
// true, so a bare endsWith quietly graded the wrong fixture.
const check = (cov, file, key) =>
  cov.events.find((e) => e.file.endsWith(`/${file}`))?.checks.find((c) => c.key === key);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'coverage-sources-'));
  await mkdir(join(dir, 'events'), { recursive: true });

  // Sponsors, and the page that listed them: nothing to do.
  await write(
    'listed.json',
    base({
      sponsors: [{ id: 'a', title: 'A', sourceIds: ['spon'] }],
      sources: [
        { id: 'sched', kind: 'schedule', url: 'http://x.test/schedule' },
        { id: 'spon', kind: 'sponsors', url: 'http://x.test/sponsors' },
      ],
    }),
  );

  // Sponsors, but no listing page — they fall back to the schedule, which never
  // said who sponsored anything.
  await write(
    'unlisted.json',
    base({
      sponsors: [{ id: 'a', title: 'A', sourceIds: ['sched'] }],
      sources: [{ id: 'sched', kind: 'schedule', url: 'http://x.test/schedule' }],
    }),
  );

  // No sponsors at all — a missing listing page is not a gap, it is nothing.
  await write(
    'nosponsors.json',
    base({ sources: [{ id: 'sched', kind: 'schedule', url: 'http://x.test/schedule' }] }),
  );

  // A record citing nothing.
  await write(
    'bare.json',
    base({
      sources: [{ id: 'sched', kind: 'schedule', url: 'http://x.test/schedule' }],
      __item: { sourceIds: undefined },
    }),
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('sponsor listing check', () => {
  it('is clear when the page that listed the sponsors is recorded', async () => {
    const cov = await buildCoverage(dir, undefined, { today: '2026-08-23' });
    expect(check(cov, 'listed.json', 'sponsorSource').missing).toBe(0);
  });

  it('flags sponsors attributed to a schedule page, and calls it fixable', async () => {
    const cov = await buildCoverage(dir, undefined, { today: '2026-08-23' });
    const c = check(cov, 'unlisted.json', 'sponsorSource');
    expect(c.missing).toBe(1);
    // Fixable: the sponsors are right there, somebody just has to find the page.
    expect(c.fixable).toBe(1);
  });

  it('says nothing about an event with no sponsors', async () => {
    const cov = await buildCoverage(dir, undefined, { today: '2026-08-23' });
    const c = check(cov, 'nosponsors.json', 'sponsorSource');
    expect(c.missing).toBe(0);
    expect(c.total).toBe(0);
  });
});

describe('unsourced records check', () => {
  it('is clear when every record cites something', async () => {
    const cov = await buildCoverage(dir, undefined, { today: '2026-08-23' });
    expect(check(cov, 'listed.json', 'unsourced').missing).toBe(0);
  });

  it('catches a record that cites nothing', async () => {
    const cov = await buildCoverage(dir, undefined, { today: '2026-08-23' });
    expect(check(cov, 'bare.json', 'unsourced').missing).toBe(1);
  });
});

describe('what is deliberately NOT checked', () => {
  it('does not flag undated sources', async () => {
    // 258 of them span all 90 real events and most cannot be dated — much of
    // this archive was gathered before provenance was recorded. A check every
    // event fails is one nobody reads. report:sources carries that number.
    const cov = await buildCoverage(dir, undefined, { today: '2026-08-23' });
    expect(cov.checks.some((c) => c.key === 'sourceDates')).toBe(false);
  });
});
