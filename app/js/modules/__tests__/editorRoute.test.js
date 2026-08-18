// The editor's address holds the record being edited.
//
// `?tab=sponsors` restored the workspace but not the dataset, so a refresh — or
// a link sent to someone — opened an empty editor on the right tab.
import { describe, it, expect } from 'vitest';
import { editorPath, parseEditorPath } from '../editorRoute.js';

const TABS = ['event', 'people', 'sessions', 'sponsors', 'timeline', 'logo'];

describe('editorPath', () => {
  it('drops the implied events/ prefix and the extension', () => {
    expect(editorPath('events/drupalsouth/2025-melbourne.json', 'sponsors', TABS)).toBe(
      '/editor/drupalsouth/2025-melbourne/sponsors',
    );
  });

  it('keeps a nested dataset path intact', () => {
    expect(editorPath('events/drupalsouth/community-day/2025-canberra.json', 'people', TABS)).toBe(
      '/editor/drupalsouth/community-day/2025-canberra/people',
    );
  });

  it('omits the tab when there is none, or when it is not a real workspace', () => {
    expect(editorPath('events/ddd/2025-leuven.json', '', TABS)).toBe('/editor/ddd/2025-leuven');
    expect(editorPath('events/ddd/2025-leuven.json', 'nonsense', TABS)).toBe(
      '/editor/ddd/2025-leuven',
    );
  });

  it('falls back to the bare editor with no dataset open', () => {
    expect(editorPath('', 'sessions', TABS)).toBe('/editor');
    expect(editorPath(null, 'sessions', TABS)).toBe('/editor');
  });

  it('escapes a segment rather than letting it break the path', () => {
    expect(editorPath('events/a b/c?d.json', 'event', TABS)).toBe('/editor/a%20b/c%3Fd/event');
  });
});

describe('parseEditorPath', () => {
  it('reads back what editorPath wrote', () => {
    const file = 'events/drupalcon/eu/2025-vienna.json';
    for (const tab of TABS) {
      expect(parseEditorPath(editorPath(file, tab, TABS), TABS)).toEqual({ file, tab });
    }
  });

  it('restores the implied events/ prefix', () => {
    expect(parseEditorPath('/editor/ddd/2026-athens/sessions', TABS)).toEqual({
      file: 'events/ddd/2026-athens.json',
      tab: 'sessions',
    });
  });

  it('accepts a path that names events/ explicitly', () => {
    expect(parseEditorPath('/editor/events/ddd/2026-athens/sessions', TABS)).toEqual({
      file: 'events/ddd/2026-athens.json',
      tab: 'sessions',
    });
  });

  it('treats a trailing non-tab segment as part of the dataset', () => {
    expect(parseEditorPath('/editor/drupalcamp/pune/2025', TABS)).toEqual({
      file: 'events/drupalcamp/pune/2025.json',
      tab: '',
    });
  });

  it('reports no dataset for the bare editor', () => {
    expect(parseEditorPath('/editor', TABS)).toEqual({ file: '', tab: '' });
    expect(parseEditorPath('/editor/', TABS)).toEqual({ file: '', tab: '' });
    expect(parseEditorPath('/editor/sponsors', TABS)).toEqual({ file: '', tab: 'sponsors' });
  });

  it('ignores a path that is not the editor at all', () => {
    expect(parseEditorPath('/archive/person/karl-hepworth', TABS)).toEqual({ file: '', tab: '' });
    expect(parseEditorPath('', TABS)).toEqual({ file: '', tab: '' });
  });

  it('decodes escaped segments', () => {
    expect(parseEditorPath('/editor/a%20b/c/event', TABS)).toEqual({
      file: 'events/a b/c.json',
      tab: 'event',
    });
  });

  it('survives a malformed escape instead of throwing during boot', () => {
    expect(() => parseEditorPath('/editor/%E0%A4%A/event', TABS)).not.toThrow();
  });
});
