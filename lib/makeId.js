// @ts-check
// Server-side stable id generation for API-created resources. Kept intentionally
// in sync with makeItemId() in app/js/modules/plannerStorage.js — the browser
// module can't be imported here, so ids minted via the API are indistinguishable
// from ids the planner/editor UI creates.

/**
 * Mint a unique id with a short type prefix (e.g. `t_1783_ab12`).
 * @param {string} [prefix]
 * @returns {string}
 */
export function makeId(prefix = 'item') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// Sponsors key off a slug of their title rather than a random id (mirrors
// normalizeSponsorId → slugify in editorSponsors.js). Falls back to a random id
// when the title is blank so a created sponsor always gets a usable id.
/**
 * @param {*} text
 * @param {string} [fallbackPrefix]
 * @returns {string}
 */
export function slugId(text, fallbackPrefix = 'sponsor') {
  const slug = String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || makeId(fallbackPrefix);
}
