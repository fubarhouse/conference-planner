export const THEME_STORAGE_KEY = 'scheduleThemeMode';

const CSS_VAR_MAP = {
  bg:          '--bg-0',
  bgAlt:       '--bg-1',
  surface:     '--surface-0',
  surfaceAlt:  '--surface-1',
  surfaceDeep: '--surface-2',
  text:        '--text-0',
  textAlt:     '--text-1',
  textMuted:   '--text-2',
  textFaint:   '--text-3',
  border:      '--line-0',
};

let _themes = [];

export async function loadThemes() {
  try {
    const res = await fetch('./data/themes.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    _themes = await res.json();
  } catch {
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
  return _themes.some((t) => t.id === id) ? id : (_themes[0]?.id || 'dark');
}

export function getCurrentThemeId() {
  const saved = localStorage.getItem(THEME_STORAGE_KEY) || '';
  return normalizeThemeId(saved);
}

export function setCurrentThemeId(id) {
  const normalized = normalizeThemeId(id);
  localStorage.setItem(THEME_STORAGE_KEY, normalized);
  return normalized;
}

export function applyThemeClass(themeId) {
  const theme = _themes.find((t) => t.id === themeId);
  const body = document.body;
  _themes.forEach((t) => body.classList.remove(`theme-${t.id}`));
  body.classList.remove('theme-dark');
  if (theme) {
    body.classList.add(`theme-${theme.id}`);
    if (theme.dark) body.classList.add('theme-dark');
  }
  body.classList.add('design-drupalcon');
}

export function applyEventColors(primaryColor, secondaryColor, tertiaryColor) {
  // Must target document.body (not documentElement) — body.theme-* stylesheet rules
  // redefine custom properties at the body scope, so only body inline styles can override them.
  const root = document.body;
  if (primaryColor) {
    root.style.setProperty('--accent', primaryColor);
    root.style.setProperty('--accent-strong', _lightenHex(primaryColor, 0.12));
  } else {
    root.style.removeProperty('--accent');
    root.style.removeProperty('--accent-strong');
  }
  if (secondaryColor) {
    root.style.setProperty('--color-secondary', secondaryColor);
  } else {
    root.style.removeProperty('--color-secondary');
  }
  if (tertiaryColor) {
    root.style.setProperty('--color-tertiary', tertiaryColor);
    root.style.setProperty('--glow-2', _hexToRgba(tertiaryColor, 0.22));
  } else {
    root.style.removeProperty('--color-tertiary');
    root.style.removeProperty('--glow-2');
  }
}

function _injectThemeStyles(themes) {
  const existing = document.getElementById('__theme_styles__');
  if (existing) existing.remove();

  const blocks = themes.map((theme) => {
    const c = theme.colors || {};
    const primary = c.primary || '#00cfff';
    const tertiary = c.tertiary || c.secondary || primary;

    const vars = Object.entries(c)
      .filter(([key]) => CSS_VAR_MAP[key])
      .map(([key, val]) => `  ${CSS_VAR_MAP[key]}: ${val};`)
      .join('\n');

    const accent       = `  --accent: ${primary};`;
    const accentStrong = `  --accent-strong: ${_lightenHex(primary, 0.12)};`;
    const colorSec     = `  --color-secondary: ${c.secondary || primary};`;
    const colorTert    = `  --color-tertiary: ${c.tertiary || c.secondary || primary};`;
    const glow1        = `  --glow-1: ${_hexToRgba(primary,  theme.dark ? 0.20 : 0.15)};`;
    const glow2        = `  --glow-2: ${_hexToRgba(tertiary, theme.dark ? 0.22 : 0.16)};`;

    const bgGradient = theme.dark
      ? `radial-gradient(ellipse at 15% 0%,   var(--glow-1) 0%, transparent 52%),\n    radial-gradient(ellipse at 88% 96%,  var(--glow-2) 0%, transparent 44%),\n    radial-gradient(ellipse at 50% 110%, rgba(0,0,0,0.04) 0%, transparent 48%),\n    var(--bg-0)`
      : `radial-gradient(ellipse at 15% 0%,   var(--glow-1) 0%, transparent 60%),\n    radial-gradient(ellipse at 88% 96%,  var(--glow-2) 0%, transparent 50%),\n    var(--bg-0)`;

    return [
      `body.theme-${theme.id} {`,
      vars,
      accent, accentStrong, colorSec, colorTert, glow1, glow2,
      `  color: var(--text-0);`,
      `  background:\n    ${bgGradient};`,
      `}`,
    ].join('\n');
  });

  const style = document.createElement('style');
  style.id = '__theme_styles__';
  style.textContent = blocks.join('\n\n');
  document.head.appendChild(style);
}

function _lightenHex(hex, amount) {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return hex;
  const r = Math.min(255, parseInt(hex.slice(1, 3), 16) + Math.round(255 * amount));
  const g = Math.min(255, parseInt(hex.slice(3, 5), 16) + Math.round(255 * amount));
  const b = Math.min(255, parseInt(hex.slice(5, 7), 16) + Math.round(255 * amount));
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function _hexToRgba(hex, alpha) {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return `rgba(0,0,0,${alpha})`;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function _builtinFallback() {
  return [{
    id: 'dark', label: 'Dark', dark: true,
    colors: {
      bg: '#010810', bgAlt: '#040d1c',
      primary: '#00cfff', secondary: '#4a90d9', tertiary: '#7c3aed',
      surface: 'rgba(3,10,22,0.93)', surfaceAlt: 'rgba(7,18,36,0.96)', surfaceDeep: 'rgba(12,28,52,0.84)',
      text: '#eaf2fc', textAlt: '#cdd9ee', textMuted: '#8eaacc', textFaint: '#6a8cb0',
      border: '#162c4c',
    },
  }];
}
