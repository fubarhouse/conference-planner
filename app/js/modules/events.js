import state, { getStorageKey } from './state.js';
import { setupMobileAccordion } from './accordion.js';
import { initVenueMap } from './scheduleVenueMap.js';
import { loadEventCatalog } from './eventCatalog.js';
import {
  getLocalDate,
  announceStatus,
  normalizeTracks,
  isLocalhost,
  slugify,
  deriveOfficialWebsite,
  normalizeString,
} from './utils.js';
import { renderSponsors } from './sponsors.js';
import { loadJson, savedAgo } from './offlineData.js';
import { renderRelatedEvents } from './relatedEvents.js';
import {
  applyFilters,
  debouncedFilterEvents,
  toggleClearButton,
  clearKeywordsFilter,
  resetFilters,
  selectAllDisplayed,
  deselectAllDisplayed,
  setSelectionOverviewUpdater,
} from './filters.js';
import { displayEvents } from './render.js';
import {
  updateDownloadButton,
  downloadSelectedEvents,
  addSelectedEventsToGoogleCalendar,
  toggleEventSelection,
} from './calendar.js';
import { initScheduleHome, openScheduleHome, closeScheduleHome } from './scheduleHome.js';
import { reportError } from './notify.js';
import { buildModalOverlay, dismissOnBackdrop } from './modalScaffold.js';
import { STORAGE_KEYS, readText, writeText } from './plannerStorage.js';
import {
  loadThemes,
  getThemeById,
  THEME_STORAGE_KEY,
  normalizeThemeId,
  setCurrentThemeId,
  applyThemeClass,
  applyEventColors,
  getThemeOverride,
  setThemeOverride,
  clearThemeOverride,
  resolveThemeId,
} from './theme.js';

const SHARE_MODAL_ID = 'shareScheduleModal';
const SHARE_CURRENT_SCHEDULE_PARAM = 'currentSchedule';
const MOBILE_VIEWPORT_MEDIA_QUERY = '(max-width: 639px)';

let updateSelectionOverview = () => {};
let updateStageStats = () => {};
import {
  parseScheduleRoute,
  scheduleHref,
  usePathRouting as useSchedulePathRouting,
} from './scheduleRoute.js';
import { scheduleSlug } from './scheduleSlug.js';

const manifestEventMetaByFile = new Map();
const manifestCategoryByFile = new Map();
const manifestVisibleByFile = new Map();
let eventCatalog = [];
let mobileViewportMediaQuery = null;
let hasBoundViewportScheduleLockUi = false;

// The route as it was when the page opened. Everything after the first load
// rewrites the address to the schedule on screen, so asking `window.location`
// later gets you the answer you just wrote, not the one you were given.
const initialRoute = parseScheduleRoute(typeof window !== 'undefined' ? window.location : {});

function parseModeFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const theme = String(params.get('theme') || '').toLowerCase();
  // The path wins over the query — `/schedules/<slug>` is the more specific
  // statement — and both forms are supported deployments, not one legacy.
  const id = String(initialRoute.slug || '')
    .trim()
    .toLowerCase();
  const currentSchedule =
    normalizeFlagValue(
      params.get(SHARE_CURRENT_SCHEDULE_PARAM) ||
        params.get('current_schedule') ||
        params.get('scheduleOnly') ||
        params.get('schedule_only'),
    ) === true;
  const preview = params.get('preview') === '1';
  // Embed mode: a chrome-less, single-schedule render for iframing on other sites.
  const embed = params.get('embed') === '1';
  const flag = (name, dflt) => {
    const v = normalizeFlagValue(params.get(name));
    return v === null ? dflt : v;
  };
  const sponsors = flag('sponsors', true); // ?sponsors=0 hides the sponsor block
  const related = flag('related', true); // ?related=0 hides related events / partners
  return { theme, id, currentSchedule, preview, embed, sponsors, related };
}

function isMobileViewport() {
  mobileViewportMediaQuery ||= window.matchMedia(MOBILE_VIEWPORT_MEDIA_QUERY);
  return mobileViewportMediaQuery.matches;
}

// Embed auto-height: tell the parent frame our content height so it can size the
// iframe and avoid a nested-scroll trap. No-op outside embed mode / a top window.
// The companion parent script lives in app/embed.js (served at /embed.js).
let _embedResizeWired = false;
function postEmbedHeight() {
  if (!state.embedMode || window.parent === window) return;
  const height = Math.ceil(document.documentElement.scrollHeight);
  window.parent.postMessage({ type: 'cesx-embed-height', height }, '*');
  if (_embedResizeWired) return;
  _embedResizeWired = true;
  window.addEventListener('resize', postEmbedHeight);
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => postEmbedHeight()).observe(document.body);
  }
}

// The related-events block sits below the sponsor grid by default; a per-event
// `relatedEventsPlacement: 'above'` reorders the two sibling sections in the DOM.
function applyRelatedEventsPlacement(meta = null) {
  const sponsors = document.getElementById('sponsorsContainer');
  const related = document.getElementById('relatedEventsContainer');
  if (!sponsors || !related || sponsors.parentNode !== related.parentNode) return;
  const above = String(meta?.relatedEventsPlacement || 'below').toLowerCase() === 'above';
  sponsors.parentNode.insertBefore(related, above ? sponsors : sponsors.nextSibling);
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
  if (!isLocalhost()) return;
  document.getElementById('editorNavLink')?.classList.remove('hidden');
  document.getElementById('curationNavLink')?.classList.remove('hidden');
  document.getElementById('scheduleEditorTab')?.classList.remove('hidden');
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
  const raw = normalizeString(value);
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
  const visibilityToken = String(eventMeta?.eventVisibility || '')
    .trim()
    .toLowerCase();

  if (manifestHidden === true || metaHidden === true) return false;
  if (visibilityToken && ['hidden', 'private', 'off', 'disabled'].includes(visibilityToken))
    return false;
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

// Populate the manifest maps from the consolidated catalog.json (one request).
// Returns false when it's missing/invalid so the caller can fall back.
async function hydrateManifestFromCatalog() {
  try {
    // Cached alongside the datasets, because it is the PREREQUISITE for them:
    // without the catalog the app cannot resolve a URL to an event, so it never
    // reaches the dataset it has saved. Caching the programme but not the index
    // that finds it leaves the offline copy unreachable.
    const { data: catalog } = await loadJson('./data/catalog.json');
    if (!catalog || !Array.isArray(catalog.events)) return false;
    const metaByFile = new Map(catalog.events.map((entry) => [entry.file, entry.event || {}]));
    for (const item of eventCatalog) {
      const eventMeta = metaByFile.get(item.file);
      if (eventMeta) {
        manifestEventMetaByFile.set(item.file, eventMeta);
        manifestCategoryByFile.set(item.file, resolveEffectiveCategory(item, eventMeta));
        manifestVisibleByFile.set(item.file, isEventVisibleByConfig(item, eventMeta));
      } else {
        // Not in the cache (e.g. an unreadable file) — treat as unavailable,
        // matching the per-file fetch-failure path below.
        manifestEventMetaByFile.set(item.file, {});
        manifestCategoryByFile.set(item.file, 'Other');
        manifestVisibleByFile.set(item.file, false);
      }
    }
    return true;
  } catch {
    return false;
  }
}

async function hydrateManifestCategories() {
  eventCatalog = await loadEventCatalog();
  // Prefer the consolidated cache (1 request); fall back to fetching every event
  // file individually so any static host works even without a generated catalog.
  if (!(await hydrateManifestFromCatalog())) {
    await Promise.all(eventCatalog.map((item) => hydrateManifestMetaForItem(item)));
  }
  // The Browse home replaced the old event-search modal on the schedule, so no
  // configureEventSearch here (the editor still uses that module).
}

function getEventCategory(eventManifestItem) {
  const file = eventManifestItem?.file || '';
  if (!file) return 'Other';
  return (
    manifestCategoryByFile.get(file) ||
    normalizeCategoryName(getEventCategoryFallback(eventManifestItem), 'Other')
  );
}

// includeHidden (admins) also returns events hidden from the public list; each
// event is tagged with `hidden` so the UI can flag them.
function getSearchableEvents(includeHidden = false) {
  return eventCatalog
    .filter((item) => includeHidden || (manifestVisibleByFile.get(item.file) ?? true))
    .map((item) => {
      const meta = manifestEventMetaByFile.get(item.file) || {};
      return {
        file: item.file,
        category: manifestCategoryByFile.get(item.file) || 'Other',
        designation: normalizeString(meta.designation),
        // What it was MARKETED as vs what it BELONGS to. Drupal Camp Delhi is
        // grouped under DrupalCamp and DrupalSouth Community Day under
        // DrupalSouth, without either losing its own name on the card.
        series: normalizeString(item.series) || normalizeString(meta.designation),
        location: normalizeString(meta.location),
        year: normalizeString(meta.year),
        region: normalizeString(meta.region),
        venue: normalizeString(meta.venue),
        startDate: normalizeString(meta.startDate),
        endDate: normalizeString(meta.endDate),
        label: getCatalogLabel(item),
        hidden: !(manifestVisibleByFile.get(item.file) ?? true),
      };
    })
    .sort((a, b) => {
      // Newest → oldest by start date; dated events before undated; fall back to
      // year then label when dates are missing/equal.
      const dateA = a.startDate ? new Date(a.startDate).getTime() : NaN;
      const dateB = b.startDate ? new Date(b.startDate).getTime() : NaN;
      const okA = !Number.isNaN(dateA);
      const okB = !Number.isNaN(dateB);
      if (okA && okB && dateA !== dateB) return dateB - dateA;
      if (okA !== okB) return okA ? -1 : 1;
      const yearA = Number.parseInt(a.year, 10);
      const yearB = Number.parseInt(b.year, 10);
      if (Number.isFinite(yearA) && Number.isFinite(yearB) && yearA !== yearB) {
        return yearB - yearA;
      }
      return a.label.localeCompare(b.label);
    });
}

async function selectEventFromSearch(category, file) {
  state.userPickedSchedule = true;
  state.currentEventCategory = category;
  setActiveTab(category);
  writeText(STORAGE_KEYS.selectedEventFile, file);
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

function getHeaderBranding(eventMeta = null) {
  const themeVal = eventMeta?.theme;
  const themeId = typeof themeVal === 'object' ? themeVal?.id : themeVal;
  const b = (themeId ? getThemeById(themeId) : null)?.branding || {};
  return {
    // The lockup's title says WHAT this page is; the line beneath says WHICH
    // event. Repeating the designation in both ("DrupalCon Schedule" over
    // "DrupalCon Rotterdam 2026") spent the largest type on the page saying a
    // word the subtitle was about to say again.
    kicker: b.kicker || 'Conference Schedule',
    iconClass: b.iconClass || 'fas fa-calendar-alt',
    brandClass: b.brandClass || 'brand-primary',
    logoUrl: normalizeString(eventMeta?.logo?.image),
    logoAlt: normalizeString(eventMeta?.logo?.imageAlt),
  };
}

function updateHeaderBranding() {
  const logo = document.getElementById('headerLogo');
  const logoImage = document.getElementById('headerLogoImage');
  const logoIcon = document.getElementById('headerLogoIcon');
  const kicker = document.getElementById('headerKicker');
  const branding = getHeaderBranding(state.eventMeta);
  const useLogoPlate =
    state.eventMeta?.logo?.usePlate === true ||
    String(state.eventMeta?.logo?.usePlate || '').toLowerCase() === 'true';

  logo.classList.remove('brand-drupalsouth', 'brand-community', 'brand-primary');
  logo.classList.add(branding.brandClass);
  logo.classList.toggle('header-logo-use-plate', useLogoPlate);
  // The seal keeps its own class. This used to be assigned `branding.iconClass`
  // (a Font Awesome class), which both wiped the seal and — now that the icon
  // font is gone — left an empty inline element in the masthead.
  logoIcon.className = 'app-lockup__seal';
  kicker.textContent = branding.kicker;

  // Hard rule: any "drupalcon" event forcibly hides its logo image (trademark
  // caution) and falls back to the Font Awesome icon — regardless of the dataset.
  const eventSlug = slugify(
    [state.eventMeta?.designation, state.eventMeta?.year, state.eventMeta?.location]
      .filter(Boolean)
      .join(' '),
  );
  const forceLogoOff = eventSlug.includes('drupalcon');
  const logoDisabled =
    forceLogoOff ||
    state.eventMeta?.logo?.logoDisabled === true ||
    String(state.eventMeta?.logo?.logoDisabled || '').toLowerCase() === 'true';
  const faIcon = normalizeString(state.eventMeta?.logo?.faIcon) || 'fa-solid fa-calendar-days';

  if (logoDisabled) {
    logoImage.onerror = null;
    logoImage.classList.add('hidden');
    logoIcon.className = faIcon;
    logoIcon.classList.remove('hidden');
  } else if (branding.logoUrl) {
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
    logoIcon.className = branding.iconClass;
    logoIcon.classList.remove('hidden');
  }
}

function normalizeFlickrMeta(eventMeta = null) {
  const flickr =
    eventMeta?.flickr && typeof eventMeta.flickr === 'object' ? eventMeta.flickr : null;
  if (flickr) {
    return {
      enabled: flickr.enabled !== false && String(flickr.enabled || '').toLowerCase() !== 'false',
      provider: normalizeString(flickr.provider) || 'Flickr',
      groupUrl: normalizeString(flickr.groupUrl),
      image: normalizeString(flickr.image),
      imageAlt: normalizeString(flickr.imageAlt),
    };
  }

  const promo = eventMeta?.mediaPromo;
  if (!promo || typeof promo !== 'object') return null;
  return {
    enabled: true,
    provider: String(promo.platform || 'Flickr').trim() || 'Flickr',
    groupUrl: normalizeString(promo.groupUrl),
    image: normalizeString(promo.image),
    imageAlt: normalizeString(promo.imageAlt),
  };
}

function inferHasEventPassed(eventMeta = null, events = []) {
  const now = new Date();
  const endDate = normalizeString(eventMeta?.endDate);
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

  const startDate = normalizeString(eventMeta?.startDate);
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
  const designation = normalizeString(eventMeta?.designation);
  const year = normalizeString(eventMeta?.year);
  const location = normalizeString(eventMeta?.location);
  return [designation, year, location].filter(Boolean).join(' ').trim() || 'Event';
}

function getFlickrDefaults(eventMeta = null, events = [], provider = 'Flickr') {
  const mode = getFlickrMode(eventMeta, events);
  const eventLabel = getEventLabel(eventMeta);
  const p = normalizeString(provider) || 'Flickr';
  return {
    mode,
    title: mode === 'archive' ? `${eventLabel} Photo Archive` : `Share Your ${eventLabel} Photos`,
    text:
      mode === 'archive'
        ? `Browse the official ${p} page for photos from ${eventLabel}.`
        : `Upload and share your photos on ${p} before, during, and after the event.`,
    buttonLabel: mode === 'archive' ? 'View Photo Archive' : `Open on ${p}`,
  };
}

function renderEventMediaPromo(eventMeta = null, events = []) {
  const container = document.getElementById('eventMediaPromo');
  if (!container) return Promise.resolve();

  const flickr = normalizeFlickrMeta(eventMeta);
  const hasPromo = Boolean(flickr && flickr.enabled && flickr.groupUrl);
  const promoImageReady =
    hasPromo && flickr.image
      ? new Promise((resolve) => {
          const preload = new Image();
          preload.decoding = 'async';
          preload.onload = () => resolve(true);
          preload.onerror = () => resolve(false);
          preload.src = flickr.image;
        })
      : Promise.resolve(false);

  const stack = document.createElement('div');
  stack.className = 'sch-infohead';

  const finalizeRender = (imageLoaded) => {
    if (hasPromo) {
      const defaults = getFlickrDefaults(eventMeta, events, flickr.provider);
      const title = defaults.title;
      const text = defaults.text;
      const buttonLabel = defaults.buttonLabel;
      const platformLabel = flickr.provider.toUpperCase();

      const card = document.createElement('div');
      card.className = 'sch-plate';

      if (flickr.image) {
        const imageFrame = document.createElement('div');
        imageFrame.className = `sch-plate__frame${imageLoaded ? '' : ' is-loading'}`;

        const image = document.createElement('img');
        image.alt = flickr.imageAlt || `${platformLabel} promo image`;
        image.width = 142;
        image.height = 106;
        image.className = 'sch-plate__image';
        if (imageLoaded) {
          image.src = flickr.image;
        }

        imageFrame.appendChild(image);
        card.appendChild(imageFrame);
      }

      const body = document.createElement('div');
      body.className = 'sch-plate__body';

      const platform = document.createElement('div');
      platform.className = 'sch-plate__eyebrow u-label';
      platform.textContent = platformLabel;
      body.appendChild(platform);

      const heading = document.createElement('h3');
      heading.className = 'sch-plate__title';
      heading.textContent = title;
      body.appendChild(heading);

      const copy = document.createElement('p');
      copy.className = 'sch-plate__copy';
      copy.textContent = text;
      body.appendChild(copy);

      const action = document.createElement('a');
      action.href = flickr.groupUrl;
      action.target = '_blank';
      action.rel = 'noopener noreferrer';
      action.className = 'sch-plate__action';
      action.textContent = buttonLabel;
      body.appendChild(action);

      card.appendChild(body);
      stack.appendChild(card);
    }

    const eventInfoCard = document.createElement('div');
    eventInfoCard.className = 'sch-colophon';

    const infoTitle = document.createElement('h3');
    infoTitle.className = 'sch-colophon__title u-label';
    infoTitle.textContent = 'Event Info';
    eventInfoCard.appendChild(infoTitle);

    // At phone width this is 296px of particulars standing between the reader
    // and the programme — the thing the page is for. It is a colophon: worth
    // having, not worth opening with. Above the breakpoint it stays expanded,
    // where it costs nothing (it shares a two-column spread with the plate).
    const infoToggle = document.createElement('button');
    infoToggle.type = 'button';
    infoToggle.id = 'eventInfoToggle';
    infoToggle.className = 'mobile-accordion-toggle sm:hidden w-full';
    infoToggle.setAttribute('aria-expanded', 'false');
    infoToggle.setAttribute('aria-controls', 'eventInfoContent');
    infoToggle.innerHTML = '<span>Event Info</span>';
    eventInfoCard.appendChild(infoToggle);

    const infoContent = document.createElement('div');
    infoContent.id = 'eventInfoContent';
    infoContent.className = 'mobile-accordion-content hidden sm:block';
    eventInfoCard.appendChild(infoContent);

    // The venue as a place, above the particulars. Hidden until coordinates
    // resolve, so an event without them shows no empty square.
    const venueMap = document.createElement('div');
    venueMap.id = 'eventVenueMap';
    venueMap.className = 'sch-colophon__map';
    venueMap.setAttribute('role', 'img');
    venueMap.hidden = true;
    infoContent.appendChild(venueMap);

    const infoList = document.createElement('dl');
    infoList.className = 'sch-colophon__list';

    const eventName = normalizeString(eventMeta?.designation);
    const location = eventMeta?.region || eventMeta?.location || 'Unknown';
    const venue = eventMeta?.venue || 'Unknown';
    const dateRange = formatEventDateRange(eventMeta);
    const website = deriveOfficialWebsite(eventMeta);

    appendInfoRow(infoList, 'Event', eventName || 'Unknown');
    appendInfoRow(infoList, 'Location', location);
    appendInfoRow(infoList, 'Venue', venue);
    appendInfoRow(infoList, 'Dates', dateRange);

    const websiteTerm = document.createElement('dt');
    websiteTerm.className = 'sch-colophon__label';
    websiteTerm.textContent = 'Official Website';
    infoList.appendChild(websiteTerm);
    const websiteValue = document.createElement('dd');
    websiteValue.className = 'sch-colophon__value sch-colophon__value--url';
    if (website) {
      const websiteLink = document.createElement('a');
      websiteLink.href = website;
      websiteLink.target = '_blank';
      websiteLink.rel = 'noopener noreferrer';
      websiteLink.className = 'sch-colophon__link';
      websiteLink.textContent = website;
      websiteValue.appendChild(websiteLink);
    } else {
      websiteValue.textContent = 'Unknown';
    }
    infoList.appendChild(websiteValue);

    infoContent.appendChild(infoList);
    stack.appendChild(eventInfoCard);

    container.innerHTML = '';
    container.appendChild(stack);
    container.classList.remove('hidden');
    // Wired here, not from app.js: this markup is built at render time, after
    // the entry point has finished its own wiring pass.
    setupMobileAccordion(infoToggle, infoContent);
    void initVenueMap(eventMeta, { label: getEventDisplayName(eventMeta) });
  };

  return promoImageReady.then((imageLoaded) => finalizeRender(imageLoaded));
}

function appendInfoRow(list, label, value) {
  const term = document.createElement('dt');
  term.className = 'sch-colophon__label';
  term.textContent = label;
  list.appendChild(term);

  const desc = document.createElement('dd');
  desc.className = 'sch-colophon__value';
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
    year: 'numeric',
  });
  const startLabel = formatDay.format(start);
  const endLabel = formatDay.format(end);
  return startLabel === endLabel ? startLabel : `${startLabel} - ${endLabel}`;
}

function setActiveTab(category) {
  const select = document.getElementById('eventCategorySelect');
  if (select) {
    select.value = category;
  }
  updateHeaderBranding();
}

function getManifestItemByFile(file) {
  return eventCatalog.find((item) => item.file === file) || null;
}

function getCatalogLabel(item = null) {
  const meta = manifestEventMetaByFile.get(item?.file || '') || {};
  const designation = normalizeString(meta.designation);
  const year = normalizeString(meta.year);
  const location = normalizeString(meta.location);
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

/**
 * The loaded catalog. Exposed so other modules can resolve a dataset file to its
 * public slug without re-fetching or re-deriving the rule.
 * @returns {Array<{file: string, event?: Record<string, any>}>}
 */
export function getEventCatalog() {
  return eventCatalog.map((item) => ({
    file: item.file,
    event: manifestEventMetaByFile.get(item.file) || {},
  }));
}

function getEventIdForManifestItem(item) {
  // The catalog's own metadata is the source, but a manifest item carries its
  // event meta in a side map here — so hand `scheduleSlug` the shape it expects.
  return scheduleSlug({ file: item?.file, event: manifestEventMetaByFile.get(item?.file || '') });
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

function buildShareUrlForMode(file, { lockToCurrentEvent = false } = {}) {
  const id = getEventIdByFile(file);
  if (!id) return window.location.href;
  const url = new URL(window.location.href);
  url.search = '';
  if (useSchedulePathRouting(url.pathname)) url.pathname = scheduleHref(id, { pathRouting: true });
  else url.searchParams.set('id', id);
  // Bake in the theme the viewer currently sees so the shared link opens the same way.
  url.searchParams.set('theme', getEffectiveThemeId());
  if (lockToCurrentEvent) {
    url.searchParams.set(SHARE_CURRENT_SCHEDULE_PARAM, '1');
  }
  return url.toString();
}

function updateBrowserUrlForEvent(file) {
  // `/schedules` IS an address — the selection screen. Until the visitor picks
  // something, leave it alone; otherwise the first load would silently move them
  // to whichever schedule happened to be behind the chooser.
  if (initialRoute.view === 'browse' && !state.userPickedSchedule) return;
  const id = getEventIdByFile(file);
  if (!id) return;
  const url = new URL(window.location.href);
  // Under path routing the slug IS the path, so it moves out of the query —
  // otherwise `/schedules/vienna?id=vienna` would say the same thing twice.
  // The static form keeps `?id=`, which is its address.
  if (useSchedulePathRouting(url.pathname)) {
    url.pathname = scheduleHref(id, { pathRouting: true });
    url.searchParams.delete('id');
  } else {
    url.searchParams.set('id', id);
  }
  // Reflect an explicit theme choice (viewer pick or shared-link theme) in the address
  // bar so copying the URL carries it; keep normal browsing URLs clean otherwise.
  if (state.userThemeOverride || state.urlTheme) {
    url.searchParams.set('theme', getEffectiveThemeId());
  } else {
    url.searchParams.delete('theme');
  }
  if (state.scheduleLockedToCurrentEvent) {
    url.searchParams.set(SHARE_CURRENT_SCHEDULE_PARAM, '1');
  } else {
    url.searchParams.delete(SHARE_CURRENT_SCHEDULE_PARAM);
  }
  window.history.replaceState({}, '', url.toString());
  updateScheduleNavLink(id);
}

// Point the nav's own "Schedule" entry at the schedule you are reading.
//
// It shipped pointing at `./index.html` — the chooser. That was harmless while
// a breadcrumb sat above the page, but the trail is hidden on mobile now and
// "Browse events" already covers going back to the full list, so the link was
// a second route to the chooser and no route to the top of the schedule you
// are actually in. Pointing it at itself makes it a way back up, and keeps the
// address it offers the same one the address bar is showing.
function updateScheduleNavLink(id) {
  if (!id) return;
  const link = document.querySelector('.app-nav__link[aria-current="page"]');
  if (link) link.setAttribute('href', scheduleHref(id));
}

// Build the embed snippet for the current event: a <conference-schedule> custom
// element (the host page includes embed.js once, then drops the tag — it builds
// the schedule iframe and auto-heights it). Carries the current theme + the
// sponsor/related toggles.
function buildEmbedSnippet({ id, theme, sponsors = true, related = true }) {
  const attrs = [`id="${id}"`];
  if (theme) attrs.push(`theme="${theme}"`);
  if (!sponsors) attrs.push('sponsors="0"');
  if (!related) attrs.push('related="0"');
  return (
    `<script src="${window.location.origin}/embed.js" async></script>\n` +
    `<conference-schedule ${attrs.join(' ')}></conference-schedule>`
  );
}

// The theme baked into the embed is exactly what the viewer currently sees — the
// effective theme (viewer pick > shared-link theme > event theme > default) — so the
// embed carries the picked look, not just the event default.
function resolveEmbedThemeId() {
  return getEffectiveThemeId();
}

// Regenerate the embed snippet from the modal's toggles (called on open + on change).
function updateEmbedSnippet() {
  const out = document.getElementById('embedSnippet');
  if (!out || !state.currentEventFile) return;
  const id = getEventIdByFile(state.currentEventFile);
  if (!id) return;
  const sponsors = document.getElementById('embedSponsors')?.checked !== false;
  const related = document.getElementById('embedRelated')?.checked !== false;
  out.value = buildEmbedSnippet({ id, theme: resolveEmbedThemeId(), sponsors, related });
}

function setShareButtonCopiedState() {
  const button = document.getElementById('shareSchedule');
  if (!button) return;
  const previous = button.innerHTML;
  button.innerHTML = 'Link copied';
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

  modal = buildModalOverlay({
    id: SHARE_MODAL_ID,
    innerHTML: `
    <div class="session-modal-card share-modal-card" role="dialog" aria-modal="true" aria-labelledby="shareModalTitle">
      <div class="session-modal-header share-modal-header">
        <span class="share-modal-eyebrow"> Share</span>
        <button id="shareModalClose" type="button" class="session-modal-close" aria-label="Close share options">Close</button>
      </div>
      <div id="shareModalBody" class="session-modal-body share-modal-body"></div>
    </div>
  `,
  });

  dismissOnBackdrop(modal, closeShareModal);
  modal.querySelector('#shareModalClose').addEventListener('click', closeShareModal);
  modal.querySelector('#shareModalBody').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-share-url]');
    if (!button) return;
    const url = button.getAttribute('data-share-url');
    const statusMessage =
      button.getAttribute('data-status-message') || 'Share link copied to clipboard.';
    await copyShareUrl(url, statusMessage);
    closeShareModal();
  });

  return modal;
}

function renderShareOptions() {
  const body = ensureShareModal().querySelector('#shareModalBody');
  if (!body || !state.currentEventFile) return;
  const eventName = getCurrentEventDisplayName();

  // One shareable link: it opens this event's schedule locked to it (the slug is
  // always included), so recipients land exactly here.
  const shareOptions = [
    {
      title: `Share the ${eventName} schedule`,
      text: 'Anyone with this link opens this schedule.',
      url: buildShareUrlForMode(state.currentEventFile, { lockToCurrentEvent: true }),
      statusMessage: 'Share link copied to clipboard.',
      buttonLabel: 'Copy link',
      primary: true,
    },
  ];

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
        `,
      )
      .join('')}
    <section class="share-modal-option share-embed">
      <h3 class="share-modal-option-title"> Embed on your site</h3>
      <p class="share-modal-option-text">Drop this into any page to show the schedule (matches the current theme). It updates when you edit the schedule.</p>
      <div class="share-embed-toggles">
        <label><input type="checkbox" id="embedSponsors" checked> Show sponsors</label>
        <label><input type="checkbox" id="embedRelated" checked> Show related events</label>
      </div>
      <textarea id="embedSnippet" class="share-embed-code" rows="3" readonly aria-label="Embed code"></textarea>
      <button type="button" class="share-modal-copy" id="embedCopyBtn">Copy embed code</button>
    </section>
  `;

  // Embed section is interactive (toggles regenerate the snippet; a dedicated copy).
  updateEmbedSnippet();
  body.querySelector('#embedSponsors')?.addEventListener('change', updateEmbedSnippet);
  body.querySelector('#embedRelated')?.addEventListener('change', updateEmbedSnippet);
  body.querySelector('#embedCopyBtn')?.addEventListener('click', async (e) => {
    e.stopPropagation(); // don't let the modal's copy-and-close delegation fire
    const snippet = document.getElementById('embedSnippet')?.value || '';
    if (!snippet) return;
    try {
      await navigator.clipboard.writeText(snippet);
    } catch {
      document.getElementById('embedSnippet')?.select();
    }
    const btn = e.currentTarget;
    const prev = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => {
      btn.textContent = prev;
    }, 1500);
  });
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

async function fetchEvents(filename) {
  if (filename === '__preview__') {
    try {
      const raw = readText(STORAGE_KEYS.preview);
      if (!raw) return [];
      const data = JSON.parse(raw);
      state.eventMeta = data.event || {};
      return processEventItems(data.items || []);
    } catch {
      // Corrupt preview payload in storage → show nothing.
      return [];
    }
  }
  try {
    // Falls back to the last saved copy when the network is gone, so the
    // programme you were reading survives losing signal mid-conference. The
    // status check stays inside loadJson: a 404 HTML error page parses as JSON in
    // some setups and throws in others, and neither is "no sessions".
    const { data, fromCache, savedAt } = await loadJson(`./data/${filename}`);
    state.eventMeta = data.event;
    state.datasetError = null;
    state.datasetStale = fromCache ? { file: filename, savedAt } : null;
    return processEventItems(data.items);
  } catch (err) {
    // Returning [] alone made a failed load indistinguishable from an event
    // with no programme yet: the page rendered its full chrome around nothing
    // and said not one word about it. The renderer needs to know which it is.
    state.datasetError = { file: filename, message: String(err?.message || err) };
    state.datasetStale = null;
    reportError(`fetchEvents(${filename})`, err);
    return [];
  }
}

/**
 * Say which of the two happened, because they need different things from the
 * reader: a stale copy is usable and wants its age; a failed load is not usable
 * and wants a retry. Rendering the same chrome around nothing, silently, was the
 * old behaviour — `state.datasetError` was set here and read by nobody.
 */
function renderDatasetNotice() {
  const host = document.getElementById('filtersPanel');
  if (!host) return;
  const existing = document.getElementById('datasetNotice');
  if (existing) existing.remove();

  const stale = state.datasetStale;
  const failed = state.datasetError;
  if (!stale && !failed) return;

  const box = document.createElement('div');
  box.id = 'datasetNotice';
  box.className = 'sch-plate mt-4';
  box.setAttribute('role', 'status');

  const body = document.createElement('div');
  body.className = 'sch-plate__body';

  const eyebrow = document.createElement('div');
  eyebrow.className = 'sch-plate__eyebrow u-label';
  eyebrow.textContent = stale ? 'OFFLINE COPY' : 'COULD NOT LOAD';
  body.appendChild(eyebrow);

  const text = document.createElement('p');
  text.textContent = stale
    ? `Showing the last copy of this programme, ${savedAgo(stale.savedAt)}. It may be out of date.`
    : 'This programme could not be loaded. It may be a connection problem rather than an empty schedule.';
  body.appendChild(text);

  if (failed) {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'app-btn';
    retry.textContent = 'Try again';
    retry.addEventListener('click', () => window.location.reload());
    body.appendChild(retry);
  }

  box.appendChild(body);
  host.appendChild(box);
}

function inferFlagFromMeta(meta = {}) {
  const combined = `${meta.region || ''} ${meta.location || ''}`.toLowerCase();
  if (
    combined.includes('new zealand') ||
    combined.includes('wellington') ||
    combined.includes('auckland') ||
    combined.includes('christchurch')
  ) {
    return { flagImage: './img/flags/nz.svg', flagAlt: 'New Zealand flag' };
  }
  if (
    combined.includes('australia') ||
    combined.includes('canberra') ||
    combined.includes('melbourne') ||
    combined.includes('brisbane') ||
    combined.includes('gold coast') ||
    combined.includes('hobart') ||
    combined.includes('sydney')
  ) {
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

async function loadEvent(filename) {
  state.currentEventFile = filename;
  updateBrowserUrlForEvent(filename);
  const manifestItem = getManifestItemByFile(filename);
  const events = await fetchEvents(filename);
  updateHeaderFlag(manifestItem || inferFlagFromMeta(state.eventMeta || {}));
  if (state.currentEventCategory) {
    updateHeaderBranding();
  }
  const meta = state.eventMeta || {};
  const themeVal = meta.theme;
  applyEffectiveTheme();
  applyEventColors(
    typeof themeVal === 'object' ? themeVal?.primaryColor : meta.primaryColor,
    typeof themeVal === 'object' ? themeVal?.secondaryColor : meta.secondaryColor,
    typeof themeVal === 'object' ? themeVal?.tertiaryColor : meta.tertiaryColor,
  );
  state.eventColumns = Number(meta.columns) > 0 ? Number(meta.columns) : 3;
  const eventDisplayName = updateDocumentTitle(meta, manifestItem);

  document.getElementById('pageTitle').innerHTML =
    `<span class="header-event">${eventDisplayName}</span>`;

  const websiteURL = String(meta.website || '').replace('/schedule', '');
  document.getElementById('creditsEventLink').innerHTML =
    `This is a custom schedule builder for <a href="${websiteURL || '#'}" target="_blank" class="drupal-blue-text">${eventDisplayName}</a>. <strong>It is not affiliated with ${eventDisplayName}</strong>.`;
  await renderEventMediaPromo(meta, events);
  renderDatasetNotice();

  events.forEach((event) => {
    // An unscheduled session has no startTime, and interpolating one would put
    // the literal "undefined" at the head of every id in the pool — where the
    // remaining title and location may not be enough to keep them apart.
    const when = event.unscheduled ? 'unscheduled' : event.startTime;
    event.id = `${when}-${event.location}-${event.title}`.replace(/[^a-zA-Z0-9-]/g, '-');
  });
  // The day filter is built from the days that exist. Unscheduled sessions have
  // no day to contribute — and `getLocalDate(undefined)` THROWS, taking the
  // whole page down before anything renders, so they must be dropped here and
  // not merely produce an empty option.
  const uniqueDates = [
    ...new Set(
      events
        .filter((event) => !event.unscheduled)
        .map((event) => getLocalDate(event.startTime, state.eventMeta?.timezone)),
    ),
  ];
  const uniqueTracks = [...new Set(events.flatMap((event) => normalizeTracks(event.track)))];

  const dateFilter = document.getElementById('dateFilter');
  dateFilter.innerHTML = '<option value="">All Days</option>';
  uniqueDates.sort().forEach((date) => {
    const option = document.createElement('option');
    option.value = date;
    option.textContent = new Date(date + 'T12:00:00').toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
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

  const savedSelections = readText(getStorageKey());
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
  // Embed can exclude the sponsor / related-events blocks via ?sponsors=0 / ?related=0.
  if (!state.embedMode || state.embedSponsors) renderSponsors(meta);
  else document.getElementById('sponsorsContainer')?.classList.add('hidden');
  if (!state.embedMode || state.embedRelated) {
    renderRelatedEvents(meta);
    applyRelatedEventsPlacement(meta);
  } else {
    document.getElementById('relatedEventsContainer')?.classList.add('hidden');
  }
  postEmbedHeight();

  document.getElementById('dateFilter').value = '';
  document.getElementById('trackFilter').value = '';
  document.getElementById('keywordsFilter').value = '';
  document.getElementById('selectionFilter').value = 'all';
  toggleClearButton();
}

function setupEventListeners() {
  document
    .getElementById('dateFilter')
    .addEventListener('change', () => applyFilters(state.allEvents, 'dateFilter'));
  document
    .getElementById('trackFilter')
    .addEventListener('change', () => applyFilters(state.allEvents, 'trackFilter'));
  document.getElementById('keywordsFilter').addEventListener('input', () => {
    toggleClearButton();
    applyFilters(state.allEvents, null, true);
    debouncedFilterEvents(state.allEvents);
  });
  document
    .getElementById('clearKeywords')
    .addEventListener('click', () => clearKeywordsFilter(state.allEvents));
  document
    .getElementById('selectionFilter')
    .addEventListener('change', () => applyFilters(state.allEvents, 'selectionFilter'));
  document
    .getElementById('downloadIcs')
    .addEventListener('click', () => downloadSelectedEvents(state.allEvents));
  document
    .getElementById('addGoogleCalendar')
    .addEventListener('click', () => addSelectedEventsToGoogleCalendar(state.allEvents));

  document
    .getElementById('resetFilters')
    .addEventListener('click', () => resetFilters(state.allEvents));

  // The empty state's own way out. Delegated, because that button only exists
  // while nothing matches and is destroyed on the next render.
  document.getElementById('eventsContainer')?.addEventListener('click', (e) => {
    if (e.target.closest('[data-empty-reset]')) resetFilters(state.allEvents);
    if (e.target.closest('[data-empty-retry]')) window.location.reload();
  });
  document
    .getElementById('selectAllDisplayed')
    .addEventListener('click', () => selectAllDisplayed(state.allEvents));
  document
    .getElementById('deselectAllDisplayed')
    .addEventListener('click', () => deselectAllDisplayed(state.allEvents));

  // State is expressed with aria-expanded and the caret rotates off it in CSS.
  // This previously reached for `#toggleDetails i` — a Font Awesome element
  // that no longer exists, so every click threw.
  document.getElementById('toggleDetails').addEventListener('click', (e) => {
    const detailsSection = document.getElementById('stageDetails');
    const button = e.currentTarget;
    const opening = detailsSection.classList.contains('hidden');
    window.sa_event?.(opening ? 'selection_details_opened' : 'selection_details_closed');
    detailsSection.classList.toggle('hidden', !opening);
    button.setAttribute('aria-expanded', opening ? 'true' : 'false');
  });

  const shareButton = document.getElementById('shareSchedule');
  if (shareButton) {
    shareButton.addEventListener('click', () => openShareModal());
  }

  const searchEventsButton = document.getElementById('searchEvents');
  if (searchEventsButton) {
    searchEventsButton.addEventListener('click', () => openBrowse());
  }
  // The header logo/title also opens the Browse home.
  document.getElementById('headerLogo')?.addEventListener('click', () => openBrowse());

  // Usage-instructions panel: dismissible on desktop, remembered across visits.
  const instructions = document.getElementById('usageInstructionsPanel');
  if (instructions && readText(STORAGE_KEYS.scheduleInstructionsDismissed)) {
    instructions.classList.add('hidden');
  }
  document.getElementById('dismissInstructions')?.addEventListener('click', () => {
    instructions?.classList.add('hidden');
    writeText(STORAGE_KEYS.scheduleInstructionsDismissed, '1');
  });

  // Day quick-nav (rebuilt each render) → smooth-scroll to the chosen day.
  document.getElementById('dayNav')?.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-day-target]');
    if (!chip) return;
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    document
      .getElementById(chip.dataset.dayTarget)
      ?.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'start' });
  });
}

function parseAndApplyStartupModes(urlModes) {
  // Embed implies a single locked schedule with all app chrome stripped (see embed.css).
  state.embedMode = urlModes.embed;
  state.embedSponsors = urlModes.sponsors;
  state.embedRelated = urlModes.related;
  state.scheduleLockedToCurrentEvent = urlModes.currentSchedule || urlModes.embed;
  if (urlModes.embed) document.body.classList.add('embed-mode');
  // Theme precedence: URL (shared link) > explicit viewer override > event theme >
  // saved base > default. themeMode holds the saved *base*; urlTheme is session-only
  // (a shared themed link shouldn't permanently hijack the viewer's preference).
  const savedTheme = readText(THEME_STORAGE_KEY) || '';
  state.themeMode = setCurrentThemeId(normalizeThemeId(savedTheme));
  state.urlTheme = urlModes.theme && getThemeById(urlModes.theme) ? urlModes.theme : '';
  state.userThemeOverride = getThemeOverride();
  applyEffectiveTheme();
}

// Resolve + apply the effective theme from current state (event meta + override +
// url + base). Applies the palette class; the event's own accent colours (set in
// applyThemeFromMeta) stay layered on top, so a picked palette keeps event identity.
function applyEffectiveTheme() {
  const themeVal = state.eventMeta?.theme;
  const metaThemeId = typeof themeVal === 'object' ? themeVal?.id : themeVal;
  const eff = resolveThemeId([
    state.urlTheme,
    state.userThemeOverride,
    metaThemeId,
    state.themeMode,
  ]);
  state.effectiveThemeId = eff;
  applyThemeClass(eff);
  // Mirror the effective theme so the planner page can match it exactly.
  writeText(STORAGE_KEYS.currentThemeId, eff);
  return eff;
}

export function getEffectiveThemeId() {
  return state.effectiveThemeId || state.themeMode || normalizeThemeId('');
}

// Theme-picker handler: id ⇒ set an explicit override, null ⇒ reset to the event
// default. Re-applies, reflects the choice in the address bar, and refreshes the
// embed snippet if the share modal is open.
export function selectTheme(id) {
  if (id) {
    setThemeOverride(id);
    state.userThemeOverride = id;
  } else {
    clearThemeOverride();
    state.userThemeOverride = '';
  }
  state.urlTheme = ''; // a deliberate pick supersedes a shared-link theme
  applyEffectiveTheme();
  if (state.currentEventFile) updateBrowserUrlForEvent(state.currentEventFile);
  updateEmbedSnippet();
  return state.effectiveThemeId;
}

function wireEventListeners() {
  setupEventListeners();
}

// ── Browse home: neutral header while browsing, event branding on the schedule ──
// While the Browse home is open the header shouldn't advertise the last event —
// show a generic identity instead, then restore the event's branding on close.
function setBrowseHeader() {
  const kicker = document.getElementById('headerKicker');
  const title = document.getElementById('pageTitle');
  const logo = document.getElementById('headerLogo');
  const logoIcon = document.getElementById('headerLogoIcon');
  const logoImage = document.getElementById('headerLogoImage');
  const flag = document.getElementById('headerFlag');
  if (kicker) kicker.textContent = 'Conference Schedules';
  if (title) title.innerHTML = '<span class="header-event">Browse events</span>';
  if (logo) logo.classList.remove('brand-drupalsouth', 'brand-community', 'brand-primary');
  if (logoImage) logoImage.classList.add('hidden');
  if (logoIcon) {
    logoIcon.className = 'fas fa-calendar-days';
    logoIcon.classList.remove('hidden');
  }
  if (flag) flag.classList.add('hidden');
}

function restoreEventHeader() {
  if (!state.currentEventFile) return;
  const item = getManifestItemByFile(state.currentEventFile);
  updateHeaderFlag(item || inferFlagFromMeta(state.eventMeta || {}));
  if (state.currentEventCategory) updateHeaderBranding();
  const title = document.getElementById('pageTitle');
  if (title) {
    title.innerHTML = `<span class="header-event">${getCurrentEventDisplayName()}</span>`;
  }
}

function openBrowse() {
  setBrowseHeader();
  openScheduleHome();
}

function closeBrowse() {
  closeScheduleHome();
  restoreEventHeader();
}

function showPreviewBanner() {
  const banner = document.createElement('div');
  banner.className = 'preview-banner';
  const canReturn = Boolean(window.opener && !window.opener.closed);
  const backControl = canReturn
    ? `<button type="button" class="preview-banner-link" id="previewBannerBack">Back to editor</button>`
    : `<a href="./editor.html" class="preview-banner-link">Back to editor</a>`;
  banner.innerHTML = `<span><strong>Preview mode</strong> — these changes have not been saved yet.</span>${backControl}`;
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
    const raw = readText(STORAGE_KEYS.preview);
    if (raw) {
      try {
        const data = JSON.parse(raw);
        const designation = String(data?.event?.designation || '').toLowerCase();
        state.currentEventCategory = designation.includes('drupalcon')
          ? 'DrupalCon'
          : data?.event?.designation || 'Conference';
      } catch {
        /* use defaults */
      }
    }
    wireEventListeners();
    await loadEvent('__preview__');
    showPreviewBanner();
    return;
  }

  parseAndApplyStartupModes(urlModes);
  await hydrateManifestCategories();

  const fileFromUrl = getEventFileById(urlModes.id);
  const savedEvent = readText(STORAGE_KEYS.selectedEventFile);
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

  writeText(STORAGE_KEYS.selectedEventFile, initialFile);
  wireEventListeners();
  await loadEvent(initialFile);

  // The Browse home: default/saved/?id event has loaded above; the home is an
  // opt-in view (Browse button / logo / ?browse) over that schedule.
  initScheduleHome({
    // getEvents(true) returns the full list with unpublished events tagged
    // `hidden`; the Browse "Show all" toggle decides what's rendered.
    getEvents: (includeAll = false) => getSearchableEvents(includeAll),
    // Owners (?showHidden=1) can open unpublished schedules; the public can only
    // see them as locked cards.
    isOwner: () => new URLSearchParams(window.location.search).get('showHidden') === '1',
    getDefaultFile: () => defaultEvent.file,
    onSelect: (category, file) => {
      closeScheduleHome();
      selectEventFromSearch(category, file); // loadEvent sets the new event's header
    },
    onClose: closeBrowse,
  });
  // `/schedules` (the bare section address) IS the selection screen, the same way
  // `/planner` is. `?browse=1` says the same thing in the static form.
  if (initialRoute.view === 'browse') openBrowse();
}

export function toggleEventSelectionPublic(eventId) {
  toggleEventSelection(eventId, applyFilters, (events) =>
    updateSelectionOverview(events, updateStageStats),
  );
}
