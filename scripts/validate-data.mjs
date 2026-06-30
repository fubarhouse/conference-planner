import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Ajv = require('../node_modules/ajv/dist/ajv.bundle.js');

const ajv = new Ajv({ allErrors: true });

const schemas = {
  'index.json':   'app/schemas/index.schema.json',
  'sponsors.json': 'app/schemas/sponsors.schema.json',
  'themes.json':  'app/schemas/themes.schema.json',
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

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const verbose = process.argv.includes('--verbose');

function collectJsonFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectJsonFiles(full));
    } else if (entry.name.endsWith('.json')) {
      results.push(full);
    }
  }
  return results;
}

const targets = args.length
  ? args
  : collectJsonFiles('app/data');

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
      const location = err.dataPath || '(root)';
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
console.log(`\n${pass}/${total} files valid${fail > 0 ? ` — ${fail} failed` : ''}.`);
if (fail > 0) process.exitCode = 1;
