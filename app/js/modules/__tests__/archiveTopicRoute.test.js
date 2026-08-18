// A keyword in one year is a page, so it needs an address.
//
// Clicking a point on the topic chart opened a real view and left the URL on
// /archive — refreshing lost it, and there was nothing to send anyone. It is a
// PAIR (term + year), which is why it carries two segments where every other
// drill carries one.
import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => {
  globalThis.document ??= {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
  };
});

const { topicPath, termFromSlug } = await import('../archiveDashboard.js');

describe('topicPath', () => {
  it('addresses a keyword and a year', () => {
    expect(topicPath('layout builder', 2025)).toBe('/archive/topic/layout-builder/2025');
  });

  it('slugifies the term and keeps accents readable', () => {
    expect(topicPath('Gábor Hojtsy', 2019)).toBe('/archive/topic/gabor-hojtsy/2019');
  });

  it('survives punctuation in a custom keyword', () => {
    expect(topicPath('c++', 2020)).toBe('/archive/topic/c/2020');
  });
});

describe('termFromSlug', () => {
  it('recovers the term the archive actually knows', () => {
    // "display suite" and "Display Suite" slugify alike; the known list decides.
    expect(termFromSlug('display-suite', ['Display Suite', 'views'])).toBe('Display Suite');
  });

  it('falls back to the de-slugged text for a keyword nobody pinned', () => {
    expect(termFromSlug('layout-builder', [])).toBe('layout builder');
  });

  it('prefers an exact known term over the fallback', () => {
    expect(termFromSlug('layout-builder', ['layout builder'])).toBe('layout builder');
  });

  it('handles an empty slug without inventing a term', () => {
    expect(termFromSlug('', ['views'])).toBe('');
    expect(termFromSlug(null, [])).toBe('');
  });
});
