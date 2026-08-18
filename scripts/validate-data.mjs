import fs from 'fs';
import path from 'path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { DATA_ROOT } from '../lib/roots.js';

// Reaching into node_modules for a prebuilt bundle used to work by accident; ajv 8
// ships no such file, and a strict node_modules layout would not let us look anyway.
const ajv = addFormats(new Ajv({ allErrors: true }));

const schemas = {
  'sponsors.json': 'app/schemas/sponsors.schema.json',
  'themes.json': 'app/schemas/themes.schema.json',
};
const eventSchema = 'app/schemas/event.schema.json';

function loadValidator(schemaPath) {
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  return ajv.compile(schema);
}

const validators = {};
for (const [file, schemaPath] of Object.entries(schemas)) {
  validators[file] = loadValidator(schemaPath);
}
const validateEvent = loadValidator(eventSchema);

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const verbose = process.argv.includes('--verbose');

const GENERATED = new Set(['catalog.json', 'geocache.json', 'album-thumbs.json']);
function collectJsonFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // `curation/` holds the private identity-mapping (decisions.json), not event data.
      if (entry.name === 'curation') continue;
      results.push(...collectJsonFiles(full));
    } else if (entry.name.endsWith('.json') && !GENERATED.has(entry.name)) {
      // Skip generated caches — not authored event data, no schema to validate against:
      //   catalog.json  (scripts/build-catalog.mjs)  ·  geocache.json (scripts/geocode-events.mjs)
      //   album-thumbs.json (resolved from each album's og:image, lib/albumThumbs.js)
      results.push(full);
    }
  }
  return results;
}

// Follow DATA_ROOT rather than assuming `app/data`. The archive is configurable
// and can live outside this repository; with the path hardcoded this script found
// nothing after the data was detached and reported "0/0 files valid" — a pass. A
// validator that silently validates nothing is worse than one that fails.
const targets = args.length ? args : collectJsonFiles(DATA_ROOT);

let pass = 0;
let fail = 0;

for (const filePath of targets) {
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exitCode = 1;
    continue;
  }

  const basename = path.basename(filePath);
  const validate = validators[basename] ?? validateEvent;

  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    console.error(`\n✗ ${filePath}`);
    console.error(`  JSON parse error: ${e.message}`);
    fail++;
    continue;
  }

  const valid = validate(data);

  if (valid) {
    if (verbose) console.log(`✓ ${filePath}`);
    pass++;
  } else {
    console.error(`\n✗ ${filePath}`);
    for (const err of validate.errors) {
      const location = err.instancePath || err.dataPath || '(root)';
      console.error(`  ${location}: ${err.message}`);
      if (err.keyword === 'enum') {
        console.error(`    allowed values: ${err.params.allowedValues.join(', ')}`);
      }
      if (err.keyword === 'additionalProperties') {
        console.error(`    unexpected property: "${err.params.additionalProperty}"`);
      }
      if (err.keyword === 'pattern') {
        console.error(`    pattern: ${err.params.pattern}`);
      }
    }
    fail++;
  }
}

const total = pass + fail;

// Nothing to validate is a failure, not a pass. It means DATA_ROOT points somewhere
// empty or wrong, and reporting success would hand CI a green tick for checking
// nothing at all.
if (total === 0) {
  console.error(`\nNo data files found under ${DATA_ROOT}.`);
  console.error('Set DATA_ROOT to the archive, or pass file paths explicitly.');
  process.exitCode = 1;
} else {
  console.log(`\n${pass}/${total} files valid${fail > 0 ? ` — ${fail} failed` : ''}.`);
  if (fail > 0) process.exitCode = 1;
}
