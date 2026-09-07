// Remapping an identity was completely broken, on every subject, and had been
// silently so: the client posted `type`, the server reads `idType`. An absent
// field reads as an empty string, empty is not a known identity kind, and the
// reply was "Unknown identity type." — an error about the VALUE for a bug in the
// NAME, which is why it survived.
//
// Nothing about the payload is visible from either side alone, so the shape gets
// a test of its own.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { identitySuggestionBody } from '../archiveDashboard.js';

describe('the identity proposal payload', () => {
  it('names the type field `idType`', () => {
    const body = identitySuggestionBody('person', 'Gabor Hojtsy', 'Gábor Hojtsy');
    expect(body.idType).toBe('person');
    // The old, wrong spelling must not come back alongside it.
    expect(body.type).toBeUndefined();
  });

  it('carries the kind the queue routes on', () => {
    // Two different claims share this endpoint; `kind` is what tells them apart.
    expect(identitySuggestionBody('sponsor', 'a', 'b').kind).toBe('identity');
  });

  it('sends both names unchanged', () => {
    // The server trims and length-limits; the client must not pre-mangle, since
    // case and accents are the whole point of a mapping.
    const body = identitySuggestionBody('speaker', 'gábor hojtsy', 'Gábor Hojtsy');
    expect(body.from).toBe('gábor hojtsy');
    expect(body.to).toBe('Gábor Hojtsy');
  });

  it('is the body actually posted', () => {
    // Guards the other half: the helper is right but unused.
    const SRC = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'archiveDashboard.js'),
      'utf8',
    );
    expect(SRC).toMatch(/JSON\.stringify\(identitySuggestionBody\(type, name, target\)\)/);
  });
});

describe('the identity types the ledger accepts', () => {
  // tools/server/internal/archive/curation/suggestions.go:
  //   identityKinds = {"speaker", "sponsor", "person"}
  // The person drill passes 'person', which is on that list — so the type was
  // never the problem, and no translation is needed here.
  it.each(['person', 'speaker', 'sponsor'])('%s is sent through as-is', (kind) => {
    expect(identitySuggestionBody(kind, 'a', 'b').idType).toBe(kind);
  });
});
