import { reportError } from './notify.js';
import { STORAGE_KEYS, readText, writeText } from './plannerStorage.js';

// Single source of truth lives in the storage registry; re-exported for callers.
export const THEME_STORAGE_KEY = STORAGE_KEYS.themeMode;
// An explicit viewer pick (via the theme picker). Kept separate from THEME_STORAGE_KEY
// so it can outrank the event's own theme without being clobbered when an event that
// designates a theme loads. Empty string ⇒ no override (follow the event/default).
const THEME_OVERRIDE_KEY = STORAGE_KEYS.themeOverride;

// Legacy surface variables. foundation.css owns every surface and text colour
// for converted markup; these exist solely so the not-yet-converted surfaces
// keep rendering during the migration.
const CSS_VAR_MAP = {
  bg: '--bg-0',
  bgAlt: '--bg-1',
  surface: '--surface-0',
  surfaceAlt: '--surface-1',
  surfaceDeep: '--surface-2',
  text: '--text-0',
  textAlt: '--text-1',
  textMuted: '--text-2',
  textFaint: '--text-3',
  border: '--line-0',
};

let _themes = [];

export async function loadThemes() {
  try {
    // Module-relative for the same reason as the archive datasets: a page with
    // path segments (/archive/speaker/x) would otherwise resolve './data/'
    // against the page, not the app root.
    const res = await fetch(new URL('../../data/themes.json', import.meta.url));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    _themes = await res.json();
  } catch (err) {
    // Fall back to built-in themes, but log why the fetch failed.
    reportError('loadThemes', err);
    _themes = _builtinFallback();
  }
  _injectThemeStyles(_themes);
  return _themes;
}

export function getThemes() {
  return _themes;
}

export function setThemes(themes) {
  _themes = themes;
  _injectThemeStyles(_themes);
}

export function getThemeById(id) {
  return _themes.find((t) => t.id === id) || null;
}

export function normalizeThemeId(id) {
  return _themes.some((t) => t.id === id) ? id : _themes[0]?.id || 'dark';
}

export function getCurrentThemeId() {
  const saved = readText(THEME_STORAGE_KEY) || '';
  return normalizeThemeId(saved);
}

export function setCurrentThemeId(id) {
  const normalized = normalizeThemeId(id);
  writeText(THEME_STORAGE_KEY, normalized);
  return normalized;
}

// Explicit viewer override (theme picker). '' ⇒ none.
export function getThemeOverride() {
  const v = readText(THEME_OVERRIDE_KEY) || '';
  return v && getThemeById(v) ? v : '';
}

export function setThemeOverride(id) {
  writeText(THEME_OVERRIDE_KEY, normalizeThemeId(id));
}

export function clearThemeOverride() {
  writeText(THEME_OVERRIDE_KEY, '');
}

// First candidate that names a real theme wins — the array order encodes precedence
// (e.g. url > override > event > saved). Falls back to the default theme.
export function resolveThemeId(candidates) {
  for (const c of candidates || []) {
    if (c && getThemeById(c)) return c;
  }
  return normalizeThemeId('');
}

// ── Mode: light | dark | '' (follow the OS) ─────────────────────────────────
// Its own axis, independent of an event's identity. An explicit pick is
// remembered and outranks everything; '' removes the attribute so the
// prefers-color-scheme rule in foundation.css takes over.
export const MODE_STORAGE_KEY = STORAGE_KEYS.colourMode;

export function getModePreference() {
  const v = readText(MODE_STORAGE_KEY) || '';
  return v === 'light' || v === 'dark' ? v : '';
}

export function setModePreference(mode) {
  const next = mode === 'light' || mode === 'dark' ? mode : '';
  writeText(MODE_STORAGE_KEY, next);
  applyMode();
  return next;
}

// The mode actually in force, with the attribute absent: explicit pick → OS →
// dark. Callers that must branch on light/dark (map tiles, the legacy body
// class) ask this rather than inspecting a theme.
export function resolveMode() {
  const pref = getModePreference();
  if (pref) return pref;
  if (typeof window !== 'undefined' && window.matchMedia)
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  return 'dark';
}

export function applyMode() {
  if (typeof document === 'undefined' || !document.documentElement) return '';
  const pref = getModePreference();
  if (pref) document.documentElement.dataset.mode = pref;
  else delete document.documentElement.dataset.mode;

  // `.theme-dark` is a LEGACY signal, and it belongs to the mode axis — the
  // legacy sheets use it to paint white text and dark fills. It used to be
  // added when the *event's* theme happened to be dark, which is the same
  // conflation the two-axis model removes: an OS-light viewer got a light page
  // wearing white-on-white legacy text. It now tracks the resolved mode, so
  // those rules apply exactly when the paper underneath them is dark.
  // It goes with the legacy sheets.
  document.body?.classList.toggle('theme-dark', resolveMode() === 'dark');
  return pref;
}

// Following the OS means following it as it changes.
if (typeof window !== 'undefined' && window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (!getModePreference()) applyMode();
  });
}

export function applyThemeClass(themeId) {
  const theme = _themes.find((t) => t.id === themeId);
  const body = document.body;
  _themes.forEach((t) => body.classList.remove(`theme-${t.id}`));
  if (theme) body.classList.add(`theme-${theme.id}`);
  body.classList.add('design-primary');
  // Mode is NOT inferred from the event. Resolution is:
  //     explicit viewer pick → prefers-color-scheme → dark
  // Letting an event's theme set the mode put an OS-light viewer into a dark
  // page (every legacy brand theme is dark), which is exactly the conflation
  // the two-axis model exists to remove. The event contributes accents only.
  applyMode();
}

export function applyEventColors(primaryColor, secondaryColor, tertiaryColor) {
  // Must target document.body (not documentElement) — body.theme-* stylesheet rules
  // redefine custom properties at the body scope, so only body inline styles can override them.
  const root = document.body;
  if (primaryColor) {
    root.style.setProperty('--brand-1', primaryColor);
    root.style.setProperty('--accent', primaryColor);
    root.style.setProperty('--accent-strong', _lightenHex(primaryColor, 0.12));
  } else {
    root.style.removeProperty('--brand-1');
    root.style.removeProperty('--accent');
    root.style.removeProperty('--accent-strong');
  }
  if (secondaryColor) {
    root.style.setProperty('--brand-2', secondaryColor);
    root.style.setProperty('--color-secondary', secondaryColor);
  } else {
    root.style.removeProperty('--brand-2');
    root.style.removeProperty('--color-secondary');
  }
  if (tertiaryColor) {
    root.style.setProperty('--brand-3', tertiaryColor);
    root.style.setProperty('--color-tertiary', tertiaryColor);
  } else {
    root.style.removeProperty('--brand-3');
    root.style.removeProperty('--color-tertiary');
  }
}

// Emits ONLY the three organiser accent values per theme.
//
// It used to emit full palettes (surfaces, text, borders) plus radial-gradient
// page backgrounds. Both are now forbidden: foundation.css owns every surface
// and text colour via the light/dark mode axis, and the brief rules out
// gradient backgrounds entirely. A theme's remaining job is identity, not
// chrome — see "Theming model" in brand/DECISIONS.md.
//
// Wrapped in @layer legacy so it cannot outrank the foundation: a runtime
// <style> element is unlayered by default, which would beat every layered rule.
function _injectThemeStyles(themes) {
  if (typeof document === 'undefined') return; // no-op in non-browser/test envs
  const existing = document.getElementById('__theme_styles__');
  if (existing) existing.remove();

  const blocks = themes.map((theme) => {
    const c = theme.colors || {};
    const primary = c.primary || '#00cfff';
    const secondary = c.secondary || primary;
    const tertiary = c.tertiary || secondary;

    // The legacy surface variables are still emitted: every not-yet-converted
    // surface (modals, browse home, promos, the loading overlay) reads them,
    // and dropping them left those surfaces with no colour at all. They go when
    // the last legacy surface is converted, not before.
    const legacyVars = Object.entries(c)
      .filter(([key]) => CSS_VAR_MAP[key])
      .map(([key, val]) => `  ${CSS_VAR_MAP[key]}: ${val};`)
      .join('\n');

    return [
      `body.theme-${theme.id} {`,
      legacyVars,
      `  --brand-1: ${primary};`,
      `  --brand-2: ${secondary};`,
      `  --brand-3: ${tertiary};`,
      // legacy aliases — still read by the not-yet-converted surfaces
      `  --accent: ${primary};`,
      `  --accent-strong: ${_lightenHex(primary, 0.12)};`,
      `  --color-secondary: ${secondary};`,
      `  --color-tertiary: ${tertiary};`,
      `}`,
    ].join('\n');
  });

  const style = document.createElement('style');
  style.id = '__theme_styles__';
  style.textContent = `@layer legacy {\n${blocks.join('\n\n')}\n}`;
  document.head.appendChild(style);
}

function _lightenHex(hex, amount) {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return hex;
  const r = Math.min(255, parseInt(hex.slice(1, 3), 16) + Math.round(255 * amount));
  const g = Math.min(255, parseInt(hex.slice(3, 5), 16) + Math.round(255 * amount));
  const b = Math.min(255, parseInt(hex.slice(5, 7), 16) + Math.round(255 * amount));
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function _builtinFallback() {
  return [
    {
      id: 'dark',
      label: 'Dark',
      dark: true,
      colors: {
        bg: '#010810',
        bgAlt: '#040d1c',
        primary: '#00cfff',
        secondary: '#4a90d9',
        tertiary: '#7c3aed',
        surface: 'rgba(3,10,22,0.93)',
        surfaceAlt: 'rgba(7,18,36,0.96)',
        surfaceDeep: 'rgba(12,28,52,0.84)',
        text: '#eaf2fc',
        textAlt: '#cdd9ee',
        textMuted: '#8eaacc',
        textFaint: '#6a8cb0',
        border: '#162c4c',
      },
    },
  ];
}
