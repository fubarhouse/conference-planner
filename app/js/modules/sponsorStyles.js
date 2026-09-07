// Shared sponsor logo style/aspect vocabularies — the single source of truth for
// the editor's field options + validation and the renderers' CSS class derivation.
// Previously these allow-lists were copy-pasted (in two drifting forms) across
// editor.js, render.js, and sponsors.js.

export const SPONSOR_BG_STYLES = ['auto', 'transparent', 'light-plate', 'dark-plate', 'brand-fill'];
export const SPONSOR_ASPECTS = ['auto', 'square', 'landscape', 'banner'];

// Coerce an arbitrary value to a known vocabulary member (unknown → 'auto').
export function normalizeSponsorBgStyle(value) {
  return SPONSOR_BG_STYLES.includes(value) ? value : 'auto';
}

export function normalizeSponsorAspect(value) {
  return SPONSOR_ASPECTS.includes(value) ? value : 'auto';
}

// CSS class helpers for the renderers. Output is always a fixed, safe token.
export function sponsorBgClass(value) {
  return `sponsor-bg-${normalizeSponsorBgStyle(value)}`;
}

export function sponsorAspectClass(value) {
  return `sponsor-aspect-${normalizeSponsorAspect(value)}`;
}
