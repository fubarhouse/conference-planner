// Sponsor feature for the editor — data normalization plus the session↔sponsor
// linking pickers (more of the sponsor list/form UI will follow here). Editor
// globals (state, els, dirty-tracking, the session/sponsor form renderers) are
// injected via initEditorSponsors() so this module owns the sponsor code without
// importing editor.js. The pure normalizers keep their JSDoc and unit tests.

import { slugify, normalizeString, escapeHtml } from './utils.js';
import { normalizeSponsorBgStyle, normalizeSponsorAspect } from './sponsorStyles.js';
import { utcIsoToLocalInput } from './editorDateTime.js';
import { parseMultiValue } from './editorNormalize.js';

// ── Injected editor collaborators ─────────────────────────────────────────────
let state;
let els;
let SPONSOR_FIELDS;
let getEventTimezone;
let markDirty;
let markSessionDirty;
let markSponsorDirty;
let trackQuickSessionChange;
let trackQuickSponsorChange;
let undoPush;
let renderSessionForm;
let selectSponsorForm;
let isQuickSponsorEditEnabled;
let syncSponsorSaveButton;
let syncSponsorEditorPanelVisibility;
let buildSponsorEventCounts;
let getSponsorEventCount;
let uploadSponsorImageFromPicker;
let bustSrc;
let escapeAttr;
let toStringValue;
let fieldDescriptionAttr;
let renderFieldIntro;
let moveTrackedIndex;
let removeTrackedIndex;
let scrollToSponsorRow;
let saveDataset;

export function initEditorSponsors(deps) {
  ({
    state,
    els,
    SPONSOR_FIELDS,
    getEventTimezone,
    markDirty,
    markSessionDirty,
    markSponsorDirty,
    trackQuickSessionChange,
    trackQuickSponsorChange,
    undoPush,
    renderSessionForm,
    selectSponsorForm,
    isQuickSponsorEditEnabled,
    syncSponsorSaveButton,
    syncSponsorEditorPanelVisibility,
    buildSponsorEventCounts,
    getSponsorEventCount,
    uploadSponsorImageFromPicker,
    bustSrc,
    escapeAttr,
    toStringValue,
    fieldDescriptionAttr,
    renderFieldIntro,
    moveTrackedIndex,
    removeTrackedIndex,
    scrollToSponsorRow,
    saveDataset,
  } = deps);
}

// ── Data normalization (pure) ─────────────────────────────────────────────────

// Slugified sponsor id, falling back to the title (or '') when no id is given.
/**
 * @param {*} value
 * @param {string} [fallback]
 * @returns {string}
 */
export function normalizeSponsorId(value, fallback = '') {
  return slugify(value || fallback || '') || '';
}

// Coerce one raw sponsor into the canonical shape, filling sensible defaults.
/**
 * @param {*} [raw]
 * @param {string} [fallbackTitle]
 * @returns {object}
 */
export function normalizeSponsorObject(raw = null, fallbackTitle = '') {
  const input = raw && typeof raw === 'object' ? raw : {};
  const title = normalizeString(input.title || fallbackTitle);
  const row = Number.parseInt(String(input.row ?? '').trim(), 10);
  return {
    id: normalizeSponsorId(input.id, title),
    title,
    tier: normalizeString(input.tier),
    row: Number.isFinite(row) ? row : 1,
    priority: Number.isFinite(Number(input.priority)) ? Number(input.priority) : 100,
    image: normalizeString(input.image),
    imageAlt: normalizeString(input.imageAlt),
    link: normalizeString(input.link),
    bgStyle: normalizeSponsorBgStyle(normalizeString(input.bgStyle)),
    aspect: normalizeSponsorAspect(normalizeString(input.aspect)),
    enabled: !(input.enabled === false || String(input.enabled || '').toLowerCase() === 'false'),
  };
}

// Normalize an array of raw sponsors; non-arrays yield an empty list.
/**
 * @param {*} [raw]
 * @returns {object[]}
 */
export function normalizeSponsorCollection(raw = null) {
  if (!Array.isArray(raw)) return [];
  return raw.map((item, index) => normalizeSponsorObject(item, `Sponsor ${index + 1}`));
}

// ── Session ↔ sponsor linking pickers ─────────────────────────────────────────

function formatSponsorLinkedSessionMeta(item, index) {
  const bits = [];
  if (item?.startTime) {
    bits.push(utcIsoToLocalInput(item.startTime, getEventTimezone()));
  }
  if (item?.location) {
    bits.push(String(item.location));
  }
  bits.push(`Session ${index + 1}`);
  return bits.filter(Boolean).join(' | ');
}

function getSelectedSponsor() {
  return state.dataset?.event?.sponsors?.[state.selectedSponsorIndex] || null;
}

function getAvailableSessionsForSponsor(sponsor) {
  if (!sponsor) return [];
  return (state.dataset?.items || [])
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !parseMultiValue(item?.sponsorIds || '').includes(sponsor.id));
}

export function closeSponsorSessionPicker() {
  if (!els.sponsorSessionPickerModal) return;
  state.sponsorSessionPickerOpen = false;
  els.sponsorSessionPickerModal.classList.add('hidden');
  els.sponsorSessionPickerModal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('session-modal-open');
}

function openSponsorSessionPicker() {
  const sponsor = getSelectedSponsor();
  if (!sponsor || !els.sponsorSessionPickerModal || !els.sponsorSessionPickerList) return;

  const availableSessions = getAvailableSessionsForSponsor(sponsor);
  state.sponsorSessionPickerOpen = true;
  els.sponsorSessionPickerModal.classList.remove('hidden');
  els.sponsorSessionPickerModal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('session-modal-open');
  const titleEl = document.getElementById('sponsorSessionPickerTitle');
  if (titleEl) {
    titleEl.textContent = `Add session to ${sponsor.title || 'sponsor'}`;
  }
  if (els.sponsorSessionPickerCount) {
    els.sponsorSessionPickerCount.textContent = `${availableSessions.length} available`;
  }
  els.sponsorSessionPickerList.innerHTML = availableSessions.length
    ? availableSessions
        .map(
          ({ item, index }) => `
        <article class="speaker-session-card">
          <div>
            <h3 class="speaker-session-title">${escapeHtml(item?.title || '(Untitled session)')}</h3>
            <p class="speaker-session-meta">${escapeHtml(formatSponsorLinkedSessionMeta(item, index))}</p>
          </div>
          <div class="session-modal-links">
            <button type="button" class="session-modal-link" data-add-linked-session="${index}">
              <span>Add session</span>
            </button>
          </div>
        </article>
      `,
        )
        .join('')
    : '<p class="speaker-session-summary">All sessions in this event are already linked to this sponsor.</p>';

  els.sponsorSessionPickerList.querySelectorAll('[data-add-linked-session]').forEach((button) => {
    button.addEventListener('click', () => {
      const itemIndex = Number.parseInt(button.dataset.addLinkedSession || '-1', 10);
      addLinkedSessionToSponsor(itemIndex);
    });
  });
}

function addLinkedSessionToSponsor(itemIndex) {
  const sponsor = getSelectedSponsor();
  const item = state.dataset?.items?.[itemIndex];
  if (!sponsor || !item) return;
  const ids = parseMultiValue(item?.sponsorIds || '');
  if (!ids.includes(sponsor.id)) {
    const nextIds = [...ids, sponsor.id].filter(Boolean);
    item.sponsorIds = nextIds.length <= 1 ? nextIds[0] || '' : nextIds;
    markDirty(true);
    markSessionDirty(true);
    markSponsorDirty(true);
    trackQuickSessionChange(itemIndex);
    trackQuickSponsorChange(state.selectedSponsorIndex);
  }
  closeSponsorSessionPicker();
  renderSponsorForm();
  renderSessionForm();
}

function removeLinkedSessionFromSponsor(itemIndex) {
  const sponsor = getSelectedSponsor();
  const item = state.dataset?.items?.[itemIndex];
  if (!sponsor || !item) return;
  const ids = parseMultiValue(item?.sponsorIds || '').filter((id) => id !== sponsor.id);
  item.sponsorIds = ids.length <= 1 ? ids[0] || '' : ids;
  markDirty(true);
  markSessionDirty(true);
  markSponsorDirty(true);
  trackQuickSessionChange(itemIndex);
  trackQuickSponsorChange(state.selectedSponsorIndex);
  renderSponsorForm();
  renderSessionForm();
}

function getAvailableSponsorsForSession(item) {
  const linkedIds = parseMultiValue(item?.sponsorIds || '');
  return (state.dataset?.event?.sponsors || [])
    .map((sponsor, index) => ({ sponsor, index }))
    .filter(({ sponsor }) => sponsor.id && !linkedIds.includes(sponsor.id));
}

export function openSessionSponsorPicker() {
  const item = state.dataset?.items?.[state.selectedIndex];
  if (!item || !els.sessionSponsorPickerModal || !els.sessionSponsorPickerList) return;
  const availableSponsors = getAvailableSponsorsForSession(item);
  state.sessionSponsorPickerOpen = true;
  els.sessionSponsorPickerModal.classList.remove('hidden');
  els.sessionSponsorPickerModal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('session-modal-open');
  if (els.sessionSponsorPickerCount) {
    els.sessionSponsorPickerCount.textContent = `${availableSponsors.length} available`;
  }
  els.sessionSponsorPickerList.innerHTML = availableSponsors.length
    ? availableSponsors
        .map(
          ({ sponsor, index }) => `
        <article class="speaker-session-card">
          <div>
            <h3 class="speaker-session-title">${escapeHtml(sponsor.title || sponsor.id || '(Untitled sponsor)')}</h3>
            <p class="speaker-session-meta">${escapeHtml(sponsor.id || '')}</p>
          </div>
          <div class="session-modal-links">
            <button type="button" class="session-modal-link" data-add-session-sponsor="${index}">
              <span>Add sponsor</span>
            </button>
          </div>
        </article>
      `,
        )
        .join('')
    : '<p class="speaker-session-summary">All sponsors are already linked to this session.</p>';
  els.sessionSponsorPickerList.querySelectorAll('[data-add-session-sponsor]').forEach((button) => {
    button.addEventListener('click', () => {
      addSponsorToSession(Number.parseInt(button.dataset.addSessionSponsor || '-1', 10));
    });
  });
}

export function closeSessionSponsorPicker() {
  if (!els.sessionSponsorPickerModal) return;
  state.sessionSponsorPickerOpen = false;
  els.sessionSponsorPickerModal.classList.add('hidden');
  els.sessionSponsorPickerModal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('session-modal-open');
}

function addSponsorToSession(sponsorIndex) {
  const item = state.dataset?.items?.[state.selectedIndex];
  const sponsor = state.dataset?.event?.sponsors?.[sponsorIndex];
  if (!item || !sponsor?.id) return;
  const ids = parseMultiValue(item?.sponsorIds || '');
  if (!ids.includes(sponsor.id)) {
    undoPush();
    const nextIds = [...ids, sponsor.id].filter(Boolean);
    item.sponsorIds = nextIds.length <= 1 ? nextIds[0] || '' : nextIds;
    markDirty(true);
    markSessionDirty(true);
    markSponsorDirty(true);
    trackQuickSessionChange(state.selectedIndex);
    trackQuickSponsorChange(state.selectedSponsorIndex);
  }
  closeSessionSponsorPicker();
  renderSessionForm();
  renderSponsorForm();
}

export function removeSponsorFromSession(sponsorId) {
  const item = state.dataset?.items?.[state.selectedIndex];
  if (!item || !sponsorId) return;
  undoPush();
  const ids = parseMultiValue(item?.sponsorIds || '');
  const nextIds = ids.filter((id) => id !== sponsorId);
  item.sponsorIds = nextIds.length <= 1 ? nextIds[0] || '' : nextIds;
  markDirty(true);
  markSessionDirty(true);
  markSponsorDirty(true);
  trackQuickSessionChange(state.selectedIndex);
  renderSessionForm();
  renderSponsorForm();
}

// ── Sponsor list + form rendering ─────────────────────────────────────────────

function getSponsorListLabel(sponsor, index) {
  const title = normalizeString(sponsor?.title) || '(Untitled sponsor)';
  const row = Number.isFinite(Number(sponsor?.row)) ? `Row ${Number(sponsor.row)}` : '';
  const tier = normalizeString(sponsor?.tier);
  return `${index + 1}. ${title}${tier || row ? ` - ${[tier, row].filter(Boolean).join(' / ')}` : ''}`;
}

export function renderSponsorList() {
  const sponsors = state.dataset?.event?.sponsors || [];
  if (!sponsors.length) {
    els.sponsorList.innerHTML = '<li class="edt-empty">No sponsors yet.</li>';
    return;
  }

  els.sponsorList.innerHTML = sponsors
    .map((sponsor, index) => {
      const active = index === state.selectedSponsorIndex ? 'is-selected' : '';
      if (isQuickSponsorEditEnabled()) {
        return `
          <li draggable="true" data-sponsor-index="${index}" class="sponsor-row edt-row edt-row--expanded ${active}">
            <div class="sponsor-row-grid">
              <div class="session-row-handle edt-ink-2">
                </div>
              <div class="min-w-0">
                <label class="session-inline-field">
                  <span class="session-inline-label">Title</span>
                  <input
                    data-inline-sponsor-field="title"
                    data-sponsor-index="${index}"
                    type="text"
                    value="${escapeAttr(toStringValue(sponsor?.title))}"
                    class="edt-field"
                  >
                </label>
              </div>
              <div>
                <label class="session-inline-field">
                  <span class="session-inline-label">Tier</span>
                  <input
                    data-inline-sponsor-field="tier"
                    data-sponsor-index="${index}"
                    type="text"
                    value="${escapeAttr(toStringValue(sponsor?.tier))}"
                    class="edt-field"
                  >
                </label>
              </div>
              <div>
                <label class="session-inline-field">
                  <span class="session-inline-label">Row</span>
                  <input
                    data-inline-sponsor-field="row"
                    data-sponsor-index="${index}"
                    type="number"
                    min="1"
                    step="1"
                    value="${escapeAttr(toStringValue(sponsor?.row))}"
                    class="edt-field"
                  >
                </label>
              </div>
              <div>
                <label class="session-inline-field">
                  <span class="session-inline-label">Priority</span>
                  <input
                    data-inline-sponsor-field="priority"
                    data-sponsor-index="${index}"
                    type="number"
                    value="${escapeAttr(toStringValue(sponsor?.priority))}"
                    class="edt-field"
                  >
                </label>
              </div>
              <button
                type="button"
                data-open-sponsor-form="${index}"
                class="editor-inline-open h-10 inline-flex items-center justify-center px-3 border edt-rule rounded-md text-xs font-medium edt-ink-1 edt-surface transition-colors whitespace-nowrap"
              >
                <span>Open</span>
              </button>
            </div>
          </li>
        `;
      }
      return `
        <li draggable="true" data-sponsor-index="${index}" class="sponsor-row edt-row ${active}">
          <div class="edt-row__body">
            <div class="min-w-0">
              <div class="edt-row__title">${escapeHtml(getSponsorListLabel(sponsor, index))}</div>
              <div class="edt-row__meta">${escapeHtml([sponsor?.id || '', sponsor?.link || ''].filter(Boolean).join(' · '))}</div>
            </div>
          </div>
        </li>
      `;
    })
    .join('');

  els.sponsorList.querySelectorAll('.sponsor-row').forEach((row) => {
    const index = Number.parseInt(row.dataset.sponsorIndex || '-1', 10);

    row.addEventListener('click', async () => {
      if (index === state.selectedSponsorIndex) return;
      selectSponsorForm(index, { collapseWorkspace: state.sponsorListExpanded });
    });

    row.addEventListener('dragstart', (event) => {
      state.draggingSponsorIndex = index;
      row.classList.add('opacity-50');
      event.dataTransfer.effectAllowed = 'move';
    });

    row.addEventListener('dragend', () => {
      state.draggingSponsorIndex = -1;
      row.classList.remove('opacity-50');
      els.sponsorList
        .querySelectorAll('.sponsor-row')
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
      const from = state.draggingSponsorIndex;
      const to = index;
      if (from < 0 || to < 0 || from === to) return;

      const moved = state.dataset.event.sponsors.splice(from, 1)[0];
      state.dataset.event.sponsors.splice(to, 0, moved);
      moveTrackedIndex(state.quickEditSponsorChanges, from, to);
      state.selectedSponsorIndex = to;
      markDirty(true);
      trackQuickSponsorChange(to, true);
      renderSponsorList();
      renderSponsorForm();
    });
  });

  const syncSponsorSelectionState = () => {
    els.sponsorList.querySelectorAll('.sponsor-row').forEach((row) => {
      const rowIndex = Number.parseInt(row.dataset.sponsorIndex || '-1', 10);
      const isActive = rowIndex === state.selectedSponsorIndex;
      // One selection mark for the whole product: a leading brand rule.
      row.classList.toggle('is-selected', isActive);
    });
  };

  els.sponsorList.querySelectorAll('[data-inline-sponsor-field]').forEach((input) => {
    const rowIndex = Number.parseInt(input.dataset.sponsorIndex || '-1', 10);
    const key = input.dataset.inlineSponsorField;

    const selectRow = () => {
      if (rowIndex === state.selectedSponsorIndex) return;
      selectSponsorForm(rowIndex);
      syncSponsorSelectionState();
    };

    input.addEventListener('click', (event) => {
      event.stopPropagation();
    });

    input.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
    });

    input.addEventListener('focus', async (event) => {
      event.stopPropagation();
      if (isQuickSponsorEditEnabled()) return;
      await selectRow();
    });

    input.addEventListener('input', (event) => {
      event.stopPropagation();
      const sponsor = state.dataset?.event?.sponsors?.[rowIndex];
      if (!sponsor) return;
      if (key === 'priority') {
        sponsor[key] = Number.parseInt(input.value || '100', 10) || 100;
      } else if (key === 'row') {
        sponsor[key] = Number.parseInt(input.value || '1', 10) || 1;
      } else {
        sponsor[key] = input.value;
      }
      if (key === 'title' && !normalizeString(sponsor.id)) {
        sponsor.id = normalizeSponsorId(input.value);
      }
      markDirty(true);
      trackQuickSponsorChange(rowIndex);
      if (rowIndex === state.selectedSponsorIndex) {
        renderSponsorForm();
      }
    });
  });

  els.sponsorList.querySelectorAll('[data-open-sponsor-form]').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      const rowIndex = Number.parseInt(button.dataset.openSponsorForm || '-1', 10);
      if (rowIndex < 0) return;
      selectSponsorForm(rowIndex, { collapseWorkspace: true });
    });
  });
}

// Preview shown when a sponsor has no logo file — mirrors the event page's name
// tile (sponsor name, subtitle on a second line) so the editor previews exactly
// what visitors will see.
function sponsorPreviewFallbackHtml(sponsor) {
  const subtitle = normalizeString(sponsor.subtitle);
  return `<div id="sponsorImagePreview" class="sponsor-preview-text sponsor-logo-surface-text">
    <span class="sponsor-logo-name">${escapeHtml(sponsor.title || 'Sponsor')}</span>
    ${subtitle ? `<span class="sponsor-logo-subtitle">${escapeHtml(subtitle)}</span>` : ''}
  </div>`;
}

function renderSponsorField(field, sponsor) {
  const spanClass =
    field.span === 2 ? 'md:col-span-2' : field.span === 3 ? 'md:col-span-2 xl:col-span-3' : '';
  const describedBy = fieldDescriptionAttr('sponsor', field.key, field);

  if (field.type === 'checkbox') {
    return `
      <label class="editor-form-field ${spanClass}">
        ${renderFieldIntro('sponsor', field.key, field)}
        <span class="edt-btn">
          <input data-sponsor-field="${field.key}" type="checkbox" class="h-4 w-4" ${sponsor[field.key] ? 'checked' : ''}${describedBy}>
          <span class="text-sm edt-ink-1">Enabled</span>
        </span>
      </label>
    `;
  }

  if (field.type === 'select') {
    const options = field.options
      .map(
        (option) =>
          `<option value="${escapeAttr(option)}" ${sponsor[field.key] === option ? 'selected' : ''}>${escapeHtml(option)}</option>`,
      )
      .join('');
    return `
      <label class="editor-form-field ${spanClass}">
        ${renderFieldIntro('sponsor', field.key, field)}
        <select data-sponsor-field="${field.key}" class="w-full h-11 pr-10 rounded-md edt-rule drupal-blue-focus text-sm edt-surface px-3"${describedBy}>${options}</select>
      </label>
    `;
  }

  const type = field.type === 'number' ? 'number' : 'text';
  const numericAttrs =
    field.type === 'number' ? `${field.key === 'row' ? ' min="1" step="1"' : ''}` : '';
  return `
    <label class="editor-form-field ${spanClass}">
      ${renderFieldIntro('sponsor', field.key, field)}
      <input data-sponsor-field="${field.key}" type="${type}"${numericAttrs} value="${escapeAttr(toStringValue(sponsor[field.key]))}" class="edt-field"${describedBy}>
    </label>
  `;
}

export function renderSponsorForm() {
  const sponsor = state.dataset?.event?.sponsors?.[state.selectedSponsorIndex] || null;
  syncSponsorEditorPanelVisibility();
  if (!sponsor) {
    els.sponsorIndexBadge.textContent = 'No sponsor selected';
    els.sponsorForm.innerHTML = '<p class="edt-muted">Select a sponsor row to edit it.</p>';
    markSponsorDirty(false);
    syncSponsorSaveButton();
    els.deleteSponsor.disabled = true;
    return;
  }

  if (isQuickSponsorEditEnabled()) {
    els.sponsorIndexBadge.textContent = `Sponsor ${state.selectedSponsorIndex + 1} of ${state.dataset.event.sponsors.length}`;
    els.sponsorForm.innerHTML = `
      <div class="editor-quick-open-state md:col-span-2 xl:col-span-3">
        <div class="editor-quick-open-card">
          <div class="text-sm font-semibold edt-ink-0 mb-2">${escapeHtml(getSponsorListLabel(sponsor, state.selectedSponsorIndex))}</div>
          <p class="edt-muted mb-4">This row is selected in quick edit. Open it to switch back to the full sponsor form.</p>
          <button type="button" id="openSelectedSponsorForm" class="h-10 inline-flex items-center justify-center px-4 border edt-rule rounded-md text-sm font-medium edt-ink-1 edt-surface transition-colors whitespace-nowrap">
            Open sponsor
          </button>
        </div>
      </div>
    `;
    const openButton = document.getElementById('openSelectedSponsorForm');
    if (openButton) {
      openButton.addEventListener('click', async () => {
        selectSponsorForm(state.selectedSponsorIndex, { collapseWorkspace: true });
      });
    }
    markSponsorDirty(state.sponsorDirty);
    syncSponsorSaveButton();
    return;
  }

  const linkedSessions = (state.dataset?.items || [])
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => parseMultiValue(item?.sponsorIds || '').includes(sponsor.id));

  els.sponsorIndexBadge.textContent = `Sponsor ${state.selectedSponsorIndex + 1} of ${state.dataset.event.sponsors.length}`;
  syncSponsorSaveButton();
  els.deleteSponsor.disabled = false;

  if (!state.sponsorEventCounts) {
    const selectedAtLoad = state.selectedSponsorIndex;
    buildSponsorEventCounts()
      .catch(() => {
        state.sponsorEventCounts = new Map();
      })
      .then(() => {
        if (state.selectedSponsorIndex === selectedAtLoad) renderSponsorForm();
      });
  }

  const imageSrc = (sponsor.image || '').trim();
  const bgStyle = sponsor.bgStyle || 'auto';
  const aspect = sponsor.aspect || 'auto';
  const eventCount = getSponsorEventCount(sponsor.title);
  const eventCountDisplay = eventCount === null ? '—' : String(eventCount);

  els.sponsorForm.innerHTML = `
    <div class="col-span-full flex gap-5 items-start">
      <div class="flex-1 min-w-0 grid grid-cols-1 md:grid-cols-2 gap-3">
        ${SPONSOR_FIELDS.filter((f) => f.key !== 'enabled')
          .map((field) => renderSponsorField(field, sponsor))
          .join('')}
        <div class="editor-form-field md:col-span-2">
          <span class="editor-field-label">Sponsor image</span>
          <span class="editor-field-description">Uploads to <code>img/sponsors/${escapeHtml(
            slugify(state.dataset?.event?.designation || 'event') || 'event',
          )}</code> and stores a relative path.</span>
          <div class="flex items-center gap-2 flex-wrap">
            <label class="edt-btn select-none">
              <input data-sponsor-field="enabled" type="checkbox" class="h-4 w-4" ${sponsor.enabled ? 'checked' : ''}>
              <span class="edt-body">Enabled</span>
            </label>
            <button id="sponsorImageUpload" type="button" class="h-9 inline-flex items-center justify-center px-3 border edt-rule rounded-md text-sm font-medium edt-ink-1 edt-surface transition-colors whitespace-nowrap">
              Upload image
            </button>
            <button id="sponsorImageClear" type="button" class="h-9 inline-flex items-center justify-center px-3 border edt-rule rounded-md text-sm font-medium edt-ink-1 edt-surface hover:border-red-300 hover:text-red-600 transition-colors whitespace-nowrap"${!imageSrc ? ' disabled' : ''}>
              Delete image
            </button>
            <div id="sponsorInlinePreview" class="sponsor-inline-preview sponsor-bg-${escapeAttr(bgStyle)} sponsor-aspect-${escapeAttr(aspect)} ml-auto">
              ${
                imageSrc
                  ? `<img src="${escapeAttr(bustSrc(imageSrc))}" alt="${escapeAttr(sponsor.imageAlt || '')}" class="sponsor-inline-image">`
                  : ``
              }
            </div>
          </div>
        </div>
        <div class="editor-form-field md:col-span-2">
          <span class="editor-field-label">Linked sessions</span>
          <span class="editor-field-description">Manage sessions currently referencing <code>${escapeHtml(sponsor.id || '(missing id)')}</code>.</span>
          <div class="rounded-md edt-note px-3 py-3 text-sm edt-ink-1 space-y-3">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <span class="text-xs edt-ink-2">${linkedSessions.length ? `${linkedSessions.length} linked session${linkedSessions.length === 1 ? '' : 's'}` : 'No sessions linked yet.'}</span>
              <button id="addLinkedSponsorSession" type="button" class="h-9 inline-flex items-center justify-center px-3 border edt-rule rounded-md text-xs font-medium edt-ink-1 edt-surface transition-colors whitespace-nowrap">
                Add session
              </button>
            </div>
            <div class="space-y-2">
              ${
                linkedSessions.length
                  ? linkedSessions
                      .map(
                        ({ item, index }) => `
                    <div class="editor-linked-item">
                      <div class="editor-linked-item-copy">
                        <div class="editor-linked-item-title">${escapeHtml(item?.title || '(Untitled session)')}</div>
                        <div class="editor-linked-item-meta">${escapeHtml(formatSponsorLinkedSessionMeta(item, index))}</div>
                      </div>
                      <button type="button" class="editor-linked-item-action" data-remove-linked-session="${index}" aria-label="Remove linked session ${escapeAttr(item?.title || '(Untitled session)')}">
                        <span>Remove</span>
                      </button>
                    </div>
                  `,
                      )
                      .join('')
                  : ''
              }
            </div>
          </div>
        </div>
      </div>

      <aside class="sponsor-editor-sidebar">
        <div id="sponsorPreviewSurface" class="sponsor-preview-surface sponsor-bg-${escapeAttr(bgStyle)} sponsor-aspect-${escapeAttr(aspect)}">
          ${
            imageSrc
              ? `<img id="sponsorImagePreview" src="${escapeAttr(bustSrc(imageSrc))}" alt="${escapeAttr(sponsor.imageAlt || '')}" class="sponsor-logo-image">`
              : sponsorPreviewFallbackHtml(sponsor)
          }
        </div>
        <div class="sponsor-event-stat">
          <span class="sponsor-event-stat-count">${escapeHtml(eventCountDisplay)}</span>
          <span class="sponsor-event-stat-label">Events Sponsored</span>
        </div>
      </aside>
    </div>
  `;

  els.sponsorForm.querySelectorAll('[data-sponsor-field]').forEach((input) => {
    input.addEventListener('input', () => {
      const key = input.dataset.sponsorField;
      if (key === 'enabled') {
        sponsor[key] = Boolean(input.checked);
      } else if (key === 'priority') {
        sponsor[key] = Number.parseInt(input.value || '100', 10) || 100;
      } else if (key === 'row') {
        sponsor[key] = Number.parseInt(input.value || '1', 10) || 1;
      } else if (key === 'id') {
        const previousId = sponsor.id;
        sponsor.id = normalizeSponsorId(input.value, sponsor.title);
        if (previousId && previousId !== sponsor.id) {
          (state.dataset?.items || []).forEach((item) => {
            const ids = parseMultiValue(item?.sponsorIds || '');
            if (!ids.includes(previousId)) return;
            const nextIds = ids.map((id) => (id === previousId ? sponsor.id : id)).filter(Boolean);
            item.sponsorIds = nextIds.length <= 1 ? nextIds[0] || '' : nextIds;
          });
          renderSessionForm();
        }
      } else if (key === 'title') {
        sponsor[key] = input.value;
        const countEl = els.sponsorForm.querySelector('.sponsor-event-stat-count');
        if (countEl) {
          const c = getSponsorEventCount(input.value);
          countEl.textContent = c === null ? '—' : String(c);
        }
      } else {
        sponsor[key] = input.value;
      }
      if (key === 'image') {
        const surface = els.sponsorForm.querySelector('#sponsorPreviewSurface');
        const inline = els.sponsorForm.querySelector('#sponsorInlinePreview');
        const newSrc = input.value.trim();
        if (surface) {
          surface.innerHTML = newSrc
            ? `<img id="sponsorImagePreview" src="${escapeAttr(newSrc)}" alt="${escapeAttr(sponsor.imageAlt || '')}" class="sponsor-logo-image">`
            : sponsorPreviewFallbackHtml(sponsor);
        }
        if (inline) {
          inline.innerHTML = newSrc
            ? `<img src="${escapeAttr(newSrc)}" alt="${escapeAttr(sponsor.imageAlt || '')}" class="sponsor-inline-image">`
            : ``;
        }
        const clearBtn = els.sponsorForm.querySelector('#sponsorImageClear');
        if (clearBtn) clearBtn.disabled = !newSrc;
      }
      if (key === 'imageAlt') {
        els.sponsorForm
          .querySelectorAll('#sponsorImagePreview, #sponsorInlinePreview img')
          .forEach((el) => {
            el.alt = input.value;
          });
      }
      if (key === 'bgStyle') {
        const val = input.value || 'auto';
        els.sponsorForm
          .querySelectorAll('#sponsorPreviewSurface, #sponsorInlinePreview')
          .forEach((el) => {
            el.className = el.className.replace(/\bsponsor-bg-\S+/g, `sponsor-bg-${val}`);
          });
      }
      if (key === 'aspect') {
        const val = input.value || 'auto';
        els.sponsorForm
          .querySelectorAll('#sponsorPreviewSurface, #sponsorInlinePreview')
          .forEach((el) => {
            el.className = el.className.replace(/\bsponsor-aspect-\S+/g, `sponsor-aspect-${val}`);
          });
      }
      // Keep the (image-less) name-tile preview in sync as the name/subtitle change.
      if ((key === 'title' || key === 'subtitle') && !normalizeString(sponsor.image)) {
        const surface = els.sponsorForm.querySelector('#sponsorPreviewSurface');
        if (surface) surface.innerHTML = sponsorPreviewFallbackHtml(sponsor);
      }
      markDirty(true);
      markSponsorDirty(true);
      trackQuickSponsorChange(state.selectedSponsorIndex);
      renderSponsorList();
    });
    input.addEventListener('change', () => {
      const key = input.dataset.sponsorField;
      if (key === 'enabled') {
        sponsor[key] = Boolean(input.checked);
        markDirty(true);
        markSponsorDirty(true);
        trackQuickSponsorChange(state.selectedSponsorIndex);
        renderSponsorList();
      }
    });
  });

  const uploadButton = els.sponsorForm.querySelector('#sponsorImageUpload');
  if (uploadButton) {
    uploadButton.addEventListener('click', async () => {
      try {
        await uploadSponsorImageFromPicker(state.selectedSponsorIndex);
      } catch (error) {
        window.alert(`Sponsor image upload failed: ${error.message}`);
      }
    });
  }

  const clearButton = els.sponsorForm.querySelector('#sponsorImageClear');
  if (clearButton) {
    clearButton.addEventListener('click', () => {
      sponsor.image = '';
      sponsor.imageAlt = '';
      markDirty(true);
      markSponsorDirty(true);
      trackQuickSponsorChange(state.selectedSponsorIndex);
      renderSponsorList();
      renderSponsorForm();
    });
  }

  const addLinkedSessionButton = els.sponsorForm.querySelector('#addLinkedSponsorSession');
  if (addLinkedSessionButton) {
    addLinkedSessionButton.addEventListener('click', () => {
      openSponsorSessionPicker();
    });
  }

  els.sponsorForm.querySelectorAll('[data-remove-linked-session]').forEach((button) => {
    button.addEventListener('click', () => {
      const itemIndex = Number.parseInt(button.dataset.removeLinkedSession || '-1', 10);
      removeLinkedSessionFromSponsor(itemIndex);
    });
  });
}

// ── Sponsor CRUD ──────────────────────────────────────────────────────────────

export async function addSponsor() {
  if (!state.dataset) return;
  undoPush();
  const sponsors = state.dataset.event.sponsors || (state.dataset.event.sponsors = []);
  const seed = sponsors[state.selectedSponsorIndex] || {};
  const nextNumber = sponsors.length + 1;
  const sponsor = normalizeSponsorObject({
    title: `Sponsor ${nextNumber}`,
    tier: seed.tier || '',
    row: seed.row ?? 1,
    priority: nextNumber * 10,
    bgStyle: 'auto',
    aspect: 'auto',
    enabled: true,
  });
  if (!sponsor.id) sponsor.id = `sponsor-${nextNumber}`;
  const insertAt =
    state.selectedSponsorIndex >= 0 ? state.selectedSponsorIndex + 1 : sponsors.length;
  sponsors.splice(insertAt, 0, sponsor);
  state.selectedSponsorIndex = insertAt;
  markDirty(true);
  trackQuickSponsorChange(state.selectedSponsorIndex, true);
  renderSponsorList();
  scrollToSponsorRow(state.selectedSponsorIndex);
  renderSponsorForm();
  renderSessionForm();
  syncSponsorSaveButton();
  els.deleteSponsor.disabled = false;
  await saveDataset();
}

export async function deleteSponsor() {
  const sponsors = state.dataset?.event?.sponsors || [];
  if (state.selectedSponsorIndex < 0 || state.selectedSponsorIndex >= sponsors.length) return;
  const sponsor = sponsors[state.selectedSponsorIndex];
  const okay = window.confirm(`Delete sponsor "${sponsor?.title || 'Untitled'}"?`);
  if (!okay) return;
  undoPush();
  const [removed] = sponsors.splice(state.selectedSponsorIndex, 1);
  removeTrackedIndex(state.quickEditSponsorChanges, state.selectedSponsorIndex);
  if (removed?.id) {
    (state.dataset?.items || []).forEach((item) => {
      const ids = parseMultiValue(item?.sponsorIds || '').filter((id) => id !== removed.id);
      item.sponsorIds = ids.length <= 1 ? ids[0] || '' : ids;
    });
  }
  if (sponsors.length === 0) {
    state.selectedSponsorIndex = -1;
  } else if (state.selectedSponsorIndex >= sponsors.length) {
    state.selectedSponsorIndex = sponsors.length - 1;
  }
  markDirty(true);
  trackQuickSponsorChange(state.selectedSponsorIndex, true);
  trackQuickSessionChange(-1, true);
  renderSponsorList();
  scrollToSponsorRow(state.selectedSponsorIndex);
  renderSponsorForm();
  renderSessionForm();
  syncSponsorSaveButton();
  els.deleteSponsor.disabled = state.selectedSponsorIndex < 0;
  await saveDataset();
}

export async function saveCurrentSponsor() {
  if (!state.dataset) {
    window.alert('No dataset loaded.');
    return;
  }
  if (!isQuickSponsorEditEnabled() && state.selectedSponsorIndex < 0) {
    window.alert('No sponsor selected.');
    return;
  }
  await saveDataset();
}
