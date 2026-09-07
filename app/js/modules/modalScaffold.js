// Shared scaffolding for the full-screen `session-modal-overlay` dialogs used
// across the schedule viewer (session, speaker, sponsor, share, and event-search
// modals). Each modal still owns its own markup and close semantics; these
// helpers remove the boilerplate that was previously hand-copied into every
// ensure*Modal() builder — most notably the ~25-line Escape/Tab focus trap.
import { getFocusableElements } from './utils.js';

// Create the overlay element once and append it to <body>. Returns the element.
export function buildModalOverlay({
  id,
  innerHTML,
  className = 'session-modal-overlay hidden',
  ariaHidden = false,
}) {
  const modal = document.createElement('div');
  modal.id = id;
  modal.className = className;
  if (ariaHidden) modal.setAttribute('aria-hidden', 'true');
  modal.innerHTML = innerHTML;
  document.body.appendChild(modal);
  return modal;
}

// Close the modal when the backdrop (the overlay itself) is clicked.
export function dismissOnBackdrop(modal, onClose) {
  modal.addEventListener('click', (event) => {
    if (event.target === modal) onClose();
  });
}

// Escape-to-close plus a Tab focus trap that keeps keyboard focus inside the
// modal. Shared verbatim by the session, speaker, and sponsor modals.
export function trapFocus(modal, onClose) {
  modal.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = getFocusableElements(modal);
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  });
}
