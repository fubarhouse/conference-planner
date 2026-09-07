// The quality probes exist to catch what a coverage score cannot see: a field
// that is filled in but wrong. Each one is tuned to a defect found in real data,
// so each test pins both halves — it fires on the defect, and it stays quiet on
// the legitimate case that looks like it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildQuality } from '../archiveQuality.js';

let dir;

const session = (over = {}) => ({
  startTime: '2024-05-06T16:00:00Z',
  endTime: '2024-05-06T17:00:00Z',
  duration: 'P60M',
  title: 'A talk',
  location: 'Hall A',
  track: ['main'],
  speakers: ['A Speaker'],
  full_description: 'Real content.\n\nWith a second paragraph.',
  video_url: '',
  link: 'https://events.example/session/a-talk',
  sponsorIds: '',
  ...over,
});

const dataset = (items, event = {}) => ({
  event: {
    designation: 'DemoCon',
    location: 'Utrecht',
    startDate: '2024-05-06T09:00:00Z',
    endDate: '2024-05-08T17:00:00Z',
    sponsors: [{ id: 's', title: 'S', link: 'https://s.example/', image: './img/s.png' }],
    ...event,
  },
  items,
});

const find = (q, file) => q.events.find((e) => e.file === file);
const defect = (ev, key) => ev.findings.find((f) => f.key === key)?.count || 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'quality-'));
  await mkdir(join(dir, 'events'), { recursive: true });

  const long = `${'x'.repeat(500)}`;
  await writeFile(
    join(dir, 'events', 'defective.json'),
    JSON.stringify(
      dataset(
        [
          session({ full_description: long }), // flattened: long, no blank line
          session({ full_description: 'Tea &amp; biscuits.' }), // undecoded entity
          session({
            full_description: 'See [https://x.example/very-lo…](https://x.example/very-long)',
          }),
          session({ link: 'https://events.example//session/doubled' }),
          session({ location: 'Location Hall C' }),
          // Eight identical short descriptions: page furniture, not eight talks.
          ...Array.from({ length: 8 }, () =>
            session({ full_description: 'Join our mailing list.' }),
          ),
        ],
        { sponsors: [{ id: 'a', title: 'A', link: '', image: '' }] },
      ),
    ),
  );

  await writeFile(
    join(dir, 'events', 'clean.json'),
    JSON.stringify(
      dataset([
        session(),
        // A long description WITH paragraphs is fine, however long it runs.
        session({ full_description: `${'y'.repeat(500)}\n\nSecond paragraph.` }),
        // Repeated coffee breaks legitimately share one line — under the threshold.
        ...Array.from({ length: 4 }, () => session({ full_description: 'Coffee break.' })),
      ]),
    ),
  );
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('quality probes', () => {
  it('finds each defect exactly once', async () => {
    const q = await buildQuality(dir);
    const ev = find(q, 'defective');
    expect(defect(ev, 'flattened')).toBe(1);
    expect(defect(ev, 'entities')).toBe(1);
    expect(defect(ev, 'truncated-links')).toBe(1);
    expect(defect(ev, 'double-slash')).toBe(1);
    expect(defect(ev, 'room-label')).toBe(1);
    expect(defect(ev, 'boilerplate')).toBe(8);
    expect(defect(ev, 'sponsor-no-link')).toBe(1);
    expect(defect(ev, 'sponsor-no-image')).toBe(1);
  });

  it('leaves a clean dataset alone', async () => {
    const q = await buildQuality(dir);
    const ev = find(q, 'clean');
    // A 500-character description with a paragraph break is not flattened, and four
    // identical "Coffee break." lines are four coffee breaks.
    expect(ev.findings).toEqual([]);
    expect(ev.defects).toBe(0);
  });

  it('reports completeness beside the defects', async () => {
    const q = await buildQuality(dir);
    const recordings = q.fields.find((f) => f.key === 'recordings');
    expect(recordings.have).toBe(0);
    expect(recordings.pct).toBe(0);
    const rooms = q.fields.find((f) => f.key === 'rooms');
    expect(rooms.have).toBe(rooms.total); // "Location Hall C" is filled in, just wrong
  });

  it('ranks the worst offender first within a probe', async () => {
    const q = await buildQuality(dir);
    const boiler = q.probes.find((p) => p.key === 'boilerplate');
    expect(boiler.worst[0].file).toBe('defective');
    expect(boiler.count).toBe(8);
  });

  it('counts an event with no defects as clean, not as missing', async () => {
    const q = await buildQuality(dir);
    expect(q.totals.events).toBe(2);
    expect(q.totals.eventsWithDefects).toBe(1);
  });
});
