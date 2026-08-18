// Why did THIS session match?
//
// A result row shows title, event, speakers and location — so a match inside the
// description is invisible. "Wrap Up Ceremony" came back for `ai` because its
// description reads "join our mailing list", and nothing on the row said so; it
// read as a broken search. The match is marked now, and a row whose own text
// does not explain itself carries a snippet of the matched context.
import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => {
  globalThis.document ??= {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
  };
});

const { matchRanges, highlightHtml, matchSnippet } = await import('../archiveDashboard.js');

describe('matchRanges', () => {
  it('finds every occurrence of a substring match', () => {
    expect(matchRanges('ai and more ai', ['ai'])).toEqual([
      [0, 2],
      [12, 14],
    ]);
  });

  it('respects word boundaries in exact mode', () => {
    expect(matchRanges('we maintain the site', ['ai'], 'exact')).toEqual([]);
    expect(matchRanges('all about ai today', ['ai'], 'exact')).toEqual([[10, 12]]);
  });

  it('marks a phrase across whatever punctuation separates it', () => {
    expect(matchRanges('Using Display-Suite well', ['display suite'], 'exact')).toEqual([[6, 19]]);
  });

  it('merges overlapping hits so two terms cannot double-shade a word', () => {
    expect(matchRanges('ai tools', ['ai', 'ai tools'])).toEqual([[0, 8]]);
  });

  it('finds adjacent repeats without skipping one', () => {
    expect(matchRanges('aiai', ['ai'])).toEqual([[0, 4]]);
  });
});

describe('highlightHtml', () => {
  it('marks the match and escapes everything', () => {
    expect(highlightHtml('AI & you', ['ai'])).toBe('<mark class="obs-hl">AI</mark> &amp; you');
  });

  it('escapes text that could otherwise inject markup', () => {
    const out = highlightHtml('<script>ai</script>', ['ai']);
    expect(out).not.toContain('<script>');
    expect(out).toContain('<mark class="obs-hl">ai</mark>');
  });

  it('escapes a match that arrives before an entity, keeping offsets honest', () => {
    // Searching HTML would have shifted every index past the &amp;.
    expect(highlightHtml('A & ai', ['ai'])).toBe('A &amp; <mark class="obs-hl">ai</mark>');
  });

  it('returns plain escaped text when nothing matched', () => {
    expect(highlightHtml('nothing here', ['ai'], 'exact')).toBe('nothing here');
  });
});

describe('matchSnippet', () => {
  it('quotes the matched context and marks the hit', () => {
    const s = matchSnippet('Join our mailing list to keep up to date on future events.', ['ai']);
    expect(s).toContain('<mark class="obs-hl">ai</mark>');
    expect(s).toContain('m');
  });

  it('is empty when the text does not match — the row then says nothing', () => {
    expect(matchSnippet('Join our mailing list', ['ai'], 'exact')).toBe('');
    expect(matchSnippet('', ['ai'])).toBe('');
  });

  it('ellipses only the ends it actually cut', () => {
    const long = `${'x '.repeat(60)}ai${' y'.repeat(60)}`;
    const s = matchSnippet(long, ['ai']);
    expect(s.startsWith('…')).toBe(true);
    expect(s.endsWith('…')).toBe(true);
    expect(matchSnippet('ai now', ['ai']).startsWith('…')).toBe(false);
  });
});
