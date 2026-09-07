// The JavaScript half of the identity contract.
//
// normName()/fingerprint() decide whether two spellings are the same entity.
// tools/server/identity.go implements the same rule for the Go cluster and
// insights work, and the curation ledger is keyed by the result — so two
// implementations that disagree by one character decide that one person is two.
//
// The shared fixture is what keeps them together: both suites read it, and a
// rule changed in one language fails the other's build.
//
// See tools/server/identity.go and docs/go-port.md.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { fingerprint, normName } from '../archiveAudit.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '../../../tools/server/testdata/identity-cases.json');

const { cases } = JSON.parse(readFileSync(FIXTURE, 'utf8'));

describe('normName / fingerprint — shared contract with tools/server', () => {
  for (const testCase of cases) {
    it(`${JSON.stringify(testCase.input)}${testCase.why ? ` — ${testCase.why}` : ''}`, () => {
      expect(normName(testCase.input)).toBe(testCase.normName);
      expect(fingerprint(testCase.input)).toBe(testCase.fingerprint);
    });
  }
});
