// @ts-check
// Pure form/format helpers shared across the planner tabs: dropdown-option
// builders, budget number parsing, attachment display names, and the timezone
// datalist. Deliberately free of planner state so feature modules can import
// them directly instead of receiving them through an init() injection — this is
// the shared leaf layer the budget/receipt/document features build on.
import { escapeHtml as esc } from './utils.js';

// Injected planner state (for the currency helpers, which read the user's default
// currency). The pure builders below do not depend on it.
/** @type {any} */
let state;

/** @param {{ state: any }} deps */
export function initPlannerFields(deps) {
  ({ state } = deps);
}

export const CURRENCIES = ['AUD', 'USD', 'EUR', 'GBP', 'NZD', 'CHF', 'CAD', 'INR', 'JPY', 'SGD'];

export function getDefaultCurrency() {
  return state.global?.defaultCurrency || 'AUD';
}

// The currency a planner's totals roll up into. A per-planner preference
// (`displayCurrency`, seeded from the global default at creation); when unset —
// e.g. planners created before this setting — it falls back to the mode's trip
// currency so nothing changes for them. Line items are still entered in their own
// currencies; this only governs the rolled-up totals.
/** @param {any} [planner] */
export function plannerDisplayCurrency(planner) {
  const p = planner || state?.planner || {};
  return (
    p.displayCurrency || p.personal?.currency || p.org?.sponsorCurrency || getDefaultCurrency()
  );
}

/** @param {string} [selected] */
export function currencyOptions(selected) {
  const active = selected || getDefaultCurrency();
  return CURRENCIES.map(
    (c) => `<option value="${c}"${c === active ? ' selected' : ''}>${c}</option>`,
  ).join('');
}

// <option> list for a "linked session" picker: a blank option plus one per
// session, labelled "<time> <title>" (truncated to 60 chars). `fmtTime` formats
// the start time (planner injects its timezone-aware formatter).
/**
 * @param {any[]} sessions
 * @param {string} selectedId
 * @param {(iso: string) => string} fmtTime
 * @returns {string}
 */
export function sessionOptionsHtml(sessions, selectedId, fmtTime) {
  const none = `<option value="">— No linked session —</option>`;
  const opts = (sessions || [])
    .map((s) => {
      const label = `${fmtTime(s.startTime)} ${s.title}`.slice(0, 60);
      return `<option value="${esc(s.id)}" ${s.id === selectedId ? 'selected' : ''}>${esc(label)}</option>`;
    })
    .join('');
  return none + opts;
}

/**
 * @param {{ value: any, label: any }[]} options
 * @param {string} [selected]
 * @returns {string}
 */
export function buildSelectOptions(options, selected = '') {
  return options
    .map(
      (c) =>
        `<option value="${esc(c.value)}"${c.value === selected ? ' selected' : ''}>${esc(c.label)}</option>`,
    )
    .join('');
}

/**
 * @param {*} str
 * @returns {number}
 */
export function parseBudget(str) {
  const n = parseFloat(String(str || ''));
  return isNaN(n) ? 0 : n;
}

// Format a numeric amount as a fixed 2-decimal money string (e.g. 1234.5 →
// "1,234.50"). Callers own any currency prefix / dash-for-zero wrapping.
/**
 * @param {*} value
 * @returns {string}
 */
export function formatAmount(value) {
  return Number(value).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * @param {string} filePath
 * @param {string} [fileLabel]
 * @returns {string | undefined}
 */
export function fileDisplayName(filePath, fileLabel) {
  if (!filePath) return '';
  return fileLabel || (filePath.startsWith('data:') ? 'Attached file' : filePath.split('/').pop());
}

// Reflect an attachment's presence into a modal's file-label element and toggle
// its remove button. Shared by the receipt and document attachment modals.
/**
 * @param {string} filePath
 * @param {string} fileLabel
 * @param {string} labelElId
 * @param {string} removeBtnId
 */
export function syncModalFile(filePath, fileLabel, labelElId, removeBtnId) {
  const labelEl = document.getElementById(labelElId);
  const removeBtn = document.getElementById(removeBtnId);
  if (labelEl) {
    if (filePath) {
      labelEl.innerHTML = `<a href="${esc(filePath)}" target="_blank" class="drupal-blue-text hover:underline truncate">${esc(fileLabel || fileDisplayName(filePath, ''))}</a>`;
    } else {
      labelEl.textContent = 'No file attached';
    }
  }
  removeBtn?.classList.toggle('hidden', !filePath);
}

export function tzDatalist() {
  const tzs =
    typeof Intl !== 'undefined' && Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : [];
  return tzs.map((tz) => `<option value="${tz}">`).join('');
}
