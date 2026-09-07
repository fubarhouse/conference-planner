// The decisions log: the half of the curation desk that makes a decision
// reversible. These cover the pure layer — which rows exist, which ones a search
// keeps, and what a row says a decision covers.
import { describe, it, expect, beforeAll } from 'vitest';

// curation.js resolves DOM nodes at module scope on import.
beforeAll(() => {
  globalThis.document ??= { getElementById: () => null, querySelector: () => null };
});

const { decisionRows, filterDecisionRows, impactText } = await import('../curation.js');

const decisions = {
  aliases: { 'kim pepper': 'Kim Pepper', fubarhouse: 'Karl Hepworth' },
  distinct: ['john smith'],
};
const impact = {
  'kim pepper': {
    variants: ['Kim Pepper', 'kim.pepper'],
    talks: 15,
    sponsorships: 0,
    credits: 1,
    events: 16,
    roles: ['volunteer'],
  },
  fubarhouse: { variants: ['fubarhouse'], talks: 1, credits: 0, events: 1, roles: [] },
  'john smith': { variants: ['John Smith', 'john smith'], talks: 4, events: 3, roles: [] },
};

describe('decisionRows', () => {
  it('lists every recorded decision, aliases and distincts alike', () => {
    // The log used to render only once every cluster had been reviewed, so 193
    // decisions showed as "No decisions yet". Every decision is a row from the
    // moment it is made.
    expect(decisionRows(decisions, impact)).toHaveLength(3);
    expect(decisionRows(decisions, impact).map((r) => r.type)).toEqual([
      'alias',
      'alias',
      'distinct',
    ]);
  });

  it('labels a row with the spellings, not the fingerprint', () => {
    // The stored key is `kim pepper` — a word-sorted, lowercased fingerprint. It
    // is the right identity and the wrong thing to read.
    const [kim] = decisionRows(decisions, impact);
    expect(kim.from).toBe('kim.pepper');
    expect(kim.canonical).toBe('Kim Pepper');
    expect(kim.key).toBe('kim pepper'); // still the undo handle
  });

  it('drops the canonical from the "from" side, so a row is not a tautology', () => {
    const [kim] = decisionRows(decisions, impact);
    expect(kim.variants).not.toContain('Kim Pepper');
  });

  it('falls back to the key when the archive no longer carries the spelling', () => {
    const [row] = decisionRows({ aliases: { 'gone away': 'Someone' } }, {});
    expect(row.from).toBe('gone away');
  });

  it('survives a payload with no impact at all', () => {
    expect(decisionRows(decisions)).toHaveLength(3);
    expect(decisionRows({})).toEqual([]);
  });
});

describe('filterDecisionRows', () => {
  const rows = decisionRows(decisions, impact);

  it('returns everything for an empty filter', () => {
    expect(filterDecisionRows(rows, '')).toHaveLength(3);
    expect(filterDecisionRows(rows, '   ')).toHaveLength(3);
  });

  it('matches EITHER side of the mapping', () => {
    // You look for a decision by whichever name you remember.
    expect(filterDecisionRows(rows, 'kim.pepper')).toHaveLength(1); // the variant
    expect(filterDecisionRows(rows, 'Kim Pepper')).toHaveLength(1); // the canonical
    expect(filterDecisionRows(rows, 'karl')).toHaveLength(1); // target only
  });

  it('matches the fingerprint underneath too', () => {
    expect(filterDecisionRows(rows, 'john smith')).toHaveLength(1);
  });

  it('ignores case and finds substrings', () => {
    expect(filterDecisionRows(rows, 'PEPPER')).toHaveLength(1);
    expect(filterDecisionRows(rows, 'hep')).toHaveLength(1);
  });

  it('says nothing rather than everything when nothing matches', () => {
    expect(filterDecisionRows(rows, 'zzzz')).toEqual([]);
  });
});

describe('impactText', () => {
  it('names the populations a mapping reaches', () => {
    // `kim pepper → Kim Pepper` does not tell you it merged a conference speaker
    // with an event volunteer. This line does, which is what makes undo a choice.
    expect(impactText(impact['kim pepper'])).toBe('15 talks · 1 volunteer credit · 16 events');
  });

  it('singularises, because a row that reads "1 talks" reads as a bug', () => {
    expect(impactText(impact.fubarhouse)).toBe('1 talk · 1 event');
  });

  it('omits populations a decision does not touch', () => {
    expect(impactText({ sponsorships: 6, events: 6 })).toBe('6 sponsorships · 6 events');
  });

  it('says so plainly when a decision covers nothing any more', () => {
    expect(impactText({})).toMatch(/Nothing in the archive/);
    expect(impactText()).toMatch(/Nothing in the archive/);
  });
});
