// Identity for a keyword line is hue AND dash.
//
// The categorical ramp is eleven hues because eleven is what passed the dataviz
// checker — a twelfth failed CVD separation. So the twelfth keyword cannot have a
// twelfth hue; it reuses the first one with a dash instead. Four laps gives 44
// lines that no two of which look alike, without inventing an unvalidated colour.
import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => {
  globalThis.document ??= {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
  };
});

const { slotStyle } = await import('../archiveDashboard.js');

const RAMP = 11;
const LAPS = 4;

describe('slotStyle', () => {
  it('gives the first lap the eleven validated hues, all solid', () => {
    const first = Array.from({ length: RAMP }, (_, i) => slotStyle(i));
    expect(new Set(first.map((s) => s.color)).size).toBe(RAMP);
    expect(first.every((s) => s.dash === '')).toBe(true);
  });

  it('reuses a hue only once the ramp is spent, and dashes it', () => {
    expect(slotStyle(RAMP).color).toBe(slotStyle(0).color);
    expect(slotStyle(RAMP).dash).not.toBe('');
    expect(slotStyle(0).dash).toBe('');
  });

  it('never repeats a hue+dash pair inside the four laps', () => {
    const seen = new Set();
    for (let i = 0; i < RAMP * LAPS; i++) {
      const s = slotStyle(i);
      const key = `${s.color}|${s.dash}`;
      expect(seen.has(key), `slot ${i} repeats ${key}`).toBe(false);
      seen.add(key);
    }
    expect(seen.size).toBe(44);
  });

  it('falls back to grey past the last lap rather than inventing a hue', () => {
    const over = slotStyle(RAMP * LAPS);
    expect(over.color).toBe('var(--viz-overflow)');
    expect(over.dash).toBe('');
  });

  it('treats an unknown term (slot -1) as overflow, not as slot 0', () => {
    expect(slotStyle(-1).color).toBe('var(--viz-overflow)');
    expect(slotStyle(undefined).color).toBe('var(--viz-overflow)');
  });
});
