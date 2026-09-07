// Builds a single consolidated catalog of event metadata so the schedule page can
// fetch ONE file (app/data/catalog.json) instead of every event JSON at startup.
//
// The event files on disk under app/data/events/ are the source of truth: this
// walks them directly (no index.json), keeps only the `event` fields the client
// consumes for the event selector / Browse home / visibility + category logic,
// and resolves the default event from an `event.default` flag on the files.
//
// The client repopulates its manifest maps from this and falls back to per-file
// fetching if it's absent, so the `event` shape here must stay a drop-in for each
// file's `data.event`.
//
// Shared by server.js (regenerates on boot + after an event is written) and
// scripts/build-catalog.mjs (for CI / static GitHub Pages builds).

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { summarizeSources } from './sources.js';

// Only the fields the client reads (getSearchableEvents + visibility/category +
// home cards). Keeping the subset small keeps catalog.json lean. `default` is
// intentionally excluded — it's collapsed into the top-level defaultFile string.
const EVENT_FIELDS = [
  'designation',
  'location',
  'year',
  'region',
  'venue',
  'startDate',
  'endDate',
  'timezone',
  'website',
  'scheduleURL',
  'enabled',
  'hidden',
  'eventVisibility',
];

// Event files live under events/; these top-level data files never do.
const EXCLUDE_NAMES = new Set(['index.json', 'catalog.json', 'new-event.json']);
const EVENTS_SUBDIR = 'events';

function pickEventFields(event) {
  const out = {};
  for (const key of EVENT_FIELDS) {
    if (event[key] !== undefined) out[key] = event[key];
  }
  return out;
}

// Recursively collect every *.json under `dir`, as POSIX paths relative to dataDir
// (e.g. "events/drupalcon/us/2008-boston.json"). Exported for reuse/testing.
export async function collectEventFiles(dir, dataDir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out; // events/ absent — treat as no events rather than throwing.
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectEventFiles(full, dataDir, out);
    } else if (entry.isFile() && entry.name.endsWith('.json') && !EXCLUDE_NAMES.has(entry.name)) {
      out.push(relative(dataDir, full).split(sep).join('/'));
    }
  }
  return out;
}

// Build the catalog object from a data directory (the app's data/ folder).
// Unreadable/invalid event files are skipped — exactly what the client does.
export async function buildCatalog(dataDir) {
  const files = (await collectEventFiles(join(dataDir, EVENTS_SUBDIR), dataDir)).sort((a, b) =>
    a.localeCompare(b),
  );

  const events = [];
  const skipped = [];
  let defaultFile = '';
  for (const file of files) {
    try {
      const data = JSON.parse(await readFile(join(dataDir, file), 'utf8'));
      const event = data?.event || {};
      // First file flagged as default wins; falls back to the first file below.
      if (!defaultFile && event.default === true) defaultFile = file;
      // A digest of the event's provenance, not the sources themselves. The
      // archive filters on this — everything from archive.org, everything
      // unsourced, everything not verified since a given year — and doing that
      // by loading 90 datasets would defeat the point of having a catalog.
      // Omitted entirely when an event has no sources, to keep the file lean.
      const sources = summarizeSources(data);
      events.push({
        file,
        event: pickEventFields(event),
        ...(sources.count ? { sources } : {}),
      });
    } catch (err) {
      // The client tolerates unavailable/invalid event data — but record it so
      // callers can surface it (a broken file would otherwise silently vanish).
      skipped.push({ file, reason: err.code || err.name || err.message });
    }
  }
  if (!defaultFile) defaultFile = files[0] || '';

  return { generatedAt: new Date().toISOString(), defaultFile, events, skipped };
}

// Build and write app/data/catalog.json. `skipped` is returned to the caller for
// logging but kept out of the committed catalog file. Returns { …catalog, skipped }.
export async function writeCatalog(dataDir) {
  const { skipped, ...catalog } = await buildCatalog(dataDir);
  await writeFile(join(dataDir, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
  return { ...catalog, skipped };
}
