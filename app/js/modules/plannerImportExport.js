// Planner export / import — download the current planner as JSON, import a
// planner JSON file (merging any embedded global team members), and save to the
// API server when configured. Extracted from planner.js: state + renderAll are
// injected via initImportExport(); storage/notify helpers are imported directly.

import {
  exportPlannerJson,
  parsePlannerImport,
  savePlanner,
  savePlannerViaApi,
  saveGlobal,
  readText,
  readJson,
  writeJson,
  plannerFilename,
  STORAGE_KEYS,
} from './plannerStorage.js';
import { escapeHtml as esc } from './utils.js';
import { showToast, reportError } from './notify.js';
import { showValidationErrorModal } from './validationModal.js';
import { showModal, hideModal } from './modal.js';
import { buildTripCalEvents, buildIcsCalendar } from './plannerCalendar.js';

// ── Injected planner collaborators ────────────────────────────────────────────
let state;
let renderAll;
let getTimezone;

export function initImportExport(deps) {
  ({ state, renderAll, getTimezone } = deps);
}

export function handleExport() {
  exportPlannerJson(state.plannerKey, state.planner);
}

// ── Calendar export (whole-trip .ics) ────────────────────────────────────────
const CAL_INCLUDE_KEY = 'cp:calexport:include';
const DEFAULT_INCLUDE = { travel: true, stays: true, items: true, hosted: true, sessions: true };
const CAL_TOGGLES = [
  ['calIncTravel', 'travel'],
  ['calIncStays', 'stays'],
  ['calIncItems', 'items'],
  ['calIncHosted', 'hosted'],
  ['calIncSessions', 'sessions'],
];

// Open the "Add to calendar" modal, restoring the last-used category toggles.
export function openCalendarExportModal() {
  const inc = { ...DEFAULT_INCLUDE, ...(readJson(CAL_INCLUDE_KEY) || {}) };
  for (const [id, key] of CAL_TOGGLES) {
    const el = document.getElementById(id);
    if (el) el.checked = inc[key] !== false;
  }
  renderSubscribeSection();
  showModal('calendarExportModal');
}

// ── Subscribe (live calendar feeds) ──────────────────────────────────────────
// Subscriptions are minted, listed and revoked on the SERVER
// (/api/planner/<slug>/feeds). The token needs the server's CSPRNG, and only its
// SHA-256 is ever stored — so the plaintext exists once, in the mint response,
// and this module's job is to put it in front of the reader at that moment and
// never pretend it can be recovered later.
//
// The previous version generated a UUID in the browser, kept it in the planner
// JSON and re-displayed it forever. That token could fall back to Math.random()
// outside a secure context, and anyone who could read the planner file could
// subscribe.

function plannerSlug() {
  // The feed path uses the planner's file slug, which is what the server reads.
  return state.plannerKey ? plannerFilename(state.plannerKey).replace(/\.json$/, '') : '';
}

function feedApi(path = '') {
  const slug = plannerSlug();
  return slug ? `/api/planner/${encodeURIComponent(slug)}/feeds${path}` : '';
}

function relativeWhen(iso) {
  if (!iso) return 'never used';
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
  if (!Number.isFinite(days)) return 'never used';
  if (days <= 0) return 'used today';
  if (days === 1) return 'used yesterday';
  if (days < 30) return `used ${days} days ago`;
  return `used ${Math.floor(days / 30)} months ago`;
}

// Every device subscribed to this trip. No secrets — the server does not hold
// them either.
export async function renderSubscribeSection() {
  const list = document.getElementById('calSubList');
  if (!list) return;
  const url = feedApi();
  if (!url) return;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(String(res.status));
    const { feeds = [] } = await res.json();
    list.innerHTML = feeds.length
      ? feeds
          .map(
            (f) => `<li class="cal-sub-item">
              <span class="cal-sub-item-name">${esc(f.label)}</span>
              <span class="cal-sub-item-meta">${esc(relativeWhen(f.lastUsedAt))}${
                f.lastAgent ? ` · ${esc(f.lastAgent)}` : ''
              }</span>
              <button type="button" class="cal-sub-mini cal-sub-mini--danger"
                data-revoke-feed="${esc(f.id)}">Revoke</button>
            </li>`,
          )
          .join('')
      : '<li class="cal-sub-empty">No devices subscribed.</li>';
  } catch {
    // Served as static files, or not signed in — the panel simply has nothing
    // to manage rather than showing an error the reader cannot act on.
    list.innerHTML = '<li class="cal-sub-empty">Subscriptions need the server.</li>';
  }
}

// Mint a subscription and reveal it once.
export async function createFeedToken() {
  const url = feedApi();
  if (!url) return;
  const labelEl = document.getElementById('calSubLabel');
  const label = labelEl?.value?.trim() || 'Calendar';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || String(res.status));
    const feed = await res.json();
    const https = `${window.location.origin}${feed.url}`;
    const box = document.getElementById('calSubNew');
    const input = document.getElementById('calSubUrl');
    const open = document.getElementById('calSubOpen');
    if (input) input.value = https;
    if (open) open.href = https.replace(/^https?:/, 'webcal:');
    box?.classList.remove('hidden');
    if (labelEl) labelEl.value = '';
    await renderSubscribeSection();
    showToast('Link created — copy it now, it will not be shown again.');
  } catch (e) {
    showToast(`Could not create the link: ${e.message}`);
  }
}

// Revoke one subscription. Reaches the server (and S3) immediately, so a leaked
// link stops working now rather than after someone remembers to push.
export async function revokeFeedToken(id) {
  const url = feedApi(`/${encodeURIComponent(id)}`);
  if (!url) return;
  try {
    const res = await fetch(url, { method: 'DELETE' });
    if (!res.ok) throw new Error(String(res.status));
    document.getElementById('calSubNew')?.classList.add('hidden');
    await renderSubscribeSection();
    showToast('Subscription revoked.');
  } catch (e) {
    showToast(`Could not revoke: ${e.message}`);
  }
}

// Briefly swap a button to a "Copied" confirmation, then restore it.
function flashCopied(btn) {
  if (!btn) return;
  if (!btn.dataset.label) btn.dataset.label = btn.innerHTML;
  btn.innerHTML = '<i class="fas fa-check" aria-hidden="true"></i>Copied';
  btn.classList.add('is-copied');
  clearTimeout(btn._copyTimer);
  btn._copyTimer = setTimeout(() => {
    btn.innerHTML = btn.dataset.label;
    btn.classList.remove('is-copied');
  }, 1600);
}

export async function copyFeedUrl() {
  // Reads the field rather than rebuilding the URL: after a mint the plaintext
  // token exists only in that input, and nowhere else in the app.
  const input = document.getElementById('calSubUrl');
  const url = input?.value || '';
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    flashCopied(document.getElementById('calSubCopy'));
  } catch {
    // No clipboard access (e.g. insecure context) — select the link so it can be
    // copied by hand, and say so.
    document.getElementById('calSubUrl')?.select();
    showToast('Select the link and copy it.');
  }
}

// Build the selected calEvents → .ics and download it. Remembers the toggles.
export function downloadTripIcs() {
  const include = {};
  for (const [id, key] of CAL_TOGGLES) include[key] = !!document.getElementById(id)?.checked;
  writeJson(CAL_INCLUDE_KEY, include);

  const events = buildTripCalEvents(state.planner, {
    allSessions: state.allSessions || [],
    timezone: getTimezone?.() || '',
    include,
  });
  if (!events.length) {
    showToast('Nothing to export — enable a category with items on your trip.');
    return;
  }
  const calName = (state.planner?._displayName || '').trim() || 'My trip';
  const ics = buildIcsCalendar(events, { calName, uidFor: (ev) => ev.uid });
  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${calName.replace(/[^a-z0-9-]+/gi, '-').toLowerCase() || 'trip'}.ics`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  hideModal('calendarExportModal');
  showToast(`${events.length} item${events.length === 1 ? '' : 's'} exported to .ics`);
}

// Fold any global team members embedded in an imported planner into state.global.
export function mergeGlobalTeamMembers(plannerObj) {
  if (!Array.isArray(plannerObj._globalTeamMembers) || !plannerObj._globalTeamMembers.length)
    return;
  const existingIds = new Set((state.global.teamMembers || []).map((m) => m.id));
  plannerObj._globalTeamMembers.forEach((m) => {
    if (m?.id && !existingIds.has(m.id)) {
      (state.global.teamMembers ??= []).push(m);
      existingIds.add(m.id);
    }
  });
  saveGlobal(state.global);
  delete plannerObj._globalTeamMembers;
}

export function handleImport(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const parsed = parsePlannerImport(e.target.result);
      mergeGlobalTeamMembers(parsed);
      state.planner = parsed;
      // Preserve current plannerKey — imported data is merged into current slot
      renderAll();
      savePlanner(state.plannerKey, state.planner);
      showToast();
    } catch (err) {
      window.alert(`Import failed: ${err.message}`);
    }
  };
  reader.readAsText(file);
}

export async function handleSaveToFile() {
  // Default to the same-origin server that's hosting the app; only use a
  // configured endpoint to target a different/remote server. Opened as a static
  // file (file://) there's no server to save to.
  const apiEndpoint = readText(STORAGE_KEYS.editorApiEndpoint) || '';
  if (!apiEndpoint && window.location.protocol === 'file:') {
    window.alert(
      'No server available to save to. Open the planner through the app server (or the editor) and try again.',
    );
    return;
  }
  const btn = document.getElementById('plannerSaveFileBtn');
  if (btn) btn.disabled = true;
  try {
    await savePlannerViaApi(apiEndpoint, state.plannerKey, state.planner);
    showToast();
  } catch (err) {
    if (err.errors?.length) {
      showValidationErrorModal({
        title: "Couldn't save this planner",
        intro: `It has ${err.errors.length} issue${err.errors.length === 1 ? '' : 's'} that need fixing before it can be saved to the server:`,
        errors: err.errors,
      });
    } else {
      reportError('saveToFile', err, {
        toast: true,
        message: `Save failed${err.status ? ` (HTTP ${err.status})` : ''}: ${err.message}`,
      });
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}
