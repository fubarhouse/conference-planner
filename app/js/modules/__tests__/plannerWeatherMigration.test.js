import { describe, it, expect, vi, beforeEach } from 'vitest';
import { weatherGlyph, weatherInfo } from '../weather.js';

const store = new Map();
vi.stubGlobal('localStorage', {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
  get length() {
    return store.size;
  },
  key: (i) => [...store.keys()][i] ?? null,
});
beforeEach(() => store.clear());

const { loadPlanner, makeEmptyPlanner, makeEmptyGlobal, getPlannerKey, PLANNER_VERSION } =
  await import('../plannerStorage.js');

describe('Weather opt-in default (v4)', () => {
  it('a fresh planner has the weather tab disabled by default', () => {
    const p = makeEmptyPlanner('k', 'e.json');
    expect(p.personal.disabledTabs).toContain('weather');
    expect(p.org.disabledTabs).toContain('weather');
    expect(p._version).toBe(PLANNER_VERSION);
  });

  it('migrates a pre-v4 planner to disable weather, bumping the version', () => {
    store.set(
      getPlannerKey('trip'),
      JSON.stringify({
        _version: 3,
        mode: 'personal',
        personal: { disabledTabs: [] },
        org: { disabledTabs: [] },
      }),
    );
    const p = loadPlanner('trip');
    expect(p.personal.disabledTabs).toContain('weather');
    expect(p.org.disabledTabs).toContain('weather');
    expect(p._version).toBe(PLANNER_VERSION);
  });

  it('leaves a v4 planner that has re-enabled weather alone', () => {
    store.set(
      getPlannerKey('trip'),
      JSON.stringify({
        _version: 4,
        mode: 'personal',
        personal: { disabledTabs: [] },
        org: { disabledTabs: [] },
      }),
    );
    const p = loadPlanner('trip');
    expect(p.personal.disabledTabs).not.toContain('weather'); // user's choice preserved
  });

  it('the global store carries a temperature unit', () => {
    expect(makeEmptyGlobal().tempUnit).toBe('C');
  });
});

describe('weatherGlyph', () => {
  const TONES = ['sun', 'part', 'cloud', 'fog', 'rain', 'snow', 'storm'];

  it('returns an inline svg that inherits the surrounding ink', () => {
    const svg = weatherGlyph('rain');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('stroke="currentColor"');
    expect(svg).toContain('fill="none"');
    expect(svg).toContain('aria-hidden="true"');
  });

  it('draws a distinct shape for every tone', () => {
    // The whole point of keeping a pictogram here is that seven days are told
    // apart at a glance — so no two tones may render the same paths.
    const drawn = TONES.map((t) => weatherGlyph(t));
    expect(new Set(drawn).size).toBe(TONES.length);
  });

  it('falls back to the cloud rather than rendering nothing', () => {
    expect(weatherGlyph('not-a-tone')).toBe(weatherGlyph('cloud'));
  });

  it('every WMO code the app knows resolves to a drawable tone', () => {
    for (const code of [0, 1, 2, 3, 45, 51, 61, 71, 80, 85, 95, 99, 12345]) {
      const { tone } = weatherInfo(code);
      expect(weatherGlyph(tone)).not.toBe('');
      expect(TONES).toContain(tone);
    }
  });
});
