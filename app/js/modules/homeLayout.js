/**
 * Shared home/landing section template factory.
 * Zero dependencies — returns HTML strings only. Event wiring belongs in the caller.
 * Both planner.js and editor.js import from here so both pages stay in sync.
 */

export function homeRoot(innerHtml) {
  return `<div class="hl-root">${innerHtml}</div>`;
}

// `iconClass` is gone from every builder here, the same way it went from
// `sectionHeader`: a title names the thing better than a glyph of it, and there
// is no icon font any more. Callers that still pass it are simply not read.
// The hero's title is an h2, not an h1. Every page already carries one h1 — the
// masthead lockup (`#pageTitle`) — so a hero h1 made a second one, and on the
// browse screen the two even said the same words. It also left the outline
// jumping h1 -> h3 straight to the event cards. h2 restores a real hierarchy
// and looks identical; `.hl-hero-title` carries the size, not the tag.
export function heroPanel({ title, lead = '', actionsHtml = '' }) {
  return `<div class="hl-hero">
    <div class="hl-hero-top">
      ${actionsHtml}
    </div>
    <h2 class="hl-hero-title">${title}</h2>
    ${lead ? `<p class="hl-hero-lead">${lead}</p>` : ''}
  </div>`;
}

export function ctaGrid(cardsHtml) {
  return `<div class="hl-cta-grid">${cardsHtml}</div>`;
}

export function ctaCard({ id, title, desc, disabled = false, disabledReason = '' }) {
  const disabledAttrs = disabled ? ` disabled title="${disabledReason}"` : '';
  return `<button type="button" class="hl-cta-card${disabled ? ' hl-cta-card--disabled' : ''}" id="${id}"${disabledAttrs}>
    <div class="hl-cta-body">
      <span class="hl-cta-title">${title}</span>
      <span class="hl-cta-desc">${desc}</span>
    </div>
  </button>`;
}

export function statusBar({ label, actionId, actionText }) {
  return `<div class="hl-status-bar">
    <span class="hl-status-dot hl-status-dot--ok"></span>
    <span class="hl-status-label">${label}</span>
    <button type="button" class="hl-status-action" id="${actionId}">${actionText}</button>
  </div>`;
}

export function sectionHeader({
  title,
  primaryBtnId,
  primaryBtnLabel,
  secondaryBtnId = null,
  secondaryBtnTitle = '',
}) {
  // The secondary control wears its title as a visible label. It used to take
  // an icon class; both icon parameters are gone rather than left accepted and
  // ignored, so a caller cannot pass something that silently does nothing.
  const secondary = secondaryBtnId
    ? `<button type="button" class="hl-settings-btn" id="${secondaryBtnId}" aria-label="${secondaryBtnTitle}">${secondaryBtnTitle}</button>`
    : '';
  return `<div class="hl-section-header">
    <h2 class="hl-section-title">${title}</h2>
    <div class="hl-section-actions">
      <button type="button" class="hl-primary-btn" id="${primaryBtnId}">${primaryBtnLabel}</button>
      ${secondary}
    </div>
  </div>`;
}

export function searchBar({ inputId, placeholder = 'Filter…', label = '' }) {
  // A placeholder is not a label: it is announced inconsistently and vanishes
  // the moment there is a value. `label` defaults to the placeholder text so
  // every caller gets a name without having to pass one.
  const name = label || placeholder.replace(/[…:]\s*$/, '');
  return `<div class="hl-search-wrap">
    <label class="sr-only" for="${inputId}">${name}</label>
    <input id="${inputId}" type="search" placeholder="${placeholder}" class="hl-search-input" autocomplete="off">
  </div>`;
}

export function cardGrid({ id, innerHtml = '' }) {
  return `<div id="${id}" class="hl-card-grid">${innerHtml}</div>`;
}

export function loadingState(text = 'Loading…') {
  return `<div class="hl-loading"> ${text}</div>`;
}

export function emptyState(text) {
  return `<p class="hl-empty">${text}</p>`;
}
