import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The ledger moved out of the public data tree. These pin the two halves of that
// move that are easy to get wrong: an existing install must keep reading its
// decisions, and a new write must never land back in the public tree.

let dataRoot;
let privateRoot;
let saved;

async function freshStore() {
  vi.resetModules();
  const { diskDecisionStore } = await import('../archiveAudit.js');
  return diskDecisionStore();
}

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), 'ledger-'));
  dataRoot = join(base, 'data');
  privateRoot = join(base, 'private');
  await mkdir(dataRoot, { recursive: true });
  saved = { DATA_ROOT: process.env.DATA_ROOT, PRIVATE_ROOT: process.env.PRIVATE_ROOT };
  process.env.DATA_ROOT = dataRoot;
  process.env.PRIVATE_ROOT = privateRoot;
});

afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  await rm(join(dataRoot, '..'), { recursive: true, force: true });
});

describe('curation ledger location', () => {
  it('reads a ledger left at the legacy public path', async () => {
    const legacyDir = join(dataRoot, 'curation');
    await mkdir(legacyDir, { recursive: true });
    await writeFile(join(legacyDir, 'decisions.json'), '{"aliases":{"a":"A"}}', 'utf8');

    const store = await freshStore();
    expect(JSON.parse(await store.read()).aliases).toEqual({ a: 'A' });
  });

  it('writes to the private root, leaving the legacy copy untouched', async () => {
    const legacyFile = join(dataRoot, 'curation', 'decisions.json');
    await mkdir(join(dataRoot, 'curation'), { recursive: true });
    await writeFile(legacyFile, '{"aliases":{"a":"A"}}', 'utf8');

    const store = await freshStore();
    await store.write('{"aliases":{"a":"A","b":"B"}}');

    const moved = join(privateRoot, 'curation', 'decisions.json');
    expect(existsSync(moved)).toBe(true);
    expect(JSON.parse(await readFile(moved, 'utf8')).aliases).toEqual({ a: 'A', b: 'B' });
    // Untouched, not deleted: if the new location is lost the decisions are still
    // recoverable, and a downgrade still finds them.
    expect(JSON.parse(await readFile(legacyFile, 'utf8')).aliases).toEqual({ a: 'A' });
  });

  it('prefers the private ledger once one exists', async () => {
    await mkdir(join(dataRoot, 'curation'), { recursive: true });
    await writeFile(join(dataRoot, 'curation', 'decisions.json'), '{"aliases":{"old":"Old"}}');
    await mkdir(join(privateRoot, 'curation'), { recursive: true });
    await writeFile(join(privateRoot, 'curation', 'decisions.json'), '{"aliases":{"new":"New"}}');

    const store = await freshStore();
    expect(JSON.parse(await store.read()).aliases).toEqual({ new: 'New' });
  });

  it('returns null when neither exists, rather than throwing', async () => {
    const store = await freshStore();
    expect(await store.read()).toBeNull();
  });

  it('keeps the S3 key under data/ even though the disk path moved', async () => {
    // The bucket layout is a contract with existing installations. If this ever
    // changes, every deployed install silently loses its ledger.
    vi.resetModules();
    const src = await readFile(new URL('../s3-sync.js', import.meta.url), 'utf8');
    expect(src).toContain("const CURATION_S3_PREFIX = 'data/curation/'");
  });
});
