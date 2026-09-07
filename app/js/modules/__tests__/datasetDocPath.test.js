import { describe, expect, it } from 'vitest';

import { datasetDocPath } from '../editorDataset.js';

// `state.file` is not one thing, and prefixing it unconditionally produced
// `events/events/…` — a 404 that read like a missing dataset rather than like a
// bug in the caller. These are the forms it actually takes.
describe('datasetDocPath', () => {
  it('leaves the catalog form alone — it already has its root', () => {
    expect(datasetDocPath('events/drupalcon/eu/2026-rotterdam.json')).toBe(
      'events/drupalcon/eu/2026-rotterdam.json',
    );
  });

  it('does not double the prefix', () => {
    expect(datasetDocPath('events/ddd/2012-barcelona.json')).not.toContain('events/events');
  });

  it('roots a local-folder path that has directories but no events/', () => {
    expect(datasetDocPath('drupalcon/eu/2026-rotterdam.json')).toBe(
      'events/drupalcon/eu/2026-rotterdam.json',
    );
  });

  it('refuses a bare filename — it has never been filed anywhere', () => {
    expect(datasetDocPath('new-event.json')).toBe('');
    expect(datasetDocPath('2026-rotterdam.json')).toBe('');
  });

  it('tolerates a leading slash', () => {
    expect(datasetDocPath('/events/ddd/2012-barcelona.json')).toBe(
      'events/ddd/2012-barcelona.json',
    );
  });

  it('trims surrounding space', () => {
    expect(datasetDocPath('  events/a/b.json  ')).toBe('events/a/b.json');
  });

  it('refuses anything that is not a dataset file', () => {
    expect(datasetDocPath('')).toBe('');
    expect(datasetDocPath(null)).toBe('');
    expect(datasetDocPath(undefined)).toBe('');
    expect(datasetDocPath('events/a/b.txt')).toBe('');
    expect(datasetDocPath('events/index.json')).toBe('');
  });
});
