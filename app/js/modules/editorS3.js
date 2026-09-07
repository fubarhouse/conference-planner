// Editor-side S3 sync — pushes/pulls only the editor's content (event datasets +
// sponsor images) via scope='data', so it stays separate from the planner's sync
// (which owns planner state + receipts/documents). Rendered as a section in the
// editor Settings modal. The API base is injected (the editor talks to its
// configured server over same-origin session auth, matching dataset writes).

let apiBase = () => '';

export function initEditorS3(deps) {
  ({ apiBase } = deps);
}

// Markup for the Cloud Sync section, embedded in the editor Settings modal.
export function editorS3SectionHtml() {
  return `
    <section class="es-section">
      <h3 class="es-section-title">Cloud Sync (S3)</h3>
      <p class="es-section-desc">Save or fetch this editor's <strong>event datasets and sponsor images</strong> to/from S3. Planner data is synced separately, from the planner.</p>
      <div id="editorS3NotConfigured" class="hidden text-xs edt-warn edt-surface-2 border edt-rule-warn rounded-lg px-3 py-2 mb-2">
        S3 is not configured on the server.
      </div>
      <div class="flex gap-2 flex-wrap">
        <button type="button" id="editorS3PushBtn" class="h-9 inline-flex items-center justify-center px-4 rounded-md text-sm font-medium edt-surface-ink edt-on-ink transition-colors">
          Save datasets to S3
        </button>
        <button type="button" id="editorS3PullBtn" class="h-9 inline-flex items-center justify-center px-4 rounded-md text-sm font-medium border edt-rule edt-ink-1 edt-surface transition-colors">
          Get datasets from S3
        </button>
      </div>
      <div id="editorS3Result" class="text-xs mt-2" role="status"></div>
    </section>`;
}

// Wire the Cloud Sync buttons (call after the settings modal markup is injected).
export function wireEditorS3() {
  const base = apiBase();
  const resultEl = document.getElementById('editorS3Result');
  const setResult = (msg, ok = true) => {
    if (resultEl)
      resultEl.innerHTML = `<span class="${ok ? 'text-emerald-700' : 'text-red-700'}">${msg}</span>`;
  };

  fetch(`${base}/api/s3/config`)
    .then((r) => r.json())
    .then((cfg) => {
      if (!cfg?.bucket)
        document.getElementById('editorS3NotConfigured')?.classList.remove('hidden');
    })
    .catch(() => {});

  async function sync(path, verb, btnId) {
    const btn = document.getElementById(btnId);
    if (btn) btn.disabled = true;
    setResult('Working…');
    try {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'data' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setResult(`✗ ${data.error || `${verb} failed`}`, false);
      } else {
        const changed = (data.pushed || data.pulled || []).length;
        const conflicts = (data.conflicts || []).length;
        const errors = (data.errors || []).length;
        const bits = [`${changed} file${changed === 1 ? '' : 's'}`];
        if (conflicts) bits.push(`${conflicts} conflict${conflicts === 1 ? '' : 's'}`);
        if (errors) bits.push(`${errors} error${errors === 1 ? '' : 's'}`);
        setResult(`✓ ${verb} complete — ${bits.join(', ')}.`, !conflicts && !errors);
      }
    } catch (e) {
      setResult(`✗ ${e.message}`, false);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  document
    .getElementById('editorS3PushBtn')
    ?.addEventListener('click', () => sync('/api/s3/push', 'Save', 'editorS3PushBtn'));
  document
    .getElementById('editorS3PullBtn')
    ?.addEventListener('click', () => sync('/api/s3/pull', 'Get', 'editorS3PullBtn'));
}
