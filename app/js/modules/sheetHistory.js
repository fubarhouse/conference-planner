// @ts-check
// Back closes the sheet, not the site.
//
// A session sheet, the rail panel and the mobile menu are all full-screen
// surfaces that a reader thinks of as "a thing I opened". On a phone the
// gesture for leaving such a thing is the system back button — and without
// this, back left the site entirely, losing the schedule, the scroll position
// and the reader's place in a programme they may be standing in a corridor
// reading. That is the worst thing a mobile web app can do.
//
// The mechanic is deliberately dumb: push one history entry when a surface
// opens, and on `popstate` close whatever is open. It never pushes twice for
// nested opens, because these surfaces are mutually exclusive by construction —
// opening a session closes the panel and vice versa (see rail.js).

const MARK = 'sheet';

/** @type {null | (() => void)} */
let closeTopmost = null;
let pushed = false;

/** Is any dismissable surface currently open? */
function openSurface() {
  if (typeof document === 'undefined') return null;
  const session = document.querySelector('.sch-entry__disclosure[open]');
  if (session)
    return () => {
      /** @type {any} */ (session).open = false;
    };
  const menu = document.getElementById('appMenu');
  if (menu && !menu.hidden) return () => document.getElementById('appMenuBtn')?.click();
  const panel = document.getElementById('railPanel');
  if (panel && !panel.hidden) return null; // caller supplies the rail closer
  return null;
}

/**
 * @param {{closeRail?: () => void}} [opts]
 * @returns {void}
 */
export function initSheetHistory(opts = {}) {
  if (typeof window === 'undefined') return;
  const closeRail = opts.closeRail || (() => {});

  const isOpen = () => {
    const panel = document.getElementById('railPanel');
    const menu = document.getElementById('appMenu');
    return Boolean(
      document.querySelector('.sch-entry__disclosure[open]') ||
      (panel && !panel.hidden) ||
      (menu && !menu.hidden),
    );
  };

  const close = () => {
    const fn = openSurface();
    if (fn) fn();
    const panel = document.getElementById('railPanel');
    if (panel && !panel.hidden) closeRail();
  };

  // One entry per opening, never a stack: a second push for a surface that
  // replaced another would need two Backs to leave one sheet.
  const sync = () => {
    const open = isOpen();
    if (open && !pushed) {
      pushed = true;
      history.pushState({ [MARK]: true }, '');
    } else if (!open && pushed) {
      pushed = false;
      // The reader closed it themselves (button, swipe, Escape). Drop our entry
      // so Back still means "the page before this one".
      if (history.state?.[MARK]) history.back();
    }
  };

  window.addEventListener('popstate', () => {
    if (!isOpen()) {
      pushed = false;
      return;
    }
    pushed = false;
    closeTopmost = close;
    closeTopmost();
  });

  // These surfaces are opened by CSS (`<details>`), by other modules and by the
  // menu, with no single event to hook. Observing the document is cheaper than
  // teaching four call sites to report in, and cannot fall out of sync.
  const mo = new MutationObserver(() => sync());
  mo.observe(document.documentElement, {
    subtree: true,
    attributes: true,
    attributeFilter: ['open', 'hidden'],
  });
  sync();
}
