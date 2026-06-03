// Drag-and-drop timeline editor for event session JSON.
// Display grid: 15-minute slots at ROW_H px each.
// Drag/add snaps to 5-minute increments (SNAP_MINS).

import { escapeHtml } from './utils.js';

const SLOT_MINS = 15;                              // display granularity
const SNAP_MINS = 5;                               // drag/add snap granularity
const ROW_H = 64;                                  // px per SLOT_MINS (4×64=256px/hr)
const SNAP_H = (SNAP_MINS / SLOT_MINS) * ROW_H;   // px per snap step (≈21px)
const MIN_SESSION_PX = 14;                         // minimum rendered session height (1 text line)

let _el = null;
let _dataset = null;
let _cbs = null;
let _activeDay = null;
let _drag = null;

// ── Public API ─────────────────────────────────────────────────────────────

export function renderTimeline(container, dataset, callbacks) {
  _el = container;
  _dataset = dataset;
  _cbs = callbacks;
  _redraw();
}

// ── Time helpers ───────────────────────────────────────────────────────────

function _tz() { return _cbs.getEventTimezone(); }
function _localStr(isoUtc) { return _cbs.utcIsoToLocalInput(isoUtc, _tz()) || ''; }
function _toUtc(localStr) { return _cbs.localInputToUtcIso(localStr, _tz()) || ''; }

function _localDate(isoUtc) {
  const s = _localStr(isoUtc);
  return s ? s.split('T')[0] : null;
}

function _localMins(isoUtc) {
  const s = _localStr(isoUtc);
  if (!s) return 0;
  const [, t] = s.split('T');
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function _minsToUtc(datePart, totalMins) {
  const h = String(Math.floor(totalMins / 60)).padStart(2, '0');
  const m = String(totalMins % 60).padStart(2, '0');
  return _toUtc(`${datePart}T${h}:${m}`);
}

const esc = escapeHtml;

// ── Day extraction (event range + session dates) ───────────────────────────

function extractDays(dataset) {
  const days = new Set();
  const { startDate, endDate } = dataset.event || {};
  if (startDate && endDate) {
    const start = _localDate(startDate);
    const end = _localDate(endDate);
    if (start && end && start <= end) {
      let cur = start;
      while (cur <= end) {
        days.add(cur);
        const d = new Date(`${cur}T12:00:00`);
        d.setDate(d.getDate() + 1);
        cur = d.toISOString().split('T')[0];
      }
    }
  }
  for (const item of dataset.items || []) {
    if (item.startTime) {
      const d = _localDate(item.startTime);
      if (d) days.add(d);
    }
  }
  return Array.from(days).sort();
}

// ── Room management ────────────────────────────────────────────────────────

// event.rooms is { [dateStr]: string[] }. Legacy flat arrays are migrated on first write.

function _getRooms() {
  const rooms = _dataset.event?.rooms;
  if (!rooms) return _deriveRoomsForDay();
  if (Array.isArray(rooms)) return rooms.filter(r => r !== '');
  const dayRooms = rooms[_activeDay];
  return Array.isArray(dayRooms) ? dayRooms.filter(r => r !== '') : _deriveRoomsForDay();
}

function _deriveRoomsForDay() {
  const seen = new Set();
  for (const item of _dataset.items || []) {
    const r = item.location ?? '';
    if (r && _localDate(item.startTime) === _activeDay) seen.add(r);
  }
  return [...seen].sort();
}

function _ensureEventRooms() {
  if (!_dataset.event) _dataset.event = {};
  const rooms = _dataset.event.rooms;
  if (Array.isArray(rooms)) {
    const days = extractDays(_dataset);
    const perDay = {};
    for (const day of days) perDay[day] = rooms.filter(r => r !== '');
    _dataset.event.rooms = perDay;
  } else if (!rooms || typeof rooms !== 'object') {
    _dataset.event.rooms = {};
  }
  if (!Array.isArray(_dataset.event.rooms[_activeDay])) {
    _dataset.event.rooms[_activeDay] = _deriveRoomsForDay();
  }
}

function _addRoom() {
  const name = window.prompt('Room name:', '');
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  _ensureEventRooms();
  const dayRooms = _dataset.event.rooms[_activeDay];
  if (!dayRooms.includes(trimmed)) {
    _cbs.undoPush();
    dayRooms.push(trimmed);
    _cbs.markDirty();
  }
  _redraw();
}

function _renameRoom(idx, newName) {
  _ensureEventRooms();
  const dayRooms = _dataset.event.rooms[_activeDay];
  const oldName = dayRooms[idx];
  if (newName === oldName) return;
  _cbs.undoPush();
  dayRooms[idx] = newName;
  for (const list of Object.values(_dataset.event.rooms)) {
    const i = list.indexOf(oldName);
    if (i !== -1 && list !== dayRooms) list[i] = newName;
  }
  for (const item of _dataset.items || []) {
    if (item.location === oldName) item.location = newName;
  }
  _cbs.markDirty();
  _redraw();
}

function _deleteRoom(idx) {
  _ensureEventRooms();
  const dayRooms = _dataset.event.rooms[_activeDay];
  const room = dayRooms[idx];
  const affected = (_dataset.items || []).filter(
    item => (item.location ?? '') === room && _localDate(item.startTime) === _activeDay
  );
  if (affected.length > 0) {
    if (!window.confirm(`Remove "${room}" from ${fmtDayLabel(_activeDay)}? ${affected.length} session(s) on this day will have their location cleared.`)) return;
    for (const item of affected) item.location = '';
  }
  _cbs.undoPush();
  dayRooms.splice(idx, 1);
  _cbs.markDirty();
  _redraw();
}

function _reorderRoom(fromIdx, toIdx) {
  _ensureEventRooms();
  const rooms = _dataset.event.rooms[_activeDay];
  _cbs.undoPush();
  const [moved] = rooms.splice(fromIdx, 1);
  rooms.splice(toIdx, 0, moved);
  _cbs.markDirty();
  _redraw();
}

// ── Misc helpers ───────────────────────────────────────────────────────────

function fmtDayLabel(dateStr) {
  const d = new Date(`${dateStr}T12:00:00`);
  return d.toLocaleDateString('en', { weekday: 'short', day: 'numeric', month: 'short' });
}

function fmtMins(total) {
  const h = Math.floor(total / 60);
  const m = total % 60;
  const ampm = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 || 12;
  return m ? `${h12}:${String(m).padStart(2, '0')}${ampm}` : `${h12}${ampm}`;
}

function getTimeRange(dayItems) {
  let minMins = 8 * 60;
  let maxMins = 18 * 60;
  for (const { item } of dayItems) {
    if (item.startTime) {
      const m = _localMins(item.startTime);
      if (m < minMins) minMins = m;
    }
    if (item.endTime) {
      const m = _localMins(item.endTime);
      if (m > maxMins) maxMins = m;
    }
  }
  // Snap boundaries to SNAP_MINS
  minMins = Math.floor(minMins / SNAP_MINS) * SNAP_MINS;
  maxMins = Math.ceil(maxMins / SNAP_MINS) * SNAP_MINS;
  return { minMins, maxMins };
}

function sessionTop(startMins, minMins) {
  return Math.max(0, (startMins - minMins) / SLOT_MINS * ROW_H);
}

function sessionHeight(durMins) {
  return Math.max(MIN_SESSION_PX, (durMins / SLOT_MINS) * ROW_H);
}

function getPrimaryTrack(item) {
  if (Array.isArray(item.track)) return item.track[0] || '';
  return String(item.track || '').split(',')[0].trim();
}

// ── HTML builders ──────────────────────────────────────────────────────────

function buildDayTabs(days) {
  return `<div class="tl-day-tabs" role="tablist" aria-label="Conference days">
    ${days.map(d => `
      <button class="tl-day-tab${d === _activeDay ? ' is-active' : ''}"
              data-day="${d}" type="button" role="tab"
              aria-selected="${d === _activeDay ? 'true' : 'false'}">
        ${esc(fmtDayLabel(d))}
      </button>`).join('')}
  </div>`;
}

function buildRoomBar(rooms) {
  const chips = rooms.map((r, idx) => `
    <div class="tl-room-chip" data-room-idx="${idx}" draggable="true">
      <span class="tl-room-chip-grip" aria-hidden="true"><i class="fas fa-grip-vertical"></i></span>
      <span class="tl-room-chip-label">${esc(r)}</span>
      <button class="tl-room-chip-rename" data-room-idx="${idx}" type="button" title="Rename room">
        <i class="fas fa-pen" aria-hidden="true"></i>
      </button>
      <button class="tl-room-chip-delete" data-room-idx="${idx}" type="button" title="Remove room from this day">
        <i class="fas fa-times" aria-hidden="true"></i>
      </button>
    </div>`).join('');

  return `<div class="tl-room-bar">
    <div class="tl-room-chips">${chips || '<span class="tl-room-bar-hint">No rooms — add one to begin.</span>'}</div>
    <button class="tl-add-room-btn" type="button">
      <i class="fas fa-plus" aria-hidden="true"></i>Add room
    </button>
  </div>`;
}

function buildTimeAxis(minMins, totalSlots) {
  let labels = '';
  for (let i = 0; i <= totalSlots; i++) {
    const mins = minMins + i * SLOT_MINS;
    if (mins % 60 === 0) {
      labels += `<div class="tl-time-label" style="top:${40 + i * ROW_H}px">${fmtMins(mins)}</div>`;
    }
  }
  return `<div class="tl-time-axis" style="height:${40 + totalSlots * ROW_H}px">
    <div class="tl-time-axis-header"></div>
    ${labels}
  </div>`;
}

function buildCollisionLayout(roomItems) {
  const sorted = [...roomItems].sort((a, b) =>
    _localMins(a.item.startTime) - _localMins(b.item.startTime));

  const laneEnds = [];
  const layout = new Map(); // index → { lane, startMins, endMins }

  for (const { item, index } of sorted) {
    const startMins = _localMins(item.startTime);
    const endMins = item.endTime ? _localMins(item.endTime) : startMins + 60;
    let lane = laneEnds.findIndex(end => end <= startMins);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(endMins); }
    else laneEnds[lane] = endMins;
    layout.set(index, { lane, startMins, endMins });
  }

  // Second pass: compute total overlapping entries for each entry
  for (const [index, info] of layout) {
    let total = 0;
    for (const [, other] of layout) {
      if (other.startMins < info.endMins && other.endMins > info.startMins) total++;
    }
    info.total = total;
  }

  return layout;
}

function buildRoomColumn(room, dayItems, minMins, totalSlots) {
  let lines = '';
  for (let i = 0; i < totalSlots; i++) {
    const mins = minMins + i * SLOT_MINS;
    const isHour = mins % 60 === 0;
    const isHalf = !isHour && mins % 30 === 0;
    lines += `<div class="tl-slot-bg${isHour ? ' is-hour' : isHalf ? ' is-half' : ''}"
      style="top:${i * ROW_H}px;height:${ROW_H}px" data-slot-mins="${mins}"></div>`;
  }

  const roomItems = dayItems.filter(({ item }) => (item.location ?? '') === room);
  const layout = buildCollisionLayout(roomItems);
  let blocks = '';
  for (const { item, index } of roomItems) {
    const startMins = _localMins(item.startTime);
    const endMins = item.endTime ? _localMins(item.endTime) : startMins + 60;
    const durMins = Math.max(1, endMins - startMins);
    const top = sessionTop(startMins, minMins);
    const height = sessionHeight(durMins);
    const track = getPrimaryTrack(item);
    const spk = Array.isArray(item.speakers) ? item.speakers.join(', ') : (item.speakers || '');
    const compact = height < ROW_H ? ' is-compact' : '';

    const { lane, total } = layout.get(index);
    const posStyle = total > 1
      ? `;left:${lane === 0 ? '4px' : `calc(${(lane / total) * 100}% + 2px)`};right:${lane === total - 1 ? '4px' : `calc(${((total - lane - 1) / total) * 100}% + 2px)`}`
      : '';

    blocks += `
      <div class="tl-session${compact}" data-index="${index}" data-room="${esc(room)}"
           data-track="${esc(track)}" style="top:${top}px;height:${height}px${posStyle}">
        <div class="tl-session-inner">
          <div class="tl-session-title">${esc(item.title || 'Untitled')}</div>
          ${spk ? `<div class="tl-session-speakers">${esc(spk)}</div>` : ''}
          <div class="tl-session-time">${esc(fmtMins(startMins))}–${esc(fmtMins(endMins))}</div>
        </div>
        <div class="tl-session-actions">
          <div class="tl-drag-handle" aria-hidden="true"><i class="fas fa-grip-vertical"></i></div>
          <button class="tl-session-span-toggle" data-index="${index}" type="button" title="Make spanning (all rooms)">
            <i class="fas fa-expand-alt" aria-hidden="true"></i>
          </button>
          <button class="tl-session-delete" data-index="${index}" type="button" title="Delete session">
            <i class="fas fa-times" aria-hidden="true"></i>
          </button>
        </div>
        <div class="tl-resize-handle" data-index="${index}"></div>
      </div>`;
  }

  return `<div class="tl-room-col" data-room="${esc(room)}">
    ${lines}${blocks}
    <div class="tl-add-indicator" aria-hidden="true"></div>
  </div>`;
}

function buildSpanningSession(item, index, minMins) {
  const startMins = _localMins(item.startTime);
  const endMins = item.endTime ? _localMins(item.endTime) : startMins + 60;
  const durMins = Math.max(1, endMins - startMins);
  const top = sessionTop(startMins, minMins);
  const height = sessionHeight(durMins);
  const track = getPrimaryTrack(item);
  const spk = Array.isArray(item.speakers) ? item.speakers.join(', ') : (item.speakers || '');
  const compact = height < ROW_H ? ' is-compact' : '';

  return `
    <div class="tl-session tl-session-spanning${compact}" data-index="${index}" data-room=""
         data-track="${esc(track)}" style="top:${top}px;height:${height}px">
      <div class="tl-session-inner">
        <div class="tl-session-title">${esc(item.title || 'Untitled')}</div>
        ${spk ? `<div class="tl-session-speakers">${esc(spk)}</div>` : ''}
        <div class="tl-session-time">${esc(fmtMins(startMins))}–${esc(fmtMins(endMins))}</div>
      </div>
      <div class="tl-session-actions">
        <div class="tl-drag-handle" aria-hidden="true"><i class="fas fa-grip-vertical"></i></div>
        <button class="tl-session-span-toggle" data-index="${index}" type="button" title="Pin to a room">
          <i class="fas fa-compress-alt" aria-hidden="true"></i>
        </button>
        <button class="tl-session-delete" data-index="${index}" type="button" title="Delete session">
          <i class="fas fa-times" aria-hidden="true"></i>
        </button>
      </div>
      <div class="tl-resize-handle" data-index="${index}"></div>
    </div>`;
}

// ── Main render ────────────────────────────────────────────────────────────

function _redraw() {
  if (!_dataset?.event) {
    _el.innerHTML = '<p class="tl-empty">No dataset loaded. Open a dataset first.</p>';
    return;
  }

  const days = extractDays(_dataset);
  if (!days.length) {
    _el.innerHTML = '<p class="tl-empty">No conference dates found. Set Start Date and End Date on the Event tab, or add sessions with start times.</p>';
    return;
  }

  if (!_activeDay || !days.includes(_activeDay)) _activeDay = days[0];

  const rooms = _getRooms();

  const dayItems = (_dataset.items || [])
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => _localDate(item.startTime) === _activeDay);

  const { minMins, maxMins } = getTimeRange(dayItems);
  const totalSlots = Math.max(1, Math.ceil((maxMins - minMins) / SLOT_MINS));

  if (!rooms.length) {
    _el.innerHTML = `<div class="tl-root">
      ${buildDayTabs(days)}
      ${buildRoomBar([])}
    </div>`;
    _bindAll();
    return;
  }

  const colsTemplate = `repeat(${rooms.length}, minmax(180px, 1fr))`;
  const roomedItems = dayItems.filter(({ item }) => item.location);
  const spanningItems = dayItems.filter(({ item }) => !item.location);
  const spanningHtml = spanningItems.map(({ item, index }) => buildSpanningSession(item, index, minMins)).join('');

  _el.innerHTML = `<div class="tl-root">
    ${buildDayTabs(days)}
    ${buildRoomBar(rooms)}
    <div class="tl-scroll-wrap">
      <div class="tl-layout">
        ${buildTimeAxis(minMins, totalSlots)}
        <div class="tl-rooms-wrap">
          <div class="tl-rooms-header" style="grid-template-columns:${colsTemplate}">
            ${rooms.map(r => `<div class="tl-room-header">${esc(r)}</div>`).join('')}
          </div>
          <div class="tl-rooms-body" style="grid-template-columns:${colsTemplate};height:${totalSlots * ROW_H}px">
            ${rooms.map(r => buildRoomColumn(r, roomedItems, minMins, totalSlots)).join('')}
            ${spanningHtml ? `<div class="tl-spanning-layer">${spanningHtml}</div>` : ''}
          </div>
        </div>
      </div>
    </div>
  </div>`;

  _el.dataset.minMins = minMins;
  _el.dataset.rooms = JSON.stringify(rooms);

  _bindAll();
}

// ── Bind handlers ──────────────────────────────────────────────────────────

function _bindAll() {
  _el.querySelectorAll('.tl-day-tab').forEach(btn =>
    btn.addEventListener('click', () => { _activeDay = btn.dataset.day; _redraw(); }));

  _bindRoomBar();

  _el.querySelectorAll('.tl-session').forEach(block =>
    block.addEventListener('mousedown', _onMoveStart));
  _el.querySelectorAll('.tl-resize-handle').forEach(h =>
    h.addEventListener('mousedown', _onResizeStart));
  _el.querySelectorAll('.tl-session-delete').forEach(btn =>
    btn.addEventListener('click', _onDelete));
  _el.querySelectorAll('.tl-session-span-toggle').forEach(btn =>
    btn.addEventListener('click', _onSpanToggle));

  _el.querySelectorAll('.tl-room-col').forEach(col => {
    col.addEventListener('click', _onColClick);
    col.addEventListener('mousemove', _onColHover);
    col.addEventListener('mouseleave', _onColLeave);
  });

  const scrollWrap = _el.querySelector('.tl-scroll-wrap');
  if (scrollWrap) {
    scrollWrap.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        window.scrollBy({ top: e.deltaY, behavior: 'instant' });
      }
    }, { passive: false });
  }
}

let _roomDragIdx = null;

function _bindRoomBar() {
  const bar = _el.querySelector('.tl-room-bar');
  if (!bar) return;

  bar.querySelector('.tl-add-room-btn')?.addEventListener('click', _addRoom);

  bar.querySelectorAll('.tl-room-chip').forEach(chip => {
    const idx = parseInt(chip.dataset.roomIdx, 10);

    chip.querySelector('.tl-room-chip-rename')?.addEventListener('click', () =>
      _startRenameRoom(chip, idx));
    chip.querySelector('.tl-room-chip-delete')?.addEventListener('click', () =>
      _deleteRoom(idx));

    chip.addEventListener('dragstart', e => {
      _roomDragIdx = idx;
      chip.classList.add('is-room-dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    chip.addEventListener('dragend', () => {
      _roomDragIdx = null;
      bar.querySelectorAll('.tl-room-chip').forEach(c =>
        c.classList.remove('is-room-dragging', 'is-room-drag-over'));
    });
    chip.addEventListener('dragover', e => {
      if (_roomDragIdx === null || _roomDragIdx === idx) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      bar.querySelectorAll('.tl-room-chip').forEach(c => c.classList.remove('is-room-drag-over'));
      chip.classList.add('is-room-drag-over');
    });
    chip.addEventListener('dragleave', () => chip.classList.remove('is-room-drag-over'));
    chip.addEventListener('drop', e => {
      e.preventDefault();
      if (_roomDragIdx === null || _roomDragIdx === idx) return;
      _reorderRoom(_roomDragIdx, idx);
    });
  });
}

function _startRenameRoom(chip, idx) {
  const label = chip.querySelector('.tl-room-chip-label');
  if (!label) return;
  const currentName = _getRooms()[idx] ?? '';

  const input = document.createElement('input');
  input.className = 'tl-room-chip-input';
  input.value = currentName;
  label.replaceWith(input);
  input.focus();
  input.select();

  let committed = false;
  const commit = () => {
    if (committed) return;
    committed = true;
    const newName = input.value.trim();
    if (newName && newName !== currentName) {
      _renameRoom(idx, newName);
    } else {
      const restored = document.createElement('span');
      restored.className = 'tl-room-chip-label';
      restored.textContent = currentName || '(no room)';
      input.replaceWith(restored);
    }
  };

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { input.value = currentName; commit(); }
  });
}

// ── Move drag ──────────────────────────────────────────────────────────────

function _onMoveStart(e) {
  if (e.target.closest('.tl-session-delete') || e.target.closest('.tl-resize-handle') || e.target.closest('.tl-session-span-toggle')) return;
  e.preventDefault();

  const block = e.currentTarget;
  const index = parseInt(block.dataset.index, 10);
  const item = _dataset.items[index];

  _drag = {
    type: 'move',
    index,
    block,
    startX: e.clientX,
    startY: e.clientY,
    origStartMins: _localMins(item.startTime),
    origEndMins: item.endTime ? _localMins(item.endTime) : _localMins(item.startTime) + 60,
    rooms: JSON.parse(_el.dataset.rooms || '[]'),
    minMins: parseInt(_el.dataset.minMins, 10),
    targetRoom: item.location ?? '',
    isSpanning: !item.location,
  };

  block.classList.add('is-dragging');
  block.style.pointerEvents = 'none';
  document.addEventListener('mousemove', _onMoveMove);
  document.addEventListener('mouseup', _onMoveUp);
}

function _onMoveMove(e) {
  if (!_drag || _drag.type !== 'move') return;

  const snappedSlotDelta = Math.round((e.clientY - _drag.startY) / SNAP_H);
  const newStartMins = Math.max(_drag.minMins, _drag.origStartMins + snappedSlotDelta * SNAP_MINS);
  const deltaY = (newStartMins - _drag.origStartMins) / SLOT_MINS * ROW_H;
  const deltaX = _drag.isSpanning ? 0 : e.clientX - _drag.startX;
  _drag.block.style.transform = `translate(${deltaX}px, ${deltaY}px)`;

  if (_drag.rooms.length && !_drag.isSpanning) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const col = el?.closest('.tl-room-col');
    const newRoom = col?.dataset.room ?? _drag.targetRoom;
    if (newRoom !== _drag.targetRoom) {
      _drag.targetRoom = newRoom;
      _el.querySelectorAll('.tl-room-col').forEach(c =>
        c.classList.toggle('is-drop-target', c.dataset.room === newRoom));
    }
  }
}

function _onMoveUp(e) {
  if (!_drag || _drag.type !== 'move') { _cleanDrag(); return; }

  const snappedSlotDelta = Math.round((e.clientY - _drag.startY) / SNAP_H);
  const durMins = _drag.origEndMins - _drag.origStartMins;
  const newStartMins = Math.max(_drag.minMins, _drag.origStartMins + snappedSlotDelta * SNAP_MINS);

  const item = _dataset.items[_drag.index];
  _cbs.undoPush();
  item.startTime = _minsToUtc(_activeDay, newStartMins);
  item.endTime = _minsToUtc(_activeDay, newStartMins + durMins);
  if (!_drag.isSpanning) item.location = _drag.targetRoom;

  _cbs.markDirty();
  _cbs.trackQuickSessionChange(_drag.index, true);
  _cleanDrag();
  _redraw();
}

// ── Resize drag ────────────────────────────────────────────────────────────

function _onResizeStart(e) {
  e.preventDefault();
  e.stopPropagation();

  const handle = e.currentTarget;
  const block = handle.closest('.tl-session');
  const index = parseInt(handle.dataset.index, 10);
  const item = _dataset.items[index];

  _drag = {
    type: 'resize',
    index,
    block,
    startY: e.clientY,
    origHeight: parseInt(block.style.height, 10),
    origStartMins: _localMins(item.startTime),
    origEndMins: item.endTime ? _localMins(item.endTime) : _localMins(item.startTime) + 60,
  };

  block.classList.add('is-dragging');
  document.addEventListener('mousemove', _onResizeMove);
  document.addEventListener('mouseup', _onResizeUp);
}

function _onResizeMove(e) {
  if (!_drag || _drag.type !== 'resize') return;
  const snappedSlotDelta = Math.round((e.clientY - _drag.startY) / SNAP_H);
  _drag.block.style.height = `${Math.max(MIN_SESSION_PX, _drag.origHeight + snappedSlotDelta * SNAP_H)}px`;
}

function _onResizeUp(e) {
  if (!_drag || _drag.type !== 'resize') { _cleanDrag(); return; }

  const snappedSlotDelta = Math.round((e.clientY - _drag.startY) / SNAP_H);
  const newEndMins = Math.max(
    _drag.origStartMins + SNAP_MINS,
    _drag.origEndMins + snappedSlotDelta * SNAP_MINS
  );

  const item = _dataset.items[_drag.index];
  _cbs.undoPush();
  item.endTime = _minsToUtc(_activeDay, newEndMins);

  _cbs.markDirty();
  _cbs.trackQuickSessionChange(_drag.index, true);
  _cleanDrag();
  _redraw();
}

// ── Add / Delete ───────────────────────────────────────────────────────────

function _onColClick(e) {
  if (e.target.closest('.tl-session') || e.target.closest('.tl-session-delete')) return;
  if (_drag) return;

  const col = e.currentTarget;
  const room = col.dataset.room ?? '';
  const minMins = parseInt(_el.dataset.minMins, 10);
  const relY = e.clientY - col.getBoundingClientRect().top;
  const slotMins = minMins + Math.floor(relY / SNAP_H) * SNAP_MINS;

  const title = window.prompt('New session title:', '');
  if (title === null || !title.trim()) return;

  _dataset.items = _dataset.items || [];
  _cbs.undoPush();
  _dataset.items.push({
    title: title.trim(),
    startTime: _minsToUtc(_activeDay, slotMins),
    endTime: _minsToUtc(_activeDay, slotMins + 60),
    location: room,
    track: '',
    speakers: [],
    full_description: '',
  });

  _cbs.markDirty();
  _redraw();
}

function _onDelete(e) {
  e.stopPropagation();
  const index = parseInt(e.currentTarget.dataset.index, 10);
  const item = _dataset.items[index];
  if (!window.confirm(`Delete "${item.title || 'Untitled'}"?`)) return;
  _cbs.undoPush();
  _dataset.items.splice(index, 1);
  _cbs.markDirty();
  _redraw();
}

function _onSpanToggle(e) {
  e.stopPropagation();
  const index = parseInt(e.currentTarget.dataset.index, 10);
  const item = _dataset.items[index];
  _cbs.undoPush();
  if (item.location) {
    item.location = '';
  } else {
    const rooms = _getRooms();
    item.location = rooms[0] || '';
  }
  _cbs.markDirty();
  _redraw();
}

// ── Add indicator hover ────────────────────────────────────────────────────

function _onColHover(e) {
  if (_drag || e.target.closest('.tl-session')) return;
  const col = e.currentTarget;
  const relY = e.clientY - col.getBoundingClientRect().top;
  const ind = col.querySelector('.tl-add-indicator');
  if (ind) {
    ind.style.top = `${Math.floor(relY / SNAP_H) * SNAP_H}px`;
    ind.style.height = `${SNAP_H}px`;
    ind.style.display = 'flex';
  }
}

function _onColLeave() {
  _el.querySelectorAll('.tl-add-indicator').forEach(el => { el.style.display = 'none'; });
}

// ── Cleanup ────────────────────────────────────────────────────────────────

function _cleanDrag() {
  if (_drag?.block) {
    _drag.block.classList.remove('is-dragging');
    _drag.block.style.transform = '';
    _drag.block.style.pointerEvents = '';
  }
  _el?.querySelectorAll('.tl-room-col').forEach(c => c.classList.remove('is-drop-target'));
  document.removeEventListener('mousemove', _onMoveMove);
  document.removeEventListener('mousemove', _onResizeMove);
  document.removeEventListener('mouseup', _onMoveUp);
  document.removeEventListener('mouseup', _onResizeUp);
  _drag = null;
}
