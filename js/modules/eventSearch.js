import { escapeHtml } from './utils.js';

const SEARCH_MODAL_ID = 'eventSearchModal';

let _getEvents = () => [];
let _onSelect = async () => {};

export function configureEventSearch({ getEvents, onSelect }) {
  _getEvents = getEvents;
  _onSelect = onSelect;
}

function closeEventSearchModal() {
  const modal = document.getElementById(SEARCH_MODAL_ID);
  if (!modal) return;
  modal.classList.add('hidden');
  document.body.classList.remove('session-modal-open');
}

function renderResults(query, container) {
  const events = _getEvents();
  const q = query.toLowerCase().trim();

  const filtered = !q
    ? events
    : events.filter((evt) => {
        const haystack = [evt.designation, evt.location, evt.year, evt.region, evt.venue]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return q.split(/\s+/).every((term) => haystack.includes(term));
      });

  if (filtered.length === 0) {
    container.innerHTML =
      '<p class="event-search-empty">No events found matching your search.</p>';
    return;
  }

  container.innerHTML = filtered
    .map(
      (evt) => `
    <button type="button" class="event-search-result" data-file="${escapeHtml(evt.file)}" data-category="${escapeHtml(evt.category)}">
      <span class="event-search-result-title">
        ${escapeHtml(evt.label)}
        ${evt.enabled === false ? '<span class="event-search-result-hidden"><i class="fas fa-eye-slash" aria-hidden="true"></i> Hidden</span>' : ''}
      </span>
      ${evt.region ? `<span class="event-search-result-meta"><i class="fas fa-map-marker-alt" aria-hidden="true"></i> ${escapeHtml(evt.region)}</span>` : ''}
      ${evt.venue ? `<span class="event-search-result-meta"><i class="fas fa-building" aria-hidden="true"></i> ${escapeHtml(evt.venue)}</span>` : ''}
    </button>`
    )
    .join('');
}

function ensureEventSearchModal() {
  let modal = document.getElementById(SEARCH_MODAL_ID);
  if (modal) return modal;

  modal = document.createElement('div');
  modal.id = SEARCH_MODAL_ID;
  modal.className = 'session-modal-overlay hidden';

  modal.innerHTML = `
    <div class="session-modal-card event-search-card" role="dialog" aria-modal="true" aria-labelledby="eventSearchTitle">
      <div class="session-modal-header event-search-header">
        <h2 id="eventSearchTitle" class="event-search-title">
          <i class="fas fa-search" aria-hidden="true"></i> Find an event
        </h2>
        <button id="eventSearchClose" type="button" class="session-modal-close" aria-label="Close event search">
          <i class="fas fa-times" aria-hidden="true"></i>
        </button>
      </div>
      <div class="event-search-input-wrap">
        <div class="event-search-input-inner">
          <i class="fas fa-search event-search-input-icon" aria-hidden="true"></i>
          <input
            id="eventSearchInput"
            type="search"
            placeholder="Search by name, location, year, country..."
            class="event-search-input"
            autocomplete="off"
            aria-label="Search events"
            aria-controls="eventSearchResults"
            aria-autocomplete="list"
          >
          <button id="eventSearchClear" type="button" class="event-search-clear hidden" aria-label="Clear search">
            <i class="fas fa-times" aria-hidden="true"></i>
          </button>
        </div>
      </div>
      <div id="eventSearchResultsWrap" class="event-search-results-wrap">
        <div id="eventSearchResults" class="event-search-results" role="listbox" aria-label="Event search results"></div>
      </div>
    </div>
  `;

  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeEventSearchModal();
  });

  modal.querySelector('#eventSearchClose').addEventListener('click', closeEventSearchModal);

  const input = modal.querySelector('#eventSearchInput');
  const clearBtn = modal.querySelector('#eventSearchClear');
  const resultsContainer = modal.querySelector('#eventSearchResults');

  input.addEventListener('input', () => {
    const hasValue = input.value.length > 0;
    clearBtn.classList.toggle('hidden', !hasValue);
    renderResults(input.value, resultsContainer);
  });

  clearBtn.addEventListener('click', () => {
    input.value = '';
    clearBtn.classList.add('hidden');
    renderResults('', resultsContainer);
    input.focus();
  });

  resultsContainer.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-file]');
    if (!btn) return;
    const file = btn.getAttribute('data-file');
    const category = btn.getAttribute('data-category');
    closeEventSearchModal();
    await _onSelect(category, file);
  });

  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeEventSearchModal();
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const results = resultsContainer.querySelectorAll('.event-search-result');
      const focused = resultsContainer.querySelector('.event-search-result:focus');
      const idx = focused ? [...results].indexOf(focused) : -1;
      const next = results[idx + 1];
      if (next) next.focus();
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const results = resultsContainer.querySelectorAll('.event-search-result');
      const focused = resultsContainer.querySelector('.event-search-result:focus');
      const idx = focused ? [...results].indexOf(focused) : results.length;
      const prev = results[idx - 1];
      if (prev) prev.focus();
      else input.focus();
    }
  });

  document.body.appendChild(modal);
  return modal;
}

export function openEventSearchModal() {
  const modal = ensureEventSearchModal();
  const input = modal.querySelector('#eventSearchInput');
  const clearBtn = modal.querySelector('#eventSearchClear');
  const resultsContainer = modal.querySelector('#eventSearchResults');

  input.value = '';
  clearBtn.classList.add('hidden');
  renderResults('', resultsContainer);

  modal.classList.remove('hidden');
  document.body.classList.add('session-modal-open');

  requestAnimationFrame(() => input.focus());
}
