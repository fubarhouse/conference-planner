import state, { getStorageKey } from './state.js';
import {
  debounce,
  getLocalDate,
  announceStatus,
  normalizeTracks,
  deriveSummaryFromEvent,
} from './utils.js';
import { displayEvents } from './render.js';
import { writeJson } from './plannerStorage.js';
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

export function filterEvents(
  events,
  { keyword = '', date = '', track = '', selectionMode = 'all' } = {},
) {
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

    const matchesDate = !date || getLocalDate(event.startTime, state.eventMeta?.timezone) === date;
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

/**
 * How many filters are narrowing the list right now.
 *
 * A collapsed accordion hides the reason a schedule looks short — on mobile it
 * is shut by default, so you can be staring at a filtered programme with
 * nothing on screen explaining why. Counting is the whole job; the empty string
 * and 'all' are each control's "not filtering" value.
 */
export function activeFilterCount({ date, track, keyword, selectionMode } = {}) {
  let n = 0;
  if (date) n += 1;
  if (track) n += 1;
  if (String(keyword ?? '').trim()) n += 1;
  if (selectionMode && selectionMode !== 'all') n += 1;
  return n;
}

// Show the count in two places, because the two widths reveal different things:
// the accordion toggle carries it on mobile (where the panel is shut), and the
// reset button carries it everywhere (where the panel is open, it is the only
// hint that there is anything to reset).
function renderFilterCount(count) {
  const toggle = document.getElementById('sessionFiltersToggle');
  if (toggle) {
    let badge = toggle.querySelector('.sch-filtercount');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'sch-filtercount';
      toggle.append(badge);
    }
    badge.textContent = String(count);
    badge.toggleAttribute('hidden', count === 0);
    toggle.setAttribute('aria-label', count ? `Filters, ${count} active` : 'Filters');
  }
  const reset = document.getElementById('resetFilters');
  if (reset) {
    reset.textContent = count ? `Reset filters (${count})` : 'Reset filters';
    reset.disabled = count === 0;
  }
}

/**
 * Paint the count from whatever the controls currently say. `applyFilters` runs
 * only on interaction, so without this the page would load showing a stale
 * "Reset filters" that looks clickable with nothing to reset.
 */
export function refreshFilterCount() {
  if (typeof document === 'undefined') return;
  if (!document.getElementById('keywordsFilter')) return;
  renderFilterCount(activeFilterCount(readFilterState()));
}

function readFilterState() {
  return {
    date: document.getElementById('dateFilter').value,
    track: document.getElementById('trackFilter').value,
    keyword: document.getElementById('keywordsFilter').value,
    selectionMode: document.getElementById('selectionFilter').value,
  };
}

export function applyFilters(
  events,
  triggerName = null,
  skipAnalytics = false,
  announceResultCount = true,
) {
  if (triggerName && !skipAnalytics) {
    window.sa_event?.(triggerName, { filter_value: document.getElementById(triggerName).value });
  }
  const filterState = readFilterState();
  renderFilterCount(activeFilterCount(filterState));
  const filteredEvents = filterEvents(events, filterState);
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

// A session with no time cannot become a calendar entry, so it has no checkbox
// and "Select all" must not reach past that and add it anyway. Deselect uses the
// same list, which is what clears one that a stale stored selection put there.
// Exported for its own test — the callers touch the DOM, this does not.
export function getBulkTargetEvents(events) {
  return Array.isArray(events) ? events.filter((event) => !event.unscheduled) : [];
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
      count: addedCount,
    });

    writeJson(getStorageKey(), [...state.selectedEvents]);

    updateDownloadButton();
    try {
      updateSelectionOverviewFn(state.allEvents);
    } catch {
      // Keep UI responsive even if overview rendering fails.
    }
    applyFilters(state.allEvents, null, true, false);
    announceStatus(
      `${addedCount} ${addedCount === 1 ? 'session' : 'sessions'} added. ${state.selectedEvents.size} selected total.`,
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
      count: removedCount,
    });

    writeJson(getStorageKey(), [...state.selectedEvents]);

    updateDownloadButton();
    try {
      updateSelectionOverviewFn(state.allEvents);
    } catch {
      // Keep UI responsive even if overview rendering fails.
    }
    applyFilters(state.allEvents, null, true, false);
    announceStatus(
      `${removedCount} ${removedCount === 1 ? 'session' : 'sessions'} removed. ${state.selectedEvents.size} selected total.`,
    );
  } else {
    announceStatus('No selected sessions found in the current displayed list.');
  }
}
