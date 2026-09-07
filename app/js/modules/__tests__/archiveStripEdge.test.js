// New Zealand is the archive's most easterly community — Auckland at ~174.8°E,
// against a `noWrap` world that stops dead at 180°. On the footprint strip, the
// zoom floor `coverZoom` was the level at which the world exactly covers the
// frame, which puts 180° precisely on the frame's right edge and leaves those
// pins about thirteen pixels from it: the marker and its tooltip get clipped.
//
// The clamp was not wrong — it kept the viewport inside the world, as intended.
// The bug is that "inside the world" and "comfortably on screen" differ at ±180°.
// Both the zoom floor and the clamp now reserve EDGE_PAD pixels beyond each edge.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'archiveDashboard.js'),
  'utf8',
);

/** The strip's clamp, mirrored, so the geometry itself can be exercised. */
const EDGE_PAD = 22;
function clamp1(v, half, world) {
  return world <= half * 2
    ? world / 2
    : Math.min(Math.max(v, half - EDGE_PAD), world - half + EDGE_PAD);
}

describe('the footprint strip near the antimeridian', () => {
  it('reserves a margin in the zoom floor rather than covering exactly', () => {
    expect(SRC).toMatch(/const EDGE_PAD = 22;/);
    expect(SRC).toMatch(
      /const coverZoom = Math\.log2\(Math\.max\(px - EDGE_PAD \* 2, 64\) \/ 256\)/,
    );
  });

  it('lets the viewport overhang the world edge by that margin', () => {
    expect(SRC).toMatch(/Math\.max\(v, half - EDGE_PAD\), world - half \+ EDGE_PAD/);
  });

  it('keeps an Auckland pin clear of the right-hand frame edge', () => {
    // Widest case: world sized so it covers the frame less the two margins.
    const px = 900;
    const world = px - EDGE_PAD * 2;
    const centreX = clamp1(world / 2, px / 2, world);
    // Where 174.8°E lands, measured from the frame's left edge.
    const lonToX = (lon) => ((lon + 180) / 360) * world;
    const pinFromLeft = lonToX(174.8) - centreX + px / 2;
    expect(px - pinFromLeft).toBeGreaterThan(10); // 8px marker radius + air
  });

  it('still centres the world when it is narrower than the frame', () => {
    // The branch that produces the margin on both sides at the widest zoom.
    expect(clamp1(999, 450, 856)).toBe(428);
  });

  it('does not let the margin push the map off its own world when zoomed in', () => {
    // Zoomed in, the overhang is bounded by EDGE_PAD and nothing more.
    const world = 16384;
    const half = 450;
    expect(clamp1(0, half, world)).toBe(half - EDGE_PAD);
    expect(clamp1(1e9, half, world)).toBe(world - half + EDGE_PAD);
  });
});
