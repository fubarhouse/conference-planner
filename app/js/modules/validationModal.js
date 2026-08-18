// Shared, self-contained schema-validation error UI, used by both the editor
// (dataset saves) and the planner ("save to file" server sync). Deliberately
// styled with inline styles rather than utility/component classes: it must look
// identical on the dark planner and the (differently-styled) editor, and the
// editor does not load planner.css. Pure helpers (humanizeValidationErrors) are
// exported separately so they can be unit-tested without a DOM.

/** @param {string} s */
function esc(s) {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

// Turn a raw AJV pointer (v6 dotted `.a.b[0].c`, v7 pointer `/a/b/0/c`, or the
// server's pre-mapped `.a.b`) into a friendly breadcrumb: `a › b › item 1 › c`.
/** @param {string} raw */
function prettifyPath(raw) {
  if (!raw || raw === '(root)') return '';
  const norm = String(raw)
    .replace(/\//g, '.')
    .replace(/\[(\d+)\]/g, '.$1');
  return norm
    .split('.')
    .filter(Boolean)
    .map((seg) => (/^\d+$/.test(seg) ? `item ${Number(seg) + 1}` : seg))
    .join(' › ');
}

/** @param {string|string[]} t */
function formatTypes(t) {
  const arr = Array.isArray(t) ? t : String(t).split(',');
  const words = arr.map(
    (x) =>
      ({
        null: 'empty',
        object: 'an object',
        array: 'a list',
        string: 'text',
        number: 'a number',
        integer: 'a whole number',
        boolean: 'true or false',
      })[x.trim()] || x.trim(),
  );
  return words.length > 1
    ? `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}`
    : words[0];
}

/** @param {any} e - an AJV-style error object */
function humanMessage(e) {
  const p = e.params || {};
  switch (e.keyword) {
    case 'type':
      return `should be ${formatTypes(p.type)}`;
    case 'required':
      return `is missing the required field "${p.missingProperty}"`;
    case 'enum':
      return `should be one of: ${(p.allowedValues || []).join(', ')}`;
    case 'additionalProperties':
      return `has an unexpected field "${p.additionalProperty}"`;
    case 'minItems':
      return `should have at least ${p.limit} item${p.limit === 1 ? '' : 's'}`;
    case 'minLength':
      return p.limit === 1 ? 'should not be empty' : `should be at least ${p.limit} characters`;
    case 'pattern':
      return 'is not in the expected format';
    default:
      return e.message || 'is invalid';
  }
}

/**
 * Normalize AJV errors (from either the client dataset validator or the server
 * planner validator) into friendly `{ location, message }` rows.
 * @param {any[]} [errors]
 * @returns {{ location: string, message: string }[]}
 */
export function humanizeValidationErrors(errors = []) {
  return (errors || []).map((e) => ({
    location: prettifyPath(e.path ?? e.dataPath ?? e.instancePath ?? ''),
    message: humanMessage(e),
  }));
}

let _openModal = null;

/**
 * Show a styled modal listing schema-validation problems.
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} [opts.intro]
 * @param {any[]} opts.errors - raw AJV-style errors
 */
export function showValidationErrorModal({ title, intro, errors }) {
  if (typeof document === 'undefined') return;
  _openModal?.remove();
  const rows = humanizeValidationErrors(errors);
  const shown = rows.slice(0, 40);
  const overflow = rows.length - shown.length;

  const overlay = document.createElement('div');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;' +
    'padding:20px;background:rgba(15,23,42,.55);backdrop-filter:blur(2px);' +
    "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;";

  const listHtml = shown
    .map(
      (r) =>
        `<li style="padding:10px 12px;border:1px solid #fee2e2;background:#fff7f7;border-radius:8px;margin-bottom:8px;list-style:none">
          <div style="font-size:13px;font-weight:600;color:#991b1b">${esc(r.message)}</div>
          ${r.location ? `<div style="font-size:11px;color:#6b7280;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;margin-top:3px">${esc(r.location)}</div>` : ''}
        </li>`,
    )
    .join('');

  overlay.innerHTML = `
    <div style="background:#fff;color:#1f2937;border-radius:14px;max-width:560px;width:100%;max-height:82vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 50px rgba(0,0,0,.35)">
      <div style="display:flex;align-items:flex-start;gap:12px;padding:18px 20px;border-bottom:1px solid #f1f5f9">
        <div style="flex-shrink:0;width:36px;height:36px;border-radius:50%;background:#fef2f2;display:flex;align-items:center;justify-content:center">
          <i class="fas fa-triangle-exclamation" style="color:#dc2626;font-size:15px"></i>
        </div>
        <div style="flex:1;min-width:0">
          <h2 style="margin:0;font-size:16px;font-weight:700;color:#111827">${esc(title)}</h2>
          ${intro ? `<p style="margin:4px 0 0;font-size:13px;color:#6b7280;line-height:1.4">${esc(intro)}</p>` : ''}
        </div>
        <button type="button" data-vm-close aria-label="Close" style="flex-shrink:0;border:none;background:transparent;color:#9ca3af;font-size:18px;cursor:pointer;line-height:1;padding:2px">&times;</button>
      </div>
      <ul style="margin:0;padding:16px 20px;overflow-y:auto;flex:1">
        ${listHtml || '<li style="list-style:none;color:#6b7280;font-size:13px">No further detail available.</li>'}
        ${overflow > 0 ? `<li style="list-style:none;color:#6b7280;font-size:12px;padding-top:4px">… and ${overflow} more</li>` : ''}
      </ul>
      <div style="padding:14px 20px;border-top:1px solid #f1f5f9;display:flex;justify-content:flex-end">
        <button type="button" data-vm-close style="background:#111827;color:#fff;border:none;border-radius:8px;padding:8px 18px;font-size:13px;font-weight:600;cursor:pointer">Close</button>
      </div>
    </div>`;

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    if (_openModal === overlay) _openModal = null;
  };
  const onKey = (/** @type {KeyboardEvent} */ ev) => {
    if (ev.key === 'Escape') close();
  };
  overlay.addEventListener('click', (ev) => {
    if (
      ev.target === overlay ||
      (ev.target instanceof Element && ev.target.closest('[data-vm-close]'))
    )
      close();
  });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  _openModal = overlay;
}
