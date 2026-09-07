import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyEntry, readCacheDir } from '../sourceCache.mjs';
import { classifyDatasetUrl, matchCacheToDataset } from '../../backfill-sources.mjs';

describe('classifyEntry', () => {
  it('reads a /session/ path segment as a session page', () => {
    expect(
      classifyEntry('http://wellington2010.drupalsouth.net.nz/session/php-for-designers'),
    ).toBe('sessions');
  });

  it('reads a schedule that merely contains the word "session" as a schedule', () => {
    // This exact URL was classified as a session page and cost DrupalSouth 2012
    // every one of its item attributions.
    expect(classifyEntry('http://drupaldownunder.org/program/session-schedule/all')).toBe(
      'schedule',
    );
  });

  it('recognises venue and accommodation pages', () => {
    expect(classifyEntry('http://example.test/venue')).toBe('venue');
    expect(classifyEntry('http://example.test/2011/venue-accommodation')).toBe('venue');
  });

  it('recognises date-shaped schedule pages', () => {
    expect(classifyEntry('https://events.drupal.org/portland2022/schedule/2022-04-25')).toBe(
      'schedule',
    );
  });

  it('falls back to other for an unremarkable url', () => {
    expect(classifyEntry('https://groups.drupal.org/node/15171')).toBe('other');
  });

  it('uses the filename hint when the url says nothing', () => {
    expect(classifyEntry('http://lanyrd.com/2013/x/abc/', 'session-wayback-urls.txt')).toBe(
      'sessions',
    );
  });
});

describe('assets are not sources', () => {
  it('keeps images, stylesheets and scripts out of the registry', () => {
    // A logo PNG reached the registry as an `other` source that nothing could
    // ever cite. A picture does not say who spoke at a conference.
    const dir = mkdtempSync(join(tmpdir(), 'srccache-'));
    mkdirSync(join(dir, 'raw'), { recursive: true });
    writeFileSync(
      join(dir, 'raw', 'urls.json'),
      JSON.stringify({
        urls: [
          'http://x.test/schedule',
          'http://x.test/sites/files/logo.png',
          'http://x.test/css/style.css?v=2',
        ],
      }),
    );
    const read = readCacheDir(dir);
    expect(read.entries.map((e) => e.url)).toEqual(['http://x.test/schedule']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps a PDF — for an older conference the programme often IS a PDF', () => {
    const dir = mkdtempSync(join(tmpdir(), 'srccache-'));
    mkdirSync(join(dir, 'raw'), { recursive: true });
    writeFileSync(
      join(dir, 'raw', 'urls.json'),
      JSON.stringify({ urls: ['http://x.test/files/Program-Wed10am.pdf'] }),
    );
    expect(readCacheDir(dir).entries).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('classifyDatasetUrl', () => {
  it('sorts the other_urls grab bag by what the path looks like', () => {
    expect(classifyDatasetUrl('https://drupaljam.nl/sponsors')).toBe('sponsors');
    expect(classifyDatasetUrl('https://drupaljam.nl/program')).toBe('schedule');
    expect(classifyDatasetUrl('https://events.drupal.org/travel')).toBe('venue');
    expect(classifyDatasetUrl('https://example.test/volunteers')).toBe('community');
    expect(classifyDatasetUrl('https://example.test/speakers')).toBe('speaker');
    // "locations" also matches the venue test, so ordering matters: the
    // Association's page about who runs these events is an organiser page.
    expect(classifyDatasetUrl('https://www.drupal.org/association/drupalcon/locations')).toBe(
      'community',
    );
    expect(classifyDatasetUrl('https://example.test/')).toBe('other');
  });
});

describe('matchCacheToDataset', () => {
  const datasets = [
    '/d/events/drupalgovau/2013-canberra.json',
    '/d/events/drupalcon/eu/2009-paris.json',
    '/d/events/drupalcon/us/2022-portland.json',
    '/d/events/drupalsouth/2008-christchurch.json',
    '/d/events/drupalsouth/2008-drupalcamp-sydney.json',
  ];

  it('matches on year plus a name token', () => {
    expect(matchCacheToDataset('/c/drupalgovau-2013', datasets).path).toContain('2013-canberra');
  });

  it('matches a cache named after the city', () => {
    expect(matchCacheToDataset('/c/drupalcon-paris-2009', datasets).path).toContain('2009-paris');
  });

  it('matches a name with no separator', () => {
    expect(matchCacheToDataset('/c/portland2022', datasets).path).toContain('2022-portland');
  });

  it('refuses to guess between two equally good candidates', () => {
    const result = matchCacheToDataset('/c/drupalsouth-2008', datasets);
    expect(result.path).toBeNull();
    expect(result.reason).toMatch(/ambiguous/);
  });

  it('reports a year with no dataset rather than falling back to another year', () => {
    const result = matchCacheToDataset('/c/drupalsouth-2009', datasets);
    expect(result.path).toBeNull();
    expect(result.reason).toMatch(/no dataset for 2009/);
  });

  it('reports a cache directory with no year in its name', () => {
    expect(matchCacheToDataset('/c/misc', datasets).reason).toMatch(/no year/);
  });
});
