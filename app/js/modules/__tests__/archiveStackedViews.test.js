// Two views plot a first-timer series against a returning one: Speakers → Who
// and Who %, and Sponsors → Loyalty. They share `sel`, `castTotals` and the
// whole data path; only the subject filling the cast differs.
//
// They were stacked bars, and drew nothing for Loyalty at all: the bar branch
// was gated on `people` (speakers) rather than `stacked` (speakers OR
// sponsors), and the line loop deliberately skipped stacked views — so Loyalty
// fell between the two and rendered a chart frame with no bars, no legend and
// no hover, while `sel` held twenty years of data.
//
// They are lines now, because a 22px bar sits on top of the reader's own
// annotation marks on the same axis. That removes the special case entirely:
// there is one drawing loop, and these views go through it like the rest.
//
// topicChartSvg() is module-private and reads a dozen pieces of module state, so
// this pins the invariant at the source. It is weaker than rendering the chart,
// and it is here because the alternative was no check at all.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'archiveDashboard.js'),
  'utf8',
);

describe('the first-timer / returning views', () => {
  it('defines `stacked` as both subjects, not just speakers', () => {
    expect(SRC).toMatch(/const stacked = people \|\| sponsorLoyalty;/);
  });

  it('has no bar-drawing special case left to fall between', () => {
    // The shape of the original bug: a branch only one of the two subjects
    // could enter. There is now no branch at all.
    expect(SRC).not.toMatch(/if \(people && !slots\) \{/);
    expect(SRC).not.toMatch(/if \(stacked && !slots\) \{/);
    expect(SRC).not.toMatch(/obs-tc-bar/);
  });

  it('sends every series through the one drawing loop', () => {
    // Previously `(stacked ? [] : sel)`, which is what starved Loyalty.
    expect(SRC).toMatch(/for \(const \[si, t\] of sel\.entries\(\)\) \{/);
    expect(SRC).not.toMatch(/\(stacked \? \[\] : sel\)/);
  });

  it('gives the two series distinct palette slots rather than keyword colours', () => {
    // Positional styling: these are a fixed pair, not keywords competing for the
    // topic colour map. slotStyle also varies the dash, so the pair stay apart
    // when printed or read without colour.
    // `register` joined this group later (the Community → Energy/Headwinds
    // views); what matters here is that `stacked` is still in it.
    // The group is a named `positional` boolean now that Countries/Series joined
    // it (they were falling through to the keyword colour map and drawing every
    // line in the overflow colour). What matters here is unchanged: `stacked` is
    // still in the group, and the group still takes slotStyle(si).
    expect(SRC).toMatch(/const positional =[^;]*\bstacked\b[^;]*;/);
    expect(SRC).toMatch(/\? slotStyle\(si\)/);
  });

  it('labels the returning series for whichever subject is stacked', () => {
    // A sponsor did not "speak" before.
    expect(SRC).toMatch(/sponsorLoyalty \? 'Sponsored before' : 'Spoken before'/);
  });
});
