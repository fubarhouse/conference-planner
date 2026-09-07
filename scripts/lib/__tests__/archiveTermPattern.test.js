// The keyword chart matches whole words, and only whole words.
//
// A line plotted over twenty years is read as a trend, so a substring match is
// not a looser answer but a wrong one: "ai" inside "maintain" and "email" would
// draw a line about nothing. Unlike the session search, this surface offers no
// "contains" option — there are no rows to eyeball, only a shape.
import { describe, it, expect } from 'vitest';
import { termPattern } from '../archiveInsights.js';

const hits = (term, text) => termPattern(term)?.test(text) ?? false;

describe('termPattern', () => {
  it('matches a word, not a fragment of one', () => {
    expect(hits('ai', 'All about AI')).toBe(true);
    expect(hits('ai', 'How we maintain the site')).toBe(false);
    expect(hits('ai', 'sent by email')).toBe(false);
    expect(hits('ai', 'sitting in a chair')).toBe(false);
  });

  it('treats a multi-word term as a phrase across any separator', () => {
    expect(hits('layout builder', 'Using Layout Builder well')).toBe(true);
    expect(hits('layout builder', 'Using Layout-Builder well')).toBe(true);
    expect(hits('layout builder', 'layoutbuilder')).toBe(false);
    expect(hits('layout builder', 'the builder of layouts')).toBe(false);
  });

  it('keeps + and # inside a word, so "c++" and "c#" are terms', () => {
    expect(hits('c++', 'Extending Drupal with C++')).toBe(true);
    expect(hits('c#', 'A C# perspective')).toBe(true);
    // And "c" alone is not "c++".
    expect(hits('c++', 'the C language')).toBe(false);
  });

  it('counts accented letters as word characters', () => {
    // ASCII classes split "gábor" into "g" + separator + "bor", which matched the
    // name by accident and would have matched "g bor" too.
    expect(hits('gábor', 'a talk by Gábor')).toBe(true);
    expect(hits('gábor', 'g bor')).toBe(false);
    expect(hits('café', 'meet at the café')).toBe(true);
    expect(hits('caf', 'meet at the café')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(hits('drupal', 'DRUPAL and you')).toBe(true);
  });

  it('escapes regex metacharacters in the term', () => {
    expect(hits('a.b', 'a.b')).toBe(true);
    expect(hits('a.b', 'axb')).toBe(false);
  });

  it('returns null for a term with no word characters', () => {
    expect(termPattern('')).toBe(null);
    expect(termPattern('---')).toBe(null);
    expect(termPattern(null)).toBe(null);
  });
});
