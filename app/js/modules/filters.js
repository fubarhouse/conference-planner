import state, { getStorageKey } from './state.js';
import { debounce, getLocalDate, announceStatus, normalizeTracks, deriveSummaryFromEvent } from './utils.js';
import { displayEvents } from './render.js';
import { updateDownloadButton } from './calendar.js';

let updateSelectionOverviewFn = () => {};

export function setSelectionOverviewUpdater(fn) {
  updateSelectionOverviewFn = fn;
}

export function toggleClearButton() {
  const keywordsFilter = document.getElementById('keywordsFilter');
  const clearButton = document.getElementById('clearKeywords');

  if (keywordsFilter.value.trim() !== '') {
    clearButton.classList.remove('hidden');
  } else {
    clearButton.classList.add('hidden');
  }
}

export function filterEvents(events, { keyword = '', date = '', track = '', selectionMode = 'all' } = {}) {
  const kw = keyword.toLowerCase();
  return events.filter((event) => {
    const titleText = String(event.title || '');
    const summaryText = String(deriveSummaryFromEvent(event) || '');
    const fullDescriptionText = String(event.full_description || '');
    const locationText = String(event.location || '');
    const eventTracks = normalizeTracks(event.track);
    const normalizedTrack = eventTracks.join(' ');
    const speakersText = Array.isArray(event.speakers)
      ? event.speakers.join(' ')
      : typeof event.speakers === 'string'
        ? event.speakers
        : '';

    const matchesDate = !date || getLocalDate(event.startTime) === date;
    const matchesTrack = !track || eventTracks.includes(track);
    const matchesKeywords =
      !kw ||
      titleText.toLowerCase().includes(kw) ||
      summaryText.toLowerCase().includes(kw) ||
      fullDescriptionText.toLowerCase().includes(kw) ||
      normalizedTrack.toLowerCase().includes(kw) ||
      locationText.toLowerCase().includes(kw) ||
      speakersText.toLowerCase().includes(kw);
    const matchesSelection =
      selectionMode === 'all' ||
      (selectionMode === 'selected' && state.selectedEvents.has(event.id)) ||
      (selectionMode === 'unselected' && !state.selectedEvents.has(event.id));

    return matchesDate && matchesTrack && matchesKeywords && matchesSelection;
  });
}

function readFilterState() {
  return {
    date: document.getElementById('dateFilter').value,
    track: document.getElementById('trackFilter').value,
    keyword: document.getElementById('keywordsFilter').value,
    selectionMode: document.getElementById('selectionFilter').value
  };
}

export function applyFilters(events, triggerName = null, skipAnalytics = false, announceResultCount = true) {
  if (triggerName && !skipAnalytics) {
    window.sa_event?.(triggerName, { filter_value: document.getElementById(triggerName).value });
  }
  const filteredEvents = filterEvents(events, readFilterState());
  state.displayedEvents = filteredEvents;
  displayEvents(filteredEvents);
  if (announceResultCount) {
    const resultLabel = filteredEvents.length === 1 ? 'session' : 'sessions';
    announceStatus(`${filteredEvents.length} ${resultLabel} shown.`);
  }
}

export const debouncedFilterEvents = debounce((events) => {
  applyFilters(events, 'keywordsFilter');
}, 2000);

export function clearKeywordsFilter(events) {
  document.getElementById('keywordsFilter').value = '';
  toggleClearButton();
  applyFilters(events, null, true);
}

export function resetFilters(events) {
  window.sa_event?.('reset_filters');
  document.getElementById('dateFilter').value = '';
  document.getElementById('trackFilter').value = '';
  document.getElementById('keywordsFilter').value = '';
  document.getElementById('selectionFilter').value = 'all';
  toggleClearButton();
  applyFilters(events, null, true);
}

function getBulkTargetEvents(events) {
  return Array.isArray(events) ? events : [];
}

export function selectAllDisplayed(events) {
  const displayedEvents = getBulkTargetEvents(events);
  if (!Array.isArray(displayedEvents) || displayedEvents.length === 0) {
    announceStatus('No displayed sessions available to add.');
    return;
  }
  let addedCount = 0;

  displayedEvents.forEach((event) => {
    if (!state.selectedEvents.has(event.id)) {
      state.selectedEvents.add(event.id);
      addedCount++;
    }
  });

  if (addedCount > 0) {
    window.sa_event?.('select_all_displayed', {
      count: addedCount
    });

    localStorage.setItem(getStorageKey(), JSON.stringify([...state.selectedEvents]));

    updateDownloadButton();
    try {
      updateSelectionOverviewFn(state.allEvents);
    } catch {
      // Keep UI responsive even if overview rendering fails.
    }
    applyFilters(state.allEvents, null, true, false);
    announceStatus(
      `${addedCount} ${addedCount === 1 ? 'session' : 'sessions'} added. ${state.selectedEvents.size} selected total.`
    );
  } else {
    announceStatus('All displayed sessions are already selected.');
  }
}

export function deselectAllDisplayed(events) {
  const displayedEvents = getBulkTargetEvents(events);
  if (!Array.isArray(displayedEvents) || displayedEvents.length === 0) {
    announceStatus('No displayed sessions available to remove.');
    return;
  }
  let removedCount = 0;

  displayedEvents.forEach((event) => {
    if (state.selectedEvents.has(event.id)) {
      state.selectedEvents.delete(event.id);
      removedCount++;
    }
  });

  if (removedCount > 0) {
    window.sa_event?.('deselect_all_displayed', {
      count: removedCount
    });

    localStorage.setItem(getStorageKey(), JSON.stringify([...state.selectedEvents]));

    updateDownloadButton();
    try {
      updateSelectionOverviewFn(state.allEvents);
    } catch {
      // Keep UI responsive even if overview rendering fails.
    }
    applyFilters(state.allEvents, null, true, false);
    announceStatus(
      `${removedCount} ${removedCount === 1 ? 'session' : 'sessions'} removed. ${state.selectedEvents.size} selected total.`
    );
  } else {
    announceStatus('No selected sessions found in the current displayed list.');
  }
}
