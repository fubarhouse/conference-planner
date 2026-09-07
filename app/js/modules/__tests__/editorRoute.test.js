// The editor's address holds the record being edited.
//
// `?tab=sponsors` restored the workspace but not the dataset, so a refresh — or
// a link sent to someone — opened an empty editor on the right tab.
//
// It now speaks two forms, like the other three sections: the path form when
// served, and `./editor.html?file=…&tab=…` as plain files. This module was the
// last one writing `/editor/...` unconditionally — an address a static host
// cannot serve, so the open dataset could not survive a reload there at all.
import { describe, it, expect } from 'vitest';
import { editorPath, parseEditorPath, usePathRouting } from '../editorRoute.js';

const TABS = ['event', 'people', 'sessions', 'sponsors', 'timeline', 'logo'];
const SERVED = { pathRouting: true };

describe('usePathRouting', () => {
  it('is true only for the served section address', () => {
    expect(usePathRouting('/editor')).toBe(true);
    expect(usePathRouting('/editor/ddd/2025-leuven/sessions')).toBe(true);
    expect(usePathRouting('/editor.html')).toBe(false);
    expect(usePathRouting('/repo/editor.html')).toBe(false);
  });
});

describe('editorPath, served', () => {
  it('drops the implied events/ prefix and the extension', () => {
    expect(editorPath('events/drupalsouth/2025-melbourne.json', 'sponsors', TABS, SERVED)).toBe(
      '/editor/drupalsouth/2025-melbourne/sponsors',
    );
  });

  it('keeps a nested dataset path intact', () => {
    expect(
      editorPath('events/drupalsouth/community-day/2025-canberra.json', 'people', TABS, SERVED),
    ).toBe('/editor/drupalsouth/community-day/2025-canberra/people');
  });

  it('omits the tab when there is none, or when it is not a real workspace', () => {
    expect(editorPath('events/ddd/2025-leuven.json', '', TABS, SERVED)).toBe(
      '/editor/ddd/2025-leuven',
    );
    expect(editorPath('events/ddd/2025-leuven.json', 'nonsense', TABS, SERVED)).toBe(
      '/editor/ddd/2025-leuven',
    );
  });

  it('falls back to the bare editor with no dataset open', () => {
    expect(editorPath('', 'sessions', TABS, SERVED)).toBe('/editor');
    expect(editorPath(null, 'sessions', TABS, SERVED)).toBe('/editor');
  });

  it('escapes a segment rather than letting it break the path', () => {
    expect(editorPath('events/a b/c?d.json', 'event', TABS, SERVED)).toBe(
      '/editor/a%20b/c%3Fd/event',
    );
  });
});

describe('parseEditorPath', () => {
  it('reads back what editorPath wrote', () => {
    const file = 'events/drupalcon/eu/2025-vienna.json';
    for (const tab of TABS) {
      expect(parseEditorPath(editorPath(file, tab, TABS, SERVED), TABS)).toEqual({ file, tab });
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

describe('editorPath, deployed as plain files', () => {
  // A host-absolute /editor/... is an address a static host cannot serve, so
  // the dataset was lost on every reload.
  it('addresses its own page and carries the dataset in the query', () => {
    expect(
      editorPath('events/ddd/2025-leuven.json', 'sessions', TABS, { pathRouting: false }),
    ).toBe('./editor.html?file=ddd%2F2025-leuven&tab=sessions');
  });

  it('falls back to the bare page with no dataset open', () => {
    expect(editorPath('', '', TABS, { pathRouting: false })).toBe('./editor.html');
  });

  it('round-trips through the query form', () => {
    const file = 'events/drupalcon/eu/2025-vienna.json';
    for (const tab of TABS) {
      const href = editorPath(file, tab, TABS, { pathRouting: false });
      const search = href.slice(href.indexOf('?'));
      expect(parseEditorPath('/repo/editor.html', TABS, search)).toEqual({ file, tab });
    }
  });
});
