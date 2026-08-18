// Server-side schema validation for event datasets. Mirrors lib/validatePlanner.js
// (same AJV v6 / Draft-7 plumbing and { valid, errors } shape) but validates
// against app/schemas/event.schema.json — the STRICT schema the CLI
// (scripts/validate-data.mjs) already enforces, so an API write is held to the
// same bar as a committed data file.

import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import Ajv from 'ajv';
// ajv 8 moved the format keywords (date-time, uri, email…) into their own package;
// without this the schema's `format` constraints throw at compile time.
import addFormats from 'ajv-formats';

const _dir = dirname(fileURLToPath(import.meta.url));
const _schemaText = readFileSync(join(_dir, '../app/schemas/event.schema.json'), 'utf8');
const _schema = JSON.parse(_schemaText);
const _validate = addFormats(new Ajv({ allErrors: true })).compile(_schema);

/**
 * A short content hash of the schema — the thing a data repo pins against.
 *
 * The schema has no `$id` or version field, and adding a hand-maintained one
 * would just be a number somebody forgets to bump. A fingerprint cannot drift
 * from what is actually enforced: it IS what is enforced. A CI job in a data repo
 * records this value, and a tightened schema shows up as a changed fingerprint
 * rather than as a wave of mystery failures — which matters here, because a
 * schema change is a breaking change for every data repo at once.
 *
 * Hashed over the file bytes, so a reformat counts as a change. That is the
 * conservative direction: a false alarm costs a glance, a missed change costs a
 * repo that thinks it is validating and is not.
 */
export const DATASET_SCHEMA_FINGERPRINT = createHash('sha256')
  .update(_schemaText)
  .digest('hex')
  .slice(0, 12);

// ajv 8 reports the location as a JSON Pointer in `instancePath` ("/items/3/title")
// where ajv 6 used a dot path in `dataPath` (".items[3].title"). Callers — the CLI,
// the API error payloads and the editor — already speak the dot form, so it is
// rebuilt here rather than changed everywhere.
export function errorPath(e) {
  const pointer = e.instancePath ?? e.dataPath ?? '';
  if (!pointer) return '(root)';
  if (pointer.startsWith('.') || pointer.startsWith('[')) return pointer; // already ajv 6 style
  return pointer
    .split('/')
    .filter(Boolean)
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce((acc, part) => (/^\d+$/.test(part) ? `${acc}[${part}]` : `${acc}.${part}`), '');
}

// Validate a parsed event dataset. Returns { valid, errors }, where each error is
// { path, message, keyword, params } — the same shape as validatePlanner and the
// CLI error rendering in scripts/validate-data.mjs.
export function validateDataset(data) {
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
