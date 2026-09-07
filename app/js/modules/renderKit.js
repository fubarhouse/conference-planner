// Small pure HTML-fragment builders shared by the planner's list/card renderers.
// These capture markup that was repeated verbatim across many *CardHtml/*RowHtml
// builders. Each returns a string; callers own data-binding and event wiring.
// Keep class names byte-identical to the originals so CSS keeps matching.

// A decorative "remove/delete" icon button. `hook` is the delegation class the
// panel listens on (e.g. 'remove-leg-btn'); `data` is the pre-rendered data-*
// attribute string; `extraClass` appends layout modifiers (e.g. the group-hover
// reveal). The fa-times glyph is decorative, so it is always aria-hidden.
export function removeIconBtn({ hook, data = '', label, extraClass = '' }) {
  // The name is now a misnomer: it draws a word, not an icon. Kept because it is
  // called from a dozen places and the ONE thing that matters is that every
  // "remove" in the planner looks and reads the same.
  const cls = `${hook} pl-act pl-act--del${extraClass ? ` ${extraClass}` : ''}`;
  const attrs = data ? ` ${data}` : '';
  return `<button type="button" class="${cls}"${attrs} aria-label="${label}">Remove</button>`;
}

// The italic "nothing here yet" paragraph used to fill empty list panels.
export function emptyStateP(text, cls = 'cmp-none') {
  return `<p class="${cls}">${text}</p>`;
}
