// A breakdown row is a SHARE, not a bare tally.
//
// The counts were read as "results on the page" and did not survive the
// comparison: the list is capped at 200 while the tallies count every match, so
// a speaker with 55 matching sessions appeared twice in the visible list and the
// number looked wrong. Each row now carries the size of its bucket in the
// searched scope, which is the denominator that makes the count mean something.
import { describe, it, expect } from 'vitest';
import { rankTally, speakerNames, matchesTerm } from '../archiveSessions.js';

describe('rankTally', () => {
  it('pairs each count with its bucket total', () => {
    expect(rankTally({ 'Gábor Hojtsy': 55 }, { 'Gábor Hojtsy': 57 })).toEqual([
      { name: 'Gábor Hojtsy', count: 55, total: 57 },
    ]);
  });

  it('ranks by matches descending — the subject is what was searched for', () => {
    const rows = rankTally(
      { DrupalCon: 3490, DrupalSouth: 497, DrupalJam: 97 },
      { DrupalCon: 5149, DrupalSouth: 772, DrupalJam: 188 },
    );
    expect(rows.map((r) => r.name)).toEqual(['DrupalCon', 'DrupalSouth', 'DrupalJam']);
  });

  it('does not let a high share outrank a high count', () => {
    // 3 of 3 is a perfect share and still a smaller contribution than 40 of 900.
    const rows = rankTally({ big: 40, tiny: 3 }, { big: 900, tiny: 3 });
    expect(rows[0].name).toBe('big');
  });

  it('breaks ties by name, so equal counts do not shuffle between requests', () => {
    // These used to follow file-read order, which is stable only by accident.
    const rows = rankTally({ zeta: 3, alpha: 3, mid: 3 });
    expect(rows.map((r) => r.name)).toEqual(['alpha', 'mid', 'zeta']);
  });

  it('falls back to the count when a bucket has no total', () => {
    // total === count renders as a plain number, not "3 of 3".
    expect(rankTally({ solo: 3 })).toEqual([{ name: 'solo', count: 3, total: 3 }]);
  });

  it('applies the limit after ranking, not before', () => {
    const rows = rankTally({ a: 1, b: 9, c: 5 }, {}, 2);
    expect(rows.map((r) => r.name)).toEqual(['b', 'c']);
  });

  it('survives empty input', () => {
    expect(rankTally(null)).toEqual([]);
    expect(rankTally({}, {}, 5)).toEqual([]);
  });
});

describe('speakerNames', () => {
  it('splits the dataset’s comma-joined list and trims', () => {
    expect(speakerNames('Karl Hepworth, Gábor Hojtsy')).toEqual(['Karl Hepworth', 'Gábor Hojtsy']);
  });

  it('drops empties rather than counting a blank speaker', () => {
    expect(speakerNames('a,, b ,')).toEqual(['a', 'b']);
    expect(speakerNames('')).toEqual([]);
    expect(speakerNames(null)).toEqual([]);
  });
});

describe('matchesTerm', () => {
  it('contains is substring matching — the original rule, and the default', () => {
    expect(matchesTerm('How we maintain the site', 'ai')).toBe(true);
    expect(matchesTerm('Building with Display Suite', 'display suite', 'contains')).toBe(true);
  });

  it('exact matches whole words only', () => {
    // The reported case: "ai" is a subject, not a fragment of "maintain".
    expect(matchesTerm('How we maintain the site', 'ai', 'exact')).toBe(false);
    expect(matchesTerm('Artificial intelligence (AI) in Drupal', 'ai', 'exact')).toBe(true);
  });

  it('exact still matches a phrase across its words', () => {
    expect(matchesTerm('Building with Display Suite', 'display suite', 'exact')).toBe(true);
    expect(matchesTerm('Display and suite are apart', 'display suite', 'exact')).toBe(false);
  });

  it('treats punctuation as a boundary, not as part of the word', () => {
    for (const text of ['End-to-end AI, tested', 'What is “ai”?', 'AI: the talk', 'x/ai/y'])
      expect(matchesTerm(text, 'ai', 'exact'), text).toBe(true);
  });

  it('does not match a word that merely starts or ends with the term', () => {
    expect(matchesTerm('AImaker and Thai food', 'ai', 'exact')).toBe(false);
  });

  it('is case-insensitive in both modes', () => {
    expect(matchesTerm('DRUPAL Canvas', 'canvas', 'exact')).toBe(true);
    expect(matchesTerm('DRUPAL Canvas', 'canvas', 'contains')).toBe(true);
  });
});
