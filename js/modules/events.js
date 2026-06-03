import state, { getStorageKey } from './state.js';
import { loadEventCatalog } from './eventCatalog.js';
import { getLocalDate, announceStatus, normalizeTracks, escapeHtml, isLocalhost, parseSponsorIds, getFocusableElements, slugify, deriveOfficialWebsite } from './utils.js';
import { renderSponsors } from './sponsors.js';
import {
  applyFilters,
  debouncedFilterEvents,
  toggleClearButton,
  clearKeywordsFilter,
  resetFilters,
  selectAllDisplayed,
  deselectAllDisplayed,
  setSelectionOverviewUpdater
} from './filters.js';
import { displayEvents } from './render.js';
import {
  updateDownloadButton,
  downloadSelectedEvents,
  addSelectedEventsToGoogleCalendar,
  toggleEventSelection
} from './calendar.js';
import { configureEventSearch, openEventSearchModal } from './eventSearch.js';
import {
  loadThemes,
  THEME_STORAGE_KEY,
  normalizeThemeId,
  setCurrentThemeId,
  applyThemeClass,
  applyEventColors,
} from './theme.js';

const SHARE_MODAL_ID = 'shareScheduleModal';
const SHARE_CURRENT_SCHEDULE_PARAM = 'currentSchedule';
const MOBILE_VIEWPORT_MEDIA_QUERY = '(max-width: 639px)';

let updateSelectionOverview = () => {};
let updateStageStats = () => {};
const manifestEventMetaByFile = new Map();
const manifestCategoryByFile = new Map();
const manifestVisibleByFile = new Map();
let eventCatalog = [];
let mobileViewportMediaQuery = null;
let hasBoundViewportScheduleLockUi = false;

function parseModeFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const theme = String(params.get('theme') || '').toLowerCase();
  const id = String(params.get('id') || '').trim().toLowerCase();
  const currentSchedule =
    normalizeFlagValue(
      params.get(SHARE_CURRENT_SCHEDULE_PARAM) ||
        params.get('current_schedule') ||
        params.get('scheduleOnly') ||
        params.get('schedule_only')
    ) === true;
  const preview = params.get('preview') === '1';
  return { theme, id, currentSchedule, preview };
}


function isMobileViewport() {
  mobileViewportMediaQuery ||= window.matchMedia(MOBILE_VIEWPORT_MEDIA_QUERY);
  return mobileViewportMediaQuery.matches;
}

function bindViewportScheduleLockUi() {
  if (hasBoundViewportScheduleLockUi) return;
  mobileViewportMediaQuery ||= window.matchMedia(MOBILE_VIEWPORT_MEDIA_QUERY);

  const handleViewportChange = () => applyScheduleLockUi();
  if (typeof mobileViewportMediaQuery.addEventListener === 'function') {
    mobileViewportMediaQuery.addEventListener('change', handleViewportChange);
  } else if (typeof mobileViewportMediaQuery.addListener === 'function') {
    mobileViewportMediaQuery.addListener(handleViewportChange);
  }

  hasBoundViewportScheduleLockUi = true;
}


function setupEditorAccessButton() {
  const button = document.getElementById('editorAccessButton');
  if (!button) return;

  const isLocalhostResult = isLocalhost();
  if (!isLocalhostResult) {
    button.disabled = true;
    button.setAttribute('aria-disabled', 'true');
    button.title = 'Editor is available only when running locally';
    button.classList.add('is-disabled');
    return;
  }

  button.disabled = false;
  button.removeAttribute('aria-disabled');
  button.title = 'Open editor';
  button.classList.remove('is-disabled');
  button.addEventListener('click', () => {
    window.location.assign('./editor.html');
  });
}

export function wireStatsHandlers(selectionOverviewFn, stageStatsFn) {
  updateSelectionOverview = selectionOverviewFn;
  updateStageStats = stageStatsFn;
  setSelectionOverviewUpdater((events) => selectionOverviewFn(events, stageStatsFn));
}

function getEventCategoryFallback() {
  return 'Other';
}

function normalizeCategoryName(value, fallback = 'Other') {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  const lower = raw.toLowerCase();
  if (lower === 'drupalgov') return 'DrupalGovAU';
  if (lower === 'drupalgovau') return 'DrupalGovAU';
  return raw;
}

function getEventCategoryFromMeta(eventMeta = null, fallbackItem = null) {
  const fromMeta = normalizeCategoryName(eventMeta?.designation || '');
  if (fromMeta) {
    return fromMeta;
  }
  return normalizeCategoryName(getEventCategoryFallback(fallbackItem), 'Other');
}

function resolveEffectiveCategory(item = null, eventMeta = null) {
  return getEventCategoryFromMeta(eventMeta, item);
}

function normalizeFlagValue(value) {
  if (typeof value === 'boolean') return value;
  if (value == null) return null;
  const text = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on', 'enabled', 'show', 'visible'].includes(text)) return true;
  if (['false', '0', 'no', 'off', 'disabled', 'hide', 'hidden'].includes(text)) return false;
  return null;
}

function isEventVisibleByConfig(item = null, eventMeta = null) {
  const manifestHidden = normalizeFlagValue(item?.hidden);
  const metaEnabled = normalizeFlagValue(eventMeta?.enabled);
  const metaHidden = normalizeFlagValue(eventMeta?.hidden);
  const visibilityToken = String(eventMeta?.eventVisibility || '').trim().toLowerCase();

  if (manifestHidden === true || metaHidden === true) return false;
  if (visibilityToken && ['hidden', 'private', 'off', 'disabled'].includes(visibilityToken)) return false;
  return metaEnabled === true;
}

async function hydrateManifestMetaForItem(item) {
  if (!item?.file) return;
  if (manifestCategoryByFile.has(item.file)) return;
  try {
    const response = await fetch(`./data/${item.file}`);
    if (!response.ok) throw new Error(`Failed to load metadata for ${item.file}`);
    const data = await response.json();
    const eventMeta = data?.event || {};
    const category = resolveEffectiveCategory(item, eventMeta);
    manifestEventMetaByFile.set(item.file, eventMeta);
    manifestCategoryByFile.set(item.file, category);
    manifestVisibleByFile.set(item.file, isEventVisibleByConfig(item, eventMeta));
  } catch (error) {
    manifestEventMetaByFile.set(item.file, {});
    manifestCategoryByFile.set(item.file, 'Other');
    manifestVisibleByFile.set(item.file, false);
    console.warn(`Skipping unavailable event data: ${item.file}`, error);
  }
}

async function hydrateManifestCategories() {
  eventCatalog = await loadEventCatalog();
  await Promise.all(eventCatalog.map((item) => hydrateManifestMetaForItem(item)));
  configureEventSearch({ getEvents: getSearchableEvents, onSelect: selectEventFromSearch });
}

export function getEventCategory(eventManifestItem) {
  const file = eventManifestItem?.file || '';
  if (!file) return 'Other';
  return manifestCategoryByFile.get(file) || normalizeCategoryName(getEventCategoryFallback(eventManifestItem), 'Other');
}

export function getManifestForCategory(category) {
  return eventCatalog
    .filter(
      (evt) =>
        getEventCategory(evt) === category &&
        (manifestVisibleByFile.get(evt.file) ?? true)
    )
    .sort((a, b) => {
      const metaA = manifestEventMetaByFile.get(a.file) || {};
      const metaB = manifestEventMetaByFile.get(b.file) || {};
      const yearA = Number.parseInt(String(metaA.year || ''), 10);
      const yearB = Number.parseInt(String(metaB.year || ''), 10);

      if (Number.isFinite(yearA) && Number.isFinite(yearB) && yearA !== yearB) {
        return yearB - yearA;
      }

      const labelA = getCatalogLabel(a).toLowerCase();
      const labelB = getCatalogLabel(b).toLowerCase();
      return labelB.localeCompare(labelA);
    });
}

export function getSearchableEvents() {
  return eventCatalog
    .filter((item) => manifestVisibleByFile.get(item.file) ?? true)
    .map((item) => {
      const meta = manifestEventMetaByFile.get(item.file) || {};
      return {
        file: item.file,
        category: manifestCategoryByFile.get(item.file) || 'Other',
        designation: String(meta.designation || '').trim(),
        location: String(meta.location || '').trim(),
        year: String(meta.year || '').trim(),
        region: String(meta.region || '').trim(),
        venue: String(meta.venue || '').trim(),
        label: getCatalogLabel(item),
      };
    })
    .sort((a, b) => {
      const yearA = Number.parseInt(a.year, 10);
      const yearB = Number.parseInt(b.year, 10);
      if (Number.isFinite(yearA) && Number.isFinite(yearB) && yearA !== yearB) {
        return yearB - yearA;
      }
      return a.label.localeCompare(b.label);
    });
}

export async function selectEventFromSearch(category, file) {
  state.currentEventCategory = category;
  setActiveTab(category);
  localStorage.setItem('selectedEventFile', file);
  await loadEvent(file);
}

function getAvailableEnabledCategories() {
  const categories = [];
  eventCatalog.forEach((item) => {
    const category = getEventCategory(item);
    const isVisible = manifestVisibleByFile.get(item.file) ?? true;
    if (category && isVisible && !categories.includes(category)) {
      categories.push(category);
    }
  });
  return categories;
}

function renderCategoryOptions(categories) {
  const select = document.getElementById('eventCategorySelect');
  if (!select) return;
  select.innerHTML = categories
    .map((category) => `<option value="${category}">${category}</option>`)
    .join('');
}

export function getHeaderBranding(category, eventMeta = null) {
  const categoryName = String(category || '').toLowerCase();
  const designationName = String(eventMeta?.designation || '').toLowerCase();
  const combinedLabel = `${categoryName} ${designationName}`;
  const isDrupalGov =
    /drupalgov/.test(combinedLabel) ||
    (state.currentEventFile || '').startsWith('drupalgov-') ||
    (state.currentEventFile || '').startsWith('drupalgovau-');
  const isDrupalSouth = /drupalsouth/.test(combinedLabel);
  const isCommunityDay = /community day/.test(combinedLabel);
  const isDrupalCon = /drupalcon/.test(combinedLabel);
  const isDrupalConSingapore = (state.currentEventFile || '') === 'drupalcon-asia-singapore-2024.json';
  if (isCommunityDay) {
    return {
      kicker: 'DrupalSouth Community Day',
      iconClass: 'fas fa-users',
      brandClass: 'brand-community',
      logoUrl: String(eventMeta?.logo?.image || '').trim(),
      logoAlt: String(eventMeta?.logo?.imageAlt || '').trim()
    };
  }
  if (isDrupalSouth) {
    if (isDrupalGov) {
      return {
        kicker: 'DrupalGov Schedule',
        iconClass: 'fas fa-landmark',
        brandClass: 'brand-drupalsouth',
        logoUrl: String(eventMeta?.logo?.image || '').trim(),
        logoAlt: String(eventMeta?.logo?.imageAlt || '').trim()
      };
    }
    return {
      kicker: 'DrupalSouth Schedule',
      iconClass: 'fas fa-water',
      brandClass: 'brand-drupalsouth',
      logoUrl: String(eventMeta?.logo?.image || '').trim(),
      logoAlt: String(eventMeta?.logo?.imageAlt || '').trim()
    };
  }
  if (isDrupalGov) {
    return {
      kicker: 'DrupalGovAU Schedule',
      iconClass: 'fas fa-landmark',
      brandClass: 'brand-drupalsouth',
      logoUrl: String(eventMeta?.logo?.image || '').trim(),
      logoAlt: String(eventMeta?.logo?.imageAlt || '').trim()
    };
  }
  if (!isDrupalCon) {
    return {
      kicker: `${category || 'Conference'} Schedule`,
      iconClass: 'fas fa-calendar-alt',
      brandClass: 'brand-drupalcon',
      logoUrl: String(eventMeta?.logo?.image || '').trim(),
      logoAlt: String(eventMeta?.logo?.imageAlt || '').trim()
    };
  }
  return {
    kicker: 'DrupalCon Schedule',
    iconClass: 'fas fa-globe',
    brandClass: 'brand-drupalcon',
    logoUrl: String(eventMeta?.logo?.image || '').trim(),
    logoAlt: String(eventMeta?.logo?.imageAlt || '').trim()
  };
}

export function updateHeaderBranding(category) {
  const logo = document.getElementById('headerLogo');
  const logoImage = document.getElementById('headerLogoImage');
  const logoIcon = document.getElementById('headerLogoIcon');
  const kicker = document.getElementById('headerKicker');
  const branding = getHeaderBranding(category, state.eventMeta);
  const useLogoPlate =
    state.eventMeta?.logo?.usePlate === true ||
    String(state.eventMeta?.logo?.usePlate || '').toLowerCase() === 'true';

  logo.classList.remove('brand-drupalsouth', 'brand-community', 'brand-drupalcon');
  logo.classList.add(branding.brandClass);
  logo.classList.toggle('header-logo-use-plate', useLogoPlate);
  logoIcon.className = branding.iconClass;
  kicker.textContent = branding.kicker;

  if (branding.logoUrl) {
    logoImage.onerror = () => {
      logoImage.classList.add('hidden');
      logoIcon.classList.remove('hidden');
      logoImage.onerror = null;
    };
    logoImage.src = branding.logoUrl;
    logoImage.alt = branding.logoAlt || 'Event logo';
    logoImage.classList.remove('hidden');
    logoIcon.classList.add('hidden');
  } else {
    logoImage.onerror = null;
    logoImage.classList.add('hidden');
    logoIcon.classList.remove('hidden');
  }
}

function normalizeFlickrMeta(eventMeta = null) {
  const flickr = eventMeta?.flickr && typeof eventMeta.flickr === 'object' ? eventMeta.flickr : null;
  if (flickr) {
    return {
      enabled: flickr.enabled !== false && String(flickr.enabled || '').toLowerCase() !== 'false',
      provider: String(flickr.provider || '').trim() || 'Flickr',
      groupUrl: String(flickr.groupUrl || '').trim(),
      image: String(flickr.image || '').trim(),
      imageAlt: String(flickr.imageAlt || '').trim()
    };
  }

  const promo = eventMeta?.mediaPromo;
  if (!promo || typeof promo !== 'object') return null;
  return {
    enabled: true,
    provider: String(promo.platform || 'Flickr').trim() || 'Flickr',
    groupUrl: String(promo.groupUrl || '').trim(),
    image: String(promo.image || '').trim(),
    imageAlt: String(promo.imageAlt || '').trim()
  };
}

function inferHasEventPassed(eventMeta = null, events = []) {
  const now = new Date();
  const endDate = String(eventMeta?.endDate || '').trim();
  if (endDate) {
    const parsed = new Date(endDate);
    if (!Number.isNaN(parsed.getTime())) return parsed <= now;
  }

  const itemDates = (Array.isArray(events) ? events : [])
    .map((item) => new Date(item?.endTime || item?.startTime || ''))
    .filter((date) => !Number.isNaN(date.getTime()))
    .sort((a, b) => b.getTime() - a.getTime());
  if (itemDates.length > 0) {
    return itemDates[0] <= now;
  }

  const startDate = String(eventMeta?.startDate || '').trim();
  if (startDate) {
    const parsed = new Date(startDate);
    if (!Number.isNaN(parsed.getTime())) return parsed <= now;
  }

  const year = Number.parseInt(String(eventMeta?.year || ''), 10);
  if (!Number.isNaN(year)) {
    return year < now.getUTCFullYear();
  }
  return false;
}

function getFlickrMode(eventMeta = null, events = []) {
  return inferHasEventPassed(eventMeta, events) ? 'archive' : 'cta';
}

function getEventLabel(eventMeta = null) {
  const designation = String(eventMeta?.designation || '').trim();
  const year = String(eventMeta?.year || '').trim();
  const location = String(eventMeta?.location || '').trim();
  return [designation, year, location].filter(Boolean).join(' ').trim() || 'Event';
}

function getFlickrDefaults(eventMeta = null, events = [], provider = 'Flickr') {
  const mode = getFlickrMode(eventMeta, events);
  const eventLabel = getEventLabel(eventMeta);
  const p = String(provider || '').trim() || 'Flickr';
  return {
    mode,
    title: mode === 'archive' ? `${eventLabel} Photo Archive` : `Share Your ${eventLabel} Photos`,
    text:
      mode === 'archive'
        ? `Browse the official ${p} page for photos from ${eventLabel}.`
        : `Upload and share your photos on ${p} before, during, and after the event.`,
    buttonLabel: mode === 'archive' ? 'View Photo Archive' : `Open on ${p}`
  };
}

function renderEventMediaPromo(eventMeta = null, events = []) {
  const container = document.getElementById('eventMediaPromo');
  if (!container) return Promise.resolve();

  const flickr = normalizeFlickrMeta(eventMeta);
  const hasPromo = Boolean(flickr && flickr.enabled && flickr.groupUrl);
  const promoImageReady = hasPromo && flickr.image
    ? new Promise((resolve) => {
        const preload = new Image();
        preload.decoding = 'async';
        preload.onload = () => resolve(true);
        preload.onerror = () => resolve(false);
        preload.src = flickr.image;
      })
    : Promise.resolve(false);

  const stack = document.createElement('div');
  stack.className = 'space-y-3';

  const finalizeRender = (imageLoaded) => {
    if (hasPromo) {
    const defaults = getFlickrDefaults(eventMeta, events, flickr.provider);
    const title = defaults.title;
    const text = defaults.text;
    const buttonLabel = defaults.buttonLabel;
    const platformLabel = flickr.provider.toUpperCase();

    const card = document.createElement('div');
    card.className = 'event-promo-card rounded-lg border border-gray-300 bg-white p-3 sm:p-4';

    if (flickr.image) {
      const imageFrame = document.createElement('div');
      imageFrame.className = `event-promo-image-frame shrink-0${imageLoaded ? '' : ' is-loading'}`;

      const image = document.createElement('img');
      image.alt = flickr.imageAlt || `${platformLabel} promo image`;
      image.width = 142;
      image.height = 106;
      image.className = 'event-promo-image';
      if (imageLoaded) {
        image.src = flickr.image;
      }

      imageFrame.appendChild(image);
      card.appendChild(imageFrame);
    }

    const body = document.createElement('div');
    body.className = 'event-promo-body min-w-0 flex-1';

    const platform = document.createElement('div');
    platform.className = 'text-xs font-semibold tracking-wide text-gray-600';
    platform.textContent = platformLabel;
    body.appendChild(platform);

    const heading = document.createElement('h3');
    heading.className = 'text-sm sm:text-base font-semibold text-gray-900 mt-0.5';
    heading.textContent = title;
    body.appendChild(heading);

    const copy = document.createElement('p');
    copy.className = 'text-sm text-gray-700 mt-1';
    copy.textContent = text;
    body.appendChild(copy);

    const action = document.createElement('a');
    action.href = flickr.groupUrl;
    action.target = '_blank';
    action.rel = 'noopener noreferrer';
    action.className = 'event-promo-action';
    action.textContent = buttonLabel;
    body.appendChild(action);

    card.appendChild(body);
    stack.appendChild(card);
  }

  const eventInfoCard = document.createElement('div');
  eventInfoCard.className = 'event-info-card rounded-lg border border-gray-300 bg-white p-3 sm:p-4';

  const infoTitle = document.createElement('h3');
  infoTitle.className = 'text-sm sm:text-base font-semibold text-gray-900';
  infoTitle.textContent = 'Event Info';
  eventInfoCard.appendChild(infoTitle);

  const infoList = document.createElement('dl');
  infoList.className = 'event-info-list mt-2 text-sm';

  const eventName = String(eventMeta?.designation || '').trim();
  const location = eventMeta?.region || eventMeta?.location || 'Unknown';
  const venue = eventMeta?.venue || 'Unknown';
  const dateRange = formatEventDateRange(eventMeta);
  const website = deriveOfficialWebsite(eventMeta);

  appendInfoRow(infoList, 'Event', eventName || 'Unknown');
  appendInfoRow(infoList, 'Location', location);
  appendInfoRow(infoList, 'Venue', venue);
  appendInfoRow(infoList, 'Dates', dateRange);

  const websiteTerm = document.createElement('dt');
  websiteTerm.className = 'event-info-label font-semibold text-gray-700';
  websiteTerm.textContent = 'Official Website';
  infoList.appendChild(websiteTerm);
  const websiteValue = document.createElement('dd');
  websiteValue.className = 'event-info-value text-gray-800 break-all';
  if (website) {
    const websiteLink = document.createElement('a');
    websiteLink.href = website;
    websiteLink.target = '_blank';
    websiteLink.rel = 'noopener noreferrer';
    websiteLink.className = 'drupal-blue-text hover:underline';
    websiteLink.textContent = website;
    websiteValue.appendChild(websiteLink);
  } else {
    websiteValue.textContent = 'Unknown';
  }
  infoList.appendChild(websiteValue);

  eventInfoCard.appendChild(infoList);
  stack.appendChild(eventInfoCard);

  container.innerHTML = '';
  container.appendChild(stack);
  container.classList.remove('hidden');
  };

  return promoImageReady.then((imageLoaded) => finalizeRender(imageLoaded));
}


function appendInfoRow(list, label, value) {
  const term = document.createElement('dt');
  term.className = 'event-info-label font-semibold text-gray-700';
  term.textContent = label;
  list.appendChild(term);

  const desc = document.createElement('dd');
  desc.className = 'event-info-value text-gray-800';
  desc.textContent = value || 'Unknown';
  list.appendChild(desc);
}

function formatEventDateRange(eventMeta = null) {
  const startValue = eventMeta?.startDate;
  const endValue = eventMeta?.endDate;
  if (!startValue || !endValue) return 'Unknown';

  const start = new Date(startValue);
  const end = new Date(endValue);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 'Unknown';

  const timeZone = eventMeta?.timezone || 'UTC';
  const formatDay = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
  const startLabel = formatDay.format(start);
  const endLabel = formatDay.format(end);
  return startLabel === endLabel ? startLabel : `${startLabel} - ${endLabel}`;
}


export function setActiveTab(category) {
  const select = document.getElementById('eventCategorySelect');
  if (select) {
    select.value = category;
  }
  updateHeaderBranding(category);
}

export function populateEventSelector(category, preferredFile) {
  const eventSelector = document.getElementById('eventSelector');
  if (!eventSelector) return;
  const categoryEvents = getManifestForCategory(category);
  eventSelector.innerHTML = '';

  categoryEvents.forEach((evt) => {
    const option = document.createElement('option');
    option.value = evt.file;
    option.textContent = getCatalogLabel(evt);
    eventSelector.appendChild(option);
  });

  const hasPreferred = preferredFile && categoryEvents.some((evt) => evt.file === preferredFile);
  if (hasPreferred) {
    eventSelector.value = preferredFile;
    return;
  }

  const categoryDefault = categoryEvents.find((evt) => evt.default);
  if (categoryDefault) {
    eventSelector.value = categoryDefault.file;
    return;
  }

  if (categoryEvents.length > 0) {
    eventSelector.value = categoryEvents[0].file;
  }
}

function getManifestItemByFile(file) {
  return eventCatalog.find((item) => item.file === file) || null;
}

function getCatalogLabel(item = null) {
  const meta = manifestEventMetaByFile.get(item?.file || '') || {};
  const designation = String(meta.designation || '').trim();
  const year = String(meta.year || '').trim();
  const location = String(meta.location || '').trim();
  if (designation && year && location) {
    return `${designation} ${year}: ${location}`;
  }
  const joined = [designation, year, location].filter(Boolean).join(' ').trim();
  return joined || String(item?.file || '');
}

function getEventDisplayName(meta = {}, manifestItem = null) {
  const fromMeta = [meta.designation, meta.location, meta.year].filter(Boolean).join(' ').trim();
  if (fromMeta) {
    return fromMeta;
  }
  const label = getCatalogLabel(manifestItem);
  if (!label) {
    return 'Drupal Event Schedule Builder';
  }
  return label.replace(':', '').trim();
}

function getCurrentEventDisplayName() {
  const manifestItem = getManifestItemByFile(state.currentEventFile);
  return getEventDisplayName(state.eventMeta || {}, manifestItem);
}

function updateDocumentTitle(meta = {}, manifestItem = null) {
  const eventDisplayName = getEventDisplayName(meta, manifestItem);
  document.title = `${eventDisplayName} - Drupal Event Schedule Builder`;
  return eventDisplayName;
}


function getEventIdForManifestItem(item) {
  const meta = manifestEventMetaByFile.get(item?.file || '') || {};
  const fromMeta = slugify([meta.designation, meta.year, meta.location].filter(Boolean).join(' '));
  if (fromMeta) return fromMeta;
  return slugify(String(item?.file || '').replace(/\.json$/i, ''));
}

function getEventFileById(eventId) {
  const id = slugify(eventId);
  if (!id) return null;
  const match = eventCatalog.find((item) => getEventIdForManifestItem(item) === id);
  return match ? match.file : null;
}

function getEventIdByFile(file) {
  const item = getManifestItemByFile(file);
  return item ? getEventIdForManifestItem(item) : '';
}

function buildShareUrl(file) {
  return buildShareUrlForMode(file, {});
}

function buildShareUrlForMode(file, { lockToCurrentEvent = false } = {}) {
  const id = getEventIdByFile(file);
  if (!id) return window.location.href;
  const url = new URL(window.location.href);
  url.search = '';
  url.searchParams.set('id', id);
  if (lockToCurrentEvent) {
    url.searchParams.set(SHARE_CURRENT_SCHEDULE_PARAM, '1');
  }
  return url.toString();
}

function updateBrowserUrlForEvent(file) {
  const id = getEventIdByFile(file);
  if (!id) return;
  const url = new URL(window.location.href);
  url.searchParams.set('id', id);
  if (state.scheduleLockedToCurrentEvent) {
    url.searchParams.set(SHARE_CURRENT_SCHEDULE_PARAM, '1');
  } else {
    url.searchParams.delete(SHARE_CURRENT_SCHEDULE_PARAM);
  }
  window.history.replaceState({}, '', url.toString());
}

function setShareButtonCopiedState() {
  const button = document.getElementById('shareSchedule');
  if (!button) return;
  const previous = button.innerHTML;
  button.innerHTML = '<i class="fas fa-check mr-2"></i>Link copied';
  window.setTimeout(() => {
    button.innerHTML = previous;
  }, 1600);
}

async function copyShareUrl(url, statusMessage = 'Share link copied to clipboard.') {
  try {
    await navigator.clipboard.writeText(url);
    announceStatus(statusMessage);
    setShareButtonCopiedState();
  } catch {
    announceStatus('Clipboard unavailable. Copy dialog opened.');
    window.prompt('Copy this schedule link:', url);
  }
}

function closeShareModal() {
  const modal = document.getElementById(SHARE_MODAL_ID);
  if (!modal) return;
  modal.classList.add('hidden');
  document.body.classList.remove('session-modal-open');
}

function ensureShareModal() {
  let modal = document.getElementById(SHARE_MODAL_ID);
  if (modal) return modal;

  modal = document.createElement('div');
  modal.id = SHARE_MODAL_ID;
  modal.className = 'session-modal-overlay hidden';
  modal.innerHTML = `
    <div class="session-modal-card" role="dialog" aria-modal="true" aria-labelledby="shareModalTitle">
      <div class="session-modal-header">
        <button id="shareModalBack" type="button" class="session-modal-back">
          <i class="fas fa-arrow-left" aria-hidden="true"></i>
          <span>Back</span>
        </button>
        <button id="shareModalClose" type="button" class="session-modal-close" aria-label="Close share options">
          <i class="fas fa-times" aria-hidden="true"></i>
        </button>
      </div>
      <div id="shareModalBody" class="session-modal-body"></div>
    </div>
  `;

  modal.addEventListener('click', (event) => {
    if (event.target === modal) {
      closeShareModal();
    }
  });

  modal.querySelector('#shareModalBack').addEventListener('click', closeShareModal);
  modal.querySelector('#shareModalClose').addEventListener('click', closeShareModal);
  modal.querySelector('#shareModalBody').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-share-url]');
    if (!button) return;
    const url = button.getAttribute('data-share-url');
    const statusMessage = button.getAttribute('data-status-message') || 'Share link copied to clipboard.';
    await copyShareUrl(url, statusMessage);
    closeShareModal();
  });

  document.body.appendChild(modal);
  return modal;
}

function renderShareOptions() {
  const body = ensureShareModal().querySelector('#shareModalBody');
  if (!body || !state.currentEventFile) return;
  const eventName = getCurrentEventDisplayName();

  const shareOptions = [];
  if (!state.scheduleLockedToCurrentEvent) {
    shareOptions.push({
      title: `Share the ${eventName} schedule`,
      text: 'Share a link to this schedule.',
      url: buildShareUrlForMode(state.currentEventFile),
      statusMessage: 'Share link copied to clipboard.',
      buttonLabel: 'Copy standard link',
      primary: false
    });
  }

  shareOptions.push({
    title: `Share the ${eventName} schedule!`,
    text: '',
    url: buildShareUrlForMode(state.currentEventFile, { lockToCurrentEvent: true }),
    statusMessage: 'Current-schedule link copied to clipboard.',
    buttonLabel: 'Copy link',
    primary: true
  });

  body.innerHTML = `
    <h2 id="shareModalTitle" class="session-modal-title">Share the schedule!</h2>
    ${shareOptions
      .map(
        (option) => `
          <section class="share-modal-option">
            <h3 class="share-modal-option-title">${option.title}</h3>
            <p class="share-modal-option-text">${option.text}</p>
            <button
              type="button"
              class="share-modal-copy${option.primary ? ' share-modal-copy-primary' : ''}"
              data-share-url="${option.url}"
              data-status-message="${option.statusMessage}"
            >
              ${option.buttonLabel}
            </button>
          </section>
        `
      )
      .join('')}
  `;
}

function openShareModal() {
  if (!state.currentEventFile) return;
  renderShareOptions();
  const modal = ensureShareModal();
  modal.classList.remove('hidden');
  document.body.classList.add('session-modal-open');
}

function applyScheduleLockUi() {
  const categoryWrap = document.getElementById('eventCategorySelectWrap');
  const selectorLabel = document.getElementById('eventSelectorLabel');
  const selectorWrap = document.getElementById('eventSelectorWrap');
  const searchButton = document.getElementById('searchEvents');
  const shareButton = document.getElementById('shareSchedule');
  const hideEventSelectors = state.scheduleLockedToCurrentEvent || isMobileViewport();
  const toggleVisibility = (element, hidden) => {
    if (!element) return;
    element.classList.toggle('hidden', hidden);
  };

  toggleVisibility(categoryWrap, hideEventSelectors);
  toggleVisibility(selectorLabel, hideEventSelectors);
  toggleVisibility(selectorWrap, hideEventSelectors);
  toggleVisibility(searchButton, state.scheduleLockedToCurrentEvent);

  if (shareButton) {
    shareButton.style.width = state.scheduleLockedToCurrentEvent ? '100%' : '';
    shareButton.style.flex = state.scheduleLockedToCurrentEvent ? '1 1 auto' : '';
  }
}

function updateHeaderFlag(manifestItem = null) {
  const flag = document.getElementById('headerFlag');
  if (!flag) return;
  const src = manifestItem?.flagImage || '';
  const alt = manifestItem?.flagAlt || 'Event country flag';
  if (!src) {
    flag.classList.add('hidden');
    flag.removeAttribute('src');
    flag.removeAttribute('alt');
    return;
  }
  flag.src = src;
  flag.alt = alt;
  flag.classList.remove('hidden');
}

function processEventItems(items) {
  items.forEach((event) => {
    event.clean_title = event.title
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '');
  });
  return items;
}

export async function fetchEvents(filename) {
  if (filename === '__preview__') {
    try {
      const raw = localStorage.getItem('__preview__');
      if (!raw) return [];
      const data = JSON.parse(raw);
      state.eventMeta = data.event || {};
      return processEventItems(data.items || []);
    } catch {
      return [];
    }
  }
  try {
    const response = await fetch(`./data/${filename}`, { cache: 'no-cache' });
    const data = await response.json();
    state.eventMeta = data.event;
    return processEventItems(data.items);
  } catch {
    return [];
  }
}

function inferFlagFromMeta(meta = {}) {
  const combined = `${meta.region || ''} ${meta.location || ''}`.toLowerCase();
  if (combined.includes('new zealand') || combined.includes('wellington') || combined.includes('auckland') || combined.includes('christchurch')) {
    return { flagImage: './img/flags/nz.svg', flagAlt: 'New Zealand flag' };
  }
  if (combined.includes('australia') || combined.includes('canberra') || combined.includes('melbourne') || combined.includes('brisbane') || combined.includes('gold coast') || combined.includes('hobart') || combined.includes('sydney')) {
    return { flagImage: './img/flags/au.svg', flagAlt: 'Australia flag' };
  }
  if (combined.includes('japan') || combined.includes('nara')) {
    return { flagImage: './img/flags/jp.svg', flagAlt: 'Japan flag' };
  }
  if (combined.includes('singapore')) {
    return { flagImage: './img/flags/sg.svg', flagAlt: 'Singapore flag' };
  }
  if (combined.includes('india') || combined.includes('mumbai')) {
    return { flagImage: './img/flags/in.svg', flagAlt: 'India flag' };
  }
  return null;
}

export async function loadEvent(filename) {
  state.currentEventFile = filename;
  updateBrowserUrlForEvent(filename);
  const manifestItem = getManifestItemByFile(filename);
  const events = await fetchEvents(filename);
  updateHeaderFlag(manifestItem || inferFlagFromMeta(state.eventMeta || {}));
  if (state.currentEventCategory) {
    updateHeaderBranding(state.currentEventCategory);
  }
  const meta = state.eventMeta || {};
  const themeVal = meta.theme;
  const themeId = typeof themeVal === 'object' ? themeVal?.id : themeVal;
  const effectiveThemeId = themeId ? normalizeThemeId(themeId) : state.themeMode;
  applyThemeClass(effectiveThemeId);
  // Persist the effective theme so the planner page can match it exactly,
  // even when the event overrides the user's saved preference.
  localStorage.setItem('scheduleCurrentThemeId', effectiveThemeId);
  applyEventColors(
    typeof themeVal === 'object' ? themeVal?.primaryColor : meta.primaryColor,
    typeof themeVal === 'object' ? themeVal?.secondaryColor : meta.secondaryColor,
    typeof themeVal === 'object' ? themeVal?.tertiaryColor : meta.tertiaryColor
  );
  state.eventColumns = Number(meta.columns) > 0 ? Number(meta.columns) : 3;
  const eventDisplayName = updateDocumentTitle(meta, manifestItem);

  document.getElementById('pageTitle').innerHTML = `
                <span class="header-event">${eventDisplayName}</span>
                <span class="header-suffix">Planner</span>
            `;

  const websiteURL = String(meta.website || '').replace('/schedule', '');
  document.getElementById('creditsEventLink').innerHTML =
    `This is a custom schedule builder for <a href="${websiteURL || '#'}" target="_blank" class="drupal-blue-text">${eventDisplayName}</a>. <strong>It is not affiliated with ${eventDisplayName}</strong>.`;
  await renderEventMediaPromo(meta, events);

  events.forEach((event) => {
    event.id = `${event.startTime}-${event.location}-${event.title}`.replace(/[^a-zA-Z0-9-]/g, '-');
  });
  const uniqueDates = [...new Set(events.map((event) => getLocalDate(event.startTime)))];
  const uniqueTracks = [...new Set(events.flatMap((event) => normalizeTracks(event.track)))];

  const dateFilter = document.getElementById('dateFilter');
  dateFilter.innerHTML = '<option value="">All Days</option>';
  uniqueDates.sort().forEach((date) => {
    const option = document.createElement('option');
    option.value = date;
    option.textContent = new Date(date + 'T12:00:00').toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric'
    });
    dateFilter.appendChild(option);
  });

  const trackFilter = document.getElementById('trackFilter');
  trackFilter.innerHTML = '<option value="">All Tracks</option>';
  uniqueTracks.sort().forEach((track) => {
    const option = document.createElement('option');
    option.value = track;
    option.textContent = track;
    trackFilter.appendChild(option);
  });

  const savedSelections = localStorage.getItem(getStorageKey());
  state.selectedEvents = new Set(savedSelections ? JSON.parse(savedSelections) : []);
  state.allEvents = events;
  state.displayedEvents = events;

  const overviewPanel = document.getElementById('selectionOverview');
  if (state.selectedEvents.size > 0) {
    overviewPanel.classList.remove('translate-y-full');
    updateSelectionOverview(events, updateStageStats);
    updateDownloadButton();
  } else {
    overviewPanel.classList.add('translate-y-full');
    updateDownloadButton();
  }

  displayEvents(events);
  renderSponsors(meta);

  document.getElementById('dateFilter').value = '';
  document.getElementById('trackFilter').value = '';
  document.getElementById('keywordsFilter').value = '';
  document.getElementById('selectionFilter').value = 'all';
  toggleClearButton();
}

export function setupEventListeners() {
  document.getElementById('dateFilter').addEventListener('change', () => applyFilters(state.allEvents, 'dateFilter'));
  document.getElementById('trackFilter').addEventListener('change', () => applyFilters(state.allEvents, 'trackFilter'));
  document.getElementById('keywordsFilter').addEventListener('input', () => {
    toggleClearButton();
    applyFilters(state.allEvents, null, true);
    debouncedFilterEvents(state.allEvents);
  });
  document.getElementById('clearKeywords').addEventListener('click', () => clearKeywordsFilter(state.allEvents));
  document.getElementById('selectionFilter').addEventListener('change', () => applyFilters(state.allEvents, 'selectionFilter'));
  document.getElementById('downloadIcs').addEventListener('click', () => downloadSelectedEvents(state.allEvents));
  document
    .getElementById('addGoogleCalendar')
    .addEventListener('click', () => addSelectedEventsToGoogleCalendar(state.allEvents));

  document.getElementById('resetFilters').addEventListener('click', () => resetFilters(state.allEvents));
  document.getElementById('selectAllDisplayed').addEventListener('click', () => selectAllDisplayed(state.allEvents));
  document
    .getElementById('deselectAllDisplayed')
    .addEventListener('click', () => deselectAllDisplayed(state.allEvents));

  document.getElementById('toggleDetails').addEventListener('click', () => {
    const detailsSection = document.getElementById('stageDetails');
    const toggleIcon = document.querySelector('#toggleDetails i');
    if (detailsSection.classList.contains('hidden')) {
      window.sa_event?.('selection_details_opened');
      detailsSection.classList.remove('hidden');
      toggleIcon.classList.add('rotate-180');
    } else {
      window.sa_event?.('selection_details_closed');
      detailsSection.classList.add('hidden');
      toggleIcon.classList.remove('rotate-180');
    }
  });

  const shareButton = document.getElementById('shareSchedule');
  if (shareButton) {
    shareButton.addEventListener('click', () => openShareModal());
  }

  const searchEventsButton = document.getElementById('searchEvents');
  if (searchEventsButton) {
    searchEventsButton.addEventListener('click', () => openEventSearchModal());
  }
}

function parseAndApplyStartupModes(urlModes) {
  state.scheduleLockedToCurrentEvent = urlModes.currentSchedule;
  const savedTheme = localStorage.getItem(THEME_STORAGE_KEY) || '';
  state.themeMode = setCurrentThemeId(normalizeThemeId(urlModes.theme || savedTheme));
  applyThemeClass(state.themeMode);
}

function wireEventListeners() {
  setupEventListeners();
}

function showPreviewBanner() {
  const banner = document.createElement('div');
  banner.className = 'preview-banner';
  const canReturn = Boolean(window.opener && !window.opener.closed);
  const backControl = canReturn
    ? `<button type="button" class="preview-banner-link" id="previewBannerBack">Back to editor</button>`
    : `<a href="./editor.html" class="preview-banner-link">Back to editor</a>`;
  banner.innerHTML = `<i class="fas fa-eye"></i><span><strong>Preview mode</strong> — these changes have not been saved yet.</span>${backControl}`;
  document.body.prepend(banner);
  document.body.classList.add('has-preview-banner');
  document.getElementById('searchEvents')?.classList.add('hidden');
  if (canReturn) {
    document.getElementById('previewBannerBack')?.addEventListener('click', () => {
      window.opener.focus();
      window.close();
    });
  }
}

export async function init() {
  setupEditorAccessButton();
  bindViewportScheduleLockUi();
  await loadThemes();
  const urlModes = parseModeFromUrl();

  if (urlModes.preview) {
    parseAndApplyStartupModes(urlModes);
    const raw = localStorage.getItem('__preview__');
    if (raw) {
      try {
        const data = JSON.parse(raw);
        const designation = String(data?.event?.designation || '').toLowerCase();
        state.currentEventCategory = designation.includes('drupalcon') ? 'DrupalCon' : (data?.event?.designation || 'Conference');
      } catch { /* use defaults */ }
    }
    wireEventListeners();
    await loadEvent('__preview__');
    showPreviewBanner();
    return;
  }

  parseAndApplyStartupModes(urlModes);
  await hydrateManifestCategories();

  const fileFromUrl = getEventFileById(urlModes.id);
  const savedEvent = localStorage.getItem('selectedEventFile');
  const savedEventIsValid = savedEvent && eventCatalog.some((e) => e.file === savedEvent);
  const defaultEvent = eventCatalog.find((e) => e.default) || eventCatalog[0];
  if (!defaultEvent) return;

  const initialFile = fileFromUrl || (savedEventIsValid ? savedEvent : defaultEvent.file);
  const initialManifestItem = eventCatalog.find((e) => e.file === initialFile) || defaultEvent;
  const initialCategory = getEventCategory(initialManifestItem);
  const availableCategories = getAvailableEnabledCategories();
  const safeInitialCategory = availableCategories.includes(initialCategory)
    ? initialCategory
    : availableCategories[0] || '';

  if (!safeInitialCategory) return;

  state.currentEventCategory = safeInitialCategory;
  setActiveTab(safeInitialCategory);
  applyScheduleLockUi();

  localStorage.setItem('selectedEventFile', initialFile);
  wireEventListeners();
  await loadEvent(initialFile);
}

export function toggleEventSelectionPublic(eventId) {
  toggleEventSelection(eventId, applyFilters, (events) => updateSelectionOverview(events, updateStageStats));
}
