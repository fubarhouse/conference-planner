// User management panel — only active in multi-user admin mode.

import { STORAGE_KEYS, readText } from './plannerStorage.js';

function apiBase() {
  return (
    (readText(STORAGE_KEYS.editorApiEndpoint) || '').replace(/\/$/, '') || window.location.origin
  );
}

async function apiFetch(path, opts = {}) {
  const res = await fetch(`${apiBase()}${path}`, opts);
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderUser(user, currentUserId) {
  const isSelf = user.user_id === currentUserId;
  return `
  <tr data-user-id="${escHtml(user.user_id)}" class="border-t edt-rule">
    <td class="py-2.5 pr-3 text-sm font-medium edt-ink-0">
      ${escHtml(user.username)}${isSelf ? ' <span class="text-xs edt-ink-2">(you)</span>' : ''}
    </td>
    <td class="py-2.5 pr-3">
      <select data-action="role" class="h-7 rounded edt-rule text-xs edt-surface drupal-blue-focus" ${isSelf ? 'disabled' : ''}>
        <option value="viewer" ${user.role === 'viewer' ? 'selected' : ''}>Viewer</option>
        <option value="editor" ${user.role === 'editor' ? 'selected' : ''}>Editor</option>
        <option value="admin"  ${user.role === 'admin' ? 'selected' : ''}>Admin</option>
      </select>
    </td>
    <td class="py-2.5 pr-3 text-xs edt-ink-2">
      <span data-token-state="${user.has_token ? 'active' : 'none'}">
        ${user.has_token ? '🔑 Token active' : 'No token'}
      </span>
    </td>
    <td class="py-2.5 text-right space-x-1.5 whitespace-nowrap">
      <button data-action="gen-token" class="h-7 px-2 text-xs rounded border edt-rule edt-ink-1 edt-surface transition-colors">
        ${user.has_token ? 'Regenerate token' : 'Generate token'}
      </button>
      ${user.has_token ? `<button data-action="revoke-token" class="h-7 px-2 text-xs rounded border edt-rule-bad edt-bad edt-surface transition-colors">Revoke</button>` : ''}
      ${!isSelf ? `<button data-action="delete" class="h-7 px-2 text-xs rounded border edt-rule-bad edt-bad edt-surface transition-colors">Delete</button>` : ''}
    </td>
  </tr>`;
}

function renderTokenResult(token) {
  return `<div class="mt-3 p-3 edt-surface-2 border edt-rule-warn rounded-lg space-y-1.5">
    <p class="text-xs font-semibold edt-warn">⚠ Save this token now — it will not be shown again.</p>
    <div class="flex gap-2 items-center">
      <code class="flex-1 text-xs font-mono edt-surface border edt-rule-warn rounded px-2 py-1.5 break-all select-all">${escHtml(token)}</code>
      <button onclick="navigator.clipboard.writeText('${escHtml(token)}')" class="flex-shrink-0 h-7 px-2 text-xs rounded border edt-rule-warn edt-warn edt-surface transition-colors">Copy</button>
    </div>
    <p class="text-xs edt-warn">Use as: <code class="font-mono">Authorization: Bearer ${escHtml(token)}</code></p>
  </div>`;
}

async function loadAndRender(container, currentUserId) {
  container.querySelector('#usersTableBody').innerHTML =
    '<tr><td colspan="4" class="py-4 edt-muted text-center">Loading…</td></tr>';

  const { ok, data } = await apiFetch('/api/users');
  if (!ok) {
    container.querySelector('#usersTableBody').innerHTML =
      `<tr><td colspan="4" class="py-4 text-sm edt-bad">${escHtml(data.error ?? 'Failed to load users')}</td></tr>`;
    return;
  }

  container.querySelector('#usersTableBody').innerHTML =
    data.map((u) => renderUser(u, currentUserId)).join('') ||
    '<tr><td colspan="4" class="py-4 edt-muted text-center">No users yet.</td></tr>';
}

export async function initUsersPanel() {
  // Check mode and role
  const [statusRes, meRes] = await Promise.all([
    apiFetch('/api/auth/status'),
    apiFetch('/api/users/me'),
  ]);

  const isMulti = statusRes.data?.mode === 'multi';
  const isAdmin = meRes.data?.role === 'admin';

  const tab = document.getElementById('showUsersTab');
  const panel = document.getElementById('usersWorkspacePanel');
  if (!tab || !panel) return;

  if (!isMulti || !isAdmin) {
    tab.classList.add('hidden');
    return;
  }

  tab.classList.remove('hidden');
  const currentUserId = meRes.data?.user_id;

  // Initial load
  await loadAndRender(panel, currentUserId);

  // Role change
  panel.addEventListener('change', async (e) => {
    if (e.target.dataset.action !== 'role') return;
    const row = e.target.closest('[data-user-id]');
    const userId = row?.dataset.userId;
    const role = e.target.value;
    if (!userId) return;
    const { ok, data } = await apiFetch(`/api/users/${userId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    });
    if (!ok) {
      alert(`Failed to update role: ${data.error ?? 'unknown error'}`);
      await loadAndRender(panel, currentUserId);
    }
  });

  // Button actions (generate token, revoke token, delete)
  panel.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const row = btn.closest('[data-user-id]');
    const userId = row?.dataset.userId;
    if (!userId) return;
    const action = btn.dataset.action;

    if (action === 'gen-token') {
      if (
        !confirm(
          'Generate a new bearer token? Any existing token for this user will be invalidated.',
        )
      )
        return;
      const { ok, data } = await apiFetch(`/api/users/${userId}/token`, { method: 'POST' });
      if (ok) {
        panel.querySelector('#usersTokenResult').innerHTML = renderTokenResult(data.token);
        await loadAndRender(panel, currentUserId);
      } else {
        alert(`Failed: ${data.error ?? 'unknown error'}`);
      }
    }

    if (action === 'revoke-token') {
      if (!confirm('Revoke this token? The user will need a new one to use the API.')) return;
      await apiFetch(`/api/users/${userId}/token`, { method: 'DELETE' });
      panel.querySelector('#usersTokenResult').innerHTML = '';
      await loadAndRender(panel, currentUserId);
    }

    if (action === 'delete') {
      const username = row.querySelector('td')?.textContent?.trim().split(' ')[0];
      if (!confirm(`Delete user "${username}"? This cannot be undone.`)) return;
      const { ok, data } = await apiFetch(`/api/users/${userId}`, { method: 'DELETE' });
      if (ok) await loadAndRender(panel, currentUserId);
      else alert(`Failed: ${data.error ?? 'unknown error'}`);
    }
  });

  // Add user form
  panel.querySelector('#usersAddForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const username = form.querySelector('[name=username]').value.trim();
    const password = form.querySelector('[name=password]').value;
    const role = form.querySelector('[name=role]').value;
    const err = panel.querySelector('#usersAddError');
    err.textContent = '';

    const { ok, data } = await apiFetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, role }),
    });

    if (ok) {
      form.reset();
      await loadAndRender(panel, currentUserId);
    } else {
      err.textContent = data.error ?? 'Failed to create user';
    }
  });
}
