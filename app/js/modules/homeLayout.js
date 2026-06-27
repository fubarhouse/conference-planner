/**
 * Shared home/landing section template factory.
 * Zero dependencies — returns HTML strings only. Event wiring belongs in the caller.
 * Both planner.js and editor.js import from here so both pages stay in sync.
 */

export function homeRoot(innerHtml) {
  return `<div class="hl-root">${innerHtml}</div>`;
}

export function heroPanel({ iconClass, title, lead = '', actionsHtml = '' }) {
  return `<div class="hl-hero">
    <div class="hl-hero-top">
      <div class="hl-hero-icon" aria-hidden="true"><i class="${iconClass}"></i></div>
      ${actionsHtml}
    </div>
    <h1 class="hl-hero-title">${title}</h1>
    ${lead ? `<p class="hl-hero-lead">${lead}</p>` : ''}
  </div>`;
}

export function ctaGrid(cardsHtml) {
  return `<div class="hl-cta-grid">${cardsHtml}</div>`;
}

export function ctaCard({ id, iconClass, iconMod = '', title, desc, disabled = false, disabledReason = '' }) {
  const disabledAttrs = disabled ? ` disabled title="${disabledReason}"` : '';
  return `<button type="button" class="hl-cta-card${disabled ? ' hl-cta-card--disabled' : ''}" id="${id}"${disabledAttrs}>
    <div class="hl-cta-icon${iconMod ? ` ${iconMod}` : ''}"><i class="${iconClass}"></i></div>
    <div class="hl-cta-body">
      <span class="hl-cta-title">${title}</span>
      <span class="hl-cta-desc">${desc}</span>
    </div>
    <i class="fas fa-chevron-right hl-cta-arrow" aria-hidden="true"></i>
  </button>`;
}

export function statusBar({ label, actionId, actionText }) {
  return `<div class="hl-status-bar">
    <span class="hl-status-dot hl-status-dot--ok"></span>
    <span class="hl-status-label">${label}</span>
    <button type="button" class="hl-status-action" id="${actionId}">${actionText}</button>
  </div>`;
}

export function sectionHeader({ title, primaryBtnId, primaryBtnLabel, primaryBtnIconClass = '', secondaryBtnId = null, secondaryBtnIconClass = null, secondaryBtnTitle = '' }) {
  const icon = primaryBtnIconClass ? `<i class="${primaryBtnIconClass}" style="margin-right:0.35rem"></i>` : '';
  const secondary = secondaryBtnId
    ? `<button type="button" class="hl-settings-btn" id="${secondaryBtnId}" title="${secondaryBtnTitle}" aria-label="${secondaryBtnTitle}"><i class="${secondaryBtnIconClass}"></i></button>`
    : '';
  return `<div class="hl-section-header">
    <h2 class="hl-section-title">${title}</h2>
    <div class="hl-section-actions">
      <button type="button" class="hl-primary-btn" id="${primaryBtnId}">${icon}${primaryBtnLabel}</button>
      ${secondary}
    </div>
  </div>`;
}

export function searchBar({ inputId, placeholder = 'Filter…' }) {
  return `<div class="hl-search-wrap">
    <i class="fas fa-search hl-search-icon" aria-hidden="true"></i>
    <input id="${inputId}" type="search" placeholder="${placeholder}" class="hl-search-input" autocomplete="off">
  </div>`;
}

export function cardGrid({ id, innerHtml = '' }) {
  return `<div id="${id}" class="hl-card-grid">${innerHtml}</div>`;
}

export function loadingState(text = 'Loading…') {
  return `<div class="hl-loading"><i class="fas fa-circle-notch fa-spin"></i> ${text}</div>`;
}

export function emptyState(text) {
  return `<p class="hl-empty">${text}</p>`;
}
