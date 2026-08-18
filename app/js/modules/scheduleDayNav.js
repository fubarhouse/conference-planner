// @ts-check
// Which day am I looking at?
//
// The programme is one long scroll. Its day headings scroll away with the
// content, so a few screens in there is nothing on the page that answers the
// question — you have to scroll back up to find out where you are.
//
// The day quick-nav already exists and already knows the days. Making it stick
// and marking the day you are inside turns it from a jump menu into a position
// readout, which is the cheaper of the two fixes and the one that also keeps
// working on a desktop-width window.
//
// The pure part is `activeDayIndex`: given where each day starts and where the
// reading line is, which day owns it. That is the whole decision, and it is
// testable without a browser.

/** How far below the sticky nav the "reading line" sits, in px. */
const READING_LINE = 8;

/**
 * The day that owns the reading line: the last one that has started.
 *
 * Before the first day starts (the page header is still on screen) this is 0 —
 * the first day is the honest answer to "which day is this schedule showing",
 * and a nav with nothing marked reads as broken rather than as "not yet".
 *
 * @param {number[]} tops - each day's offset from the top of the document, in order
 * @param {number} line - the reading line's offset from the top of the document
 * @returns {number} index into `tops`, or -1 when there are no days
 */
export function activeDayIndex(tops, line) {
  if (!Array.isArray(tops) || !tops.length) return -1;
  let active = 0;
  for (let i = 0; i < tops.length; i += 1) {
    if (tops[i] - line <= 0) active = i;
  }
  return active;
}

/**
 * Mark the active chip and keep it in view.
 *
 * @param {HTMLElement} nav
 * @param {number} index
 */
function markActive(nav, index) {
  const chips = /** @type {HTMLElement[]} */ ([...nav.querySelectorAll('[data-day-target]')]);
  if (!chips.length || index < 0) return;
  const chip = chips[index];
  if (!chip || chip.getAttribute('aria-current') === 'true') return;
  for (const c of chips) c.removeAttribute('aria-current');
  chip.setAttribute('aria-current', 'true');
  // A long conference runs the chips off the side of the sticky bar; keep the
  // one that answers the question on screen.
  if (nav.scrollWidth > nav.clientWidth) {
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    nav.scrollTo({
      left: chip.offsetLeft - (nav.clientWidth - chip.offsetWidth) / 2,
      behavior: calm ? 'auto' : 'smooth',
    });
  }
}

/**
 * Mirror the "Jump to now" button into the bar while the event is running.
 *
 * The real button lives in the page's action cluster, which the mobile menu
 * adopts — so on the one day it matters it was a menu away. Rather than move it
 * (the bar is rebuilt on every render, and a moved node would be wiped), this
 * proxies it, the same way the bottom bar's Browse tab proxies `#searchEvents`.
 * There is still one button, one place that decides whether it applies.
 *
 * @param {HTMLElement} nav
 */
function syncNowChip(nav) {
  const real = /** @type {HTMLElement|null} */ (document.getElementById('jumpToNow'));
  const live = Boolean(real) && !real?.classList.contains('hidden');
  const existing = nav.querySelector('[data-day-now]');
  if (!live) {
    existing?.remove();
    return;
  }
  if (existing) return;
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.dataset.dayNow = '1';
  chip.className = 'sch-daynav__chip sch-daynav__now';
  chip.textContent = 'Now';
  chip.addEventListener('click', () => real?.click());
  nav.append(chip);
}

/**
 * The clock readout: which slot the reading line is inside.
 *
 * Worth its width because the slot times genuinely do scroll away — measured on
 * this programme, a time is on screen at only 55% of mobile scroll positions
 * (80% on desktop), with stretches of 1600px, nearly two screens, showing none.
 * The day answers "which day"; this answers "how far into it".
 *
 * @param {HTMLElement} nav
 * @param {number} line
 */
function syncTimeReadout(nav, line) {
  let out = /** @type {HTMLElement|null} */ (nav.querySelector('[data-day-time]'));
  if (!out) {
    out = document.createElement('span');
    out.dataset.dayTime = '1';
    out.className = 'sch-daynav__time';
    // aria-hidden: the heading it mirrors is already in the reading order, and
    // a live region that fires on every scroll tick is unusable with a reader.
    out.setAttribute('aria-hidden', 'true');
    nav.prepend(out);
  }
  const bands = /** @type {HTMLElement[]} */ ([...document.querySelectorAll('.sch-band__hh')]);
  if (!bands.length) {
    out.hidden = true;
    return;
  }
  const tops = bands.map((s) => s.getBoundingClientRect().top + window.scrollY);
  const i = activeDayIndex(tops, line);
  // Before the first slot there is nothing to report — the page header is still
  // on screen, and a time then would be a guess.
  const started = i >= 0 && tops[i] <= line;
  out.hidden = !started;
  if (started) out.textContent = bands[i].textContent?.trim() || '';
}

/**
 * Wire the day nav to the scroll position. Safe to call on every render — it
 * installs its listeners once and re-reads the days each time.
 *
 * @returns {void}
 */
export function trackDayNav() {
  if (typeof document === 'undefined') return;
  const nav = /** @type {HTMLElement|null} */ (document.getElementById('dayNav'));
  if (!nav) return;

  syncNowChip(nav);
  const real = document.getElementById('jumpToNow');
  if (real && !real.dataset.navMirrored) {
    real.dataset.navMirrored = '1';
    // nowIndicator.js shows and hides the button on its own clock.
    new MutationObserver(() => syncNowChip(nav)).observe(real, {
      attributes: true,
      attributeFilter: ['class'],
    });
  }

  const update = () => {
    const days = /** @type {HTMLElement[]} */ ([...document.querySelectorAll('.schedule-day')]);
    if (days.length < 2) return;
    const line = window.scrollY + nav.getBoundingClientRect().bottom + READING_LINE;
    const tops = days.map((d) => d.getBoundingClientRect().top + window.scrollY);
    markActive(nav, activeDayIndex(tops, line));
    syncTimeReadout(nav, line);
  };

  if (!nav.dataset.tracking) {
    nav.dataset.tracking = '1';
    let queued = false;
    const onScroll = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        update();
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
  }
  update();
}
