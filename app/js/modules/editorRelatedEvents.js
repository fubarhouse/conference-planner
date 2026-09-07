// Editor — Content ▸ Related events. CRUD for `event.relatedEvents` (partners /
// linked conferences), managed through a modal. Mirrors the sponsor editor's
// role (mutate the dataset + markDirty) but stays self-contained: it imports the
// pure helpers and the modal scaffold directly, and is injected only `state` +
// `markDirty`. The rendered frontend lives in relatedEvents.js.

import { escapeHtml, normalizeString, slugify } from './utils.js';
import { buildModalOverlay, dismissOnBackdrop, trapFocus } from './modalScaffold.js';

const MODAL_ID = 'relatedEventModal';
const RELATIONSHIP_SUGGESTIONS = ['Partner', 'Linked Conference', 'Co-located', 'Related Event'];

let state;
let markDirty;
let uploadImage = null; // injected async (file, name) => './path' | null
let catalogPromise = null;
let editingIndex = -1;
let scheduleOptions = []; // [{ id, label }] catalog choices for the schedule combobox

export function initEditorRelatedEvents(deps) {
  ({ state, markDirty, uploadImage = null } = deps);
}

// ── Data normalization (pure) ─────────────────────────────────────────────────

export function normalizeRelatedEventObject(raw = null, index = 0) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const name = normalizeString(input.name, `Related event ${index + 1}`);
  const priority = Number.parseInt(String(input.priority ?? '').trim(), 10);
  return {
    id: slugify(input.id || name) || `related-${index + 1}`,
    name,
    relationship: normalizeString(input.relationship, 'Partner'),
    scheduleId: normalizeString(input.scheduleId),
    website: normalizeString(input.website),
    image: normalizeString(input.image),
    imageAlt: normalizeString(input.imageAlt),
    description: normalizeString(input.description),
    priority: Number.isFinite(priority) ? priority : 100,
    featured: input.featured === true || String(input.featured || '').toLowerCase() === 'true',
    enabled: !(input.enabled === false || String(input.enabled || '').toLowerCase() === 'false'),
  };
}

export function normalizeRelatedEventCollection(raw = null) {
  if (!Array.isArray(raw)) return [];
  return raw.map((item, index) => normalizeRelatedEventObject(item, index));
}

// ── Catalog helpers (internal schedule link target) ───────────────────────────

// The deep-link id the schedule page resolves (?id=): slug of designation+year+location.
export function catalogEventId(meta = {}) {
  const fromMeta = slugify([meta.designation, meta.year, meta.location].filter(Boolean).join(' '));
  return fromMeta || '';
}

function currentEventId() {
  return catalogEventId(state?.dataset?.event || {});
}

// Read catalog.json directly — loadEventCatalog() strips per-event metadata, but we
// need designation/year/location to build the deep-link id + a friendly label.
async function catalogOptions() {
  if (!catalogPromise)
    catalogPromise = fetch(new URL('../../data/catalog.json', import.meta.url), {
      cache: 'no-cache',
    })
      .then((r) => (r.ok ? r.json() : { events: [] }))
      .catch(() => ({ events: [] }));
  const payload = await catalogPromise;
  const events = Array.isArray(payload?.events) ? payload.events : [];
  const selfId = currentEventId();
  return events
    .map((item) => {
      const meta = item.event || {};
      const id = catalogEventId(meta);
      const label =
        [meta.designation, meta.year, meta.location].filter(Boolean).join(' ') || item.file;
      return { id, label };
    })
    .filter((o) => o.id && o.id !== selfId)
    .sort((a, b) => a.label.localeCompare(b.label));
}

// ── State helpers ─────────────────────────────────────────────────────────────

function list() {
  const event = state?.dataset?.event;
  if (!event) return [];
  if (!Array.isArray(event.relatedEvents)) event.relatedEvents = [];
  return event.relatedEvents;
}

function uniqueId(base, skipIndex = -1) {
  const items = list();
  let candidate = slugify(base) || 'related';
  let n = 2;
  const taken = (id) => items.some((it, i) => i !== skipIndex && it.id === id);
  while (taken(candidate)) candidate = `${slugify(base) || 'related'}-${n++}`;
  return candidate;
}

// ── List panel ────────────────────────────────────────────────────────────────

function linkSummary(entry) {
  if (entry.scheduleId) return `${escapeHtml(entry.scheduleId)}`;
  if (entry.website) return `${escapeHtml(entry.website)}`;
  return '<span class="edt-ink-2">No link</span>';
}

export function renderRelatedList() {
  const listEl = document.getElementById('relatedEventsList');
  const headingInput = document.getElementById('relatedEventsHeadingInput');
  const placementSel = document.getElementById('relatedEventsPlacementSelect');
  const event = state?.dataset?.event;
  if (headingInput && event) headingInput.value = normalizeString(event.relatedEventsHeading);
  if (placementSel && event)
    placementSel.value = event.relatedEventsPlacement === 'above' ? 'above' : 'below';
  if (!listEl) return;

  const items = list();
  if (!items.length) {
    listEl.innerHTML =
      '<li class="rel-empty edt-muted py-6 text-center">No related events yet. Add a partner or linked conference.</li>';
    return;
  }
  listEl.innerHTML = items
    .map(
      (entry, index) => `
      <li class="rel-row" data-index="${index}">
        <div class="rel-row-main">
          <span class="rel-row-name">${escapeHtml(entry.name)}${
            entry.enabled ? '' : ' <span class="rel-row-off">disabled</span>'
          }</span>
          <span class="rel-row-badge">${escapeHtml(entry.relationship)}</span>
          ${entry.featured ? '<span class="rel-row-feature">Featured</span>' : ''}
          <span class="rel-row-link">${linkSummary(entry)}</span>
        </div>
        <div class="rel-row-actions">
          <button type="button" class="rel-edit" data-index="${index}">Edit</button>
          <button type="button" class="rel-delete" data-index="${index}">Remove</button>
        </div>
      </li>`,
    )
    .join('');
}

// ── Modal ─────────────────────────────────────────────────────────────────────

function ensureModal() {
  let modal = document.getElementById(MODAL_ID);
  if (modal) return modal;
  modal = buildModalOverlay({
    id: MODAL_ID,
    ariaHidden: true,
    innerHTML: `
    <div class="session-modal-card rel-modal-card" role="dialog" aria-modal="true" aria-labelledby="relModalTitle">
      <div class="session-modal-header">
        <h2 id="relModalTitle" class="session-modal-title">Related event</h2>
        <button id="relModalClose" type="button" class="session-modal-close" aria-label="Close"></button>
      </div>
      <div class="session-modal-body rel-modal-body">
        <label class="rel-field"><span>Name</span><input id="relName" type="text" class="rel-input" placeholder="DrupalJam"></label>
        <label class="rel-field"><span>Relationship</span><input id="relRelationship" type="text" class="rel-input" list="relRelationshipList" placeholder="Partner"><datalist id="relRelationshipList">${RELATIONSHIP_SUGGESTIONS.map(
          (s) => `<option value="${escapeHtml(s)}"></option>`,
        ).join('')}</datalist></label>
        <div class="rel-field">
          <span>Link to a schedule <em>(internal)</em></span>
          <div class="rel-combo">
            <input id="relScheduleSearch" type="text" class="rel-input rel-combo-input" placeholder="Search events by name…" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="relScheduleResults">
            <button id="relScheduleClear" type="button" class="rel-combo-clear hidden" aria-label="Clear linked schedule"></button>
            <ul id="relScheduleResults" class="rel-combo-results hidden" role="listbox"></ul>
            <input id="relSchedule" type="hidden">
          </div>
        </div>
        <label class="rel-field"><span>Website URL <em>(used when no schedule is linked)</em></span><input id="relWebsite" type="url" class="rel-input" placeholder="https://…"></label>
        <div class="rel-field rel-field-wide">
          <span>Logo</span>
          <div class="rel-logo-manage">
            <div id="relLogoPreview" class="rel-logo-preview" aria-hidden="true"></div>
            <div class="rel-logo-side">
              <div class="rel-logo-actions">
                <button id="relLogoUpload" type="button" class="rel-btn rel-btn-ghost">Upload</button>
                <button id="relLogoRemove" type="button" class="rel-btn rel-btn-ghost">Remove</button>
              </div>
              <input id="relImageAlt" type="text" class="rel-input" placeholder="Alt text — describes the logo">
            </div>
          </div>
          <input id="relImage" type="hidden">
        </div>
        <label class="rel-field rel-field-wide"><span>Description <em>(stored; hidden on the schedule for now)</em></span><textarea id="relDescription" class="rel-input" rows="3"></textarea></label>
        <div class="rel-checks rel-field-wide">
          <label class="rel-check rel-check-feature"><input id="relFeatured" type="checkbox"> <span><strong>Feature it</strong> — full-width promotion, shown ahead of its group</span></label>
          <label class="rel-check"><input id="relEnabled" type="checkbox" checked> <span>Visible on the schedule</span></label>
        </div>
      </div>
      <div class="session-modal-footer rel-modal-footer">
        <button id="relCancel" type="button" class="rel-btn rel-btn-ghost">Cancel</button>
        <button id="relSave" type="button" class="rel-btn rel-btn-primary">Save related event</button>
      </div>
    </div>`,
  });

  const close = () => closeRelatedEventModal();
  dismissOnBackdrop(modal, close);
  modal.querySelector('#relModalClose').addEventListener('click', close);
  modal.querySelector('#relCancel').addEventListener('click', close);
  modal.querySelector('#relSave').addEventListener('click', saveRelatedEventModal);
  modal.querySelector('#relLogoUpload').addEventListener('click', pickAndUploadLogo);
  modal.querySelector('#relLogoRemove').addEventListener('click', () => setLogo(''));

  // Searchable schedule picker (typeahead) — a plain 80-option <select> was unusable.
  const search = modal.querySelector('#relScheduleSearch');
  const results = modal.querySelector('#relScheduleResults');
  search.addEventListener('focus', () => renderScheduleResults(search.value));
  search.addEventListener('input', () => {
    modal.querySelector('#relSchedule').value = ''; // typing invalidates the prior pick
    modal.querySelector('#relScheduleClear').classList.add('hidden');
    renderScheduleResults(search.value);
  });
  // mousedown (not click) so the pick registers before the input's blur closes the list.
  results.addEventListener('mousedown', (e) => {
    const li = e.target.closest('[data-id]');
    if (!li) return;
    e.preventDefault();
    applySchedule(li.dataset.id, li.dataset.label);
  });
  modal.querySelector('#relScheduleClear').addEventListener('click', () => {
    applySchedule('', '');
    search.focus();
  });
  search.addEventListener('blur', () => setTimeout(() => results.classList.add('hidden'), 120));

  trapFocus(modal, close);
  return modal;
}

// Render the filtered event list under the schedule search box.
function renderScheduleResults(query) {
  const modal = document.getElementById(MODAL_ID);
  if (!modal) return;
  const results = modal.querySelector('#relScheduleResults');
  const q = String(query || '')
    .trim()
    .toLowerCase();
  const matches = scheduleOptions
    .filter((o) => !q || o.label.toLowerCase().includes(q))
    .slice(0, 60);
  results.innerHTML = matches.length
    ? matches
        .map(
          (o) =>
            `<li class="rel-combo-item" role="option" data-id="${escapeHtml(
              o.id,
            )}" data-label="${escapeHtml(o.label)}">${escapeHtml(o.label)}</li>`,
        )
        .join('')
    : '<li class="rel-combo-empty">No matching events</li>';
  results.classList.remove('hidden');
  modal.querySelector('#relScheduleSearch').setAttribute('aria-expanded', 'true');
}

// Commit a schedule choice: store the id, show its label, close the list.
function applySchedule(id, label) {
  const modal = document.getElementById(MODAL_ID);
  if (!modal) return;
  modal.querySelector('#relSchedule').value = id;
  modal.querySelector('#relScheduleSearch').value = id ? label : '';
  modal.querySelector('#relScheduleClear').classList.toggle('hidden', !id);
  modal.querySelector('#relScheduleResults').classList.add('hidden');
  modal.querySelector('#relScheduleSearch').setAttribute('aria-expanded', 'false');
}

// Paint the logo preview from a path or blob URL (placeholder when empty).
function renderLogoPreview(src) {
  const box = document.getElementById('relLogoPreview');
  const removeBtn = document.getElementById('relLogoRemove');
  if (!box) return;
  if (src) {
    box.innerHTML = `<img src="${escapeHtml(src)}" alt="" class="rel-logo-img">`;
    box.classList.remove('rel-logo-empty');
  } else {
    box.innerHTML = '';
    box.classList.add('rel-logo-empty');
  }
  if (removeBtn) removeBtn.disabled = !src;
}

// Set the stored image path (hidden input) + refresh the preview.
function setLogo(path) {
  const input = document.getElementById('relImage');
  if (input) input.value = path;
  renderLogoPreview(path);
}

async function pickAndUploadLogo() {
  if (typeof uploadImage !== 'function') {
    window.alert('Connect a folder or configure an API server to upload images.');
    return;
  }
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = '.svg,image/*';
  picker.click();
  await new Promise((resolve) => picker.addEventListener('change', resolve, { once: true }));
  const file = picker.files && picker.files[0] ? picker.files[0] : null;
  if (!file) return;

  const name = document.getElementById('relName')?.value.trim() || 'related';
  // Show an instant local preview while the upload lands.
  renderLogoPreview(URL.createObjectURL(file));
  const path = await uploadImage(file, name).catch(() => null);
  if (!path) {
    renderLogoPreview(document.getElementById('relImage')?.value || '');
    return;
  }
  setLogo(path);
  const altInput = document.getElementById('relImageAlt');
  if (altInput && !altInput.value.trim()) altInput.value = `${name} logo`;
}

function closeRelatedEventModal() {
  const modal = document.getElementById(MODAL_ID);
  if (!modal) return;
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  editingIndex = -1;
}

async function openRelatedEventModal(index = -1) {
  const modal = ensureModal();
  editingIndex = index;
  const entry = index >= 0 ? list()[index] : null;

  // Load the catalog choices for the searchable schedule picker (self excluded).
  scheduleOptions = await catalogOptions();
  const picked = entry?.scheduleId ? scheduleOptions.find((o) => o.id === entry.scheduleId) : null;
  modal.querySelector('#relSchedule').value = entry?.scheduleId || '';
  // Show the friendly label; fall back to the raw id if it isn't in the catalog.
  modal.querySelector('#relScheduleSearch').value = entry?.scheduleId
    ? picked?.label || entry.scheduleId
    : '';
  modal.querySelector('#relScheduleClear').classList.toggle('hidden', !entry?.scheduleId);
  modal.querySelector('#relScheduleResults').classList.add('hidden');

  modal.querySelector('#relModalTitle').textContent = entry
    ? 'Edit related event'
    : 'Add related event';
  modal.querySelector('#relName').value = entry?.name || '';
  modal.querySelector('#relRelationship').value = entry?.relationship || 'Partner';
  modal.querySelector('#relWebsite').value = entry?.website || '';
  modal.querySelector('#relImage').value = entry?.image || '';
  modal.querySelector('#relImageAlt').value = entry?.imageAlt || '';
  modal.querySelector('#relDescription').value = entry?.description || '';
  modal.querySelector('#relFeatured').checked = entry?.featured === true;
  modal.querySelector('#relEnabled').checked = entry ? entry.enabled !== false : true;
  renderLogoPreview(entry?.image || '');

  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  modal.querySelector('#relName').focus();
}

function saveRelatedEventModal() {
  const modal = document.getElementById(MODAL_ID);
  if (!modal) return;
  const val = (sel) => modal.querySelector(sel).value.trim();
  const name = val('#relName');
  if (!name) {
    modal.querySelector('#relName').focus();
    return;
  }
  const items = list();
  const existing = editingIndex >= 0 ? items[editingIndex] : null;
  const entry = {
    id: existing?.id || uniqueId(name, editingIndex),
    name,
    relationship: val('#relRelationship') || 'Partner',
    scheduleId: val('#relSchedule'),
    website: val('#relWebsite'),
    image: val('#relImage'),
    imageAlt: val('#relImageAlt'),
    description: val('#relDescription'),
    priority: existing?.priority ?? items.reduce((m, it) => Math.max(m, it.priority || 0), 0) + 10,
    featured: modal.querySelector('#relFeatured').checked,
    enabled: modal.querySelector('#relEnabled').checked,
  };
  if (existing) items[editingIndex] = entry;
  else items.push(entry);

  markDirty(true);
  closeRelatedEventModal();
  renderRelatedList();
}

export function deleteRelatedEvent(index) {
  const items = list();
  if (index < 0 || index >= items.length) return;
  items.splice(index, 1);
  markDirty(true);
  renderRelatedList();
}

// ── Panel wiring ──────────────────────────────────────────────────────────────

export function wireRelatedEventsPanel() {
  document
    .getElementById('addRelatedEvent')
    ?.addEventListener('click', () => openRelatedEventModal(-1));

  const headingInput = document.getElementById('relatedEventsHeadingInput');
  headingInput?.addEventListener('input', () => {
    if (!state?.dataset?.event) return;
    state.dataset.event.relatedEventsHeading = headingInput.value;
    markDirty(true);
  });

  const placementSel = document.getElementById('relatedEventsPlacementSelect');
  placementSel?.addEventListener('change', () => {
    if (!state?.dataset?.event) return;
    state.dataset.event.relatedEventsPlacement = placementSel.value === 'above' ? 'above' : 'below';
    markDirty(true);
  });

  const listEl = document.getElementById('relatedEventsList');
  listEl?.addEventListener('click', (e) => {
    const edit = e.target.closest('.rel-edit');
    if (edit) return void openRelatedEventModal(Number.parseInt(edit.dataset.index, 10));
    const del = e.target.closest('.rel-delete');
    if (del) return void deleteRelatedEvent(Number.parseInt(del.dataset.index, 10));
  });
}
