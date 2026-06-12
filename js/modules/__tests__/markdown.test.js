import { describe, it, expect } from 'vitest';
import { applyInlineMarkdown, formatTextBlock } from '../markdown.js';

// ── applyInlineMarkdown ───────────────────────────────────────────────────────

describe('applyInlineMarkdown', () => {
  it('renders ![alt](url) as an img tag', () => {
    const result = applyInlineMarkdown('![cat](https://example.com/cat.jpg)');
    expect(result).toContain('<img src="https://example.com/cat.jpg" alt="cat"');
    expect(result).toContain('loading="lazy"');
  });

  it('renders [text](url) as a link with rel=noopener', () => {
    const result = applyInlineMarkdown('[click](https://example.com)');
    expect(result).toContain('<a href="https://example.com"');
    expect(result).toContain('>click</a>');
    expect(result).toContain('noopener');
  });

  it('renders relative-path links', () => {
    expect(applyInlineMarkdown('[docs](./guide.html)')).toContain('<a href="./guide.html"');
  });

  it('does not render links for bare text without a URL scheme', () => {
    expect(applyInlineMarkdown('[text](not-a-url)')).not.toContain('<a ');
  });

  it('renders `code` as <code>', () => {
    expect(applyInlineMarkdown('`hello`')).toBe('<code>hello</code>');
  });

  it('renders **bold** as <strong>', () => {
    expect(applyInlineMarkdown('**bold**')).toBe('<strong>bold</strong>');
  });

  it('renders __bold__ as <strong>', () => {
    expect(applyInlineMarkdown('__bold__')).toBe('<strong>bold</strong>');
  });

  it('renders *italic* as <em>', () => {
    expect(applyInlineMarkdown('*italic*')).toBe('<em>italic</em>');
  });

  it('renders _italic_ as <em>', () => {
    expect(applyInlineMarkdown('_italic_')).toBe('<em>italic</em>');
  });

  it('handles multiple inline elements in one string', () => {
    const result = applyInlineMarkdown('`code` and **bold** and *em*');
    expect(result).toContain('<code>code</code>');
    expect(result).toContain('<strong>bold</strong>');
    expect(result).toContain('<em>em</em>');
  });

  it('passes plain text through unchanged', () => {
    expect(applyInlineMarkdown('hello world')).toBe('hello world');
  });

  it('does not produce img tags for exclamation marks not followed by markdown syntax', () => {
    expect(applyInlineMarkdown('not an image!')).not.toContain('<img');
  });

  it('returns empty string for empty input', () => {
    expect(applyInlineMarkdown('')).toBe('');
  });

  it('returns empty string for null input', () => {
    expect(applyInlineMarkdown(null)).toBe('');
  });
});

// ── formatTextBlock ───────────────────────────────────────────────────────────

describe('formatTextBlock — empty input', () => {
  it('returns empty string for empty input', () => {
    expect(formatTextBlock('')).toBe('');
    expect(formatTextBlock(null)).toBe('');
    expect(formatTextBlock('   ')).toBe('');
  });
});

describe('formatTextBlock — paragraphs', () => {
  it('wraps plain text in a <p>', () => {
    expect(formatTextBlock('Hello world')).toBe('<p>Hello world</p>');
  });

  it('produces two <p> tags for text separated by a blank line', () => {
    expect(formatTextBlock('First\n\nSecond')).toBe('<p>First</p><p>Second</p>');
  });

  it('joins consecutive non-blank lines within one paragraph with <br>', () => {
    const result = formatTextBlock('Line one\nLine two');
    expect(result).toBe('<p>Line one<br>Line two</p>');
  });

  it('escapes HTML special characters in paragraph content', () => {
    const result = formatTextBlock('<b>not bold</b> & "quotes"');
    expect(result).toContain('&lt;b&gt;');
    expect(result).toContain('&amp;');
    expect(result).toContain('&quot;');
  });
});

describe('formatTextBlock — headings', () => {
  it('renders # as <h1>', () => {
    expect(formatTextBlock('# Title')).toBe('<h1>Title</h1>');
  });

  it('renders ## as <h2>', () => {
    expect(formatTextBlock('## Sub')).toBe('<h2>Sub</h2>');
  });

  it('renders all heading levels h1–h6', () => {
    for (let i = 1; i <= 6; i++) {
      const result = formatTextBlock(`${'#'.repeat(i)} H${i}`);
      expect(result).toBe(`<h${i}>H${i}</h${i}>`);
    }
  });

  it('applies inline markdown inside headings', () => {
    expect(formatTextBlock('## **Bold** heading')).toContain('<strong>Bold</strong>');
  });
});

describe('formatTextBlock — blockquotes', () => {
  it('renders > as <blockquote>', () => {
    const result = formatTextBlock('> A quote');
    expect(result).toContain('<blockquote>');
    expect(result).toContain('A quote');
  });

  it('collects multi-line blockquotes into one block', () => {
    const result = formatTextBlock('> line one\n> line two');
    const matches = result.match(/<blockquote>/g);
    expect(matches).toHaveLength(1);
  });
});

describe('formatTextBlock — lists', () => {
  it('renders - items as <ul><li>', () => {
    const result = formatTextBlock('- item one\n- item two');
    expect(result).toContain('<ul>');
    expect(result).toContain('<li>item one</li>');
    expect(result).toContain('<li>item two</li>');
  });

  it('renders * items as <ul><li>', () => {
    expect(formatTextBlock('* item')).toContain('<ul>');
  });

  it('renders 1. ordered items as <ol><li>', () => {
    const result = formatTextBlock('1. first\n2. second');
    expect(result).toContain('<ol>');
    expect(result).toContain('<li>first</li>');
    expect(result).toContain('<li>second</li>');
  });

  it('renders nested list items as children', () => {
    const result = formatTextBlock('- parent\n  - child');
    expect(result).toContain('<ul>');
    expect(result).toContain('parent');
    expect(result).toContain('child');
    // child list is nested inside the parent li
    expect(result).toMatch(/<li>parent<ul>/);
  });
});

describe('formatTextBlock — code blocks', () => {
  it('wraps fenced content in <pre><code>', () => {
    const result = formatTextBlock('```\nconst x = 1;\n```');
    expect(result).toContain('<pre><code>');
    expect(result).toContain('const x = 1;');
  });

  it('escapes HTML inside code blocks', () => {
    const result = formatTextBlock('```\n<div class="x">\n```');
    expect(result).toContain('&lt;div');
    expect(result).not.toContain('<div');
  });

  it('renders empty code block for triple-backtick with no content', () => {
    const result = formatTextBlock('```\n```');
    expect(result).toContain('<pre><code>');
  });
});

describe('formatTextBlock — tables', () => {
  it('renders a markdown table as <table> with thead and tbody', () => {
    const md = '| Name | Age |\n| --- | --- |\n| Alice | 30 |';
    const result = formatTextBlock(md);
    expect(result).toContain('<table>');
    expect(result).toContain('<thead>');
    expect(result).toContain('<tbody>');
    expect(result).toContain('<th>Name</th>');
    expect(result).toContain('<td>Alice</td>');
  });

  it('pads short rows to the column count', () => {
    const md = '| A | B | C |\n| --- | --- | --- |\n| x | y |';
    const result = formatTextBlock(md);
    // Row has only 2 cells but header has 3 — third cell should be empty td
    expect(result).toContain('<td></td>');
  });
});

describe('formatTextBlock — inline markdown', () => {
  it('applies inline markdown inside paragraphs', () => {
    const result = formatTextBlock('This is **bold**.');
    expect(result).toContain('<strong>bold</strong>');
  });

  it('highlights keywords when the second argument is provided', () => {
    const result = formatTextBlock('Drupal rocks', 'Drupal');
    expect(result).toContain('keyword-highlight');
  });
});
