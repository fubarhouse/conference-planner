// Session feature for the editor — the session list + form rendering (session
// CRUD and quick-edit state remain in editor.js for now). Editor globals are
// injected via initEditorSessions() so this module owns the session rendering
// without importing editor.js. Cross-feature: the session form links sessions to
// sponsors, so it imports the two sponsor-side pickers directly (one-way).

import { escapeHtml, normalizeString } from './utils.js';
import { itemKind } from './sessionKind.js';
import { openMapPicker } from './mapPicker.js';
import { utcIsoToLocalInput, localInputToUtcIso } from './editorDateTime.js';
import { syncSessionDuration, durationToEditorValue } from './editorDuration.js';
import { parseMultiValue } from './editorNormalize.js';
import {
  openSessionSponsorPicker,
  removeSponsorFromSession,
  renderSponsorForm,
} from './editorSponsors.js';

// ── Injected editor collaborators ─────────────────────────────────────────────
let state;
let els;
let SESSION_FIELDS;
let getEventTimezone;
let formatDateHeading;
let isQuickSessionEditEnabled;
let escapeAttr;
let toStringValue;
let getSessionTimingSummary;
let selectSessionForm;
let undoPush;
let moveTrackedIndex;
let markDirty;
let markSessionDirty;
let trackQuickSessionChange;
let syncSessionEditorPanelVisibility;
let syncSessionSaveButton;
let renderFieldIntro;
let fieldDescriptionAttr;
let fieldDescriptionId;
let markdownToHtml;
let scrollToSessionRow;
let saveDataset;
let removeTrackedIndex;
let trackQuickSponsorChange;
let cloneJsonValue;

export function initEditorSessions(deps) {
  ({
    state,
    els,
    SESSION_FIELDS,
    getEventTimezone,
    formatDateHeading,
    isQuickSessionEditEnabled,
    escapeAttr,
    toStringValue,
    getSessionTimingSummary,
    selectSessionForm,
    undoPush,
    moveTrackedIndex,
    markDirty,
    markSessionDirty,
    trackQuickSessionChange,
    syncSessionEditorPanelVisibility,
    syncSessionSaveButton,
    renderFieldIntro,
    fieldDescriptionAttr,
    fieldDescriptionId,
    markdownToHtml,
    scrollToSessionRow,
    saveDataset,
    removeTrackedIndex,
    trackQuickSponsorChange,
    cloneJsonValue,
  } = deps);
}

// ── Session list + form rendering ─────────────────────────────────────────────

export function renderSessionList() {
  const items = state.dataset?.items || [];
  if (items.length === 0) {
    els.sessionList.innerHTML = '<li class="edt-empty">No sessions yet.</li>';
    return;
  }

  const query = String(state.sessionSearchQuery || '')
    .trim()
    .toLowerCase();
  const visibleItems = query
    ? items
        .map((item, index) => ({ item, index }))
        .filter(({ item }) =>
          String(item?.title || '')
            .toLowerCase()
            .includes(query),
        )
    : items.map((item, index) => ({ item, index }));

  if (visibleItems.length === 0) {
    els.sessionList.innerHTML = '<li class="edt-empty">No sessions match this search.</li>';
    return;
  }

  const groups = new Map();
  for (const entry of visibleItems) {
    const local = utcIsoToLocalInput(entry.item?.startTime, getEventTimezone());
    const dateKey = local ? local.slice(0, 10) : '';
    if (!groups.has(dateKey)) groups.set(dateKey, []);
    groups.get(dateKey).push(entry);
  }

  const sortedKeys = [...groups.keys()].sort((a, b) => {
    if (!a) return 1;
    if (!b) return -1;
    return a.localeCompare(b);
  });

  els.sessionList.innerHTML = sortedKeys
    .map((dateKey) => {
      const label = dateKey ? formatDateHeading(dateKey) : 'Unscheduled';
      const header = `<li class="session-date-header edt-rows__day">${escapeHtml(label)}</li>`;
      const rows = groups
        .get(dateKey)
        .map(({ item: rowItem, index: rowIndex }) => {
          const active = rowIndex === state.selectedIndex ? 'is-selected' : '';
          if (isQuickSessionEditEnabled()) {
            const startValue = utcIsoToLocalInput(rowItem?.startTime, getEventTimezone());
            const endValue = utcIsoToLocalInput(rowItem?.endTime, getEventTimezone());
            return `
          <li draggable="true" data-session-index="${rowIndex}" class="session-row edt-row edt-row--expanded ${active}">
            <div class="session-row-expanded-grid">
              <div class="session-row-handle edt-ink-2">
                </div>
              <div class="min-w-0">
                <label class="session-inline-field">
                  <span class="session-inline-label">Title</span>
                  <input
                    data-inline-session-field="title"
                    data-session-index="${rowIndex}"
                    type="text"
                    value="${escapeAttr(toStringValue(rowItem?.title))}"
                    class="edt-field"
                  >
                </label>
              </div>
              <div>
                <label class="session-inline-field">
                  <span class="session-inline-label">Start time</span>
                  <input
                    data-inline-session-field="startTime"
                    data-session-index="${rowIndex}"
                    type="datetime-local"
                    value="${escapeAttr(startValue)}"
                    class="edt-field"
                  >
                </label>
              </div>
              <div>
                <label class="session-inline-field">
                  <span class="session-inline-label">End time</span>
                  <input
                    data-inline-session-field="endTime"
                    data-session-index="${rowIndex}"
                    type="datetime-local"
                    value="${escapeAttr(endValue)}"
                    class="edt-field"
                  >
                </label>
              </div>
              <div class="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  data-open-session-form="${rowIndex}"
                  class="editor-inline-open h-10 inline-flex items-center justify-center px-3 border edt-rule rounded-md text-xs font-medium edt-ink-1 edt-surface transition-colors whitespace-nowrap"
                >
                  <span>Open</span>
                </button>
                <button type="button" data-duplicate-session="${rowIndex}" title="Duplicate session"
                  class="h-10 inline-flex items-center justify-center px-3 border edt-rule rounded-md text-xs font-medium edt-ink-1 edt-surface transition-colors whitespace-nowrap">
                  <span>Duplicate</span>
                </button>
                ${
                  state.sessionListExpanded
                    ? `
                <button type="button" data-move-top="${rowIndex}" title="Send to top"
                  class="h-10 inline-flex items-center justify-center px-2 border edt-rule rounded-md text-xs font-medium edt-ink-1 edt-surface transition-colors">↑↑</button>
                <button type="button" data-move-bottom="${rowIndex}" title="Send to bottom"
                  class="h-10 inline-flex items-center justify-center px-2 border edt-rule rounded-md text-xs font-medium edt-ink-1 edt-surface transition-colors">↓↓</button>
                <button type="button" data-move-to="${rowIndex}" title="Send to position…"
                  class="h-10 inline-flex items-center justify-center px-2 border edt-rule rounded-md text-xs font-medium edt-ink-1 edt-surface transition-colors">#</button>
                `
                    : ''
                }
              </div>
            </div>
          </li>
        `;
          }
          return `
        <li draggable="true" data-session-index="${rowIndex}" class="session-row edt-row ${active}">
          <div class="edt-row__body">
            <div class="min-w-0">
              <div class="edt-row__title">${escapeHtml(`${rowIndex + 1}. ${rowItem?.title ? String(rowItem.title) : '(Untitled session)'}`)}</div>
              <div class="edt-row__meta">${escapeHtml([getSessionTimingSummary(rowItem), rowItem?.location || ''].filter(Boolean).join(' · '))}</div>
            </div>
            <div class="edt-row__acts">
              <button type="button" data-duplicate-session="${rowIndex}" title="Duplicate session"
                class="edt-rowact">
                </button>
              ${
                state.sessionListExpanded
                  ? `
              <button type="button" data-move-top="${rowIndex}" title="Send to top"
                class="edt-rowact">↑↑</button>
              <button type="button" data-move-bottom="${rowIndex}" title="Send to bottom"
                class="edt-rowact">↓↓</button>
              <button type="button" data-move-to="${rowIndex}" title="Send to position…"
                class="edt-rowact">#</button>
              `
                  : ''
              }
            </div>
          </div>
        </li>
      `;
        })
        .join('');
      return header + rows;
    })
    .join('');

  function moveSessionTo(from, to) {
    const items = state.dataset.items;
    const clampedTo = Math.max(0, Math.min(to, items.length - 1));
    if (from === clampedTo) return;
    undoPush();
    const moved = items.splice(from, 1)[0];
    items.splice(clampedTo, 0, moved);
    moveTrackedIndex(state.quickEditSessionChanges, from, clampedTo);
    state.selectedIndex = clampedTo;
    markDirty(true);
    trackQuickSessionChange(clampedTo, true);
    renderSessionList();
    renderSessionForm();
  }

  els.sessionList.querySelectorAll('.session-row').forEach((row) => {
    const index = Number.parseInt(row.dataset.sessionIndex || '-1', 10);

    row.addEventListener('click', async () => {
      if (index === state.selectedIndex) return;
      selectSessionForm(index, { collapseWorkspace: state.sessionListExpanded });
    });

    row.addEventListener('dragstart', (event) => {
      state.draggingIndex = index;
      row.classList.add('opacity-50');
      event.dataTransfer.effectAllowed = 'move';
    });

    row.addEventListener('dragend', () => {
      state.draggingIndex = -1;
      row.classList.remove('opacity-50');
      els.sessionList
        .querySelectorAll('.session-row')
        .forEach((r) => r.classList.remove('is-droptarget'));
    });

    row.addEventListener('dragover', (event) => {
      event.preventDefault();
      row.classList.add('is-droptarget');
    });

    row.addEventListener('dragleave', () => {
      row.classList.remove('is-droptarget');
    });

    row.addEventListener('drop', (event) => {
      event.preventDefault();
      row.classList.remove('is-droptarget');
      const from = state.draggingIndex;
      const to = index;
      if (from < 0 || to < 0 || from === to) return;
      undoPush();
      const moved = state.dataset.items.splice(from, 1)[0];
      state.dataset.items.splice(to, 0, moved);
      moveTrackedIndex(state.quickEditSessionChanges, from, to);
      state.selectedIndex = to;
      markDirty(true);
      trackQuickSessionChange(to, true);
      renderSessionList();
      renderSessionForm();
    });

    row.querySelector('[data-move-top]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      moveSessionTo(index, 0);
    });

    row.querySelector('[data-move-bottom]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      moveSessionTo(index, state.dataset.items.length - 1);
    });

    row.querySelector('[data-move-to]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const total = state.dataset.items.length;
      const input = prompt(`Move to position (1–${total}):`, String(index + 1));
      if (input === null) return;
      const n = parseInt(input, 10);
      if (!isNaN(n)) moveSessionTo(index, n - 1);
    });

    row.querySelector('[data-duplicate-session]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      duplicateSession(index);
    });
  });

  const syncExpandedSelectionState = () => {
    els.sessionList.querySelectorAll('.session-row').forEach((row) => {
      const rowIndex = Number.parseInt(row.dataset.sessionIndex || '-1', 10);
      const isActive = rowIndex === state.selectedIndex;
      // One selection mark for the whole product: a leading brand rule.
      row.classList.toggle('is-selected', isActive);
    });
  };

  els.sessionList.querySelectorAll('[data-inline-session-field]').forEach((input) => {
    const rowIndex = Number.parseInt(input.dataset.sessionIndex || '-1', 10);
    const key = input.dataset.inlineSessionField;

    const selectRow = () => {
      if (rowIndex === state.selectedIndex) return;
      selectSessionForm(rowIndex);
      syncExpandedSelectionState();
    };

    input.addEventListener('click', (event) => {
      event.stopPropagation();
    });

    input.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
    });

    input.addEventListener('focus', async (event) => {
      event.stopPropagation();
      if (isQuickSessionEditEnabled()) {
        undoPush();
        return;
      }
      await selectRow();
    });

    input.addEventListener('input', (event) => {
      event.stopPropagation();
      const item = state.dataset?.items?.[rowIndex];
      if (!item) return;
      const raw = input.value;

      if (key === 'startTime' || key === 'endTime') {
        item[key] = localInputToUtcIso(raw, getEventTimezone());
      } else {
        item[key] = raw;
      }

      markDirty(true);
      trackQuickSessionChange(rowIndex);

      if (rowIndex === state.selectedIndex) {
        renderSessionForm();
      }
    });

    input.addEventListener('change', (event) => {
      event.stopPropagation();
      if (key === 'startTime' || key === 'endTime') {
        renderSessionList();
      }
    });
  });

  els.sessionList.querySelectorAll('[data-open-session-form]').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      const rowIndex = Number.parseInt(button.dataset.openSessionForm || '-1', 10);
      if (rowIndex < 0) return;
      selectSessionForm(rowIndex, { collapseWorkspace: true });
    });
  });
}

function renderSessionField(field, item) {
  const spanClass = field.span === 2 ? 'md:col-span-2' : '';
  const describedBy = fieldDescriptionAttr('session', field.key, field);

  if (field.key === 'sponsorIds') {
    const linkedIds = parseMultiValue(item[field.key] || '');
    const sponsors = state.dataset?.event?.sponsors || [];
    const linkedSponsors = linkedIds.map((id) => sponsors.find((s) => s.id === id)).filter(Boolean);
    const linkedHtml = linkedSponsors.length
      ? `<div class="space-y-2">${linkedSponsors
          .map(
            (sponsor) => `
          <div class="editor-linked-item">
            <div class="editor-linked-item-copy">
              <div class="editor-linked-item-title">${escapeHtml(sponsor.title || sponsor.id)}</div>
              <div class="editor-linked-item-meta">${escapeHtml(sponsor.id)}</div>
            </div>
            <button type="button" class="editor-linked-item-action" data-remove-session-sponsor="${escapeAttr(sponsor.id)}" aria-label="Remove ${escapeAttr(sponsor.title || sponsor.id)}">
              <span>Remove</span>
            </button>
          </div>
        `,
          )
          .join('')}</div>`
      : '';
    return `
      <div class="${spanClass}">
        <div class="rounded-md edt-note px-3 py-3 text-sm edt-ink-1 space-y-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <span class="text-xs edt-ink-2">${linkedSponsors.length ? `${linkedSponsors.length} linked sponsor${linkedSponsors.length === 1 ? '' : 's'}` : 'No sponsors linked yet.'}</span>
            <button id="addLinkedSessionSponsor" type="button" class="h-9 inline-flex items-center justify-center px-3 border edt-rule rounded-md text-xs font-medium edt-ink-1 edt-surface transition-colors whitespace-nowrap">
              Add sponsor
            </button>
          </div>
          ${linkedHtml}
        </div>
        ${field.description ? `<span id="${escapeAttr(fieldDescriptionId('session', field.key))}" class="editor-field-description">${escapeHtml(field.description)}</span>` : ''}
      </div>
    `;
  }

  if (field.type === 'select') {
    // `kind` is a judgement about the item, and the current value has to reflect
    // the older `isAgendaItem` spelling too — otherwise editing a legacy record
    // would silently reset it to "session".
    const current = field.key === 'kind' ? itemKind(item) : toStringValue(item[field.key]);
    const opts = (field.options || [])
      .map(
        (o) =>
          `<option value="${escapeAttr(o.value)}"${o.value === current ? ' selected' : ''}>${escapeHtml(o.label)}</option>`,
      )
      .join('');
    return `
      <label class="editor-form-field ${spanClass}">
        ${renderFieldIntro('session', field.key, field)}
        <select data-session-field="${field.key}" class="w-full rounded-md edt-rule drupal-blue-focus text-sm edt-surface px-3 py-2"${describedBy}>${opts}</select>
      </label>
    `;
  }

  if (field.type === 'checkbox') {
    const checked = item[field.key] === true ? ' checked' : '';
    return `
      <div class="editor-form-field ${spanClass}">
        <label class="editor-check-row">
          <input data-session-field="${field.key}" type="checkbox"${checked} class="editor-check"${describedBy}>
          <span class="editor-check-label">${escapeHtml(field.label)}</span>
        </label>
        ${field.description ? `<span id="${escapeAttr(fieldDescriptionId('session', field.key))}" class="editor-field-description">${escapeHtml(field.description)}</span>` : ''}
      </div>
    `;
  }

  if (field.type === 'textarea') {
    const value = toStringValue(item[field.key]);
    const markdownPreview =
      field.key === 'full_description'
        ? `<div class="mt-2 p-3 rounded-md edt-note">
            <div class="text-xs font-semibold edt-ink-2 mb-2">Markdown Preview</div>
            <div data-md-preview="full_description" class="session-description-preview text-sm edt-ink-1">${markdownToHtml(value)}</div>
          </div>`
        : '';
    return `
      <label class="editor-form-field ${spanClass}">
        ${renderFieldIntro('session', field.key, field)}
          <textarea data-session-field="${field.key}" rows="${field.key.includes('description') ? 7 : 3}" class="w-full rounded-md edt-rule drupal-blue-focus text-sm edt-surface px-3 py-2"${describedBy}>${escapeHtml(
            value,
          )}</textarea>
        ${markdownPreview}
      </label>
    `;
  }

  if (field.type === 'datetime-local') {
    const localValue = utcIsoToLocalInput(item[field.key], getEventTimezone());
    const tzHint =
      field.key === 'startTime'
        ? `<span class="editor-tz-note">Times are shown in <strong>${escapeHtml(getEventTimezone())}</strong></span>`
        : '';
    return `
      <label class="editor-form-field ${spanClass}">
        ${renderFieldIntro('session', field.key, field)}
        ${tzHint}
        <input data-session-field="${field.key}" type="datetime-local" value="${escapeAttr(localValue)}" class="edt-field"${describedBy}>
      </label>
    `;
  }

  const value =
    field.key === 'duration'
      ? durationToEditorValue(syncSessionDuration(item))
      : toStringValue(item[field.key]);
  if (field.key === 'duration') {
    return `
      <label class="editor-form-field ${spanClass}">
        ${renderFieldIntro('session', field.key, field)}
        <input data-session-derived-field="${field.key}" type="text" value="${escapeAttr(value)}" class="w-full h-11 rounded-md edt-rule text-sm edt-surface-2 edt-ink-1 px-3 cursor-not-allowed" readonly tabindex="-1"${describedBy}>
      </label>
    `;
  }
  if (field.key === 'location') {
    const rooms = [
      ...new Set(
        (state.dataset?.items || []).map((s) => normalizeString(s.location)).filter(Boolean),
      ),
    ].sort();
    const datalistHtml = rooms.length
      ? `<datalist id="roomSuggestions">${rooms.map((r) => `<option value="${escapeAttr(r)}">`).join('')}</datalist>`
      : '';
    return `
      <label class="editor-form-field ${spanClass}">
        ${renderFieldIntro('session', field.key, field)}
        <input data-session-field="${field.key}" type="text" value="${escapeAttr(value)}"${rooms.length ? ' list="roomSuggestions"' : ''} class="edt-field"${describedBy}>
        ${datalistHtml}
      </label>
    `;
  }

  return `
    <label class="editor-form-field ${spanClass}">
      ${renderFieldIntro('session', field.key, field)}
      <input data-session-field="${field.key}" type="text" value="${escapeAttr(value)}" class="edt-field"${describedBy}>
    </label>
  `;
}

/**
 * "Held somewhere else" — the session's own venue.
 *
 * Not part of SESSION_FIELDS because it is a nested object with a map behind it,
 * and because it should read as an exception rather than another field everyone
 * has to consider: almost every session is at the conference venue, and the ones
 * that are not (an awards night, a sprint in a sponsor's office) are the story.
 */
function venueFieldHtml(item) {
  const v = item.venue || null;
  const set = !!(v && String(v.name || '').trim());
  const pin =
    set && Number.isFinite(v.latitude) && Number.isFinite(v.longitude)
      ? `${v.latitude.toFixed(5)}, ${v.longitude.toFixed(5)}`
      : '';
  return `
    <div class="editor-form-field md:col-span-2 xl:col-span-3">
      <div class="edt-venue">
        <div class="edt-venue-head">
          <span class="edt-sublabel">Held somewhere else</span>
          <p class="edt-muted">Only for a session away from the event venue — calendar feeds send subscribers here instead. Leave empty otherwise.</p>
        </div>
        ${
          set
            ? `<div class="edt-venue-set">
                 <b>${escapeHtml(v.name)}</b>
                 ${v.address ? `<span>${escapeHtml(v.address)}</span>` : ''}
                 <span class="edt-venue-pin">${pin ? `📍 ${pin}` : 'no pin — feeds will carry the name only'}</span>
               </div>`
            : `<p class="edt-venue-none">At the event venue.</p>`
        }
        <div class="edt-venue-acts">
          <button type="button" class="app-btn" data-venue-pick>${set ? 'Change venue' : 'Find on map'}</button>
          ${set ? `<button type="button" class="app-btn" data-venue-clear>Clear</button>` : ''}
        </div>
      </div>
    </div>`;
}

export function renderSessionForm() {
  const item = state.dataset?.items?.[state.selectedIndex] || null;
  syncSessionEditorPanelVisibility();
  if (!item) {
    els.sessionIndexBadge.textContent = 'No session selected';
    els.sessionForm.innerHTML = '<p class="edt-muted">Select a session on the left to edit it.</p>';
    markSessionDirty(false);
    syncSessionSaveButton();
    return;
  }

  if (isQuickSessionEditEnabled()) {
    els.sessionIndexBadge.textContent = `Session ${state.selectedIndex + 1} of ${state.dataset.items.length}`;
    els.sessionForm.innerHTML = `
      <div class="editor-quick-open-state md:col-span-2">
        <div class="editor-quick-open-card">
          <div class="text-sm font-semibold edt-ink-0 mb-2">${escapeHtml(item?.title || '(Untitled session)')}</div>
          <p class="edt-muted mb-4">This row is selected in quick edit. Open it to switch back to the full form.</p>
          <button type="button" id="openSelectedSessionForm" class="h-10 inline-flex items-center justify-center px-4 border edt-rule rounded-md text-sm font-medium edt-ink-1 edt-surface transition-colors whitespace-nowrap">
            Open session
          </button>
        </div>
      </div>
    `;
    const openButton = document.getElementById('openSelectedSessionForm');
    if (openButton) {
      openButton.addEventListener('click', () => {
        selectSessionForm(state.selectedIndex, { collapseWorkspace: true });
      });
    }
    markSessionDirty(state.sessionDirty);
    syncSessionSaveButton();
    return;
  }

  els.sessionIndexBadge.textContent = `Session ${state.selectedIndex + 1} of ${state.dataset.items.length}`;
  syncSessionSaveButton();
  els.sessionForm.innerHTML =
    SESSION_FIELDS.map((field) => renderSessionField(field, item)).join('') + venueFieldHtml(item);

  els.sessionForm.querySelector('[data-venue-pick]')?.addEventListener('click', () => {
    const ev = state.dataset?.event || {};
    const v = item.venue || {};
    // The conference venue is the reference AND the leash: an offsite session is
    // somewhere in the same city, so the search is confined to 5km of it rather
    // than being allowed to match a namesake on another continent.
    openMapPicker({
      title: 'Where is this session held?',
      searchPlaceholder: 'Search a venue near the conference…',
      lat: Number.isFinite(v.latitude) ? v.latitude : null,
      lon: Number.isFinite(v.longitude) ? v.longitude : null,
      query: v.name || '',
      radiusKm: 5,
      reference: {
        coords:
          Number.isFinite(ev.latitude) && Number.isFinite(ev.longitude)
            ? `${ev.latitude},${ev.longitude}`
            : '',
        query: [ev.venue, ev.location].filter(Boolean).join(', '),
        label: ev.venue || ev.location || 'Conference venue',
      },
      onConfirm: (la, lo, extra) => {
        undoPush();
        const next = { ...(item.venue || {}) };
        next.latitude = la;
        next.longitude = lo;
        // The geocoder's own name is a starting point, not an answer — it returns
        // full postal strings ("SS Rotterdam, 3e Katendrechtse Hoofd, …"), so the
        // first part becomes the name and the rest the address, both editable.
        if (!String(next.name || '').trim() && extra?.label) {
          const parts = String(extra.label)
            .split(',')
            .map((x) => x.trim());
          next.name = parts[0] || 'Venue';
          if (parts.length > 1 && !next.address) next.address = parts.slice(1, 4).join(', ');
        }
        if (!String(next.name || '').trim()) next.name = 'Venue';
        item.venue = next;
        markDirty(true);
        markSessionDirty(true);
        renderSessionForm();
      },
    });
  });

  els.sessionForm.querySelector('[data-venue-clear]')?.addEventListener('click', () => {
    undoPush();
    // Removed entirely, not blanked: absent means "at the event venue", and an
    // empty object would fail validation for want of a name.
    delete item.venue;
    markDirty(true);
    markSessionDirty(true);
    renderSessionForm();
  });

  els.sessionForm.querySelectorAll('[data-session-field]').forEach((input) => {
    input.addEventListener('focus', undoPush);
    input.addEventListener('input', () => {
      const key = input.dataset.sessionField;
      const raw = input.value;

      if (key === 'kind') {
        // "session" is the default; writing it into every item would add a key
        // to thousands of records to say "normal".
        if (raw && raw !== 'session') item.kind = raw;
        else delete item.kind;
      } else if (input.type === 'checkbox') {
        // Only store the flag when it is set. Writing `false` into every session
        // would add a key to thousands of records to say "normal", and the
        // archive already treats "absent" as "judge it by the title".
        if (input.checked) item[key] = true;
        else delete item[key];
      } else if (key === 'track' || key === 'speakers') {
        const values = parseMultiValue(raw);
        item[key] = values.length <= 1 ? values[0] || '' : values;
      } else if (key === 'startTime' || key === 'endTime') {
        const utcIso = localInputToUtcIso(raw, getEventTimezone());
        item[key] = utcIso;
        syncSessionDuration(item);
        const durationField = els.sessionForm.querySelector(
          '[data-session-derived-field="duration"]',
        );
        if (durationField) durationField.value = durationToEditorValue(item.duration);
      } else {
        item[key] = raw;
        if (key === 'full_description') {
          const markdownPreview = els.sessionForm.querySelector(
            '[data-md-preview="full_description"]',
          );
          if (markdownPreview) markdownPreview.innerHTML = markdownToHtml(raw);
        }
      }

      markDirty(true);
      markSessionDirty(true);
      trackQuickSessionChange(state.selectedIndex);
      renderSessionList();
    });
  });

  const addLinkedSponsorButton = els.sessionForm.querySelector('#addLinkedSessionSponsor');
  if (addLinkedSponsorButton) {
    addLinkedSponsorButton.addEventListener('click', () => openSessionSponsorPicker());
  }

  els.sessionForm.querySelectorAll('[data-remove-session-sponsor]').forEach((button) => {
    button.addEventListener('click', () => {
      removeSponsorFromSession(button.dataset.removeSessionSponsor);
    });
  });
}

// ── Session CRUD ──────────────────────────────────────────────────────────────

export async function addSession() {
  if (!state.dataset) return;
  undoPush();
  const seed = state.dataset.items[state.selectedIndex] || {};
  const newItem = {
    title: 'New session',
    startTime: seed.startTime || '',
    endTime: seed.endTime || '',
    location: seed.location || '',
    duration: '',
    track: seed.track || [],
    speakers: [],
    full_description: '',
    sponsorIds: '',
    link: '',
    video_url: '',
  };
  syncSessionDuration(newItem);

  const insertAt = state.selectedIndex >= 0 ? state.selectedIndex + 1 : state.dataset.items.length;
  state.dataset.items.splice(insertAt, 0, newItem);
  state.selectedIndex = insertAt;
  markDirty(true);
  trackQuickSessionChange(state.selectedIndex, true);
  renderSessionList();
  scrollToSessionRow(state.selectedIndex);
  renderSessionForm();
  renderSponsorForm();
  syncSessionSaveButton();
  els.deleteSession.disabled = false;
  await saveDataset();
}

export async function deleteSession() {
  if (!state.dataset || state.selectedIndex < 0) return;
  const item = state.dataset.items[state.selectedIndex];
  const okay = window.confirm(`Delete session "${item?.title || 'Untitled'}"?`);
  if (!okay) return;
  undoPush();
  state.dataset.items.splice(state.selectedIndex, 1);
  removeTrackedIndex(state.quickEditSessionChanges, state.selectedIndex);
  if (state.dataset.items.length === 0) {
    state.selectedIndex = -1;
  } else if (state.selectedIndex >= state.dataset.items.length) {
    state.selectedIndex = state.dataset.items.length - 1;
  }

  markDirty(true);
  trackQuickSessionChange(state.selectedIndex, true);
  trackQuickSponsorChange(-1, true);
  renderSessionList();
  scrollToSessionRow(state.selectedIndex);
  renderSessionForm();
  renderSponsorForm();
  syncSessionSaveButton();
  els.deleteSession.disabled = state.selectedIndex < 0;
  await saveDataset();
}

function duplicateSession(index) {
  if (!state.dataset || index < 0 || index >= state.dataset.items.length) return;
  undoPush();
  const copy = cloneJsonValue(state.dataset.items[index]);
  copy.title = `${copy.title || 'Untitled'} (copy)`;
  state.dataset.items.splice(index + 1, 0, copy);
  state.selectedIndex = index + 1;
  markDirty(true);
  trackQuickSessionChange(index + 1, true);
  renderSessionList();
  scrollToSessionRow(state.selectedIndex);
  renderSessionForm();
  renderSponsorForm();
  syncSessionSaveButton();
  els.deleteSession.disabled = false;
}

export async function saveCurrentSession() {
  if (!state.dataset) {
    window.alert('No dataset loaded.');
    return;
  }
  if (!isQuickSessionEditEnabled() && state.selectedIndex < 0) {
    window.alert('No session selected.');
    return;
  }
  await saveDataset();
}
