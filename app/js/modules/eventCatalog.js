import { once } from './utils.js';

function normalizeCatalogEntry(entry, defaultFile = '') {
  if (typeof entry === 'string') {
    return { file: entry, default: entry === defaultFile };
  }
  if (!entry || typeof entry !== 'object' || !entry.file) {
    return null;
  }
  return {
    ...entry,
    default: Boolean(entry.default) || entry.file === defaultFile
  };
}

export const loadEventCatalog = once(async () => {
  const response = await fetch('./data/index.json');
  if (!response.ok) {
    throw new Error('Failed to load dataset catalog.');
  }
  const payload = await response.json();
  const defaultFile = String(payload?.defaultFile || '').trim();
  const files = Array.isArray(payload?.files) ? payload.files : [];
  return files.map((entry) => normalizeCatalogEntry(entry, defaultFile)).filter(Boolean);
});
