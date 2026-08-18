import { describe, it, expect, afterEach, vi } from 'vitest';
import { join, resolve, sep } from 'node:path';
import {
  guardPath,
  ROOT,
  APP,
  DATA_ROOT,
  PRIVATE_ROOT,
  PLANNER_ROOT,
  CURATION_ROOT,
  LEGACY_CURATION_ROOT,
} from '../roots.js';

// The roots are read from the environment at module load, so exercising an
// override means resetting the registry and importing again.
async function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  try {
    return await fn(await import('../roots.js'));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.resetModules();
  }
}

afterEach(() => {
  vi.resetModules();
});

describe('defaults', () => {
  it('keeps public content where it has always been', () => {
    expect(DATA_ROOT).toBe(join(APP, 'data'));
    expect(APP).toBe(join(ROOT, 'app'));
  });

  it('keeps private state OUT of the statically-served tree', () => {
    // The whole point of PRIVATE_ROOT. express.static(APP) cannot serve what is
    // not under APP, whatever shape a URL arrives in.
    expect(PRIVATE_ROOT).toBe(join(ROOT, 'private'));
    expect(PLANNER_ROOT).toBe(join(ROOT, 'private', 'planners'));
    for (const r of [PRIVATE_ROOT, PLANNER_ROOT, CURATION_ROOT]) {
      expect(r.startsWith(APP + sep)).toBe(false);
    }
  });

  it('points the curation ledger at the private root, not the archive', () => {
    expect(CURATION_ROOT).toBe(join(PRIVATE_ROOT, 'curation'));
    expect(LEGACY_CURATION_ROOT).toBe(join(DATA_ROOT, 'curation'));
    expect(CURATION_ROOT).not.toBe(LEGACY_CURATION_ROOT);
  });

  it('is absolute, so guardPath comparisons are sound', () => {
    for (const r of [ROOT, APP, DATA_ROOT, PRIVATE_ROOT, PLANNER_ROOT]) {
      expect(resolve(r)).toBe(r);
    }
  });
});

describe('overrides', () => {
  it('accepts an absolute root outside the repo', async () => {
    await withEnv({ DATA_ROOT: '/srv/archive' }, (m) => {
      expect(m.DATA_ROOT).toBe(resolve('/srv/archive'));
    });
  });

  it('resolves a relative root against the repo, not the process CWD', async () => {
    await withEnv({ DATA_ROOT: '../archive' }, (m) => {
      expect(m.DATA_ROOT).toBe(resolve(ROOT, '..', 'archive'));
    });
  });

  it('normalises a trailing slash — otherwise guardPath rejects every child', async () => {
    await withEnv({ DATA_ROOT: '/srv/archive/' }, (m) => {
      expect(m.DATA_ROOT).toBe(join('/srv', 'archive'));
      expect(guardPath(m.DATA_ROOT, 'events/a.json')).toBe(join('/srv/archive/events/a.json'));
    });
  });

  it('treats a blank value as unset rather than as the repo root', async () => {
    await withEnv({ DATA_ROOT: '   ' }, (m) => {
      expect(m.DATA_ROOT).toBe(join(APP, 'data'));
    });
  });

  it('moves every private sub-root together', async () => {
    await withEnv({ PRIVATE_ROOT: '/var/state' }, (m) => {
      expect(m.PLANNER_ROOT).toBe(join('/var/state', 'planners'));
      expect(m.RECEIPT_ROOT).toBe(join('/var/state', 'receipts'));
      expect(m.DOCUMENT_ROOT).toBe(join('/var/state', 'documents'));
      expect(m.CURATION_ROOT).toBe(join('/var/state', 'curation'));
    });
  });

  it('tracks the legacy curation path against DATA_ROOT, not the private root', async () => {
    // The fallback has to follow the data, since that is where it used to live.
    await withEnv({ DATA_ROOT: '/srv/archive', PRIVATE_ROOT: '/var/state' }, (m) => {
      expect(m.LEGACY_CURATION_ROOT).toBe(join('/srv/archive', 'curation'));
    });
  });

  it('keeps the three roots independent', async () => {
    await withEnv({ DATA_ROOT: '/a/data', IMG_ROOT: '/b/img', PRIVATE_ROOT: '/c' }, (m) => {
      expect(m.DATA_ROOT).toBe(join('/a', 'data'));
      expect(m.IMG_ROOT).toBe(join('/b', 'img'));
      expect(m.PRIVATE_ROOT).toBe(join('/c'));
    });
  });
});

describe('guardPath', () => {
  const base = join('/srv', 'archive');

  it('resolves a path inside the base', () => {
    expect(guardPath(base, 'events/drupalcon/eu/2025-vienna.json')).toBe(
      join(base, 'events/drupalcon/eu/2025-vienna.json'),
    );
  });

  it('allows the base itself', () => {
    expect(guardPath(base, '')).toBe(base);
  });

  it('rejects traversal out of the base', () => {
    expect(guardPath(base, '../secrets.json')).toBeNull();
    expect(guardPath(base, 'events/../../secrets.json')).toBeNull();
  });

  it('rejects a sibling whose name merely starts with the base', () => {
    // `/srv/archive-private` startsWith `/srv/archive` — the separator check is
    // what stops it, so it is worth pinning.
    expect(guardPath(base, `..${sep}archive-private${sep}x.json`)).toBeNull();
  });

  it('resolves an unnormalised base rather than rejecting all its children', () => {
    // The bug this guards: a base with a trailing slash or a `..` never matched
    // its own children, so every guarded write returned null — a fail-closed
    // break that presents as "saving stopped working".
    expect(guardPath('/srv/archive/', 'a.json')).toBe(join(base, 'a.json'));
    expect(guardPath('/srv/tmp/../archive', 'a.json')).toBe(join(base, 'a.json'));
  });
});
