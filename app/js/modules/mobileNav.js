// Shared iOS-style mobile navigation for the planner and the editor: a bottom tab
// bar of a few curated primary destinations, plus a grouped "More" bottom sheet
// for everything else. Keeping it in one module stops the two surfaces from
// drifting (the editor's old copy silently broke when it missed the planner CSS).
//
// Each surface supplies:
//   meta(tab)  -> { label }
//   primary    -> [tabId]                    // tabs shown in the bar
//   groups     -> [{ label, tabs:[tabId] }]  // sheet grouping (mirrors the sidebar)
//   footer     -> [{ href, label }]          // cross-app links
//
// Icons are deliberately absent. The icon font went with the CDN, and a badge
// tinted a different colour per tab spent colour on identity it did not have —
// colour is reserved for state. A tab is named by its label; nothing else is
// needed when the label is right there.
// and wires clicks on [data-nav-tab] / [data-nav-more]. Markup only — no state.

import { escapeHtml as esc } from './utils.js';

// The bottom bar: primary tabs + a "More" button. When the active tab lives in the
// sheet (not the bar), the More button borrows that tab's label, so the bar always
// shows where you are.
export function bottomBarHtml({ primary, activeTab, meta }) {
  const activeInBar = primary.includes(activeTab);
  const tabBtn = (tab) => {
    const m = meta(tab);
    const active = tab === activeTab;
    return `<button type="button" class="mobile-bottom-tab${active ? ' is-active' : ''}" data-nav-tab="${esc(tab)}" aria-label="${esc(m.label)}" aria-selected="${active}">
      <span class="mobile-bottom-tab-label">${esc(m.label)}</span>
    </button>`;
  };
  const m = activeInBar ? { label: 'More' } : meta(activeTab);
  const moreBtn = `<button type="button" class="mobile-bottom-tab${activeInBar ? '' : ' is-active'}" data-nav-more aria-label="More" aria-haspopup="true" aria-expanded="false">
      <span class="mobile-bottom-tab-label">${esc(activeInBar ? 'More' : m.label)}</span>
    </button>`;
  return primary.map(tabBtn).join('') + moreBtn;
}

// The "More" sheet body: only tabs NOT already in the bar (no duplication), grouped
// under the same labels as the desktop sidebar, then footer links.
export function moreSheetHtml({ groups, primary, activeTab, meta, footer = [] }) {
  const inBar = new Set(primary);
  const joinRows = (items, render) =>
    items
      .map((it, i) => (i > 0 ? '<div class="planner-action-divider"></div>' : '') + render(it))
      .join('');

  const tabRow = (tab) => {
    const m = meta(tab);
    const active = tab === activeTab;
    return `<button type="button" data-nav-tab="${esc(tab)}" class="planner-action-row${active ? ' is-current' : ''}">
      <span class="flex-1">${esc(m.label)}</span>
      <span class="nav-sheet-row-mark" aria-hidden="true">${active ? '\u2713' : '\u203a'}</span>
    </button>`;
  };

  const footerRow = (f) => `<a href="${f.href}" class="planner-action-row">
      <span class="flex-1">${esc(f.label)}</span>
      <span class="nav-sheet-row-mark" aria-hidden="true">\u2197</span>
    </a>`;

  const groupBlocks = groups
    .map((g) => {
      const tabs = g.tabs.filter((t) => !inBar.has(t));
      if (!tabs.length) return '';
      return (
        (g.label ? `<p class="nav-sheet-group-label">${esc(g.label)}</p>` : '') +
        joinRows(tabs, tabRow)
      );
    })
    .join('');

  const footerBlock = footer.length
    ? `<div class="nav-sheet-foot">${joinRows(footer, footerRow)}</div>`
    : '';
  return groupBlocks + footerBlock;
}
