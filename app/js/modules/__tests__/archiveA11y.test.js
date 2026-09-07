// The archive was built as an overlay inside the editor and later became a page
// of its own. Most of its accessibility defects come from that move: behaviour
// that was correct for a modal is wrong for a <main>.
//
// The worst of them: Escape called closeObservatory(), which added `.hidden` to
// #archiveObservatory. In the editor that dismissed an overlay. On the archive
// page #archiveObservatory IS the page, the .obs-close button it was written for
// no longer exists in any markup, and Escape was its only caller — so one
// keystroke, anywhere, emptied the screen with no way back.
//
// Source-level, like the other archive suites: these handlers bind to live DOM
// and there is no jsdom here.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, '..', 'archiveDashboard.js'), 'utf8');
const RAIL = readFileSync(join(here, '..', 'rail.js'), 'utf8');
const HTML = readFileSync(join(here, '..', '..', '..', 'archive.html'), 'utf8');

describe('Escape cannot hide the page', () => {
  it('has no closeObservatory to call', () => {
    expect(SRC).not.toMatch(/export function closeObservatory/);
    expect(SRC).not.toMatch(/\$\('archiveObservatory'\)\?\.classList\.add\('hidden'\)/);
  });

  it('does not bind Escape to hiding the studio', () => {
    expect(SRC).not.toMatch(/e\.key === 'Escape'\) closeObservatory/);
  });

  it('leaves the studio as the page it is — no scroll lock', () => {
    // #archiveObservatory is <main> on archive.html; locking body scroll locked
    // the page, and archive.js had been undoing it on the very next line.
    expect(HTML).toMatch(/<main id="archiveObservatory"/);
    expect(SRC).not.toMatch(/document\.body\.style\.overflow = 'hidden'/);
  });
});

describe('everything clickable is reachable from the keyboard', () => {
  // WCAG 2.1.1. The archive is full of rows and bars that are buttons in
  // behaviour and divs in markup; each needs a role, a tab stop, and Enter/Space.
  const clickTargets = [...SRC.matchAll(/closest\('\[([a-zA-Z-]+)\]'\)/g)].map((m) => m[1]);

  it('finds the click targets it is meant to be guarding', () => {
    expect(clickTargets.length).toBeGreaterThanOrEqual(15);
  });

  it.each([...new Set(clickTargets)])(
    'every non-button carrying [%s] has role + tabindex',
    (attr) => {
      const tagRe = new RegExp(`<(\\w+)([^>]*\\b${attr}=[^>]*)>`, 'g');
      for (const m of SRC.matchAll(tagRe)) {
        const [, tag, attrs] = m;
        // Real interactive elements are already keyboard-operable.
        if (['button', 'a', 'input', 'select', 'form', 'textarea'].includes(tag)) continue;
        // Assert on the WHOLE tag — these are long template strings and the
        // attributes are conditional, so role/tabindex often sit well past the
        // start of it.
        const line = SRC.slice(0, m.index).split('\n').length;
        const where = `${tag}[${attr}] at line ${line}`;
        expect(attrs, where).toMatch(/role=/);
        expect(attrs, where).toMatch(/tabindex/);
      }
    },
  );

  it('forwards Enter and Space to any element standing in for a button', () => {
    // This used to name [data-source-event] specifically, so it fixed exactly
    // one of them and left the rest focusable but inert — worse than not being
    // focusable at all.
    expect(SRC).toMatch(/closest\?\.\('\[role="button"\]'\)/);
    expect(SRC).toMatch(/row\.tagName === 'BUTTON'/);
  });
});

describe('the rail is a named region the keyboard can find', () => {
  it('takes a role before it takes a name', () => {
    // aria-label on a role-less div is not reliably exposed: the panel had a
    // name nothing would read.
    expect(RAIL).toMatch(/setAttribute\('role', 'region'\)/);
    expect(RAIL).toMatch(/setAttribute\('aria-label', label\)/);
  });

  it('is NOT a dialog', () => {
    // Twice wrong: the panel is not modal, and the planner's modal skin keys
    // every rule off [role="dialog"] — so calling it one painted a 45%-ink
    // scrim over the rail.
    expect(RAIL).not.toMatch(/'role', 'dialog'/);
  });

  it('moves focus into the panel when it opens', () => {
    // Otherwise it opens somewhere later in the tab order and Escape — its only
    // dismissal — does nothing, because focus is still outside it.
    expect(RAIL).toMatch(/el\.focus\(\{ preventScroll: true \}\)/);
  });

  it('drops the role and name again on close', () => {
    // A closed, emptied panel is not a named region; leaving the pair behind
    // advertises a landmark that holds nothing.
    expect(RAIL).toMatch(/removeAttribute\('role'\)/);
    expect(RAIL).toMatch(/removeAttribute\('aria-label'\)/);
  });

  it('is not also a live region', () => {
    // The panel's whole innerHTML is replaced on open, so a live region wrapping
    // it announced the entire panel every time.
    expect(HTML).not.toMatch(/id="railPanel"[^>]*aria-live/);
  });
});

describe('names and status', () => {
  it('labels the identity-mapping input rather than relying on its placeholder', () => {
    // A placeholder is not an accessible name (WCAG 4.1.2), and it is gone the
    // moment you type.
    expect(SRC).toMatch(/<label class="u-visually-hidden" for="obsMapidInput">/);
  });

  it('announces the result count when Show more changes it', () => {
    expect(SRC).toMatch(/data-sess-count role="status"/);
  });
});

// The archive is a set of addresses, and the browser's Back and Forward buttons
// are the primary way anyone moves between them. Two things broke that.
describe('history is honest about where you have been', () => {
  it('records how deep each entry is, so Back can be a real Back', () => {
    expect(SRC).toMatch(/function pushArchiveState\(state, path, \{ home = false \} = \{\}\)/);
    expect(SRC).toMatch(/archiveDepth: depth/);
  });

  it('pushes every drill through that helper', () => {
    // A raw pushState anywhere means an entry with no depth on it, and the Back
    // button silently falls back to pushing a duplicate.
    const raw = [...SRC.matchAll(/history\.pushState\(/g)].length;
    // Two legitimate ones: inside the helper itself, and the deep-link fallback
    // in the Back handler where there is genuinely nothing to go back to.
    expect(raw).toBe(2);
  });

  it('unwinds past every drill, back to the home view you came from', () => {
    // Two drills deep must clear both, not one — but must stop at the tab you
    // were reading rather than running all the way to the overview. Open a
    // speaker from Videos and Back belongs on Videos.
    expect(SRC).toMatch(/history\.go\(-steps\)/);
    expect(SRC).toMatch(
      /const steps = \(state\?\.archiveDepth \|\| 0\) - \(state\?\.homeDepth \|\| 0\)/,
    );
    expect(SRC).toMatch(/pushArchiveState\(\{ homeTab: tab \}[^;]*\{ home: true \}\)/);
  });

  it('does not push a third entry that merely looks like the first', () => {
    // The old bug: Back pushed /archive again, so the browser's Back button then
    // went FORWARDS into the drill you had just left.
    expect(SRC).not.toMatch(
      /\[data-back\][\s\S]{0,300}history\.pushState\(\{\}, '', _homeTab === 'overview'/,
    );
  });

  it('knows a drill is open, so routing home does not reload the page', () => {
    // _homeTab names which HOME tab is selected and stays "overview" while you
    // read a speaker page — so routing back to /archive concluded "nothing to
    // do" and popstate fell through to location.reload().
    expect(SRC).toMatch(/if \(_homeTab === 'overview' && !_drillOpen\) return false;/);
    // Maintained in setCrumbs, which every view already calls.
    expect(SRC).toMatch(/_drillOpen = trail\.length > 0;/);
  });
});
