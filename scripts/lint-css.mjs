#!/usr/bin/env node
/**
 * Guards the CSS rules codified in brand/DECISIONS.md.
 *
 *  1. No `!important` outside the `overrides` layer. Ours exists only to
 *     outrank an `!important` in the legacy sheets, and it is quarantined in
 *     one place so it can be deleted wholesale when those are pruned.
 *  2. No gradient backgrounds, anywhere.
 *  3. No literal font-size values — every size resolves to a --step-* token.
 *
 * Legacy sheets are exempt: they are scheduled for deletion, not repair.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const CSS_DIR = 'app/css';
const OWNED = [
  'foundation.css',
  'section-chrome.css',
  'section-schedule.css',
  'section-archive.css',
  'section-planner.css',
  'section-editor.css',
  'section-home.css',
  'section-curation.css',
];

const problems = [];
let quarantined = 0;

for (const file of readdirSync(CSS_DIR).filter((f) => OWNED.includes(f))) {
  const path = join(CSS_DIR, file);
  // Blank out comment bodies (preserving newlines) so prose mentioning
  // `!important` or "gradient" is not mistaken for a declaration.
  const raw = readFileSync(path, 'utf8');
  const lines = raw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).split('\n');

  let depth = 0;
  let overridesDepth = -1;

  lines.forEach((line, i) => {
    const at = `${path}:${i + 1}`;

    if (/^\s*@layer\s+overrides\s*\{/.test(line)) overridesDepth = depth;
    const inOverrides = overridesDepth >= 0;

    if (line.includes('!important')) {
      // Two standing exemptions, both genuine contracts rather than styling:
      //   - prefers-reduced-motion must defeat inline/JS-driven animation
      //   - [hidden] must never be overridden by a display rule
      const exempt =
        /animation-|transition-|scroll-behavior/.test(line) ||
        /\[hidden\]/.test(lines[i - 1] || '');
      if (inOverrides) quarantined += 1;
      else if (exempt) {
        /* allowed */
      } else problems.push(`${at}  !important outside the overrides layer`);
    }

    if (/(linear|radial|conic)-gradient/.test(line)) {
      // the select caret is drawn with two hard-stop gradients, not a fade
      if (!/transparent 50%|currentColor 50%/.test(line)) {
        problems.push(`${at}  gradient background`);
      }
    }

    // Square corners are the default; a radius over 2px is a bug (see the hard
    // rules in brand/DECISIONS.md).
    const radius = line.match(/border-radius:\s*([^;!]+)/);
    if (radius) {
      const px = radius[1].trim();
      const n = parseFloat(px);
      const isZero = /^0(px|rem|%)?$/.test(px) || n === 0;
      const tiny = /px$/.test(px) && n <= 2;
      const round = /50%|9999px/.test(px); // a circle is a shape, not a corner
      if (!isZero && !tiny && !round) {
        problems.push(`${at}  border-radius "${px}" — square corners are the default, max 2px`);
      }
    }

    const size = line.match(/font-size:\s*([^;]+);/);
    if (size && !/var\(--/.test(size[1])) {
      problems.push(`${at}  literal font-size "${size[1].trim()}" — use a --step-* token`);
    }

    depth += (line.match(/\{/g) || []).length;
    depth -= (line.match(/\}/g) || []).length;
    if (inOverrides && depth <= overridesDepth) overridesDepth = -1;
  });
}

if (problems.length) {
  console.error('CSS rule violations:\n');
  problems.forEach((p) => console.error('  ' + p));
  console.error(`\n${problems.length} problem(s). See brand/DECISIONS.md.`);
  process.exit(1);
}

console.log(`CSS rules OK. !important still quarantined in overrides: ${quarantined}`);
console.log('Target is 0 — reached when the legacy sheets are pruned.');
