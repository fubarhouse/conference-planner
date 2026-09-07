// @ts-check
// Bottom navigation bar composition. Picks the curated primary destinations for a
// mode, then backfills from the visible tab order so the bar always has
// BOTTOM_BAR_SIZE valid entries. Pure — planner.js passes the visible tab order.

const BOTTOM_BAR_SIZE = 4;

// Curated bottom-bar destinations per mode (the most-used pages up front, rather
// than the first N in tab order).
/** @type {Record<string, string[]>} */
const BOTTOM_BAR_TABS = {
  personal: ['personal', 'itinerary', 'map', 'budget'],
  sponsor: ['sponsor', 'team', 'budget', 'tasks'],
};

/**
 * @param {string} mode - 'personal' | 'sponsor'
 * @param {string[]} orderedTabs - currently visible tabs, in order
 * @returns {string[]} up to BOTTOM_BAR_SIZE tab keys
 */
export function bottomBarPrimary(mode, orderedTabs) {
  const visible = new Set(orderedTabs);
  const result = (BOTTOM_BAR_TABS[mode] || []).filter((t) => visible.has(t));
  for (const t of orderedTabs) {
    if (result.length >= BOTTOM_BAR_SIZE) break;
    if (!result.includes(t)) result.push(t);
  }
  return result.slice(0, BOTTOM_BAR_SIZE);
}
