// API access — the bearer token another tool uses to reach /api/v1 as you.
//
// The server side has existed for a while (POST/DELETE /api/users/:id/token in
// lib/users.js); nothing ever surfaced it. app/js/modules/usersPanel.js was
// written for it and then never imported by anything — it is still listed in
// knip.json's ignore list, which is why the dead-code report stayed quiet about
// it. This module is the part that actually mounts, in the planner's own
// settings language rather than the editor's.
//
// Tokens work in either authenticated mode. In multi mode the token acts as
// your user row; in SINGLE-USER mode there is nobody to identify, so it is
// simply the key to this server — the card says so rather than asking who you
// are. Open mode is the one refusal: no authentication means no identity for a
// token to represent, and the server will not mint one.
//
// When it is unavailable the controls STAY VISIBLE and go disabled with a line
// saying why — the same treatment "Lock this planner" gets one section above. A
// capability you cannot see is a capability you cannot plan around.

const el = (id) => document.getElementById(id);

/** Matches SINGLE_USER_ID in lib/auth.js — session mode's one addressable id. */
const SINGLE_USER_ID = 'owner';

/** Cache the availability probe: the answer cannot change without a redeploy. */
let _availability = null;

/**
 * Can this deployment issue tokens, and may this caller ask for one?
 * @returns {Promise<{ok: boolean, reason: string, userId: string|null}>}
 */
async function probe() {
  if (_availability) return _availability;
  try {
    const res = await fetch('/api/auth/status', { credentials: 'same-origin' });
    const status = await res.json();
    if (status.mode === 'open') {
      // Not a limitation to work around: with no authentication there is no
      // identity for a token to represent, and the server refuses to mint one.
      _availability = {
        ok: false,
        reason:
          'This server runs without authentication, so there is no account for a token to belong to. Set a password (single user) or a users table (multi-user).',
        userId: null,
      };
    } else if (status.mode === 'session') {
      // Single user: there is nobody to identify, so the token is not "yours"
      // as against anyone else's — it is simply the key to this server. Say
      // that, rather than leaving the card silent and looking unexplained.
      _availability = {
        ok: true,
        reason: '',
        note: 'Single user mode — one token for this server, and it is the whole credential. Anyone holding it has your access.',
        userId: SINGLE_USER_ID,
      };
    } else if (status.role !== 'admin') {
      _availability = {
        ok: false,
        reason: 'Only an admin can issue tokens. Ask whoever administers this server.',
        userId: null,
      };
    } else {
      // Both authenticated modes report an id here: the user's row in multi
      // mode, and the single fixed identity ('owner') in session mode.
      const me = await fetch('/api/users/me', { credentials: 'same-origin' }).then((r) =>
        r.ok ? r.json() : null,
      );
      _availability = me?.user_id
        ? {
            ok: true,
            reason: '',
            note: 'This token acts as your account. Anyone holding it has your access.',
            userId: me.user_id,
          }
        : { ok: false, reason: 'Could not identify the signed-in account.', userId: null };
    }
  } catch {
    _availability = {
      ok: false,
      reason: 'The server is not reachable, so tokens cannot be issued.',
      userId: null,
    };
  }
  return _availability;
}

/** Escape for the one place a server string reaches innerHTML. */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Reveal a freshly minted token. It is shown once — the server keeps only a
 * SHA-256 of it, so there is no second chance to read it back.
 * @param {string} token
 */
function showToken(token) {
  const out = el('settingsTokenResult');
  if (!out) return;
  out.classList.remove('hidden');
  out.innerHTML = `
    <p class="set-token-warn">Copy this now — it is not shown again.</p>
    <div class="set-token-row">
      <code class="set-token-code">${esc(token)}</code>
      <button type="button" class="set-btn" data-copy-token>Copy</button>
    </div>
    <p class="set-token-use">Send it as <code>Authorization: Bearer &lt;token&gt;</code></p>`;
  // A listener, not an inline onclick with the token interpolated into an
  // attribute — that is an injection seam and dies under any CSP worth having.
  out.querySelector('[data-copy-token]')?.addEventListener('click', async (e) => {
    const btn = e.target;
    // The clipboard API rejects outside a secure context and when permission is
    // refused. Say so rather than claiming a copy that did not happen — the
    // token is on screen and selectable, so the fallback is to select it.
    let copied = false;
    try {
      await navigator.clipboard.writeText(token);
      copied = true;
    } catch {
      copied = false;
    }
    btn.textContent = copied ? 'Copied' : 'Select it';
    setTimeout(() => {
      btn.textContent = 'Copy';
    }, 1800);
  });
}

function setNote(text) {
  const note = el('settingsTokenState');
  if (!note) return;
  note.textContent = text;
  note.classList.toggle('hidden', !text);
}

let _wired = false;

/**
 * Render + wire the API access card. Safe to call on every settings render:
 * the listeners attach once, the probe is cached.
 */
export function renderApiTokenSection() {
  const genBtn = el('settingsTokenBtn');
  const revokeBtn = el('settingsTokenRevokeBtn');
  if (!genBtn || !revokeBtn) return;

  // Disabled until the probe says otherwise, so a slow answer can never leave
  // a live-looking button that 501s when pressed.
  genBtn.disabled = true;
  revokeBtn.disabled = true;

  probe().then(({ ok, reason, note }) => {
    genBtn.disabled = !ok;
    revokeBtn.disabled = !ok;
    // A note when it works too — "why is this disabled" and "what does this
    // token mean here" are both things the card should answer on sight.
    setNote(ok ? note || '' : reason);
  });

  if (_wired) return;
  _wired = true;

  genBtn.addEventListener('click', async () => {
    const { ok, userId } = await probe();
    if (!ok || !userId) return;
    genBtn.disabled = true;
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(userId)}/token`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.token) showToken(data.token);
      else setNote(data.error || 'Could not generate a token.');
    } finally {
      genBtn.disabled = false;
    }
  });

  revokeBtn.addEventListener('click', async () => {
    const { ok, userId } = await probe();
    if (!ok || !userId) return;
    revokeBtn.disabled = true;
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(userId)}/token`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      el('settingsTokenResult')?.classList.add('hidden');
      setNote(res.ok ? 'Token revoked. Anything using it stops working now.' : 'Could not revoke.');
    } finally {
      revokeBtn.disabled = false;
    }
  });
}
