// Tasks tab for the planner — task list rendering, the add/edit modal, and CRUD
// over state.planner.tasks. Extracted from planner.js. Planner-internal
// collaborators (shared state + a few render/save helpers) are supplied once via
// init(); truly shared utilities are imported directly.

import { escapeHtml as esc } from './utils.js';
import { makeItemId } from './plannerStorage.js';
import { showUndoToast } from './notify.js';
import { showModal, hideModal } from './modal.js';

const TASK_PRIORITY_ORDER = { urgent: 0, high: 1, normal: 2, low: 3 };
const TASK_STATUS_BADGE = {
  'in-progress': 'bg-blue-100 text-blue-600',
  blocked: 'bg-amber-100 text-amber-700',
};

// ── Injected planner collaborators ────────────────────────────────────────────
let state;
let localDateStr;
let fmtTime;
let renderListPanel;
let buildSessionOptions;
let scheduleAutoSave;

export function initTasks(deps) {
  ({ state, localDateStr, fmtTime, renderListPanel, buildSessionOptions, scheduleAutoSave } = deps);
}

// Static shell for the Tasks tab panel — injected into #plannerTasksPanel at boot
// so the panel's markup lives beside the code that drives it (renderTasksTab /
// wireTasksPanel populate #tasksList / wire #addTaskBtn / #tasksFilterSelect).
export function tasksPanelHtml() {
  return `
    <section>
      <div class="pln-section__head">
        <div>
          <p class="pln-eyebrow">Follow-ups</p>
          <h2 class="pln-section__title">Tasks</h2>
        </div>
        <div class="ckl-tools">
          <select id="tasksFilterSelect" class="ckl-select" aria-label="Filter tasks">
            <option value="all">All tasks</option>
            <option value="open">Open only</option>
            <option value="done">Done only</option>
          </select>
          <button id="addTaskBtn" type="button" class="pl-add-btn">Add task</button>
        </div>
      </div>
      <div id="tasksList" class="tsk-list"></div>
      <div id="tasksEmptyState" class="hidden jrn-empty">
        <p class="jrn-empty-t">Nothing on the docket</p>
        <p class="jrn-empty-s">Capture follow-ups from the event — a demo to send, a person to email, a thing to book.</p>
      </div>
    </section>`;
}

// ── Pure list ordering (filter + sort) — no DOM, unit-tested ──────────────────
// filter: 'all' | 'open' | 'done'. Open tasks sort by priority then due date and
// come before done tasks.
export function orderTasks(tasks, filter) {
  const filtered = tasks.filter((t) => {
    if (filter === 'open') return !t.done;
    if (filter === 'done') return t.done;
    return true;
  });
  const sortOpen = (a, b) => {
    const pa = TASK_PRIORITY_ORDER[a.priority] ?? 2;
    const pb = TASK_PRIORITY_ORDER[b.priority] ?? 2;
    if (pa !== pb) return pa - pb;
    if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
    if (a.dueDate) return -1;
    if (b.dueDate) return 1;
    return 0;
  };
  const open = filtered.filter((t) => !t.done).sort(sortOpen);
  const done = filtered.filter((t) => t.done);
  return [...open, ...done];
}

function taskRowHtml(task) {
  const session = task.sessionId ? state.allSessions.find((s) => s.id === task.sessionId) : null;
  const today = localDateStr(new Date());
  const overdue = !task.done && task.dueDate && task.dueDate < today;
  const dueStr = task.dueDate
    ? new Date(task.dueDate + 'T12:00:00').toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
      })
    : '';

  const pri = task.priority;
  const priChip =
    !task.done && pri && pri !== 'normal'
      ? `<span class="tsk-pri tsk-pri--${esc(pri)}">${esc(pri)}</span>`
      : '';
  const statusChip =
    !task.done && task.status && TASK_STATUS_BADGE[task.status]
      ? `<span class="tsk-chip tsk-chip--status${task.status === 'blocked' ? ' tsk-chip--blocked' : ''}">${esc(task.status)}</span>`
      : '';
  const dueChip = dueStr
    ? `<span class="tsk-chip tsk-chip--due${overdue ? ' tsk-chip--overdue' : ''}">Due ${esc(dueStr)}${overdue ? ' · overdue' : ''}</span>`
    : '';
  const sessionChip = session
    ? `<span class="tsk-chip tsk-chip--session" title="${esc(session.title)}">At ${esc(fmtTime(session.startTime))} · ${esc(session.title.slice(0, 30))}${session.title.length > 30 ? '…' : ''}</span>`
    : '';
  const meta = priChip || statusChip || dueChip || sessionChip;
  const rowMod = task.done
    ? ' tsk-row--done'
    : pri && pri !== 'normal'
      ? ` tsk-row--${esc(pri)}`
      : '';

  // The checkbox stays on the row for one-tap triage; the rest of the row is a
  // single click target that opens the task editor (which owns Edit + Delete).
  return `
    <div class="tsk-row${rowMod} tsk-row--open" data-task-id="${esc(task.id)}">
      <input type="checkbox" class="ckl-check tsk-check" data-task-id="${esc(task.id)}" data-task-field="done" ${task.done ? 'checked' : ''} aria-label="Mark task done">
      <button type="button" class="tsk-body edit-task-btn" data-task-id="${esc(task.id)}" aria-label="Edit task: ${esc(task.text || 'Untitled task')}">
        <span class="tsk-body-main">
          <span class="tsk-text">${esc(task.text || 'Untitled task')}</span>
          ${meta ? `<span class="tsk-meta">${priChip}${dueChip}${statusChip}${sessionChip}</span>` : ''}
        </span>
        <span class="pl-open-go" aria-hidden="true">&rsaquo;</span>
      </button>
    </div>`;
}

export function renderTasksTab() {
  renderListPanel(
    'tasksList',
    'tasksEmptyState',
    orderTasks(state.planner.tasks, state.tasksFilter),
    taskRowHtml,
  );
}

let _taskModalId = null;

function openTaskModal(id) {
  _taskModalId = id;
  const task = id ? state.planner.tasks.find((t) => t.id === id) : null;
  const isConference = state.planner?.isConference !== false;

  document.getElementById('taskModalTitle').textContent = id ? 'Edit Task' : 'Add Task';
  document.getElementById('taskModalText').value = task?.text || '';
  document.getElementById('taskModalDueDate').value = task?.dueDate || '';

  const statusEl = document.getElementById('taskModalStatus');
  if (statusEl) statusEl.value = task?.status || 'open';
  const priorityEl = document.getElementById('taskModalPriority');
  if (priorityEl) priorityEl.value = task?.priority || 'normal';

  const sessionRowEl = document.getElementById('taskModalSessionRow');
  if (sessionRowEl) sessionRowEl.classList.toggle('hidden', !isConference);
  const sessionEl = document.getElementById('taskModalSession');
  if (sessionEl)
    sessionEl.innerHTML = buildSessionOptions(isConference ? task?.sessionId || '' : '');

  document.getElementById('taskModalDelete')?.classList.toggle('hidden', !id);
  showModal('taskModal', 'taskModalText');
}

function saveTaskModal() {
  const isNew = !_taskModalId;
  const id = _taskModalId || makeItemId('t');
  const text = document.getElementById('taskModalText').value.trim();
  const isConference = state.planner?.isConference !== false;
  const sessionId = isConference ? document.getElementById('taskModalSession').value || null : null;
  const status = document.getElementById('taskModalStatus')?.value || 'open';
  const priority = document.getElementById('taskModalPriority')?.value || 'normal';
  const dueDate = document.getElementById('taskModalDueDate')?.value || '';
  if (isNew) {
    state.planner.tasks.unshift({ id, text, done: false, sessionId, status, priority, dueDate });
  } else {
    const task = state.planner.tasks.find((t) => t.id === id);
    if (task) {
      task.text = text;
      task.sessionId = sessionId;
      task.status = status;
      task.priority = priority;
      task.dueDate = dueDate;
    }
  }
  closeTaskModal();
  renderTasksTab();
  scheduleAutoSave();
}

function closeTaskModal() {
  hideModal('taskModal');
  _taskModalId = null;
}

function addTask() {
  openTaskModal(null);
}

function deleteTask(id) {
  const snapshot = state.planner.tasks.find((t) => t.id === id);
  if (!snapshot) return;
  state.planner.tasks = state.planner.tasks.filter((t) => t.id !== id);
  renderTasksTab();
  scheduleAutoSave();
  showUndoToast(snapshot.title || 'Task', () => {
    state.planner.tasks = [...state.planner.tasks, snapshot];
    renderTasksTab();
    scheduleAutoSave();
  });
}

function handleTaskChange(id, field, value) {
  const task = state.planner.tasks.find((t) => t.id === id);
  if (!task) return;
  task[field] = field === 'done' ? Boolean(value) : value || null;
  if (field === 'done') renderTasksTab();
  scheduleAutoSave();
}

export function wireTasksPanel() {
  const panel = document.getElementById('plannerTasksPanel');
  if (!panel) return;

  panel.addEventListener('change', (e) => {
    const id = e.target.dataset.taskId;
    const field = e.target.dataset.taskField;
    if (id && field === 'done') handleTaskChange(id, 'done', e.target.checked);
  });

  panel.addEventListener('click', (e) => {
    // The whole row (except the done checkbox) opens the editor, which owns
    // Edit + Delete; there's no inline delete button on the row anymore.
    const editBtn = e.target.closest('.edit-task-btn');
    if (editBtn) {
      openTaskModal(editBtn.dataset.taskId);
      return;
    }
  });

  document.getElementById('addTaskBtn')?.addEventListener('click', addTask);

  document.getElementById('tasksFilterSelect')?.addEventListener('change', (e) => {
    state.tasksFilter = e.target.value;
    renderTasksTab();
  });

  // Task modal wiring
  document.getElementById('taskModalClose')?.addEventListener('click', closeTaskModal);
  document.getElementById('taskModalDone')?.addEventListener('click', saveTaskModal);
  document.getElementById('taskModalDelete')?.addEventListener('click', () => {
    if (_taskModalId) {
      deleteTask(_taskModalId);
      closeTaskModal();
    }
  });
  document.getElementById('taskModal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeTaskModal();
  });
  document.getElementById('taskModal')?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeTaskModal();
  });
}
