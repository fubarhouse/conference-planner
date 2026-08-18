import { once, normalizeString } from './utils.js';

function normalizeCatalogEntry(entry, defaultFile = '') {
  if (typeof entry === 'string') {
    return { file: entry, default: entry === defaultFile };
  }
  if (!entry || typeof entry !== 'object' || !entry.file) {
    return null;
  }
  // Keep only the list shape (file + default); metadata is hydrated elsewhere.
  return {
    file: entry.file,
    default: Boolean(entry.default) || entry.file === defaultFile,
  };
}

export const loadEventCatalog = once(async () => {
  // Module-relative: see validator.js — a deep route made document-relative
  // fetches resolve under the route and return HTML.
  const response = await fetch(new URL('../../data/catalog.json', import.meta.url), {
    cache: 'no-cache',
  });
  if (!response.ok) {
    throw new Error('Failed to load dataset catalog.');
  }
  const payload = await response.json();
  const defaultFile = normalizeString(payload?.defaultFile);
  // catalog.json lists events as { file, event }; the file list is all we need
  // here — metadata is hydrated separately in events.js.
  const entries = Array.isArray(payload?.events) ? payload.events : [];
  return entries.map((entry) => normalizeCatalogEntry(entry, defaultFile)).filter(Boolean);
});
