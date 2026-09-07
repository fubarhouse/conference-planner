// `_view` caches the filtered view, and every reader takes it as
// `_view || computeView()` — which short-circuits. So a facet change that does
// not clear it is not a stale-cache nuisance: it is a panel that keeps showing
// a scope you are no longer looking at, indefinitely.
//
// That bug shipped three times over in the same file — the series select, the
// region/country/year selects, and the "clear filter" chip — because each site
// was written separately and the invalidation is one easily-forgotten line. The
// clear-filter one was the worst of them: clearing a filter is what somebody
// does to escape an empty panel, and it left the panel exactly as empty.
//
// This reads the source rather than the behaviour, because the handlers are
// bound to live DOM inside openObservatory() and there is no jsdom here. What it
// checks is the invariant those three bugs all violated: a function that changes
// the scope must also drop the cache.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'archiveDashboard.js'),
  'utf8',
);

/** Assignments that SET a scope, as opposed to declaring or restoring one. */
const FACET_WRITE =
  /^\s*(?:(?:else\s+)?if\s*\([^)]*\)\s*)?_(series|region|country|year)\s*=\s*(.+);/;

describe('the cached view is dropped whenever the scope changes', () => {
  const lines = SRC.split('\n');
  const writes = [];
  lines.forEach((line, i) => {
    const m = line.match(FACET_WRITE);
    if (!m) return;
    // The declarations at the top of the module, and loadPrefs() restoring a
    // saved scope before the first render — at which point there is no cache to
    // invalidate.
    if (/^let _/.test(line.trim())) return;
    if (/p\.series/.test(line)) return;
    writes.push({ line: i + 1, text: line.trim() });
  });

  it('finds the facet writes it is meant to be guarding', () => {
    // If this drops to zero the regex has rotted and the suite below is vacuous
    // — the exact failure mode the oracle guard had.
    expect(writes.length).toBeGreaterThanOrEqual(8);
  });

  it.each(writes.map((w) => [w.line, w.text]))(
    'line %i (%s) is followed by _view = null',
    (line) => {
      // Generous window: these handlers do several things (reset paging, drop
      // the map, re-render) before they finish.
      const window = lines.slice(line - 1, line + 24).join('\n');
      expect(window).toMatch(/_view = null/);
    },
  );
});
