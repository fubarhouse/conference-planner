// @ts-check
// Planner tab visibility + ordering. The per-mode base tab sets, the
// conference-only tabs, and the pure logic that resolves which tabs are visible
// and in what order from the planner's stored tabOrder / disabledTabs. planner.js
// wraps these with its live `state.planner`.

// Base tabs per mode (before per-event disable overrides). 'settings' is added
// by visibleTabs, not listed here.
export const SPONSOR_TABS_BASE = new Set([
  'contacts',
  'tasks',
  'checklists',
  'sponsor',
  'team',
  'notes',
  'documents',
  'tickets',
  'budget',
  'map',
  'weather',
  'summary',
]);
export const PERSONAL_TABS_BASE = new Set([
  'personal',
  'companions',
  'notes',
  'contacts',
  'tasks',
  'checklists',
  'receipts',
  'documents',
  'tickets',
  'budget',
  'split',
  'map',
  'weather',
  'schedule',
  'itinerary',
  'summary',
]);

// Tabs that only appear when isConference is true on the planner.
export const CONFERENCE_TABS = new Set(['notes', 'contacts', 'schedule']);

// Ordered visible tab keys (excluding 'settings') for the tab bar: the planner's
// stored order first (filtered to the base set, enabled, and conference-gated),
// then any remaining base tabs in their default order.
/**
 * @param {string} mode - 'sponsor' | 'personal'
 * @param {*} planner - state.planner
 * @returns {string[]}
 */
export function visibleTabsOrdered(mode, planner) {
  const isConference = planner?.isConference !== false;
  const base = mode === 'sponsor' ? SPONSOR_TABS_BASE : PERSONAL_TABS_BASE;
  const stored =
    mode === 'sponsor' ? planner?.org?.tabOrder || [] : planner?.personal?.tabOrder || [];
  const disabled = new Set(
    mode === 'sponsor' ? planner?.org?.disabledTabs || [] : planner?.personal?.disabledTabs || [],
  );
  const visible = (/** @type {string} */ t) =>
    base.has(t) && !disabled.has(t) && (isConference || !CONFERENCE_TABS.has(t));
  // The user's saved order comes first (their explicit arrangement is preserved),
  // then any base tab they've never ordered — but a NEW tab is slotted in right
  // after its base-order neighbour rather than dumped at the very end, so a freshly
  // added feature (e.g. checklists after tasks) stays discoverable for people who
  // already customised their tab order. Walking base order guarantees a tab's
  // predecessor is already placed by the time we insert it.
  const ordered = stored.filter(visible);
  const baseArr = [...base];
  baseArr.forEach((t, idx) => {
    if (ordered.includes(t) || !visible(t)) return;
    let insertAt = ordered.length;
    for (let k = idx - 1; k >= 0; k--) {
      const pos = ordered.indexOf(baseArr[k]);
      if (pos !== -1) {
        insertAt = pos + 1;
        break;
      }
    }
    ordered.splice(insertAt, 0, t);
  });
  return ordered;
}

// All visible tabs including 'settings' (used for routing / the settings panel).
/**
 * @param {string} mode
 * @param {*} planner
 * @returns {Set<string>}
 */
export function visibleTabs(mode, planner) {
  return new Set([...visibleTabsOrdered(mode, planner), 'settings']);
}
