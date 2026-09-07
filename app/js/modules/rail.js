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
  // The name and the dialog role describe the panel's CONTENT; a closed,
  // emptied panel has neither, and leaving them behind advertises a dialog that
  // is not there.
  el.removeAttribute('role');
  el.removeAttribute('aria-label');
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
  // A role FIRST, then the label: aria-label on an element with no role is not
  // reliably exposed, so the panel had a name nothing could read out.
  //
  // region, NOT dialog. Two reasons, and the second is the expensive one:
  //   - this panel is not modal. It traps nothing, the page behind stays
  //     usable, and `dialog` would promise a containment that is not there.
  //   - the planner's modal skin keys every rule off `[role="dialog"]` — one
  //     lever for twenty-six surfaces — so labelling the rail a dialog dressed
  //     it in that component, starting with a 45%-ink scrim as its background.
  el.setAttribute('role', 'region');
  el.setAttribute('aria-label', label);
  document.body.setAttribute(OPEN_ATTR, 'true');
  el.innerHTML = '<div class="app-panel__body"></div>';

  // MOVE FOCUS IN. Without this the panel opened somewhere after the button
  // that opened it in the tab order, so a keyboard user had to guess it was
  // there and tab the rest of the page to reach it — and Escape, its only
  // dismissal, is meaningless while focus is still outside.
  el.setAttribute('tabindex', '-1');
  el.focus({ preventScroll: true });

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
