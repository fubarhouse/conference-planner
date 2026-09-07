import { describe, expect, it, vi } from 'vitest';

// Node env, no jsdom: the panel's render/wire functions bail on a missing
// element, so a stub that returns null exercises the guards without a DOM.
globalThis.document ??= { getElementById: () => null, querySelector: () => null };

const { initSources, inputPreview, renderSourcesEditor, sourceLabel, wireSourcesPanel } =
  await import('../editorSources.js');

const CAPTURE =
  'https://web.archive.org/web/20130826155852/http://lanyrd.com/2013/drupalgov/schedule/';

describe('inputPreview — telling the editor what will happen before it does', () => {
  it('announces that a wayback paste will be split into original + capture', () => {
    const preview = inputPreview(CAPTURE);
    expect(preview.tone).toBe('wayback');
    expect(preview.message).toContain('http://lanyrd.com/2013/drupalgov/schedule/');
  });

  it('calls a plain url a link', () => {
    expect(inputPreview('https://drupaljam.nl/program').tone).toBe('url');
  });

  it('warns that free text becomes a stated source shown to readers', () => {
    const preview = inputPreview('Reported by the organisers at the closing session');
    expect(preview.tone).toBe('stated');
    expect(preview.message).toMatch(/shown to readers/);
  });

  it('says nothing for an empty field', () => {
    expect(inputPreview('   ')).toEqual({ tone: 'empty', message: '' });
  });
});

describe('sourceLabel', () => {
  it('prefers an explicit title', () => {
    expect(sourceLabel({ title: 'DrupalJam programme', url: 'https://a.test/x' })).toBe(
      'DrupalJam programme',
    );
  });

  it('falls back to a readable host + path', () => {
    expect(sourceLabel({ url: 'https://www.drupaljam.nl/program/community-day' })).toBe(
      'drupaljam.nl/program/community-day',
    );
  });

  it('shows the statement for a stated source', () => {
    expect(sourceLabel({ id: 's', title: 'Told at close', via: { provider: 'stated' } })).toBe(
      'Told at close',
    );
  });

  it('does not throw on a malformed url', () => {
    expect(sourceLabel({ id: 's', url: 'not a url' })).toBe('not a url');
  });
});

describe('panel functions survive a missing DOM', () => {
  it('renders and wires without a container rather than throwing', () => {
    initSources({
      state: { dataset: { event: {} } },
      markDirty: vi.fn(),
      escapeHtml: (s) => s,
      escapeAttr: (s) => s,
    });
    expect(() => renderSourcesEditor()).not.toThrow();
    expect(() => wireSourcesPanel()).not.toThrow();
  });

  it('does not create a sources array on a dataset that is not loaded', () => {
    const state = { dataset: null };
    initSources({ state, markDirty: vi.fn(), escapeHtml: (s) => s, escapeAttr: (s) => s });
    expect(() => renderSourcesEditor()).not.toThrow();
    expect(state.dataset).toBeNull();
  });
});
