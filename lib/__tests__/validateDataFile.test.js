import { describe, it, expect } from 'vitest';
import { validateDataFile, summarizeErrors } from '../validateDataFile.js';

// Fixtures, deliberately NOT the real files under app/data. The archive is
// configurable (DATA_ROOT) and can live outside this repository entirely, so a
// test that reads it fails the moment the data is detached — which is exactly what
// happened the first time these ran after the move.
const THEME_COLOR_KEYS = [
  'bg',
  'bgAlt',
  'primary',
  'secondary',
  'tertiary',
  'surface',
  'surfaceAlt',
  'surfaceDeep',
  'text',
  'textAlt',
  'textMuted',
  'textFaint',
  'border',
];
const themesFixture = () => [
  {
    id: 'test',
    label: 'Test',
    dark: false,
    colors: Object.fromEntries(THEME_COLOR_KEYS.map((k) => [k, '#000000'])),
  },
];
const sponsorsFixture = () => [{ title: 'Acme', aliases: ['acme corp'] }];

const validEvent = () => ({
  event: {
    designation: 'Test',
    location: 'Town',
    year: '2025',
    website: '',
    region: '',
    timezone: 'UTC',
    enabled: true,
    columns: 1,
    scheduleURLs: [],
    logo: { image: '', imageAlt: '', usePlate: false },
    flickr: { enabled: false, groupUrl: '', image: '', imageAlt: '' },
    sponsors: [],
  },
  items: [],
});

describe('picking a schema by filename', () => {
  it('validates an event dataset against the event schema', () => {
    const r = validateDataFile('events/drupalcon/eu/2025.json', validEvent());
    expect(r.valid).toBe(true);
    expect(r.schema).toBe('event.schema.json');
  });

  it('validates themes.json against the THEMES schema, not the event one', () => {
    // The trap this guards: `/api/data/*` is not only event datasets. The editor
    // saves themes through the same route, and holding them to the event schema
    // would reject every theme save.
    const r = validateDataFile('themes.json', themesFixture());
    expect(r.schema).toBe('themes.schema.json');
    expect(r.valid).toBe(true);
  });

  it('validates sponsors.json against the sponsors schema', () => {
    const r = validateDataFile('sponsors.json', sponsorsFixture());
    expect(r.schema).toBe('sponsors.schema.json');
    expect(r.valid).toBe(true);
  });

  it('would reject that same themes document if it were judged as an event', () => {
    // Proves the previous test is meaningful rather than vacuously passing.
    expect(validateDataFile('events/x.json', themesFixture()).valid).toBe(false);
  });

  it('skips generated caches rather than failing them', () => {
    for (const f of ['catalog.json', 'geocache.json', 'album-thumbs.json']) {
      const r = validateDataFile(f, { anything: true });
      expect(r).toMatchObject({ valid: true, skipped: true, schema: null });
    }
  });

  it('matches on the basename, wherever the file sits', () => {
    expect(validateDataFile('nested/dir/themes.json', {}).schema).toBe('themes.schema.json');
    expect(validateDataFile('themes.json', {}).schema).toBe('themes.schema.json');
  });
});

describe('rejecting what the browser validator lets through', () => {
  // The concrete case from docs/todo.md 2.4: vendored AJV 6 accepts these, the
  // server must not, and this route is now the gate that stops them.
  it.each([
    ['month 13', '2025-13-28T09:00:00Z'],
    ['day 32', '2025-09-32T09:00:00Z'],
    ['hour 25', '2025-09-28T25:00:00Z'],
  ])('rejects %s', (_label, startDate) => {
    const d = validEvent();
    d.event.startDate = startDate;
    const r = validateDataFile('events/x.json', d);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.path.includes('startDate'))).toBe(true);
  });

  it('still accepts a genuinely valid timestamp', () => {
    const d = validEvent();
    d.event.startDate = '2025-09-28T09:00:00Z';
    expect(validateDataFile('events/x.json', d).valid).toBe(true);
  });
});

describe('summarizeErrors', () => {
  it('names the field and the problem, because the editor shows it verbatim', () => {
    const s = summarizeErrors([
      { path: '.event.startDate', message: 'must match format "date-time"' },
    ]);
    expect(s).toContain('.event.startDate');
    expect(s).toContain('date-time');
  });

  it('caps the list and counts the remainder', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ path: `.f${i}`, message: 'bad' }));
    const s = summarizeErrors(many);
    expect(s).toContain('and 4 more');
  });

  it('never throws on an empty or odd input', () => {
    expect(summarizeErrors([])).toBe('Schema validation failed');
    expect(summarizeErrors(null)).toBe('Schema validation failed');
  });
});
