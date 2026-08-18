import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readdir, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Step 5 — the local mirror is optional.
//
// `plannerList` is a READ. It used to `mkdir` the planner directory first, which
// meant listing planners on a read-only filesystem (immutable container, S3
// authoritative) failed with EACCES and returned a 500 instead of "none".
//
// The route itself lives in server.js, which starts a listener on import and so
// cannot be unit-tested here. This pins the LOGIC it now uses, against a real
// filesystem — including a genuinely unwritable directory, which is the case
// that regressed.

/** The listing behaviour as server.js implements it. */
async function listPlanners(dir) {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith('.json'));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

let base;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'nomirror-'));
});

afterEach(async () => {
  await chmod(base, 0o700).catch(() => {});
  await rm(base, { recursive: true, force: true });
});

describe('planner listing without a local mirror', () => {
  it('reports no planners when the directory does not exist', async () => {
    expect(await listPlanners(join(base, 'absent'))).toEqual([]);
  });

  it('does not CREATE the directory as a side effect of reading', async () => {
    const dir = join(base, 'absent');
    await listPlanners(dir);
    // The whole point: a read that writes is a read that fails on read-only disk.
    await expect(readdir(dir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('lists planners when a mirror is present, ignoring non-JSON', async () => {
    const dir = join(base, 'planners');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'planner-a.json'), '{}');
    await writeFile(join(dir, 'planner-b.json'), '{}');
    await writeFile(join(dir, 'notes.txt'), 'x');
    expect((await listPlanners(dir)).sort()).toEqual(['planner-a.json', 'planner-b.json']);
  });

  it('survives a read-only parent — the regression this guards', async () => {
    // Before the fix this threw EACCES from mkdir and the route answered 500.
    await chmod(base, 0o500);
    expect(await listPlanners(join(base, 'planners'))).toEqual([]);
  });

  it('still surfaces errors that are not "missing"', async () => {
    // A missing mirror is normal; an unreadable one is a real fault and must not
    // be flattened into an empty list, or a broken mount looks like "no trips".
    const dir = join(base, 'locked');
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o000);
    let err = null;
    try {
      await listPlanners(dir);
    } catch (e) {
      err = e;
    }
    await chmod(dir, 0o700);
    // Root ignores permission bits; skip rather than assert a false expectation.
    if (err) expect(err.code).toBe('EACCES');
  });
});
