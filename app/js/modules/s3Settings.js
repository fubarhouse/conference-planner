// Wires up S3 save/get/advanced UI. Call initS3Settings() once the DOM is ready.
// Expects elements with IDs: s3StatusChip, s3NotConfigured, s3ConfigDisplay,
// s3SaveBtn, s3GetBtn, s3AdvancedToggle, s3AdvancedPanel,
// s3ImportBtn, s3UploadPlannerInput, s3ClearBtn, s3MirrorBtn (planner only),
// s3Progress, s3Result.

function apiBase() {
  const stored = (localStorage.getItem('editorApiEndpoint') || '').replace(/\/$/, '');
  return stored || window.location.origin;
}

async function s3Fetch(path, opts = {}) {
  const res = await fetch(`${apiBase()}${path}`, opts);
  const data = await res.json().catch(() => ({ error: res.statusText }));
  return { ok: res.ok, status: res.status, data };
}

function el(id) { return document.getElementById(id); }

const RESULT_STYLES = {
  success: 'background:#dcfce7;color:#14532d;border:1px solid #86efac',
  error:   'background:#fee2e2;color:#7f1d1d;border:1px solid #fca5a5',
  warn:    'background:#fef3c7;color:#78350f;border:1px solid #fcd34d',
  info:    'background:#f1f5f9;color:#1e293b;border:1px solid #cbd5e1',
};

function setResult(html, type = 'info') {
  const div = el('s3Result');
  if (!div) return;
  div.className = 'text-xs rounded-md px-3 py-2.5 s3-result';
  div.setAttribute('style', RESULT_STYLES[type] ?? RESULT_STYLES.info);
  div.innerHTML = html;
  div.classList.remove('hidden');
}

function clearResult() {
  const div = el('s3Result');
  if (div) { div.innerHTML = ''; div.classList.add('hidden'); }
}

function setStatusChip(connected, label) {
  const chip = el('s3StatusChip');
  if (!chip) return;
  chip.className = connected
    ? 'inline-flex items-center gap-1.5 text-xs font-medium text-green-700'
    : 'inline-flex items-center gap-1.5 text-xs font-medium text-red-600';
  chip.innerHTML = connected
    ? `<span class="inline-block w-1.5 h-1.5 rounded-full bg-green-500"></span>${escHtml(label)}`
    : `<span class="inline-block w-1.5 h-1.5 rounded-full bg-red-500"></span>${escHtml(label)}`;
}

function formatSyncResult(data, direction) {
  const { pushed, pulled, skipped, conflicts = [], errors = [] } = {
    pushed: data.pushed ?? [],
    pulled: data.pulled ?? [],
    ...data,
  };
  const transferred = direction === 'push' ? pushed : pulled;
  const lines = [];

  if (transferred.length)
    lines.push(`<span class="font-medium">${transferred.length} file${transferred.length !== 1 ? 's' : ''} ${direction === 'push' ? 'saved to cloud' : 'retrieved from cloud'}.</span>`);
  if (skipped?.length)
    lines.push(`${skipped.length} already up to date.`);

  if (conflicts.length) {
    lines.push(`<span class="font-semibold text-amber-700">⚠ ${conflicts.length} conflict${conflicts.length !== 1 ? 's' : ''}:</span>`);
    conflicts.forEach(c => lines.push(`&nbsp;&nbsp;• ${escHtml(c.path)} <span class="text-gray-500">(${c.reason ?? 'conflict'})</span>`));
    lines.push(
      `<div class="flex gap-2 mt-1.5">` +
      `<button data-s3-force="${direction}" class="h-7 px-2.5 rounded border border-amber-700 text-amber-900 bg-amber-100 hover:bg-amber-200 transition-colors text-xs font-medium">` +
      `Force ${direction === 'push' ? 'save' : 'get'}</button></div>`
    );
  }

  if (errors.length) {
    lines.push(`<span class="font-semibold text-red-700">✗ ${errors.length} error${errors.length !== 1 ? 's' : ''}:</span>`);
    errors.forEach(e => lines.push(`&nbsp;&nbsp;• ${escHtml(e.path)}: ${escHtml(e.error)}`));
  }

  if (!lines.length) lines.push('Everything is already up to date.');

  const type = errors.length ? 'error' : conflicts.length ? 'warn' : 'success';
  return { html: lines.join('<br>'), type };
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function loadConfig() {
  const { ok, data } = await s3Fetch('/api/s3/config');
  const notConfigured = el('s3NotConfigured');
  const configDisplay = el('s3ConfigDisplay');
  const saveBtn = el('s3SaveBtn');
  const getBtn  = el('s3GetBtn');

  if (!ok || !data.configured) {
    notConfigured?.classList.remove('hidden');
    configDisplay?.classList.add('hidden');
    [saveBtn, getBtn, el('s3MirrorBtn')].forEach(b => b?.setAttribute('disabled', ''));
    setStatusChip(false, 'Not configured');
    return;
  }

  notConfigured?.classList.add('hidden');
  if (configDisplay) {
    configDisplay.innerHTML =
      `Bucket: <span class="text-gray-700 font-medium">${escHtml(data.bucket)}</span><br>` +
      `Region: <span class="text-gray-700">${escHtml(data.region)}</span>` +
      (data.prefix ? `<br>Prefix: <span class="text-gray-700">${escHtml(data.prefix)}</span>` : '');
    configDisplay.classList.remove('hidden');
  }
  [saveBtn, getBtn, el('s3MirrorBtn')].forEach(b => b?.removeAttribute('disabled'));

  // Auto-check connection and show status chip
  const test = await s3Fetch('/api/s3/test').catch(() => ({ ok: false, data: { error: 'Connection failed' } }));
  if (test.ok) {
    setStatusChip(true, 'Connected');
  } else {
    setStatusChip(false, 'Not connected');
  }
}

function setBusy(btn, busy) {
  if (!btn) return;
  btn.disabled = busy;
  if (busy) btn.setAttribute('data-s3-busy', '');
  else btn.removeAttribute('data-s3-busy');
  const progress = el('s3Progress');
  if (progress) progress.classList.toggle('hidden', !busy);
}

const PLANNER_PREFIX  = 'drupalconPlanner_';
const PLANNER_GLOBAL  = 'drupalconPlanner_global';
const DELETED_KEY     = 'drupalconPlanner__deleted';

function getTombstone() {
  try {
    const slugs = JSON.parse(localStorage.getItem(DELETED_KEY) || '[]');
    return Array.isArray(slugs)
      ? slugs.map((s) => (s.endsWith('.json') ? s : `${s}.json`))
      : [];
  } catch { return []; }
}

function clearTombstone() {
  localStorage.removeItem(DELETED_KEY);
}

function formatMirrorResult(data) {
  const pushed         = data.pushed         || [];
  const pulled         = data.pulled         || [];
  const deletedFromS3  = data.deletedFromS3  || [];
  const deletedLocally = data.deletedLocally || [];
  const conflicts      = data.conflicts      || [];
  const errors         = data.errors         || [];

  const lines = [];
  if (pushed.length)
    lines.push(`<strong>↑ ${pushed.length} saved to cloud:</strong> ${pushed.map(escHtml).join(', ')}`);
  if (deletedFromS3.length)
    lines.push(`<strong>✕ ${deletedFromS3.length} removed from cloud:</strong> ${deletedFromS3.map(escHtml).join(', ')}`);
  if (pulled.length)
    lines.push(`<span style="opacity:0.6">↓ ${pulled.length} skipped (cloud only — use Get updates to retrieve):</span> ${pulled.map(escHtml).join(', ')}`);

  if (conflicts.length) {
    lines.push(`<strong style="color:#78350f">⚠ ${conflicts.length} conflict${conflicts.length !== 1 ? 's' : ''}:</strong>`);
    conflicts.forEach((c) => lines.push(`&nbsp;&nbsp;• ${escHtml(c.path)} <span style="opacity:0.7">(${escHtml(c.reason ?? 'conflict')})</span>`));
  }
  if (errors.length) {
    lines.push(`<strong style="color:#7f1d1d">✗ ${errors.length} error${errors.length !== 1 ? 's' : ''}:</strong>`);
    errors.forEach((e) => lines.push(`&nbsp;&nbsp;• ${escHtml(e.path)}: ${escHtml(e.error)}`));
  }

  if (!lines.length) lines.push('Everything is already in sync — nothing changed.');

  const type = errors.length ? 'error' : conflicts.length ? 'warn' : 'success';
  return { html: lines.join('<br>'), type };
}

async function flushLocalPlannersToServer() {
  const base = apiBase();
  const saved = [], skipped = [], errors = [];

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(PLANNER_PREFIX) || key === PLANNER_GLOBAL) continue;
    const slug = key.slice(PLANNER_PREFIX.length);
    // Defensive: never write the global planner file regardless of key shape
    if (slug === 'global' || slug === 'global.json') { skipped.push(slug); continue; }
    const filename = slug.endsWith('.json') ? slug : `${slug}.json`;
    let data;
    try { data = JSON.parse(localStorage.getItem(key) || 'null'); } catch {
      errors.push({ slug, reason: 'corrupt JSON in localStorage' }); continue;
    }
    if (!data || typeof data !== 'object') { skipped.push(slug); continue; }
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
          if (res.status === 403) reason += ' — check your account role (editor or admin required) and that /api/* paths are not behind a proxy auth gate';
          if (res.status === 401) reason += ' — session may have expired, try refreshing the page';
        } catch { /* ignore */ }
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

  // Save to cloud: flush browser localStorage planners to server, then push all to S3
  el('s3SaveBtn')?.addEventListener('click', async () => {
    const btn = el('s3SaveBtn');
    setBusy(btn, true);
    clearResult();

    const { saved: flushed, errors: flushErrors } = await flushLocalPlannersToServer();

    const { ok, data } = await s3Fetch('/api/s3/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }).catch(e => ({ ok: false, data: { error: e.message } }));

    if (!ok) {
      setResult(`✗ ${escHtml(data.error ?? 'Save failed')}`, 'error');
    } else {
      const { html, type } = formatSyncResult(data, 'push');
      const extra = flushErrors.length
        ? `<br><span class="text-red-700">⚠ ${flushErrors.length} browser planner${flushErrors.length !== 1 ? 's' : ''} could not be flushed first.</span>`
        : '';
      setResult(html + extra, type);
    }
    setBusy(btn, false);
  });

  // Get updates: pull from S3
  el('s3GetBtn')?.addEventListener('click', async () => {
    const btn = el('s3GetBtn');
    setBusy(btn, true);
    clearResult();
    const { ok, data } = await s3Fetch('/api/s3/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }).catch(e => ({ ok: false, data: { error: e.message } }));

    if (!ok) { setResult(`✗ ${escHtml(data.error ?? 'Get failed')}`, 'error'); }
    else {
      const { html, type } = formatSyncResult(data, 'pull');
      setResult(html, type);
    }
    setBusy(btn, false);
  });

  // Advanced drawer toggle
  el('s3AdvancedToggle')?.addEventListener('click', () => {
    const panel = el('s3AdvancedPanel');
    const chevron = el('s3AdvancedChevron');
    if (!panel) return;
    const isOpen = !panel.classList.contains('hidden');
    panel.classList.toggle('hidden', isOpen);
    if (chevron) chevron.style.transform = isOpen ? '' : 'rotate(90deg)';
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
          if (res.status === 403) reason += ' — check your account role (editor or admin required) and that /api/* paths are not behind a proxy auth gate';
          if (res.status === 401) reason += ' — session may have expired, try refreshing the page';
        } catch { /* ignore */ }
        setResult(`✗ ${escHtml(filename)}: ${escHtml(reason)}`, 'error');
      }
    } catch (err) {
      setResult(`✗ ${escHtml(filename)}: ${escHtml(err.message || 'network error')}`, 'error');
    }

    setBusy(btn, false);
  });

  // Clear browser copies
  el('s3ClearBtn')?.addEventListener('click', () => {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(PLANNER_PREFIX) && key !== PLANNER_GLOBAL) keys.push(key);
    }
    if (!keys.length) { setResult('No planner data found in browser storage.', 'info'); return; }
    if (!confirm(`Remove ${keys.length} planner${keys.length !== 1 ? 's' : ''} from browser storage? This cannot be undone.`)) return;
    keys.forEach(k => localStorage.removeItem(k));
    setResult(`✓ Cleared ${keys.length} planner${keys.length !== 1 ? 's' : ''} from browser storage.`, 'success');
  });

  // Mirror to cloud (planner only): flush browser + push all + process tombstone deletions
  el('s3MirrorBtn')?.addEventListener('click', async () => {
    const tombstone = getTombstone();
    const tombstoneMsg = tombstone.length
      ? `\n• Remove ${tombstone.length} deleted planner${tombstone.length !== 1 ? 's' : ''} from cloud storage`
      : '';
    if (!confirm(
      'Mirror to cloud will:\n' +
      '• Save all local planners to cloud storage' +
      tombstoneMsg + '\n\n' +
      'Planners in cloud storage that do not exist locally will not be touched — use Get updates to retrieve those first.\n\n' +
      'This cannot be undone. Continue?'
    )) return;

    const btn = el('s3MirrorBtn');
    setBusy(btn, true);
    clearResult();

    const base = apiBase();
    const pushed = [], pushErrors = [], deleted = [], deleteErrors = [];

    const { saved, errors: writeErrors } = await flushLocalPlannersToServer();
    pushed.push(...saved);
    pushErrors.push(...writeErrors);

    for (const filename of tombstone) {
      try {
        const res = await fetch(`${base}/api/planner/${encodeURIComponent(filename)}`, { method: 'DELETE' });
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
      try {
        const remaining = JSON.parse(localStorage.getItem(DELETED_KEY) || '[]')
          .filter((s) => {
            const f = s.endsWith('.json') ? s : `${s}.json`;
            return !deleted.includes(f);
          });
        localStorage.setItem(DELETED_KEY, JSON.stringify(remaining));
      } catch {}
    }

    const { html, type } = formatMirrorResult({
      pushed,
      deletedFromS3: deleted,
      conflicts: [],
      errors: [
        ...pushErrors.map((e) => ({ path: e.slug, error: e.reason })),
        ...deleteErrors,
      ],
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
    }).catch(e => ({ ok: false, data: { error: e.message } }));
    if (!ok) { setResult(`✗ ${escHtml(data.error ?? `Force ${direction} failed`)}`, 'error'); }
    else {
      const { html, type } = formatSyncResult(data, direction);
      setResult(html, type);
    }
  });
}
