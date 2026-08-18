import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateDataset, DATASET_SCHEMA_FINGERPRINT } from '../validateDataset.js';

describe('schema fingerprint', () => {
  it('is a hash of the schema file that is actually enforced', () => {
    // Not a hand-maintained version number — those drift from the schema they
    // claim to describe. Deriving it from the bytes makes that impossible, which
    // is the whole reason a data repo can trust it as a pin.
    const schemaPath = fileURLToPath(
      new URL('../../app/schemas/event.schema.json', import.meta.url),
    );
    const expected = createHash('sha256')
      .update(readFileSync(schemaPath, 'utf8'))
      .digest('hex')
      .slice(0, 12);
    expect(DATASET_SCHEMA_FINGERPRINT).toBe(expected);
    expect(DATASET_SCHEMA_FINGERPRINT).toMatch(/^[0-9a-f]{12}$/);
  });
});

const validEvent = {
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
};

describe('validateDataset', () => {
  it('accepts a minimal valid event dataset', () => {
    const { valid, errors } = validateDataset(validEvent);
    expect(errors).toEqual([]);
    expect(valid).toBe(true);
  });

  it('rejects a dataset missing required top-level keys', () => {
    const { valid, errors } = validateDataset({ event: validEvent.event });
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects an unknown extra property (strict schema)', () => {
    const bad = { ...validEvent, event: { ...validEvent.event, bogus: true } };
    const { valid } = validateDataset(bad);
    expect(valid).toBe(false);
  });
});
