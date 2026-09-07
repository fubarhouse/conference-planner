// Countries, Series and Count are three new subjects on the one chart. Their
// data path is testable on its own (archiveStacks.test.js), but the wiring that
// makes them subjects — a MODES entry, a VIEWS entry, and a stacked view that
// leaves the line renderer alone — lives inside a 269 KB module full of
// module-private state, so this pins it at the source. Weaker than rendering
// the chart; here because the alternative is no check at all.
//
// The bug this guards against is the one the first pass actually had: the
// stacked chart was a separate section of the page rather than a view of the
// chart, and every OTHER panel on the dashboard had no maximise button.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, '..', 'archiveDashboard.js'), 'utf8');
const MAX = readFileSync(join(here, '..', 'chartMaximise.js'), 'utf8');

describe('the Countries / Series / Count subjects', () => {
  it('are primary subjects, not sections bolted beside the chart', () => {
    for (const m of [
      "['countries', 'Countries']",
      "['series', 'Series']",
      "['regions', 'Regions']",
      // Renamed: "Count" next to "Countries" in a tab bar is genuinely misread.
      "['count', 'Scale']",
    ])
      expect(SRC).toContain(m);
    // The standalone panels the first pass added are gone.
    expect(SRC).not.toMatch(/function stackSection\(/);
    expect(SRC).not.toMatch(/stackSection\('country'/);
  });

  it('groups eight subjects into the two families that actually differ', () => {
    // The first group counts EVENTS and works on a record with no programme at
    // all; the second reads what was inside them and goes blank on dated stubs.
    expect(SRC).toMatch(/const MODE_GROUPS = \[/);
    expect(SRC).toMatch(/\['The archive', \['count', 'regions', 'countries', 'series'\]\]/);
    expect(SRC).toMatch(/\['What was in it', \['topics', 'programme'/);
  });

  it('drops the standalone year panel the Scale tab now replaces', () => {
    // It drew bar=sessions/number=events; Scale → Total draws both as lines,
    // and the chart already renders the same annotation marks.
    expect(SRC).not.toMatch(/function yearsChart\(/);
    expect(SRC).not.toMatch(/The archive over time/);
    expect(SRC).toMatch(/\{ term: 'Events', byYear: ev \}/);
    expect(SRC).toMatch(/\{ term: 'Sessions', byYear: ses \}/);
  });

  it('divides for Share % exactly once', () => {
    // THE BUG: `share` is set from the VIEW NAME alone — `v === 'share'` — so it
    // was already true for the Countries share view. Pre-normalising the series
    // as well meant val() divided a SECOND time, by the topic denominator, and
    // plotted Spain at 111% of 2007 (100 / 90 * 100). A share above 100% is
    // impossible by construction, so it can only ever be a second divisor.
    //
    // The fix is one divisor in one place: the series carry raw counts and
    // `denom` carries the year totals, like every other share on this chart.
    expect(SRC).toMatch(/const denom = topicShare[\s\S]{0,120}?geoShare\s*\?\s*geoTotals/);
    // No percentage is computed while building the geo series.
    const selBlock = SRC.slice(
      SRC.indexOf('const sel = geo'),
      SRC.indexOf('const sel = geo') + 600,
    );
    expect(selBlock).not.toMatch(/\* 100/);
    expect(selBlock).not.toMatch(/totals\[y\]/);
  });

  it('normalises Share % against the whole year, not the selected lines', () => {
    // Dividing by the selection would make any two countries look like 100% of
    // Drupal between them, so geoTotals sums EVERY key, not the visible ones.
    expect(SRC).toMatch(/THE DENOMINATOR IS THE WHOLE YEAR/);
    expect(SRC).toMatch(/if \(geoShare\)\s*\n?\s*for \(const g of geoSeries\(/);
  });

  it('offer the sub-views each subject was given', () => {
    // A comment can sit between the entries, so this checks the three appear in
    // order within the subject rather than being strictly adjacent.
    for (const k of ['countries', 'series', 'regions'])
      expect(SRC).toMatch(
        new RegExp(
          `${k}: \\[[\\s\\S]{0,300}?'Lines'[\\s\\S]{0,300}?'Stacked'[\\s\\S]{0,300}?'share'`,
        ),
      );
    expect(SRC).toMatch(/count: \[\s*\['total', 'Total'\],\s*\['active', 'Active'\],/);
  });

  it('sends the line views through the one drawing loop, like every other subject', () => {
    // `geo` selects series for `sel`; it must NOT get a bar-drawing branch of
    // its own inside topicChartSvg — that is the shape of the bug the
    // first-timer views already have a test for.
    expect(SRC).toMatch(/const geo =\s*_chartMode === 'countries' \|\|[\s\S]{0,80}?'regions';/);
    expect(SRC).not.toMatch(/obs-tc-bar/);
  });

  it('short-circuits the stacked view instead of teaching the line renderer bars', () => {
    expect(SRC).toMatch(/const stackedView =/);
    expect(SRC).toMatch(/if \(stackedView\) \{/);
    // The line renderer's crosshair has nothing to hit-test in a stacked view.
    expect(SRC).toMatch(/if \(!stackedView\) \{\s*armRise\(chart\);\s*watchChartWidth\(chart\);/);
  });

  it('colours its lines positionally, not from the keyword map', () => {
    // THE BUG: Countries/Series fell through to topicStyle(), which looks a term
    // up in the KEYWORD colour map. There is no entry for "Poland", so every
    // line resolved to slotStyle(-1) — the single overflow colour — and all
    // eight were drawn identically while the legend swatched them positionally
    // with eight different colours.
    expect(SRC).toMatch(/const positional =[^;]*\bgeo\b[^;]*;/);
    // ⚠ THIS LINE USED TO ASSERT `… || countTotal` ON THE SINGLE-COLOUR BRANCH,
    // on the stated belief that Scale → Total was "the single-line Count view".
    // It is not: it plots Events AND Sessions, so it was drawing both in one
    // gold while staticLegend swatched them two colours — the same legend/chart
    // disagreement this suite exists to catch, one panel over. The single-colour
    // branch now holds only genuinely single-series views.
    expect(SRC).toMatch(/sessions \|\| hours \|\| sponsorCount\s*$/m);
  });

  it('swatches the legend from the same palette the lines use', () => {
    // geoLegend and the drawing loop must index the SAME palette function, or
    // the legend describes colours the chart never drew.
    expect(SRC).toMatch(/data-geo="\$\{esc\(g\.key\)\}"[^`]*swatch\(slotStyle\(i\)/);
  });

  it('opens on a readable number of lines rather than all 39', () => {
    expect(SRC).toMatch(/const GEO_DEFAULT_N = \d+;/);
    const n = Number(SRC.match(/const GEO_DEFAULT_N = (\d+);/)[1]);
    expect(n).toBeGreaterThan(2);
    expect(n).toBeLessThanOrEqual(12);
  });

  it('never leaves the chart with no line on it', () => {
    // Same guarantee the Community legend makes: the last series stays put.
    expect(SRC).toMatch(/if \(sel\.has\(key\) && sel\.size > 1\) sel\.delete\(key\);/);
  });

  it('re-seeds the selection when the scope changes it out from under the reader', () => {
    // Picking a region can remove every country the reader had selected; without
    // this the chart goes blank and looks broken.
    expect(SRC).toMatch(/!\[\.\.\._geoSel\[mode\]\]\.some\(\(k\) => live\.has\(k\)\)/);
  });
});

describe('maximise', () => {
  it('is wired by observing the container, not per render path', () => {
    // The first pass called wireMaximise() from renderDashboard only, so the
    // home tabs and every drill-down had no button at all.
    expect(MAX).toMatch(/export function observeMaximise/);
    expect(MAX).toMatch(/new MutationObserver\(\(\) => wireMaximise\(root\)\)/);
    expect(SRC).toMatch(/observeMaximise\(\$\('obsBody'\)\)/);
  });

  it('fills the screen with a class, so a refused fullscreen still works', () => {
    // requestFullscreen rejects in an iframe without allow="fullscreen" and does
    // not exist on older iOS Safari. The class must not depend on it resolving.
    const openFn = MAX.slice(MAX.indexOf('function open(panel)'));
    expect(openFn.indexOf("classList.add('obs-panel--max')")).toBeLessThan(
      openFn.indexOf('requestFullscreen'),
    );
    expect(MAX).toMatch(/\.catch\(\(\) => \{\}\)/);
  });

  it('restores when the browser exits fullscreen by its own affordance', () => {
    expect(MAX).toMatch(/addEventListener\('fullscreenchange'/);
  });

  it('does not stack duplicate buttons on re-render', () => {
    expect(MAX).toMatch(/querySelector\(':scope > \.obs-max-btn'\)\) continue;/);
  });
});

describe('the rise animation must never hide the data', () => {
  const SRC_ = SRC;

  it('observes the container, not the SVG groups', () => {
    // THE BUG: `.obs-rise` is a <g> inside the chart SVG, and intersection
    // observation of SVG CHILD elements is unreliable outside Chromium. When the
    // callback never fired, `is-armed` held the group at scaleY(0) with the
    // animation paused — axes drawn, not one line visible. That is what the
    // dashboard did on mobile, in more than one browser.
    expect(SRC_).toMatch(/OBSERVE THE CONTAINER, NOT THE SVG GROUPS/);
    expect(SRC_).toMatch(/_riseObserver\.observe\(host\)/);
    // The old form observed each mark.
    expect(SRC_).not.toMatch(/marks\.forEach\(\(el\) => \{[\s\S]{0,120}?\.observe\(el\)/);
  });

  it('draws the chart anyway if the observer never fires', () => {
    // An entrance animation must not be the reason data cannot be read.
    expect(SRC_).toMatch(/FAILSAFE/);
    expect(SRC_).toMatch(/setTimeout\(startAll, \d+\)/);
  });

  it('still draws when IntersectionObserver is missing entirely', () => {
    expect(SRC_).toMatch(/if \(typeof IntersectionObserver === 'undefined'\) \{\s*startAll\(\);/);
  });
});

describe('mobile', () => {
  const CSS = readFileSync(join(here, '..', '..', '..', 'css', 'section-archive.css'), 'utf8');

  it('lets the subject controls wrap instead of clipping them', () => {
    // `.obs-topic-views` is inline-flex with overflow:hidden — correct on a wide
    // screen, but on a phone it clipped most of the eight subjects out of reach
    // rather than wrapping them.
    expect(CSS).toMatch(/@media \(max-width: 700px\)[\s\S]{0,900}?overflow: visible;/);
    expect(CSS).toMatch(/@media \(max-width: 700px\)[\s\S]{0,900}?flex-wrap: wrap;/);
  });

  it('scrolls the stacked chart rather than shrinking its labels', () => {
    // The stacked chart has ONE fixed 1000x340 viewBox; at 360px its 11px
    // labels are mush, so it gets a min-width and the panel scrolls.
    expect(CSS).toMatch(/\.obs-stk \{\s*min-width: 560px;/);
    expect(CSS).toMatch(/overflow-x: auto;[\s\S]{0,120}?-webkit-overflow-scrolling: touch;/);
  });

  it('leaves the line chart to size itself, because chartGeom already does', () => {
    // chartGeom() returns a smaller viewBox below 560px, tuned so type renders
    // 1:1. A min-width would stretch that drawing and undo the tuning.
    expect(CSS).toMatch(/THE TWO CHART IDIOMS NEED OPPOSITE TREATMENT/);
    expect(CSS).not.toMatch(/\.obs-topic-chart > svg,?\s*\n?\s*\.obs-stk \{\s*min-width/);
  });

  it('shows the maximise button on touch, where there is no hover', () => {
    expect(CSS).toMatch(
      /@media \(max-width: 700px\)[\s\S]{0,1400}?\.obs-max-btn \{[\s\S]{0,80}?opacity: 1;/,
    );
  });
});
