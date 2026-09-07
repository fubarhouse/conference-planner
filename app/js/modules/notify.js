// Shared user-facing notifications + error reporting.
//
// This is the single channel for toasts and for surfacing errors. Before this
// module, toast helpers lived inline in planner.js and errors were swallowed by
// bare `catch {}` blocks. Route failures through reportError() so they are always
// logged (and optionally shown to the user) instead of disappearing silently.

import { escapeHtml } from './utils.js';

// ── Save toast ────────────────────────────────────────────────────────────────

let _toastTimer = null;

// Briefly show the "saved" toast. `id` targets a pre-existing element in the page
// (defaults to the planner's save toast) so styling/markup stays in the HTML.
export function showToast(id = 'plannerSaveToast', duration = 2500) {
  const el = document.getElementById(id);
  if (!el) return;
  clearTimeout(_toastTimer);
  el.classList.add('is-visible');
  _toastTimer = setTimeout(() => el.classList.remove('is-visible'), duration);
}

// ── Soft-delete undo toast ────────────────────────────────────────────────────

let _undoTimer = null;
let _undoToastEl = null;

export function showUndoToast(label, undoFn) {
  if (_undoTimer) clearTimeout(_undoTimer);
  if (!_undoToastEl) {
    _undoToastEl = document.createElement('div');
    _undoToastEl.id = 'plannerUndoToast';
    document.body.appendChild(_undoToastEl);
  }
  _undoToastEl.className =
    'fixed bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-3 bg-gray-900 text-white text-sm px-4 py-2.5 rounded-full shadow-lg z-[9999] opacity-0 translate-y-1 transition-all duration-200 pointer-events-none';
  _undoToastEl.innerHTML = `<span>${escapeHtml(label)} deleted</span><button class="planner-undo-btn ml-2 font-semibold pl-accent text-xs underline underline-offset-2 transition-colors">Undo</button>`;
  requestAnimationFrame(() => {
    _undoToastEl.classList.remove('opacity-0', 'translate-y-1', 'pointer-events-none');
    _undoToastEl.classList.add('opacity-100', 'translate-y-0');
  });
  _undoToastEl.querySelector('.planner-undo-btn').addEventListener(
    'click',
    () => {
      undoFn();
      dismissUndoToast();
    },
    { once: true },
  );
  _undoTimer = setTimeout(dismissUndoToast, 5000);
}

function dismissUndoToast() {
  if (_undoTimer) {
    clearTimeout(_undoTimer);
    _undoTimer = null;
  }
  if (!_undoToastEl) return;
  _undoToastEl.classList.add('opacity-0', 'translate-y-1', 'pointer-events-none');
  _undoToastEl.classList.remove('opacity-100', 'translate-y-0');
}

// ── Error toast ───────────────────────────────────────────────────────────────

let _errorTimer = null;
let _errorToastEl = null;

// Transient error toast. Styled to mirror the undo toast so it reads as part of
// the same system; auto-dismisses after `duration`.
function showErrorToast(message, duration = 6000) {
  if (_errorTimer) clearTimeout(_errorTimer);
  if (!_errorToastEl) {
    _errorToastEl = document.createElement('div');
    _errorToastEl.id = 'plannerErrorToast';
    _errorToastEl.setAttribute('role', 'alert');
    document.body.appendChild(_errorToastEl);
  }
  _errorToastEl.className =
    'fixed bottom-6 left-1/2 -translate-x-1/2 flex items-start gap-3 bg-red-900 text-white text-sm px-4 py-2.5 rounded-lg shadow-lg z-[9999] max-w-lg opacity-0 translate-y-1 transition-all duration-200 pointer-events-none';
  _errorToastEl.innerHTML = `<span class="min-w-0 break-words">${escapeHtml(message)}</span>`;
  requestAnimationFrame(() => {
    _errorToastEl.classList.remove('opacity-0', 'translate-y-1');
    _errorToastEl.classList.add('opacity-100', 'translate-y-0');
  });
  _errorTimer = setTimeout(() => {
    if (!_errorToastEl) return;
    _errorToastEl.classList.add('opacity-0', 'translate-y-1');
    _errorToastEl.classList.remove('opacity-100', 'translate-y-0');
  }, duration);
}

// ── Error reporting ─────────────────────────────────────────────────────────

// The single place errors flow through. Always logs with context; optionally
// surfaces a user-facing toast. Use `toast: true` on user-initiated paths
// (save/load/import/export, network fetches) so failures are visible.
export function reportError(context, err, { toast = false, message } = {}) {
  console.error(`[${context}]`, err);
  if (toast) showErrorToast(message || `${context} failed. Please try again.`);
}
