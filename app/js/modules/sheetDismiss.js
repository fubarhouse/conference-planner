// @ts-check
// Swipe a sheet away.
//
// On phones both detail surfaces — a session's <details> and the async rail
// panel — become a full sheet that slides in from the RIGHT. So the gesture
// that dismisses them is a swipe right, the platform's back gesture, and not
// the swipe-down a bottom sheet would want. That choice also keeps the gesture
// off the vertical axis, so it never competes with scrolling the sheet's own
// content — the usual reason swipe-to-dismiss feels broken.
//
// The sheet is dragged under the finger and either completes or springs back,
// because a gesture that gives no feedback until you release is a guess.

/** Fraction of the sheet's width that commits the dismissal. */
const COMMIT = 0.3;
/** px/ms past which a short flick counts regardless of distance. */
const FLICK = 0.5;
/** Slop before we decide this is a horizontal drag rather than a scroll. */
const SLOP = 10;

const SHEETS = ['.sch-entry__disclosure[open] > .sch-entry__detail', '.app-panel:not([hidden])'];

/**
 * Close whichever surface this sheet belongs to.
 *
 * @param {HTMLElement} sheet
 * @param {() => void} closeRail
 */
function dismiss(sheet, closeRail) {
  const details = sheet.closest('details');
  if (details) {
    details.open = false;
    return;
  }
  closeRail();
}

/**
 * @param {HTMLElement} sheet
 * @param {number|null} dx - null restores the CSS-driven transform
 */
function drag(sheet, dx) {
  if (dx === null) {
    sheet.style.transform = '';
    sheet.style.transition = '';
    return;
  }
  sheet.style.transition = 'none';
  sheet.style.transform = `translateX(${dx}px)`;
}

/**
 * @param {{closeRail?: () => void, breakpoint?: string}} [opts]
 * @returns {void}
 */
export function initSheetDismiss(opts = {}) {
  if (typeof document === 'undefined' || !('ontouchstart' in globalThis)) return;
  const closeRail = opts.closeRail || (() => {});
  const mq = window.matchMedia(opts.breakpoint || '(max-width: 85.99rem)');

  /** @type {HTMLElement|null} */
  let sheet = null;
  let x0 = 0;
  let y0 = 0;
  let t0 = 0;
  /** @type {null|boolean} */
  let horizontal = null;

  document.addEventListener(
    'touchstart',
    (e) => {
      sheet = null;
      horizontal = null;
      if (!mq.matches || e.touches.length !== 1) return;
      const found = /** @type {HTMLElement|null} */ (
        /** @type {Element} */ (e.target).closest(SHEETS.join(', '))
      );
      // Only from the top of the sheet's own scroll — mid-article, a horizontal
      // drag is far more likely to be a mis-swipe than an intent to leave.
      if (!found || found.scrollTop > 0) return;
      sheet = found;
      x0 = e.touches[0].clientX;
      y0 = e.touches[0].clientY;
      t0 = e.timeStamp;
    },
    { passive: true },
  );

  document.addEventListener(
    'touchmove',
    (e) => {
      if (!sheet) return;
      const dx = e.touches[0].clientX - x0;
      const dy = e.touches[0].clientY - y0;
      if (horizontal === null) {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
        horizontal = Math.abs(dx) > Math.abs(dy);
        if (!horizontal) sheet = null; // it was a scroll; let it go
        return;
      }
      if (dx <= 0) {
        drag(sheet, 0);
        return;
      }
      drag(sheet, dx);
    },
    { passive: true },
  );

  const release = (/** @type {TouchEvent} */ e) => {
    if (!sheet) return;
    const current = sheet;
    sheet = null;
    if (!horizontal) return drag(current, null);
    const dx = (e.changedTouches[0]?.clientX ?? x0) - x0;
    const speed = dx / Math.max(1, e.timeStamp - t0);
    const far = dx > current.offsetWidth * COMMIT;
    drag(current, null);
    if (far || speed > FLICK) dismiss(current, closeRail);
  };

  document.addEventListener('touchend', release, { passive: true });
  document.addEventListener('touchcancel', release, { passive: true });
}
