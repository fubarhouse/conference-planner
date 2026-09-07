// Source attribution — re-exported from the client-side module.
//
// The implementation lives in app/js/modules/sources.js, not here, for one
// reason: the editor needs it in the browser, and only `app/` is served. The
// app also runs as plain static files with no server at all, so there is no
// route that could expose `lib/` — the file has to sit inside the served tree.
//
// It is pure ESM with no Node imports, so Node can read it from there happily.
// This shim exists so `lib/` and `scripts/` keep importing `../lib/sources.js`
// as they always have, and so there is exactly ONE implementation of the schema
// rather than a server copy and a browser copy quietly drifting apart.
//
// See docs/sources.md.

export {
  autoVerifiable,
  sourceConfidence,
  attributionStrength,
  sourceReach,
  parseWaybackUrl,
  isWaybackUrl,
  waybackTimestampToIso,
  makeSource,
  looksLikeUrl,
  sourceFromInput,
  deriveSourceId,
  validateSource,
  validateDatasetSources,
  summarizeSources,
  classifyUrl,
} from '../../app/js/modules/sources.js';
