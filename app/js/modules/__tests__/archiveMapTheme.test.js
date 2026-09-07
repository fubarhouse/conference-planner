// The archive's two maps — the world strip under the stats, and the drill-down
// map on a speaker/sponsor/year/series page — both hardcoded CARTO's `dark_all`
// basemap. In light mode that put a black rectangle in the middle of a white
// page. Every other map in the app (planner, itinerary, schedule venue, picker)
// already read the body class; these two predate that and were never revisited.
//
// They are also the two most screenshot-worthy things on the dashboard and had
// no maximise control, because chartMaximise only ever looked for `.obs-panel`
// and neither map lives in one.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, '..', p), 'utf8');
const DASH = read('archiveDashboard.js');
const MAX = read('chartMaximise.js');
const CSS = readFileSync(join(here, '..', '..', '..', 'css', 'section-archive.css'), 'utf8');

describe('the archive basemaps', () => {
  it('pin no tile slug into a URL', () => {
    // The whole bug in one assertion: a literal slug in a tile URL cannot follow
    // the theme, whichever slug it happens to be.
    expect(DASH).not.toMatch(/basemaps\.cartocdn\.com\/(dark|light)_all/);
  });

  it('choose the slug from the body class, as every other map does', () => {
    expect(DASH).toMatch(
      /function mapTileSlug\(\)[\s\S]*?theme-dark'\)\s*\?\s*'dark_all'\s*:\s*'light_all'/,
    );
  });

  it('are built through the one helper, so neither can drift again', () => {
    // Two call sites, one source of truth.
    expect(DASH.match(/addBasemap\(L, _(map|stripMap)\)/g)).toHaveLength(2);
    expect(DASH).toMatch(/function addBasemap\(L, map, opts\)/);
  });

  it('re-point live layers when the theme changes mid-session', () => {
    // A mode switch does not re-render the dashboard, so creating the layer with
    // the right slug is necessary but not sufficient — the map outlives it.
    expect(DASH).toMatch(/function updateMapTheme\(\)[\s\S]*?layer\?\.setUrl\?\.\(url\)/);
    expect(DASH).toMatch(
      /new MutationObserver\(updateMapTheme\)[\s\S]*?attributeFilter: \['class'\]/,
    );
  });

  it('do not accumulate dead layers across re-renders', () => {
    expect(DASH).toMatch(/_mapTileLayers\.filter\(\(l\) => l\?\._map\)\.concat\(layer\)/);
  });
});

describe('maximising a map', () => {
  it('is offered on both maps, via the opt-in class', () => {
    expect(MAX).toMatch(/const SEL = '\.obs-panel, \.obs-maxable';/);
    // The strip map and the drill map each carry it.
    expect(DASH).toMatch(/class="obs-stripmap-map obs-maxable"/);
    expect(DASH).toMatch(/class="obs-map-box obs-maxable"/);
  });

  it('wires and hit-tests through that same selector', () => {
    // Both halves must agree, or a button appears that no click can resolve.
    expect(MAX).toMatch(/root\.querySelectorAll\(SEL\)/);
    expect(MAX).toMatch(/btn\.closest\(SEL\)/);
  });

  it('tells the panel it changed instead of reaching for Leaflet itself', () => {
    // chartMaximise stays generic; the dashboard owns the map-specific repair.
    // The check is about CODE, not commentary — the module's own doc comment
    // explains *why* it refuses to touch Leaflet, and naming the thing you are
    // declining to depend on is the point of that comment.
    const code = MAX.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(MAX).toMatch(/new CustomEvent\('obs:maximise'/);
    expect(code).not.toMatch(/invalidateSize|window\.L\b|\bL\.tileLayer\b/);
  });

  it('re-measures AND re-frames the map that was maximised', () => {
    // invalidateSize alone leaves a strip map at the zoom it computed for a
    // 15rem band, which at full height is not the picture anyone wanted.
    expect(DASH).toMatch(/obs:maximise/);
    expect(DASH).toMatch(/m\.invalidateSize\(\);\s*[\s\S]{0,240}?m\._obsRefit\?\.\(\)/);
    expect(DASH).toMatch(/map\._obsRefit = fit;/);
    expect(DASH).toMatch(/map\._obsRefit = applyView;/);
  });

  it('only resizes the map that is actually inside the maximised element', () => {
    expect(DASH).toMatch(/el\.contains\?\.\(m\.getContainer\?\.\(\)\)/);
  });

  it('lifts the button above Leaflet panes and drops the in-page height cap', () => {
    // Leaflet's panes sit at z-index 400–700; a z-index:2 control is invisible.
    expect(CSS).toMatch(/\.obs-maxable > \.obs-max-btn \{\s*z-index: 1000;/);
    expect(CSS).toMatch(
      /\.obs-panel--max[\s\S]{0,200}?\.obs-stripmap,[\s\S]{0,120}?max-height: none;/,
    );
  });
});

describe('a maximised map', () => {
  it('gains the handlers the inline strip deliberately lacks', () => {
    // Inline, the strip is inert on purpose: it sits under the stats and a map
    // that eats scroll there is an obstacle. Maximised, the map IS the page.
    expect(DASH).toMatch(/function setMapInteractive\(map, on\)/);
    for (const h of [
      'dragging',
      'scrollWheelZoom',
      'doubleClickZoom',
      'touchZoom',
      'boxZoom',
      'keyboard',
    ])
      expect(DASH, h).toMatch(new RegExp(`'${h}'`));
    expect(DASH).toMatch(/map\[h\]\?\.\[on \? 'enable' : 'disable'\]/);
  });

  it('adds a zoom control on the way in and removes it on the way out', () => {
    expect(DASH).toMatch(/L\.control\.zoom\(\{ position: 'topleft' \}\)\.addTo\(map\)/);
    expect(DASH).toMatch(/map\.removeControl\(map\._obsZoomCtl\)/);
  });

  it('drives interactivity from the event, not from a guess about state', () => {
    // `detail.open` is what distinguishes entering from leaving; without it the
    // handlers would be enabled on the way out too.
    expect(DASH).toMatch(
      /const open = !!\(\/\*\* @type \{CustomEvent\} \*\/ \(e\)\.detail\?\.open\)/,
    );
    expect(DASH).toMatch(/setMapInteractive\(m, open\)/);
  });

  it('resets its framing when restored, so panning does not leak into the page', () => {
    // The same _obsRefit that fixes the size on the way in discards any panning
    // on the way out — one mechanism, both directions.
    expect(DASH).toMatch(/setMapInteractive\(m, open\);[\s\S]{0,400}?m\._obsRefit\?\.\(\)/);
  });

  it('offers a reset control that re-frames without leaving fullscreen', () => {
    expect(DASH).toMatch(/closest\?\.\('\.obs-map-reset'\)/);
    expect(DASH).toMatch(/function mapResetBtn\(\)/);
    // Rendered into both maximisable wrappers.
    expect(DASH.match(/\$\{mapResetBtn\(\)\}/g)).toHaveLength(2);
  });

  it('shows that control only while maximised', () => {
    expect(CSS).toMatch(/\.obs-map-reset \{[\s\S]*?display: none;/);
    expect(CSS).toMatch(/\.obs-panel--max > \.obs-map-reset \{\s*display: grid;/);
  });
});
