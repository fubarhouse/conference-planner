// The archive's search box is a combobox, and it was missing every convention of
// one. Three separate reports, one root cause each:
//
//   - clicking elsewhere left the suggestion list hanging over the page, because
//     the only thing that ever closed it was typing fewer than two characters;
//   - Enter did nothing at all, so the most obvious key on the keyboard was a
//     no-op and you had to go back for the mouse;
//   - and a search was a one-way door: submitting an empty box returned early,
//     so the only way back to the full list was the browser's Back button.
//
// These live at the source because the handlers bind to live DOM inside
// renderHome()/showSessionSearch() and there is no jsdom here.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'archiveDashboard.js'),
  'utf8',
);

describe('the suggestion list can be dismissed', () => {
  it('closes when the pointer goes down outside it', () => {
    expect(SRC).toMatch(/document\.addEventListener\('pointerdown'/);
    // Must ignore its own list, or the button under the pointer never gets the
    // click that follows.
    expect(SRC).toMatch(/closest\?\.\('#obsResults, #obsSearch'\)/);
  });

  it('closes on Escape before clearing the query', () => {
    // Escape is "back one step" — a single press must not destroy a long query.
    expect(SRC).toMatch(
      /if \(rows\.length\) closeSearchResults\(\);\s*\n\s*else e\.target\.value = ''/,
    );
  });

  it('empties the list rather than only hiding it', () => {
    // A hidden-but-populated list still answers arrow keys and still holds the
    // previous query's results the next time it opens.
    expect(SRC).toMatch(/function closeSearchResults\(\)[\s\S]{0,300}box\.innerHTML = ''/);
  });
});

describe('the keyboard reaches the results', () => {
  it('runs a session search on Enter when nothing is highlighted', () => {
    expect(SRC).toMatch(/if \(e\.key !== 'Enter'\) return;/);
    expect(SRC).toMatch(/openSessionSearch\(q\)/);
  });

  it('takes the highlighted suggestion on Enter when there is one', () => {
    expect(SRC).toMatch(/const pick = rows\[_activeResult\];[\s\S]{0,80}pick\.click\(\)/);
  });

  it('moves the highlight with the arrow keys', () => {
    expect(SRC).toMatch(/ArrowDown[\s\S]{0,200}setActiveResult\(_activeResult \+ /);
  });

  it('announces itself as a combobox', () => {
    // Focus stays in the input, so the active option has to be published
    // explicitly or a screen reader follows none of this.
    expect(SRC).toMatch(/role="combobox"/);
    expect(SRC).toMatch(/aria-activedescendant/);
    expect(SRC).toMatch(/role="listbox"/);
  });
});

describe('a search is not a one-way door', () => {
  it('lets an empty query through as a real request', () => {
    // Was `if (!next || next === q) return;` — the `!next` is what trapped you.
    expect(SRC).not.toMatch(/if \(!next \|\| next === q\) return;/);
    expect(SRC).toMatch(/if \(next === q\) return;/);
  });

  it('offers a Clear button once there is something to clear', () => {
    expect(SRC).toMatch(/data-sess-clear/);
    expect(SRC).toMatch(/\[data-sess-clear\]'\)\)[\s\S]{0,80}openSessionSearch\(''\)/);
  });

  it('gives the no-query page its own words instead of empty quotes', () => {
    // The heading rendered a bare “” when the query was empty.
    expect(SRC).toMatch(/'Every session'/);
  });

  it('routes every entry point through one helper, so all are linkable', () => {
    // The history push used to live inside the click handler, so only that one
    // route produced an address you could reload or come Back to.
    expect(SRC).toMatch(/function openSessionSearch\(query\)[\s\S]{0,400}pushArchiveState/);
  });
});
