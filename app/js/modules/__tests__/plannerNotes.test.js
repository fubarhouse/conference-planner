import { describe, it, expect, beforeEach, vi } from 'vitest';
import { initNotes, handleNoteChange } from '../plannerNotes.js';

// handleNoteChange mutates the injected shared state and calls scheduleAutoSave.
// Wire a fake state + spy so we can assert its note-creation + field-set logic
// without a DOM.
let state;
let saveSpy;

beforeEach(() => {
  state = {
    allSessions: [{ id: 's1', title: 'Keynote', startTime: '2025-01-01T09:00:00Z' }],
    planner: { sessionNotes: {} },
  };
  saveSpy = vi.fn();
  initNotes({
    state,
    fmtTime: () => '',
    fmtDate: () => '',
    groupByDate: () => ({}),
    scheduleAutoSave: saveSpy,
  });
});

describe('handleNoteChange', () => {
  it('creates a note seeded from the session when none exists', () => {
    handleNoteChange('s1', 'attended', true);
    expect(state.planner.sessionNotes.s1).toMatchObject({
      sessionId: 's1',
      sessionTitle: 'Keynote',
      sessionStartTime: '2025-01-01T09:00:00Z',
      attended: true,
      rating: 0,
      notes: '',
    });
    expect(saveSpy).toHaveBeenCalledOnce();
  });

  it('updates an existing note in place without clobbering other fields', () => {
    state.planner.sessionNotes.s1 = {
      sessionId: 's1',
      sessionTitle: 'Keynote',
      attended: true,
      rating: 4,
      notes: 'good',
    };
    handleNoteChange('s1', 'notes', 'updated');
    expect(state.planner.sessionNotes.s1.notes).toBe('updated');
    expect(state.planner.sessionNotes.s1.rating).toBe(4);
    expect(state.planner.sessionNotes.s1.attended).toBe(true);
  });

  it('still records the id when the session is not in the catalog', () => {
    handleNoteChange('ghost', 'rating', 3);
    expect(state.planner.sessionNotes.ghost).toMatchObject({
      sessionId: 'ghost',
      sessionTitle: '',
      sessionStartTime: '',
      rating: 3,
    });
  });
});
