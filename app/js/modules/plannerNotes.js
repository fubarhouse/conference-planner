// Notes tab for the planner — per-session notes/ratings/attendance rendering,
// the inline editors, and the "add session" search. Extracted from planner.js.
// Planner-internal collaborators (shared state + date/save helpers) are supplied
// once via init(); shared utilities are imported directly.

import { escapeHtml as esc } from './utils.js';

// ── Injected planner collaborators ────────────────────────────────────────────
let state;
let fmtTime;
let fmtDate;
let groupByDate;
let scheduleAutoSave;

export function initNotes(deps) {
  ({ state, fmtTime, fmtDate, groupByDate, scheduleAutoSave } = deps);
}

// Build the default note record for a session that has none yet. `sessionId` is
// passed explicitly so a note can be created even for a session not in the
// catalog (session may be undefined).
function blankNote(sessionId, session) {
  return {
    sessionId,
    sessionTitle: session?.title || '',
    sessionStartTime: session?.startTime || '',
    attended: false,
    rating: 0,
    notes: '',
  };
}

function starRatingHtml(sessionId, rating) {
  return [1, 2, 3, 4, 5]
    .map((n) => {
      const filled = n <= rating;
      // ★ / ☆ rather than two icon-font weights — the same characters this file
      // already uses for the collapsed badge, so a rating reads identically
      // whether the card is open or shut.
      return `<button type="button" class="star-btn nts-star${filled ? ' nts-star--on' : ''}" data-note-id="${esc(sessionId)}" data-rating="${n}" aria-label="Rate ${n} star${n > 1 ? 's' : ''}">${filled ? '★' : '☆'}</button>`;
    })
    .join('');
}

function noteCardHtml(session, note) {
  const sid = session.id;
  const time = fmtTime(session.startTime);
  const track = Array.isArray(session.track) ? session.track.join(', ') : session.track || '';
  const hasNote = note.notes || note.rating || note.attended;

  return `
    <details class="nts-ses planner-note-card" data-session-id="${esc(sid)}" ${hasNote ? 'open' : ''}>
      <summary class="nts-ses-sum">
        <span class="note-card-chevron" aria-hidden="true">&rsaquo;</span>
        <div class="nts-ses-main">
          <p class="nts-ses-title">${esc(session.title)}</p>
          <p class="nts-ses-meta">${esc(time)}${session.location ? ` · ${esc(session.location)}` : ''}${track ? ` · ${esc(track)}` : ''}</p>
        </div>
        <div class="flex items-center gap-2 flex-shrink-0 nts-ses-badges">
          ${note.attended ? '<span class="nts-attended">Attended</span>' : ''}
          ${note.rating ? `<span class="nts-stars-inline">${'★'.repeat(note.rating)}</span>` : ''}
          ${note.notes ? '<span class="nts-has-note">Noted</span>' : ''}
        </div>
      </summary>
      <div class="nts-ses-body">
        <div class="flex items-center gap-6 flex-wrap">
          <label class="inline-flex items-center gap-2 cursor-pointer text-sm pl-ink-1">
            <input type="checkbox" class="ckl-check" data-note-field="attended" data-note-id="${esc(sid)}" ${note.attended ? 'checked' : ''}>
            Attended
          </label>
          <div class="flex items-center gap-1" role="group" aria-label="Rating">
            <span class="text-sm pl-ink-2 mr-1">Rating:</span>
            ${starRatingHtml(sid, note.rating)}
            ${note.rating ? `<button type="button" class="clear-rating-btn nts-act" data-note-id="${esc(sid)}" aria-label="Clear rating">Clear</button>` : ''}
          </div>
        </div>
        <textarea data-note-field="notes" data-note-id="${esc(sid)}" class="nts-ses-textarea"
          placeholder="Your notes for this session…">${esc(note.notes)}</textarea>
      </div>
    </details>`;
}

export function renderNotesTab() {
  const withData = document.getElementById('notesWithData');
  const empty = document.getElementById('notesEmptyState');
  const results = document.getElementById('notesSearchResults');
  if (!withData) return;

  // Sessions that have been added to the notes list (even if fields are still blank)
  const noted = state.allSessions.filter((s) => !!state.planner.sessionNotes?.[s.id]);

  // Clear search results when re-rendering
  if (results) {
    results.innerHTML = '';
    results.classList.add('hidden');
  }

  empty?.classList.toggle('hidden', noted.length > 0);

  if (noted.length === 0) {
    withData.innerHTML = '';
    return;
  }

  const groups = groupByDate(noted);
  const sortedDates = Object.keys(groups).sort();

  withData.innerHTML = sortedDates
    .map((date) => {
      const dayLabel = fmtDate(`${date}T12:00:00`);
      const cards = groups[date]
        .map((session) => {
          const note = state.planner.sessionNotes[session.id] || blankNote(session.id, session);
          return noteCardHtml(session, note);
        })
        .join('');
      return `
      <div class="mb-4">
        <p class="nts-day">${esc(dayLabel)}</p>
        <div>${cards}</div>
      </div>`;
    })
    .join('');
}

export function handleNoteChange(sessionId, field, value) {
  const session = state.allSessions.find((s) => s.id === sessionId);
  if (!state.planner.sessionNotes[sessionId]) {
    state.planner.sessionNotes[sessionId] = blankNote(sessionId, session);
  }
  state.planner.sessionNotes[sessionId][field] = value;
  scheduleAutoSave();
}

export function wireNotesPanel() {
  const panel = document.getElementById('plannerNotesPanel');
  if (!panel) return;

  panel.addEventListener('change', (e) => {
    const field = e.target.dataset.noteField;
    const id = e.target.dataset.noteId;
    if (!field || !id) return;
    const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    handleNoteChange(id, field, value);
    // Update the attended badge in summary without full re-render
    if (field === 'attended') {
      const details = e.target.closest('details[data-session-id]');
      const badge = details?.querySelector('summary .nts-attended');
      if (e.target.checked && !badge) {
        const badgeContainer = details?.querySelector('summary .nts-ses-badges');
        if (badgeContainer) {
          const span = document.createElement('span');
          span.className = 'nts-attended';
          span.textContent = 'Attended';
          badgeContainer.prepend(span);
        }
      } else if (!e.target.checked && badge) {
        badge.remove();
      }
    }
  });

  panel.addEventListener('input', (e) => {
    const field = e.target.dataset.noteField;
    const id = e.target.dataset.noteId;
    if (field === 'notes' && id) handleNoteChange(id, 'notes', e.target.value);
  });

  panel.addEventListener('click', (e) => {
    // Star rating
    const starBtn = e.target.closest('.star-btn');
    if (starBtn) {
      const id = starBtn.dataset.noteId;
      const rating = Number(starBtn.dataset.rating);
      handleNoteChange(id, 'rating', rating);
      // Re-render just this card's rating section
      const details = starBtn.closest('details[data-session-id]');
      if (details) {
        const ratingGroup = details.querySelector('[role="group"]');
        if (ratingGroup) {
          const note = state.planner.sessionNotes[id] || { rating: 0 };
          ratingGroup.innerHTML = `
            <span class="text-sm pl-ink-2 mr-1">Rating:</span>
            ${starRatingHtml(id, note.rating)}
            ${note.rating ? `<button type="button" class="clear-rating-btn nts-act" data-note-id="${esc(id)}" aria-label="Clear rating">Clear</button>` : ''}`;
        }
      }
      return;
    }
    // Clear rating
    const clearBtn = e.target.closest('.clear-rating-btn');
    if (clearBtn) {
      const id = clearBtn.dataset.noteId;
      handleNoteChange(id, 'rating', 0);
      const details = clearBtn.closest('details[data-session-id]');
      if (details) {
        const ratingGroup = details.querySelector('[role="group"]');
        if (ratingGroup) {
          ratingGroup.innerHTML = `
            <span class="text-sm pl-ink-2 mr-1">Rating:</span>
            ${starRatingHtml(id, 0)}`;
        }
      }
    }
  });

  // Chevron rotation on details toggle
  panel.addEventListener(
    'toggle',
    (e) => {
      const chevron = e.target.querySelector('.note-card-chevron');
      if (chevron) chevron.classList.toggle('rotate-90', e.target.open);
    },
    true,
  );

  // Search input — filter sessions and show results
  const searchInput = document.getElementById('notesSearchInput');
  const searchResults = document.getElementById('notesSearchResults');

  searchInput?.addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    if (!q) {
      searchResults?.classList.add('hidden');
      if (searchResults) searchResults.innerHTML = '';
      return;
    }
    const matches = state.allSessions
      .filter((s) => {
        const track = Array.isArray(s.track) ? s.track.join(' ') : s.track || '';
        return (
          s.title?.toLowerCase().includes(q) ||
          s.location?.toLowerCase().includes(q) ||
          track.toLowerCase().includes(q)
        );
      })
      .slice(0, 30);

    if (!searchResults) return;
    if (!matches.length) {
      searchResults.innerHTML = '<p class="nts-result-none">No sessions match that.</p>';
      searchResults.classList.remove('hidden');
      return;
    }
    searchResults.innerHTML = matches
      .map((s) => {
        const time = fmtTime(s.startTime);
        const track = Array.isArray(s.track) ? s.track.join(', ') : s.track || '';
        return `<button type="button" class="notes-search-result nts-result" data-session-id="${esc(s.id)}">
        <p class="nts-result-title">${esc(s.title)}</p>
        <p class="nts-result-meta">${esc(time)}${s.location ? ` · ${esc(s.location)}` : ''}${track ? ` · ${esc(track)}` : ''}</p>
      </button>`;
      })
      .join('');
    searchResults.classList.remove('hidden');
  });

  // Click on a search result row — add session note and re-render
  searchResults?.addEventListener('click', (e) => {
    const btn = e.target.closest('.notes-search-result');
    if (!btn) return;
    const sid = btn.dataset.sessionId;
    const session = state.allSessions.find((s) => s.id === sid);
    if (!session) return;
    // Add stub note if not present
    if (!state.planner.sessionNotes[sid]) {
      state.planner.sessionNotes[sid] = blankNote(sid, session);
    }
    searchResults.innerHTML = '';
    searchResults.classList.add('hidden');
    if (searchInput) searchInput.value = '';
    renderNotesTab();
    scheduleAutoSave();
    // Scroll to and open the newly added card
    setTimeout(() => {
      const el = document.querySelector(`[data-session-id="${sid}"]`);
      if (el) {
        el.setAttribute('open', '');
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }, 50);
  });
}

// Static shell for this tab panel — injected into #plannerNotesPanel at boot (#7 co-location).
export function notesPanelHtml() {
  return `
          <section>
            <div class="pln-section__head">
              <div>
                <p class="pln-eyebrow">What you thought</p>
                <h2 class="pln-section__title">Notes</h2>
              </div>
              <button id="addPersonalNoteBtn" type="button" class="pl-add-btn">Add note</button>
            </div>

            <div class="nts-section">
              <div class="doc-divider"><span>Your notes</span></div>
              <div id="personalNotesList" class="nts-list"></div>
              <p id="personalNotesEmpty" class="nts-none">Nothing jotted yet — add a note for anything about the trip.</p>
            </div>

            <div class="nts-section">
              <div class="doc-divider"><span>Session notes</span></div>
              <div class="nts-search">
                <input id="notesSearchInput" type="text" placeholder="Find a session to rate or note…" autocomplete="off">
              </div>
              <div id="notesSearchResults" class="nts-results hidden"></div>
              <div id="notesWithData"></div>
              <div id="notesEmptyState" class="nts-none" style="padding:0.4rem 0.15rem">No sessions rated yet — search above to add one.</div>
            </div>
          </section>
        `;
}
