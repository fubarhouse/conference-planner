// The shared detail surface.
//
// Session details are pure CSS — a <details name="session"> whose content is
// lifted into the margin (desktop) or slid in as a full sheet (mobile). That
// works because a session's content is already in the fetched dataset.
//
// Some detail content cannot be pre-rendered: sponsor history is assembled
// asynchronously across every event. This module gives that content the same
// surface, so the product has ONE place where detail appears rather than a rail
// for sessions and a modal for everything else.
//
// It stays mutually exclusive with the CSS-only details: opening the panel
// closes any open session, and opening a session closes the panel.
const PANEL_ID = 'railPanel';
const OPEN_ATTR = 'data-rail-open';

let lastFocused = null;

function panel() {
  return document.getElementById(PANEL_ID);
}

function closeOpenSession() {
  document.querySelectorAll('.sch-entry__disclosure[open]').forEach((d) => {
    d.open = false;
  });
}

export function closeRail({ restoreFocus = true } = {}) {
  const el = panel();
  if (!el || el.hidden) return;
  el.hidden = true;
  // Callers may have MOVED live nodes into the panel (the archive relocates
  // its keyword legend). Tell them before the panel is emptied, so they can
  // reclaim what is theirs instead of having it destroyed.
  el.dispatchEvent(new CustomEvent('rail:closed'));
  el.innerHTML = '';
  document.body.removeAttribute(OPEN_ATTR);
  if (restoreFocus && lastFocused && document.contains(lastFocused)) lastFocused.focus();
  lastFocused = null;
}

// Opens the surface and returns the element to render into. The caller owns the
// content; the close affordance and the exclusivity are handled here.
export function openRail(label = 'Details') {
  const el = panel();
  if (!el) return null;

  lastFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  closeOpenSession();

  el.hidden = false;
  el.setAttribute('aria-label', label);
  document.body.setAttribute(OPEN_ATTR, 'true');
  el.innerHTML = '<div class="app-panel__body"></div>';

  return el.querySelector('.app-panel__body');
}

export function initRail() {
  const el = panel();
  if (!el) return;

  // A session opening must retire the panel. `toggle` does not bubble, so it is
  // captured rather than delegated.
  const container = document.getElementById('eventsContainer');
  container?.addEventListener(
    'toggle',
    (e) => {
      if (e.target.matches?.('.sch-entry__disclosure') && e.target.open)
        closeRail({ restoreFocus: false });
    },
    true,
  );

  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-rail-close]')) closeRail();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.hidden) closeRail();
  });
}
