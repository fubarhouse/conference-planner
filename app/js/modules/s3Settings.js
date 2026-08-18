// Wires up S3 save/get/advanced UI. Call initS3Settings() once the DOM is ready.
// Expects elements with IDs: s3StatusChip, s3NotConfigured, s3ConfigDisplay,
// s3SaveBtn, s3GetBtn, s3AdvancedToggle, s3AdvancedPanel,
// s3ImportBtn, s3UploadPlannerInput, s3ClearBtn, s3MirrorBtn (planner only),
// s3Progress, s3Result.

import {
  STORAGE_PREFIX,
  GLOBAL_KEY,
  STORAGE_KEYS,
  readJson,
  writeJson,
  readText,
  removeKey,
  listKeys,
} from './plannerStorage.js';

function apiBase() {
  const stored = (readText(STORAGE_KEYS.editorApiEndpoint) || '').replace(/\/$/, '');
  return stored || window.location.origin;
}

async function s3Fetch(path, opts = {}) {
  const res = await fetch(`${apiBase()}${path}`, opts);
  const data = await res.json().catch(() => ({ error: res.statusText }));
  return { ok: res.ok, status: res.status, data };
}

function el(id) {
  return document.getElementById(id);
}

// Append a timestamped entry to the activity-log console (#s3Result). The console
// is append-only + self-scrolling, so results accumulate in a fixed panel rather
// than replacing an ephemeral message and shoving the layout around.
function setResult(html, type = 'info') {
  const div = el('s3Result');
  if (!div) return;
  div.querySelector('.s3-logs-empty')?.remove();
  const entry = document.createElement('div');
  entry.className = `s3-log s3-log--${type}`;
  const time = new Date().toLocaleTimeString(undefined, { hour12: false });
  entry.innerHTML = `<span class="s3-log-time">${time}</span><span class="s3-log-body">${html}</span>`;
  div.appendChild(entry);
  div.scrollTop = div.scrollHeight;
}

// Kept for call-site compatibility: the log is a persistent history, so starting
// a new action no longer wipes it (a manual "Clear" button empties it instead).
function clearResult() {}

function setStatusChip(connected, label) {
  const chip = el('s3StatusChip');
  if (!chip) return;
  const stateCls = connected ? 'ok' : label === 'Not configured' ? 'off' : 'warn';
  const icon = connected
    ? 'fa-cloud'
    : stateCls === 'off'
      ? 'fa-cloud-slash'
      : 'fa-triangle-exclamation';
  chip.className = `s3-status s3-status--${stateCls}`;
  chip.innerHTML = `<span class="s3-status-ic"><i class="fas ${icon}"></i></span><span class="s3-status-label">${escHtml(label)}</span>`;
}

function formatSyncResult(data, direction) {
  const {
    pushed,
    pulled,
    skipped,
    conflicts = [],
    errors = [],
  } = {
    pushed: data.pushed ?? [],
    pulled: data.pulled ?? [],
    ...data,
  };
  const transferred = direction === 'push' ? pushed : pulled;
  const lines = [];

  if (transferred.length)
    lines.push(
      `<span class="font-medium">${transferred.length} file${transferred.length !== 1 ? 's' : ''} ${direction === 'push' ? 'saved to cloud' : 'retrieved from cloud'}.</span>`,
    );
  if (skipped?.length) lines.push(`${skipped.length} already up to date.`);

  if (conflicts.length) {
    lines.push(
      `<span class="font-semibold pl-warn">⚠ ${conflicts.length} conflict${conflicts.length !== 1 ? 's' : ''}:</span>`,
    );
    conflicts.forEach((c) =>
      lines.push(
        `&nbsp;&nbsp;• ${escHtml(c.path)} <span class="pl-ink-2">(${c.reason ?? 'conflict'})</span>`,
      ),
    );
    lines.push(
      `<div class="flex gap-2 mt-1.5">` +
        `<button data-s3-force="${direction}" class="h-7 px-2.5 rounded border pl-rule-warn pl-warn pl-surface-2 transition-colors text-xs font-medium">` +
        `Force ${direction === 'push' ? 'save' : 'get'}</button></div>`,
    );
  }

  if (errors.length) {
    lines.push(
      `<span class="font-semibold pl-req">✗ ${errors.length} error${errors.length !== 1 ? 's' : ''}:</span>`,
    );
    errors.forEach((e) => lines.push(`&nbsp;&nbsp;• ${escHtml(e.path)}: ${escHtml(e.error)}`));
  }

  if (!lines.length) lines.push('Everything is already up to date.');

  const type = errors.length ? 'error' : conflicts.length ? 'warn' : 'success';
  return { html: lines.join('<br>'), type };
}

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// A generation token so a slow/stale run (e.g. a transient boot-time probe) can
// never write its result over a newer one — the source of the contradictory
// "Connected" + "not configured" state.
let _cfgGen = 0;

// Exported so the settings modal can re-check on every open — initS3Settings only
// runs once at page load, and the S3 probe can be transiently unavailable at boot.
export async function loadConfig() {
  const gen = ++_cfgGen;

  // Resolve BOTH probes first, then paint the whole section once — atomically —
  // so the status, config, not-configured notice and buttons can never disagree.
  const cfg = await s3Fetch('/api/s3/config');
  if (gen !== _cfgGen) return; // superseded by a newer run
  const data = cfg.data || {};
  const configured = !!cfg.ok && !!data.configured;

  let connected = false;
  if (configured) {
    const test = await s3Fetch('/api/s3/test').catch(() => ({ data: { ok: false } }));
    if (gen !== _cfgGen) return; // superseded
    connected = !!test.data?.ok;
  }

  const notConfigured = el('s3NotConfigured');
  const configDisplay = el('s3ConfigDisplay');
  const buttons = [el('s3SaveBtn'), el('s3GetBtn'), el('s3MirrorBtn')];

  notConfigured?.classList.toggle('hidden', configured); // notice ONLY when not configured
  if (configDisplay) {
    if (configured) {
      configDisplay.innerHTML =
        `Bucket: <span class="pl-ink-1 font-medium">${escHtml(data.bucket)}</span><br>` +
        `Region: <span class="pl-ink-1">${escHtml(data.region)}</span>` +
        (data.prefix ? `<br>Prefix: <span class="pl-ink-1">${escHtml(data.prefix)}</span>` : '');
    }
    configDisplay.classList.toggle('hidden', !configured); // details ONLY when configured
  }
  // Actions only work when configured AND the connectivity probe passes.
  buttons.forEach((b) => {
    if (b) b.disabled = !(configured && connected);
  });
  setStatusChip(
    connected,
    !configured ? 'Not configured' : connected ? 'Connected' : 'Unavailable',
  );
}

function setBusy(btn, busy) {
  if (!btn) return;
  btn.disabled = busy;
  if (busy) btn.setAttribute('data-s3-busy', '');
  else btn.removeAttribute('data-s3-busy');
  const progress = el('s3Progress');
  if (progress) progress.classList.toggle('hidden', !busy);
}

function getTombstone() {
  const slugs = readJson(STORAGE_KEYS.deletedPlanners, []);
  return Array.isArray(slugs) ? slugs.map((s) => (s.endsWith('.json') ? s : `${s}.json`)) : [];
}

function formatMirrorResult(data) {
  const pushed = data.pushed || [];
  const pulled = data.pulled || [];
  const deletedFromS3 = data.deletedFromS3 || [];
  const conflicts = data.conflicts || [];
  const errors = data.errors || [];

  const lines = [];
  if (pushed.length)
    lines.push(
      `<strong>↑ ${pushed.length} saved to cloud:</strong> ${pushed.map(escHtml).join(', ')}`,
    );
  if (deletedFromS3.length)
    lines.push(
      `<strong>✕ ${deletedFromS3.length} removed from cloud:</strong> ${deletedFromS3.map(escHtml).join(', ')}`,
    );
  if (pulled.length)
    lines.push(
      `<span style="opacity:0.6">↓ ${pulled.length} skipped (cloud only — use Get updates to retrieve):</span> ${pulled.map(escHtml).join(', ')}`,
    );

  if (conflicts.length) {
    lines.push(
      `<strong style="color:#78350f">⚠ ${conflicts.length} conflict${conflicts.length !== 1 ? 's' : ''}:</strong>`,
    );
    conflicts.forEach((c) =>
      lines.push(
        `&nbsp;&nbsp;• ${escHtml(c.path)} <span style="opacity:0.7">(${escHtml(c.reason ?? 'conflict')})</span>`,
      ),
    );
  }
  if (errors.length) {
    lines.push(
      `<strong style="color:#7f1d1d">✗ ${errors.length} error${errors.length !== 1 ? 's' : ''}:</strong>`,
    );
    errors.forEach((e) => lines.push(`&nbsp;&nbsp;• ${escHtml(e.path)}: ${escHtml(e.error)}`));
  }

  if (!lines.length) lines.push('Everything is already in sync — nothing changed.');

  const type = errors.length ? 'error' : conflicts.length ? 'warn' : 'success';
  return { html: lines.join('<br>'), type };
}

async function flushLocalPlannersToServer() {
  const base = apiBase();
  const saved = [],
    skipped = [],
    errors = [];

  for (const key of listKeys(STORAGE_PREFIX)) {
    if (key === GLOBAL_KEY) continue;
    const slug = key.slice(STORAGE_PREFIX.length);
    // Defensive: never write the global planner file regardless of key shape
    if (slug === 'global' || slug === 'global.json') {
      skipped.push(slug);
      continue;
    }
    const filename = slug.endsWith('.json') ? slug : `${slug}.json`;
    const data = readJson(key, null);
    if (data === null) {
      errors.push({ slug, reason: 'corrupt JSON in localStorage' });
      continue;
    }
    if (typeof data !== 'object') {
      skipped.push(slug);
      continue;
    }
    try {
      const res = await fetch(`${base}/api/planner/${filename}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...data, _lastModified: new Date().toISOString() }, null, 2),
      });
      if (res.ok) {
        saved.push(slug);
      } else {
        let reason = `HTTP ${res.status}`;
        try {
          const body = await res.json();
          reason = body.error || reason;
          if (res.status === 403)
            reason +=
              ' — check your account role (editor or admin required) and that /api/* paths are not behind a proxy auth gate';
          if (res.status === 401) reason += ' — session may have expired, try refreshing the page';
        } catch {
          /* ignore */
        }
        errors.push({ slug, reason });
      }
    } catch (e) {
      errors.push({ slug, reason: e.message || 'network error' });
    }
  }
  return { saved, skipped, errors };
}

export function initS3Settings() {
  loadConfig();

  // Clear the activity-log console back to its empty state.
  el('s3LogsClear')?.addEventListener('click', () => {
    const div = el('s3Result');
    if (div)
      div.innerHTML =
        '<p class="s3-logs-empty">No activity yet — Save or Get to sync with the cloud.</p>';
  });

  // Save to cloud: flush browser localStorage planners to server, then push all to S3
  el('s3SaveBtn')?.addEventListener('click', async () => {
    const btn = el('s3SaveBtn');
    setBusy(btn, true);
    setResult('<span class="s3-log-run">Saving to cloud…</span>', 'info');

    const { errors: flushErrors } = await flushLocalPlannersToServer();

    const { ok, data } = await s3Fetch('/api/s3/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'planner' }),
    }).catch((e) => ({ ok: false, data: { error: e.message } }));

    if (!ok) {
      setResult(`✗ ${escHtml(data.error ?? 'Save failed')}`, 'error');
    } else {
      const { html, type } = formatSyncResult(data, 'push');
      const extra = flushErrors.length
        ? `<br><span class="pl-req">⚠ ${flushErrors.length} browser planner${flushErrors.length !== 1 ? 's' : ''} could not be flushed first.</span>`
        : '';
      setResult(html + extra, type);
    }
    setBusy(btn, false);
  });

  // Get updates: pull from S3
  el('s3GetBtn')?.addEventListener('click', async () => {
    const btn = el('s3GetBtn');
    setBusy(btn, true);
    setResult('<span class="s3-log-run">Getting updates…</span>', 'info');
    const { ok, data } = await s3Fetch('/api/s3/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'planner' }),
    }).catch((e) => ({ ok: false, data: { error: e.message } }));

    if (!ok) {
      setResult(`✗ ${escHtml(data.error ?? 'Get failed')}`, 'error');
    } else {
      const { html, type } = formatSyncResult(data, 'pull');
      setResult(html, type);
    }
    setBusy(btn, false);
  });

  // Upload a planner file
  el('s3ImportBtn')?.addEventListener('click', () => {
    el('s3UploadPlannerInput')?.click();
  });

  el('s3UploadPlannerInput')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    clearResult();

    let data;
    try {
      const text = await file.text();
      data = JSON.parse(text);
      if (!data || typeof data !== 'object' || Array.isArray(data))
        throw new Error('not a planner object');
    } catch (err) {
      setResult(`✗ ${escHtml(file.name)}: invalid JSON — ${escHtml(err.message)}`, 'error');
      return;
    }

    const filename = file.name.endsWith('.json') ? file.name : `${file.name}.json`;
    const btn = el('s3ImportBtn');
    setBusy(btn, true);

    try {
      const res = await fetch(`${apiBase()}/api/planner/${filename}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...data, _lastModified: new Date().toISOString() }, null, 2),
      });
      if (res.ok) {
        setResult(`✓ <strong>${escHtml(filename)}</strong> uploaded to cloud.`, 'success');
      } else {
        let reason = `HTTP ${res.status}`;
        try {
          const body = await res.json();
          reason = body.error || reason;
          if (res.status === 403)
            reason +=
              ' — check your account role (editor or admin required) and that /api/* paths are not behind a proxy auth gate';
          if (res.status === 401) reason += ' — session may have expired, try refreshing the page';
        } catch {
          /* ignore */
        }
        setResult(`✗ ${escHtml(filename)}: ${escHtml(reason)}`, 'error');
      }
    } catch (err) {
      setResult(`✗ ${escHtml(filename)}: ${escHtml(err.message || 'network error')}`, 'error');
    }

    setBusy(btn, false);
  });

  // Clear browser copies
  el('s3ClearBtn')?.addEventListener('click', () => {
    const keys = listKeys(STORAGE_PREFIX).filter((key) => key !== GLOBAL_KEY);
    if (!keys.length) {
      setResult('No planner data found in browser storage.', 'info');
      return;
    }
    if (
      !confirm(
        `Remove ${keys.length} planner${keys.length !== 1 ? 's' : ''} from browser storage? This cannot be undone.`,
      )
    )
      return;
    keys.forEach((k) => removeKey(k));
    setResult(
      `✓ Cleared ${keys.length} planner${keys.length !== 1 ? 's' : ''} from browser storage.`,
      'success',
    );
  });

  // Mirror to cloud (planner only): flush browser + push all + process tombstone deletions
  el('s3MirrorBtn')?.addEventListener('click', async () => {
    const tombstone = getTombstone();
    const tombstoneMsg = tombstone.length
      ? `\n• Remove ${tombstone.length} deleted planner${tombstone.length !== 1 ? 's' : ''} from cloud storage`
      : '';
    if (
      !confirm(
        'Mirror to cloud will:\n' +
          '• Save all local planners to cloud storage' +
          tombstoneMsg +
          '\n\n' +
          'Planners in cloud storage that do not exist locally will not be touched — use Get updates to retrieve those first.\n\n' +
          'This cannot be undone. Continue?',
      )
    )
      return;

    const btn = el('s3MirrorBtn');
    setBusy(btn, true);
    clearResult();

    const base = apiBase();
    const pushed = [],
      pushErrors = [],
      deleted = [],
      deleteErrors = [];

    const { saved, errors: writeErrors } = await flushLocalPlannersToServer();
    pushed.push(...saved);
    pushErrors.push(...writeErrors);

    for (const filename of tombstone) {
      try {
        const res = await fetch(`${base}/api/planner/${encodeURIComponent(filename)}`, {
          method: 'DELETE',
        });
        if (res.ok) {
          deleted.push(filename);
        } else {
          deleteErrors.push({ path: filename, error: `HTTP ${res.status}` });
        }
      } catch (e) {
        deleteErrors.push({ path: filename, error: e.message || 'network error' });
      }
    }

    if (deleted.length) {
      const remaining = readJson(STORAGE_KEYS.deletedPlanners, []).filter((s) => {
        const f = s.endsWith('.json') ? s : `${s}.json`;
        return !deleted.includes(f);
      });
      writeJson(STORAGE_KEYS.deletedPlanners, remaining);
    }

    const { html, type } = formatMirrorResult({
      pushed,
      deletedFromS3: deleted,
      conflicts: [],
      errors: [...pushErrors.map((e) => ({ path: e.slug, error: e.reason })), ...deleteErrors],
    });
    setResult(html, type);
    setBusy(btn, false);
  });

  // Force save/get buttons rendered inside the result area
  el('s3Result')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-s3-force]');
    if (!btn) return;
    const direction = btn.dataset.s3Force;
    btn.disabled = true;
    btn.textContent = `${direction === 'push' ? 'Saving' : 'Getting'}…`;
    const { ok, data } = await s3Fetch(`/api/s3/${direction}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: true }),
    }).catch((e) => ({ ok: false, data: { error: e.message } }));
    if (!ok) {
      setResult(`✗ ${escHtml(data.error ?? `Force ${direction} failed`)}`, 'error');
    } else {
      const { html, type } = formatSyncResult(data, direction);
      setResult(html, type);
    }
  });
}
