// @ts-check
// The editor's address.
//
// It used to be `/editor?tab=sponsors`: the workspace survived a refresh but the
// DATASET did not, so reloading — or sending someone the link — opened an empty
// editor on the right tab. The record is the thing being edited, so the record
// belongs in the path:
//
//   /editor/drupalsouth/2025-melbourne/sponsors
//   └─ dataset ──────────────────────┘ └ tab ┘
//
// `events/` is implied. Every editable dataset lives under it, so repeating it in
// every URL is noise; a path that names it explicitly still round-trips, which is
// what keeps this honest for anything stored elsewhere.

/**
 * The URL for a dataset (and optionally a tab within it).
 *
 * @param {string} file dataset path as the editor holds it, e.g. `events/ddd/2025-leuven.json`
 * @param {string} [tab]
 * @param {readonly string[]} [tabs] the known workspaces; an unknown tab is dropped
 *   rather than written into a URL that could not be read back
 * @returns {string}
 */
export function editorPath(file, tab, tabs = []) {
  const rel = String(file || '')
    .trim()
    .replace(/^\/+/, '')
    .replace(/^events\//i, '')
    .replace(/\.json$/i, '');
  if (!rel) return '/editor';
  const seg = rel
    .split('/')
    .filter(Boolean)
    .map((s) => encodeURIComponent(s))
    .join('/');
  return tab && tabs.includes(tab) ? `/editor/${seg}/${tab}` : `/editor/${seg}`;
}

/**
 * Read a dataset + tab back out of a path.
 *
 * The last segment is the tab when it names one. That is ambiguous for a dataset
 * literally called `sponsors.json`, and deliberately accepted: every URL this
 * app writes carries a tab, so the ambiguity only exists for one hand-typed
 * path, where opening the sponsors tab of the parent folder is a reasonable
 * reading of what was typed.
 *
 * @param {string} pathname
 * @param {readonly string[]} [tabs]
 * @returns {{file: string, tab: string}} `file` is '' when the path names no dataset
 */
export function parseEditorPath(pathname, tabs = []) {
  const m = String(pathname || '').match(/^\/editor(?:\.html)?(?:\/(.*))?$/i);
  if (!m) return { file: '', tab: '' };
  const parts = String(m[1] || '')
    .split('/')
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s; // a malformed escape is not worth throwing a whole boot over
      }
    });
  let tab = '';
  if (parts.length && tabs.includes(parts[parts.length - 1]))
    tab = /** @type {string} */ (parts.pop());
  if (!parts.length) return { file: '', tab };
  const rel = parts.join('/');
  return { file: `${/^events\//i.test(rel) ? rel : `events/${rel}`}.json`, tab };
}
