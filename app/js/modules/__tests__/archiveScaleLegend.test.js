// The Scale panel's two views each plot TWO series — Total draws Events and
// Sessions, Active draws Countries and Series — and both are legended by
// staticLegend(), which swatches slot 0, slot 1, … positionally.
//
// Total was grouped with the single-line views (Sessions, Hours, Sponsor count)
// and handed `var(--viz-1)`, so the chart drew both its lines in the same gold
// while the legend showed two different colours and named them Events and
// Sessions. The reader had no way to tell which line was which.
//
// This is the third time this exact fault has appeared on this chart (Countries
// and Series were the second), so the invariant is worth pinning rather than the
// individual symptom: THE SINGLE-COLOUR BRANCH IS FOR SINGLE-SERIES VIEWS ONLY.
// The test for membership is how many entries the view puts in `sel`.
//
// topicChartSvg() is module-private and reads a dozen pieces of module state, so
// this pins the invariant at the source, as its sibling suites do.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'archiveDashboard.js'),
  'utf8',
);

/** The `a || b || c` operand list of a `const <name> = …;` declaration. */
function operands(name) {
  const m = SRC.match(new RegExp(`const ${name} =([\\s\\S]*?);`));
  if (!m) throw new Error(`no \`const ${name}\` declaration found`);
  return m[1].split('||').map((s) => s.trim());
}

describe('Scale → Total', () => {
  it('takes positional colours, so the chart agrees with its legend', () => {
    expect(operands('positional')).toContain('countTotal');
  });

  it('is not in the single-colour branch, which is for one-line views', () => {
    // The branch immediately preceding `? { color: 'var(--viz-1)' …`.
    const m = SRC.match(/const style =\s*([\s\S]*?)\s*\?\s*\{ color: 'var\(--viz-1\)'/);
    expect(m).not.toBeNull();
    const single = m[1].split('||').map((s) => s.trim());
    expect(single).not.toContain('countTotal');
    // The views that legitimately remain draw exactly one line each.
    expect(single.sort()).toEqual(['hours', 'sessions', 'sponsorCount']);
  });
});

describe('every multi-series Scale view', () => {
  it('is positional, both of them', () => {
    // Active was already correct; Total is the one that regressed. Pinning both
    // stops a future edit from "tidying" them back into different branches.
    const pos = operands('positional');
    expect(pos).toContain('countActive');
    expect(pos).toContain('countTotal');
  });

  it('still legends by position, which is what makes that the right choice', () => {
    // If staticLegend ever stopped swatching positionally, `positional` would be
    // the wrong answer and this suite would be enforcing the wrong invariant.
    expect(SRC).toMatch(/function staticLegend\(labels\)[\s\S]*?swatch\(slotStyle\(i\)\)/);
    expect(SRC).toMatch(
      /staticLegend\(\s*_chartView === 'active'\s*\?\s*\['Countries', 'Series'\]\s*:\s*\['Events', 'Sessions'\]\s*\)/,
    );
  });
});
