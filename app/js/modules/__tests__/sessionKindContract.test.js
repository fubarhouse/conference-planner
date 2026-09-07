// The JavaScript half of the sessionKind cross-language contract.
//
// tools/server/sessionkind.go implements the same rule for the Go coverage
// report. The fixture below is shared by both suites, so the vocabulary and the
// precedence between `kind`, `isAgendaItem` and the title heuristic cannot drift
// in one language without failing the other.
//
// See tools/server/sessionkind.go and docs/go-port.md.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { countsAsSession, isAgendaTitle, itemKind } from '../sessionKind.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '../../../../tools/server/testdata/session-kind-cases.json');

const cases = JSON.parse(readFileSync(FIXTURE, 'utf8'));

describe('isAgendaTitle — shared contract with tools/server', () => {
  for (const { title, agenda, why } of cases.agendaTitles) {
    it(`${JSON.stringify(title)} → ${agenda}${why ? ` (${why})` : ''}`, () => {
      expect(isAgendaTitle(title)).toBe(agenda);
    });
  }
});

describe('itemKind / countsAsSession — shared contract with tools/server', () => {
  for (const { item, kind, counts, why } of cases.kinds) {
    it(`${JSON.stringify(item)} → ${kind}${why ? ` (${why})` : ''}`, () => {
      expect(itemKind(item)).toBe(kind);
      expect(countsAsSession(item)).toBe(counts);
    });
  }
});
