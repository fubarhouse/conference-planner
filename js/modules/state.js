const state = {
  currentEventFile: null,
  currentEventCategory: null,
  eventMeta: null,
  eventColumns: 3,
  scheduleLockedToCurrentEvent: false,
  themeMode: 'dark',
  selectedEvents: new Set(),
  allEvents: [],
  displayedEvents: []
};

// Experimental/private feature switch.
// Keep `false` to disable speaker session drilldown in session modal.
export const ENABLE_SPEAKER_SESSION_DRILLDOWN = false;

export function getStorageKey() {
  return `drupalconSelectedEvents_${state.currentEventFile || 'events.json'}`;
}

export default state;
