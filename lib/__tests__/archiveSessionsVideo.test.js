// The video view is the session search with one extra rule, and that rule changes
// what an empty query means. Everywhere else an empty search returns nothing —
// "show me everything" is not a useful default over 6,000 sessions. Over the
// recordings it is exactly the useful default, because the interesting question
// is often "what is there?" rather than "where is this one talk?".
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchSessions } from '../archiveSessions.js';

let dir;

const session = (over = {}) => ({
  startTime: '2024-09-24T09:00:00Z',
  endTime: '2024-09-24T09:45:00Z',
  duration: 'P45M',
  title: 'A talk about testing',
  location: 'Room 1',
  track: ['development'],
  speakers: ['Ada Lovelace'],
  full_description: 'Something worth watching.',
  video_url: '',
  link: 'https://events.example/session/a',
  sponsorIds: '',
  ...over,
});

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sessions-video-'));
  await mkdir(join(dir, 'events'), { recursive: true });
  await writeFile(
    join(dir, 'events', 'demo.json'),
    JSON.stringify({
      event: { designation: 'DemoCon', location: 'Barcelona', year: '2024', country: 'ES' },
      items: [
        session({ title: 'Filmed talk', video_url: 'https://youtu.be/abc123' }),
        session({ title: 'Also filmed', video_url: 'https://archive.org/details/x' }),
        session({ title: 'Not filmed' }),
        // Lunch is not a search result anywhere, filmed or not.
        session({ title: 'Lunch', isAgendaItem: true, video_url: 'https://youtu.be/zzz999' }),
      ],
    }),
  );
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('searchSessions with hasVideo', () => {
  it('browses every recording when the query is empty', async () => {
    const r = await searchSessions(dir, '', { hasVideo: true });
    expect(r.total).toBe(2);
    expect(r.results.map((x) => x.title).sort()).toEqual(['Also filmed', 'Filmed talk']);
  });

  it('still returns nothing for an empty query in the ordinary session search', async () => {
    const r = await searchSessions(dir, '');
    expect(r.total).toBe(0);
    expect(r.results).toEqual([]);
  });

  it('narrows to recordings that match the query', async () => {
    const r = await searchSessions(dir, 'Filmed talk', { hasVideo: true });
    expect(r.results.map((x) => x.title)).toEqual(['Filmed talk']);
  });

  it('lets the event name be searched, because that is where the place lives', async () => {
    // "barcelona" is a search someone types on the video view; the session has no
    // idea where it happened, the event does.
    const r = await searchSessions(dir, 'barcelona', { hasVideo: true });
    expect(r.total).toBe(2);
    const without = await searchSessions(dir, 'barcelona');
    expect(without.total).toBe(0); // the ordinary search is unchanged
  });

  it('excludes agenda items even when they carry a video', async () => {
    const r = await searchSessions(dir, '', { hasVideo: true });
    expect(r.results.some((x) => x.title === 'Lunch')).toBe(false);
  });

  it('carries the length through, so a card can say how long the recording is', async () => {
    const r = await searchSessions(dir, '', { hasVideo: true });
    expect(r.results.every((x) => x.minutes === 45)).toBe(true);
  });

  it('applies the same scope filters as every other view', async () => {
    expect((await searchSessions(dir, '', { hasVideo: true, series: 'DemoCon' })).total).toBe(2);
    expect((await searchSessions(dir, '', { hasVideo: true, series: 'OtherCon' })).total).toBe(0);
    expect((await searchSessions(dir, '', { hasVideo: true, year: '2024' })).total).toBe(2);
    expect((await searchSessions(dir, '', { hasVideo: true, year: '2019' })).total).toBe(0);
  });
});
