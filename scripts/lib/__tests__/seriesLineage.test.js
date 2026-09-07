// Series lineage — "this conference was part of that series".
//
// What an event was CALLED and what it BELONGED TO are different facts, and the
// dataset only records the first. These map the second, per event, in the same
// private ledger as the identity decisions — so the assertions that matter are
// that it round-trips, that clearing is an absence rather than a stored "none",
// and that it never disturbs the decisions already in the ledger.
import { describe, it, expect } from 'vitest';
import {
  parseDecisions,
  serializeDecisions,
  applyDecision,
  dropDecision,
} from '../archiveAudit.js';

const SOUTH_2011 = 'events/drupalsouth/2011-brisbane.json';
const GOV_2020 = 'events/drupalgovau/2020-online.json';

describe('series lineage in the ledger', () => {
  it('records which series an event belongs to', () => {
    const next = applyDecision(parseDecisions('{}'), {
      type: 'series',
      key: SOUTH_2011,
      canonical: 'DrupalSouth',
    });
    expect(next.series).toEqual({ [SOUTH_2011]: 'DrupalSouth' });
  });

  it('round-trips through serialize/parse', () => {
    const one = applyDecision(parseDecisions('{}'), {
      type: 'series',
      key: GOV_2020,
      canonical: 'DrupalSouth',
    });
    expect(parseDecisions(serializeDecisions(one)).series).toEqual({ [GOV_2020]: 'DrupalSouth' });
  });

  it('clears by storing nothing, not a "none" value', () => {
    // Most of the archive belongs to no wider series. That is an absence, and
    // storing a sentinel for it would put every event in the ledger.
    const set = applyDecision(parseDecisions('{}'), {
      type: 'series',
      key: GOV_2020,
      canonical: 'DrupalSouth',
    });
    const cleared = applyDecision(set, { type: 'series', key: GOV_2020, canonical: '' });
    expect(cleared.series).toEqual({});
    expect(GOV_2020 in cleared.series).toBe(false);
  });

  it('drops one mapping without touching the others', () => {
    let d = parseDecisions('{}');
    d = applyDecision(d, { type: 'series', key: SOUTH_2011, canonical: 'DrupalSouth' });
    d = applyDecision(d, { type: 'series', key: GOV_2020, canonical: 'DrupalSouth' });
    const after = dropDecision(d, { type: 'series', key: GOV_2020 });
    expect(after.series).toEqual({ [SOUTH_2011]: 'DrupalSouth' });
  });

  it('leaves identity and coverage decisions alone', () => {
    // One ledger, four kinds. A lineage edit must not disturb reconciliation
    // work, which is slow and human and cannot be redone from anywhere.
    let d = parseDecisions('{}');
    d = applyDecision(d, { type: 'alias', key: 'gabor hojtsy', canonical: 'Gábor Hojtsy' });
    d = applyDecision(d, { type: 'distinct', key: 'two different people' });
    d = applyDecision(d, { type: 'coverage', key: 'x.json::venue', state: 'snoozed' });
    const before = JSON.stringify({ a: d.aliases, x: d.distinct, s: d.snoozes });

    d = applyDecision(d, { type: 'series', key: SOUTH_2011, canonical: 'Drupal Down Under' });
    d = dropDecision(d, { type: 'series', key: SOUTH_2011 });

    expect(JSON.stringify({ a: d.aliases, x: d.distinct, s: d.snoozes })).toBe(before);
  });

  it('survives a ledger written before series existed', () => {
    const legacy = '{"aliases":{"a":"A"},"distinct":["b"],"snoozes":{}}';
    const d = parseDecisions(legacy);
    expect(d.series).toEqual({});
    expect(d.aliases).toEqual({ a: 'A' });
  });

  it('refuses a non-object series, including an array', () => {
    // `typeof [] === 'object'`, so an array would otherwise survive and break
    // every lookup done against it.
    expect(parseDecisions('{"series":[]}').series).toEqual({});
    expect(parseDecisions('{"series":7}').series).toEqual({});
    expect(parseDecisions('{"series":null}').series).toEqual({});
  });
});
