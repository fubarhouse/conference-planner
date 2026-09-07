import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { saveReceiptViaApi } from '../plannerStorage.js';

// Record fetch calls and drive their responses per-test.
let calls;
function mockFetch(responder) {
  return vi.fn(async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body });
    return responder(url, opts);
  });
}
const ok = (status = 200) => ({ ok: status < 400, status });

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('saveReceiptViaApi', () => {
  const RC = { id: 'rc_1', name: 'Taxi', amount: '40', currency: 'AUD' };

  it('upsert PUTs the element to the receipts collection when it exists', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(() => ok(200)),
    );
    const r = await saveReceiptViaApi('', 'trip', 'upsert', RC);
    expect(r).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].url).toBe('/api/v1/planners/trip.json/receipts/rc_1');
    expect(JSON.parse(calls[0].body)).toMatchObject({ id: 'rc_1', amount: '40' });
  });

  it('upsert falls back to POST (create) when the PUT 404s — no duplicate', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch((_url, opts) => (opts.method === 'PUT' ? ok(404) : ok(201))),
    );
    const r = await saveReceiptViaApi('https://api.example.com/', 'trip', 'upsert', RC);
    expect(r).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(['PUT', 'POST']);
    expect(calls[0].url).toBe('https://api.example.com/api/v1/planners/trip.json/receipts/rc_1');
    expect(calls[1].url).toBe('https://api.example.com/api/v1/planners/trip.json/receipts');
  });

  it('delete DELETEs the element and tolerates a 404 (already gone)', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(() => ok(404)),
    );
    const r = await saveReceiptViaApi('', 'trip', 'delete', { id: 'rc_1' });
    expect(r).toBe(true);
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].url).toBe('/api/v1/planners/trip.json/receipts/rc_1');
  });

  it('throws on a genuine server error (caller treats as best-effort)', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(() => ok(500)),
    );
    await expect(saveReceiptViaApi('', 'trip', 'delete', { id: 'rc_1' })).rejects.toThrow(
      'HTTP 500',
    );
  });

  it('flattens a planner-key path into one filename segment', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(() => ok(200)),
    );
    await saveReceiptViaApi('', 'events/drupalcon/eu/2026.json', 'upsert', RC);
    expect(calls[0].url).toBe('/api/v1/planners/events-drupalcon-eu-2026.json/receipts/rc_1');
  });
});
