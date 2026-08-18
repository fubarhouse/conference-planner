// The provenance notice, read once and injected wherever a page asks for it.
//
// One wording, one file (app/partials/provenance.html). The alternative —
// pasting the same paragraph into home.html and index.html — is how two copies
// of a statement about what this product is and is not start to disagree, and
// this is precisely the text that must not.
//
// It is injected server-side rather than fetched by the client on purpose: a
// disclosure that depends on JavaScript is a disclosure that sometimes is not
// there. The placeholder is a plain HTML comment, so a static deployment that
// never runs this server simply renders nothing visible rather than a broken
// element — see the note in docs/architecture.md.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(HERE, '../app/partials/provenance.html');

/** Where corrections and removals are handled. Per-deployment. */
export const ALMANAC_HOME = (process.env.ALMANAC_HOME || 'https://drupal-almanac.com').replace(
  /\/$/,
  '',
);

/** The marker a page puts where the notice belongs. */
export const PLACEHOLDER = '<!--provenance-->';

let _cached = null;

/**
 * The notice, with the canonical home applied.
 *
 * The link carries `data-almanac-home`, so pointing a deployment at its own
 * address is a substitution on one attribute rather than a copy of the text.
 */
export function provenanceHtml() {
  if (_cached) return _cached;
  let html = readFileSync(SOURCE, 'utf8');
  // Drop the authoring comments — they explain the file to a maintainer and
  // have no business being served to every visitor. Anchored to the START and
  // looped, rather than one lazy match: the first version stopped at the first
  // `-->` it found, which was one INSIDE the comment's own prose, and shipped
  // the remainder of that comment to every reader. The test caught it.
  let trimmed = html.trimStart();
  while (trimmed.startsWith('<!--')) {
    const end = trimmed.indexOf('-->');
    if (end === -1) break;
    trimmed = trimmed.slice(end + 3).trimStart();
  }
  html = trimmed;
  // Token substitution, not pattern matching on markup: the formatter wraps
  // long tags as `<a href="…"\n  >label</a\n>`, and a regex written against the
  // unwrapped shape silently replaced the href while leaving the visible label
  // saying the old domain — a link whose text and destination disagreed.
  html = html
    .replaceAll('{{ALMANAC_HOME}}', ALMANAC_HOME)
    .replaceAll('{{ALMANAC_LABEL}}', ALMANAC_HOME.replace(/^https?:\/\//, ''));
  _cached = html.trim();
  return _cached;
}

/** Replace the marker in a page. A page without the marker is left alone. */
export function injectProvenance(html) {
  if (!html.includes(PLACEHOLDER)) return html;
  return html.replace(PLACEHOLDER, provenanceHtml());
}
