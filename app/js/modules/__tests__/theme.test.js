import { describe, it, expect, beforeEach } from 'vitest';
import { setThemes, resolveThemeId, normalizeThemeId, getThemeById } from '../theme.js';

const THEMES = [
  { id: 'dark', label: 'Dark', dark: true, colors: {} },
  { id: 'light', label: 'Light', dark: false, colors: {} },
  { id: 'drupaljam', label: 'DrupalJam', dark: true, colors: {} },
  { id: 'drupalsouth', label: 'DrupalSouth', dark: true, colors: {} },
];

beforeEach(() => setThemes(THEMES));

describe('resolveThemeId (precedence)', () => {
  it('returns the first candidate that names a real theme', () => {
    expect(resolveThemeId(['light', 'dark'])).toBe('light');
  });

  it('skips empty/unknown candidates (url > override > event > base)', () => {
    // url empty, override unknown, event valid → event wins
    expect(resolveThemeId(['', 'nope', 'drupaljam', 'dark'])).toBe('drupaljam');
  });

  it('an explicit override outranks the event theme', () => {
    expect(resolveThemeId(['', 'light', 'drupaljam', 'dark'])).toBe('light');
  });

  it('a url (shared-link) theme outranks everything', () => {
    expect(resolveThemeId(['drupalsouth', 'light', 'drupaljam', 'dark'])).toBe('drupalsouth');
  });

  it('falls back to the default theme when nothing matches', () => {
    expect(resolveThemeId(['', null, 'ghost'])).toBe('dark');
    expect(resolveThemeId([])).toBe('dark');
  });
});

describe('rename sanity', () => {
  it('has drupaljam and no drupalcon theme', () => {
    expect(getThemeById('drupaljam')).toBeTruthy();
    expect(getThemeById('drupalcon')).toBeNull();
  });

  it('normalizeThemeId keeps known ids and defaults unknown ones', () => {
    expect(normalizeThemeId('light')).toBe('light');
    expect(normalizeThemeId('drupalcon')).toBe('dark'); // old id no longer valid
  });
});
