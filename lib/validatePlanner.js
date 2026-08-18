// Server-side schema validation for planner blobs. The schema
// (app/schemas/planner.schema.json) is deliberately PERMISSIVE so it never
// rejects a valid, migration-era planner and breaks a user's save — it catches
// gross structural corruption (wrong types / non-array collections), not every
// field. Uses AJV v6 (Draft-7), matching scripts/validate-data.mjs.

import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import Ajv from 'ajv';
// ajv 8 moved the format keywords (date-time, uri, email…) into their own package;
// without this the schema's `format` constraints throw at compile time.
import addFormats from 'ajv-formats';

const _dir = dirname(fileURLToPath(import.meta.url));
const _schemaText = readFileSync(join(_dir, '../app/schemas/planner.schema.json'), 'utf8');
const _schema = JSON.parse(_schemaText);
const _validate = addFormats(new Ajv({ allErrors: true })).compile(_schema);

/** Content hash of the planner schema — see DATASET_SCHEMA_FINGERPRINT. */
export const PLANNER_SCHEMA_FINGERPRINT = createHash('sha256')
  .update(_schemaText)
  .digest('hex')
  .slice(0, 12);

// ajv 8 reports the location as a JSON Pointer in `instancePath` ("/items/3/title")
// where ajv 6 used a dot path in `dataPath` (".items[3].title"). Callers — the CLI,
// the API error payloads and the editor — already speak the dot form, so it is
// rebuilt here rather than changed everywhere.
function errorPath(e) {
  const pointer = e.instancePath ?? e.dataPath ?? '';
  if (!pointer) return '(root)';
  if (pointer.startsWith('.') || pointer.startsWith('[')) return pointer; // already ajv 6 style
  return pointer
    .split('/')
    .filter(Boolean)
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce((acc, part) => (/^\d+$/.test(part) ? `${acc}[${part}]` : `${acc}.${part}`), '');
}

// Validate a parsed planner object. Returns { valid, errors }, where each error
// is { path, message, keyword, params } (same shape the dataset validator will
// use, and mirroring the CLI error rendering in scripts/validate-data.mjs).
export function validatePlanner(data) {
  const valid = _validate(data);
  if (valid) return { valid: true, errors: [] };
  return {
    valid: false,
    errors: (_validate.errors || []).map((e) => ({
      path: errorPath(e),
      message: e.message,
      keyword: e.keyword,
      params: e.params,
    })),
  };
}
