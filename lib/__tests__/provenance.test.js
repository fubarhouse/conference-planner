import { describe, it, expect } from 'vitest';
import { provenanceHtml, injectProvenance, PLACEHOLDER, ALMANAC_HOME } from '../provenance.js';

// These are not style assertions. The notice exists to state, plainly, what this
// archive is and is not — so each claim gets a test, and an edit that quietly
// drops one fails here instead of shipping.
describe('the provenance notice', () => {
  const html = provenanceHtml();

  it('says the data came from the organisers own public communications', () => {
    expect(html).toMatch(/published by its organisers/i);
    expect(html).toMatch(/the event's own communications/i);
  });

  it('says it is not official', () => {
    expect(html).toMatch(/not an official source/i);
  });

  it('says it is not authoritative', () => {
    expect(html).toMatch(/not authoritative/i);
  });

  it('says it is not endorsed, and by whom', () => {
    expect(html).toMatch(/not endorsed by any\s+event, organiser, speaker or sponsor/i);
  });

  it('defers to the organiser where the two disagree', () => {
    expect(html).toMatch(/the organiser is right/i);
  });

  it('offers a route to correction or removal', () => {
    expect(html).toMatch(/corrected or removed/i);
    expect(html).toContain(ALMANAC_HOME);
  });

  it('puts the disclaimers in the one bold sentence, so a skim catches them', () => {
    // Prettier wraps long tags as `<strong\n  >text</strong\n>`, so both the
    // open and close can carry whitespace before the bracket.
    const bold = html.match(/<strong\b[^>]*>([\s\S]*?)<\/strong\s*>/i)?.[1] || '';
    expect(bold).toMatch(/not an official source/i);
    expect(bold).toMatch(/not authoritative/i);
    expect(bold).toMatch(/not endorsed/i);
  });

  it('makes the link text and its destination agree', () => {
    // They did not: the substitution used to pattern-match the markup, and the
    // formatter wraps long tags across lines, so the href changed while the
    // visible label still named the old domain.
    const href = html.match(/app-provenance__link" href="([^"]+)"/)?.[1];
    const label = html.match(/app-provenance__link"[^>]*>([^<]+)</)?.[1];
    expect(href).toBe(ALMANAC_HOME);
    expect(href).toContain(label);
  });

  it('leaves no unsubstituted tokens', () => {
    expect(html).not.toMatch(/\{\{\w+\}\}/);
  });

  it('does not name the product — the rename must not invalidate it', () => {
    expect(html).not.toMatch(/Conference Almanac|Programme|Conference Planner/);
  });

  it('ships no authoring comment to the reader', () => {
    expect(html).not.toContain('<!--');
  });
});

describe('injectProvenance', () => {
  it('replaces the marker', () => {
    const out = injectProvenance(`<footer>${PLACEHOLDER}</footer>`);
    expect(out).not.toContain(PLACEHOLDER);
    expect(out).toContain('app-provenance');
  });

  it('leaves a page without the marker untouched', () => {
    const page = '<footer>nothing here</footer>';
    expect(injectProvenance(page)).toBe(page);
  });
});
