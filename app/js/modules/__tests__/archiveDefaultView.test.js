// Entering a chart mode must land on a view that mode actually offers.
//
// THE BUG: `DEFAULT_VIEW[mode] || 'count'` was the fallback in two places — the
// mode-switch handler and the preference restore. DEFAULT_VIEW was written when
// there were five modes and never gained entries for the four added later
// (Scale, Countries, Series, Regions), so entering any of them fell back to the
// literal 'count'. Scale does not offer a 'count' view.
//
// `_chartView` then matched nothing: `countTotal` and `countActive` were both
// false, `sel` fell through to the keyword branch, and Scale drew TOPIC LINES
// beneath a legend reading "Events | Sessions". The chart rendered, which is
// exactly why it went unnoticed.
//
// This suite tests the resolver against the real tables rather than the symptom,
// so a tenth mode added without a DEFAULT_VIEW entry cannot reintroduce it.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MODES, VIEWS, defaultViewFor } from '../archiveDashboard.js';

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'archiveDashboard.js'),
  'utf8',
);

describe('defaultViewFor', () => {
  it('returns a view the mode really defines, for every mode', () => {
    for (const [mode] of MODES) {
      const views = (VIEWS[mode] || []).map(([k]) => k);
      if (!views.length) continue; // a mode with no sub-views has nothing to pick
      expect(views, `mode "${mode}"`).toContain(defaultViewFor(mode));
    }
  });

  it('never hands Scale the view that broke it', () => {
    // The specific regression, named.
    expect(defaultViewFor('count')).not.toBe('count');
    expect(defaultViewFor('count')).toBe('total');
  });

  it('opens the four later modes on their first view', () => {
    expect(defaultViewFor('countries')).toBe('lines');
    expect(defaultViewFor('series')).toBe('lines');
    expect(defaultViewFor('regions')).toBe('lines');
  });

  it('still honours an explicit preference that is not the first view', () => {
    // The table is not vestigial: these modes deliberately open on something
    // other than their first tab, and that must survive the new fallback.
    expect(defaultViewFor('topics')).toBe('share');
    expect(defaultViewFor('community')).toBe('peak');
  });

  it('falls back safely for a mode it has never heard of', () => {
    expect(typeof defaultViewFor('nonesuch')).toBe('string');
  });
});

describe('the two places a view is chosen', () => {
  it('both go through the resolver, so neither can drift', () => {
    // The mode-switch handler and the preference restore had the same flawed
    // expression copied into each. Comments are stripped first: the resolver's
    // own doc comment quotes the old expression to explain what it replaced, and
    // that quotation is documentation, not a call site.
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/DEFAULT_VIEW\[[^\]]+\] \|\| 'count'/);
    expect(code.match(/defaultViewFor\(/g).length).toBeGreaterThanOrEqual(3);
  });
});
