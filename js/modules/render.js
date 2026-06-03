import state, { ENABLE_SPEAKER_SESSION_DRILLDOWN } from './state.js';
import {
  getLocalDate,
  formatDuration,
  highlightKeywords,
  escapeHtml,
  normalizeTracks,
  deriveSummaryFromEvent,
  parseSponsorIds,
  getFocusableElements
} from './utils.js';
import { formatTextBlock } from './markdown.js';
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
  loadAllTalks
} from './speakers.js';

const SESSION_MODAL_ID = 'sessionDetailModal';
const SPEAKER_MODAL_ID = 'speakerSessionModal';
let lastFocusedElementBeforeModal = null;
let lastFocusedElementBeforeSpeakerModal = null;
let returnToSessionModalOnSpeakerClose = false;
let toggleSelectionFn = null;

export function setToggleSelectionFn(fn) {
  toggleSelectionFn = fn;
}

export function setupEventsDelegation() {
  const container = document.getElementById('eventsContainer');
  if (!container) return;

  container.addEventListener('click', (e) => {
    if (e.target.closest('a, label, input')) return;
    const card = e.target.closest('[data-event-id]');
    if (card) openSessionModal(card.dataset.eventId);
  });

  container.addEventListener('keydown', (e) => {
    const card = e.target.closest('[data-event-id]');
    if (!card || e.target !== card) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openSessionModal(card.dataset.eventId);
    }
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
      ''
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
  return Boolean(String(event.full_description || '').trim());
}

function getCardSummary(event) {
  return String(deriveSummaryFromEvent(event) || '').trim();
}


function getNormalizedEventSponsors() {
  if (!Array.isArray(state.eventMeta?.sponsors)) return [];
  return state.eventMeta.sponsors
    .filter((sponsor) => sponsor && typeof sponsor === 'object')
    .map((sponsor, index) => ({
      id: String(sponsor.id || '').trim() || `sponsor-${index + 1}`,
      title: String(sponsor.title || '').trim() || 'Sponsor',
      tier: String(sponsor.tier || '').trim() || 'Sponsors',
      image: String(sponsor.image || '').trim(),
      imageAlt: String(sponsor.imageAlt || '').trim(),
      link: String(sponsor.link || '').trim(),
      bgStyle: String(sponsor.bgStyle || 'auto').trim() || 'auto',
      aspect: String(sponsor.aspect || 'auto').trim() || 'auto',
      enabled: sponsor.enabled !== false && String(sponsor.enabled || '').toLowerCase() !== 'false'
    }))
    .filter((sponsor) => sponsor.enabled);
}

function getSponsorsForSession(event) {
  const sponsorIds = parseSponsorIds(event?.sponsorIds);
  if (!sponsorIds.length) return [];
  const sponsorsById = new Map(getNormalizedEventSponsors().map((sponsor) => [sponsor.id, sponsor]));
  return sponsorIds.map((id) => sponsorsById.get(id)).filter(Boolean);
}

function getEventById(eventId) {
  return state.allEvents.find((event) => event.id === eventId) || null;
}

function ensureSessionModal() {
  let modal = document.getElementById(SESSION_MODAL_ID);
  if (modal) return modal;

  modal = document.createElement('div');
  modal.id = SESSION_MODAL_ID;
  modal.className = 'session-modal-overlay hidden';
  modal.setAttribute('aria-hidden', 'true');
  modal.innerHTML = `
    <div class="session-modal-card" role="dialog" aria-modal="true" aria-labelledby="sessionModalTitle">
      <div class="session-modal-header">
        <button id="sessionModalBack" type="button" class="session-modal-back">
          <i class="fas fa-arrow-left"></i><span>Back to schedule</span>
        </button>
        <button id="sessionModalClose" type="button" class="session-modal-close" aria-label="Close session details">
          <i class="fas fa-times"></i>
        </button>
      </div>
      <div class="session-modal-body" id="sessionModalBody"></div>
    </div>
  `;
  document.body.appendChild(modal);

  modal.addEventListener('click', (event) => {
    if (event.target === modal) {
      closeSessionModal();
    }
  });
  modal.querySelector('#sessionModalClose').addEventListener('click', closeSessionModal);
  modal.querySelector('#sessionModalBack').addEventListener('click', closeSessionModal);
  modal.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeSessionModal();
      return;
    }
    if (event.key !== 'Tab') {
      return;
    }
    const focusable = getFocusableElements(modal);
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  });

  return modal;
}

function ensureSpeakerModal() {
  let modal = document.getElementById(SPEAKER_MODAL_ID);
  if (modal) return modal;

  modal = document.createElement('div');
  modal.id = SPEAKER_MODAL_ID;
  modal.className = 'session-modal-overlay hidden';
  modal.setAttribute('aria-hidden', 'true');
  modal.innerHTML = `
    <div class="session-modal-card" role="dialog" aria-modal="true" aria-labelledby="speakerModalTitle">
      <div class="session-modal-header">
        <button id="speakerModalBack" type="button" class="session-modal-back">
          <i class="fas fa-arrow-left"></i><span>Back to session</span>
        </button>
        <button id="speakerModalClose" type="button" class="session-modal-close" aria-label="Close speaker sessions">
          <i class="fas fa-times"></i>
        </button>
      </div>
      <div class="session-modal-body" id="speakerModalBody"></div>
    </div>
  `;
  document.body.appendChild(modal);

  modal.addEventListener('click', (event) => {
    if (event.target === modal) {
      closeSpeakerModal();
    }
  });
  modal.querySelector('#speakerModalClose').addEventListener('click', closeSpeakerModal);
  modal.querySelector('#speakerModalBack').addEventListener('click', closeSpeakerModal);
  modal.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeSpeakerModal();
      return;
    }
    if (event.key !== 'Tab') {
      return;
    }
    const focusable = getFocusableElements(modal);
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  });

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
  const countLabel = collapsedTalks.length === 1 ? '1 session' : `${collapsedTalks.length} sessions`;

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
      const isCurrentSession = Boolean(selectedSignature) && (
        (Array.isArray(talk.__sourceSignatures) && talk.__sourceSignatures.includes(selectedSignature)) ||
        talkSignature(talk) === selectedSignature
      );
      const summary = truncateText(deriveSummaryFromEvent(talk, 190), 190);
      const fullDescription = String(talk.full_description || '').trim();
      const hasFullDescription = Boolean(fullDescription);
      const fullDescriptionHtml = hasFullDescription ? formatTextBlock(fullDescription) : '';
      const trackText = normalizeTracks(talk.track || []).join(', ');
      return `
        <article class="speaker-session-card${isCurrentSession ? ' speaker-session-card-current' : ''}">
          ${isCurrentSession ? '<div class="speaker-session-current-badge">Current session</div>' : ''}
          <h3 class="speaker-session-title">${escapeHtml(talk.title || 'Session')}</h3>
          <p class="speaker-session-meta"><strong>${escapeHtml(talk.eventLabel || '')}</strong></p>
          <p class="speaker-session-meta"><i class="far fa-clock mr-1" aria-hidden="true"></i>${escapeHtml(formatTalkWhen(talk))}</p>
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
                      ? `<a class="session-modal-link" href="${escapeHtml(talk.link)}" target="_blank" rel="noopener noreferrer"><i class="fas fa-external-link-alt"></i><span>Session page</span></a>`
                      : ''
                  }
                  ${
                    talk.video_url
                      ? `<a class="session-modal-link" href="${escapeHtml(talk.video_url)}" target="_blank" rel="noopener noreferrer"><i class="fab fa-youtube"></i><span>Watch recording</span></a>`
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
  const sessionModal = ensureSessionModal();
  lastFocusedElementBeforeSpeakerModal = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  returnToSessionModalOnSpeakerClose = !sessionModal.classList.contains('hidden');
  if (returnToSessionModalOnSpeakerClose) {
    sessionModal.classList.add('hidden');
    sessionModal.setAttribute('aria-hidden', 'true');
  }

  speakerModal.classList.remove('hidden');
  speakerModal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('session-modal-open');
  renderSpeakerModalLoading(speaker.name);

  const { speakerIndex } = await loadAllTalks();
  const identity = parseSpeakerIdentity({
    name: speaker.name,
    username: speaker.username || ''
  });
  const resolvedUser = resolveUserForSpeaker(speakerIndex, identity) || identity;
  const talks = getTalksForUserFromIndex(speakerIndex, resolvedUser).sort(
    (a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime()
  );

  const selectedTalkRef = {
    file: state.currentEventFile,
    startTime: currentEvent?.startTime || '',
    location: currentEvent?.location || '',
    title: currentEvent?.title || ''
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

  if (returnToSessionModalOnSpeakerClose) {
    const sessionModal = ensureSessionModal();
    sessionModal.classList.remove('hidden');
    sessionModal.setAttribute('aria-hidden', 'false');
  } else {
    document.body.classList.remove('session-modal-open');
  }

  if (lastFocusedElementBeforeSpeakerModal && document.contains(lastFocusedElementBeforeSpeakerModal)) {
    lastFocusedElementBeforeSpeakerModal.focus();
  }
  lastFocusedElementBeforeSpeakerModal = null;
  returnToSessionModalOnSpeakerClose = false;
}

function buildSponsorBlock(sessionSponsors) {
  if (!sessionSponsors.length) return '';
  const cards = sessionSponsors.map((sponsor) => `
    <article class="session-sponsor-card">
      <div class="session-sponsor-logo sponsor-bg-${escapeHtml(['transparent', 'light-plate', 'dark-plate', 'brand-fill'].includes(sponsor.bgStyle) ? sponsor.bgStyle : 'auto')} sponsor-aspect-${escapeHtml(['square', 'landscape', 'banner'].includes(sponsor.aspect) ? sponsor.aspect : 'auto')}">
        ${sponsor.image ? `<img class="sponsor-logo-image" src="${escapeHtml(sponsor.image)}" alt="${escapeHtml(sponsor.imageAlt || sponsor.title)}" loading="lazy" decoding="async">` : ''}
      </div>
      <div class="session-sponsor-copy">
        <p class="session-sponsor-name">${escapeHtml(sponsor.title)}</p>
        <p class="session-sponsor-tier">${escapeHtml(sponsor.tier)}</p>
      </div>
      ${sponsor.link ? `<div class="session-sponsor-actions"><a class="session-modal-link" href="${escapeHtml(sponsor.link)}" target="_blank" rel="noopener noreferrer"><i class="fas fa-circle-info"></i><span>Sponsor information</span></a></div>` : ''}
    </article>`).join('');
  return `
    <section class="session-sponsor-block" aria-label="Sponsored by">
      <div class="session-sponsor-block-head"><h3 class="session-sponsor-block-title">Sponsored by</h3></div>
      <div class="session-sponsor-grid">${cards}</div>
    </section>`;
}

function renderSessionModalContent(event) {
  const startDate = new Date(event.startTime);
  const endDate = new Date(event.endTime);
  const dayDate = startDate.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: state.eventMeta.timezone
  });
  const startTime = startDate.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: state.eventMeta.timezone
  });
  const endTime = endDate.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: state.eventMeta.timezone
  });

  const isSelected = state.selectedEvents.has(event.id);
  const description = getSessionDescription(event);
  const descriptionHtml = formatTextBlock(description);
  const hasDescription = hasSessionDescription(event);
  const speakerEntries = getSpeakerEntries(event);
  const speakersInfo = getSpeakersInfo(speakerEntries.map((entry) => entry.name));
  const speakersIcon = speakersInfo.isMultiple ? 'fa-users' : 'fa-user';
  const whenValue = `${escapeHtml(dayDate)}, ${escapeHtml(startTime)} - ${escapeHtml(endTime)}`;
  const trackValues = normalizeTracks(event.track);
  const trackText = trackValues.join(', ');
  const body = ensureSessionModal().querySelector('#sessionModalBody');
  const sponsorBlock = buildSponsorBlock(getSponsorsForSession(event));

  body.innerHTML = `
    <h2 id="sessionModalTitle" class="session-modal-title">${escapeHtml(event.title || 'Session')}</h2>
    ${
      speakersInfo.text
        ? `<p class="session-modal-meta"><span class="session-modal-meta-label">Speakers</span><span class="session-modal-meta-value"><i class="fas ${speakersIcon} mr-1" aria-hidden="true"></i>${
          isSpeakerSessionDrilldownEnabled()
              ? `<span class="session-speaker-links">${speakerEntries
                  .map(
                    (entry, index) =>
                      `<button type="button" class="session-speaker-link" data-speaker-index="${index}">${escapeHtml(entry.name)}</button>`
                  )
                  .join('<span class="session-speaker-separator">, </span>')}</span>`
              : escapeHtml(speakersInfo.text)
          }</span></p>`
        : ''
    }
    <p class="session-modal-meta"><span class="session-modal-meta-label">When</span><span class="session-modal-meta-value"><i class="far fa-clock mr-1" aria-hidden="true"></i>${whenValue}</span></p>
    ${event.location ? `<p class="session-modal-meta"><span class="session-modal-meta-label">Location</span><span class="session-modal-meta-value">${escapeHtml(event.location)}</span></p>` : ''}
    ${trackText ? `<p class="session-modal-meta"><span class="session-modal-meta-label">Track</span><span class="session-modal-meta-value">${escapeHtml(trackText)}</span></p>` : ''}
    ${event.duration ? `<p class="session-modal-meta"><span class="session-modal-meta-label">Duration</span><span class="session-modal-meta-value">${escapeHtml(formatDuration(event, event.duration))}</span></p>` : ''}
    ${
      event.video_url || (event.link && hasDescription)
        ? `<div class="session-modal-links">
            ${event.link && hasDescription ? `<a class="session-modal-link" href="${event.link}" target="_blank" rel="noopener noreferrer"><i class="fas fa-external-link-alt"></i><span>Session page</span></a>` : ''}
            ${event.video_url ? `<a class="session-modal-link" href="${event.video_url}" target="_blank" rel="noopener noreferrer"><i class="fab fa-youtube"></i><span>Watch recording</span></a>` : ''}
          </div>`
        : ''
    }
    <div class="session-modal-description">${descriptionHtml || '<em>No description available.</em>'}</div>
    ${sponsorBlock}
    <div class="session-modal-actions">
      <button id="sessionModalToggleSelection" type="button" aria-pressed="${isSelected ? 'true' : 'false'}" class="session-modal-toggle ${isSelected ? 'is-selected' : ''}">
        ${isSelected ? 'Remove from selection' : 'Add to selection'}
      </button>
    </div>
  `;

  const toggleButton = body.querySelector('#sessionModalToggleSelection');
  toggleButton.addEventListener('click', () => {
    toggleSelectionFn?.(event.id);
    const selected = state.selectedEvents.has(event.id);
    toggleButton.classList.toggle('is-selected', selected);
    toggleButton.setAttribute('aria-pressed', selected ? 'true' : 'false');
    toggleButton.textContent = selected ? 'Remove from selection' : 'Add to selection';
  });

  if (isSpeakerSessionDrilldownEnabled()) {
    const speakerButtons = body.querySelectorAll('.session-speaker-link');
    speakerButtons.forEach((button) => {
      button.addEventListener('click', () => {
        const index = Number.parseInt(button.dataset.speakerIndex || '-1', 10);
        const speaker = speakerEntries[index];
        if (!speaker) return;
        openSpeakerModalFromSession(speaker, event);
      });
    });
  }
}

export function openSessionModal(eventId) {
  const event = getEventById(eventId);
  if (!event) return;
  const modal = ensureSessionModal();
  lastFocusedElementBeforeModal = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  renderSessionModalContent(event);
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('session-modal-open');
  const closeButton = modal.querySelector('#sessionModalClose');
  if (closeButton) {
    closeButton.focus();
  }
}

export function closeSessionModal() {
  const modal = ensureSessionModal();
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  const speakerModal = document.getElementById(SPEAKER_MODAL_ID);
  if (speakerModal && !speakerModal.classList.contains('hidden')) {
    speakerModal.classList.add('hidden');
    speakerModal.setAttribute('aria-hidden', 'true');
  }
  document.body.classList.remove('session-modal-open');
  if (lastFocusedElementBeforeModal && document.contains(lastFocusedElementBeforeModal)) {
    lastFocusedElementBeforeModal.focus();
  }
  lastFocusedElementBeforeModal = null;
  lastFocusedElementBeforeSpeakerModal = null;
  returnToSessionModalOnSpeakerClose = false;
}

export function handleSessionCardKeydown(event, eventId) {
  if (event.target !== event.currentTarget) {
    return;
  }
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    openSessionModal(eventId);
  }
}

export function groupEventsByDate(events) {
  return events.reduce((groups, event) => {
    const date = getLocalDate(event.startTime);
    if (!groups[date]) {
      groups[date] = [];
    }
    groups[date].push(event);
    return groups;
  }, {});
}

export function groupEventsByStartTime(events) {
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

function hashString(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function getEventPalette(event) {
  const palettePairs = [
    ['#0ea5e9', '#2563eb'],
    ['#f97316', '#ea580c'],
    ['#16a34a', '#0d9488'],
    ['#d946ef', '#9333ea'],
    ['#ef4444', '#dc2626'],
    ['#14b8a6', '#0891b2'],
    ['#f59e0b', '#d97706'],
    ['#22c55e', '#15803d']
  ];
  const seed = `${normalizeTracks(event.track).join('|')}|${event.title || ''}|${event.location || ''}`;
  return palettePairs[hashString(seed) % palettePairs.length];
}

function getLocationOrder(location) {
  const text = String(location || '').trim();
  if (!text) return Number.POSITIVE_INFINITY;

  const parenLevel = text.match(/\(\s*level\s*(\d+)\s*\)/i);
  if (parenLevel) return Number.parseInt(parenLevel[1], 10);

  const direct = text.match(/\b(?:breakout|room|track|level)\s*(\d+)\b/i);
  if (direct) return Number.parseInt(direct[1], 10);

  return Number.POSITIVE_INFINITY;
}

function renderEventCard(event, { keywordsFilter, isDrupalConDesign, timeSlotBgColor }) {
  const isSelected = state.selectedEvents.has(event.id);
  const startDateItem = new Date(event.startTime);
  const endDateItem = new Date(event.endTime);
  const dayDate = startDateItem.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: state.eventMeta.timezone
  });
  const startTimeItem = startDateItem.toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', timeZone: state.eventMeta.timezone
  });
  const endTimeItem = endDateItem.toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', timeZone: state.eventMeta.timezone
  });

  const fullDateTime = `${dayDate}.<br><strong>${startTimeItem} - ${endTimeItem}</strong>`;
  const timelineTime = `${startTimeItem} - ${endTimeItem}`;
  const highlightedSummary = highlightKeywords(event.title, keywordsFilter);
  const speakersInfo = getSpeakersInfo(event.speakers);
  const highlightedSpeakers = speakersInfo.text ? highlightKeywords(speakersInfo.text, keywordsFilter) : '';
  const speakersIcon = speakersInfo.isMultiple ? 'fa-users' : 'fa-user';
  const highlightedLocation = event.location ? highlightKeywords(event.location, keywordsFilter) : '';
  const descriptionText = getCardSummary(event);
  const hasDescription = hasSessionDescription(event);
  const highlightedDescription = descriptionText ? formatTextBlock(descriptionText, keywordsFilter) : '';
  const trackClass = isDrupalConDesign
    ? 'track-pill track-pill-dc'
    : 'track-pill text-xs text-gray-600 bg-white bg-opacity-60 px-2 py-1 rounded-sm inline-flex';
  const trackLabels = normalizeTracks(event.track);
  const highlightedTrack = trackLabels
    .map((track) => ({ raw: track, text: highlightKeywords(escapeHtml(track), keywordsFilter) }))
    .map(({ raw, text }) => `<span class="${trackClass}" data-track="${escapeHtml(raw)}">${text}</span>`)
    .join('');
  const primaryTrack = trackLabels[0] || '';
  const durationText = formatDuration(event, event.duration);
  const [colorA, colorB] = getEventPalette(event);
  const bgColor = isSelected ? 'drupal-blue-bg-light' : timeSlotBgColor;
  const hoverColor = isSelected ? '' : 'hover:brightness-95';
  const cardStyle = isDrupalConDesign ? `style="--event-color-a: ${colorA}; --event-color-b: ${colorB};"` : '';
  const cardExtraClass = isDrupalConDesign ? 'event-card-dc' : '';
  const selectedBadge = isSelected ? '<span class="session-selected-indicator" aria-hidden="true">Selected</span>' : '';

  return `
    <div class="event-card relative h-full p-4 rounded-md transition-colors cursor-pointer border ${cardExtraClass} ${bgColor} ${hoverColor} ${isSelected ? 'drupal-blue-border-light' : 'border-gray-300'}"
         data-primary-track="${escapeHtml(primaryTrack)}"
         role="button" tabindex="0" aria-haspopup="dialog"
         aria-label="${escapeHtml(event.title || 'Session')}. Open session details."
         data-event-id="${event.id}" ${cardStyle}>
      <div class="absolute top-3 right-3 flex flex-col items-end gap-1">
        <label class="schedule-select-label inline-flex items-center justify-center cursor-pointer select-none" title="Add or remove from selection">
          <input type="checkbox" class="h-4 w-4 schedule-select-checkbox" ${isSelected ? 'checked' : ''}
            aria-label="${isSelected ? 'Remove session from selection' : 'Add session to selection'}: ${escapeHtml(event.title || 'Session')}" />
        </label>
        ${selectedBadge}
      </div>
      <div class="absolute bottom-3 right-3 flex items-center gap-1.5">
        ${event.video_url ? '<span class="session-card-indicator" title="Recording available"><i class="fab fa-youtube"></i></span>' : ''}
        ${event.link ? '<span class="session-card-indicator session-card-indicator-link" title="Session page available"><i class="fas fa-external-link-alt"></i></span>' : ''}
        <span class="text-xs text-gray-500 whitespace-nowrap">${durationText}</span>
      </div>
      <div class="flex items-start space-x-3 flex-1 self-stretch">
        <div class="flex-1 flex flex-col h-full pr-16">
          <h3 class="text-[0.96rem] leading-[1.32] font-medium text-gray-900 mb-1">${highlightedSummary}</h3>
          ${speakersInfo.text ? `<p class="text-sm text-gray-700 mb-1"><i class="fas ${speakersIcon} mr-1" aria-hidden="true"></i>${highlightedSpeakers}</p>` : ''}
          ${event.location ? `<p class="text-sm text-gray-500 mb-1"><i class="fas fa-map-marker-alt mr-1"></i>${highlightedLocation}</p>` : ''}
          ${isDrupalConDesign
            ? `<p class="text-xs text-gray-500 mb-1"><i class="far fa-clock mr-1" aria-hidden="true"></i>${timelineTime}</p>`
            : `<p class="text-sm text-gray-600 mb-1"><i class="far fa-clock mr-1" aria-hidden="true"></i>${fullDateTime}</p>`}
          ${descriptionText ? `<div class="session-description-preview text-sm text-gray-700 mb-1">${highlightedDescription}</div>` : '<div class="mb-1"></div>'}
          ${trackLabels.length > 0 ? `<div class="mt-auto pt-[5px] flex flex-wrap gap-1">${highlightedTrack}</div>` : ''}
        </div>
      </div>
    </div>`;
}

export function displayListView(events, container) {
  const groupedEvents = groupEventsByDate(events);
  container.innerHTML = '';

  const keywordsFilter = document.getElementById('keywordsFilter').value;
  const isDrupalConDesign = true;
  const timeSlotColors = ['slot-bg-a', 'slot-bg-b'];
  const gridCols = 'grid grid-cols-1 md:grid-cols-2 lg:[grid-template-columns:repeat(var(--slot-columns),minmax(0,1fr))] gap-2';

  Object.entries(groupedEvents).forEach(([date, dateEvents]) => {
    const dateSection = document.createElement('div');
    dateSection.className = isDrupalConDesign ? 'mb-8 schedule-day' : 'mb-6';
    const formattedDate = new Date(date + 'T12:00:00').toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric'
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

    const startTimeEntries = Object.entries(groupEventsByStartTime(sortedDateEvents))
      .sort((a, b) => new Date(a[0]) - new Date(b[0]));

    let dateHtml = isDrupalConDesign
      ? `<h2 class="schedule-day-heading text-xl font-semibold text-gray-800 mb-4">${formattedDate}</h2>`
      : `<h2 class="text-xl font-semibold text-gray-800 mb-3">${formattedDate}</h2>`;

    startTimeEntries.forEach(([startTime, timeSlotEvents], index) => {
      const startDate = new Date(startTime);
      const displayDate = startDate.toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', timeZone: state.eventMeta.timezone
      });
      const displayTime = startDate.toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit', timeZone: state.eventMeta.timezone
      });

      const maxColumns = Math.max(1, Math.min(6, state.eventColumns || 3));
      const designColumnsCap = isDrupalConDesign ? Math.max(maxColumns, 4) : maxColumns;
      const slotColumns = Math.min(timeSlotEvents.length, designColumnsCap);
      const timeSlotBgColor = timeSlotColors[index % timeSlotColors.length];

      const sortedSlotEvents = [...timeSlotEvents].sort((a, b) => {
        const byLocationOrder = getLocationOrder(a.location) - getLocationOrder(b.location);
        if (byLocationOrder !== 0) return byLocationOrder;
        const byLocation = String(a.location || '').localeCompare(String(b.location || ''));
        if (byLocation !== 0) return byLocation;
        return String(a.title || '').localeCompare(String(b.title || ''));
      });

      const slotCardsHtml = sortedSlotEvents
        .map((event) => renderEventCard(event, { keywordsFilter, isDrupalConDesign, timeSlotBgColor }))
        .join('');

      if (isDrupalConDesign) {
        dateHtml += `
          <div class="timeline-row mb-3">
            <div class="timeline-time">
              <div class="timeline-time-hour">${displayTime}</div>
              <div class="timeline-time-date">${displayDate}</div>
            </div>
            <div class="timeline-events ${gridCols}" style="--slot-columns: ${slotColumns};">${slotCardsHtml}</div>
          </div>`;
      } else {
        dateHtml += `
          <div class="mb-4">
            <div class="slot-heading sticky top-0 z-10 bg-gray-100 text-sm font-semibold text-gray-600 mb-2 py-2 -mx-4 px-4">${displayDate}, from ${displayTime}</div>
            <div class="${gridCols}" style="--slot-columns: ${slotColumns};">${slotCardsHtml}</div>
          </div>`;
      }
    });

    dateSection.innerHTML = dateHtml;
    container.appendChild(dateSection);
  });
}

export function displayEvents(events) {
  const container = document.getElementById('eventsContainer');
  displayListView(events, container);
}

