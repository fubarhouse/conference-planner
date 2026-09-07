// @ts-check
/**
 * "Maximise" for every chart panel on the archive dashboard.
 *
 * The point is screenshots: a chart in the page carries the page's chrome, the
 * nav and whatever else happens to be beside it. Real fullscreen gives a clean
 * frame with nothing in it but the drawing.
 *
 * ⚠ USES THE FULLSCREEN API, WITH AN IN-PAGE FALLBACK. `requestFullscreen`
 * rejects when the document is not allowed to enter fullscreen (an iframe
 * without `allow="fullscreen"`, some embedded webviews) and it is not available
 * at all on older iOS Safari. Both cases fall back to a fixed overlay, which
 * still fills the viewport — it just cannot hide the browser's own chrome.
 *
 * The button is injected rather than written into every template because the
 * panels are produced by a dozen different render paths in a 269 KB module;
 * adding markup to each one would mean touching all of them and missing some.
 */

const LABEL_ON = 'Maximise';
const LABEL_OFF = 'Exit fullscreen';

/**
 * What gets a button. `.obs-panel` is every chart panel; `.obs-maxable` is the
 * opt-in for things that are not panels but are just as worth screenshotting —
 * the two archive maps, which live in their own wrappers.
 */
const SEL = '.obs-panel, .obs-maxable';

/**
 * Announce a maximise change on the element itself.
 *
 * ⚠ SOME CONTENT CANNOT SURVIVE BEING RESIZED BY CSS ALONE. Leaflet measures its
 * container once and caches the result, so a map that doubles in size renders
 * its old viewport into the new box — grey gutters, pins in the wrong place.
 * This module stays Leaflet-agnostic and lets the owner fix its own content.
 *
 * @param {Element} el
 * @param {boolean} open
 */
function announce(el, open) {
  el.dispatchEvent(new CustomEvent('obs:maximise', { detail: { open }, bubbles: true }));
}

/**
 * @param {Element} panel
 * @returns {boolean}
 */
function isOpen(panel) {
  return panel.classList.contains('obs-panel--max');
}

/**
 * @param {Element} panel
 */
function mark(panel) {
  const open = isOpen(panel);
  const btn = panel.querySelector('.obs-max-btn');
  if (!btn) return;
  btn.setAttribute('aria-label', open ? LABEL_OFF : LABEL_ON);
  btn.setAttribute('title', open ? LABEL_OFF : LABEL_ON);
  btn.setAttribute('aria-pressed', open ? 'true' : 'false');
}

/**
 * Leave whichever panel is maximised.
 *
 * @param {Document|null} [doc]
 */
function closeMaximised(doc) {
  const d = doc || (typeof document !== 'undefined' ? document : null);
  if (!d) return;
  for (const p of Array.from(d.querySelectorAll('.obs-panel--max'))) {
    p.classList.remove('obs-panel--max');
    mark(p);
    announce(p, false);
  }
  d.documentElement?.classList.remove('obs-maxed');
  if (d.fullscreenElement && d.exitFullscreen) d.exitFullscreen().catch(() => {});
}

/**
 * @param {Element} panel
 */
function open(panel) {
  const d = panel.ownerDocument;
  closeMaximised(d);
  panel.classList.add('obs-panel--max');
  d.documentElement?.classList.add('obs-maxed');
  mark(panel);
  announce(panel, true);
  // The class is what actually fills the screen, so the drawing is already
  // correct if the request is refused — this only removes the browser chrome.
  const req = /** @type {any} */ (panel).requestFullscreen;
  if (typeof req === 'function') req.call(panel).catch(() => {});
}

/**
 * @param {Element} panel
 */
function toggleMaximise(panel) {
  if (isOpen(panel)) closeMaximised(panel.ownerDocument);
  else open(panel);
}

/**
 * Give every chart panel under `root` a maximise button, once.
 *
 * Safe to call after every render: panels that already have a button are
 * skipped, so a re-render of part of the page does not stack duplicates.
 *
 * @param {ParentNode|null} root
 * @returns {number} how many buttons were added
 */
function wireMaximise(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return 0;
  let n = 0;
  for (const panel of Array.from(root.querySelectorAll(SEL))) {
    if (panel.querySelector(':scope > .obs-max-btn')) continue;
    const btn = panel.ownerDocument.createElement('button');
    btn.type = 'button';
    btn.className = 'obs-max-btn';
    btn.setAttribute('aria-label', LABEL_ON);
    btn.setAttribute('title', LABEL_ON);
    btn.setAttribute('aria-pressed', 'false');
    // Inline so the control survives a stylesheet that has not loaded yet, and
    // so a screenshot never catches a bare glyph-less square.
    btn.innerHTML =
      '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<path d="M1.5 6V1.5H6M10 1.5h4.5V6M14.5 10v4.5H10M6 14.5H1.5V10"/></svg>';
    panel.appendChild(btn);
    n++;
  }
  return n;
}

/**
 * Keep every panel wired, however it got there.
 *
 * ⚠ THE DASHBOARD WRITES `#obsBody` FROM A DOZEN PLACES — the overview, each
 * home tab, every drill-down, and several async paths that land after their
 * caller has returned. Calling wireMaximise() from each of them means finding
 * all of them and remembering to add the next one; the first pass wired the
 * overview only, which is why every other chart on the page had no maximise
 * button at all. Observing the container instead is one hook that cannot be
 * forgotten.
 *
 * @param {Element|null} root
 */
export function observeMaximise(root) {
  if (!root || typeof MutationObserver === 'undefined') return;
  if (/** @type {any} */ (root)._obsMaxObserved) return;
  /** @type {any} */ (root)._obsMaxObserved = true;
  wireMaximise(root);
  // Cheap: only fires on structural change, and wireMaximise skips panels that
  // already carry a button.
  new MutationObserver(() => wireMaximise(root)).observe(root, {
    childList: true,
    subtree: true,
  });
}

/**
 * Wire the document-level listeners once: click to toggle, Escape to leave, and
 * a fullscreenchange hook so leaving by the browser's own affordance (Escape
 * handled natively, or the OS control) still clears our class.
 *
 * @param {Document|null} [doc]
 */
export function initMaximise(doc) {
  const d = doc || (typeof document !== 'undefined' ? document : null);
  if (!d || /** @type {any} */ (d)._obsMaxWired) return;
  /** @type {any} */ (d)._obsMaxWired = true;

  d.addEventListener('click', (e) => {
    const btn = /** @type {Element} */ (e.target)?.closest?.('.obs-max-btn');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const panel = btn.closest(SEL);
    if (panel) toggleMaximise(panel);
  });

  d.addEventListener('keydown', (e) => {
    // Escape already exits real fullscreen by itself; this is for the fallback
    // overlay, where nothing else would.
    if (e.key === 'Escape' && d.querySelector('.obs-panel--max')) closeMaximised(d);
  });

  d.addEventListener('fullscreenchange', () => {
    if (!d.fullscreenElement) closeMaximised(d);
  });
}
