// The JavaScript half of the cross-language contract.
//
// summarizeSources() has a second implementation in tools/server/sources.go,
// because the catalog is being ported to Go one piece at a time. sources.js
// used to be safe by being the only implementation; it no longer is, so the
// shared fixture below takes over that job. Both suites read the same file, and
// a rule changed in one language fails the other's build.
//
// See tools/server/sources.go and docs/go-port.md.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  attributionStrength,
  sourceConfidence,
  sourceReach,
  summarizeSources,
  waybackTimestampToIso,
} from '../sources.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '../../../../tools/server/testdata/sources-cases.json');

const cases = JSON.parse(readFileSync(FIXTURE, 'utf8'));

describe('summarizeSources — shared contract with tools/server', () => {
  for (const { name, dataset, expected } of cases.summaries) {
    it(name, () => {
      const { kindOrder, ...fields } = expected;
      const summary = summarizeSources(dataset);
      expect(summary).toEqual(fields);
      // Key order is part of the contract, not an implementation detail: the
      // catalog carries `kinds` in first-seen order, and a Go map would
      // otherwise emit it in a random one.
      if (kindOrder) expect(Object.keys(summary.kinds)).toEqual(kindOrder);
    });
  }
});

describe('waybackTimestampToIso — shared contract with tools/server', () => {
  for (const { input, expected } of cases.waybackTimestamps) {
    it(`${JSON.stringify(input)} → ${expected}`, () => {
      expect(waybackTimestampToIso(input)).toBe(expected);
    });
  }
});

describe('sourceConfidence — shared contract with tools/server', () => {
  for (const { source, tier, why } of cases.confidence) {
    it(`${why}`, () => {
      expect(sourceConfidence(source)).toBe(tier);
    });
  }
});

describe('attributionStrength — shared contract with tools/server', () => {
  for (const { record, sources, strength, why } of cases.attribution) {
    it(`${why}`, () => {
      const byId = new Map(sources.map((s) => [s.id, s]));
      expect(attributionStrength(record, byId)).toBe(strength);
    });
  }
});

describe('sourceReach — shared contract with tools/server', () => {
  it('counts every record that cites each source', () => {
    expect(Object.fromEntries(sourceReach(cases.reach.dataset))).toEqual(cases.reach.expected);
  });
});
