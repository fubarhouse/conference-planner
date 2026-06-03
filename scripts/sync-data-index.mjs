import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const dataDir = path.join(repoRoot, 'data');
const indexPath = path.join(dataDir, 'index.json');

function sortFiles(a, b) {
  return a.localeCompare(b);
}

function normalizeDefaultFile(value, availableFiles) {
  const file = String(value || '').trim();
  if (file && availableFiles.includes(file)) return file;
  return availableFiles[0] || '';
}

async function loadExistingIndex() {
  try {
    const text = await readFile(indexPath, 'utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function main() {
  const dirEntries = await readdir(dataDir, { withFileTypes: true });
  const files = dirEntries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith('.json'))
    .filter((name) => name !== 'index.json')
    .filter((name) => name !== 'new-event.json')
    .sort(sortFiles);

  const existingIndex = await loadExistingIndex();
  const existingDefault = existingIndex?.defaultFile || existingIndex?.files?.find((item) => item?.default)?.file || '';
  const defaultFile = normalizeDefaultFile(existingDefault, files);

  const payload = {
    defaultFile,
    files: files.map((file) => (file === defaultFile ? { file, default: true } : { file }))
  };

  await writeFile(indexPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  process.stdout.write(`Updated data/index.json with ${files.length} dataset files.\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
