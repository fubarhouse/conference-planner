import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const gitDir = path.join(repoRoot, '.git');
const hooksDir = path.join(gitDir, 'hooks');
const bootstrapHookPath = path.join(hooksDir, 'pre-commit');

const bootstrapHook = `#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
hook_path="$repo_root/.githooks/pre-commit"

if [ ! -x "$hook_path" ]; then
  echo "Missing executable repo hook: $hook_path" >&2
  echo "Run: node scripts/install-git-hooks.mjs" >&2
  exit 1
fi

exec "$hook_path" "$@"
`;

async function main() {
  await mkdir(hooksDir, { recursive: true });
  await writeFile(bootstrapHookPath, bootstrapHook, 'utf8');
  await chmod(bootstrapHookPath, 0o755);
  await chmod(path.join(repoRoot, '.githooks', 'pre-commit'), 0o755);
  await execFileAsync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: repoRoot });
  process.stdout.write('Installed repo git hooks and set core.hooksPath to .githooks\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
