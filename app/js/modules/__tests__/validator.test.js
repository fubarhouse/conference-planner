import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createContext, runInContext } from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA = JSON.parse(
  readFileSync(resolve(__dirname, '../../../schemas/event.schema.json'), 'utf-8'),
);

// The editor loads Ajv as a plain <script>, so the browser's validator is whatever
// app/vendor ships — not the copy in node_modules, which is a different major
// version used by the server. Running the vendored bundle here means these tests
// exercise the file that actually reaches the page.
function vendoredAjv() {
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  createContext(sandbox);
  runInContext(
    readFileSync(resolve(__dirname, '../../../vendor/ajv-6.12.6.min.js'), 'utf-8'),
    sandbox,
  );
  return sandbox.Ajv;
}

// Minimal dataset that satisfies every required field in event.schema.json
const VALID_DATASET = {
  event: {
    designation: 'DrupalSouth',
    location: 'Melbourne',
    year: '2025',
    website: 'https://example.com',
    region: 'Australia – Melbourne',
    timezone: 'Australia/Melbourne',
    enabled: true,
    columns: 3,
    scheduleURLs: [],
    logo: { image: 'img/logo.png', imageAlt: 'Logo', usePlate: false },
    flickr: { enabled: false, groupUrl: '', image: '', imageAlt: '' },
    sponsors: [],
  },
  items: [],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

// `ok` included because the real thing has it, and the loader checks it: a 404
// that returns an HTML error page used to surface as "Unexpected token '<'".
function makeFetchStub(schema = SCHEMA, { ok = true, status = 200 } = {}) {
  return vi.fn(() => Promise.resolve({ ok, status, json: () => Promise.resolve(schema) }));
}

async function freshValidator(fetchStub, AjvStub) {
  vi.resetModules();
  vi.stubGlobal('fetch', fetchStub ?? makeFetchStub());
  if (AjvStub !== undefined) vi.stubGlobal('Ajv', AjvStub);
  return import('../validator.js');
}

describe('loading the schema', () => {
  it('reports the HTTP status when the schema cannot be fetched', async () => {
    // A deep route used to answer this request with editor.html, so the JSON parse
    // failed on "<!DOCTYPE" and the message said nothing useful. Fail on the status
    // instead, before anything tries to parse a page as a schema.
    const { validateDataset } = await freshValidator(
      makeFetchStub(SCHEMA, { ok: false, status: 404 }),
    );
    const result = await validateDataset(structuredClone(VALID_DATASET));
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('404');
  });
});

// ── formatValidationErrors ────────────────────────────────────────────────────

describe('formatValidationErrors', () => {
  // Import once — formatValidationErrors has no module-level state
  let formatValidationErrors;
  beforeEach(async () => {
    ({ formatValidationErrors } = await freshValidator());
  });

  it('formats a basic error with path and message', () => {
    const errors = [{ instancePath: '/event/year', message: 'must match pattern' }];
    const output = formatValidationErrors(errors);
    expect(output).toContain('/event/year');
    expect(output).toContain('must match pattern');
  });

  it('annotates additionalProperties errors with the unexpected key', () => {
    const errors = [
      {
        instancePath: '/event',
        message: 'must NOT have additional properties',
        keyword: 'additionalProperties',
        params: { additionalProperty: 'bogusField' },
      },
    ];
    expect(formatValidationErrors(errors)).toContain('"bogusField"');
  });

  it('truncates to 15 errors and appends a "… and N more" line', () => {
    const errors = Array.from({ length: 20 }, (_, i) => ({
      instancePath: `/items/${i}`,
      message: 'error',
    }));
    const output = formatValidationErrors(errors);
    expect(output).toContain('… and 5 more');
  });

  it('resolves dataset context for object errors', () => {
    const dataset = { items: [{ title: 'My Talk', badField: 'oops' }] };
    const errors = [{ instancePath: '/items/0', message: 'fail' }];
    const output = formatValidationErrors(errors, dataset);
    expect(output).toContain('"My Talk"');
  });

  it('handles a null dataset without throwing', () => {
    const errors = [{ instancePath: '/items/0', message: 'fail' }];
    expect(() => formatValidationErrors(errors, null)).not.toThrow();
  });
});

// ── validateDataset ───────────────────────────────────────────────────────────

describe('validateDataset', () => {
  it('returns valid:true for a minimal schema-conformant dataset', async () => {
    // Use the real, vendored Ajv so the schema is actually evaluated
    const Ajv = vendoredAjv();
    const { validateDataset } = await freshValidator(makeFetchStub(), Ajv);
    const result = await validateDataset(structuredClone(VALID_DATASET));
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('returns valid:false when a required event field is missing', async () => {
    const Ajv = vendoredAjv();
    const { validateDataset } = await freshValidator(makeFetchStub(), Ajv);
    const bad = structuredClone(VALID_DATASET);
    delete bad.event.designation;
    const result = await validateDataset(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('returns valid:false for an additionalProperties violation', async () => {
    const Ajv = vendoredAjv();
    const { validateDataset } = await freshValidator(makeFetchStub(), Ajv);
    const bad = structuredClone(VALID_DATASET);
    bad.event.unknownField = 'surprise';
    const result = await validateDataset(bad);
    expect(result.valid).toBe(false);
  });

  it('returns valid:false (not valid:true) when fetch fails', async () => {
    const failFetch = vi.fn(() => Promise.reject(new Error('Network error')));
    const { validateDataset } = await freshValidator(failFetch, undefined);
    const result = await validateDataset(VALID_DATASET);
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toMatch(/schema validation unavailable/i);
  });

  it('returns valid:false (not valid:true) when Ajv is not available', async () => {
    const { validateDataset } = await freshValidator(makeFetchStub(), undefined);
    // Ajv is not set as a global — globalThis.Ajv will be undefined, causing a TypeError
    vi.stubGlobal('Ajv', undefined);
    const result = await validateDataset(VALID_DATASET);
    expect(result.valid).toBe(false);
  });

  it('does not silently pass on a second call after Ajv fails', async () => {
    const failFetch = vi.fn(() => Promise.reject(new Error('gone')));
    const { validateDataset } = await freshValidator(failFetch, undefined);
    // First call — populates _validatorError
    await validateDataset(VALID_DATASET);
    // Second call — must re-throw the cached error, not return valid:true
    const result = await validateDataset(VALID_DATASET);
    expect(result.valid).toBe(false);
  });
});
