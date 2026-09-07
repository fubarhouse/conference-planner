// Per-planner "privacy lock" — a soft lock that hides a planner behind a password
// prompt when `planner.locked` is set. The user's own account password is verified
// against the server (POST ./api/auth/verify); a successful unlock grants a 90-minute
// grace window (per planner, in sessionStorage) before it re-locks.
//
// Honest scope: planner data lives in localStorage, so this is a privacy deterrent
// (shared device / over-the-shoulder), not encryption. It can only be enforced when
// the server runs with auth (session/multi); in `open`/static mode there is no
// password to verify, so it fails open (the toggle is disabled in the UI there).

import { escapeHtml as esc } from './utils.js';

const LOCK_GRACE_MS = 90 * 60 * 1000; // 90 minutes
const OVERLAY_ID = 'plannerLockOverlay';
const graceKey = (slug) => `__plannerUnlock_v1__${slug}`;

let _authModePromise = null;

// The server auth mode (cached). null when unreachable (static / offline). A 3s
// timeout guarantees a locked planner never hangs on a slow/absent endpoint.
async function lockAuthMode() {
  if (!_authModePromise) {
    _authModePromise = (async () => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 3000);
        const r = await fetch('./api/auth/status', { cache: 'no-store', signal: ctrl.signal });
        clearTimeout(t);
        if (!r.ok) return null;
        const j = await r.json();
        return j && typeof j.mode === 'string' ? j.mode : null;
      } catch {
        return null;
      }
    })();
  }
  return _authModePromise;
}

// A password lock can only be enforced when a login password exists.
export async function lockEnforceable() {
  const mode = await lockAuthMode();
  return mode === 'session' || mode === 'multi';
}

export function hasUnlockGrace(slug) {
  try {
    const until = Number(sessionStorage.getItem(graceKey(slug)) || 0);
    return Number.isFinite(until) && until > Date.now();
  } catch {
    return false;
  }
}

export function grantUnlockGrace(slug) {
  try {
    sessionStorage.setItem(graceKey(slug), String(Date.now() + LOCK_GRACE_MS));
  } catch {
    /* sessionStorage unavailable — the planner just re-prompts, no crash */
  }
}

// Re-verify the account password. Returns { ok, reason } so the caller can tell a
// wrong password apart from a rate-limit or an unreachable/misconfigured endpoint —
// otherwise every failure looks like "wrong password" and is impossible to diagnose.
//   reason: 'bad' (wrong password) | 'rate' (429) | 'unreachable' (redirect/404/HTML/offline)
export async function verifyPassword(password) {
  try {
    const res = await fetch('./api/auth/verify', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (res.status === 429) return { ok: false, reason: 'rate' };
    // A 302→login redirect or a static 404 fallback returns HTML, not JSON.
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return { ok: false, reason: 'unreachable' };
    const data = await res.json().catch(() => ({}));
    if (data?.ok === true) return { ok: true };
    // requireRole returns { error: 'Unauthorized' | 'Insufficient permissions' } — a
    // sign-in problem (e.g. the session expired), not a wrong password.
    if (data?.error) return { ok: false, reason: 'unreachable' };
    return { ok: false, reason: 'bad' };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}

function removeOverlay() {
  document.getElementById(OVERLAY_ID)?.remove();
  document.body.classList.remove('planner-lock-open');
}

function buildOverlay(name) {
  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.className = 'planner-lock-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'plannerLockTitle');
  overlay.innerHTML = `
    <div class="planner-lock-card">
      <div class="planner-lock-icon" aria-hidden="true"><i class="fas fa-lock"></i></div>
      <h2 id="plannerLockTitle" class="planner-lock-title">Planner locked</h2>
      <p class="planner-lock-sub">Enter your account password to open <strong>${esc(
        name || 'this planner',
      )}</strong>.</p>
      <form class="planner-lock-form" autocomplete="off">
        <input id="plannerLockInput" type="password" class="planner-lock-input" placeholder="Password" autocomplete="current-password" aria-label="Account password">
        <p id="plannerLockError" class="planner-lock-error" role="alert" hidden></p>
        <button type="submit" id="plannerLockSubmit" class="planner-lock-btn"><i class="fas fa-unlock-keyhole"></i> Unlock</button>
      </form>
      <a href="./planner.html" class="planner-lock-back">← All planners</a>
    </div>`;
  document.body.appendChild(overlay);
  document.body.classList.add('planner-lock-open');
  return overlay;
}

// Show the lock screen and resolve once unlocked. Grants the grace window on success.
function showLockOverlay({ slug, name } = {}) {
  removeOverlay();
  const overlay = buildOverlay(name);
  const input = overlay.querySelector('#plannerLockInput');
  const errorEl = overlay.querySelector('#plannerLockError');
  const submit = overlay.querySelector('#plannerLockSubmit');
  const form = overlay.querySelector('.planner-lock-form');
  input?.focus();

  return new Promise((resolve) => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = input.value;
      if (!password) return;
      submit.disabled = true;
      errorEl.hidden = true;
      const { ok, reason } = await verifyPassword(password);
      if (ok) {
        grantUnlockGrace(slug);
        removeOverlay();
        resolve(true);
        return;
      }
      submit.disabled = false;
      input.focus();
      if (reason === 'rate') {
        errorEl.textContent = 'Too many attempts — wait a few minutes and try again.';
      } else if (reason === 'unreachable') {
        errorEl.textContent = "Couldn't reach the server to verify — check you're signed in.";
      } else {
        input.value = '';
        errorEl.textContent = 'Incorrect password.';
      }
      errorEl.hidden = false;
    });
  });
}

// Boot gate — NON-BLOCKING. If the planner is locked (and outside its grace window)
// the overlay is shown immediately to cover the content, but boot is NOT awaited on
// it: the planner still initialises and PERSISTS underneath the cover. This keeps a
// soft privacy lock from ever gating autosave/save. Returns true when a cover was
// shown. Fails open (removes the cover) when no password can be verified, and is
// DOM-guarded so it no-ops in non-browser/test environments.
export function guardPlannerLock({ planner, slug, name } = {}) {
  if (!planner?.locked || !slug) return false;
  if (hasUnlockGrace(slug)) return false;
  if (typeof document === 'undefined' || !document.body) return true;
  showLockOverlay({ slug, name });
  // Can't enforce (open / static / offline) → drop the cover; nothing to check against.
  lockEnforceable().then((ok) => {
    if (!ok) removeOverlay();
  });
  return true;
}
