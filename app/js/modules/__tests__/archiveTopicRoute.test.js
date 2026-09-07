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
  // The archive now speaks two address forms and reads the live location to
  // decide which — so a path-form expectation has to say it is on a path.
  globalThis.location ??= { pathname: '/archive', search: '', origin: '' };
});

const { topicPath, termFromSlug } = await import('../archiveDashboard.js');

describe('topicPath, served at /archive', () => {
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

describe('topicPath, deployed as plain files', () => {
  // The same view, addressed the way a static host can actually serve it. A
  // host-absolute path here 404s on reload and points a GitHub Pages project
  // site at the wrong origin entirely.
  it('uses the query form and stays relative to the page', () => {
    const was = globalThis.location.pathname;
    globalThis.location.pathname = '/repo/archive.html';
    try {
      expect(topicPath('layout builder', 2025)).toBe(
        './archive.html?topic=layout-builder&year=2025',
      );
    } finally {
      globalThis.location.pathname = was;
    }
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
