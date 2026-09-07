import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCatalog, writeCatalog } from '../buildCatalog.js';

describe('buildCatalog', () => {
  let dir;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'catalog-'));
    await mkdir(join(dir, 'events', 'series', 'nested'), { recursive: true });
    // Nested + flat event files — the walk must find both.
    await writeFile(
      join(dir, 'events', 'series', 'a.json'),
      JSON.stringify({
        event: {
          designation: 'DrupalSouth',
          location: 'Wellington',
          year: '2026',
          startDate: '2026-05-11T21:00:00Z',
          enabled: true,
          default: true, // marks the default event
          somethingUnused: 'ignore me',
        },
        sessions: [{ title: 'not included' }],
      }),
    );
    await writeFile(
      join(dir, 'events', 'series', 'nested', 'b.json'),
      JSON.stringify({ event: { designation: 'DrupalCon', location: 'Vienna' } }),
    );
    // Invalid JSON on disk → skipped, not fatal.
    await writeFile(join(dir, 'events', 'series', 'broken.json'), '{ not json');
    // Top-level data files must never be treated as events.
    await writeFile(join(dir, 'catalog.json'), '{}');
    await writeFile(join(dir, 'sponsors.json'), '{}');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('walks event files, applies the field whitelist and skips unreadable ones', async () => {
    const catalog = await buildCatalog(dir);

    expect(catalog).toHaveProperty('generatedAt');
    // Only readable event files, sorted; top-level data files excluded.
    expect(catalog.events.map((e) => e.file)).toEqual([
      'events/series/a.json',
      'events/series/nested/b.json',
    ]);

    const a = catalog.events.find((e) => e.file === 'events/series/a.json').event;
    expect(a.designation).toBe('DrupalSouth');
    expect(a.enabled).toBe(true);
    expect(a.startDate).toBe('2026-05-11T21:00:00Z');
    // Whitelist only — no session data, extras, or the internal `default` flag.
    expect(a).not.toHaveProperty('somethingUnused');
    expect(a).not.toHaveProperty('sessions');
    expect(a).not.toHaveProperty('default');

    // The invalid file is reported so callers can log it (not silently lost).
    expect(catalog.skipped).toEqual([{ file: 'events/series/broken.json', reason: 'SyntaxError' }]);
  });

  it('resolves defaultFile from the event flag, falling back to the first file', async () => {
    expect((await buildCatalog(dir)).defaultFile).toBe('events/series/a.json');

    // Remove the flag → falls back to the first (sorted) file.
    await writeFile(
      join(dir, 'events', 'series', 'a.json'),
      JSON.stringify({ event: { designation: 'DrupalSouth' } }),
    );
    expect((await buildCatalog(dir)).defaultFile).toBe('events/series/a.json');
  });

  it('writeCatalog emits catalog.json only (no legacy index.json)', async () => {
    await writeCatalog(dir);

    const catalog = JSON.parse(await readFile(join(dir, 'catalog.json'), 'utf8'));
    expect(catalog.defaultFile).toBe('events/series/a.json');
    expect(catalog.events.map((e) => e.file)).toEqual([
      'events/series/a.json',
      'events/series/nested/b.json',
    ]);
    expect(catalog).not.toHaveProperty('skipped'); // kept out of the committed file

    // index.json is retired — writeCatalog must not resurrect it.
    await expect(readFile(join(dir, 'index.json'), 'utf8')).rejects.toThrow();
  });
});
