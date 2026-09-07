// @ts-check
// The mobile accordion.
//
// Three panels on the schedule collapse at phone width and stay open above it —
// usage notes, filters, and the colophon. The pattern is a toggle marked
// `sm:hidden` over content marked `hidden sm:block`, so CSS decides which width
// gets a disclosure and JS only has to flip the pair.
//
// Extracted from app.js because the colophon is built at render time and needs
// the same wiring, and two copies of a disclosure contract is how two panels
// start disagreeing about what `aria-expanded` means.

/**
 * @param {string|HTMLElement|null} toggleRef
 * @param {string|HTMLElement|null} contentRef
 * @returns {void}
 */
export function setupMobileAccordion(toggleRef, contentRef) {
  if (typeof document === 'undefined') return;
  const toggle = typeof toggleRef === 'string' ? document.getElementById(toggleRef) : toggleRef;
  const content = typeof contentRef === 'string' ? document.getElementById(contentRef) : contentRef;
  if (!toggle || !content || toggle.dataset.accordion) return;
  toggle.dataset.accordion = '1';

  toggle.addEventListener('click', () => {
    const expanded = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
    content.classList.toggle('hidden', expanded);
  });
}
