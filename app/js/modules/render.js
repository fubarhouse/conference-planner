import state, { ENABLE_SPEAKER_SESSION_DRILLDOWN } from './state.js';
import {
  getLocalDate,
  formatDuration,
  highlightKeywords,
  escapeHtml,
  normalizeTracks,
  deriveSummaryFromEvent,
  parseSponsorIds,
  normalizeString,
} from './utils.js';
import { formatTextBlock } from './markdown.js';
import { sponsorBgClass, sponsorAspectClass } from './sponsorStyles.js';
import { normalizeSponsors } from './sponsors.js';
import { trackDayNav } from './scheduleDayNav.js';
import { itemKind, isCancelled } from './sessionKind.js';
import { buildModalOverlay, dismissOnBackdrop, trapFocus } from './modalScaffold.js';
import {
  getSpeakersInfo,
  getSpeakerEntries,
  truncateText,
  formatTalkWhen,
  talkSignature,
  collapseSpeakerModalTalks,
  parseSpeakerIdentity,
  resolveUserForSpeaker,
  getTalksForUserFromIndex,
  loadAllTalks,
} from './speakers.js';

const SPEAKER_MODAL_ID = 'speakerSessionModal';
let lastFocusedElementBeforeSpeakerModal = null;
let toggleSelectionFn = null;

export function setToggleSelectionFn(fn) {
  toggleSelectionFn = fn;
}

export function setupEventsDelegation() {
  const container = document.getElementById('eventsContainer');
  if (!container) return;

  // Opening a session is now native: <summary> handles click, Enter and Space,
  // and <details name> keeps only one open. Nothing to wire.
  //
  // Speaker drill-down is delegated because details are rendered upfront for
  // every entry — per-render listeners would mean hundreds of bindings.
  container.addEventListener('click', (e) => {
    const link = e.target.closest('.session-speaker-link');
    if (!link) return;
    const card = link.closest('[data-event-id]');
    const event = card && getEventById(card.dataset.eventId);
    if (!event) return;
    const index = Number.parseInt(link.dataset.speakerIndex || '-1', 10);
    const speaker = getSpeakerEntries(event)[index];
    if (speaker) openSpeakerModalFromSession(speaker, event);
  });

  container.addEventListener('change', (e) => {
    if (e.target.type === 'checkbox') {
      const card = e.target.closest('[data-event-id]');
      if (card) toggleSelectionFn?.(card.dataset.eventId);
    }
  });
}

function isSpeakerSessionDrilldownEnabled() {
  const params = new URLSearchParams(window.location.search);
  const value = String(
    params.get('enableSpeakers') ||
      params.get('speaker_modal') ||
      params.get('speakerDrilldown') ||
      params.get('speaker_drilldown') ||
      '',
  )
    .trim()
    .toLowerCase();

  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return ENABLE_SPEAKER_SESSION_DRILLDOWN;
}

function getSessionDescription(event) {
  return event.full_description || '';
}

function hasSessionDescription(event) {
  return Boolean(normalizeString(event.full_description));
}

function getCardSummary(event) {
  return normalizeString(deriveSummaryFromEvent(event));
}

function getSponsorsForSession(event) {
  const sponsorIds = parseSponsorIds(event?.sponsorIds);
  if (!sponsorIds.length) return [];
  const sponsorsById = new Map(
    normalizeSponsors(state.eventMeta).map((sponsor) => [sponsor.id, sponsor]),
  );
  return sponsorIds.map((id) => sponsorsById.get(id)).filter(Boolean);
}

function getEventById(eventId) {
  return state.allEvents.find((event) => event.id === eventId) || null;
}
function ensureSpeakerModal() {
  let modal = document.getElementById(SPEAKER_MODAL_ID);
  if (modal) return modal;

  modal = buildModalOverlay({
    id: SPEAKER_MODAL_ID,
    ariaHidden: true,
    innerHTML: `
    <div class="session-modal-card" role="dialog" aria-modal="true" aria-labelledby="speakerModalTitle">
      <div class="session-modal-header">
        <button id="speakerModalBack" type="button" class="session-modal-back"><span>Back to session</span>
        </button>
        <button id="speakerModalClose" type="button" class="session-modal-close" aria-label="Close speaker sessions">Close</button>
      </div>
      <div class="session-modal-body" id="speakerModalBody"></div>
    </div>
  `,
  });

  dismissOnBackdrop(modal, closeSpeakerModal);
  modal.querySelector('#speakerModalClose').addEventListener('click', closeSpeakerModal);
  modal.querySelector('#speakerModalBack').addEventListener('click', closeSpeakerModal);
  trapFocus(modal, closeSpeakerModal);

  return modal;
}

function renderSpeakerModalLoading(speakerName) {
  const body = ensureSpeakerModal().querySelector('#speakerModalBody');
  body.innerHTML = `
    <div class="speaker-modal-head">
      <h2 id="speakerModalTitle" class="session-modal-title">${escapeHtml(speakerName)}</h2>
      <span class="speaker-modal-count-badge">...</span>
    </div>
    <p class="session-modal-meta">Loading speaker sessions...</p>
  `;
}

function renderSpeakerModalContent(speaker, talks, selectedTalkRef = null) {
  const body = ensureSpeakerModal().querySelector('#speakerModalBody');
  const collapsedTalks = collapseSpeakerModalTalks(talks);
  const countLabel =
    collapsedTalks.length === 1 ? '1 session' : `${collapsedTalks.length} sessions`;

  if (collapsedTalks.length === 0) {
    body.innerHTML = `
      <div class="speaker-modal-head">
        <h2 id="speakerModalTitle" class="session-modal-title">${escapeHtml(speaker.name)}</h2>
        <span class="speaker-modal-count-badge">0</span>
      </div>
      <p class="session-modal-meta">No sessions were found for this speaker.</p>
    `;
    return;
  }

  const selectedSignature = selectedTalkRef
    ? `${selectedTalkRef.file || ''}|${selectedTalkRef.startTime || ''}|${selectedTalkRef.location || ''}|${selectedTalkRef.title || ''}`
    : '';

  const cards = collapsedTalks
    .map((talk) => {
      const isCurrentSession =
        Boolean(selectedSignature) &&
        ((Array.isArray(talk.__sourceSignatures) &&
          talk.__sourceSignatures.includes(selectedSignature)) ||
          talkSignature(talk) === selectedSignature);
      const summary = truncateText(deriveSummaryFromEvent(talk, 190), 190);
      const fullDescription = normalizeString(talk.full_description);
      const hasFullDescription = Boolean(fullDescription);
      const fullDescriptionHtml = hasFullDescription ? formatTextBlock(fullDescription) : '';
      const trackText = normalizeTracks(talk.track || []).join(', ');
      return `
        <article class="speaker-session-card${isCurrentSession ? ' speaker-session-card-current' : ''}">
          ${isCurrentSession ? '<div class="speaker-session-current-badge">Current session</div>' : ''}
          <h3 class="speaker-session-title">${escapeHtml(talk.title || 'Session')}</h3>
          <p class="speaker-session-meta"><strong>${escapeHtml(talk.eventLabel || '')}</strong></p>
          <p class="speaker-session-meta">${escapeHtml(formatTalkWhen(talk))}</p>
          ${trackText ? `<p class="speaker-session-meta">${escapeHtml(trackText)}</p>` : ''}
          ${summary ? `<p class="speaker-session-summary">${escapeHtml(summary)}</p>` : ''}
          ${
            hasFullDescription
              ? `<details class="speaker-session-accordion">
                  <summary class="speaker-session-accordion-toggle">View full description</summary>
                  <div class="speaker-session-accordion-body">${fullDescriptionHtml}</div>
                </details>`
              : ''
          }
          ${
            talk.link || talk.video_url
              ? `<div class="session-modal-links">
                  ${
                    talk.link
                      ? `<a class="session-modal-link" href="${escapeHtml(talk.link)}" target="_blank" rel="noopener noreferrer"><span>Session page</span></a>`
                      : ''
                  }
                  ${
                    talk.video_url
                      ? `<a class="session-modal-link" href="${escapeHtml(talk.video_url)}" target="_blank" rel="noopener noreferrer"><span>Watch recording</span></a>`
                      : ''
                  }
                </div>`
              : ''
          }
        </article>
      `;
    })
    .join('');

  body.innerHTML = `
    <div class="speaker-modal-head">
      <h2 id="speakerModalTitle" class="session-modal-title">${escapeHtml(speaker.name)}</h2>
      <span class="speaker-modal-count-badge">${escapeHtml(countLabel)}</span>
    </div>
    <div class="speaker-session-grid">${cards}</div>
  `;
}

async function openSpeakerModalFromSession(speaker, currentEvent) {
  if (!isSpeakerSessionDrilldownEnabled()) return;
  const speakerModal = ensureSpeakerModal();
  lastFocusedElementBeforeSpeakerModal =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;

  speakerModal.classList.remove('hidden');
  speakerModal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('session-modal-open');
  renderSpeakerModalLoading(speaker.name);

  const { speakerIndex } = await loadAllTalks();
  const identity = parseSpeakerIdentity({
    name: speaker.name,
    username: speaker.username || '',
  });
  const resolvedUser = resolveUserForSpeaker(speakerIndex, identity) || identity;
  const talks = getTalksForUserFromIndex(speakerIndex, resolvedUser).sort(
    (a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime(),
  );

  const selectedTalkRef = {
    file: state.currentEventFile,
    startTime: currentEvent?.startTime || '',
    location: currentEvent?.location || '',
    title: currentEvent?.title || '',
  };
  renderSpeakerModalContent(speaker, talks, selectedTalkRef);
  const closeButton = speakerModal.querySelector('#speakerModalClose');
  if (closeButton) {
    closeButton.focus();
  }
}

function closeSpeakerModal() {
  const modal = ensureSpeakerModal();
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');

  // Nothing to restore: the session detail is inline, not a modal.
  document.body.classList.remove('session-modal-open');

  if (
    lastFocusedElementBeforeSpeakerModal &&
    document.contains(lastFocusedElementBeforeSpeakerModal)
  ) {
    lastFocusedElementBeforeSpeakerModal.focus();
  }
  lastFocusedElementBeforeSpeakerModal = null;
}

function groupEventsByDate(events) {
  return events.reduce((groups, event) => {
    const date = getLocalDate(event.startTime, state.eventMeta?.timezone);
    if (!groups[date]) {
      groups[date] = [];
    }
    groups[date].push(event);
    return groups;
  }, {});
}

function groupEventsByStartTime(events) {
  const grouped = {};
  events.forEach((event) => {
    const startTime = event.startTime;
    if (!grouped[startTime]) {
      grouped[startTime] = [];
    }
    grouped[startTime].push(event);
  });
  return grouped;
}

function getLocationOrder(location) {
  const text = normalizeString(location);
  if (!text) return Number.POSITIVE_INFINITY;

  const parenLevel = text.match(/\(\s*level\s*(\d+)\s*\)/i);
  if (parenLevel) return Number.parseInt(parenLevel[1], 10);

  const direct = text.match(/\b(?:breakout|room|track|level)\s*(\d+)\b/i);
  if (direct) return Number.parseInt(direct[1], 10);

  return Number.POSITIVE_INFINITY;
}

function buildSponsorBlock(sessionSponsors) {
  if (!sessionSponsors.length) return '';
  const cards = sessionSponsors
    .map(
      (sponsor) => `
    <article class="session-sponsor-card">
      <div class="session-sponsor-logo ${sponsorBgClass(sponsor.bgStyle)} ${sponsorAspectClass(sponsor.aspect)}">
        ${sponsor.image ? `<img class="sponsor-logo-image" src="${escapeHtml(sponsor.image)}" alt="${escapeHtml(sponsor.imageAlt || sponsor.title)}" loading="lazy" decoding="async">` : ''}
      </div>
      <div class="session-sponsor-copy">
        <p class="session-sponsor-name">${escapeHtml(sponsor.title)}</p>
        <p class="session-sponsor-tier">${escapeHtml(sponsor.tier)}</p>
      </div>
      ${sponsor.link ? `<div class="session-sponsor-actions"><a class="sch-entry__link" href="${escapeHtml(sponsor.link)}" target="_blank" rel="noopener noreferrer">Sponsor information ↗</a></div>` : ''}
    </article>`,
    )
    .join('');
  return `
    <section class="session-sponsor-block" aria-label="Sponsored by">
      <div class="session-sponsor-block-head"><h3 class="session-sponsor-block-title u-label">Sponsored by</h3></div>
      <div class="session-sponsor-grid">${cards}</div>
    </section>`;
}

function renderEventCard(event, { keywordsFilter }) {
  const isSelected = state.selectedEvents.has(event.id);
  const startDateItem = new Date(event.startTime);
  const endDateItem = new Date(event.endTime);
  const dayDate = startDateItem.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: state.eventMeta.timezone,
  });
  const startTimeItem = startDateItem.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: state.eventMeta.timezone,
  });
  const endTimeItem = endDateItem.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: state.eventMeta.timezone,
  });

  // An unscheduled session has no times to format, and `new Date(undefined)`
  // would print "Invalid Date" into both the flag and the When fact. Empty is
  // correct: the flag is dropped and When says what is actually known.
  const timelineTime = event.unscheduled ? '' : `${startTimeItem} - ${endTimeItem}`;
  const highlightedSummary = highlightKeywords(event.title, keywordsFilter);
  const speakerEntries = getSpeakerEntries(event);
  const speakersInfo = getSpeakersInfo(speakerEntries.map((entry) => entry.name));
  const highlightedSpeakers = speakersInfo.text
    ? highlightKeywords(speakersInfo.text, keywordsFilter)
    : '';
  const highlightedLocation = event.location
    ? highlightKeywords(event.location, keywordsFilter)
    : '';
  // The description preview is NOT shown at rest — the abstract belongs in the
  // detail, and a truncated teaser on every entry makes the programme far less
  // scannable. It reappears only while a keyword search is running, because
  // then it is doing real work: the match is often in the description, and the
  // highlight is what explains why a session is in the results.
  const searching = Boolean(String(keywordsFilter || '').trim());
  const summaryText = searching ? getCardSummary(event) : '';
  const highlightedSummaryText = summaryText ? formatTextBlock(summaryText, keywordsFilter) : '';
  const trackLabels = normalizeTracks(event.track);
  const primaryTrack = trackLabels[0] || '';
  const trackText = trackLabels.join(', ');
  const highlightedTrack = trackLabels
    .map((track) => ({ raw: track, text: highlightKeywords(escapeHtml(track), keywordsFilter) }))
    .map(
      ({ raw, text }) =>
        `<span class="sch-entry__track" data-track="${escapeHtml(raw)}">${text}</span>`,
    )
    .join('');
  const durationText = formatDuration(event, event.duration);

  // Flags are words, not icon glyphs — no icon font, no third-party origin.
  // The entry's own time range is kept because sessions sharing a start time
  // do not necessarily share an end time.
  // A sprint, a summit and the pub quiz all sit in the programme, but a reader
  // scanning for talks needs to see at a glance which is which. Only the two
  // kinds that are neither a plain session nor plain logistics get a word.
  const kind = itemKind(event);
  const kindFlag = kind === 'workshop' ? 'Workshop' : kind === 'social' ? 'Social' : '';

  const flags = [
    timelineTime ? `<span class="sch-flag">${escapeHtml(timelineTime)}</span>` : '',
    durationText ? `<span class="sch-flag">${escapeHtml(durationText)}</span>` : '',
    kindFlag ? `<span class="sch-flag sch-flag--${kind}">${kindFlag}</span>` : '',
    event.video_url ? '<span class="sch-flag">Recorded</span>' : '',
    event.link ? '<span class="sch-flag">Session page</span>' : '',
  ]
    .filter(Boolean)
    .join('');

  // --- detail -------------------------------------------------------------
  // Carries everything the session modal used to show. Rendered upfront: the
  // text is already in the fetched dataset, and a closed <details> is never
  // laid out, so this costs node construction and nothing else.
  const description = getSessionDescription(event);
  const descriptionHtml = formatTextBlock(description, keywordsFilter);
  const hasDescription = hasSessionDescription(event);
  const speakersMarkup = isSpeakerSessionDrilldownEnabled()
    ? speakerEntries
        .map(
          (entry, index) =>
            `<button type="button" class="session-speaker-link" data-speaker-index="${index}">${escapeHtml(entry.name)}</button>`,
        )
        .join('<span class="session-speaker-separator">, </span>')
    : escapeHtml(speakersInfo.text);

  const fact = (label, value) =>
    value ? `<div class="sch-entry__fact"><dt>${label}</dt><dd>${value}</dd></div>` : '';

  const links = [
    event.link && hasDescription
      ? `<a class="sch-entry__link" href="${escapeHtml(event.link)}" target="_blank" rel="noopener noreferrer">Session page ↗</a>`
      : '',
    event.video_url
      ? `<a class="sch-entry__link" href="${escapeHtml(event.video_url)}" target="_blank" rel="noopener noreferrer">Watch recording ↗</a>`
      : '',
  ]
    .filter(Boolean)
    .join('');

  const selectId = `sel-${event.id}`;

  // Selecting a session builds a calendar entry from it. One with no time can
  // never produce a VEVENT, so the checkbox is not rendered at all rather than
  // shown disabled — a disabled control still says "this ought to work".
  const picker = event.unscheduled
    ? ''
    : `
      <label class="sch-entry__picker schedule-select-label" title="Add or remove from selection">
        <input type="checkbox" id="${escapeHtml(selectId)}" class="sch-entry__pick schedule-select-checkbox" ${isSelected ? 'checked' : ''}
          aria-label="${isSelected ? 'Remove session from selection' : 'Add session to selection'}: ${escapeHtml(event.title || 'Session')}" />
      </label>`;

  return `
    <article class="sch-entry${event.unscheduled ? ' sch-entry--nopick' : ''}" data-primary-track="${escapeHtml(primaryTrack)}" data-event-id="${event.id}">
      ${picker}
      <details class="sch-entry__disclosure" name="session">
        <summary class="sch-entry__summary">
          ${highlightedTrack}${
            event.location
              ? // The separator belongs to the pair, not to the room. Without a
                // track in front of it the card opened with a stray "· ".
                `<span class="sch-entry__room">${trackLabels.length ? ' · ' : ''}${highlightedLocation}</span>`
              : ''
          }
          <span class="sch-entry__title">${highlightedSummary}</span>
          ${speakersInfo.text ? `<span class="sch-entry__by">${highlightedSpeakers}</span>` : ''}
          ${summaryText ? `<span class="sch-entry__summary-text session-description-preview">${highlightedSummaryText}</span>` : ''}
          ${flags ? `<span class="sch-entry__flags">${flags}</span>` : ''}
        </summary>
        <div class="sch-entry__detail">
          <div class="sch-entry__detail-head">
            <details class="sch-entry__close sch-entry__close--top" name="session">
              <summary aria-label="Close session details">Close</summary>
            </details>
            <p class="sch-entry__detail-title">${escapeHtml(event.title || 'Session')}</p>
            ${speakersInfo.text ? `<p class="sch-entry__detail-by">${speakersMarkup}</p>` : ''}
          </div>
          <dl class="sch-entry__facts">
            ${
              event.unscheduled
                ? fact('When', 'Offered, never placed in a slot')
                : fact('When', `${escapeHtml(dayDate)}, ${escapeHtml(timelineTime)}`)
            }
            ${fact('Location', escapeHtml(event.location || ''))}
            ${fact('Track', escapeHtml(trackText))}
            ${fact('Duration', escapeHtml(durationText || ''))}
          </dl>
          <div class="sch-entry__abstract">${descriptionHtml || '<em>No description available.</em>'}</div>
          ${links ? `<div class="sch-entry__links">${links}</div>` : ''}
          <div class="sch-entry__actions">
            <label class="sch-entry__toggle" for="${escapeHtml(selectId)}">
              <span class="sch-entry__toggle-add">Add to selection</span>
              <span class="sch-entry__toggle-remove">Remove from selection</span>
            </label>
            <details class="sch-entry__close" name="session"><summary>Close</summary></details>
          </div>
          ${buildSponsorBlock(getSponsorsForSession(event))}
        </div>
      </details>
    </article>`;
}

// The empty state. It names what is filtering, because "no results" without
// the cause is a dead end — and the way out is a control, not a suggestion.
//
// Three cases share this surface and they are NOT the same statement: the
// programme could not be loaded, the event has no programme yet, or your
// filters excluded all of it. Saying "no sessions" to all three is how a broken
// page passes for an empty one.
function buildNoResults(keyword) {
  const el = document.createElement('div');
  el.className = 'sch-empty';
  const term = String(keyword || '').trim();

  if (state.datasetError) {
    el.classList.add('sch-empty--error');
    el.setAttribute('role', 'alert');
    el.innerHTML = `
      <p class="sch-empty__lead">This programme could not be loaded.</p>
      <p class="sch-empty__hint">The schedule data did not arrive. It may be a
        connection problem, or the dataset may have moved.</p>
      <button type="button" class="app-btn" data-empty-retry>Try again</button>`;
    return el;
  }

  if (!state.allEvents.length) {
    el.innerHTML = `
      <p class="sch-empty__lead">No sessions published yet.</p>
      <p class="sch-empty__hint">This event's programme has not been announced.
        Subscribe to the calendar feed and it will appear when it does.</p>`;
    return el;
  }

  el.innerHTML = `
    <p class="sch-empty__lead">No sessions match${term ? ` <strong>${escapeHtml(term)}</strong>` : ' the current filters'}.</p>
    <p class="sch-empty__hint">Widen the search, or clear the filters to see the full programme.</p>
    <button type="button" class="app-btn" data-empty-reset>Clear filters</button>`;
  return el;
}

// The sessions a barcamp offered but never placed. Rendered after the timed
// days, under a heading that says why there are no times — a reader who finds
// sessions with no slot and no explanation will assume the data is broken, and
// the whole point of this record is that it is not.
function buildSessionPool(pool, keywordsFilter) {
  const section = document.createElement('div');
  section.className = 'schedule-day sch-pool';
  section.id = 'session-pool';
  const cards = [...pool]
    .sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')))
    .map((event) => renderEventCard(event, { keywordsFilter }))
    .join('');
  section.innerHTML = `
    <div class="sch-chapter">
      <h2 class="sch-chapter__title">Sessions without a time</h2>
    </div>
    <div class="sch-pool__grid">${cards}</div>`;
  return section;
}

function displayListView(allEvents, container) {
  // A cancelled item is kept in the dataset as evidence but must never appear
  // in the programme — showing it would assert that something happened which
  // did not. Dropped here, before grouping, so day headings and slot counts
  // never include it either.
  const events = allEvents.filter((event) => !isCancelled(event));

  // A barcamp offers sessions it never places. Those carry `unscheduled: true`
  // and no times at all, so they cannot be grouped by day or slot — grouping
  // them would put every one under an Invalid Date heading. They are held back
  // here and rendered as a pool after the timed days, which is the only honest
  // position for them: inside the event, outside the timetable.
  const scheduled = events.filter((event) => !event.unscheduled);
  const pool = events.filter((event) => event.unscheduled);
  const groupedEvents = groupEventsByDate(scheduled);

  // Selecting a session re-renders the whole list, which would otherwise close
  // whatever the reader has open — you tick a talk and lose your place. Remember
  // the open entry and restore it once the new markup is in.
  const openDetail = container.querySelector('.sch-entry__disclosure[open]');
  const openEventId = openDetail?.closest('[data-event-id]')?.dataset.eventId || null;
  const openScroll = openDetail?.querySelector('.sch-entry__detail')?.scrollTop || 0;

  container.innerHTML = '';

  const keywordsFilter = document.getElementById('keywordsFilter').value;

  // Nothing matched. Without this the container is simply empty — a blank page
  // with no explanation and no way back. The announcement in filters.js already
  // tells a screen reader; this tells everyone else, and hands them the undo.
  if (!events.length) {
    container.append(buildNoResults(keywordsFilter));
    renderDayNav([]);
    return;
  }

  const dayNavItems = [];
  Object.entries(groupedEvents).forEach(([date, dateEvents]) => {
    const dateSection = document.createElement('div');
    dateSection.className = 'schedule-day';
    dateSection.id = `day-${date}`;
    dateSection.dataset.day = date;
    const formattedDate = new Date(date + 'T12:00:00').toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    });
    const navDate = new Date(date + 'T12:00:00');
    dayNavItems.push({
      date,
      short: `${navDate.toLocaleDateString('en-US', { weekday: 'short' })} ${navDate.getDate()}`,
    });

    const sortedDateEvents = [...dateEvents].sort((a, b) => {
      const byTime = new Date(a.startTime) - new Date(b.startTime);
      if (byTime !== 0) return byTime;
      const byLocationOrder = getLocationOrder(a.location) - getLocationOrder(b.location);
      if (byLocationOrder !== 0) return byLocationOrder;
      const byLocation = String(a.location || '').localeCompare(String(b.location || ''));
      if (byLocation !== 0) return byLocation;
      return String(a.title || '').localeCompare(String(b.title || ''));
    });

    const startTimeEntries = Object.entries(groupEventsByStartTime(sortedDateEvents)).sort(
      (a, b) => new Date(a[0]) - new Date(b[0]),
    );

    let dateHtml = `<div class="sch-chapter"><h2 class="sch-chapter__title schedule-day-heading">${formattedDate}</h2></div>`;

    startTimeEntries.forEach(([startTime, timeSlotEvents]) => {
      const startDate = new Date(startTime);
      const displayTime = startDate.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: state.eventMeta.timezone,
      });

      // Three columns maximum. Beyond that the entries get too narrow to read
      // at a glance, and a uniform three reads as a programme grid rather than
      // a variable-width scatter.
      const maxColumns = Math.max(1, Math.min(3, state.eventColumns || 3));
      const slotColumns = Math.min(timeSlotEvents.length, maxColumns);
      // Min card width so auto-fit lands on `slotColumns` per row when they fit
      // comfortably, but wraps to extra rows once cards would fall below the floor.
      // -1px guards against sub-pixel rounding dropping a column.
      const slotGapRem = 0.9; // must match --sp-s, the .sch-band__events gap
      const slotMin = `max(15rem, calc((100% - ${(slotColumns - 1) * slotGapRem}rem - 1px) / ${slotColumns}))`;
      const slotStyle = `--slot-columns: ${slotColumns}; --slot-min: ${slotMin};`;
      const sortedSlotEvents = [...timeSlotEvents].sort((a, b) => {
        const byLocationOrder = getLocationOrder(a.location) - getLocationOrder(b.location);
        if (byLocationOrder !== 0) return byLocationOrder;
        const byLocation = String(a.location || '').localeCompare(String(b.location || ''));
        if (byLocation !== 0) return byLocation;
        return String(a.title || '').localeCompare(String(b.title || ''));
      });

      const slotCardsHtml = sortedSlotEvents
        .map((event) => renderEventCard(event, { keywordsFilter }))
        .join('');

      // Slot duration, for the margin figure. Sessions in a slot can end at
      // different times, so this is the shortest — each entry carries its own.
      const slotEndMs = Math.min(
        ...timeSlotEvents.map((ev) => new Date(ev.endTime).getTime()).filter(Number.isFinite),
      );
      const slotMins = Number.isFinite(slotEndMs)
        ? Math.round((slotEndMs - startDate.getTime()) / 60000)
        : 0;
      const slotDur = slotMins > 0 ? `${slotMins} min` : '';

      dateHtml += `
        <div class="sch-band timeline-row" style="${slotStyle}">
          <div class="sch-band__time timeline-time">
            <div class="sch-band__hh">${displayTime}</div>
            ${slotDur ? `<div class="sch-band__dur">${slotDur}</div>` : ''}
          </div>
          <div class="sch-band__events timeline-events">${slotCardsHtml}</div>
        </div>`;
    });

    dateSection.innerHTML = dateHtml;
    container.appendChild(dateSection);
  });

  if (pool.length) container.appendChild(buildSessionPool(pool, keywordsFilter));

  if (openEventId) {
    const reopened = container.querySelector(
      `[data-event-id="${CSS.escape(openEventId)}"] .sch-entry__disclosure`,
    );
    if (reopened) {
      reopened.open = true;
      const panel = reopened.querySelector('.sch-entry__detail');
      if (panel && openScroll) panel.scrollTop = openScroll;
    }
  }

  renderDayNav(dayNavItems);
}

// Sticky day quick-nav: chips that scroll-jump to each day. Only shown for
// multi-day events (a single day needs no nav). Rebuilt on every render so it
// reflects the currently-filtered days. Clicks are delegated in events.js.
function renderDayNav(days) {
  const nav = document.getElementById('dayNav');
  if (!nav) return;
  if (days.length < 2) {
    nav.innerHTML = '';
    nav.classList.add('hidden');
    return;
  }
  nav.innerHTML = days
    .map(
      (d) =>
        `<button type="button" class="sch-daynav__chip day-nav-chip" data-day-target="day-${escapeHtml(d.date)}">${escapeHtml(d.short)}</button>`,
    )
    .join('');
  nav.classList.remove('hidden');
  trackDayNav();
}

export function displayEvents(events) {
  const container = document.getElementById('eventsContainer');
  displayListView(events, container);
}
