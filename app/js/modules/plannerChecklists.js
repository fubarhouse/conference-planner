// @ts-check
// Checklists for the planner: multiple named tick-off lists per mode (personal /
// org) with one-click starter templates. Distinct from the Tasks tab (flat,
// actionable to-dos) — checklists are reusable grouped lists (packing, booth kit).
// The pure progress math is unit-tested; the DOM layer follows the planner's
// init → render → wire convention and is mode-aware (reads the active mode's
// `checklists` array, exactly like the Budget tab).

// ── Injected planner collaborators ──────────────────────────────────────────
/** @type {any} */
let state;
/** @type {() => void} */
let scheduleAutoSave;
/** @type {(s: any) => string} */
let esc;
/** @type {(prefix?: string) => string} */
let makeItemId;

/**
 * @param {{ state: any, scheduleAutoSave: () => void, esc: (s: any) => string,
 *   makeItemId: (prefix?: string) => string }} deps
 */
export function initChecklists(deps) {
  ({ state, scheduleAutoSave, esc, makeItemId } = deps);
}

// ── Pure progress math ──────────────────────────────────────────────────────

/**
 * @param {Array<{done?: boolean}>} items
 * @returns {{done: number, total: number, pct: number}}
 */
export function listProgress(items) {
  const total = (items || []).length;
  const done = (items || []).filter((i) => i && i.done).length;
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
}

/**
 * @param {Array<{items?: Array<{done?: boolean}>}>} lists
 * @returns {{done: number, total: number, pct: number}}
 */
export function overallProgress(lists) {
  let done = 0;
  let total = 0;
  for (const l of lists || []) {
    const p = listProgress(l.items || []);
    done += p.done;
    total += p.total;
  }
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
}

// ── Starter templates ───────────────────────────────────────────────────────

const PERSONAL_TEMPLATES = [
  {
    title: 'Packing',
    items: [
      'Passport / ID',
      'Phone + charger',
      'Laptop + charger',
      'Travel adapter',
      'Medications',
      'Toiletries',
      'Reusable water bottle',
    ],
  },
  {
    title: 'Pre-departure',
    items: [
      'Check in online',
      'Confirm accommodation',
      'Download offline maps',
      'Notify bank of travel',
      'Set out-of-office',
      'Arrange airport transport',
    ],
  },
  {
    title: 'Travel documents',
    items: [
      'Flight confirmations',
      'Accommodation bookings',
      'Travel insurance',
      'Conference ticket',
      'Emergency contacts',
    ],
  },
];

const ORG_TEMPLATES = [
  {
    title: 'Booth kit',
    items: [
      'Banner / signage',
      'Table cloth',
      'Swag / giveaways',
      'Business cards',
      'Laptop + demo device',
      'Extension cords + power board',
      'Lead capture setup',
    ],
  },
  {
    title: 'Shipping / freight',
    items: [
      'Book freight',
      'Print shipping labels',
      'Confirm delivery to venue',
      'Arrange return shipping',
    ],
  },
  {
    title: 'Team pre-event',
    items: [
      'Share schedule + shifts',
      'Book team accommodation',
      'Confirm booth staff',
      'Brief team on messaging',
      'Order catering',
    ],
  },
];

/**
 * Starter templates for a planner mode.
 * @param {string} mode
 * @returns {Array<{title: string, items: string[]}>}
 */
export function templatesFor(mode) {
  return mode === 'sponsor' ? ORG_TEMPLATES : PERSONAL_TEMPLATES;
}

// ── Planner-state accessors ─────────────────────────────────────────────────

function activeMode() {
  return state.planner?.mode === 'sponsor' ? 'sponsor' : 'personal';
}

// Lazily-initialised checklist array on the active mode's container.
/** @returns {any[]} */
function getLists() {
  const container = activeMode() === 'sponsor' ? state.planner.org : state.planner.personal;
  if (!Array.isArray(container.checklists)) container.checklists = [];
  return container.checklists;
}

// ── Panel shell (injected by planner.js) ────────────────────────────────────

export function checklistsPanelHtml() {
  return `
    <div>
      <div class="pln-section__head">
        <div>
          <p class="pln-eyebrow">Before you go</p>
          <h2 class="pln-section__title">Checklists</h2>
        </div>
        <div class="ckl-tools">
          <select id="checklistTemplate" class="ckl-select" aria-label="Add from template">
            <option value="">Add from template…</option>
          </select>
          <button id="checklistAddBtn" type="button" class="pl-add-btn">New list</button>
        </div>
      </div>
      <div id="checklistOverall"></div>
      <div id="checklistLists" class="ckl-lists"></div>
    </div>`;
}

// ── Render ──────────────────────────────────────────────────────────────────

/** @param {number} pct */
function progressBar(pct) {
  return `<div class="ckl-rule"><i style="width:${pct}%"></i></div>`;
}

function renderTemplateOptions() {
  const sel = /** @type {HTMLSelectElement|null} */ (document.getElementById('checklistTemplate'));
  if (!sel) return;
  const opts = templatesFor(activeMode())
    .map((t, i) => `<option value="${i}">${esc(t.title)}</option>`)
    .join('');
  sel.innerHTML = `<option value="">Add from template…</option>${opts}`;
}

function renderOverall() {
  const wrap = document.getElementById('checklistOverall');
  if (!wrap) return;
  const lists = getLists();
  if (!lists.length) {
    wrap.innerHTML = '';
    return;
  }
  const { done, total, pct } = overallProgress(lists);
  wrap.innerHTML = `<div class="ckl-overall">
      <span class="ckl-overall-count"><b>${done}</b> of ${total} done</span>
      ${progressBar(pct)}
      <span class="ckl-overall-pct">${pct}%</span>
    </div>`;
}

function renderLists() {
  const wrap = document.getElementById('checklistLists');
  if (!wrap) return;
  const lists = getLists();
  if (!lists.length) {
    wrap.innerHTML = `<div class="jrn-empty">
        <p class="jrn-empty-t">Nothing to check off yet</p>
        <p class="jrn-empty-s">Start a list, or pull in a packing / booth-kit template above.</p>
      </div>`;
    return;
  }
  wrap.innerHTML = lists
    .map((list) => {
      const { done, total, pct } = listProgress(list.items || []);
      const complete = total > 0 && done === total;
      const items = (list.items || [])
        .map(
          (/** @type {any} */ it) => `
        <li class="ckl-item${it.done ? ' ckl-item--done' : ''}">
          <input type="checkbox" data-cl-toggle data-list="${esc(list.id)}" data-item="${esc(it.id)}" ${it.done ? 'checked' : ''} class="ckl-check" aria-label="Done">
          <input type="text" value="${esc(it.text || '')}" data-cl-item-text data-list="${esc(list.id)}" data-item="${esc(it.id)}" class="ckl-item-text">
          <button type="button" data-cl-del-item data-list="${esc(list.id)}" data-item="${esc(it.id)}" class="ckl-item-del" aria-label="Delete item">&times;</button>
        </li>`,
        )
        .join('');
      return `<div class="ckl-list${complete ? ' ckl-list--done' : ''}">
        ${complete ? '<span class="ckl-stamp">Ready</span>' : ''}
        <div class="ckl-list-head">
          <input type="text" value="${esc(list.title || '')}" data-cl-title data-list="${esc(list.id)}" class="ckl-title" placeholder="List name">
          <span class="ckl-frac">${done}/${total}</span>
          <button type="button" data-cl-del-list data-list="${esc(list.id)}" class="ckl-del pl-act pl-act--del" aria-label="Delete list">Delete</button>
        </div>
        ${progressBar(pct)}
        <ul class="ckl-items">${items}</ul>
        <form data-cl-add-item="${esc(list.id)}" class="ckl-add">
          <input type="text" placeholder="Add an item…" class="ckl-add-input" data-cl-new-item>
          <button type="submit" class="ckl-add-btn">Add</button>
        </form>
      </div>`;
    })
    .join('');
}

export function renderChecklistsTab() {
  renderTemplateOptions();
  renderOverall();
  renderLists();
}

// ── Wire ────────────────────────────────────────────────────────────────────

/**
 * @param {string} title
 * @param {string[]} [items]
 */
function addList(title, items) {
  getLists().push({
    id: makeItemId('cl'),
    title: title || 'New list',
    items: (items || []).map((/** @type {string} */ text) => ({
      id: makeItemId('cli'),
      text,
      done: false,
    })),
  });
  scheduleAutoSave();
  renderChecklistsTab();
}

/** @param {string | null} id */
function findList(id) {
  return getLists().find((l) => l.id === id) || null;
}

export function wireChecklistsPanel() {
  document
    .getElementById('checklistAddBtn')
    ?.addEventListener('click', () => addList('New list', []));

  document.getElementById('checklistTemplate')?.addEventListener('change', (e) => {
    const sel = /** @type {HTMLSelectElement} */ (e.target);
    const idx = Number.parseInt(sel.value, 10);
    const tpl = templatesFor(activeMode())[idx];
    if (tpl) addList(tpl.title, tpl.items);
    sel.value = '';
  });

  const wrap = document.getElementById('checklistLists');

  // Add an item to a list.
  wrap?.addEventListener('submit', (e) => {
    const form = /** @type {HTMLElement} */ (e.target).closest('[data-cl-add-item]');
    if (!form) return;
    e.preventDefault();
    const list = findList(form.getAttribute('data-cl-add-item'));
    const input = /** @type {HTMLInputElement|null} */ (form.querySelector('[data-cl-new-item]'));
    const text = (input?.value || '').trim();
    if (!list || !text) return;
    list.items = list.items || [];
    list.items.push({ id: makeItemId('cli'), text, done: false });
    scheduleAutoSave();
    renderChecklistsTab();
  });

  // Toggle an item / edit item text / rename a list.
  wrap?.addEventListener('change', (e) => {
    const t = /** @type {HTMLInputElement} */ (e.target);
    if (t.hasAttribute('data-cl-toggle')) {
      const list = findList(t.getAttribute('data-list'));
      const it = list?.items?.find((/** @type {any} */ x) => x.id === t.getAttribute('data-item'));
      if (it) {
        it.done = t.checked;
        scheduleAutoSave();
        renderChecklistsTab();
      }
    } else if (t.hasAttribute('data-cl-item-text')) {
      const list = findList(t.getAttribute('data-list'));
      const it = list?.items?.find((/** @type {any} */ x) => x.id === t.getAttribute('data-item'));
      if (it) {
        it.text = t.value;
        scheduleAutoSave();
      }
    } else if (t.hasAttribute('data-cl-title')) {
      const list = findList(t.getAttribute('data-list'));
      if (list) {
        list.title = t.value;
        scheduleAutoSave();
      }
    }
  });

  // Delete an item or a whole list.
  wrap?.addEventListener('click', (e) => {
    const delItem = /** @type {HTMLElement} */ (e.target).closest('[data-cl-del-item]');
    if (delItem) {
      const list = findList(delItem.getAttribute('data-list'));
      if (list?.items) {
        list.items = list.items.filter(
          (/** @type {any} */ x) => x.id !== delItem.getAttribute('data-item'),
        );
        scheduleAutoSave();
        renderChecklistsTab();
      }
      return;
    }
    const delList = /** @type {HTMLElement} */ (e.target).closest('[data-cl-del-list]');
    if (delList) {
      const arr = getLists();
      const i = arr.findIndex((l) => l.id === delList.getAttribute('data-list'));
      if (i >= 0) {
        arr.splice(i, 1);
        scheduleAutoSave();
        renderChecklistsTab();
      }
    }
  });
}
