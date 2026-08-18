import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import { createV1Router } from '../crudApi.js';
import { validateDataset } from '../validateDataset.js';
import { HttpError } from '../httpError.js';

// plannerStorage's factory touches localStorage lazily; stub it so the import is
// safe in the node test environment (mirrors validatePlanner.test.js).
vi.stubGlobal('localStorage', {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  length: 0,
  key: () => null,
});
const { validatePlanner } = await import('../validatePlanner.js');
const { makeEmptyPlanner } = await import('../../app/js/modules/plannerStorage.js');

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

const sponsorInput = (title) => ({
  title,
  tier: 'Gold',
  row: 1,
  priority: 1,
  image: '',
  imageAlt: '',
  link: '',
  bgStyle: 'auto',
  aspect: 'auto',
  enabled: true,
});

// In-memory document store standing in for the disk/S3-backed I/O helpers.
function makeStore(seed) {
  const m = new Map(Object.entries(seed));
  return {
    map: m,
    list: async () => [...m.keys()],
    read: async (p) => {
      if (!m.has(p)) throw new HttpError(404, 'Not found');
      return JSON.stringify(m.get(p));
    },
    write: async (p, s) => {
      m.set(p, JSON.parse(s));
      return { ok: true };
    },
    remove: async (p) => {
      if (!m.has(p)) throw new HttpError(404, 'Not found');
      m.delete(p);
      return { ok: true };
    },
  };
}

let server;
let base;
let datasets;
let planners;

beforeAll(async () => {
  datasets = makeStore({ 'events/t.json': validEvent() });
  planners = makeStore({ 'e.json': makeEmptyPlanner('e', 'e.json') });
  const app = express();
  app.use(
    '/api/v1',
    createV1Router({
      requireRole: () => (req, res, next) => next(),
      datasets: { ...datasets, validate: validateDataset, schemaFingerprint: 'abc123dataset' },
      planners: { ...planners, validate: validatePlanner, schemaFingerprint: 'abc123planner' },
    }),
  );
  await new Promise((r) => {
    server = app.listen(0, r);
  });
  base = `http://127.0.0.1:${server.address().port}/api/v1`;
});

afterAll(() => server?.close());

const j = (res) => res.json();
const send = (method, path, body) =>
  fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe('createV1Router — whole documents', () => {
  it('lists and reads documents', async () => {
    expect(await j(await send('GET', '/planners'))).toEqual(['e.json']);
    const doc = await j(await send('GET', '/planners/e.json'));
    expect(doc._eventFile).toBe('e.json');
    expect((await j(await send('GET', '/datasets'))).sort()).toEqual(['events/t.json']);
  });

  it('404s an unknown document and unknown collection', async () => {
    expect((await send('GET', '/planners/missing.json')).status).toBe(404);
    expect((await send('GET', '/planners/e.json/not-a-collection')).status).toBe(404);
  });

  it('rejects a whole-document replace that fails validation (422)', async () => {
    const res = await send('PUT', '/planners/e.json', { mode: 'bogus' });
    expect(res.status).toBe(422);
    expect((await j(res)).error).toBe('validation_failed');
  });
});

describe('createV1Router — nested planner collection lifecycle', () => {
  it('creates, lists, replaces, and deletes an element', async () => {
    const created = await j(await send('POST', '/planners/e.json/tasks', { text: 'Book flights' }));
    expect(created.text).toBe('Book flights');
    expect(created.id).toMatch(/^t_/);

    const list = await j(await send('GET', '/planners/e.json/tasks'));
    expect(list).toHaveLength(1);

    const replaced = await j(
      await send('PUT', `/planners/e.json/tasks/${created.id}`, { text: 'Done', id: 'ignored' }),
    );
    expect(replaced.id).toBe(created.id); // id preserved, body id ignored
    expect(replaced.text).toBe('Done');

    expect((await send('DELETE', `/planners/e.json/tasks/${created.id}`)).status).toBe(200);
    expect(await j(await send('GET', '/planners/e.json/tasks'))).toEqual([]);
  });

  it('405s POST-to-element and PUT-to-collection; 404s a missing element', async () => {
    expect((await send('POST', '/planners/e.json/tasks/x', { text: 'y' })).status).toBe(405);
    expect((await send('PUT', '/planners/e.json/tasks', { text: 'y' })).status).toBe(405);
    expect((await send('PUT', '/planners/e.json/tasks/nope', { text: 'y' })).status).toBe(404);
  });
});

describe('createV1Router — dataset sponsors', () => {
  it('mints a slug id from the title and keeps the dataset valid', async () => {
    const created = await j(
      await send('POST', '/datasets/events/t.json/sponsors', sponsorInput('Acme Corp')),
    );
    expect(created.id).toBe('acme-corp');
    const list = await j(await send('GET', '/datasets/events/t.json/sponsors'));
    expect(list.map((s) => s.id)).toEqual(['acme-corp']);
  });

  it('rejects a sponsor that breaks the dataset schema (422)', async () => {
    const res = await send('POST', '/datasets/events/t.json/sponsors', { title: 'x' }); // missing required
    expect(res.status).toBe(422);
  });
});

describe('POST /validate — check a document without storing it', () => {
  it('accepts a valid dataset and reports the schema it used', async () => {
    const res = await send('POST', '/validate', validEvent());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      valid: true,
      errors: [],
      domain: 'datasets',
      schemaFingerprint: 'abc123dataset',
    });
  });

  it('answers 200 for an INVALID document — the request succeeded', async () => {
    // The distinction the endpoint exists to preserve: "your document is wrong"
    // is a result, not a failed call. A CI job reads `valid`; it cannot tell a
    // rejected document from a malformed request by status code alone.
    const res = await send('POST', '/validate', { event: {}, items: 'not-an-array' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(false);
    expect(body.errors.length).toBeGreaterThan(0);
    expect(body.errors[0]).toHaveProperty('path');
    expect(body.errors[0]).toHaveProperty('message');
  });

  it('validates planners when asked', async () => {
    const res = await send('POST', '/validate?domain=planners', makeEmptyPlanner('x', 'x.json'));
    const body = await res.json();
    expect(body.valid).toBe(true);
    expect(body.domain).toBe('planners');
    expect(body.schemaFingerprint).toBe('abc123planner');
  });

  it('stores nothing — validation must not be a write', async () => {
    const before = [...datasets.map.keys()];
    await send('POST', '/validate', validEvent());
    await send('POST', '/validate', { garbage: true });
    expect([...datasets.map.keys()]).toEqual(before);
  });

  it('rejects an unknown domain rather than guessing', async () => {
    const res = await send('POST', '/validate?domain=sponsors', validEvent());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Unknown domain/);
  });

  it('rejects a missing or unparseable body', async () => {
    expect((await send('POST', '/validate')).status).toBe(400);
    const bad = await fetch(`${base}/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/Invalid JSON/);
  });

  it('is not shadowed by the /datasets/* wildcard', async () => {
    // `/validate` has no `.json`, so if the wildcard ever matched it first the
    // answer would be "Path must reference a .json document".
    const body = await j(await send('POST', '/validate', validEvent()));
    expect(body).not.toHaveProperty('error');
  });
});
