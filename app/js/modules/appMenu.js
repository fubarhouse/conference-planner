// @ts-check
// The mobile menu.
//
// At phone width the masthead was asking for more room than it had: the site
// nav overflowed (its last two links were simply unreachable), and Subscribe
// and the theme picker were squeezed to 31px with their labels clipped to
// nothing. Below them the page actions took a row of their own. The programme —
// the thing the page is for — started 917px down.
//
// This gathers that chrome behind one button. It ADOPTS the real elements
// rather than re-rendering copies of them: moving a node keeps its listeners,
// its state, and its popovers, so there is exactly one Subscribe control and
// one theme picker on the page and no second copy to keep in sync. Each adopted
// node leaves a marker behind and goes home when the viewport widens.

const MENU_ID = 'appMenu';
const BTN_ID = 'appMenuBtn';

/** @type {Array<{node: Element, mark: Comment}>} */
let adopted = [];
/** @type {MediaQueryList|null} */
let mq = null;

/**
 * @param {HTMLElement} panel
 * @param {string[]} selectors
 */
function adopt(panel, selectors) {
  if (adopted.length) return;
  for (const sel of selectors) {
    const node = document.querySelector(sel);
    if (!node || !node.parentNode) continue;
    const mark = document.createComment(`app-menu:${sel}`);
    node.parentNode.insertBefore(mark, node);
    panel.append(node);
    adopted.push({ node, mark });
  }
}

/** Put everything back where the markup had it. */
function release() {
  for (const { node, mark } of adopted) {
    mark.parentNode?.insertBefore(node, mark);
    mark.remove();
  }
  adopted = [];
}

/**
 * @param {boolean} open
 */
function setOpen(open) {
  const menu = document.getElementById(MENU_ID);
  const btn = document.getElementById(BTN_ID);
  if (!menu || !btn) return;
  menu.toggleAttribute('hidden', !open);
  btn.setAttribute('aria-expanded', String(open));
  document.body.classList.toggle('app-menu-open', open);
  if (open) /** @type {HTMLElement|null} */ (menu.querySelector('a, button'))?.focus();
}

/**
 * Mount the menu. Idempotent — safe to call from any page's entry point.
 *
 * @param {{adopt?: string[], breakpoint?: string}} [opts]
 * @returns {void}
 */
export function initAppMenu(opts = {}) {
  if (typeof document === 'undefined') return;
  if (document.getElementById(BTN_ID)) return;
  const bar = document.querySelector('.app-masthead__bar');
  const masthead = document.querySelector('.app-masthead');
  if (!bar || !masthead) return;

  const selectors = opts.adopt || [];

  const btn = document.createElement('button');
  btn.id = BTN_ID;
  btn.type = 'button';
  btn.className = 'app-burger';
  btn.setAttribute('aria-controls', MENU_ID);
  btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML =
    '<span class="app-burger__bars" aria-hidden="true"></span><span class="app-burger__label">Menu</span>';
  bar.append(btn);

  const menu = document.createElement('div');
  menu.id = MENU_ID;
  menu.className = 'app-menu';
  menu.hidden = true;
  menu.innerHTML = `<div class="app-menu__panel">
      <div class="app-menu__head">
        <p class="app-menu__title u-label">Menu</p>
        <button type="button" class="app-menu__close" aria-label="Close menu">Close</button>
      </div>
    </div>`;
  masthead.after(menu);
  const panel = /** @type {HTMLElement} */ (menu.querySelector('.app-menu__panel'));

  btn.addEventListener('click', () => setOpen(btn.getAttribute('aria-expanded') !== 'true'));

  // Adopted controls open their own popovers (Subscribe, the theme picker). In
  // here those are in flow, so opening one can put its content below the fold
  // of a panel the reader has no reason to think has scrolled. Bring it up.
  panel.addEventListener('click', (e) => {
    const control = /** @type {Element} */ (e.target).closest('button');
    if (!control) return;
    requestAnimationFrame(() => {
      const opened = panel.querySelector('.theme-picker-menu:not(.hidden), .sub-pop:not(.hidden)');
      if (!(opened instanceof HTMLElement)) return;
      if (opened.getBoundingClientRect().bottom <= panel.getBoundingClientRect().bottom) return;
      opened.scrollIntoView({ block: 'end', behavior: 'smooth' });
    });
  });

  // Dismiss on the backdrop, on Escape, and on choosing something — a menu that
  // stays open over the thing you just asked for is a menu in the way.
  menu.addEventListener('click', (e) => {
    // Adopted controls are still clicked programmatically from elsewhere (the
    // day bar's "Now" chip proxies the jump button, which lives in here). Those
    // synthetic clicks bubble to this handler with the menu already shut, and
    // must not be treated as the user dismissing it — returning focus to the
    // burger would scroll the page back to the top mid-jump.
    if (menu.hidden) return;
    if (e.target === menu) setOpen(false);
    else if (
      /** @type {Element} */ (e.target).closest('a, .app-btn, .app-nav__link, .app-menu__close')
    ) {
      setOpen(false);
      btn.focus({ preventScroll: true });
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) {
      setOpen(false);
      btn.focus();
    }
  });

  mq = window.matchMedia(opts.breakpoint || '(max-width: 52rem)');
  const sync = () => {
    if (mq?.matches) {
      adopt(panel, selectors);
    } else {
      setOpen(false);
      release();
    }
  };
  mq.addEventListener('change', sync);
  sync();
}
