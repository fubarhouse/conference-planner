import './modules/pwa.js'; // registers the service worker (PWA/offline)
import {
  loadThemes,
  normalizeThemeId,
  applyThemeClass,
  applyEventColors,
  getCurrentThemeId,
} from './modules/theme.js';

import {
  loadPlanner,
  savePlanner,
  makeItemId,
  listPlannerFiles,
  loadGlobal,
  saveGlobal,
  GLOBAL_KEY,
  STORAGE_KEYS,
  getPlannerKey,
  readJson,
  writeJson,
  readText,
  writeText,
  removeKey,
  isPlannerEntry,
  plannerDisplayName,
  plannerFilename,
  normalizeEventFiles,
  saveReceiptViaApi,
} from './modules/plannerStorage.js';
import { guardPlannerLock, lockEnforceable, grantUnlockGrace } from './modules/plannerLock.js';
import { loadRatesIntoCache } from './modules/currency.js';

import { escapeHtml, isLocalhost, normalizeString } from './modules/utils.js';
import { showToast, showUndoToast, reportError } from './modules/notify.js';
import {
  initPlannerFields,
  CURRENCIES,
  getDefaultCurrency,
  currencyOptions,
  plannerDisplayCurrency,
  tzDatalist,
  sessionOptionsHtml,
  buildSelectOptions,
} from './modules/plannerFields.js';
import { showModal, hideModal, touchDevice } from './modules/modal.js';
import {
  initTasks,
  renderTasksTab,
  wireTasksPanel,
  tasksPanelHtml,
} from './modules/plannerTasks.js';
import {
  initNotes,
  renderNotesTab,
  wireNotesPanel,
  notesPanelHtml,
} from './modules/plannerNotes.js';
import {
  initContacts,
  renderContactsTab,
  wireContactsPanel,
  contactsPanelHtml,
} from './modules/plannerContacts.js';
import {
  initReceipts,
  renderReceiptsTab,
  wireReceiptsPanel,
  receiptsPanelHtml,
  openReceiptModal,
} from './modules/plannerReceipts.js';
import {
  initDocuments,
  renderDocumentsTab,
  wireDocumentsPanel,
  documentsPanelHtml,
} from './modules/plannerDocuments.js';
import {
  initTickets,
  renderTicketsTab,
  wireTicketsPanel,
  ticketsPanelHtml,
} from './modules/plannerTickets.js';
import {
  initTrackedSessions,
  syncSponsoredSessions,
  wireTrackedSessionModal,
  wireTrackedSessionSearch,
} from './modules/plannerTrackedSessions.js';
import { initMap, renderMapTab, wireMapPanel, mapPanelHtml } from './modules/plannerMap.js';
import {
  initSplit,
  renderSplitTab,
  wireSplitPanel,
  splitPanelHtml,
} from './modules/plannerSplit.js';
import {
  initChecklists,
  renderChecklistsTab,
  wireChecklistsPanel,
  checklistsPanelHtml,
} from './modules/plannerChecklists.js';
import {
  initWeather,
  renderWeatherTab,
  renderItineraryWeather,
  renderWeatherSummary,
  wireWeatherPanel,
  weatherPanelHtml,
} from './modules/plannerWeather.js';
import {
  initPersonalLeg,
  openPersonalLegModal,
  wirePersonalLegModal,
} from './modules/plannerPersonalLeg.js';
import { itineraryItemToCalEvent, accommodationToCalEvent } from './modules/plannerCalendar.js';
import { openCalendarMenu } from './modules/plannerCalendarUi.js';
import {
  renderSurfaceView,
  viewAttrsFor,
  isClickableEvent,
} from './modules/plannerCalendarView.js';
import {
  initAccommodation,
  openAccommodationModal,
  checklistItemHtml,
  swagCardHtml,
  renderAccomMembersSection,
  loadMemberStayFields,
} from './modules/plannerAccommodation.js';
import {
  initCompanions,
  renderCompanionsTab,
  wireCompanionsPanel,
  companionsPanelHtml,
  openCompanionDetail,
} from './modules/plannerCompanions.js';
import {
  initSchedule,
  renderScheduleTab,
  wireSchedulePanel,
  schedulePanelHtml,
} from './modules/plannerSchedule.js';
import { wirePersonDetailModal } from './modules/plannerPersonDetail.js';
import {
  initAssignments,
  makeTripAssignment,
  renderSettingsPersonalContactsSection,
  openPersonalContactModal,
  wirePersonalContactModal,
  companionCardHtml,
  renderPersonalCompanionsSection,
  openTripAssignmentModal,
  openLocalCompanionAssignmentModal,
  renderPersonalAccomMembersSection,
  loadPersonalCompanionStayFields,
  _hideAssignmentModalImportButtons,
} from './modules/plannerAssignments.js';
import {
  initBudget,
  getEventBudgetCategories,
  getActiveBudgetCategoryOptions,
  renderBudgetItems,
  renderBudgetTab,
  wireBudgetPanel,
  wireBudgetItemsPanel,
  renderBudgetCategoryManager,
  addBudgetCategory,
  removeBudgetCategory,
  setDefaultBudgetCategories,
  budgetPanelHtml,
} from './modules/plannerBudget.js';
import {
  initSummary,
  buildEventBudgetData,
  buildPersonalBudgetData,
  renderSummaryTab,
  wireSummaryPanel,
  summaryPanelHtml,
} from './modules/plannerSummary.js';
import { makeLeg, TRAVEL_STATUSES } from './modules/plannerTravel.js';
import {
  initPersonal,
  renderPersonalTab,
  renderPersonalItinerary,
  renderPersonalTimeline,
  renderPersonalAccomList,
  renderPersonalNotes,
  renderPersonalBudgetBreakdown,
  renderSponsorBudgetBreakdown,
  personalPanelHtml,
} from './modules/plannerPersonal.js';
import {
  initOrg,
  renderOrgTab,
  renderAssignmentLegsInModal,
  accomTypeIcon,
  makeWaypointStop,
  renderWaypointStops,
  toggleWaypointStopsSection,
  wireWaypointStopsDragDrop,
  initMapCoordPickers,
  renderTimeline,
  refreshAssignMemberSelect,
  sponsorPanelHtml,
} from './modules/plannerOrg.js';
import {
  initImportExport,
  handleExport,
  openCalendarExportModal,
  downloadTripIcs,
  createFeedToken,
  copyFeedUrl,
  revokeFeedToken,
  handleImport,
  handleSaveToFile,
  mergeGlobalTeamMembers,
} from './modules/plannerImportExport.js';
import { initGlobalSettings, wireGlobalSettingsModal } from './modules/plannerGlobalSettings.js';
import {
  initCreatePlanner,
  openCreatePlannerModal,
  wireCreatePlannerModal,
} from './modules/plannerCreate.js';
import { initDashEdit, wireDashboardPlannerEditModal } from './modules/plannerDashEdit.js';
import { initCogMenu, wireTripCogMenu } from './modules/plannerCogMenu.js';
import { initDashboard, renderTripDashboard } from './modules/plannerDashboard.js';
import {
  initTeam,
  renderTeamTab,
  openTeamMemberModal,
  openTeamMemberDetailModal,
  wireTeamPanel,
  teamPanelHtml,
} from './modules/plannerTeam.js';
import {
  initItinerary,
  wireItineraryPanel,
  renderOrgItinerary,
  openOrgEventModal,
  personalAssigneeChips,
  personalAssignablePeople,
  makeItineraryItem,
  itineraryPanelHtml,
} from './modules/plannerItinerary.js';
import { configureEventSearch, openEventSearchModal } from './modules/eventSearch.js';
import {
  renderEntityReceiptStatus,
  createReceiptForEntity,
  linkEntityReceipt,
  unlinkEntityReceipt,
  linkedReceipt,
  openReceiptPicker,
} from './modules/plannerEntityReceipt.js';
import { loadEventCatalog } from './modules/eventCatalog.js';
import { bottomBarHtml, moreSheetHtml } from './modules/mobileNav.js';
import { parsePlannerRoute, plannerHref, plannerCrumbs } from './modules/plannerRoute.js';
import { initThemePicker } from './modules/themePicker.js';
import { toWednesdayOfWeek, autoArriveDate, localDateStr } from './modules/plannerDates.js';
import { buildDayItinerary } from './modules/plannerAgenda.js';
import { detectPersonalConflicts, accommodationGaps } from './modules/plannerConflicts.js';
import { bottomBarPrimary } from './modules/plannerNav.js';
import { renderApiTokenSection } from './modules/plannerApiTokens.js';
import {
  SPONSOR_TABS_BASE,
  PERSONAL_TABS_BASE,
  CONFERENCE_TABS,
  visibleTabsOrdered,
  visibleTabs,
} from './modules/plannerTabs.js';

// ── State ────────────────────────────────────────────────────────────────────

const state = {
  plannerKey: null, // storage key (may differ from eventFile for custom planners)
  eventFile: null, // PRIMARY schedule association (.json file) = _eventFiles[0], null when none
  eventMeta: null, // primary event's metadata (drives timezone/theme/weather/header)
  allSessions: [], // sessions merged across ALL associated events (each tagged _eventFile/_eventLabel)
  events: [], // [{ file, meta, label }] one per associated event — for multi-event conference bands
  planner: null,
  global: null,
  activeTab: 'personal',
  notesSearchQuery: '',
  tasksFilter: 'all',
  dirty: false,
};

// Summary UI state (display currency, global filter) + rate notice moved to
// ./modules/plannerSummary.js.

// ── Per-event date cache ──────────────────────────────────────────────────────
// eventFile → { wednesday, start, end } once fetched. A fetched-but-unusable
// event (missing/HTTP-error/no startDate) caches an all-null record so it is not
// refetched. `wednesday` feeds the chart time axis, `start` the FX rate lookup,
// `end` the trip dashboard.
const _eventDates = new Map();
const EVENT_DATES_MISS = { wednesday: null, start: null, end: null };

async function fetchEventDates(eventFile) {
  if (_eventDates.has(eventFile)) return _eventDates.get(eventFile);
  try {
    const res = await fetch(`./data/${resolveEventFile(eventFile)}`);
    if (!res.ok) {
      _eventDates.set(eventFile, EVENT_DATES_MISS);
      return EVENT_DATES_MISS;
    }
    const data = await res.json();
    const startDate = data?.event?.startDate;
    const endDate = data?.event?.endDate;
    if (!startDate) {
      _eventDates.set(eventFile, EVENT_DATES_MISS);
      return EVENT_DATES_MISS;
    }
    const record = {
      wednesday: toWednesdayOfWeek(startDate),
      start: startDate.slice(0, 10),
      end: endDate ? endDate.slice(0, 10) : null,
    };
    _eventDates.set(eventFile, record);
    return record;
  } catch (err) {
    reportError(`fetchEventDates(${eventFile})`, err);
    _eventDates.set(eventFile, EVENT_DATES_MISS);
    return EVENT_DATES_MISS;
  }
}

// ── Utilities ────────────────────────────────────────────────────────────────

const esc = escapeHtml;

function getTimezone() {
  return state.eventMeta?.timezone || undefined;
}

function fmtTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: getTimezone(),
  });
}

function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: getTimezone(),
  });
}

function groupByDate(sessions) {
  const groups = {};
  sessions.forEach((s) => {
    const key = new Date(s.startTime).toLocaleDateString('en-CA', { timeZone: getTimezone() });
    (groups[key] ??= []).push(s);
  });
  return groups;
}

// ── Toast & dirty state ──────────────────────────────────────────────────────

function markDirty(flag) {
  state.dirty = flag;
  const el = document.getElementById('plannerDirtyState');
  if (el) {
    const dot = el.querySelector('.sidebar-dirty-dot');
    const label = el.querySelector('span:not(.sidebar-dirty-dot)');
    dot?.classList.toggle('is-dirty', flag);
    if (label) label.textContent = flag ? 'Unsaved changes' : 'Saved';
  }
  _syncSidebarDirty(flag);
}

let _saveTimer = null;

function scheduleAutoSave() {
  if (!state.plannerKey) return;
  markDirty(true);
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    savePlanner(state.plannerKey, state.planner);
    markDirty(false);
    showToast();
  }, 600);
}

// ── Modal visibility helpers ─────────────────────────────────────────────────

// ── Disk recovery ────────────────────────────────────────────────────────────

// Cached probe: can this client read authorized API endpoints? Lets the disk-seed
// helpers below skip authorized-only requests when the API is unavailable or the
// user isn't logged in — so an unauthenticated/static setup degrades quietly
// instead of firing 401s. The shared promise means concurrent callers probe once.
let _apiCanReadPromise = null;
function apiCanRead() {
  if (!_apiCanReadPromise) {
    _apiCanReadPromise = (async () => {
      try {
        const res = await fetch('./api/auth/status');
        if (!res.ok) return false;
        const { authenticated } = await res.json();
        return !!authenticated;
      } catch {
        return false; // no server / offline → disk sync unavailable
      }
    })();
  }
  return _apiCanReadPromise;
}

// Seeds localStorage from the API disk copy when the local entry is missing or has a corrupted
// event association (e.g. _eventFile was overwritten by a stale bug and points to the wrong event).
async function seedFromDiskIfMissing(plannerKey) {
  if (!(await apiCanRead())) return;
  if (_getDeletedSlugs().has(plannerKey)) return;
  const raw = readText(getPlannerKey(plannerKey));
  if (raw) {
    // For schedule-linked planners (key ends in .json), the _eventFile must equal the plannerKey.
    // If they differ the local entry was corrupted — fall through to re-seed from disk.
    try {
      const local = JSON.parse(raw);
      const corrupted =
        plannerKey.endsWith('.json') && local._eventFile && local._eventFile !== plannerKey;
      if (!corrupted) return;
    } catch {
      /* parse error — fall through to re-seed */
    }
  }
  try {
    const filename = plannerFilename(plannerKey);
    const res = await fetch(`./api/planner/${filename}`);
    if (!res.ok) return;
    const data = await res.json();
    if (!data || typeof data !== 'object') return;
    if (!data._eventFile && !data._plannerKey && !data._displayName) return;
    delete data._globalTeamMembers; // strip before saving; global.json handles team member seeding
    writeJson(getPlannerKey(plannerKey), data);
  } catch {
    /* server not running or file not found — silent */
  }
}

// Seeds global state from disk on every startup, merging non-destructively by key.
// Team members + budget categories: merged by ID — new entries are appended, existing ones are never overwritten.
// defaultMode: seeded only when the local value is empty/missing.
async function seedGlobalFromDiskIfMissing() {
  if (!(await apiCanRead())) return;
  try {
    const res = await fetch('./api/planner/global.json');
    if (!res.ok) return;
    const data = await res.json();
    if (!data || typeof data !== 'object') return;
    const existing = readJson(GLOBAL_KEY, {});
    let changed = false;

    // Merge team members by ID
    if (Array.isArray(data.teamMembers)) {
      const existingIds = new Set((existing.teamMembers || []).map((m) => m.id));
      const toAdd = data.teamMembers.filter((m) => m?.id && !existingIds.has(m.id));
      if (toAdd.length) {
        existing.teamMembers = [...(existing.teamMembers || []), ...toAdd];
        changed = true;
      }
    }

    // Merge budget categories by ID — adds any from global.json not yet in localStorage
    if (Array.isArray(data.budgetCategories) && data.budgetCategories.length) {
      const existingIds = new Set((existing.budgetCategories || []).map((c) => c.id));
      const toAdd = data.budgetCategories.filter((c) => c?.id && !existingIds.has(c.id));
      if (toAdd.length) {
        existing.budgetCategories = [...(existing.budgetCategories || []), ...toAdd];
        changed = true;
      }
    }

    // Seed default mode and currency if local has none
    if (data.defaultMode && !existing.defaultMode) {
      existing.defaultMode = data.defaultMode;
      changed = true;
    }
    if (data.defaultCurrency && !existing.defaultCurrency) {
      existing.defaultCurrency = data.defaultCurrency;
      changed = true;
    }

    if (changed) writeJson(GLOBAL_KEY, existing);
  } catch {
    /* server not running or file not found — silent */
  }
}

// ── Shared planner delete ────────────────────────────────────────────────────

// Tombstone list — slugs deleted by the user. Prevents seedFromDiskIfMissing
// from restoring disk files when the API delete fails or is unavailable.
const DELETED_SLUGS_KEY = STORAGE_KEYS.deletedPlanners;

function _getDeletedSlugs() {
  return new Set(readJson(DELETED_SLUGS_KEY, []));
}
function _markDeleted(slug) {
  const set = _getDeletedSlugs();
  set.add(slug);
  writeJson(DELETED_SLUGS_KEY, [...set]);
}

// Removes from localStorage, records a tombstone, then attempts disk + S3 removal.
// Removes from localStorage, records a tombstone, then calls DELETE /api/planner/{file}.
// The server handles both local disk and S3 deletion via this endpoint.
// Returns { ok: boolean, error: string|null }
async function deletePlannerBySlug(slug) {
  if (!slug) return { ok: false, error: 'No slug provided' };
  removeKey(getPlannerKey(slug));
  _markDeleted(slug);

  const filename = plannerFilename(slug);
  // Use the same base URL logic as s3Settings.js — falls back to current origin
  const stored = (readText(STORAGE_KEYS.editorApiEndpoint) || '').replace(/\/$/, '');
  const base = stored || window.location.origin;

  try {
    const res = await fetch(`${base}/api/planner/${filename}`, { method: 'DELETE' });
    if (res.ok) return { ok: true, error: null };
    let msg = `Server returned ${res.status}`;
    try {
      const body = await res.json();
      msg = body.error || body.message || msg;
    } catch {
      /* non-JSON error body → keep status message */
    }
    return { ok: false, error: msg };
  } catch (e) {
    return { ok: false, error: e.message || 'Network error' };
  }
}

// ── Event catalog + URL routing ──────────────────────────────────────────────

let _eventCatalog = [];
let _searchCatalog = [];

// Resolve a planner's stored `_eventFile` to a real schedule path in the catalog.
// Older planners saved a flattened name (e.g. "drupalsouth-2026-wellington.json")
// from before schedules were reorganized under events/<series>/…; map those back
// to the nested path so the schedule still loads. Returns the input unchanged when
// it already matches a catalog entry or has no flattened equivalent (used only for
// the schedule fetch — the stored `_eventFile`/plannerKey is left untouched).
function resolveEventFile(eventFile) {
  if (!eventFile || !_eventCatalog.length) return eventFile;
  const files = _eventCatalog.map((e) => e.file);
  if (files.includes(eventFile)) return eventFile;
  const flatten = (f) => f.replace(/^events\//, '').replace(/\//g, '-');
  return files.find((f) => flatten(f) === eventFile) || eventFile;
}

// Builds a search-ready catalog with labels, matching the shape expected by eventSearch.js.
// Tries /api/meta first (one request); falls back to fetching each event file in parallel.
async function buildPlannerSearchCatalog(catalog) {
  function mapMeta(file, meta, enabled) {
    const designation = normalizeString(meta.designation);
    const year = normalizeString(meta.year);
    const location = normalizeString(meta.location);
    const label =
      designation && year && location
        ? `${designation} ${year}: ${location}`
        : [designation, year, location].filter(Boolean).join(' ') || file;
    return {
      file,
      label,
      category: designation || 'Other',
      designation,
      location,
      year,
      region: normalizeString(meta.region),
      venue: normalizeString(meta.venue),
      enabled: enabled !== false,
    };
  }

  function sortByYearDesc(arr) {
    return arr.sort((a, b) => {
      const ya = Number.parseInt(a.year, 10);
      const yb = Number.parseInt(b.year, 10);
      if (Number.isFinite(ya) && Number.isFinite(yb) && ya !== yb) return yb - ya;
      return a.label.localeCompare(b.label);
    });
  }

  try {
    const res = await fetch('./api/meta');
    if (res.ok) {
      const metas = await res.json();
      if (Array.isArray(metas) && metas.length > 0) {
        return sortByYearDesc(
          metas.filter((m) => m?.file).map((m) => mapMeta(m.file, m, m.enabled)),
        );
      }
    }
  } catch {
    /* API not running — fall through */
  }

  const results = await Promise.all(
    catalog.map(async (item) => {
      try {
        const res = await fetch(`./data/${item.file}`);
        if (!res.ok) return null;
        const data = await res.json();
        return mapMeta(item.file, data?.event || {}, item.enabled);
      } catch {
        return null; /* skip a dataset that fails to load */
      }
    }),
  );
  return sortByYearDesc(results.filter(Boolean));
}

// The address bar always describes what you are looking at, so a refresh — or a
// link you send someone — lands in the same place. `plannerRoute.js` decides the
// FORM (path when served, query when opened as files); this only decides when to
// write, and whether it is a navigation or a correction.
// Until boot finishes, every URL write is a REPLACE. Rendering the app is not
// navigating through it, and a stray push during start-up leaves a history entry
// you can go Back to but never reach again — which is exactly what happened:
// Back landed on the sponsor tab of a personal planner.
let _routeReady = false;

function writePlannerUrl(plannerKey, tab, { push = false } = {}) {
  try {
    const href = plannerHref(plannerKey, tab);
    if (href === `${location.pathname}${location.search}`) return;
    const state = { plannerKey, tab };
    if (push && _routeReady) history.pushState(state, '', href);
    else history.replaceState(state, '', href);
  } catch {
    /* history API blocked (e.g. sandboxed) → ignore */
  }
}

function pushPlannerUrl(plannerKey) {
  if (!plannerKey) return;
  writePlannerUrl(plannerKey, parsePlannerRoute(location).tab);
}

// Changing tab is a navigation — it is the thing Back should undo. Loading the
// page is not, so `setActiveTab` is called with `{push:false}` during boot.
function writeTabParam(tab, opts) {
  writePlannerUrl(state.plannerKey, tab, opts);
}

// ── Breadcrumbs ──────────────────────────────────────────────────────────────
// The route, rendered. Same contract as the archive's, so the two sections read
// alike: Home → Planner → this trip → this tab.
// The tab a planner opens on — the first one visible for its mode.
function defaultTabForMode() {
  const mode = state.planner?.mode || 'personal';
  return getVisibleTabsOrdered(mode)[0] || TABS[0];
}

function renderPlannerCrumbs() {
  const nav = document.getElementById('plannerCrumbs');
  if (!nav) return;
  const key = state.plannerKey;
  const trail = plannerCrumbs({
    key,
    name: key ? state.planner?._displayName || plannerDisplayName(state.planner, key) : null,
    tab: state.activeTab,
    // A trip's home IS its default tab, so that tab is not a step of its own in
    // the trail. The default differs by mode, so ask rather than assume.
    tabLabel:
      key && state.activeTab && state.activeTab !== defaultTabForMode()
        ? TAB_LABELS[state.activeTab]
        : null,
  });
  nav.innerHTML = trail
    .map((c, i) =>
      i === trail.length - 1
        ? `<span aria-current="page">${escapeHtml(c.label)}</span>`
        : c.href
          ? `<a href="${escapeHtml(c.href)}">${escapeHtml(c.label)}</a>`
          : `<span>${escapeHtml(c.label)}</span>`,
    )
    .join('<span class="app-crumbs__sep" aria-hidden="true">&rarr;</span>');
}

// ── Theme ────────────────────────────────────────────────────────────────────

function applyTheme() {
  const meta = state.eventMeta || {};
  const themeVal = meta.theme;
  const themeId = typeof themeVal === 'object' ? themeVal?.id : themeVal;
  // Use the schedule viewer's last effective theme as the fallback so the
  // planner always matches the schedule even when the event overrides the
  // user's saved preference without updating localStorage.
  const fallbackId = readText(STORAGE_KEYS.currentThemeId) || getCurrentThemeId();
  const effectiveThemeId = themeId ? normalizeThemeId(themeId) : fallbackId;
  applyThemeClass(effectiveThemeId);
  writeText(STORAGE_KEYS.currentThemeId, effectiveThemeId);
  applyEventColors(
    typeof themeVal === 'object' ? themeVal?.primaryColor : meta.primaryColor,
    typeof themeVal === 'object' ? themeVal?.secondaryColor : meta.secondaryColor,
    typeof themeVal === 'object' ? themeVal?.tertiaryColor : meta.tertiaryColor,
  );
}

// ── Constants ────────────────────────────────────────────────────────────────

// Budget categories — loaded from data/budget.json at init, then overridden per-event
// Budget categories + getEventBudgetCategories/getActiveBudgetCategoryOptions -> plannerBudget.js

function renderListPanel(listId, emptyId, items, cardFn) {
  const list = document.getElementById(listId);
  const empty = document.getElementById(emptyId);
  if (!list) return;
  empty?.classList.toggle('hidden', items.length > 0);
  list.innerHTML = items.map(cardFn).join('');
}

// Upload file to API server or, when no server is configured, encode as a base64
// data URL stored in localStorage via the planner JSON. Files > 1.5 MB are rejected
// in the no-API path to stay within localStorage's ~5 MB quota.
// Turn a human description into a sensible file base name (no extension), e.g.
// "Conference pass (early bird)" → "conference-pass-early-bird". Empty when the
// description has no usable characters, so callers fall back to the original name.
function fileBaseFromName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// destination: 'receipts' (default) | 'documents'
// desiredName: optional human label (e.g. the receipt description) used to rename
// Delete a previously-uploaded file from the server (disk + S3). Best-effort and
// a no-op when there's no API, or when the path is an inline data: URL (which
// lives in the planner JSON, so dropping the reference is the whole deletion).
async function deleteUploadedFile(path) {
  const apiEndpoint = readText(STORAGE_KEYS.editorApiEndpoint) || '';
  if (!apiEndpoint || !path || String(path).startsWith('data:')) return;
  const clean = String(path).replace(/^\.?\//, '');
  if (!clean.startsWith('receipts/') && !clean.startsWith('documents/')) return;
  try {
    await fetch(`${apiEndpoint.replace(/\/$/, '')}/api/${clean}`, { method: 'DELETE' });
  } catch {
    /* best-effort — a failed cleanup must not block deleting the record */
  }
}

// Resolve a stored file path to a viewable absolute URL. Files are served by the
// same server they were uploaded to, so use the same base as uploads (the
// configured API endpoint, else the current origin). Inline (data:/blob:) and
// already-absolute URLs pass through untouched.
function resolveFileUrl(path) {
  if (!path) return '';
  if (/^(data:|blob:|https?:)/i.test(path)) return path;
  const clean = String(path).replace(/^\.?\//, '');
  // Uploads are read through the API — `/api/receipts/…`, `/api/documents/…` —
  // not from the static paths they are stored under. Both are gated at the
  // origin, but only this one keeps working when `/receipts` and `/documents`
  // are blocked outright at the CDN, which is the point: personal files should
  // not be one guard away from the open internet.
  //
  // A hosted app uses its OWN origin, so the preview iframe stays same-origin
  // (X-Frame-Options: SAMEORIGIN) and survives a stale API-endpoint setting.
  // Only a file:// launch, which has no origin server, uses the configured one.
  if (window.location.protocol !== 'file:') return `/api/${clean}`;
  const ep = (readText(STORAGE_KEYS.editorApiEndpoint) || '').replace(/\/$/, '');
  return ep ? `${ep}/api/${clean}` : clean;
}

// the stored file to something sensible instead of the camera/scan filename.
async function uploadOrReadFile(file, destination = 'receipts', desiredName = '') {
  const base = fileBaseFromName(desiredName);
  const ext = (file.name.match(/\.([a-zA-Z0-9]+)$/)?.[1] || '').toLowerCase();
  const label = base ? (ext ? `${base}.${ext}` : base) : file.name;
  const apiEndpoint = readText(STORAGE_KEYS.editorApiEndpoint) || '';
  if (apiEndpoint) {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('eventFile', state.plannerKey);
    if (base) formData.append('fileName', base);
    const res = await fetch(`${apiEndpoint.replace(/\/$/, '')}/api/${destination}`, {
      method: 'POST',
      body: formData,
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    // Label from the server's ACTUAL stored filename, not the client's guess — so the
    // displayed name always matches what's on disk (even if the server sanitised or
    // de-duplicated it differently, e.g. "conference-pass-2.jpg").
    const storedName = String(data.path || '')
      .split('/')
      .pop();
    return { path: data.path, label: storedName || label };
  }
  const MAX_BYTES = 1_500_000;
  if (file.size > MAX_BYTES) {
    throw new Error(
      `File too large to store locally (${(file.size / 1_048_576).toFixed(1)} MB). Connect the API server to upload larger files.`,
    );
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ path: reader.result, label });
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}

// Best-effort per-collection receipt sync (Phase 4). Pushes an individual receipt
// change straight to the v1 CRUD API so it reaches the server between manual "Save to
// file" blob saves (which stay authoritative). Skips when there's no server to reach
// (opened as a static file with no configured endpoint); errors never block the UI.
function syncReceiptToApi(op, receipt) {
  const apiEndpoint = readText(STORAGE_KEYS.editorApiEndpoint) || '';
  if (!apiEndpoint && window.location.protocol === 'file:') return; // offline / static
  if (!state.plannerKey) return;
  saveReceiptViaApi(apiEndpoint, state.plannerKey, op, receipt).catch((err) => {
    // Non-fatal: the authoritative whole-blob save will reconcile on the next manual save.
    console.warn(`[receipts] granular ${op} sync failed: ${err.message}`);
  });
}

function scheduleMetaTitle() {
  const meta = state.eventMeta || {};
  return [meta.location || meta.designation, meta.year].filter(Boolean).join(' ');
}

function syncEventTitleField(inputId, hintId) {
  const el = document.getElementById(inputId);
  const hint = document.getElementById(hintId);
  if (!el) return;
  const metaTitle = scheduleMetaTitle();
  // Only treat as associated when the schedule actually loaded meaningful metadata.
  // state.eventFile can be truthy due to backward-compat even when the file is
  // a planner (not a schedule), in which case eventMeta is empty.
  if (state.eventFile && metaTitle) {
    el.value = metaTitle;
    el.disabled = true;
    hint?.classList.remove('hidden');
  } else {
    el.value =
      state.planner?._displayName || plannerDisplayName(state.planner, state.plannerKey) || '';
    el.disabled = false;
    hint?.classList.add('hidden');
  }
}

// ── Tab system ───────────────────────────────────────────────────────────────

const TABS = [
  'sponsor',
  'team',
  'documents',
  'tasks',
  'checklists',
  'contacts',
  'personal',
  'companions',
  'notes',
  'receipts',
  'tickets',
  'budget',
  'split',
  'map',
  'weather',
  'schedule',
  'itinerary',
  'summary',
  'settings',
];

// Two-letter codes for the COLLAPSED sidebar only.
//
// The planner used a Font Awesome glyph per tab; the icon font is gone with the
// CDN, and nineteen bespoke SVGs would be nineteen things to maintain. Expanded,
// the label identifies the tab and needs no help. Collapsed to the 56px rail
// there is no label at all, and something has to distinguish IT from TI.
const TAB_CODES = {
  sponsor: 'PL',
  team: 'TM',
  personal: 'PL',
  tasks: 'TK',
  checklists: 'CL',
  contacts: 'CT',
  notes: 'NT',
  receipts: 'RC',
  tickets: 'TI',
  companions: 'CP',
  budget: 'BD',
  split: 'SC',
  map: 'MP',
  weather: 'WX',
  schedule: 'CS',
  itinerary: 'IT',
  documents: 'DC',
  summary: 'SM',
  settings: 'ST',
};

const PANEL_IDS = {
  contacts: 'plannerContactsPanel',
  tasks: 'plannerTasksPanel',
  checklists: 'plannerChecklistsPanel',
  sponsor: 'plannerSponsorPanel',
  personal: 'plannerPersonalPanel',
  notes: 'plannerNotesPanel',
  team: 'plannerTeamPanel',
  documents: 'plannerDocumentsPanel',
  receipts: 'plannerReceiptsPanel',
  tickets: 'plannerTicketsPanel',
  companions: 'plannerCompanionsPanel',
  budget: 'plannerBudgetPanel',
  split: 'plannerSplitPanel',
  map: 'plannerMapPanel',
  weather: 'plannerWeatherPanel',
  schedule: 'plannerSchedulePanel',
  itinerary: 'plannerItineraryPanel',
  summary: 'plannerSummaryPanel',
  settings: 'plannerSettingsPanel',
};

const TAB_BTN_IDS = {
  contacts: 'showContactsTab',
  tasks: 'showTasksTab',
  checklists: 'showChecklistsTab',
  sponsor: 'showSponsorTab',
  personal: 'showPersonalTab',
  notes: 'showNotesTab',
  team: 'showTeamTab',
  documents: 'showDocumentsTab',
  receipts: 'showReceiptsTab',
  tickets: 'showTicketsTab',
  companions: 'showCompanionsTab',
  budget: 'showBudgetTab',
  split: 'showSplitTab',
  map: 'showMapTab',
  weather: 'showWeatherTab',
  schedule: 'showScheduleTab',
  itinerary: 'showItineraryTab',
  summary: 'showSummaryTab',
  settings: 'showSettingsTab',
};

// Back and Forward move between tabs, and out to the selection screen. A
// planner CHANGE cannot be done in place — too much module state is keyed to the
// open planner — so that reloads; a tab change is just a render.
function wirePlannerHistory() {
  window.addEventListener('popstate', () => {
    const { key, tab } = parsePlannerRoute(location);
    if ((key || null) !== (state.plannerKey || null)) {
      location.reload();
      return;
    }
    // The default here must be the mode's default tab, not TABS[0] — that is
    // 'sponsor', which a personal planner does not have. Going Back to a
    // no-tab entry was selecting it, finding nothing, and rewriting the entry's
    // URL to a tab you could never reach.
    if (key) setActiveTab(tab || defaultTabForMode(), { push: false });
  });
}

function setActiveTab(tab, { push = true } = {}) {
  const next = TABS.includes(tab) ? tab : TABS[0];
  state.activeTab = next;
  TABS.forEach((t) => {
    document.getElementById(PANEL_IDS[t])?.classList.toggle('hidden', t !== next);
  });
  // Update all tab buttons (main bar + Settings + overflow dropdown) via data-tab
  document.querySelectorAll('[data-tab]').forEach((btn) => {
    const active = btn.dataset.tab === next;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  writeTabParam(next, { push });
  renderPlannerCrumbs();
  renderMobileTabNav();
}

// ── Contacts tab ─────────────────────────────────────────────────────────────
// Extracted to ./modules/plannerContacts.js (initContacts / renderContactsTab /
// wireContactsPanel).

// ── Tasks tab ────────────────────────────────────────────────────────────────

// ── Org tab + trip-render helpers ─────────────────────────────────────────────
// Extracted to ./modules/plannerOrg.js (initOrg + renderOrgTab, leg/assignment/
// accommodation/waypoint/timeline render helpers).

// Shared travel/leg primitives (TRAVEL_MODES, sortLegs, travelIcon, etc.) +
// TIMELINE_COLORS extracted to ./modules/plannerTravel.js.

// ── Assignment modal ──────────────────────────────────────────────────────────

function openAssignmentModal(memberId) {
  const modal = document.getElementById('assignmentModal');
  const member = state.global?.teamMembers.find((m) => m.id === memberId);
  if (!modal || !member) return;

  const assignment = (state.planner.org.teamAssignments || []).find((a) => a.memberId === memberId);
  if (!assignment) return;

  // One-time migration from flat flightOut/flightReturn → legs arrays
  if (assignment.flightOut !== undefined || assignment.flightReturn !== undefined) {
    if (!assignment.outboundLegs) {
      assignment.outboundLegs = assignment.flightOut?.date
        ? [
            {
              ...makeLeg(),
              date: assignment.flightOut.date,
              ref: assignment.flightOut.flightNo || '',
              from: assignment.flightOut.from || '',
              to: assignment.flightOut.to || '',
              confirmation: assignment.flightOut.confirmation || '',
            },
          ]
        : [];
    }
    if (!assignment.returnLegs) {
      assignment.returnLegs = assignment.flightReturn?.date
        ? [
            {
              ...makeLeg(),
              date: assignment.flightReturn.date,
              ref: assignment.flightReturn.flightNo || '',
              from: assignment.flightReturn.from || '',
              to: assignment.flightReturn.to || '',
              confirmation: assignment.flightReturn.confirmation || '',
            },
          ]
        : [];
    }
    delete assignment.flightOut;
    delete assignment.flightReturn;
    scheduleAutoSave();
  }

  // Ensure arrays exist
  assignment.outboundLegs = assignment.outboundLegs || [];
  assignment.returnLegs = assignment.returnLegs || [];

  modal.dataset.ctx = 'org';
  modal.dataset.memberId = memberId;
  document.getElementById('assignmentModalSubtitle').textContent =
    `${member.name || 'Unnamed'}${member.role ? ` · ${member.role}` : ''}`;

  renderAssignmentLegsInModal(assignment);
  _hideAssignmentModalImportButtons();

  // Org team-assignment cost lives on the linked receipt — the cost inputs are for
  // personal/companion assignments only, so they stay blank/hidden here.
  document.getElementById('assignmentNotes').value = assignment.notes || '';

  renderAssignmentReceiptStatus();
  showModal('assignmentModal');
  if (!touchDevice()) modal.querySelector('input, select')?.focus();
}

// Resolve the team assignment the assignment modal is currently editing (org ctx).
// Only org team assignments carry receipt-backed travel cost in the budget summary;
// personal companion assignments are informational (not in plannerSummary).
function _currentTeamAssignment() {
  const modal = document.getElementById('assignmentModal');
  const ctx = modal?.dataset.ctx || 'org';
  if (ctx !== 'org') return null;
  const memberId = modal?.dataset.memberId;
  return (state.planner.org?.teamAssignments || []).find((a) => a.memberId === memberId) || null;
}

// Toggle the assignment modal's cost vs receipt sections by context. Org team
// assignments move cost to a linked receipt (Receipt section shown, cost inputs
// hidden); personal / local-companion assignments aren't receipt-backed, so they
// keep their own cost inputs (cost shown, Receipt hidden).
function renderAssignmentReceiptStatus() {
  const section = document.getElementById('assignmentReceiptSection');
  const costSection = document.getElementById('assignmentCostSection');
  const assignment = _currentTeamAssignment(); // non-null only for org ctx
  if (section) section.classList.toggle('hidden', !assignment);
  if (costSection) costSection.classList.toggle('hidden', !!assignment);
  if (!assignment) return;
  renderEntityReceiptStatus(document.getElementById('assignmentReceiptStatus'), {
    receipt: linkedReceipt(state.planner, assignment),
    idPrefix: 'assignment',
    canLink: true,
  });
}

// Create a receipt for the team assignment and open it so cost/details are entered
// on the receipt (the single home for money). Closes the modal to avoid stacking.
function createReceiptForAssignment() {
  const assignment = _currentTeamAssignment();
  if (!assignment) return;
  const member = state.global?.teamMembers?.find((m) => m.id === assignment.memberId);
  const receipt = createReceiptForEntity(state.planner, assignment, {
    name: member?.name ? `${member.name} — travel` : 'Team travel',
    currency: state.planner?.org?.sponsorCurrency || 'AUD',
    category: 'travel',
  });
  scheduleAutoSave();
  renderReceiptsTab();
  hideModal('assignmentModal');
  document.getElementById('assignmentModal').dataset.ctx = '';
  renderOrgTab();
  openReceiptModal(receipt.id);
}

// ── Accommodation modal ───────────────────────────────────────────────────────
// Extracted to ./modules/plannerAccommodation.js (initAccommodation +
// openAccommodationModal, checklistItemHtml, swagCardHtml, member/stay sections).

// renderOrgTab is defined above in the Org tab section

// ── Itinerary tab ────────────────────────────────────────────────────────────
// Extracted to ./modules/plannerItinerary.js (initItinerary / renderItineraryTab /
// wireItineraryPanel / renderOrgItinerary / openOrgEventModal / personalAssigneeChips).

// ── Receipts tab ─────────────────────────────────────────────────────────────
// Extracted to ./modules/plannerReceipts.js (initReceipts / makeReceipt /
// renderReceiptsTab / wireReceiptsPanel).
// ── Summary tab ───────────────────────────────────────────────────────────────

// Summary renders (buildEventBudgetData/buildPersonalBudgetData/renderSummaryTab/
// renderSummaryThisEvent/renderSummaryAllEvents + drilldowns) extracted to
// ./modules/plannerSummary.js.

// ── Create Planner modal ──────────────────────────────────────────────────────
// Extracted to ./modules/plannerCreate.js (initCreatePlanner /
// openCreatePlannerModal / wireCreatePlannerModal).

// ── Load available event options (for create/edit modals on dashboard) ────────
async function _loadEventOptions() {
  try {
    const res = await fetch('./api/meta');
    if (res.ok) {
      const metas = await res.json();
      return metas
        .filter((m) => m.file)
        .map((m) => ({
          file: m.file,
          label: [m.designation, m.location, m.year].filter(Boolean).join(' '),
        }))
        .sort((a, b) => b.label.localeCompare(a.label)); // newest first
    }
  } catch {
    /* offline */
  }
  return _searchCatalog
    .filter((m) => m.file)
    .map((m) => ({ file: m.file, label: m.label }))
    .sort((a, b) => b.label.localeCompare(a.label));
}

// ── Trip card cog dropdown (dashboard) ────────────────────────────────────────
// Extracted to ./modules/plannerCogMenu.js (initCogMenu / wireTripCogMenu).

// ── Dashboard planner edit modal ──────────────────────────────────────────────
// Extracted to ./modules/plannerDashEdit.js (initDashEdit /
// openDashboardPlannerEdit / wireDashboardPlannerEditModal).

// ── Timeline card hover interaction ──────────────────────────────────────────
let _timelineHoverWired = false;
function wireTimelineHover() {
  if (_timelineHoverWired) return;
  _timelineHoverWired = true;
  const container = document.getElementById('plannerNoEvent');
  if (!container) return;
  container.addEventListener(
    'mouseenter',
    (e) => {
      const wrap = e.target.closest('.trip-card-wrap');
      if (!wrap) return;
      const slug = wrap.querySelector('.trip-card-cog')?.dataset.slug;
      if (!slug) return;
      container
        .querySelectorAll(`.trip-tl-bar[data-slug="${CSS.escape(slug)}"]`)
        .forEach((bar) => bar.classList.add('is-active'));
    },
    true,
  );
  container.addEventListener(
    'mouseleave',
    (e) => {
      const wrap = e.target.closest('.trip-card-wrap');
      if (!wrap) return;
      container
        .querySelectorAll('.trip-tl-bar.is-active')
        .forEach((bar) => bar.classList.remove('is-active'));
    },
    true,
  );
}

// ── Global settings modal (dashboard) ────────────────────────────────────────
// Extracted to ./modules/plannerGlobalSettings.js (initGlobalSettings /
// wireGlobalSettingsModal).

function wireManageEventBtn() {
  document.addEventListener('click', (e) => {
    // Detach a single event via the × on its path-chip / settings row (delegated).
    const remove = e.target.closest('[data-remove-event]');
    if (remove) {
      removeEventFromPlanner(remove.dataset.removeEvent);
      return;
    }
    // "Add conference" in the Settings pane opens the event search (its onSelect
    // appends the chosen event to this planner — see configureEventSearch below).
    if (e.target.closest('#settingsAddConferenceBtn')) openEventSearchModal();
  });
}

// (summary panel wiring + drilldown modals moved to plannerSummary.js)

// ── Export / Import ──────────────────────────────────────────────────────────
// Extracted to ./modules/plannerImportExport.js.

// ── Tracked Sessions ─────────────────────────────────────────────────────────
// Extracted to ./modules/plannerTrackedSessions.js (initTrackedSessions /
// renderTrackedSessions / syncSponsoredSessions / wireTrackedSessionModal /
// wireTrackedSessionSearch).

// ── Personal tab ───────────────────────────────────────────────────────────
// Extracted to ./modules/plannerPersonal.js (initPersonal + renderPersonalTab,
// personal timeline/accom/notes + budget-breakdown renders).

// ── Shared modal lifecycle helper ────────────────────────────────────────────

function createModal(modalId, { onSave, onDone, onDelete, onClose } = {}) {
  const getEl = () => document.getElementById(modalId);
  const isOpen = () => !getEl()?.classList.contains('hidden');

  function open(focusId) {
    const modal = getEl();
    if (!modal) return;
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = 'hidden';
    document.body.style.paddingRight = scrollbarWidth ? `${scrollbarWidth}px` : '';
    modal.classList.remove('hidden');
    if (!touchDevice())
      (focusId
        ? document.getElementById(focusId)
        : modal.querySelector('input:not([type=hidden]),select,textarea')
      )?.focus();
  }

  function close() {
    const modal = getEl();
    if (!modal) return;
    modal.classList.add('hidden');
    document.body.style.overflow = '';
    document.body.style.paddingRight = '';
    onClose?.();
  }

  function wire() {
    const modal = getEl();
    if (!modal) return;
    document.getElementById(`${modalId}Close`)?.addEventListener('click', close);
    document.getElementById(`${modalId}Done`)?.addEventListener('click', () => {
      onDone?.();
      close();
    });
    if (onDelete) {
      document.getElementById(`${modalId}Delete`)?.addEventListener('click', () => {
        onDelete();
        close();
      });
    }
    if (onSave) {
      modal.addEventListener('input', onSave);
      modal.addEventListener('change', onSave);
    }
    modal.addEventListener('click', (e) => {
      if (e.target === modal) close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isOpen()) close();
    });
  }

  return { open, close, wire };
}

// ── Personal leg modal ───────────────────────────────────────────────────────
// Extracted to ./modules/plannerPersonalLeg.js (initPersonalLeg /
// openPersonalLegModal / wirePersonalLegModal).

// ── Budget Items ─────────────────────────────────────────────────────────────

// ── Budget Items -> extracted to ./modules/plannerBudget.js

// ── Swag modal ────────────────────────────────────────────────────────────────

let _swagId = null;

// The swag modal's static fields, resolved once (see personalAccomEls).
let _swagEls = null;
function swagEls() {
  return (_swagEls ??= {
    name: document.getElementById('swagModalName'),
    quantity: document.getElementById('swagModalQuantity'),
    returned: document.getElementById('swagModalReturned'),
    notes: document.getElementById('swagModalNotes'),
    doneCheck: document.getElementById('swagModalDoneCheck'),
  });
}

function saveSwag() {
  if (!_swagId) return;
  const item = (state.planner.org.swag || []).find((x) => x.id === _swagId);
  if (!item) return;
  const m = swagEls();
  item.name = m.name?.value || '';
  item.quantity = parseInt(m.quantity?.value, 10) || 1;
  const retVal = m.returned?.value;
  item.returned = retVal !== '' && retVal != null ? parseInt(retVal, 10) : null;
  item.notes = m.notes?.value || '';
  item.done = m.doneCheck?.checked ?? false;
  scheduleAutoSave();
}

const _swagModal = createModal('swagModal', {
  onSave: saveSwag,
  onDelete: () => {
    state.planner.org.swag = (state.planner.org.swag || []).filter((x) => x.id !== _swagId);
    scheduleAutoSave();
  },
  onClose: () => {
    _swagId = null;
    renderOrgTab();
    renderSponsorBudgetBreakdown();
  },
});

function openSwagModal(id) {
  const item = (state.planner.org.swag || []).find((x) => x.id === id);
  if (!item) return;
  _swagId = item.id;
  const m = swagEls();
  m.name.value = item.name || '';
  m.quantity.value = item.quantity ?? 1;
  m.returned.value = item.returned != null ? item.returned : '';
  m.notes.value = item.notes || '';
  m.doneCheck.checked = !!item.done;
  renderSwagReceiptStatus(item);
  _swagModal.open('swagModalName');
}

// The Receipt block in the swag modal — swag actual spend moves to a linked receipt
// (see buildEventBudgetData). Swag items always exist before the modal opens, so
// linking is always available (no unsaved-hint needed).
function renderSwagReceiptStatus(item) {
  renderEntityReceiptStatus(document.getElementById('swagReceiptStatus'), {
    receipt: linkedReceipt(state.planner, item),
    idPrefix: 'swag',
    canLink: !!item,
  });
}

// Create a receipt for the swag item and open it so cost/details are entered on the
// receipt (the single home for money). Closes the swag modal to avoid stacking.
function createReceiptForSwag() {
  const item = (state.planner.org?.swag || []).find((x) => x.id === _swagId);
  if (!item) return;
  const m = swagEls();
  const receipt = createReceiptForEntity(state.planner, item, {
    name: m.name?.value.trim() || item.name || 'Swag',
    currency: state.planner?.org?.sponsorCurrency || 'AUD',
    category: 'swag',
  });
  scheduleAutoSave();
  renderReceiptsTab();
  _swagModal.close();
  openReceiptModal(receipt.id);
}

function wireSwagModal() {
  _swagModal.wire();
  const modal = document.getElementById('swagModal');
  modal?.addEventListener('click', (e) => {
    if (e.target.closest('#swagCreateReceiptBtn')) {
      createReceiptForSwag();
      return;
    }
    if (e.target.closest('#swagViewReceiptBtn')) {
      const item = (state.planner.org?.swag || []).find((x) => x.id === _swagId);
      _swagModal.close();
      setActiveTab('receipts');
      setTimeout(() => {
        const el = item?.receiptId
          ? document.querySelector(`details[data-receipt-id="${item.receiptId}"]`)
          : null;
        el?.setAttribute('open', '');
        el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 50);
      return;
    }
    if (e.target.closest('#swagUnlinkReceiptBtn')) {
      const item = (state.planner.org?.swag || []).find((x) => x.id === _swagId);
      if (item) {
        unlinkEntityReceipt(item);
        scheduleAutoSave();
        renderSwagReceiptStatus(item);
      }
    }
  });
}

// ── Trip note modal ──────────────────────────────────────────────────────────

let _noteId = null;

function saveNote() {
  if (!_noteId) return;
  const note = (state.planner.personal?.noteList || []).find((n) => n.id === _noteId);
  if (!note) return;
  note.title = document.getElementById('noteModalTitle')?.value || '';
  note.body = document.getElementById('noteModalBody')?.value || '';
  scheduleAutoSave();
}

const _noteModal = createModal('noteModal', {
  onSave: saveNote,
  onDelete: () => {
    state.planner.personal.noteList = (state.planner.personal?.noteList || []).filter(
      (n) => n.id !== _noteId,
    );
    scheduleAutoSave();
  },
  onClose: () => {
    // Drop a note that was added but left completely empty.
    const list = state.planner.personal?.noteList;
    if (_noteId && list) {
      const n = list.find((x) => x.id === _noteId);
      if (n && !(n.title || '').trim() && !(n.body || '').trim() && !n.emoji) {
        state.planner.personal.noteList = list.filter((x) => x.id !== _noteId);
        scheduleAutoSave();
      }
    }
    _noteId = null;
    renderPersonalNotes();
  },
});

// A broad curated emoji set for quick insertion into notes (no dependency), grouped
// loosely by category so related glyphs cluster in the scrollable picker.
// prettier-ignore
const NOTE_EMOJIS = [
  // Smileys & emotion
  '😀','😃','😄','😁','😆','😅','😂','🤣','🥲','😊','😇','🙂','🙃','😉','😌','😍',
  '🥰','😘','😋','😜','🤪','😝','🤗','🤭','🤫','🤔','😐','😑','😶','😏','😒','🙄',
  '😬','😴','😪','🥱','🤯','😳','🥺','😢','😭','😤','😠','😡','🤬','😱','😨','😰',
  '😥','😓','🥳','🤩','😎','🤠','🥵','🥶','😷','🤒','🤢','🤮','🤧','🤑','🤐',
  '😈','👻','💀','☠️','👽','🤖','🎃','💩','🤡',
  // Gestures & people
  '👍','👎','👊','✊','🤛','🤜','👌','🤏','✌️','🤞','🤟','🤘','🤙','👈','👉','👆',
  '👇','☝️','✋','🤚','🖐️','🖖','👋','🤝','🙏','💪','🙌','👏','🤲','✍️',
  // Hearts & marks
  '❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖',
  '💘','💝','💯','✅','❌','⭕','❗','❓','‼️','⚠️','🚫','💤','⭐','🌟','✨','⚡',
  '🔥','💥','💫','🎉','🎊','🎈','🎁','🏆','🥇','🥈','🥉','🎯','🔔','📢','💬','💭',
  // Objects & work
  '📝','📋','📌','📍','📎','🔖','📅','📆','⏰','⏳','⌛','🔑','🔒','🔓','🔍','💡',
  '💰','💵','💳','💎','📱','💻','🖥️','⌨️','📷','🎥','🎧','🎵','🎶','🔦','🕯️','🔋',
  '🧭','🗺️','📖','📚','🩺','💊','🧾','✂️','📐','🖊️','🖍️','🧩','🎮','🧸','🎫','🧳',
  // Travel & places
  '✈️','🛫','🚀','🚁','⛵','🚢','🚆','🚄','🚌','🚕','🚗','🚙','🚲','🛵','🏍️','🚏',
  '⛽','🚦','🏨','🏠','🏰','🗼','🗽','🗿','🏖️','🏝️','🏜️','⛰️','🏔️','🌋','🏕️','⛺',
  // Nature & weather
  '☀️','🌤️','⛅','🌥️','☁️','🌧️','⛈️','🌩️','🌨️','❄️','☃️','⛄','🌬️','🌈','🌊','💧',
  '🌍','🌎','🌏','🌙','🌸','🌺','🌻','🌹','🌷','🌼','🌱','🌲','🌳','🌴','🌵','🍀',
  '🍁','🍂','🍄','🐶','🐱','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐵','🐧','🦋','🐝',
  // Food & drink
  '🍎','🍊','🍋','🍌','🍉','🍇','🍓','🍒','🍑','🥭','🍍','🥝','🍅','🥑','🌽','🥕',
  '🍞','🧀','🥚','🍳','🥞','🥓','🍔','🍟','🍕','🌭','🥪','🌮','🌯','🥗','🍝','🍜',
  '🍲','🍣','🍱','🍤','🍙','🍚','🍢','🍧','🍨','🍦','🍰','🎂','🧁','🍩','🍪','🍫',
  '🍬','🍭','🍿','☕','🍵','🥤','🍺','🍻','🥂','🍷','🥃','🍸','🍹','🍾','🍽️',
  // Flags — special + a broad spread of country flags
  '🏁','🚩','🏳️','🏴','🏳️‍🌈','🏴‍☠️',
  '🇦🇺','🇳🇿','🇺🇸','🇬🇧','🇨🇦','🇮🇪','🇳🇱','🇩🇪','🇫🇷','🇪🇸','🇵🇹','🇮🇹','🇧🇪','🇦🇹','🇨🇭','🇱🇺',
  '🇸🇪','🇳🇴','🇩🇰','🇫🇮','🇮🇸','🇵🇱','🇨🇿','🇸🇰','🇭🇺','🇷🇴','🇧🇬','🇬🇷','🇭🇷','🇸🇮','🇷🇸','🇺🇦',
  '🇪🇪','🇱🇻','🇱🇹','🇹🇷','🇷🇺','🇯🇵','🇰🇷','🇨🇳','🇭🇰','🇹🇼','🇮🇳','🇸🇬','🇲🇾','🇹🇭','🇮🇩','🇵🇭',
  '🇻🇳','🇦🇪','🇸🇦','🇮🇱','🇿🇦','🇪🇬','🇰🇪','🇳🇬','🇧🇷','🇦🇷','🇨🇱','🇨🇴','🇵🇪','🇲🇽','🇪🇺',
];

// Wire the note emoji picker once: toggles a popover and inserts the chosen emoji at
// the caret in the note body. Optional — the body is plain typing otherwise.
// Build + wire an emoji popover: a toggle button and a grid; `onPick(emoji)` fires on
// selection (empty string when the leading "default" cell is chosen). `prepend`
// injects extra leading cells. Shared by the body-insert picker and the note-icon one.
function attachEmojiPicker(btn, picker, onPick, { prepend = '' } = {}) {
  if (!btn || !picker) return;
  if (!picker.dataset.built) {
    picker.innerHTML =
      prepend +
      NOTE_EMOJIS.map(
        (e) => `<button type="button" class="note-emoji" tabindex="-1">${e}</button>`,
      ).join('');
    picker.dataset.built = '1';
  }
  const setOpen = (open) => {
    picker.classList.toggle('hidden', !open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(picker.classList.contains('hidden'));
  });
  picker.addEventListener('click', (e) => {
    const cell = e.target.closest('.note-emoji');
    if (!cell) return;
    onPick(cell.dataset.clear ? '' : cell.textContent);
    setOpen(false);
  });
  document.addEventListener('click', (e) => {
    if (
      !picker.classList.contains('hidden') &&
      !picker.contains(e.target) &&
      !btn.contains(e.target)
    ) {
      setOpen(false);
    }
  });
}

// Reflect a note's icon emoji on the modal button (default sticky icon when empty).
function updateNoteIconBtn(emoji) {
  const btn = document.getElementById('noteIconBtn');
  if (btn)
    btn.innerHTML = emoji
      ? `<span class="note-icon-emoji">${emoji}</span>`
      : '<span class="note-icon-emoji note-icon-emoji--none">＋</span>';
}

// Set (or clear) the current note's icon emoji and persist.
function setNoteEmoji(emoji) {
  const note = (state.planner.personal?.noteList || []).find((n) => n.id === _noteId);
  if (!note) return;
  note.emoji = emoji || '';
  updateNoteIconBtn(note.emoji);
  scheduleAutoSave();
}

function wireNoteEmojiPicker() {
  const body = document.getElementById('noteModalBody');
  // Body picker — inserts the emoji at the caret in the note body.
  attachEmojiPicker(
    document.getElementById('noteEmojiBtn'),
    document.getElementById('noteEmojiPicker'),
    (emoji) => {
      if (!body) return;
      const start = body.selectionStart ?? body.value.length;
      const end = body.selectionEnd ?? body.value.length;
      body.value = body.value.slice(0, start) + emoji + body.value.slice(end);
      const pos = start + emoji.length;
      body.focus();
      body.setSelectionRange(pos, pos);
      body.dispatchEvent(new Event('input', { bubbles: true })); // trigger the modal auto-save
    },
  );
  // Icon picker — sets the note's own icon; the leading cell resets to the default.
  attachEmojiPicker(
    document.getElementById('noteIconBtn'),
    document.getElementById('noteIconPicker'),
    (emoji) => setNoteEmoji(emoji),
    {
      prepend:
        '<button type="button" class="note-emoji note-emoji-default" data-clear="1" title="No icon" tabindex="-1">&times;</button>',
    },
  );
}

function openNoteModal(id) {
  const note = (state.planner.personal?.noteList || []).find((n) => n.id === id);
  if (!note) return;
  _noteId = id;
  document.getElementById('noteModalTitle').value = note.title || '';
  document.getElementById('noteModalBody').value = note.body || '';
  updateNoteIconBtn(note.emoji || '');
  document.getElementById('noteEmojiPicker')?.classList.add('hidden');
  document.getElementById('noteIconPicker')?.classList.add('hidden');
  document.getElementById('noteEmojiBtn')?.setAttribute('aria-expanded', 'false');
  document.getElementById('noteIconBtn')?.setAttribute('aria-expanded', 'false');
  _noteModal.open('noteModalTitle');
}

function wireNoteModal() {
  _noteModal.wire();
}

// ── Personal accommodation modal ─────────────────────────────────────────────

let _personalAccomId = null;

// The personal-accommodation modal's static fields, resolved once (the markup is
// fixed in planner.html). One cached map documents the modal's DOM contract and
// replaces ~20 getElementById reads across open/save.
let _personalAccomEls = null;
function personalAccomEls() {
  return (_personalAccomEls ??= {
    type: document.getElementById('personalAccomModalType'),
    name: document.getElementById('personalAccomModalName'),
    address: document.getElementById('personalAccomModalAddress'),
    coords: document.getElementById('personalAccomModalCoords'),
    confirmation: document.getElementById('personalAccomModalConfirmation'),
    status: document.getElementById('personalAccomModalStatus'),
    checkIn: document.getElementById('personalAccomModalCheckIn'),
    checkOut: document.getElementById('personalAccomModalCheckOut'),
    notes: document.getElementById('personalAccomModalNotes'),
  });
}

function savePersonalAccom() {
  if (!_personalAccomId) return;
  const accom = (state.planner.personal?.accommodations || []).find(
    (a) => a.id === _personalAccomId,
  );
  if (!accom) return;
  const m = personalAccomEls();
  accom.type = m.type?.value || 'accommodation';
  accom.name = m.name?.value || '';
  accom.address = m.address?.value || '';
  accom.coords = m.coords?.value || '';
  accom.confirmation = m.confirmation?.value || '';
  accom.status = m.status?.value || '';
  accom.checkIn = accom.type === 'waypoints' ? m.checkIn?.value || '' : '';
  accom.checkOut = accom.type === 'waypoints' ? m.checkOut?.value || '' : '';
  accom.notes = m.notes?.value || '';
  scheduleAutoSave();
  renderPersonalTimeline();
  renderPersonalBudgetBreakdown();
}

const _personalAccomModal = createModal('personalAccomModal', {
  onSave: savePersonalAccom,
  onDelete: () => {
    const personal = state.planner.personal;
    personal.accommodations = (personal.accommodations || []).filter(
      (a) => a.id !== _personalAccomId,
    );
    scheduleAutoSave();
  },
  onClose: () => {
    _personalAccomId = null;
    renderPersonalAccomList();
    renderPersonalTimeline();
    renderPersonalBudgetBreakdown();
  },
});

function _syncPersonalAccomModalType(type) {
  const iconEl = document.getElementById('personalAccomModalTitleIcon');
  const textEl = document.getElementById('personalAccomModalTitleText');
  const isWaypoints = type === 'waypoints';
  if (iconEl) iconEl.className = `${accomTypeIcon(type)} mr-2 pl-ink-2 text-sm`;
  if (textEl) textEl.textContent = isWaypoints ? 'Waypoint' : 'Accommodation';
  toggleWaypointStopsSection(isWaypoints, 'personalAccomWaypointStopsSection');
  document.getElementById('personalAccomModalCheckInRow')?.classList.toggle('hidden', !isWaypoints);
  document
    .getElementById('personalAccomModalCheckOutRow')
    ?.classList.toggle('hidden', !isWaypoints);
  document
    .getElementById('personalAccomCompanionCheckInRow')
    ?.classList.toggle('hidden', isWaypoints);
  document
    .getElementById('personalAccomCompanionCheckOutRow')
    ?.classList.toggle('hidden', isWaypoints);
}

function openPersonalAccomModal(id, { selectMe = false } = {}) {
  const accom = (state.planner.personal?.accommodations || []).find((a) => a.id === id);
  if (!accom) return;
  _personalAccomId = id;
  const m = personalAccomEls();
  if (m.type) m.type.value = accom.type || 'accommodation';
  _syncPersonalAccomModalType(accom.type || 'accommodation');
  renderWaypointStops(
    accom.stops,
    'personalAccomWaypointStopsList',
    'personalAccomWaypointStopsEmpty',
  );
  m.name.value = accom.name || '';
  m.address.value = accom.address || '';
  if (m.coords) m.coords.value = accom.coords || '';
  m.confirmation.value = accom.confirmation || '';
  if (m.status) m.status.innerHTML = buildSelectOptions(TRAVEL_STATUSES, accom.status || '');
  m.checkIn.value = accom.checkIn || '';
  m.checkOut.value = accom.checkOut || '';
  m.notes.value = accom.notes || '';
  renderPersonalAccomReceiptStatus(accom);
  renderPersonalAccomMembersSection(accom);
  // Pre-select the "Me" stay so seeded gap dates are visible/editable on open.
  if (selectMe && (accom.assignments || []).some((s) => s.memberId === '__me__')) {
    const sel = document.getElementById('personalAccomCompanionSelect');
    if (sel) {
      sel.value = '__me__';
      loadPersonalCompanionStayFields(accom, '__me__');
    }
  }
  _personalAccomModal.open('personalAccomModalName');
}

// The Receipt block in the personal-accommodation modal — the accommodation-level
// cost moves to a linked receipt (see buildPersonalBudgetData). Per-companion stay
// costs are handled by their own stay receipts (migrated automatically).
function renderPersonalAccomReceiptStatus(accom) {
  renderEntityReceiptStatus(document.getElementById('personalAccomReceiptStatus'), {
    receipt: linkedReceipt(state.planner, accom),
    idPrefix: 'personalAccom',
    canLink: !!accom,
    showLink: true, // a stay's booking/confirmation lives on its linked receipt
  });
}

// Create a receipt for the accommodation and open it so cost/details are entered on
// the receipt (the single home for money). Closes the modal to avoid stacking.
function createReceiptForPersonalAccom() {
  const accom = (state.planner.personal?.accommodations || []).find(
    (a) => a.id === _personalAccomId,
  );
  if (!accom) return;
  const m = personalAccomEls();
  const receipt = createReceiptForEntity(state.planner, accom, {
    name: m.name?.value.trim() || accom.name || 'Accommodation',
    currency: state.planner?.personal?.currency || 'AUD',
    category: 'accommodation',
  });
  scheduleAutoSave();
  renderReceiptsTab();
  _personalAccomModal.close();
  openReceiptModal(receipt.id);
}

// The accommodation-level receipt link (booking confirmation lives on the receipt).
function renderOrgAccomReceiptStatus(accom) {
  renderEntityReceiptStatus(document.getElementById('accomDocStatus'), {
    receipt: linkedReceipt(state.planner, accom),
    idPrefix: 'orgAccom',
    canLink: !!accom,
    showLink: true,
  });
}
function createReceiptForOrgAccom() {
  const acc = _currentOrgAccom();
  if (!acc) return;
  const receipt = createReceiptForEntity(state.planner, acc, {
    name: acc.name || 'Accommodation',
    currency: state.planner?.org?.sponsorCurrency || 'AUD',
    category: 'accommodation',
  });
  scheduleAutoSave();
  renderReceiptsTab();
  hideModal('accommodationModal');
  openReceiptModal(receipt.id);
}

// The current org accommodation the accommodation modal is editing.
function _currentOrgAccom() {
  const modal = document.getElementById('accommodationModal');
  return (
    (state.planner.org?.accommodations || []).find((a) => a.id === modal?.dataset.accomId) || null
  );
}

// The org accommodation stay for the member currently selected in the modal.
function _currentAccomStay() {
  const acc = _currentOrgAccom();
  const memberId = document.getElementById('accomMemberSelect')?.value;
  if (!acc || !memberId) return null;
  return (acc.assignments || []).find((s) => s.memberId === memberId) || null;
}

// The Receipt block for the selected member's stay — each org accommodation stay's
// cost moves to its own linked receipt (see buildEventBudgetData accom stays).
function renderAccomStayReceiptStatus(acc, memberId) {
  const stay = (acc?.assignments || []).find((s) => s.memberId === memberId) || null;
  renderEntityReceiptStatus(document.getElementById('accomMemberReceiptStatus'), {
    receipt: linkedReceipt(state.planner, stay),
    idPrefix: 'accomMember',
    canLink: !!stay,
    showLink: true,
  });
}

// Create a receipt for the selected stay and open it so cost/details are entered on
// the receipt (the single home for money). Closes the modal to avoid stacking.
function createReceiptForAccomStay() {
  const acc = _currentOrgAccom();
  const stay = _currentAccomStay();
  if (!acc || !stay) return;
  const member = state.global?.teamMembers?.find((m) => m.id === stay.memberId);
  const who = member?.name ? ` — ${member.name}` : '';
  const receipt = createReceiptForEntity(state.planner, stay, {
    name: `${acc.name || 'Accommodation'}${who}`,
    currency: state.planner?.org?.sponsorCurrency || 'AUD',
    category: 'accommodation',
  });
  scheduleAutoSave();
  renderReceiptsTab();
  hideModal('accommodationModal');
  renderOrgTab();
  openReceiptModal(receipt.id);
}

function wirePersonalAccomModal() {
  _personalAccomModal.wire();

  const modal = document.getElementById('personalAccomModal');
  if (!modal) return;

  modal.addEventListener('click', (e) => {
    if (e.target.closest('#personalAccomLinkReceiptBtn')) {
      const accom = (state.planner.personal?.accommodations || []).find(
        (a) => a.id === _personalAccomId,
      );
      if (!accom) return;
      openReceiptPicker(state.planner, {
        onPick: (rid) => {
          linkEntityReceipt(accom, rid);
          scheduleAutoSave();
          renderPersonalAccomReceiptStatus(accom);
          renderReceiptsTab();
        },
        onCreate: () => createReceiptForPersonalAccom(),
      });
      return;
    }
    if (e.target.closest('#personalAccomCreateReceiptBtn')) {
      createReceiptForPersonalAccom();
      return;
    }
    if (e.target.closest('#personalAccomViewReceiptBtn')) {
      const accom = (state.planner.personal?.accommodations || []).find(
        (a) => a.id === _personalAccomId,
      );
      _personalAccomModal.close();
      setActiveTab('receipts');
      setTimeout(() => {
        const el = accom?.receiptId
          ? document.querySelector(`details[data-receipt-id="${accom.receiptId}"]`)
          : null;
        el?.setAttribute('open', '');
        el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 50);
      return;
    }
    if (e.target.closest('#personalAccomUnlinkReceiptBtn')) {
      const accom = (state.planner.personal?.accommodations || []).find(
        (a) => a.id === _personalAccomId,
      );
      if (accom) {
        unlinkEntityReceipt(accom);
        scheduleAutoSave();
        renderPersonalAccomReceiptStatus(accom);
      }
      return;
    }
    if (e.target.closest('#personalAccomRemoveCompanionBtn')) {
      const accom = (state.planner.personal?.accommodations || []).find(
        (a) => a.id === _personalAccomId,
      );
      if (!accom) return;
      const select = document.getElementById('personalAccomCompanionSelect');
      const contactId = select?.value;
      if (!contactId) return;
      accom.assignments = (accom.assignments || []).filter((s) => s.memberId !== contactId);
      const opt = select.querySelector(`option[value="${CSS.escape(contactId)}"]`);
      if (opt) opt.textContent = opt.textContent.replace(' ✓', '');
      [
        'personalAccomCompanionCheckIn',
        'personalAccomCompanionCheckOut',
        'personalAccomCompanionBudget',
        'personalAccomCompanionActual',
      ].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });
      const currEl = document.getElementById('personalAccomCompanionCurrency');
      if (currEl) currEl.innerHTML = currencyOptions('AUD');
      const removeBtn = document.getElementById('personalAccomRemoveCompanionBtn');
      if (removeBtn) removeBtn.classList.add('opacity-0', 'pointer-events-none');
      scheduleAutoSave();
    }
  });

  const COMPANION_FIELD_MAP = {
    personalAccomCompanionCheckIn: 'checkIn',
    personalAccomCompanionCheckOut: 'checkOut',
    personalAccomCompanionCurrency: 'currency',
    personalAccomCompanionBudget: 'budget',
    personalAccomCompanionActual: 'budgetActual',
    personalAccomCompanionPurchaseDate: 'purchaseDate',
  };

  modal.addEventListener('change', (e) => {
    if (e.target.id === 'personalAccomCompanionSelect') {
      const accom = (state.planner.personal?.accommodations || []).find(
        (a) => a.id === _personalAccomId,
      );
      if (!accom) return;
      const contactId = e.target.value;
      if (contactId) {
        accom.assignments = accom.assignments || [];
        if (!accom.assignments.find((s) => s.memberId === contactId)) {
          accom.assignments.push({
            memberId: contactId,
            checkIn: '',
            checkOut: '',
            budget: '',
            budgetActual: '',
            purchaseDate: '',
            currency: state.planner?.personal?.currency || 'AUD',
          });
          const opt = modal.querySelector(
            `#personalAccomCompanionSelect option[value="${CSS.escape(contactId)}"]`,
          );
          if (opt && !opt.textContent.endsWith(' ✓')) opt.textContent += ' ✓';
          const removeBtn = document.getElementById('personalAccomRemoveCompanionBtn');
          if (removeBtn) removeBtn.classList.remove('opacity-0', 'pointer-events-none');
          scheduleAutoSave();
        }
        loadPersonalCompanionStayFields(accom, contactId);
      } else {
        document.getElementById('personalAccomCompanionFields')?.classList.add('hidden');
        const removeBtn = document.getElementById('personalAccomRemoveCompanionBtn');
        if (removeBtn) removeBtn.classList.add('opacity-0', 'pointer-events-none');
      }
      return;
    }
    if (COMPANION_FIELD_MAP[e.target.id]) {
      const accom = (state.planner.personal?.accommodations || []).find(
        (a) => a.id === _personalAccomId,
      );
      if (!accom) return;
      const contactId = document.getElementById('personalAccomCompanionSelect')?.value;
      if (!contactId) return;
      accom.assignments = accom.assignments || [];
      let stay = accom.assignments.find((s) => s.memberId === contactId);
      if (!stay) {
        stay = {
          memberId: contactId,
          checkIn: '',
          checkOut: '',
          budget: '',
          budgetActual: '',
          purchaseDate: '',
          currency: state.planner?.personal?.currency || 'AUD',
        };
        accom.assignments.push(stay);
        const opt = modal.querySelector(
          `#personalAccomCompanionSelect option[value="${CSS.escape(contactId)}"]`,
        );
        if (opt && !opt.textContent.endsWith(' ✓')) opt.textContent += ' ✓';
        const removeBtn = document.getElementById('personalAccomRemoveCompanionBtn');
        if (removeBtn) removeBtn.classList.remove('opacity-0', 'pointer-events-none');
      }
      stay[COMPANION_FIELD_MAP[e.target.id]] = e.target.value;
      scheduleAutoSave();
    }
  });

  document.getElementById('personalAccomAddWaypointStopBtn')?.addEventListener('click', () => {
    const accom = (state.planner.personal?.accommodations || []).find(
      (a) => a.id === _personalAccomId,
    );
    if (!accom) return;
    accom.stops = [...(accom.stops || []), makeWaypointStop()];
    renderWaypointStops(
      accom.stops,
      'personalAccomWaypointStopsList',
      'personalAccomWaypointStopsEmpty',
    );
    scheduleAutoSave();
  });

  document.getElementById('personalAccomWaypointStopsList')?.addEventListener('input', (e) => {
    const field = e.target.dataset.stopField;
    if (!field) return;
    const legId = e.target.closest('[data-stop-id]')?.dataset.stopId;
    if (!legId) return;
    const accom = (state.planner.personal?.accommodations || []).find(
      (a) => a.id === _personalAccomId,
    );
    if (!accom) return;
    const leg = (accom.stops || []).find((l) => l.id === legId);
    if (leg) {
      leg[field] = e.target.value;
      scheduleAutoSave();
    }
  });

  document.getElementById('personalAccomWaypointStopsList')?.addEventListener('click', (e) => {
    if (!e.target.closest('.remove-waypoint-stop-btn')) return;
    const legId = e.target.closest('[data-stop-id]')?.dataset.stopId;
    if (!legId) return;
    const accom = (state.planner.personal?.accommodations || []).find(
      (a) => a.id === _personalAccomId,
    );
    if (!accom) return;
    accom.stops = (accom.stops || []).filter((l) => l.id !== legId);
    renderWaypointStops(
      accom.stops,
      'personalAccomWaypointStopsList',
      'personalAccomWaypointStopsEmpty',
    );
    scheduleAutoSave();
  });

  wireWaypointStopsDragDrop(
    'personalAccomWaypointStopsList',
    'personalAccomWaypointStopsEmpty',
    () => (state.planner.personal?.accommodations || []).find((a) => a.id === _personalAccomId),
  );
}

function wirePersonalPanel() {
  const panel = document.getElementById('plannerPersonalPanel');
  if (!panel) return;

  function ensurePersonal() {
    if (!state.planner.personal)
      state.planner.personal = {
        outboundLegs: [],
        returnLegs: [],
        accommodations: [],
        budget: '',
        budgetActual: '',
        currency: getDefaultCurrency(),
        notes: '',
        noteList: [],
      };
    if (!Array.isArray(state.planner.personal.noteList)) state.planner.personal.noteList = [];
    return state.planner.personal;
  }

  // Trip notes — add a new note and open it in the modal to fill in
  document.getElementById('addPersonalNoteBtn')?.addEventListener('click', () => {
    const personal = ensurePersonal();
    const note = { id: makeItemId('note'), title: '', body: '', emoji: '' };
    personal.noteList = [...personal.noteList, note];
    renderPersonalNotes();
    scheduleAutoSave();
    openNoteModal(note.id);
  });

  // Trip notes — edit (open modal) and remove (with undo). Delegated on document
  // because the trip-notes list now lives on the Notes tab, not the Personal panel.
  document.addEventListener('click', (e) => {
    const editBtn = e.target.closest('.personal-note-edit-btn');
    if (editBtn) {
      openNoteModal(editBtn.dataset.noteId);
      return;
    }

    const removeBtn = e.target.closest('.personal-note-remove-btn');
    if (!removeBtn) return;
    const id = removeBtn.dataset.noteId;
    const personal = ensurePersonal();
    const idx = personal.noteList.findIndex((n) => n.id === id);
    const snapshot = personal.noteList[idx];
    personal.noteList = personal.noteList.filter((n) => n.id !== id);
    renderPersonalNotes();
    scheduleAutoSave();
    if (snapshot)
      showUndoToast(snapshot.title || 'Note', () => {
        const p = ensurePersonal();
        p.noteList.splice(Math.min(idx, p.noteList.length), 0, snapshot);
        renderPersonalNotes();
        scheduleAutoSave();
      });
  });

  document.getElementById('addPersonalOutboundLegBtn')?.addEventListener('click', () => {
    const personal = ensurePersonal();
    const newLeg = makeLeg();
    personal.outboundLegs = [...(personal.outboundLegs || []), newLeg];
    renderPersonalTab();
    scheduleAutoSave();
    openPersonalLegModal('outbound', newLeg.id);
  });

  document.getElementById('addPersonalReturnLegBtn')?.addEventListener('click', () => {
    const personal = ensurePersonal();
    const newLeg = makeLeg();
    personal.returnLegs = [...(personal.returnLegs || []), newLeg];
    renderPersonalTab();
    scheduleAutoSave();
    openPersonalLegModal('return', newLeg.id);
  });

  document.getElementById('addPersonalLocalLegBtn')?.addEventListener('click', () => {
    const personal = ensurePersonal();
    const newLeg = makeLeg();
    personal.localLegs = [...(personal.localLegs || []), newLeg];
    renderPersonalTab();
    scheduleAutoSave();
    openPersonalLegModal('local', newLeg.id);
  });

  // Personal accom type select — updates modal icon/title live and saves
  document.getElementById('personalAccomModalType')?.addEventListener('change', (e) => {
    _syncPersonalAccomModalType(e.target.value);
    savePersonalAccom();
  });

  // Create a new personal accommodation (optionally pre-seeded with stay dates,
  // e.g. from a "gap night" CTA) and open it for editing. A regular stay's own
  // dates live on the `__me__` assignment, so seeded dates go there.
  function addPersonalAccommodation({ checkIn = '', checkOut = '' } = {}) {
    const personal = ensurePersonal();
    const currency = personal.currency || 'AUD';
    const newAccom = {
      id: makeItemId('ia'),
      name: '',
      address: '',
      checkIn: '',
      checkOut: '',
      confirmation: '',
      status: '',
      budget: '',
      budgetActual: '',
      currency,
      notes: '',
      receiptId: '',
    };
    const seeded = !!(checkIn && checkOut);
    if (seeded) {
      newAccom.assignments = [
        {
          memberId: '__me__',
          checkIn,
          checkOut,
          budget: '',
          budgetActual: '',
          purchaseDate: '',
          currency,
        },
      ];
    }
    personal.accommodations = [...(personal.accommodations || []), newAccom];
    scheduleAutoSave();
    renderPersonalAccomList();
    renderPersonalTimeline();
    renderPersonalConflicts();
    renderPersonalItineraryTab(); // refresh the agenda so the filled gap row clears
    openPersonalAccomModal(newAccom.id, { selectMe: seeded });
  }

  // Add accommodation
  document
    .getElementById('addPersonalAccomBtn')
    ?.addEventListener('click', () => addPersonalAccommodation());

  // "Add stay" from an itinerary gap night — document-level so it fires from the
  // agenda in both the Itinerary tab and the mobile overview. Seeds the gap dates.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest?.('.agenda-add-accom');
    if (!btn) return;
    addPersonalAccommodation({
      checkIn: btn.dataset.gapCheckin || '',
      checkOut: btn.dataset.gapCheckout || '',
    });
  });

  // Budget + notes field delegation
  panel.addEventListener('input', handlePersonalField);
  panel.addEventListener('change', handlePersonalField);

  // Timeline date range inputs — override the auto-derived range
  document.getElementById('personalTimelineStart')?.addEventListener('change', () => {
    renderPersonalTimeline();
    renderPersonalItinerary();
  });
  document.getElementById('personalTimelineEnd')?.addEventListener('change', () => {
    renderPersonalTimeline();
    renderPersonalItinerary();
  });

  function handlePersonalField(e) {
    const personal = ensurePersonal();
    // Event title (unassociated planners only)
    if (e.target.id === 'plannerPersonalTitle') {
      state.planner._displayName = e.target.value;
      const other = document.getElementById('plannerSponsorTitle');
      if (other && !other.disabled) other.value = e.target.value;
      scheduleAutoSave();
      updateHeader();
      return;
    }
    // Leg fields (data-leg-id / data-direction / data-leg-field)
    const { legId, direction, legField } = e.target.dataset;
    if (legId && direction && legField) {
      const legs = direction === 'outbound' ? personal.outboundLegs : personal.returnLegs;
      const leg = (legs || []).find((l) => l.id === legId);
      if (leg) {
        leg[legField] = e.target.value;
        if (legField === 'date' || legField === 'departTime' || legField === 'arriveTime') {
          const computed = autoArriveDate(leg.date, leg.departTime, leg.arriveTime);
          if (computed && !leg.arriveDate) {
            leg.arriveDate = computed;
            const arriveDateInput = e.target
              .closest('[data-leg-id]')
              ?.parentElement?.querySelector(`[data-leg-field="arriveDate"]`);
            if (arriveDateInput) arriveDateInput.value = computed;
          }
        }
        scheduleAutoSave();
        if (legField === 'date' || legField === 'mode') {
          renderPersonalTimeline();
          renderPersonalItinerary();
        }
      }
    }
  }

  // Travel legs + accommodation rows are now full-width cards that open the shared
  // read-only detail modal (Edit / Remove / Add-to-calendar live inside it — see
  // plannerItinerary). Their old inline edit/remove/calendar row handlers were
  // removed with the buttons.

  const personalPanel = document.getElementById('plannerPersonalPanel');
  if (personalPanel) {
    personalPanel.addEventListener('click', (e) => {
      const viewBtn = e.target.closest('.view-companion-btn');
      if (viewBtn) {
        openCompanionDetail(viewBtn.dataset.personId);
        return;
      }
      const editBtn = e.target.closest('.edit-companion-btn');
      if (editBtn) {
        openTripAssignmentModal(editBtn.dataset.companionId);
        return;
      }
      const removeBtn = e.target.closest('.remove-companion-btn');
      if (removeBtn) {
        const contactId = removeBtn.dataset.companionId;
        if (!state.planner.personal) return;
        const snapshot = (state.planner.personal.tripAssignments || []).find(
          (a) => a.memberId === contactId,
        );
        const contact = (state.planner.contacts || []).find((c) => c.id === contactId);
        state.planner.personal.tripAssignments = (
          state.planner.personal.tripAssignments || []
        ).filter((a) => a.memberId !== contactId);
        scheduleAutoSave();
        renderPersonalCompanionsSection();
        renderPersonalTimeline();
        renderSettingsPersonalContactsSection();
        if (snapshot)
          showUndoToast(contact?.name || 'Companion', () => {
            state.planner.personal.tripAssignments = [
              ...(state.planner.personal.tripAssignments || []),
              snapshot,
            ];
            renderPersonalCompanionsSection();
            renderPersonalTimeline();
            renderSettingsPersonalContactsSection();
            scheduleAutoSave();
          });
        return;
      }
    });
  }

  wireTrackedSessionSearch('personal');
}

// ── Render all tabs ──────────────────────────────────────────────────────────

// ── Tickets tab ──────────────────────────────────────────────────────────────

function getMeLabel() {
  const meId = state.planner.personal?.meContactId;
  if (!meId) return 'Me';
  const c = (state.global?.personalContacts || []).find((x) => x.id === meId);
  if (c) return `${c.name || 'Unnamed'} (me)`;
  const lc = (state.planner.personal?.localCompanions || []).find((x) => x.id === meId);
  return lc ? `${lc.name || 'Unnamed'} (me)` : 'Me';
}

// Tickets tab UI extracted to ./modules/plannerTickets.js (initTickets /
// renderTicketsTab / wireTicketsPanel). getMeLabel stays here (shared helper).

// ── Budget category management ────────────────────────────────────────────────

// ── Budget category management -> plannerBudget.js

// ── Settings tab ─────────────────────────────────────────────────────────────

// ── Budget tab (sponsor mode) ─────────────────────────────────────────────────

// ── Budget tab -> plannerBudget.js

function renderSettingsTeamSection() {
  const el = document.getElementById('settingsTeamList');
  if (!el) return;
  const members = state.global?.teamMembers || [];
  const assignedIds = new Set((state.planner.org?.teamAssignments || []).map((a) => a.memberId));

  if (!members.length) {
    el.innerHTML = '<p class="text-sm pl-ink-1 italic">No team members yet. Add one below.</p>';
    return;
  }

  el.innerHTML = members
    .map((m) => {
      const assigned = assignedIds.has(m.id);
      const disabled = m.enabled === false;
      const meta = [m.role, m.department, m.company].filter(Boolean).join(' · ');
      return `<div class="flex items-center gap-3 py-2 px-3 pl-bordered pl-surface ${disabled ? 'opacity-50' : ''}">
      <label class="flex items-center gap-2 flex-shrink-0 cursor-pointer" title="${assigned ? 'Remove from this event' : 'Assign to this event'}">
        <input type="checkbox" class="settings-team-assign h-4 w-4 rounded pl-rule pl-accent drupal-blue-focus"
          data-member-id="${esc(m.id)}" ${assigned ? 'checked' : ''}>
      </label>
      <div class="flex-1 min-w-0">
        <p class="text-sm font-medium pl-ink-0 truncate">${esc(m.name || 'Unnamed')}${disabled ? ' <span class="text-[0.6rem] font-semibold uppercase tracking-wider px-1 py-0.5 rounded pl-surface-2 pl-ink-2 ml-1">Inactive</span>' : ''}</p>
        ${meta ? `<p class="pl-hint truncate">${esc(meta)}</p>` : ''}
      </div>
      <button type="button" class="view-team-member-btn pl-act" data-member-id="${esc(m.id)}" aria-label="View ${esc(m.name || 'member')}">Details</button>
      <button type="button" class="edit-team-member-btn pl-act" data-member-id="${esc(m.id)}" aria-label="Edit ${esc(m.name || 'member')}">Edit</button>
    </div>`;
    })
    .join('');
}

function renderSettingsTab() {
  const mode = state.planner.mode || 'personal';
  const isSponsor = mode === 'sponsor';
  const isConference = state.planner?.isConference !== false;
  const base = isSponsor ? SPONSOR_TABS_BASE : PERSONAL_TABS_BASE;
  const disabled = new Set(
    isSponsor
      ? state.planner?.org?.disabledTabs || []
      : state.planner?.personal?.disabledTabs || [],
  );

  // Mode radio buttons
  const modePersonalRadio = document.getElementById('settingsModePersonal');
  const modeSponsorRadio = document.getElementById('settingsModeSponsor');
  if (modePersonalRadio) modePersonalRadio.checked = !isSponsor;
  if (modeSponsorRadio) modeSponsorRadio.checked = isSponsor;

  // Spec strip — a live, mono summary of this planner's key configuration.
  const specEl = document.getElementById('settingsSpec');
  if (specEl) {
    const cur = plannerDisplayCurrency(state.planner);
    const confN = (state.planner?._eventFiles || []).filter(Boolean).length;
    const locked = !!state.planner?.locked;
    // The live config strip. Each chip is one fact about this planner, so it
    // is one word — the glyphs were a second, vaguer copy of the same fact.
    const chip = (text, accent) =>
      `<span class="set-chip${accent ? ' set-chip--on' : ''}">${esc(text)}</span>`;
    specEl.innerHTML =
      chip(isSponsor ? 'Sponsor' : 'Personal', true) +
      chip(isConference ? 'Conference' : 'Trip') +
      (confN ? chip(`${confN} schedule${confN !== 1 ? 's' : ''}`) : '') +
      (cur ? chip(`Reports in ${cur}`) : '') +
      chip(locked ? 'Locked' : 'Open', locked);
  }

  // Conference toggle
  const conferenceEl = document.getElementById('settingsIsConference');
  if (conferenceEl) conferenceEl.checked = isConference;

  // Getting-around (local travel) toggle — off by default.
  const localTravelEl = document.getElementById('settingsLocalTravel');
  if (localTravelEl) localTravelEl.checked = !!state.planner?.personal?.showLocalTravel;

  // Lock toggle — disabled (with a note) unless the server can verify a password.
  const lockEl = document.getElementById('settingsLockPlanner');
  if (lockEl) {
    lockEl.checked = !!state.planner?.locked;
    lockEnforceable().then((ok) => {
      lockEl.disabled = !ok;
      document.getElementById('settingsLockUnavailable')?.classList.toggle('hidden', ok);
    });
  }

  // Tab order + visibility list (all tabs in stored order, including disabled; conference-only tabs hidden when !isConference)
  const tabsEl = document.getElementById('settingsTabList');
  if (tabsEl) {
    const stored = isSponsor
      ? state.planner?.org?.tabOrder || []
      : state.planner?.personal?.tabOrder || [];
    const inBase = (t) => base.has(t) && (isConference || !CONFERENCE_TABS.has(t));
    const allOrdered = stored.filter(inBase);
    base.forEach((t) => {
      if (!allOrdered.includes(t) && inBase(t)) allOrdered.push(t);
    });
    tabsEl.innerHTML = allOrdered
      .map((tab) => {
        const label = TAB_LABELS[tab] || tab;
        const desc = TAB_DESCRIPTIONS[tab] || '';
        const checked = !disabled.has(tab);
        return `<div class="settings-tab-row set-card" draggable="true" data-tab="${esc(tab)}">
        <span class="drag-handle set-drag" title="Drag to reorder" aria-hidden="true">::</span>
        <div class="set-card-body pointer-events-none">
          <p class="set-card-title">${esc(label)}</p>
          ${desc ? `<p class="set-card-desc">${esc(desc)}</p>` : ''}
        </div>
        <input type="checkbox" class="settings-tab-toggle pl-toggle" data-tab="${esc(tab)}" ${checked ? 'checked' : ''}>
      </div>`;
      })
      .join('');
  }

  // Sponsor-only sections
  document.getElementById('settingsSponsorSection')?.classList.toggle('hidden', !isSponsor);
  if (isSponsor) {
    renderSponsorLinked();
    renderSettingsTeamSection();
  }

  // Personal-only sections
  document.getElementById('settingsPersonalSection')?.classList.toggle('hidden', isSponsor);
  if (!isSponsor) {
    renderSettingsPersonalContactsSection();
  }

  // Associated conference schedules (multi-event): one row per linked event, the
  // first flagged primary, each with an unlink ×. Add via the "Add conference" btn.
  const confListEl = document.getElementById('settingsConferenceList');
  if (confListEl) {
    const files = state.planner?._eventFiles || [];
    if (!files.length) {
      confListEl.innerHTML =
        '<p class="pl-hint">No conference linked. Use “Add conference” to pull in a schedule.</p>';
    } else {
      confListEl.innerHTML = files
        .map((f, i) => {
          const ev = state.events.find((e) => e.file === f);
          const label = ev?.label || f.replace(/^events\//, '').replace(/\.json$/, '');
          const primary =
            i === 0 && files.length > 1 ? '<span class="set-chip set-chip--on">Primary</span>' : '';
          // .set-card, like every other row on this page. This was the last
          // pre-rebrand markup in Settings: rounded-md (6px) against a design
          // that is radius 0 throughout, on a `pl-surface` that resolves to
          // pure #fff in light mode — not a palette colour.
          return `<div class="set-card">
            <span class="set-card-body">
              <span class="set-card-title">${escapeHtml(label)}</span>
            </span>${primary}
            <button type="button" class="pl-act pl-act--del" data-remove-event="${escapeHtml(f)}" aria-label="Unlink ${escapeHtml(label)}">Unlink</button>
          </div>`;
        })
        .join('');
    }
  }

  // API access — present on every render; it disables itself when the server
  // cannot issue tokens rather than disappearing.
  renderApiTokenSection();

  // Show only the relevant budget category section
  document.getElementById('settingsBudgetSponsor')?.classList.toggle('hidden', !isSponsor);
  document.getElementById('settingsBudgetPersonal')?.classList.toggle('hidden', isSponsor);
  renderBudgetCategoryManager(isSponsor ? 'org' : 'personal');

  // Per-planner roll-up (display) currency. Falls back to the trip currency when
  // unset (older planners), so the selector always shows the effective target.
  const displayCurrencyEl = document.getElementById('settingsDisplayCurrency');
  if (displayCurrencyEl) {
    const effective = plannerDisplayCurrency(state.planner);
    displayCurrencyEl.innerHTML = CURRENCIES.map(
      (c) => `<option value="${c}"${c === effective ? ' selected' : ''}>${c}</option>`,
    ).join('');
  }

  // Global defaults section
  const defaultCurrencyEl = document.getElementById('settingsDefaultCurrency');
  if (defaultCurrencyEl) {
    defaultCurrencyEl.innerHTML = CURRENCIES.map(
      (c) => `<option value="${c}"${c === getDefaultCurrency() ? ' selected' : ''}>${c}</option>`,
    ).join('');
  }
  const defaultModeEl = document.getElementById('settingsDefaultMode');
  if (defaultModeEl) defaultModeEl.value = state.global?.defaultMode || 'personal';
}

function wireSettingsTabOrder() {
  const list = document.getElementById('settingsTabList');
  if (!list) return;
  let _dragged = null;

  list.addEventListener(
    'dragstart',
    (e) => {
      const row = e.target.closest('.settings-tab-row');
      if (!row) return;
      _dragged = row.dataset.tab;
      row.classList.add('tab-drag-source');
      e.dataTransfer.effectAllowed = 'move';
    },
    { passive: true },
  );

  list.addEventListener(
    'dragend',
    () => {
      _dragged = null;
      list
        .querySelectorAll('.tab-drag-source, .settings-drop-before, .settings-drop-after')
        .forEach((el) =>
          el.classList.remove('tab-drag-source', 'settings-drop-before', 'settings-drop-after'),
        );
    },
    { passive: true },
  );

  list.addEventListener('dragover', (e) => {
    if (!_dragged) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const target = e.target.closest('.settings-tab-row');
    list
      .querySelectorAll('.settings-drop-before, .settings-drop-after')
      .forEach((el) => el.classList.remove('settings-drop-before', 'settings-drop-after'));
    if (target && target.dataset.tab !== _dragged) {
      const rect = target.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      target.classList.add(before ? 'settings-drop-before' : 'settings-drop-after');
    }
  });

  list.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!_dragged) return;
    const target = e.target.closest('.settings-tab-row');
    if (!target || target.dataset.tab === _dragged) return;

    const mode = state.planner.mode || 'personal';
    const isSponsor = mode === 'sponsor';
    const base = isSponsor ? SPONSOR_TABS_BASE : PERSONAL_TABS_BASE;
    const stored = isSponsor
      ? state.planner?.org?.tabOrder || []
      : state.planner?.personal?.tabOrder || [];
    const allOrdered = stored.filter((t) => base.has(t));
    base.forEach((t) => {
      if (!allOrdered.includes(t)) allOrdered.push(t);
    });

    const rect = target.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    const from = allOrdered.indexOf(_dragged);
    const to = allOrdered.indexOf(target.dataset.tab);
    if (from === -1 || to === -1) return;

    const newOrder = [...allOrdered];
    newOrder.splice(from, 1);
    const insertAt = before ? to - (from < to ? 1 : 0) : to + (from > to ? 1 : 0);
    newOrder.splice(Math.max(0, insertAt), 0, _dragged);

    if (isSponsor) state.planner.org.tabOrder = newOrder;
    else state.planner.personal.tabOrder = newOrder;
    scheduleAutoSave();
    renderTabBar();
    renderSettingsTab();
  });
}

function wireSettingsPanel() {
  const panel = document.getElementById('plannerSettingsPanel');
  if (!panel) return;

  panel.addEventListener('change', (e) => {
    const mode = state.planner.mode || 'personal';

    // Planner mode radio
    if (e.target.name === 'settingsMode') {
      applyMode(e.target.value);
      renderSettingsTab();
      return;
    }

    // Conference features toggle
    if (e.target.id === 'settingsIsConference') {
      state.planner.isConference = e.target.checked;
      scheduleAutoSave();
      applyConferenceMode();
      renderSettingsTab();
      return;
    }

    // Getting-around (local travel) toggle — shows/hides the section + its
    // itinerary/timeline/map entries.
    if (e.target.id === 'settingsLocalTravel') {
      (state.planner.personal ??= {}).showLocalTravel = e.target.checked;
      scheduleAutoSave();
      renderPersonalTab();
      return;
    }

    // Per-planner lock. Enabling while you're already inside shouldn't lock you out —
    // grant the 90-minute grace now; the lock engages on the next open (or after it).
    if (e.target.id === 'settingsLockPlanner') {
      state.planner.locked = e.target.checked;
      if (e.target.checked) grantUnlockGrace(state.plannerKey);
      scheduleAutoSave();
      return;
    }

    // "Me" identity select (personal mode)
    if (e.target.id === 'settingsMeContactId') {
      if (state.planner.personal) {
        state.planner.personal.meContactId = e.target.value || null;
        scheduleAutoSave();
        renderPersonalTab();
        renderPersonalTimeline();
        if (state.activeTab === 'map') renderMapTab();
      }
      return;
    }

    // Per-planner roll-up (display) currency — re-render everything that shows a total
    if (e.target.id === 'settingsDisplayCurrency') {
      state.planner.displayCurrency = e.target.value;
      scheduleAutoSave();
      renderPersonalBudgetBreakdown();
      renderSponsorBudgetBreakdown();
      renderSummaryTab();
      return;
    }

    // Global default currency select
    if (e.target.id === 'settingsDefaultCurrency') {
      state.global.defaultCurrency = e.target.value;
      saveGlobal(state.global);
      return;
    }

    // Global default mode select
    if (e.target.id === 'settingsDefaultMode') {
      state.global.defaultMode = e.target.value;
      saveGlobal(state.global);
      return;
    }

    // Tab visibility toggle
    const tabCb = e.target.closest('.settings-tab-toggle');
    if (tabCb) {
      const tab = tabCb.dataset.tab;
      const isSponsor = mode === 'sponsor';
      const arr = isSponsor
        ? (state.planner.org.disabledTabs ??= [])
        : (state.planner.personal.disabledTabs ??= []);
      if (tabCb.checked) {
        const idx = arr.indexOf(tab);
        if (idx !== -1) arr.splice(idx, 1);
      } else {
        if (!arr.includes(tab)) arr.push(tab);
      }
      scheduleAutoSave();
      applyMode(mode);
      return;
    }

    // Team event-assignment toggle
    const assignCb = e.target.closest('.settings-team-assign');
    if (assignCb) {
      const memberId = assignCb.dataset.memberId;
      const assignments = (state.planner.org.teamAssignments ??= []);
      if (assignCb.checked) {
        if (!assignments.find((a) => a.memberId === memberId)) {
          assignments.push({
            memberId,
            budget: '',
            budgetActual: '',
            currency: state.planner.org.sponsorCurrency || 'AUD',
            notes: '',
            outboundLegs: [],
            returnLegs: [],
          });
          refreshAssignMemberSelect();
          renderOrgTab();
        }
      } else {
        const idx = assignments.findIndex((a) => a.memberId === memberId);
        if (idx !== -1) {
          const a = assignments[idx];
          const hasData =
            a.budget || a.budgetActual || a.notes || a.outboundLegs?.length || a.returnLegs?.length;
          if (hasData) {
            assignCb.checked = true; // revert
            alert(
              'This member has travel or budget data on this event. Remove them from the Team tab instead.',
            );
            return;
          }
          assignments.splice(idx, 1);
          refreshAssignMemberSelect();
          renderOrgTab();
        }
      }
      scheduleAutoSave();
      return;
    }

    const pcAssignCheck = e.target.closest('.settings-personal-contact-assign');
    if (pcAssignCheck) {
      const contactId = pcAssignCheck.dataset.contactId;
      if (!state.planner.personal) return;
      state.planner.personal.tripAssignments = state.planner.personal.tripAssignments || [];
      if (pcAssignCheck.checked) {
        if (!state.planner.personal.tripAssignments.find((a) => a.memberId === contactId)) {
          state.planner.personal.tripAssignments.push(makeTripAssignment(contactId));
        }
      } else {
        state.planner.personal.tripAssignments = state.planner.personal.tripAssignments.filter(
          (a) => a.memberId !== contactId,
        );
      }
      scheduleAutoSave();
      renderPersonalCompanionsSection();
      renderPersonalTimeline();
      return;
    }
  });

  // Clicks: view/edit team member buttons, add-member, reset tab order, delete
  panel.addEventListener('click', async (e) => {
    const viewBtn = e.target.closest('.view-team-member-btn');
    if (viewBtn) {
      openTeamMemberDetailModal(viewBtn.dataset.memberId);
      return;
    }
    const editBtn = e.target.closest('.edit-team-member-btn');
    if (editBtn) {
      openTeamMemberModal(editBtn.dataset.memberId);
      return;
    }
    if (e.target.closest('#settingsAddTeamMemberBtn')) {
      openTeamMemberModal(null);
      return;
    }
    if (e.target.closest('#settingsAddPersonalContactBtn')) {
      openPersonalContactModal(null);
      return;
    }
    const editPersonalContact = e.target.closest('.edit-personal-contact-btn');
    if (editPersonalContact) {
      openPersonalContactModal(editPersonalContact.dataset.contactId);
      return;
    }
    if (e.target.closest('#settingsResetTabOrderBtn')) {
      const m = state.planner.mode || 'personal';
      if (m === 'sponsor') state.planner.org.tabOrder = [];
      else state.planner.personal.tabOrder = [];
      scheduleAutoSave();
      renderTabBar();
      renderSettingsTab();
      return;
    }

    if (e.target.closest('#settingsDeletePlannerBtn')) {
      const name = state.planner._displayName || state.plannerKey || 'this planner';
      if (window.matchMedia('(max-width: 639px)').matches) {
        const sheet = document.getElementById('plannerDeleteSheet');
        const nameEl = document.getElementById('plannerDeleteSheetName');
        if (nameEl) nameEl.textContent = name;
        if (sheet) {
          sheet.classList.remove('hidden');
          document.body.style.overflow = 'hidden';
        }
      } else {
        if (!window.confirm(`Delete "${name}"? This cannot be undone.`)) return;
        const { ok, error } = await deletePlannerBySlug(state.plannerKey);
        if (!ok) {
          alert(`Delete failed: ${error}`);
          return;
        }
        location.href = 'planner.html';
      }
      return;
    }
  });

  wireSettingsTabOrder();

  // Sponsor search
  document.getElementById('sponsorSearchInput')?.addEventListener('input', (e) => {
    const query = e.target.value.trim().toLowerCase();
    const results = document.getElementById('sponsorSearchResults');
    if (!results) return;
    if (!query) {
      results.classList.add('hidden');
      results.innerHTML = '';
      return;
    }
    const sponsors = state.eventMeta?.sponsors || [];
    const matches = sponsors.filter((s) => s.title?.toLowerCase().includes(query));
    if (!matches.length) {
      results.innerHTML = '<li class="px-4 py-2 pl-hint italic">No sponsors found</li>';
    } else {
      results.innerHTML = matches
        .map(
          (s) =>
            `<li class="px-4 py-2 text-sm pl-ink-1 cursor-pointer flex items-center justify-between gap-2 sponsor-result-item" data-sponsor-id="${esc(s.id)}">
          <span>${esc(s.title || '')}</span>
          <span class="pl-hint flex-shrink-0">${esc(s.tier || '')}</span>
        </li>`,
        )
        .join('');
    }
    results.classList.remove('hidden');
  });

  document.getElementById('sponsorSearchResults')?.addEventListener('click', (e) => {
    const item = e.target.closest('.sponsor-result-item');
    if (!item) return;
    state.planner.org.sponsorId = item.dataset.sponsorId;
    document.getElementById('sponsorSearchInput').value = '';
    document.getElementById('sponsorSearchResults').classList.add('hidden');
    renderSponsorLinked();
    syncSponsoredSessions();
    scheduleAutoSave();
  });

  document.getElementById('unlinkSponsorBtn')?.addEventListener('click', () => {
    state.planner.org.sponsorId = '';
    renderSponsorLinked();
    scheduleAutoSave();
  });

  document.addEventListener(
    'click',
    (e) => {
      if (!e.target.closest('#sponsorSearchRow') && !e.target.closest('#sponsorSearchResults')) {
        document.getElementById('sponsorSearchResults')?.classList.add('hidden');
      }
    },
    { capture: false },
  );
}

function wireBudgetCategoryManager() {
  ['personal', 'org'].forEach((mode) => {
    const addInput = document.getElementById(
      mode === 'personal' ? 'personalBudgetCategoryInput' : 'sponsorBudgetCategoryInput',
    );
    const addBtn = document.getElementById(
      mode === 'personal' ? 'addPersonalBudgetCategoryBtn' : 'addSponsorBudgetCategoryBtn',
    );
    const container = document.getElementById(
      mode === 'personal' ? 'personalBudgetCategoryList' : 'sponsorBudgetCategoryList',
    );

    addBtn?.addEventListener('click', () => {
      if (addInput?.value) {
        addBudgetCategory(mode, addInput.value);
        addInput.value = '';
      }
    });
    addInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        addBudgetCategory(mode, addInput.value);
        addInput.value = '';
        e.preventDefault();
      }
    });
    container?.addEventListener('click', (e) => {
      const btn = e.target.closest('.remove-budget-cat-btn');
      if (btn) removeBudgetCategory(btn.dataset.catMode, btn.dataset.catId);
    });
  });
}

function renderAll() {
  renderSidebar();
  applyScheduleGating();
  renderContactsTab();
  renderTasksTab();
  renderChecklistsTab();
  renderWeatherTab();
  renderWeatherSummary();
  renderOrgTab();
  renderPersonalTab();
  renderTeamTab();
  renderDocumentsTab();
  renderReceiptsTab();
  renderTicketsTab();
  renderBudgetTab();
  renderSplitTab();
  renderSummaryTab();
  renderSettingsTab();
}

// ── Event delegation ─────────────────────────────────────────────────────────

function renderSponsorLinked() {
  const sponsorId = state.planner.org.sponsorId || '';
  const sponsors = state.eventMeta?.sponsors || [];
  const linked = sponsors.find((s) => s.id === sponsorId);
  const searchRow = document.getElementById('sponsorSearchRow');
  const resultsEl = document.getElementById('sponsorSearchResults');
  const linkedCard = document.getElementById('sponsorLinkedCard');
  const unlinkBtn = document.getElementById('unlinkSponsorBtn');

  if (linked) {
    searchRow?.classList.add('hidden');
    resultsEl?.classList.add('hidden');
    linkedCard?.classList.remove('hidden');
    unlinkBtn?.classList.remove('hidden');
    const nameEl = document.getElementById('sponsorLinkedName');
    const tierEl = document.getElementById('sponsorLinkedTier');
    const urlEl = document.getElementById('sponsorLinkedUrl');
    if (nameEl) nameEl.textContent = linked.title || '';
    if (tierEl) tierEl.textContent = linked.tier || '';
    if (urlEl) {
      if (linked.link) {
        urlEl.href = linked.link;
        urlEl.classList.remove('hidden');
      } else {
        urlEl.classList.add('hidden');
      }
    }
  } else {
    searchRow?.classList.remove('hidden');
    linkedCard?.classList.add('hidden');
    unlinkBtn?.classList.add('hidden');
  }
}

function wireAssignmentModal() {
  const assignModal = document.getElementById('assignmentModal');
  if (!assignModal) return;

  function getAssignment() {
    const ctx = assignModal.dataset.ctx || 'org';
    if (ctx === 'localCompanion') {
      return (state.planner.personal?.localCompanions || []).find(
        (lc) => lc.id === assignModal.dataset.memberId,
      );
    }
    const store =
      ctx === 'personal'
        ? state.planner.personal?.tripAssignments || []
        : state.planner.org?.teamAssignments || [];
    return store.find((a) => a.memberId === assignModal.dataset.memberId);
  }

  function handleAssignField(e) {
    const assignment = getAssignment();
    if (!assignment) return;
    if (e.target.id === 'assignmentBudget') {
      assignment.budget = e.target.value;
      scheduleAutoSave();
      return;
    }
    if (e.target.id === 'assignmentActual') {
      assignment.budgetActual = e.target.value;
      scheduleAutoSave();
      return;
    }
    if (e.target.id === 'assignmentCurrency') {
      assignment.currency = e.target.value;
      scheduleAutoSave();
      return;
    }
    if (e.target.id === 'assignmentPurchaseDate') {
      assignment.purchaseDate = e.target.value;
      scheduleAutoSave();
      return;
    }
    if (e.target.id === 'assignmentNotes') {
      assignment.notes = e.target.value;
      scheduleAutoSave();
      return;
    }
    const { legId, direction, legField } = e.target.dataset;
    if (legId && direction && legField) {
      const legs = direction === 'outbound' ? assignment.outboundLegs : assignment.returnLegs;
      const leg = legs?.find((l) => l.id === legId);
      if (leg) {
        leg[legField] = e.target.value;
        scheduleAutoSave();
      }
    }
  }

  document.getElementById('addOutboundLegBtn')?.addEventListener('click', () => {
    const assignment = getAssignment();
    if (!assignment) return;
    assignment.outboundLegs.push(makeLeg());
    renderAssignmentLegsInModal(assignment);
    scheduleAutoSave();
  });

  document.getElementById('addReturnLegBtn')?.addEventListener('click', () => {
    const assignment = getAssignment();
    if (!assignment) return;
    assignment.returnLegs.push(makeLeg());
    renderAssignmentLegsInModal(assignment);
    scheduleAutoSave();
  });

  function importLegsFromMe(direction) {
    const assignment = getAssignment();
    if (!assignment) return;
    const personal = state.planner.personal;
    const srcLegs =
      direction === 'outbound' ? personal?.outboundLegs || [] : personal?.returnLegs || [];
    if (!srcLegs.length) return;
    const destLegs = direction === 'outbound' ? assignment.outboundLegs : assignment.returnLegs;
    if (destLegs.length > 0) {
      if (!window.confirm(`Replace existing ${direction} legs with your own legs?`)) return;
    }
    const copied = srcLegs.map((l) => ({ ...l, id: makeItemId('leg') }));
    if (direction === 'outbound') assignment.outboundLegs = copied;
    else assignment.returnLegs = copied;
    renderAssignmentLegsInModal(assignment);
    scheduleAutoSave();
  }

  document
    .getElementById('importOutboundFromMeBtn')
    ?.addEventListener('click', () => importLegsFromMe('outbound'));
  document
    .getElementById('importReturnFromMeBtn')
    ?.addEventListener('click', () => importLegsFromMe('return'));

  assignModal.addEventListener('click', (e) => {
    const removeBtn = e.target.closest('.remove-leg-btn');
    if (removeBtn) {
      const { legId, direction } = removeBtn.dataset;
      const assignment = getAssignment();
      if (!assignment) return;
      if (direction === 'outbound')
        assignment.outboundLegs = assignment.outboundLegs.filter((l) => l.id !== legId);
      else assignment.returnLegs = assignment.returnLegs.filter((l) => l.id !== legId);
      renderAssignmentLegsInModal(assignment);
      scheduleAutoSave();
      return;
    }
    const legRcBtn = e.target.closest(
      '.leg-link-receipt-btn, .leg-create-receipt-btn, .leg-unlink-receipt-btn',
    );
    if (legRcBtn) {
      const { legId, direction } = legRcBtn.dataset;
      const assignment = getAssignment();
      if (!assignment) return;
      const legs =
        direction === 'return' ? assignment.returnLegs || [] : assignment.outboundLegs || [];
      const leg = legs.find((l) => l.id === legId);
      if (!leg) return;
      const rerender = () => {
        renderAssignmentLegsInModal(assignment);
        scheduleAutoSave();
        renderReceiptsTab();
      };
      if (legRcBtn.classList.contains('leg-unlink-receipt-btn')) {
        unlinkEntityReceipt(leg);
        rerender();
        return;
      }
      const createForLeg = () => {
        const route = [leg.from, leg.to].filter(Boolean).join(' → ');
        createReceiptForEntity(state.planner, leg, {
          name: route ? `Travel: ${route}` : 'Travel receipt',
          date: leg.date || '',
          currency: state.planner?.org?.sponsorCurrency || 'AUD',
          category: 'travel',
        });
        rerender();
      };
      if (legRcBtn.classList.contains('leg-create-receipt-btn')) {
        createForLeg();
        return;
      }
      openReceiptPicker(state.planner, {
        onPick: (rid) => {
          linkEntityReceipt(leg, rid);
          rerender();
        },
        onCreate: createForLeg,
      });
      return;
    }
    if (e.target.closest('#assignmentCreateReceiptBtn')) {
      createReceiptForAssignment();
      return;
    }
    if (e.target.closest('#assignmentViewReceiptBtn')) {
      const assignment = _currentTeamAssignment();
      hideModal('assignmentModal');
      assignModal.dataset.ctx = '';
      setActiveTab('receipts');
      setTimeout(() => {
        const el = assignment?.receiptId
          ? document.querySelector(`details[data-receipt-id="${assignment.receiptId}"]`)
          : null;
        el?.setAttribute('open', '');
        el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 50);
      return;
    }
    if (e.target.closest('#assignmentUnlinkReceiptBtn')) {
      const assignment = _currentTeamAssignment();
      if (assignment) {
        unlinkEntityReceipt(assignment);
        scheduleAutoSave();
        renderAssignmentReceiptStatus();
      }
      return;
    }
  });

  createModal('assignmentModal', {
    onSave: handleAssignField,
    onClose: () => {
      const ctx = assignModal.dataset.ctx;
      if (ctx === 'personal' || ctx === 'localCompanion') {
        renderPersonalCompanionsSection();
        renderCompanionsTab();
        renderPersonalTimeline();
        renderPersonalAccomList();
      } else {
        renderOrgTab();
      }
      assignModal.dataset.ctx = '';
    },
  }).wire();
}

function wireOrgPanel() {
  const panel = document.getElementById('plannerSponsorPanel');
  if (!panel) return;

  // ── Booth fields ────────────────────────────────────────────────────────────
  panel.addEventListener('input', (e) => {
    if (e.target.id === 'plannerSponsorTitle') {
      state.planner._displayName = e.target.value;
      const other = document.getElementById('plannerPersonalTitle');
      if (other && !other.disabled) other.value = e.target.value;
      scheduleAutoSave();
      updateHeader();
      return;
    }
    if (e.target.id === 'orgBoothInfo') {
      state.planner.org.boothInfo = e.target.value;
      scheduleAutoSave();
      return;
    }
    if (e.target.id === 'orgBoothNotes') {
      state.planner.org.boothNotes = e.target.value;
      scheduleAutoSave();
      return;
    }

    const delivId = e.target.dataset.deliverablesId;
    const delivField = e.target.dataset.deliverablesField;
    if (delivId && delivField && delivField !== 'done') {
      const item = state.planner.org.deliverables.find((x) => x.id === delivId);
      if (item) {
        item[delivField] = e.target.value;
        scheduleAutoSave();
      }
    }
  });

  panel.addEventListener('change', (e) => {
    // Timeline date range
    if (e.target.id === 'timelineStartDate') {
      state.planner.org.timeline = { ...state.planner.org.timeline, startDate: e.target.value };
      renderTimeline();
      scheduleAutoSave();
      return;
    }
    if (e.target.id === 'timelineEndDate') {
      state.planner.org.timeline = { ...state.planner.org.timeline, endDate: e.target.value };
      renderTimeline();
      scheduleAutoSave();
      return;
    }

    // Assign team member select
    if (e.target.id === 'assignMemberSelect') {
      const memberId = e.target.value;
      if (!memberId) return;
      const already = (state.planner.org.teamAssignments || []).some(
        (a) => a.memberId === memberId,
      );
      if (!already) {
        state.planner.org.teamAssignments = [
          ...(state.planner.org.teamAssignments || []),
          {
            memberId,
            outboundLegs: [],
            returnLegs: [],
            budget: '',
            budgetActual: '',
            currency: state.planner?.org?.sponsorCurrency || getDefaultCurrency(),
            notes: '',
            receiptId: '',
          },
        ];
        renderOrgTab();
        scheduleAutoSave();
        openAssignmentModal(memberId);
      }
      e.target.value = '';
      return;
    }

    if (e.target.classList.contains('swag-done-check')) {
      const id = e.target.dataset.swagId;
      const item = state.planner.org.swag.find((x) => x.id === id);
      if (item) {
        item.done = e.target.checked;
        scheduleAutoSave();
        renderOrgTab();
      }
      return;
    }
    const delivId = e.target.dataset.deliverablesId;
    const delivField = e.target.dataset.deliverablesField;
    if (delivId && delivField === 'done') {
      const item = state.planner.org.deliverables.find((x) => x.id === delivId);
      if (item) {
        item.done = e.target.checked;
        const row = e.target.closest(`[data-deliverables-id="${delivId}"]`);
        row
          ?.querySelector('[data-deliverables-field="label"]')
          ?.classList.toggle('line-through', item.done);
        row
          ?.querySelector('[data-deliverables-field="label"]')
          ?.classList.toggle('text-gray-400', item.done);
        scheduleAutoSave();
      }
    }
  });

  panel.addEventListener('click', (e) => {
    // Assignment edit / remove
    const editAssign = e.target.closest('.edit-assignment-btn');
    if (editAssign) {
      openAssignmentModal(editAssign.dataset.memberId);
      return;
    }

    const removeAssign = e.target.closest('.remove-assignment-btn');
    if (removeAssign) {
      const mid = removeAssign.dataset.memberId;
      const snapAssign = (state.planner.org.teamAssignments || []).find((a) => a.memberId === mid);
      const snapAccomAssns = (state.planner.org.accommodations || []).map((acc) => ({
        id: acc.id,
        a: [...(acc.assignments || [])],
      }));
      state.planner.org.teamAssignments = (state.planner.org.teamAssignments || []).filter(
        (a) => a.memberId !== mid,
      );
      (state.planner.org.accommodations || []).forEach((acc) => {
        acc.assignments = (acc.assignments || []).filter((a) => a.memberId !== mid);
      });
      renderOrgTab();
      scheduleAutoSave();
      if (snapAssign) {
        const member = (state.global?.teamMembers || []).find((m) => m.id === mid);
        showUndoToast(member?.name || 'Team member', () => {
          state.planner.org.teamAssignments = [
            ...(state.planner.org.teamAssignments || []),
            snapAssign,
          ];
          snapAccomAssns.forEach(({ id, a }) => {
            const acc = (state.planner.org.accommodations || []).find((x) => x.id === id);
            if (acc) acc.assignments = a;
          });
          renderOrgTab();
          scheduleAutoSave();
        });
      }
      return;
    }

    // Add accommodation stay to a calendar
    const calAccom = e.target.closest('.accommodation-cal-btn');
    if (calAccom) {
      const acc = (state.planner.org.accommodations || []).find(
        (a) => a.id === calAccom.dataset.accomId,
      );
      // Dates live on the accommodation itself (waypoints) or per-member in the
      // assignments (a normal stay); take the full span across all members.
      let checkIn = acc?.checkIn || '';
      let checkOut = acc?.checkOut || '';
      if (acc && acc.type !== 'waypoints') {
        const ins = (acc.assignments || [])
          .map((s) => s.checkIn)
          .filter(Boolean)
          .sort();
        const outs = (acc.assignments || [])
          .map((s) => s.checkOut)
          .filter(Boolean)
          .sort();
        checkIn = ins[0] || '';
        checkOut = outs[outs.length - 1] || '';
      }
      const calEvent = accommodationToCalEvent({
        name: acc?.name,
        checkIn,
        checkOut,
        location: acc?.address,
      });
      if (calEvent)
        openCalendarMenu(calAccom, calEvent, { id: acc?.id, filenameBase: calEvent.title });
      return;
    }
    // Accommodation edit / delete
    const editAccom = e.target.closest('.edit-accommodation-btn');
    if (editAccom) {
      openAccommodationModal(editAccom.dataset.accomId);
      return;
    }

    const delAccom = e.target.closest('.delete-accommodation-btn');
    if (delAccom) {
      const id = delAccom.dataset.accomId;
      const snapshot = (state.planner.org.accommodations || []).find((a) => a.id === id);
      state.planner.org.accommodations = (state.planner.org.accommodations || []).filter(
        (a) => a.id !== id,
      );
      renderOrgTab();
      scheduleAutoSave();
      if (snapshot)
        showUndoToast(snapshot.name || 'Accommodation', () => {
          state.planner.org.accommodations = [
            ...(state.planner.org.accommodations || []),
            snapshot,
          ];
          renderOrgTab();
          scheduleAutoSave();
        });
      return;
    }

    const editSwag = e.target.closest('.edit-swag-btn');
    if (editSwag) {
      openSwagModal(editSwag.dataset.swagId);
      return;
    }
    if (e.target.closest('.delete-deliverables-btn')) {
      const id = e.target.closest('.delete-deliverables-btn').dataset.deliverablesId;
      const snapshot = (state.planner.org.deliverables || []).find((x) => x.id === id);
      state.planner.org.deliverables = state.planner.org.deliverables.filter((x) => x.id !== id);
      renderOrgTab();
      scheduleAutoSave();
      if (snapshot)
        showUndoToast(snapshot.name || 'Deliverable', () => {
          state.planner.org.deliverables = [...(state.planner.org.deliverables || []), snapshot];
          renderOrgTab();
          scheduleAutoSave();
        });
    }

    const calOrgEvent = e.target.closest('.org-event-cal-btn');
    if (calOrgEvent) {
      const id = calOrgEvent.dataset.eventId;
      const item = (state.planner.org?.itinerary || []).find((i) => i.id === id);
      const calEvent = itineraryItemToCalEvent(item, { timezone: getTimezone() });
      if (calEvent) openCalendarMenu(calOrgEvent, calEvent, { id, filenameBase: calEvent.title });
      return;
    }
    const editOrgEvent = e.target.closest('.edit-org-event-btn');
    if (editOrgEvent) {
      openOrgEventModal(editOrgEvent.dataset.eventId);
      return;
    }
    const delOrgEvent = e.target.closest('.delete-org-event-btn');
    if (delOrgEvent) {
      const id = delOrgEvent.dataset.eventId;
      const snapshot = (state.planner.org.itinerary || []).find((i) => i.id === id);
      state.planner.org.itinerary = (state.planner.org.itinerary || []).filter((i) => i.id !== id);
      renderOrgItinerary();
      scheduleAutoSave();
      if (state.activeTab === 'summary') renderSummaryTab();
      if (snapshot)
        showUndoToast(snapshot.title || 'Team event', () => {
          state.planner.org.itinerary = [...(state.planner.org.itinerary || []), snapshot];
          renderOrgItinerary();
          scheduleAutoSave();
          if (state.activeTab === 'summary') renderSummaryTab();
        });
    }
  });

  panel.addEventListener('change', (e) => {
    if (e.target.classList.contains('org-event-done-check')) {
      const id = e.target.dataset.eventId;
      const item = (state.planner.org?.itinerary || []).find((i) => i.id === id);
      if (item) {
        item.done = e.target.checked;
        scheduleAutoSave();
      }
    }
  });

  document.getElementById('addOrgEventBtn')?.addEventListener('click', () => openOrgEventModal());

  document.getElementById('addAccommodationBtn')?.addEventListener('click', () => {
    const acc = {
      id: makeItemId('acc'),
      name: '',
      address: '',
      confirmation: '',
      notes: '',
      assignments: [],
      receiptId: '',
    };
    state.planner.org.accommodations = [...(state.planner.org.accommodations || []), acc];
    renderOrgTab();
    scheduleAutoSave();
    openAccommodationModal(acc.id);
  });

  document.getElementById('addSwagBtn')?.addEventListener('click', () => {
    const item = {
      id: makeItemId('sw'),
      name: '',
      quantity: 1,
      budget: '',
      actual: '',
      currency: state.planner?.org?.sponsorCurrency || 'AUD',
      done: false,
      notes: '',
      receiptId: '',
    };
    state.planner.org.swag.push(item);
    renderOrgTab();
    scheduleAutoSave();
    openSwagModal(item.id);
  });

  document.getElementById('addDeliverableBtn')?.addEventListener('click', () => {
    state.planner.org.deliverables.push({
      id: makeItemId('dv'),
      label: '',
      done: false,
      dueDate: '',
    });
    renderOrgTab();
    scheduleAutoSave();
  });

  // ── Accommodation modal ─────────────────────────────────────────────────────
  const accomModal = document.getElementById('accommodationModal');
  if (accomModal) {
    function getAccom() {
      return (state.planner.org.accommodations || []).find(
        (a) => a.id === accomModal.dataset.accomId,
      );
    }

    const MEMBER_FIELD_MAP = {
      accomMemberCheckIn: 'checkIn',
      accomMemberCheckOut: 'checkOut',
    };

    function handleAccomField(e) {
      const acc = getAccom();
      if (!acc) return;
      if (e.target.id === 'accomType') {
        acc.type = e.target.value;
        document.getElementById('accommodationModalTitle').textContent =
          e.target.value === 'waypoints' ? 'Waypoint' : 'Accommodation';
        toggleWaypointStopsSection(e.target.value === 'waypoints', 'accomWaypointStopsSection');
        renderWaypointStops(acc.stops, 'accomWaypointStopsList', 'accomWaypointStopsEmpty');
        renderAccomMembersSection(acc);
        renderTimeline();
      } else if (e.target.id === 'accomName') {
        acc.name = e.target.value;
      } else if (e.target.id === 'accomAddress') {
        acc.address = e.target.value;
      } else if (e.target.id === 'accomCoords') {
        acc.coords = e.target.value;
      } else if (e.target.id === 'accomConfirmation') {
        acc.confirmation = e.target.value;
      } else if (e.target.id === 'accomNotes') {
        acc.notes = e.target.value;
      } else if (MEMBER_FIELD_MAP[e.target.id]) {
        const memberId = document.getElementById('accomMemberSelect')?.value;
        if (!memberId) return;
        acc.assignments = acc.assignments || [];
        let stay = acc.assignments.find((s) => s.memberId === memberId);
        if (!stay) {
          stay = {
            memberId,
            checkIn: '',
            checkOut: '',
            budget: '',
            budgetActual: '',
            purchaseDate: '',
            currency: state.planner?.org?.sponsorCurrency || 'AUD',
            receiptId: '',
          };
          acc.assignments.push(stay);
          // Mark option with ✓ and show remove button
          const opt = accomModal.querySelector(
            `#accomMemberSelect option[value="${CSS.escape(memberId)}"]`,
          );
          if (opt && !opt.textContent.endsWith(' ✓')) opt.textContent += ' ✓';
          const removeBtn = document.getElementById('accomRemoveMemberBtn');
          if (removeBtn) removeBtn.classList.remove('opacity-0', 'pointer-events-none');
        }
        stay[MEMBER_FIELD_MAP[e.target.id]] = e.target.value;
      }
      scheduleAutoSave();
    }

    createModal('accommodationModal', {
      onSave: handleAccomField,
      onDelete: () => {
        const id = accomModal.dataset.accomId;
        state.planner.org.accommodations = (state.planner.org.accommodations || []).filter(
          (a) => a.id !== id,
        );
        scheduleAutoSave();
      },
      onClose: () => renderOrgTab(),
    }).wire();

    accomModal.addEventListener('click', (e) => {
      if (e.target.closest('#orgAccomLinkReceiptBtn')) {
        const acc = _currentOrgAccom();
        if (!acc) return;
        openReceiptPicker(state.planner, {
          onPick: (rid) => {
            linkEntityReceipt(acc, rid);
            scheduleAutoSave();
            renderOrgAccomReceiptStatus(acc);
            renderReceiptsTab();
          },
          onCreate: () => createReceiptForOrgAccom(),
        });
        return;
      }
      if (e.target.closest('#orgAccomCreateReceiptBtn')) {
        createReceiptForOrgAccom();
        return;
      }
      if (e.target.closest('#orgAccomViewReceiptBtn')) {
        const acc = _currentOrgAccom();
        hideModal('accommodationModal');
        renderOrgTab();
        setActiveTab('receipts');
        setTimeout(() => {
          const el = acc?.receiptId
            ? document.querySelector(`details[data-receipt-id="${acc.receiptId}"]`)
            : null;
          el?.setAttribute('open', '');
          el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 50);
        return;
      }
      if (e.target.closest('#orgAccomUnlinkReceiptBtn')) {
        const acc = _currentOrgAccom();
        if (acc) {
          unlinkEntityReceipt(acc);
          scheduleAutoSave();
          renderOrgAccomReceiptStatus(acc);
        }
        return;
      }
      if (e.target.closest('#accomMemberLinkReceiptBtn')) {
        const stay = _currentAccomStay();
        if (!stay) return;
        openReceiptPicker(state.planner, {
          onPick: (rid) => {
            linkEntityReceipt(stay, rid);
            scheduleAutoSave();
            renderAccomStayReceiptStatus(_currentOrgAccom(), stay.memberId);
            renderReceiptsTab();
          },
          onCreate: () => createReceiptForAccomStay(),
        });
        return;
      }
      if (e.target.closest('#accomMemberCreateReceiptBtn')) {
        createReceiptForAccomStay();
        return;
      }
      if (e.target.closest('#accomMemberViewReceiptBtn')) {
        const stay = _currentAccomStay();
        hideModal('accommodationModal');
        renderOrgTab();
        setActiveTab('receipts');
        setTimeout(() => {
          const el = stay?.receiptId
            ? document.querySelector(`details[data-receipt-id="${stay.receiptId}"]`)
            : null;
          el?.setAttribute('open', '');
          el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 50);
        return;
      }
      if (e.target.closest('#accomMemberUnlinkReceiptBtn')) {
        const acc = _currentOrgAccom();
        const stay = _currentAccomStay();
        if (stay) {
          unlinkEntityReceipt(stay);
          scheduleAutoSave();
          renderAccomStayReceiptStatus(acc, stay.memberId);
        }
        return;
      }
    });

    document.getElementById('accomMemberSelect')?.addEventListener('change', (e) => {
      const acc = getAccom();
      if (!acc) return;
      const memberId = e.target.value;
      if (memberId) {
        acc.assignments = acc.assignments || [];
        if (!acc.assignments.find((s) => s.memberId === memberId)) {
          acc.assignments.push({
            memberId,
            checkIn: '',
            checkOut: '',
            budget: '',
            budgetActual: '',
            currency: state.planner?.org?.sponsorCurrency || 'AUD',
            receiptId: '',
          });
          const opt = accomModal.querySelector(
            `#accomMemberSelect option[value="${CSS.escape(memberId)}"]`,
          );
          if (opt && !opt.textContent.endsWith(' ✓')) opt.textContent += ' ✓';
          scheduleAutoSave();
        }
        loadMemberStayFields(acc, memberId);
      } else {
        document.getElementById('accomMemberFields')?.classList.add('hidden');
        const removeBtn = document.getElementById('accomRemoveMemberBtn');
        if (removeBtn) removeBtn.classList.add('opacity-0', 'pointer-events-none');
      }
    });

    document.getElementById('accomRemoveMemberBtn')?.addEventListener('click', () => {
      const acc = getAccom();
      if (!acc) return;
      const select = document.getElementById('accomMemberSelect');
      const memberId = select?.value;
      if (!memberId) return;
      acc.assignments = (acc.assignments || []).filter((s) => s.memberId !== memberId);
      // Strip ✓ from the option
      const opt = select.querySelector(`option[value="${CSS.escape(memberId)}"]`);
      if (opt) opt.textContent = opt.textContent.replace(' ✓', '');
      // Clear fields and hide remove button
      [
        'accomMemberCheckIn',
        'accomMemberCheckOut',
        'accomMemberBudget',
        'accomMemberActual',
      ].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });
      const currEl = document.getElementById('accomMemberCurrency');
      if (currEl) currEl.innerHTML = currencyOptions('AUD');
      const removeBtn = document.getElementById('accomRemoveMemberBtn');
      if (removeBtn) removeBtn.classList.add('opacity-0', 'pointer-events-none');
      scheduleAutoSave();
    });

    document.getElementById('accomAddWaypointStopBtn')?.addEventListener('click', () => {
      const acc = getAccom();
      if (!acc) return;
      acc.stops = [...(acc.stops || []), makeWaypointStop()];
      renderWaypointStops(acc.stops, 'accomWaypointStopsList', 'accomWaypointStopsEmpty');
      scheduleAutoSave();
    });

    document.getElementById('accomWaypointStopsList')?.addEventListener('input', (e) => {
      const field = e.target.dataset.stopField;
      if (!field) return;
      const legId = e.target.closest('[data-stop-id]')?.dataset.stopId;
      if (!legId) return;
      const acc = getAccom();
      if (!acc) return;
      const leg = (acc.stops || []).find((l) => l.id === legId);
      if (leg) {
        leg[field] = e.target.value;
        scheduleAutoSave();
      }
    });

    document.getElementById('accomWaypointStopsList')?.addEventListener('click', (e) => {
      if (!e.target.closest('.remove-waypoint-stop-btn')) return;
      const legId = e.target.closest('[data-stop-id]')?.dataset.stopId;
      if (!legId) return;
      const acc = getAccom();
      if (!acc) return;
      acc.stops = (acc.stops || []).filter((l) => l.id !== legId);
      renderWaypointStops(acc.stops, 'accomWaypointStopsList', 'accomWaypointStopsEmpty');
      scheduleAutoSave();
    });

    wireWaypointStopsDragDrop('accomWaypointStopsList', 'accomWaypointStopsEmpty', getAccom);
  }

  wireTrackedSessionSearch('sponsor');
}

// ── Personal contacts (global) + assignments ─────────────────────────────────
// Extracted to ./modules/plannerAssignments.js (initAssignments + personal
// contacts, trip-assignment/companion cards + modals, accommodation sections).

// ── Team tab (global team members) ───────────────────────────────────────────
// Extracted to ./modules/plannerTeam.js (initTeam / renderTeamTab /
// openTeamMemberModal / wireTeamPanel).

// ── Mode toggle (sponsor / personal) ─────────────────────────────────────────

// Human-readable labels used by the settings UI
const TAB_LABELS = {
  sponsor: 'Planner',
  team: 'Team',
  documents: 'Documents',
  tasks: 'Tasks',
  checklists: 'Checklists',
  contacts: 'Contacts',
  personal: 'Planner',
  notes: 'Notes',
  receipts: 'Receipts',
  tickets: 'Tickets',
  companions: 'Companions',
  budget: 'Budget',
  split: 'Shared costs',
  map: 'Map',
  weather: 'Weather',
  schedule: 'Conference Schedule',
  itinerary: 'Itinerary',
  summary: 'Summary',
  settings: 'Settings',
};

// One-line explanations shown under each tab's toggle in Settings, so it's clear
// what turning a tab on/off actually adds to the planner.
const TAB_DESCRIPTIONS = {
  personal: 'Your trip at a glance — travel legs, accommodation & timeline.',
  sponsor: 'Booth details, sponsorship info & sponsored sessions.',
  team: 'Team members and who’s assigned to this event.',
  companions: 'People travelling with you on this trip.',
  notes: 'Free-form notes and takeaways for the event.',
  contacts: 'Key people and their details, in one place.',
  tasks: 'To-dos with due dates to keep prep on track.',
  checklists: 'Reusable packing & prep lists you can tick off.',
  receipts: 'Log expenses and attach receipt files.',
  documents: 'Store tickets, PDFs and other trip files.',
  tickets: 'Passes and entry tickets you’re holding.',
  budget: 'Plan and track spend by category.',
  split: 'Share and split costs with your companions.',
  map: 'See travel, stays and venues on a map.',
  weather: 'A forecast for your destination across the trip dates.',
  schedule:
    'Events you host during the conference — booth demos, meetings — pinned alongside programme slots.',
  itinerary: 'A day-by-day schedule of everything planned.',
  summary: 'An at-a-glance overview and spend report.',
};

// Thin wrappers binding the pure tab logic (plannerTabs.js) to live state.
function getVisibleTabsOrdered(mode) {
  return visibleTabsOrdered(mode, state.planner);
}

function getVisibleTabs(mode) {
  return visibleTabs(mode, state.planner);
}

let _draggedTab = null;
let _tabMoreOpen = false;

function renderTabBar() {
  const mode = state.planner?.mode || 'personal';
  const ordered = getVisibleTabsOrdered(mode);
  const mainEl = document.getElementById('tabBarMain');
  if (!mainEl) return;

  mainEl.innerHTML = '';
  ordered.forEach((tab) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = TAB_BTN_IDS[tab];
    btn.dataset.tab = tab;
    btn.draggable = true;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-controls', PANEL_IDS[tab]);
    btn.setAttribute('aria-selected', state.activeTab === tab ? 'true' : 'false');
    btn.className = `editor-tab-button whitespace-nowrap flex-shrink-0${state.activeTab === tab ? ' is-active' : ''}`;
    btn.textContent = TAB_LABELS[tab] || tab;
    mainEl.appendChild(btn);
  });

  wireDragDrop(mainEl, mode);
  requestAnimationFrame(updateTabOverflow);
}

function updateTabOverflow() {
  const mainEl = document.getElementById('tabBarMain');
  const moreWrap = document.getElementById('tabBarMoreWrap');
  const moreBtnEl = document.getElementById('tabMoreBtn');
  const dropdown = document.getElementById('tabMoreDropdown');
  if (!mainEl || !moreWrap || !dropdown) return;

  const allBtns = [...mainEl.querySelectorAll('[data-tab]')];
  if (!allBtns.length) {
    moreWrap.classList.add('hidden');
    return;
  }

  // Reset state for measurement
  allBtns.forEach((b) => {
    b.style.display = '';
  });
  moreWrap.classList.add('hidden');

  const containerWidth = mainEl.getBoundingClientRect().width;
  const gap = 4;

  // Sum all button widths
  const widths = allBtns.map((b) => b.getBoundingClientRect().width + gap);
  const total = widths.reduce((s, w) => s + w, 0) - gap;

  if (total <= containerWidth + 1) {
    // Everything fits, no More button needed
    dropdown.innerHTML = '';
    _tabMoreOpen = false;
    return;
  }

  // Measure More button width
  moreWrap.classList.remove('hidden');
  const moreWidth = moreWrap.getBoundingClientRect().width + gap;
  moreWrap.classList.add('hidden');

  const usable = containerWidth - moreWidth;
  let accumulated = 0;
  let overflowIdx = 0;
  for (let i = 0; i < allBtns.length; i++) {
    if (accumulated + widths[i] <= usable + 1) {
      accumulated += widths[i];
      overflowIdx = i + 1;
    } else {
      break;
    }
  }

  moreWrap.classList.remove('hidden');
  moreBtnEl?.setAttribute('aria-expanded', String(_tabMoreOpen));
  dropdown.innerHTML = '';

  allBtns.forEach((btn, i) => {
    if (i >= overflowIdx) {
      btn.style.display = 'none';
      const item = document.createElement('button');
      item.type = 'button';
      item.dataset.tab = btn.dataset.tab;
      const isActive = state.activeTab === btn.dataset.tab;
      item.className = isActive ? 'is-active' : '';
      item.innerHTML = btn.innerHTML;
      dropdown.appendChild(item);
    }
  });

  if (!_tabMoreOpen) dropdown.classList.add('hidden');
}

function wireDragDrop(mainEl, mode) {
  mainEl.addEventListener(
    'dragstart',
    (e) => {
      const btn = e.target.closest('[data-tab]');
      if (!btn) return;
      _draggedTab = btn.dataset.tab;
      btn.classList.add('tab-drag-source');
      e.dataTransfer.effectAllowed = 'move';
    },
    { passive: true },
  );

  mainEl.addEventListener(
    'dragend',
    () => {
      _draggedTab = null;
      mainEl
        .querySelectorAll('.tab-drag-source, .tab-drop-before, .tab-drop-after')
        .forEach((el) =>
          el.classList.remove('tab-drag-source', 'tab-drop-before', 'tab-drop-after'),
        );
    },
    { passive: true },
  );

  mainEl.addEventListener('dragover', (e) => {
    if (!_draggedTab) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const target = e.target.closest('[data-tab]');
    mainEl
      .querySelectorAll('.tab-drop-before, .tab-drop-after')
      .forEach((el) => el.classList.remove('tab-drop-before', 'tab-drop-after'));
    if (target && target.dataset.tab !== _draggedTab) {
      const rect = target.getBoundingClientRect();
      const before = e.clientX < rect.left + rect.width / 2;
      target.classList.add(before ? 'tab-drop-before' : 'tab-drop-after');
    }
  });

  mainEl.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!_draggedTab) return;
    const target = e.target.closest('[data-tab]');
    if (!target || target.dataset.tab === _draggedTab) return;

    const rect = target.getBoundingClientRect();
    const before = e.clientX < rect.left + target.getBoundingClientRect().width / 2;
    const ordered = getVisibleTabsOrdered(mode);
    const from = ordered.indexOf(_draggedTab);
    const to = ordered.indexOf(target.dataset.tab);
    if (from === -1 || to === -1) return;

    const newOrder = [...ordered];
    newOrder.splice(from, 1);
    const insertAt = before ? to - (from < to ? 1 : 0) : to + (from > to ? 1 : 0);
    newOrder.splice(Math.max(0, insertAt), 0, _draggedTab);

    // Persist full tab list order (including disabled tabs) so disabled→re-enabled tabs keep position
    const fullBase = mode === 'sponsor' ? SPONSOR_TABS_BASE : PERSONAL_TABS_BASE;
    const disabled = new Set(
      mode === 'sponsor'
        ? state.planner?.org?.disabledTabs || []
        : state.planner?.personal?.disabledTabs || [],
    );
    const finalOrder = [
      ...newOrder,
      ...[...fullBase].filter((t) => disabled.has(t) && !newOrder.includes(t)),
    ];

    if (mode === 'sponsor') state.planner.org.tabOrder = finalOrder;
    else state.planner.personal.tabOrder = finalOrder;
    scheduleAutoSave();
    renderTabBar();
  });
}

function applyConferenceMode() {
  const isConference = state.planner?.isConference !== false;
  ['sponsorTrackedSessionsSection', 'personalTrackedSessionsSection'].forEach((id) => {
    document.getElementById(id)?.classList.toggle('hidden', !isConference);
  });
  renderTabBar();
  const mode = state.planner?.mode || 'personal';
  if (!getVisibleTabs(mode).has(state.activeTab)) {
    // A correction, not a navigation: the tab you were on stopped existing.
    // Pushing here would put an unreachable state in the history.
    setActiveTab(getVisibleTabsOrdered(mode)[0] || 'settings', { push: false });
  }
  renderMobileBottomBar();
}

function applyMode(mode) {
  state.planner.mode = mode;
  savePlanner(state.plannerKey, state.planner);

  const isSponsor = mode === 'sponsor';
  const visibleTabs = getVisibleTabs(mode);

  renderTabBar();
  renderSidebar();

  // Update header mode label and subtitle
  const suffix = document.getElementById('plannerHeaderSuffix');
  if (suffix) suffix.textContent = isSponsor ? 'Sponsor' : 'Personal';
  const subtitle = document.getElementById('plannerModeSubtitle');
  if (subtitle)
    subtitle.textContent = isSponsor
      ? 'Your sponsor notebook for this event.'
      : 'Your personal notebook for this event.';

  // Sync the settings panel mode radio buttons
  const modePersonalRadio = document.getElementById('settingsModePersonal');
  const modeSponsorRadio = document.getElementById('settingsModeSponsor');
  if (modePersonalRadio) modePersonalRadio.checked = !isSponsor;
  if (modeSponsorRadio) modeSponsorRadio.checked = isSponsor;

  // Move off the current tab if it isn't available in this mode — again a
  // correction rather than a navigation.
  const cur = state.activeTab;
  if (!visibleTabs.has(cur)) {
    setActiveTab(isSponsor ? 'sponsor' : 'personal', { push: false });
  }

  // Re-render summary if it's visible (stats differ by mode)
  if (state.activeTab === 'summary') renderSummaryTab();
  if (state.activeTab === 'settings') renderSettingsTab();
}

// ── Documents tab ────────────────────────────────────────────────────────────
// Extracted to ./modules/plannerDocuments.js (initDocuments / renderDocumentsTab /
// wireDocumentsPanel).

// ── Companions tab ────────────────────────────────────────────────────────────
// Extracted to ./modules/plannerCompanions.js (initCompanions / renderCompanionsTab /
// wireCompanionsPanel / localCompanionCardHtml / makeLocalCompanion).

// ── Map tab ───────────────────────────────────────────────────────────────────
// Extracted to ./modules/plannerMap.js (initMap / renderMapTab / wireMapPanel).

const TAB_EXTRA_RENDERS = {
  checklists: () => renderChecklistsTab(),
  sponsor: () => renderSponsorBudgetBreakdown(),
  personal: () => renderPersonalBudgetBreakdown(),
  notes: () => {
    renderNotesTab();
    renderPersonalNotes(); // trip notes now live on the Notes page alongside session notes
  },
  tickets: () => renderTicketsTab(),
  companions: () => renderCompanionsTab(),
  budget: () => renderBudgetTab(),
  documents: () => renderDocumentsTab(),
  split: () => renderSplitTab(),
  map: () => renderMapTab(),
  weather: () => renderWeatherTab(),
  schedule: () => renderScheduleTab(),
  itinerary: () => renderPersonalItineraryTab(),
  summary: () => renderSummaryTab(),
  settings: () => renderSettingsTab(),
};

function wireToolbar() {
  // Tab bar: delegated click handler covers main bar, Settings pin, and overflow dropdown
  document.getElementById('plannerTabBar')?.addEventListener('click', (e) => {
    // More button toggle
    if (e.target.closest('#tabMoreBtn')) {
      _tabMoreOpen = !_tabMoreOpen;
      const dropdown = document.getElementById('tabMoreDropdown');
      document.getElementById('tabMoreBtn')?.setAttribute('aria-expanded', String(_tabMoreOpen));
      dropdown?.classList.toggle('hidden', !_tabMoreOpen);
      document.getElementById('tabMoreChevron')?.classList.toggle('rotate-180', _tabMoreOpen);
      return;
    }
    const btn = e.target.closest('[data-tab]');
    if (!btn || btn.id === 'tabMoreBtn') return;
    const tab = btn.dataset.tab;
    setActiveTab(tab);
    TAB_EXTRA_RENDERS[tab]?.();
    // Close More dropdown after selection
    _tabMoreOpen = false;
    document.getElementById('tabMoreDropdown')?.classList.add('hidden');
    document.getElementById('tabMoreChevron')?.classList.remove('rotate-180');
  });
  // Close More dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (_tabMoreOpen && !e.target.closest('#tabBarMoreWrap')) {
      _tabMoreOpen = false;
      document.getElementById('tabMoreDropdown')?.classList.add('hidden');
      document.getElementById('tabMoreChevron')?.classList.remove('rotate-180');
      document.getElementById('tabMoreBtn')?.setAttribute('aria-expanded', 'false');
    }
  });

  // Mode toggle
  // Mode is now changed via the Settings tab radio buttons

  // Export / import / save-to-file
  document.getElementById('plannerExportBtn')?.addEventListener('click', handleExport);

  // Calendar export (whole-trip .ics) — button opens the include-toggles modal.
  document
    .getElementById('plannerCalExportBtn')
    ?.addEventListener('click', openCalendarExportModal);
  document.getElementById('calExportDownload')?.addEventListener('click', downloadTripIcs);
  document.getElementById('calSubCreate')?.addEventListener('click', createFeedToken);
  document.getElementById('calSubCopy')?.addEventListener('click', copyFeedUrl);
  // Delegated: the revoke buttons are rebuilt every time the list renders.
  document.getElementById('calSubList')?.addEventListener('click', (e) => {
    const id = e.target.closest('[data-revoke-feed]')?.dataset.revokeFeed;
    if (id) void revokeFeedToken(id);
  });
  // Read-only URL: focusing it selects the whole link so it's easy to copy by hand.
  document.getElementById('calSubUrl')?.addEventListener('focus', (e) => e.target.select());
  const calExportModal = document.getElementById('calendarExportModal');
  document
    .getElementById('calExportClose')
    ?.addEventListener('click', () => hideModal('calendarExportModal'));
  calExportModal?.addEventListener('click', (e) => {
    if (e.target === calExportModal) hideModal('calendarExportModal');
  });

  const importBtn = document.getElementById('plannerImportBtn');
  const importInput = document.getElementById('plannerImportInput');
  importBtn?.addEventListener('click', () => importInput?.click());
  importInput?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) {
      handleImport(file);
      e.target.value = '';
    }
  });

  document.getElementById('plannerSaveFileBtn')?.addEventListener('click', handleSaveToFile);
  // New planner wiring is in wireCreatePlannerModal; disassociate is in wireManageEventBtn

  // Recalculate tab overflow whenever the tab bar container is resized
  const tabBarMain = document.getElementById('tabBarMain');
  if (tabBarMain && typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => updateTabOverflow()).observe(tabBarMain);
  }
}

// ── Sidebar navigation ────────────────────────────────────────────────────────

const SIDEBAR_GROUPS = [
  { label: 'Plan', tabs: ['personal', 'schedule', 'itinerary', 'map', 'weather'] },
  { label: 'Org', tabs: ['sponsor', 'team', 'companions'] },
  {
    label: 'Admin',
    tabs: [
      'tasks',
      'checklists',
      'contacts',
      'budget',
      'split',
      'receipts',
      'tickets',
      'documents',
    ],
  },
  { label: 'Reference', tabs: ['notes', 'summary'] },
  { label: '', tabs: ['settings'] },
];

function navMeta(tab) {
  return {
    label: TAB_LABELS[tab] || tab,
  };
}

function renderSidebar() {
  const nav = document.getElementById('sidebarNav');
  if (!nav) return;
  const mode = state.planner?.mode || 'personal';
  const visible = getVisibleTabs(mode);

  nav.innerHTML = SIDEBAR_GROUPS.map(({ label, tabs }) => {
    const rows = tabs.filter((t) => visible.has(t));
    if (!rows.length) return '';
    return `<div class="sidebar-group">
      ${label ? `<span class="sidebar-group-label">${esc(label)}</span>` : ''}
      ${rows
        .map(
          (tab) => `
        <button type="button" data-tab="${esc(tab)}" class="sidebar-tab-btn">
          <span class="sidebar-item-icon pln-code" aria-hidden="true">${esc(TAB_CODES[tab] || '??')}</span>
          <span class="sidebar-label">${esc(TAB_LABELS[tab] || tab)}</span>
        </button>`,
        )
        .join('')}
    </div>`;
  })
    .filter(Boolean)
    .join('');

  // Sync active state on freshly rendered buttons
  nav.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.tab === state.activeTab);
  });
}

function _syncSidebarDirty(flag) {
  const icon = document.getElementById('sidebarDirtyIcon');
  const label = document.getElementById('sidebarDirtyText');
  if (!icon || !label) return;
  // The dot is drawn in CSS; only its state changes here. Saved/unsaved is real
  // state, so it is one of the few places colour is allowed to carry meaning.
  icon.className = `sidebar-dirty-dot${flag ? ' is-dirty' : ''}`;
  label.textContent = flag ? 'Unsaved' : 'Saved';
}

let _sidebarCollapsed = readText(STORAGE_KEYS.sidebarCollapsed) === '1';

function applySidebarCollapse() {
  const sidebar = document.getElementById('plannerSidebar');
  if (!sidebar) return;
  sidebar.classList.toggle('sidebar-collapsed', _sidebarCollapsed);
  // A drawn chevron, not an icon-font glyph.
  const icon = document.getElementById('sidebarToggleIcon');
  if (icon) icon.textContent = _sidebarCollapsed ? '\u00bb' : '\u00ab';
}

function toggleSidebar() {
  _sidebarCollapsed = !_sidebarCollapsed;
  writeText(STORAGE_KEYS.sidebarCollapsed, _sidebarCollapsed ? '1' : '0');
  applySidebarCollapse();
}

function wireSidebar() {
  document.getElementById('sidebarToggleBtn')?.addEventListener('click', toggleSidebar);

  // Tab navigation: delegate on the whole sidebar so sidebarNav + sidebarFooter are covered
  document.getElementById('plannerSidebar')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]');
    if (!btn || btn === document.getElementById('sidebarToggleBtn')) return;
    const tab = btn.dataset.tab;
    if (!TABS.includes(tab)) return;
    setActiveTab(tab);
    TAB_EXTRA_RENDERS[tab]?.();
  });

  // Editor link: only visible on localhost
  if (isLocalhost()) document.getElementById('sidebarEditorLink')?.classList.remove('hidden');
  applySidebarCollapse();
}

// ── Mobile tab navigation ─────────────────────────────────────────────────────

function renderMobileTabNav() {
  const label = document.getElementById('mobileTabLabel');
  if (label) label.textContent = TAB_LABELS[state.activeTab] || state.activeTab;
  renderMobileBottomBar();
}

function renderMobileBottomBar() {
  const bar = document.getElementById('mobileBottomBar');
  if (!bar) return;

  const mode = state.planner?.mode || 'personal';
  const allTabs = [...getVisibleTabsOrdered(mode), 'settings'];
  const primary = bottomBarPrimary(mode, allTabs);

  bar.innerHTML = bottomBarHtml({ primary, activeTab: state.activeTab, meta: navMeta });

  bar.querySelectorAll('[data-nav-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.navTab;
      setActiveTab(tab);
      TAB_EXTRA_RENDERS[tab]?.();
    });
  });
  bar.querySelector('[data-nav-more]')?.addEventListener('click', openMobileTabSheet);
}

function openMobileTabSheet() {
  const sheet = document.getElementById('mobileTabSheet');
  const list = document.getElementById('mobileTabSheetList');
  if (!sheet || !list) return;

  const mode = state.planner?.mode || 'personal';
  const allTabs = [...getVisibleTabsOrdered(mode), 'settings'];
  const primary = bottomBarPrimary(mode, allTabs);
  const visible = new Set(allTabs);
  const groups = SIDEBAR_GROUPS.map((g) => ({
    label: g.label,
    tabs: g.tabs.filter((t) => visible.has(t)),
  }));
  const footer = [
    { href: './index.html', label: 'Schedule' },
    ...(isLocalhost() ? [{ href: './editor.html', label: 'Dataset Editor' }] : []),
  ];

  list.innerHTML = moreSheetHtml({
    groups,
    primary,
    activeTab: state.activeTab,
    meta: navMeta,
    footer,
  });
  // Row clicks are handled by the delegated listener in wireMobileTabNav().

  sheet.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeMobileTabSheet() {
  const sheet = document.getElementById('mobileTabSheet');
  if (sheet) sheet.classList.add('hidden');
  document.body.style.overflow = '';
}

function wirePlannerActionsSheet() {
  const sheet = document.getElementById('plannerActionsSheet');
  if (!sheet) return;

  function open() {
    const name = state.planner?._displayName || state.plannerKey || 'Planner';
    const title = document.getElementById('plannerActionsSheetTitle');
    if (title) title.textContent = name;
    sheet.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }

  function close() {
    sheet.classList.add('hidden');
    document.body.style.overflow = '';
  }

  document.getElementById('plannerActionsBtn')?.addEventListener('click', open);
  document.getElementById('plannerActionsSheetClose')?.addEventListener('click', close);
  sheet.addEventListener('click', (e) => {
    if (e.target === sheet) close();
  });

  document.getElementById('plannerActionsNew')?.addEventListener('click', () => {
    close();
    openCreatePlannerModal();
  });
  // Each row forwards to the button that owns the behaviour, so the menu adds
  // no second implementation of anything.
  document.getElementById('plannerActionsSave')?.addEventListener('click', () => {
    close();
    document.getElementById('plannerSaveFileBtn')?.click();
  });
  document.getElementById('plannerActionsCalendar')?.addEventListener('click', () => {
    close();
    document.getElementById('plannerCalExportBtn')?.click();
  });
  document.getElementById('plannerActionsBackup')?.addEventListener('click', () => {
    close();
    document.getElementById('plannerExportBtn')?.click();
  });
  document.getElementById('plannerActionsRestore')?.addEventListener('click', () => {
    close();
    document.getElementById('plannerImportBtn')?.click();
  });
  document.getElementById('plannerActionsDelete')?.addEventListener('click', () => {
    close();
    // Show native delete confirmation sheet (bypasses window.confirm on mobile)
    const deleteSheet = document.getElementById('plannerDeleteSheet');
    const nameEl = document.getElementById('plannerDeleteSheetName');
    const name = state.planner?._displayName || state.plannerKey || 'this planner';
    if (nameEl) nameEl.textContent = name;
    if (deleteSheet) {
      deleteSheet.classList.remove('hidden');
      document.body.style.overflow = 'hidden';
    }
  });

  // Delete confirmation sheet wiring
  const deleteSheet = document.getElementById('plannerDeleteSheet');
  document.getElementById('plannerDeleteSheetCancel')?.addEventListener('click', () => {
    deleteSheet?.classList.add('hidden');
    document.body.style.overflow = '';
  });
  deleteSheet?.addEventListener('click', (e) => {
    if (e.target === deleteSheet) {
      deleteSheet.classList.add('hidden');
      document.body.style.overflow = '';
    }
  });
  document.getElementById('plannerDeleteSheetConfirm')?.addEventListener('click', async () => {
    deleteSheet?.classList.add('hidden');
    document.body.style.overflow = '';
    await deletePlannerBySlug(state.plannerKey);
    location.href = 'planner.html';
  });
}

function wireMobileTabNav() {
  document.getElementById('mobileTabMenuBtn')?.addEventListener('click', openMobileTabSheet);
  document.getElementById('mobileTabSheetClose')?.addEventListener('click', closeMobileTabSheet);

  document.getElementById('mobileTabSheet')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
      closeMobileTabSheet();
      return;
    }
    const btn = e.target.closest('[data-nav-tab]');
    if (!btn) return;
    const tab = btn.dataset.navTab;
    setActiveTab(tab);
    TAB_EXTRA_RENDERS[tab]?.();
    closeMobileTabSheet();
  });
}

// ── Collapsible sections ─────────────────────────────────────────────────────

const _COLLAPSE_KEY = STORAGE_KEYS.sectionCollapse;

function _getCollapseState() {
  return readJson(_COLLAPSE_KEY, {});
}

function _saveCollapseState(state_) {
  writeJson(_COLLAPSE_KEY, state_);
}

function initCollapsibleSections() {
  const collapsed = _getCollapseState();
  document.querySelectorAll('[data-collapse]').forEach((section) => {
    const key = section.dataset.collapse;
    const body = section.querySelector(`[data-collapse-body="${key}"]`);
    const h3 = section.querySelector('h3');
    if (!body || !h3) return;

    // A drawn caret, prepended to the heading. It used to be an empty Font
    // Awesome <i>: invisible, but still a flex sibling — which is why every
    // collapsible heading sat pushed to the far end of its own rule.
    const chevron = document.createElement('span');
    chevron.className = 'section-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.textContent = '\u25be';
    h3.prepend(chevron);
    h3.style.cursor = 'pointer';
    h3.title = 'Click to collapse';

    const apply = (isCollapsed) => {
      body.classList.toggle('hidden', isCollapsed);
      chevron.style.transform = isCollapsed ? 'rotate(-90deg)' : '';
      h3.title = isCollapsed ? 'Click to expand' : 'Click to collapse';
    };

    apply(!!collapsed[key]);

    h3.addEventListener('click', () => {
      const cs = _getCollapseState();
      const next = !cs[key];
      if (next) cs[key] = true;
      else delete cs[key];
      _saveCollapseState(cs);
      apply(next);
    });
  });
}

// ── Conflict detection ────────────────────────────────────────────────────────

function renderPersonalConflicts() {
  const banner = document.getElementById('personalConflictBanner');
  if (!banner) return;
  const personal = state.planner?.personal;
  const conflicts = detectPersonalConflicts(personal);
  if (!conflicts.length) {
    banner.classList.add('hidden');
    return;
  }
  const gaps = accommodationGaps(personal);

  const icons = {
    error: 'fa-circle-exclamation text-red-500',
    warning: 'fa-triangle-exclamation text-amber-500',
  };
  banner.innerHTML = conflicts
    .map((c) => {
      // The accommodation-gap warning gets an inline "Add accommodation" CTA that
      // seeds a stay covering the first gap run (reuses the agenda gap handler).
      const cta =
        /without accommodation/.test(c.msg) && gaps.length
          ? `<button type="button" class="agenda-add-accom ml-1 inline-flex items-center h-6 px-2 rounded border pl-rule-warn pl-warn text-[0.7rem] font-medium transition-colors align-middle"
          data-gap-checkin="${esc(gaps[0].date)}" data-gap-checkout="${esc(gaps[0].checkOut)}">
          Add accommodation</button>`
          : '';
      return `<div class="flex items-start gap-2 text-xs py-1">
      <i class="fas ${icons[c.sev]} flex-shrink-0 mt-0.5"></i>
      <span class="${c.sev === 'error' ? 'pl-req' : 'pl-warn'}">${esc(c.msg)}${cta}</span>
    </div>`;
    })
    .join('');
  banner.classList.remove('hidden');
}

// ── Mobile itinerary tab ──────────────────────────────────────────────────────

// Day-by-day agenda, shared by the dedicated Itinerary tab and the mobile
// Timeline slot in the Personal overview (the horizontal Gantt is desktop-only —
// a sideways-scrolling grid is out of place on a phone). Pure string builder.
function dayAgendaHtml(precomputed) {
  const days =
    precomputed ||
    buildDayItinerary({
      personal: state.planner?.personal,
      allSessions: state.allSessions,
      timezone: getTimezone(),
      fmtTime,
      eventMeta: state.eventMeta,
      events: state.events,
      isConference: state.planner?.isConference !== false,
    });

  if (!days.length) {
    return `
      <div class="jrn-empty">
        <p class="jrn-empty-t">Your journey starts here</p>
        <p class="jrn-empty-s">Add travel, a place to stay, or a plan of your own to build the day-by-day line.</p>
        <button type="button" class="agenda-add-item jrn-empty-btn">
          Add the first thing
        </button>
      </div>`;
  }

  const todayStr = localDateStr(new Date());

  // Each day is a threaded timeline of moments — the thread is the point, and
  // it survives the rebrand. What changed is what it is drawn WITH: a hairline
  // spine and square nodes instead of a gradient rail and coloured discs.
  //
  // Nodes carry ONE distinction, because only one is worth carrying: a filled
  // node is a moment you chose (an itinerary item, an event you host); a hollow
  // node is scaffold the planner derived for you (a flight, a stay, a session
  // you tracked). The five type-hues that used to sit on top of that said
  // nothing the row's own text does not already say.
  return days
    .map((day) => {
      const d = new Date(day.date + 'T00:00:00');
      const validDate = !Number.isNaN(d.getTime());
      const eyebrow = validDate ? d.toLocaleDateString(undefined, { weekday: 'short' }) : '';
      const datePart = validDate
        ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
        : day.label;
      const isToday = day.date === todayStr;
      const planCount = day.events.filter((ev) => ev.type === 'item').length;

      const body =
        day.events.length === 0
          ? `<button type="button" class="jrn-free agenda-day-add" data-agenda-day="${esc(day.date)}" aria-label="Plan something on ${esc(datePart)}">
            <span class="jrn-free-dot" aria-hidden="true"></span>
            <span class="min-w-0">
              <span class="jrn-free-t block">Free day — plan something</span>
              <span class="jrn-free-s block">A tour, a meal, or some well-earned downtime.</span>
            </span>
            <span class="jrn-free-go" aria-hidden="true">&rsaquo;</span>
          </button>`
          : `<div class="jrn-line">${day.events
              .map((ev) => {
                if (ev.type === 'gap') {
                  return `
          <div class="jrn-moment jrn-moment--gap">
            <span class="jrn-time jrn-time--none">&mdash;</span>
            <span class="jrn-node" aria-hidden="true"></span>
            <div class="jrn-body">
              <p class="jrn-title">No stay booked</p>
              <p class="jrn-sub">Nowhere to sleep this night.</p>
            </div>
            <div class="jrn-acts">
              <button type="button" class="agenda-add-accom jrn-act" data-gap-checkin="${esc(ev.checkIn)}" data-gap-checkout="${esc(ev.checkOut)}" aria-label="Add a stay this night">Add a stay</button>
            </div>
          </div>`;
                }
                const isItem = ev.type === 'item';
                const isHosted = ev.type === 'hosted';
                const avatars = isItem || isHosted ? personalAssigneeChips(ev.memberIds) : [];
                const done = (isItem || isHosted) && ev.done;
                // Every entry with a resolvable record is clickable → its read-only
                // detail view. The data-view-* mapping is shared with the calendar
                // view via viewAttrsFor (plannerCalendarView.js).
                const clickable = isClickableEvent(ev);
                const viewAttrs = viewAttrsFor(ev, day.date);
                return `
          <div class="jrn-moment jrn-moment--${esc(ev.type)}${done ? ' jrn-moment--done' : ''}${clickable ? ' jrn-moment--view' : ''}"${viewAttrs}>
            <span class="jrn-time${ev.time ? '' : ' jrn-time--none'}">${ev.time ? esc(ev.time) : '·'}</span>
            <span class="jrn-node jrn-node--${esc(ev.type)}" aria-hidden="true"></span>
            <div class="jrn-body">
              <p class="jrn-title">${esc(ev.label)}</p>
              ${ev.sub ? `<p class="jrn-sub truncate">${esc(ev.sub)}</p>` : ''}
              ${avatars.length ? `<div class="pl-avatars">${avatars.map((a) => `<span class="pl-avatar" title="${esc(a.name)}">${esc(a.initial)}</span>`).join('')}</div>` : ''}
            </div>
            ${
              isItem
                ? `<div class="jrn-acts">
              <button type="button" class="agenda-item-cal-btn jrn-act" data-agenda-item-id="${esc(ev.id)}" aria-label="Add ${esc(ev.label)} to a calendar">Calendar</button>
            </div>`
                : ev.type === 'travel' && ev.legId
                  ? `<div class="jrn-acts">
              <button type="button" class="agenda-leg-cal-btn jrn-act" data-leg-id="${esc(ev.legId)}" data-leg-dir="${esc(ev.legDir)}" aria-label="Add ${esc(ev.label)} to a calendar">Calendar</button>
            </div>`
                  : ''
            }
          </div>`;
              })
              .join('')}</div>`;

      return `
    <div class="itin-day jrn-day${isToday ? ' jrn-day--today' : ''}">
      <div class="jrn-head">
        <div class="jrn-head-l">
          <span class="jrn-eyebrow">${esc(eyebrow)}</span>
          <span class="jrn-date">${esc(datePart)}</span>
          <span class="itin-wx" data-wx-day="${esc(day.date)}"></span>
          ${planCount ? `<span class="jrn-count">${planCount} planned</span>` : ''}
        </div>
        <button type="button" class="agenda-day-add jrn-add" data-agenda-day="${esc(day.date)}" aria-label="Add itinerary item on ${esc(datePart)}">Add</button>
      </div>
      ${body}
    </div>`;
    })
    .join('');
}

function renderPersonalItineraryTab() {
  const days = buildDayItinerary({
    personal: state.planner?.personal,
    allSessions: state.allSessions,
    timezone: getTimezone(),
    fmtTime,
    eventMeta: state.eventMeta,
    events: state.events,
    isConference: state.planner?.isConference !== false,
  });
  // The Journey Line self-renders its own empty state, so this surface always
  // renders (hasItems defaults true). Weather chips only exist in list markup.
  renderSurfaceView('itineraryDayList', 'itinerary', {
    days,
    listHtml: dayAgendaHtml(days),
    calOpts: { todayStr: localDateStr(new Date()) },
    onList: renderItineraryWeather,
  });
}

// ── Personal itinerary single-item editor ────────────────────────────────────
// One focused modal per item (add or edit) with multi-person assignment — the
// replacement for the old per-day list-manager. Wired in wireItineraryPanel().
let _personalItinId = null;

// The personal itinerary-item modal's static fields, resolved once (see personalAccomEls).
let _personalItinEls = null;
function personalItinEls() {
  return (_personalItinEls ??= {
    modal: document.getElementById('personalItineraryItemModal'),
    modalTitle: document.getElementById('personalItinModalTitle'),
    modalSubtitle: document.getElementById('personalItinModalSubtitle'),
    title: document.getElementById('personalItinTitle'),
    date: document.getElementById('personalItinDate'),
    time: document.getElementById('personalItinTime'),
    end: document.getElementById('personalItinEnd'),
    tz: document.getElementById('personalItinTz'),
    location: document.getElementById('personalItinLocation'),
    coords: document.getElementById('personalItinCoords'),
    notes: document.getElementById('personalItinNotes'),
    done: document.getElementById('personalItinDone'),
    delete: document.getElementById('personalItinDelete'),
  });
}

// Fill the itinerary-item timezone picker: a "Trip timezone" default (inherits the
// event's zone, or floating when none) plus the full IANA list. `selected` is the
// item's stored override ('' = inherit).
function populateItinTimezone(selected) {
  const m = personalItinEls();
  if (!m.tz) return;
  const tripTz = getTimezone();
  let zones = [];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    zones = [];
  }
  if (!zones.length) {
    // Minimal fallback for engines without supportedValuesOf.
    zones = [tripTz, 'UTC', 'Europe/London', 'Europe/Amsterdam', 'America/New_York'].filter(
      Boolean,
    );
  }
  const defLabel = tripTz ? `Trip timezone (${tripTz})` : 'Trip timezone / floating';
  m.tz.innerHTML =
    `<option value="">${escapeHtml(defLabel)}</option>` +
    zones.map((z) => `<option value="${escapeHtml(z)}">${escapeHtml(z)}</option>`).join('');
  m.tz.value = selected || '';
}

function openPersonalItineraryItemModal(id = null, defaultDate = '') {
  const m = personalItinEls();
  if (!m.modal) return;
  const personal = state.planner?.personal;
  _personalItinId = id;
  const item = id ? (personal?.itinerary || []).find((i) => i.id === id) : null;
  const d = item?.date || defaultDate || '';

  m.modalTitle.textContent = id ? 'Edit itinerary item' : 'Add itinerary item';
  m.modalSubtitle.textContent = d
    ? new Date(d + 'T00:00:00').toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      })
    : 'Pick a date below';

  m.title.value = item?.title || '';
  m.date.value = d;
  m.time.value = item?.time || '';
  if (m.end) m.end.value = item?.endTime || '';
  populateItinTimezone(item?.timezone || '');
  m.location.value = item?.location || '';
  if (m.coords) m.coords.value = item?.coords || '';
  m.notes.value = item?.notes || '';
  m.done.checked = !!item?.done;

  _renderPersonalItinAssignChips(item?.memberIds || []);
  renderPersonalItinReceiptStatus(item);
  m.delete.classList.toggle('hidden', !id);
  showModal('personalItineraryItemModal', 'personalItinTitle');
}

// The Receipt block in the itinerary modal — uses the shared entity-receipt
// mechanism. Cost moves to Receipts: when a receipt is linked, the item's actual
// is taken from that receipt (see buildPersonalBudgetData). A brand-new (unsaved)
// item must be saved first, so the receipt has an item to attach to.
function renderPersonalItinReceiptStatus(item) {
  renderEntityReceiptStatus(document.getElementById('personalItinReceiptStatus'), {
    receipt: linkedReceipt(state.planner, item),
    idPrefix: 'personalItin',
    canLink: !!_personalItinId,
    unsavedHint: 'Save this item first to move its cost to a receipt.',
  });
}

// Create a receipt for the itinerary item and open it so cost is entered there (the
// single home for money). Closes the itinerary modal to avoid modal stacking.
function createReceiptForItinerary() {
  const personal = state.planner?.personal;
  const item = personal?.itinerary?.find((i) => i.id === _personalItinId);
  if (!item) return;
  const m = personalItinEls();
  const receipt = createReceiptForEntity(state.planner, item, {
    name: m.title.value.trim() || item.title || 'Itinerary item',
    date: m.date.value || item.date || '',
    currency: personal?.currency || 'AUD',
    category: 'misc', // itinerary items land in Misc in the budget summary
  });
  scheduleAutoSave();
  renderReceiptsTab();
  renderPersonalBudgetBreakdown();
  renderSummaryTab();
  hideModal('personalItineraryItemModal');
  openReceiptModal(receipt.id);
}

function _renderPersonalItinAssignChips(selectedIds) {
  const wrap = document.getElementById('personalItinAssignChips');
  if (!wrap) return;
  const sel = new Set(selectedIds);
  wrap.innerHTML = personalAssignablePeople()
    .map((pp) => {
      const initial = (pp.name.trim()[0] || '?').toUpperCase();
      return `<button type="button" class="pl-chip" aria-pressed="${sel.has(pp.id)}" data-person-id="${esc(pp.id)}"><span class="pl-chip-av">${esc(initial)}</span>${esc(pp.name)}</button>`;
    })
    .join('');
  _updatePersonalItinAssignHint();
}

function _updatePersonalItinAssignHint() {
  const hint = document.getElementById('personalItinAssignHint');
  if (!hint) return;
  const n = document.querySelectorAll(
    '#personalItinAssignChips .pl-chip[aria-pressed="true"]',
  ).length;
  hint.textContent = n ? '' : 'No one picked — shared with everyone';
}

function savePersonalItineraryItem() {
  const personal = state.planner?.personal;
  if (!personal) return;
  const m = personalItinEls();
  const title = m.title.value.trim();
  if (!title) {
    m.title.focus();
    return;
  }
  const date = m.date.value || '';
  if (!date) {
    m.date.focus();
    return;
  }

  const memberIds = [
    ...document.querySelectorAll('#personalItinAssignChips .pl-chip[aria-pressed="true"]'),
  ].map((c) => c.dataset.personId);
  const fields = {
    title,
    date,
    time: m.time.value || '',
    endTime: m.end?.value || '',
    timezone: m.tz?.value || '',
    location: m.location.value || '',
    coords: m.coords?.value || '',
    notes: m.notes.value || '',
    done: m.done.checked,
    memberIds,
  };

  personal.itinerary = personal.itinerary || [];
  let saved;
  if (_personalItinId) {
    saved = personal.itinerary.find((i) => i.id === _personalItinId);
    if (saved) Object.assign(saved, fields);
  } else {
    saved = makeItineraryItem(null, date);
    Object.assign(saved, fields);
    personal.itinerary.push(saved);
  }
  // Keep the linked receipt's name in sync with the item, so the rename flows through
  // to every financial view of that receipt (the item is descriptive; the receipt is
  // the money). The budget/summary already read the item's title directly.
  if (saved?.receiptId) {
    const receipt = (state.planner.receipts || []).find((r) => r.id === saved.receiptId);
    if (receipt) receipt.name = title;
  }
  hideModal('personalItineraryItemModal');
  _personalItinId = null;
  _refreshPersonalItineraryViews();
  scheduleAutoSave();
}

function deletePersonalItineraryItem(id) {
  const personal = state.planner?.personal;
  if (!personal) return;
  const snapshot = (personal.itinerary || []).find((i) => i.id === id);
  personal.itinerary = (personal.itinerary || []).filter((i) => i.id !== id);
  hideModal('personalItineraryItemModal');
  _personalItinId = null;
  _refreshPersonalItineraryViews();
  scheduleAutoSave();
  if (snapshot)
    showUndoToast(snapshot.title || 'Itinerary item', () => {
      personal.itinerary = [...(personal.itinerary || []), snapshot];
      _refreshPersonalItineraryViews();
      scheduleAutoSave();
    });
}

function _refreshPersonalItineraryViews() {
  renderPersonalTimeline(); // Gantt + mobile overview agenda
  renderPersonalItineraryTab(); // Itinerary tab
  renderPersonalBudgetBreakdown();
  renderReceiptsTab(); // a renamed item keeps its linked receipt's name in sync
  if (state.activeTab === 'summary') renderSummaryTab();
}

function wirePersonalItineraryItemModal() {
  const modal = document.getElementById('personalItineraryItemModal');
  if (!modal) return;
  const dismiss = () => {
    hideModal('personalItineraryItemModal');
    _personalItinId = null;
  };
  document.getElementById('personalItinModalClose')?.addEventListener('click', dismiss);
  document.getElementById('personalItinSave')?.addEventListener('click', savePersonalItineraryItem);
  document.getElementById('personalItinDelete')?.addEventListener('click', () => {
    if (_personalItinId) deletePersonalItineraryItem(_personalItinId);
  });
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      dismiss();
      return;
    }
    // Receipt integration (create / view / unlink) — mirrors the travel-leg modal.
    if (e.target.closest('#personalItinCreateReceiptBtn')) {
      createReceiptForItinerary();
      return;
    }
    if (e.target.closest('#personalItinViewReceiptBtn')) {
      const item = state.planner?.personal?.itinerary?.find((i) => i.id === _personalItinId);
      const rid = item?.receiptId;
      dismiss();
      setActiveTab('receipts');
      if (rid)
        setTimeout(() => {
          const el = document.querySelector(`[data-receipt-id="${rid}"]`);
          el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 50);
      return;
    }
    if (e.target.closest('#personalItinUnlinkReceiptBtn')) {
      const item = state.planner?.personal?.itinerary?.find((i) => i.id === _personalItinId);
      if (item) {
        unlinkEntityReceipt(item);
        scheduleAutoSave();
        renderPersonalItinReceiptStatus(item);
        renderPersonalBudgetBreakdown();
        renderSummaryTab();
      }
      return;
    }
  });
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') dismiss();
  });
  document.getElementById('personalItinAssignChips')?.addEventListener('click', (e) => {
    const chip = e.target.closest('.pl-chip');
    if (!chip) return;
    chip.setAttribute(
      'aria-pressed',
      chip.getAttribute('aria-pressed') === 'true' ? 'false' : 'true',
    );
    _updatePersonalItinAssignHint();
  });
  // Keep the subtitle in step when the date is changed inside the editor.
  document.getElementById('personalItinDate')?.addEventListener('change', (e) => {
    const d = e.target.value;
    document.getElementById('personalItinModalSubtitle').textContent = d
      ? new Date(d + 'T00:00:00').toLocaleDateString(undefined, {
          weekday: 'long',
          month: 'long',
          day: 'numeric',
        })
      : 'Pick a date below';
  });
}

// ── Init ─────────────────────────────────────────────────────────────────────

function revealPage() {
  document.documentElement.style.opacity = '1';
}

function updateHeader() {
  const meta = state.eventMeta || {};
  // Only consider the schedule "loaded" if the metadata has meaningful content.
  // state.eventFile can be set via backward-compat even when the file is a planner
  // (not a data/schedule file), leaving eventMeta empty after a failed fetch.
  const metaTitle = scheduleMetaTitle();
  const hasSchedule = !!state.eventFile && !!metaTitle;

  const kicker = hasSchedule
    ? [meta.designation, meta.location].filter(Boolean).join(' · ')
    : 'Conference Planner';
  const title = hasSchedule
    ? metaTitle
    : state.planner?._displayName ||
      plannerDisplayName(state.planner, state.plannerKey) ||
      'Trip Notebook';

  document.title = `${title} - Trip Planner`;

  const kickerEl = document.getElementById('plannerHeaderKicker');
  const eventEl = document.getElementById('plannerHeaderEvent');
  const nameEl = document.getElementById('plannerEventName');
  if (kickerEl) kickerEl.textContent = kicker;
  if (eventEl) eventEl.textContent = title;

  // Sync sidebar brand
  const sidebarName = document.getElementById('sidebarEventName');
  if (sidebarName) sidebarName.textContent = title;
  if (nameEl) nameEl.textContent = title;

  // Show "Save to file" whenever a server is hosting the app (same origin) or a
  // remote endpoint is configured — i.e. any time saving to disk is possible.
  // Only a static file:// launch has no server to save to.
  const apiEndpoint = readText(STORAGE_KEYS.editorApiEndpoint) || '';
  if (apiEndpoint || window.location.protocol !== 'file:') {
    document.getElementById('plannerSaveFileBtn')?.classList.remove('hidden');
    // The menu row is the only visible way in, so it follows the same condition.
    document.getElementById('plannerActionsSave')?.classList.remove('hidden');
  }

  // The linked schedules, named the way a person names them.
  //
  // This used to print `data/events/…/foo.json` — a path that means something
  // only to whoever maintains the datasets. The row's real job is the unlink ×,
  // so the row stays and wears the event's label instead. The planner's own
  // file path survives on localhost only, where writing it is the point.
  const pathChip = document.getElementById('plannerPathChip');
  if (pathChip) {
    const rowsEl = document.getElementById('plannerScheduleRows');
    const files = state.planner?._eventFiles || [];
    if (rowsEl) {
      rowsEl.innerHTML = files
        .map((f, i) => {
          const ev = state.events.find((e) => e.file === f);
          const label = ev?.label || f.replace(/^.*\//, '').replace(/\.json$/, '');
          const primary =
            i === 0 && files.length > 1 ? ' <span class="toolbar-path-primary">primary</span>' : '';
          return `<div class="toolbar-path-row" data-path-row="schedule" title="Linked conference schedule">
            <span class="toolbar-path-text" data-path="schedule">${escapeHtml(label)}${primary}</span>
            <button type="button" class="toolbar-path-unlink" data-remove-event="${escapeHtml(f)}" title="Remove this schedule" aria-label="Remove ${escapeHtml(label)}">&times;</button>
          </div>`;
        })
        .join('');
    }

    const plannerRow = pathChip.querySelector('[data-path-row="planner"]');
    const plannerText = pathChip.querySelector('[data-path="planner"]');
    const key = state.plannerKey || '';
    const plannerFile = key && isLocalhost() ? `planner/${plannerFilename(key)}` : '';
    if (plannerText) plannerText.textContent = plannerFile;
    plannerRow?.classList.toggle('hidden', !plannerFile);

    pathChip.classList.toggle('hidden', !plannerFile && !files.length);
  }
}

function applyScheduleGating() {
  const hasSchedule = !!state.eventFile && state.allSessions.length > 0;
  const msg = 'Associate a schedule to enable session features.';

  // Session notes panel - gate the notes content area
  const notesPanel = document.getElementById('plannerNotesPanel');
  let notesGate = document.getElementById('scheduleGateNotes');
  if (notesPanel) {
    if (!hasSchedule) {
      if (!notesGate) {
        notesGate = document.createElement('div');
        notesGate.id = 'scheduleGateNotes';
        notesGate.className = 'pln-gate';
        notesGate.textContent = msg;
        notesPanel.prepend(notesGate);
      }
    } else {
      notesGate?.remove();
    }
  }

  // Tracked sessions search inputs
  ['sponsorSessionSearchInput', 'personalSessionSearchInput'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.disabled = !hasSchedule;
    el.placeholder = hasSchedule
      ? id.includes('sponsor')
        ? 'Search sessions…'
        : 'Search sessions…'
      : msg;
    el.title = hasSchedule ? '' : msg;
  });
}

// A short human label for an event's metadata (e.g. "DrupalCon 2026"), used to tag
// each merged session and to label its conference band.
function eventShortLabel(meta) {
  const em = meta || {};
  return [em.designation, em.year].filter(Boolean).join(' ') || 'Event';
}

// Fetch one event dataset → { file, meta, label, sessions }. Sessions carry their
// source `_eventFile`/`_eventLabel` so merged views can attribute them. The session
// `id` derivation is unchanged (content-only) — see the merged-view note in the plan.
async function loadOneSchedule(eventFile) {
  const res = await fetch(`./data/${resolveEventFile(eventFile)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const meta = data.event || {};
  const label = eventShortLabel(meta);
  const sessions = (data.items || []).map((session) => ({
    ...session,
    _eventFile: eventFile,
    _eventLabel: label,
    id: `${session.startTime}-${session.location}-${session.title}`.replace(/[^a-zA-Z0-9-]/g, '-'),
  }));
  return { file: eventFile, meta, label, sessions };
}

// Load ALL of the planner's associated events (`_eventFiles`) into merged state.
// The first (primary) event drives the single-value ambient context — its metadata
// becomes `state.eventMeta` (timezone/theme/weather/header). Sessions from every
// event are merged into `state.allSessions`. A failed fetch for one event is skipped
// (logged) so the rest still load.
async function loadPlannerSchedules() {
  const files = (state.planner?._eventFiles || []).filter(Boolean);
  const events = [];
  for (const file of files) {
    try {
      events.push(await loadOneSchedule(file));
    } catch (err) {
      console.warn('Could not load event data:', file, err);
    }
  }
  state.events = events;
  state.eventFile = events[0]?.file || null;
  state.eventMeta = events[0]?.meta || {};
  state.allSessions = events.flatMap((e) => e.sessions);
  applyTheme();
}

// Attach an event to the current planner (append to `_eventFiles`, dedup), persist,
// reload merged schedules, and re-render. No-op if already attached.
async function addEventToPlanner(file) {
  if (!file || !state.planner) return;
  const files = state.planner._eventFiles || [];
  if (files.includes(file)) return;
  state.planner._eventFiles = [...files, file];
  normalizeEventFiles(state.planner);
  savePlanner(state.plannerKey, state.planner);
  await loadPlannerSchedules();
  syncSponsoredSessions();
  updateHeader();
  renderAll();
}

// Detach one event from the current planner, persist, reload, re-render.
async function removeEventFromPlanner(file) {
  if (!file || !state.planner) return;
  state.planner._eventFiles = (state.planner._eventFiles || []).filter((f) => f !== file);
  normalizeEventFiles(state.planner);
  savePlanner(state.plannerKey, state.planner);
  await loadPlannerSchedules();
  syncSponsoredSessions();
  updateHeader();
  renderAll();
}

// Each tab panel's static shell now lives beside the module that drives it;
// inject them all before any init/render/wire queries their inner elements.
function injectPanelShells() {
  const shells = {
    plannerTasksPanel: tasksPanelHtml,
    plannerChecklistsPanel: checklistsPanelHtml,
    plannerWeatherPanel: weatherPanelHtml,
    plannerTeamPanel: teamPanelHtml,
    plannerDocumentsPanel: documentsPanelHtml,
    plannerReceiptsPanel: receiptsPanelHtml,
    plannerTicketsPanel: ticketsPanelHtml,
    plannerContactsPanel: contactsPanelHtml,
    plannerNotesPanel: notesPanelHtml,
    plannerCompanionsPanel: companionsPanelHtml,
    plannerMapPanel: mapPanelHtml,
    plannerSchedulePanel: schedulePanelHtml,
    plannerItineraryPanel: itineraryPanelHtml,
    plannerBudgetPanel: budgetPanelHtml,
    plannerSplitPanel: splitPanelHtml,
    plannerSummaryPanel: summaryPanelHtml,
    plannerPersonalPanel: personalPanelHtml,
    plannerSponsorPanel: sponsorPanelHtml,
    plannerSettingsPanel: settingsPanelHtml,
  };
  for (const [id, html] of Object.entries(shells)) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html();
  }
}

async function init() {
  injectPanelShells();

  // Wire the extracted tab modules with their planner collaborators before any
  // render runs (renderAll below calls into them). Must precede renderAll().
  initTasks({
    state,
    localDateStr,
    fmtTime,
    renderListPanel,
    buildSessionOptions: (selectedId) => sessionOptionsHtml(state.allSessions, selectedId, fmtTime),
    scheduleAutoSave,
  });
  initNotes({ state, fmtTime, fmtDate, groupByDate, scheduleAutoSave });
  initContacts({ state, scheduleAutoSave });
  initPlannerFields({ state });
  initReceipts({
    state,
    scheduleAutoSave,
    renderListPanel,
    getActiveBudgetCategoryOptions,
    renderPersonalBudgetBreakdown,
    renderSponsorBudgetBreakdown,
    renderBudgetItems,
    renderDocumentsTab,
    uploadOrReadFile,
    deleteUploadedFile,
    syncReceipt: syncReceiptToApi,
    renderBudgetTab,
    renderSummaryTab,
  });
  initDocuments({
    state,
    scheduleAutoSave,
    renderListPanel,
    getActiveBudgetCategoryOptions,
    uploadOrReadFile,
    deleteUploadedFile,
    resolveFileUrl,
    openReceiptModal,
    openPersonalLegModal,
    openPersonalAccomModal,
    openAccommodationModal,
    openAssignmentModal,
  });
  initTickets({
    state,
    scheduleAutoSave,
    renderSummaryTab,
    renderReceiptsTab,
    setActiveTab,
    getMeLabel,
    openReceiptModal,
  });
  initTrackedSessions({ state, scheduleAutoSave, fmtTime, createModal });
  initMap({ state, scheduleAutoSave, reportError, getMeLabel });
  initPersonalLeg({
    state,
    scheduleAutoSave,
    createModal,
    autoArriveDate,
    uploadOrReadFile,
    setActiveTab,
  });
  initAccommodation({ state, renderOrgAccomReceiptStatus, renderAccomStayReceiptStatus });
  initCompanions({
    state,
    scheduleAutoSave,
    companionCardHtml,
    openLocalCompanionAssignmentModal,
    openTripAssignmentModal,
    renderPersonalCompanionsSection,
  });
  initAssignments({
    state,
    scheduleAutoSave,
    createModal,
    getMeLabel,
    renderAssignmentReceiptStatus,
  });
  initSchedule({
    state,
    scheduleAutoSave,
    fmtTime,
    getTimezone,
    renderPersonalItineraryTab,
  });
  initBudget({
    state,
    scheduleAutoSave,
    createModal,
    renderSummaryTab,
    renderSponsorBudgetBreakdown,
    renderPersonalBudgetBreakdown,
    buildEventBudgetData,
    buildPersonalBudgetData,
    renderReceiptsTab,
    renderPersonalTab,
    openReceiptModal,
    setActiveTab,
  });
  initSplit({
    state,
    scheduleAutoSave,
    esc,
    makeItemId,
    getMeLabel,
    getActiveBudgetCategoryOptions,
  });
  initChecklists({ state, scheduleAutoSave, esc, makeItemId });
  initWeather({ state, scheduleAutoSave, esc });
  initSummary({
    state,
    fetchEventDates,
    getEventBudgetCategories,
    getVisibleTabs,
    isPlannerEntry,
    toWednesdayOfWeek,
    scheduleAutoSave,
    _eventDates,
  });
  initImportExport({ state, renderAll, getTimezone });
  initGlobalSettings({ state, openPersonalContactModal, openTeamMemberModal });
  initCreatePlanner({ state, _loadEventOptions });
  initDashEdit({ _loadEventOptions, _eventDates, renderTripDashboard });
  initCogMenu({ deletePlannerBySlug, renderTripDashboard });
  initDashboard({ isPlannerEntry, _eventDates, fetchEventDates });
  initTeam({
    state,
    renderListPanel,
    createModal,
    buildEventBudgetData,
    refreshAssignMemberSelect,
    renderSettingsTeamSection,
  });
  initOrg({
    state,
    scheduleAutoSave,
    getTimezone,
    localDateStr,
    checklistItemHtml,
    renderBudgetItems,
    renderSponsorBudgetBreakdown,
    swagCardHtml,
    syncEventTitleField,
  });
  initMapCoordPickers();
  initPersonal({
    state,
    getMeLabel,
    getTimezone,
    localDateStr,
    renderListPanel,
    buildEventBudgetData,
    buildPersonalBudgetData,
    renderBudgetItems,
    renderPersonalCompanionsSection,
    renderPersonalConflicts,
    syncEventTitleField,
    renderItineraryWeather,
  });
  initItinerary({
    state,
    scheduleAutoSave,
    openCalendarExportModal,
    localDateStr,
    renderSummaryTab,
    getTimezone,
    openPersonalItineraryItemModal,
    openPersonalAccomModal,
    openPersonalLegModal,
    renderPersonalItinerary,
    renderPersonalItineraryTab,
    renderPersonalTab,
    renderItineraryWeather,
    setActiveTab,
    renderReceiptsTab,
    openReceiptModal,
  });

  // Load themes and event catalog in parallel
  const [, catalog] = await Promise.all([loadThemes(), loadEventCatalog().catch(() => [])]);
  _eventCatalog = catalog;
  applyThemeClass(getCurrentThemeId());

  // Which planner, and which tab — from the path when the app is served, from
  // the query when it is opened as files. `plannerRoute.js` owns that decision.
  const route = parsePlannerRoute(location);
  const plannerKey = route.key;

  if (!plannerKey) {
    document.getElementById('plannerNoEvent')?.classList.remove('hidden');
    document.getElementById('plannerApp')?.classList.add('hidden');

    // Seed any disk planners not yet in localStorage (works same-origin without editorApiEndpoint)
    try {
      const apiEndpoint = readText(STORAGE_KEYS.editorApiEndpoint) || '';
      const deleted = _getDeletedSlugs();
      const diskFiles = await listPlannerFiles(apiEndpoint);
      await Promise.all(
        diskFiles.map((f) => {
          const slug = f.endsWith('.json') ? f.slice(0, -5) : f;
          if (deleted.has(slug)) return;
          return seedFromDiskIfMissing(slug);
        }),
      );
    } catch {
      /* offline or no server */
    }

    state.global = loadGlobal();
    await renderTripDashboard();
    revealPage();
    wireCreatePlannerModal();
    wireTripCogMenu();
    wireDashboardPlannerEditModal();
    wireTimelineHover();
    wireGlobalSettingsModal();
    return;
  }

  state.plannerKey = plannerKey;

  // Start building the search catalog in the background — runs in parallel with schedule load.
  const searchCatalogPromise = buildPlannerSearchCatalog(catalog);

  // Pre-warm exchange rate cache from localStorage (avoids a fetch on first summary open)
  loadRatesIntoCache();

  // Restore from disk if localStorage has no entry (cleared storage, new browser, etc.)
  await Promise.all([seedFromDiskIfMissing(plannerKey), seedGlobalFromDiskIfMissing()]);

  // A `.json` key IS a schedule file (the ?event= form); pass it as
  // defaultEventFile so freshly-created (empty) planners get the association
  // set automatically. This used to test the raw param — the key itself is the
  // honest test, and it survives the path form too.
  const isScheduleParam = plannerKey.endsWith('.json');
  state.planner = loadPlanner(plannerKey, isScheduleParam ? plannerKey : '');

  // Backward compat: old planners have _eventFile equal to the storage key
  if (!state.planner._eventFile && plannerKey.endsWith('.json')) {
    state.planner._eventFile = plannerKey;
  }
  // Re-normalize after the back-compat tweak so `_eventFiles` reflects `_eventFile`.
  normalizeEventFiles(state.planner);
  state.eventFile = state.planner._eventFile || null;

  if (state.planner._eventFiles.length) {
    await loadPlannerSchedules();
  } else {
    state.events = [];
    state.eventMeta = {};
    state.allSessions = [];
    const fallback = readText(STORAGE_KEYS.currentThemeId) || getCurrentThemeId();
    applyThemeClass(fallback);
  }

  state.global = loadGlobal();
  // Use global budget categories as the default (sourced from planner/global.json via seed).
  if (state.global.budgetCategories?.length)
    setDefaultBudgetCategories(state.global.budgetCategories);
  // Merge any team members bundled in a seeded-from-disk planner file, then
  // re-save so the _globalTeamMembers field doesn't persist in localStorage.
  if (state.planner._globalTeamMembers) {
    mergeGlobalTeamMembers(state.planner);
    savePlanner(state.plannerKey, state.planner);
  }

  if (isLocalhost()) {
    document.getElementById('editorNavLink')?.classList.remove('hidden');
    document.getElementById('plannerEditorNavLink')?.classList.remove('hidden');
    document.getElementById('plannerCurationNavLink')?.classList.remove('hidden');
  }

  const storageNotice = document.getElementById('storageNotice');
  if (storageNotice && !readText(STORAGE_KEYS.storageNoticeDismissed)) {
    storageNotice.classList.remove('hidden');
    document.getElementById('storageNoticeDismiss')?.addEventListener('click', () => {
      storageNotice.classList.add('hidden');
      writeText(STORAGE_KEYS.storageNoticeDismissed, '1');
    });
  }

  // Sync the URL so refresh stays on this planner and the address is shareable
  pushPlannerUrl(state.plannerKey);

  syncSponsoredSessions();

  // Privacy lock: if this planner is locked (and outside its 90-min grace), cover it
  // with the password prompt. NON-blocking on purpose — the planner still initialises
  // and autosaves underneath the cover, so the lock can never break persistence.
  guardPlannerLock({
    planner: state.planner,
    slug: state.plannerKey,
    name: state.planner?.name,
  });

  updateHeader();
  renderAll();
  applyMode(state.planner.mode || 'personal');
  applyConferenceMode();

  // Restore the tab the route asked for (falling back to a legacy #hash link),
  // after applyMode so tab visibility for the mode is already correct. This is
  // a restoration, not a navigation, so it must not push a history entry —
  // otherwise Back on a freshly opened deep link goes nowhere.
  const savedTab = route.tab || location.hash.replace('#', '');
  if (savedTab && TABS.includes(savedTab)) {
    const mode = state.planner.mode || 'personal';
    if (getVisibleTabs(mode).has(savedTab)) {
      setActiveTab(savedTab, { push: false });
      TAB_EXTRA_RENDERS[savedTab]?.(); // populate lazy tabs (map, summary, settings…)
    }
  }
  renderPlannerCrumbs();
  wirePlannerHistory();
  _routeReady = true;

  // Configure the shared event-search modal used by "Find event" / "Manage event"
  _searchCatalog = await searchCatalogPromise;
  configureEventSearch({
    getEvents: () => _searchCatalog,
    // Selecting an event in the in-planner "Manage events" search ADDS it to this
    // planner's associated events (a trip can span several co-located conferences).
    // The planner's slug/URL is unaffected — `_eventFiles` is pure association data.
    onSelect: async (_category, file) => {
      await addEventToPlanner(file);
    },
  });

  wireToolbar();
  wireCreatePlannerModal();
  wireManageEventBtn();
  wireContactsPanel();
  wireTasksPanel();
  wireChecklistsPanel();
  wireWeatherPanel();
  wireOrgPanel();
  wirePersonalPanel();
  wireTrackedSessionModal();
  wireBudgetItemsPanel();
  wireSwagModal();
  wireNoteModal();
  wireNoteEmojiPicker();
  wirePersonalLegModal();
  wirePersonalAccomModal();
  wireAssignmentModal();
  wirePersonalContactModal();
  wireNotesPanel();
  wireTeamPanel();
  wireItineraryPanel();
  wirePersonalItineraryItemModal();
  wireDocumentsPanel();
  wireReceiptsPanel();
  wireSummaryPanel();
  wireTicketsPanel();
  wireBudgetPanel();
  wireSplitPanel();
  wireMapPanel();
  wireCompanionsPanel();
  wireSchedulePanel();
  wirePersonDetailModal();
  wireBudgetCategoryManager();
  wireSettingsPanel();
  wireSidebar();
  wireMobileTabNav();
  wirePlannerActionsSheet();
  wireGlobalSettingsModal();
  initCollapsibleSections();

  // Inject timezone datalist once
  if (!document.getElementById('tzList')) {
    const dl = document.createElement('datalist');
    dl.id = 'tzList';
    dl.innerHTML = tzDatalist();
    document.body.appendChild(dl);
  }

  revealPage();
}

// Last-resort error page: if startup fails, reveal the page (it begins at
// opacity:0 to avoid FOUC) and show a useful message instead of a blank screen.
function renderFatalError(err) {
  reportError('planner init', err);
  document.documentElement.style.opacity = '1';
  const box = document.createElement('div');
  box.setAttribute('role', 'alert');
  box.style.cssText =
    'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;padding:1.5rem;background:#f8fafc;font-family:system-ui,-apple-system,sans-serif;color:#1e293b';
  box.innerHTML = `<div style="max-width:34rem;width:100%">
    <h1 style="font-size:1.25rem;font-weight:600;margin:0 0 .5rem">Couldn't load the planner</h1>
    <p style="margin:0 0 1rem;color:#475569">Something went wrong during startup. Your saved planners are still stored safely in this browser.</p>
    <pre style="background:#f1f5f9;border:1px solid #cbd5e1;border-radius:.5rem;padding:.75rem;font-size:.8rem;white-space:pre-wrap;overflow:auto;margin:0 0 1rem">${escapeHtml(String(err?.stack || err?.message || err))}</pre>
    <div style="display:flex;gap:.5rem">
      <button type="button" id="fatalReload" style="height:2.25rem;padding:0 1rem;border:0;border-radius:.5rem;background:#334155;color:#fff;font-size:.85rem;cursor:pointer">Reload</button>
      <a href="planner.html" style="height:2.25rem;padding:0 1rem;display:inline-flex;align-items:center;border:1px solid #cbd5e1;border-radius:.5rem;color:#334155;font-size:.85rem;text-decoration:none">All trips</a>
    </div>
  </div>`;
  document.body.prepend(box);
  document.getElementById('fatalReload')?.addEventListener('click', () => location.reload());
}

initThemePicker();
init().catch(renderFatalError);

// Static shell for the Settings tab — injected into #plannerSettingsPanel at boot (#7 co-location).
function settingsPanelHtml() {
  return `
          <section>
            <div class="pln-section__head">
              <div>
                <p class="pln-eyebrow">How this planner works</p>
                <h2 class="pln-section__title">Settings</h2>
              </div>
            </div>
            <div id="settingsSpec" class="set-spec"></div>

            <!-- Planner mode -->
            <div class="set-section" style="margin-top:1.4rem">
              <div class="doc-divider"><span>Planner mode</span></div>
              <p class="set-section-desc">Sponsor mode adds team, budget &amp; booth tracking; personal mode focuses on your own travel and expenses.</p>
              <div class="set-cards set-cards--2">
                <label class="set-card">
                  <input type="radio" id="settingsModePersonal" name="settingsMode" value="personal" class="set-radio">
                  <span class="set-card-body">
                    <span class="set-card-title">Personal</span>
                    <span class="set-card-desc">Travel, receipts, session notes, contacts</span>
                  </span>
                </label>
                <label class="set-card">
                  <input type="radio" id="settingsModeSponsor" name="settingsMode" value="sponsor" class="set-radio">
                  <span class="set-card-body">
                    <span class="set-card-title">Sponsor</span>
                    <span class="set-card-desc">Team, booth, budget, deliverables</span>
                  </span>
                </label>
              </div>
            </div>

            <!-- Planner features -->
            <div class="set-section">
              <div class="doc-divider"><span>Planner features</span></div>
              <p class="set-section-desc">Switch whole capabilities on or off for this planner.</p>
              <div class="set-cards">
                <label class="set-card">
                  <span class="set-card-body">
                    <span class="set-card-title">Conference features</span>
                    <span class="set-card-desc">Adds Notes, Contacts &amp; the conference schedule for an event. Turn off for a plain trip.</span>
                  </span>
                  <input type="checkbox" id="settingsIsConference" class="pl-toggle">
                </label>
                <label class="set-card">
                  <span class="set-card-body">
                    <span class="set-card-title">Getting around</span>
                    <span class="set-card-desc">Track local trips while you're there — trains, taxis, cable cars — on the itinerary, timeline &amp; map.</span>
                  </span>
                  <input type="checkbox" id="settingsLocalTravel" class="pl-toggle">
                </label>
                <label class="set-card">
                  <span class="set-card-body">
                    <span class="set-card-title">Lock this planner</span>
                    <span class="set-card-desc">Require your account password to open it. Stays unlocked for 90 minutes, then re-locks.</span>
                    <span id="settingsLockUnavailable" class="set-card-note hidden">Needs the server running with a password (session or multi-user auth).</span>
                  </span>
                  <input type="checkbox" id="settingsLockPlanner" class="pl-toggle">
                </label>
              </div>
            </div>

            <!-- Conference schedules -->
            <div class="set-section">
              <div class="doc-divider"><span>Conference schedules</span>
                <button type="button" id="settingsAddConferenceBtn" class="set-btn" style="margin-left:auto">Add conference</button>
              </div>
              <p class="set-section-desc">Link one or more event schedules — sessions, dates &amp; conference bands from all of them show together. The first is the primary (drives timezone &amp; theme).</p>
              <div id="settingsConferenceList" class="set-cards"></div>
            </div>

            <!-- Tab order & visibility -->
            <div class="set-section">
              <div class="doc-divider"><span>Tab order &amp; visibility</span>
                <button type="button" id="settingsResetTabOrderBtn" class="set-btn" style="margin-left:auto">Reset order</button>
              </div>
              <p class="set-section-desc">Drag to reorder. Toggle to show or hide a tab. Settings cannot be disabled.</p>
              <div id="settingsTabList" class="set-cards"></div>
            </div>

            <!-- Sponsor-only sections (linked sponsor + team) -->
            <div id="settingsSponsorSection" class="hidden">

              <!-- Linked sponsor -->
              <div class="set-section">
                <div class="doc-divider"><span>Linked sponsor</span>
                  <button type="button" id="unlinkSponsorBtn" class="hidden set-btn" style="margin-left:auto">Unlink</button>
                </div>
                <p class="set-section-desc">Connect this planner to a sponsor entry from the event data to auto-track sponsored sessions.</p>
                <div id="sponsorSearchRow" class="set-field">
                  <input type="text" id="sponsorSearchInput" placeholder="Search sponsors by name…" class="set-input" autocomplete="off">
                </div>
                <ul id="sponsorSearchResults" class="hidden set-results text-sm"></ul>
                <div id="sponsorLinkedCard" class="hidden set-linked" style="margin-top:0.5rem">
                  <div class="flex-1 min-w-0">
                    <p id="sponsorLinkedName" class="text-sm font-semibold pl-ink-0 truncate"></p>
                    <p id="sponsorLinkedTier" class="pl-hint"></p>
                  </div>
                  <a id="sponsorLinkedUrl" href="#" target="_blank" rel="noopener" class="flex-shrink-0 text-xs hidden set-btn">
                    Visit
                  </a>
                </div>
              </div>

              <!-- Team -->
              <div class="set-section">
                <div class="doc-divider"><span>Team</span>
                  <button type="button" id="settingsAddTeamMemberBtn" class="set-btn" style="margin-left:auto">Add member</button>
                </div>
                <p class="set-section-desc">Global team members — check the box to assign them to this event.</p>
                <div id="settingsTeamList" class="space-y-2"></div>
              </div>

            </div>

            <!-- Personal contacts section (personal mode only) -->
            <div id="settingsPersonalSection" class="hidden">

              <!-- Me identity -->
              <div class="set-section">
                <div class="doc-divider"><span>"Me" identity</span></div>
                <p class="set-section-desc">Optionally name yourself. When set, "Me" is replaced with this person's name throughout the planner.</p>
                <select id="settingsMeContactId" class="set-input">
                  <option value="">Me (default)</option>
                </select>
              </div>

              <div class="set-section">
                <div class="doc-divider"><span>Trip contacts</span>
                  <button type="button" id="settingsAddPersonalContactBtn" class="set-btn" style="margin-left:auto">Add contact</button>
                </div>
                <p class="set-section-desc">Your global list of travel companions — check the box to add them to this trip.</p>
                <div id="settingsPersonalContactsList" class="space-y-2"></div>
              </div>
            </div>

            <!-- Roll-up (display) currency — applies to both modes -->
            <div class="set-section">
              <div class="doc-divider"><span>Report totals in</span></div>
              <p class="set-section-desc">Budget and financial-summary totals roll up into this currency. Each line item is still entered in its own currency.</p>
              <select id="settingsDisplayCurrency" class="set-input"></select>
            </div>

            <!-- Budget categories (sponsor mode) -->
            <div id="settingsBudgetSponsor" class="hidden set-section">
              <div class="doc-divider"><span>Budget categories</span></div>
              <p class="set-section-desc">Customise categories for this event's sponsor budget. Removing one won't delete existing items — they fall back to Misc.</p>
              <div id="sponsorBudgetCategoryList" class="space-y-1"></div>
              <div class="flex gap-2" style="margin-top:0.6rem">
                <input type="text" id="sponsorBudgetCategoryInput" placeholder="New category name" class="set-input flex-1">
                <button type="button" id="addSponsorBudgetCategoryBtn" class="set-btn flex-shrink-0">Add</button>
              </div>
            </div>

            <!-- Budget categories (personal mode) -->
            <div id="settingsBudgetPersonal" class="hidden set-section">
              <div class="doc-divider"><span>Budget categories</span></div>
              <p class="set-section-desc">Customise categories for this event's personal budget. Removing one won't delete existing items — they fall back to Misc.</p>
              <div id="personalBudgetCategoryList" class="space-y-1"></div>
              <div class="flex gap-2" style="margin-top:0.6rem">
                <input type="text" id="personalBudgetCategoryInput" placeholder="New category name" class="set-input flex-1">
                <button type="button" id="addPersonalBudgetCategoryBtn" class="set-btn flex-shrink-0">Add</button>
              </div>
            </div>

            <!-- API access -->
            <div class="set-section">
              <div class="doc-divider"><span>API access</span></div>
              <p class="set-section-desc set-section-desc--wide">A bearer token lets another tool read and write through the API at <code>/api/v1</code>. Treat it like a password: whoever holds it acts as you.</p>
              <div class="set-cards">
                <div class="set-card">
                  <span class="set-card-body">
                    <span class="set-card-title">Personal access token</span>
                    <span class="set-card-desc">Shown once when generated. The server keeps only a hash of it, so it cannot be read back.</span>
                    <span id="settingsTokenState" class="set-card-note hidden"></span>
                  </span>
                  <button type="button" id="settingsTokenRevokeBtn" class="set-btn" disabled>Revoke</button>
                  <button type="button" id="settingsTokenBtn" class="set-btn" disabled>Generate token</button>
                </div>
              </div>
              <div id="settingsTokenResult" class="hidden"></div>
            </div>

            <!-- Danger zone -->
            <div class="set-danger">
              <p class="set-danger-title">Danger zone</p>
              <p class="set-danger-desc">This cannot be undone. All planner data will be permanently removed.</p>
              <button type="button" id="settingsDeletePlannerBtn" class="set-danger-btn">
                Delete this planner
              </button>
            </div>
          </section>
        `;
}
