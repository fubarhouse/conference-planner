// Pick the right schema for a file under DATA_ROOT, and validate against it.
//
// `/api/data/*` is not only event datasets: the editor also saves `themes.json`
// (and `sponsors.json`), which have their own schemas. Validating everything as an
// event would reject those outright and break saving from the editor — so the
// dispatch below mirrors the one `scripts/validate-data.mjs` already uses.
//
// Generated caches are skipped rather than failed. `catalog.json`,
// `geocache.json` and `album-thumbs.json` are derived artifacts with no authored
// schema; holding them to the event schema would reject legitimate writes.

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { validateDataset, errorPath } from './validateDataset.js';

const _dir = dirname(fileURLToPath(import.meta.url));

/** Same AJV construction as validateDataset/validatePlanner — formats included. */
function compile(schemaFile) {
  const schema = JSON.parse(readFileSync(join(_dir, '../app/schemas', schemaFile), 'utf8'));
  return addFormats(new Ajv({ allErrors: true })).compile(schema);
}

const BY_BASENAME = {
  'themes.json': { schema: 'themes.schema.json', validate: compile('themes.schema.json') },
  'sponsors.json': { schema: 'sponsors.schema.json', validate: compile('sponsors.schema.json') },
};

/** Derived artifacts — no authored schema to hold them to. */
const GENERATED = new Set(['catalog.json', 'geocache.json', 'album-thumbs.json']);

/**
 * @param {string} relPath path under DATA_ROOT, e.g. `events/drupalcon/eu/2025.json`
 * @param {unknown} data the parsed document
 * @returns {{ valid: boolean, errors: Array<object>, schema: string|null, skipped?: boolean }}
 */
export function validateDataFile(relPath, data) {
  const base = String(relPath || '')
    .split('/')
    .pop();

  if (base && GENERATED.has(base)) {
    return { valid: true, errors: [], schema: null, skipped: true };
  }

  const special = base ? BY_BASENAME[base] : null;
  if (special) {
    const valid = special.validate(data);
    return {
      valid,
      errors: valid
        ? []
        : (special.validate.errors || []).map((e) => ({
            path: errorPath(e),
            message: e.message,
            keyword: e.keyword,
            params: e.params,
          })),
      schema: special.schema,
    };
  }

  return { ...validateDataset(data), schema: 'event.schema.json' };
}

/**
 * A one-line summary for a human. The editor shows `err.error` verbatim, so a bare
 * "validation_failed" would tell the person nothing about what to fix.
 *
 * @param {Array<{path?: string, message?: string}>} errors
 * @returns {string}
 */
export function summarizeErrors(errors) {
  const list = Array.isArray(errors) ? errors : [];
  if (!list.length) return 'Schema validation failed';
  const first = list
    .slice(0, 3)
    .map((e) => `${e.path || '(root)'} ${e.message || ''}`.trim())
    .join('; ');
  const more = list.length > 3 ? ` (and ${list.length - 3} more)` : '';
  return `Schema validation failed: ${first}${more}`;
}
