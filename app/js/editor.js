import './modules/pwa.js'; // registers the service worker (PWA/offline)
import { loadEventCatalog } from './modules/eventCatalog.js';
import { formatTextBlock } from './modules/markdown.js';
import { slugify, escapeHtml, normalizeString } from './modules/utils.js';
import { reportError } from './modules/notify.js';
import {
  STORAGE_KEYS,
  readJson,
  writeJson,
  readText,
  writeText,
  removeKey,
} from './modules/plannerStorage.js';
import { SPONSOR_BG_STYLES, SPONSOR_ASPECTS } from './modules/sponsorStyles.js';
import {
  initSources,
  renderSourcesEditor,
  renderSponsorSourceField,
} from './modules/editorSources.js';
import {
  initFeedModal,
  showFeedDiff,
  showFeedImported,
  showFeedMessage,
} from './modules/feedModal.js';
import {
  initEditorSponsors,
  normalizeSponsorCollection,
  closeSponsorSessionPicker,
  closeSessionSponsorPicker,
  renderSponsorList,
  renderSponsorForm,
  addSponsor,
  deleteSponsor,
  saveCurrentSponsor,
} from './modules/editorSponsors.js';
import {
  initEditorRelatedEvents,
  normalizeRelatedEventCollection,
  renderRelatedList,
  wireRelatedEventsPanel,
} from './modules/editorRelatedEvents.js';
import {
  initEditorSessions,
  renderSessionList,
  renderSessionForm,
  addSession,
  deleteSession,
  saveCurrentSession,
} from './modules/editorSessions.js';
import { initEditorS3, editorS3SectionHtml, wireEditorS3 } from './modules/editorS3.js';
import { syncSessionDuration } from './modules/editorDuration.js';
import {
  normalizeUrlArray,
  parseMultiValue,
  stripSummaryFields,
  normalizeFlickrObject,
  normalizeLogoObject,
} from './modules/editorNormalize.js';
import { peopleGroupsHtml, CREDIT_ROLES } from './modules/editorPeople.js';
import { editorPath, parseEditorPath } from './modules/editorRoute.js';
import { utcIsoToLocalInput, localInputToUtcIso } from './modules/editorDateTime.js';
import {
  buildDatasetOptionLabel,
  datasetDocPath,
  isEditorDatasetFile,
  validateDatasetSchema,
  buildDatasetGroupingRecord,
  buildDatasetGroupingFallback,
  mergeDateIntoIso,
} from './modules/editorDataset.js';
import { openMapPicker } from './modules/mapPicker.js';
import { configureEventSearch, openEventSearchModal } from './modules/eventSearch.js';
import { renderTimeline } from './modules/timeline.js';
import { validateDataset, formatValidationErrors } from './modules/validator.js';
import { showValidationErrorModal } from './modules/validationModal.js';
import {
  homeRoot,
  heroPanel,
  ctaGrid,
  ctaCard,
  statusBar,
  sectionHeader,
  searchBar,
  cardGrid,
  loadingState,
} from './modules/homeLayout.js';
import {
  loadThemes,
  getThemes,
  setThemes,
  getThemeById,
  normalizeThemeId,
  getCurrentThemeId,
  setCurrentThemeId,
  applyThemeClass,
  applyEventColors,
} from './modules/theme.js';
import { initThemePicker } from './modules/themePicker.js';
import { initAppMenu } from './modules/appMenu.js';

const state = {
  dataset: null,
  file: '',
  // Event file → the series it belongs to, from the curation ledger. Null until
  // fetched; `{}` once fetched and empty. NOT part of the dataset, so it is
  // deliberately outside the dirty/undo machinery.
  seriesMap: null,
  seriesOptions: [],
  outputPath: '',
  fileHandle: null,
  projectDirHandle: null,
  folderConnectedInSession: false,
  lastDatasetSelectValue: '',
  selectedIndex: -1,
  selectedSponsorIndex: -1,
  draggingIndex: -1,
  draggingSponsorIndex: -1,
  sessionSearchQuery: '',
  sessionListExpanded: false,
  sessionQuickEditEnabled: false,
  sponsorListExpanded: false,
  sponsorQuickEditEnabled: false,
  activeEditorTab: 'sessions',
  dirty: false,
  sessionDirty: false,
  sponsorDirty: false,
  persistedSnapshot: null,
  // Fingerprint of the dataset file's on-disk content as we last loaded/saved it.
  // Compared against the live file just before a save to catch external edits
  // (another tab, the server, a script) so we never silently clobber them.
  loadedDiskFingerprint: '',
  quickEditSessionChanges: new Set(),
  quickEditSponsorChanges: new Set(),
  sessionStructureDirty: false,
  sponsorStructureDirty: false,
  timezones: [],
  sponsorSessionPickerOpen: false,
  sessionSponsorPickerOpen: false,
  imageCacheBust: new Map(),
  sponsorEventCounts: null,
  apiEndpoint: readText(STORAGE_KEYS.editorApiEndpoint) || '',
};

const UNDO_STACK = [];
const UNDO_LIMIT = 50;
const RECOVERY_KEY = STORAGE_KEYS.editorRecovery;
const PHOTOS_BACKUP_KEY = STORAGE_KEYS.photosBackup;
const LOGO_BACKUP_KEY = STORAGE_KEYS.logoBackup;
const RECOVERY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const FILE_LINK_DB = 'dataset-editor-file-links';
const FILE_LINK_STORE = 'links';
const DIR_HANDLE_KEY = STORAGE_KEYS.projectDirHandle;
const EVENT_META_FIELDS = [
  'id',
  'name',
  'designation',
  'ecosystem',
  'year',
  'location',
  'region',
  'country',
  'regionCode',
  'venue',
  'latitude',
  'longitude',
  'website',
  'scheduleURLs',
  'startDate',
  'endDate',
  'logo',
  'flickr',
  'timezone',
  'columns',
  'enabled',
  'scheduleComplete',
  'attendance',
];
const EVENT_META_FIELD_CONFIG = {
  attendance: {
    label: 'Attendees',
    description:
      'The final attendee count as the ORGANISERS reported it, with where the number came from. Never an estimate of ours — an archive that guesses at attendance is worse than one that leaves it blank, because the guess gets quoted back. Leave it empty until there is a figure to record.',
  },
  designation: {
    label: 'Event series',
    description: 'The public event family name, such as DrupalSouth, DrupalCon, or DrupalGov.',
  },
  ecosystem: {
    label: 'Community',
    description:
      'Which software community this event belongs to. The app stays ecosystem-neutral in its own copy, so this records the fact as data instead of assuming it. Not shown on the public schedule.',
  },
  year: {
    label: 'Event year',
    description: 'The calendar year used for sorting, grouping, and display.',
  },
  location: {
    label: 'Host city',
    description: 'The city or primary location shown in the event picker.',
  },
  region: {
    label: 'Region label',
    description:
      'Free-text region shown on the public event page, such as "Europe – Greece" or "New Zealand – Wellington".',
  },
  country: {
    label: 'Country',
    description:
      'Canonical country name used by the Archive Observatory country filter, such as Greece or Australia. Leave blank for online/global events.',
  },
  regionCode: {
    label: 'Macro-region',
    description:
      'Canonical macro-region used by the Archive Observatory filters: Europe, Middle East & Africa, Asia-Pacific, North America, or Latin America.',
  },
  venue: {
    label: 'Venue',
    description: 'The main venue name shown in the event details.',
  },
  latitude: {
    label: 'Venue latitude',
    description:
      'Optional. With longitude, pins the venue exactly on the planner map (skips geocoding). E.g. -41.2865.',
  },
  longitude: {
    label: 'Venue longitude',
    description: 'Optional. Used with latitude for the map pin. E.g. 174.7762.',
  },
  website: {
    label: 'Event website',
    description: 'The official event website URL.',
  },
  scheduleURLs: {
    label: 'Schedule URLs',
    description: 'One or more source schedule URLs used when this dataset was created or checked.',
  },
  logo: {
    label: 'Event logo',
    description:
      'Upload and store the exact logo used in the public schedule header for this event.',
  },
  timezone: {
    label: 'Event time zone',
    description: 'The local time zone for session editing. Session times are saved as UTC.',
  },
  columns: {
    label: 'Schedule columns',
    description: 'The preferred number of columns for the public schedule layout.',
  },
  startDate: {
    label: 'Conference start date',
    description:
      'First day of the event. Populates the timeline day tabs even when no sessions are scheduled yet.',
  },
  endDate: {
    label: 'Conference end date',
    description: 'Last day of the event. All dates between start and end appear as timeline days.',
  },
  enabled: {
    label: 'Show this event',
    description: 'Controls whether this dataset is available in the public planner.',
  },
  scheduleComplete: {
    label: 'Schedule complete',
    description:
      'Mark when the event has passed and its schedule is final — no further session changes are expected.',
  },
};
const FLICKR_FIELD_CONFIG = {
  enabled: {
    label: 'Show photos block',
    description: 'Displays the photo callout on the public event page when a URL is provided.',
  },
  provider: {
    label: 'Photo provider',
    description:
      'Name of the photo platform shown in the callout (e.g. Flickr, Google Photos, SmugMug).',
  },
  groupUrl: {
    label: 'Photos URL',
    description:
      'The public link to the photo album, group, or gallery used by the call-to-action button.',
  },
  image: {
    label: 'Promo image path',
    description: 'A relative path to the square promo image shown beside the photos block text.',
  },
  imageAlt: {
    label: 'Image alternative text',
    description: 'A short description of the promo image for screen readers.',
  },
};
const LOGO_FIELD_CONFIG = {
  image: {
    label: 'Logo image path',
    description: 'A relative path to the logo shown in the public schedule header.',
  },
  imageAlt: {
    label: 'Logo alternative text',
    description: 'A short description of the logo for screen readers.',
  },
  usePlate: {
    label: 'Use background plate',
    description: 'Enable a soft white plate behind the logo for images without transparency.',
  },
  logoDisabled: {
    label: 'Disable logo image',
    description:
      'When checked, the logo image is hidden on the schedule and a Font Awesome icon is shown instead.',
  },
  faIcon: {
    label: 'Replacement icon',
    description:
      'Font Awesome icon classes shown when the logo is disabled (e.g. "fa-solid fa-calendar-days"). Defaults to fa-solid fa-calendar-days.',
  },
};
const SPONSOR_FIELDS = [
  {
    key: 'title',
    label: 'Sponsor title',
    description: 'Public sponsor name used in the editor and rendered placements.',
    type: 'text',
    span: 2,
  },
  {
    key: 'subtitle',
    label: 'Subtitle text',
    description:
      'Optional display name shown on the schedule instead of the company name. Falls back to the sponsor title if blank.',
    type: 'text',
    span: 2,
  },
  {
    key: 'id',
    label: 'Sponsor ID',
    description: 'Stable identifier used by sessions to reference this sponsor.',
    type: 'text',
  },
  {
    key: 'tier',
    label: 'Tier',
    description: 'Grouping label such as Platinum, Gold, Silver, or Partner.',
    type: 'text',
  },
  {
    key: 'row',
    label: 'Display row',
    description: 'Which row this sponsor appears in. Lower numbers appear first.',
    type: 'number',
  },
  {
    key: 'priority',
    label: 'Display order',
    description: 'Position within the row. Lower numbers appear earlier.',
    type: 'number',
  },
  {
    key: 'link',
    label: 'Sponsor URL',
    description: 'Optional external link for the sponsor logo or card.',
    type: 'text',
    span: 2,
  },
  {
    key: 'image',
    label: 'Image path',
    description: 'Relative path to the uploaded sponsor image asset.',
    type: 'text',
    span: 2,
  },
  {
    key: 'imageAlt',
    label: 'Image alternative text',
    description: 'Short accessible description for the sponsor image.',
    type: 'text',
    span: 2,
  },
  {
    key: 'bgStyle',
    label: 'Logo background',
    description:
      'How the logo image background is treated. Use "light-plate" or "dark-plate" if the logo has no transparent background.',
    type: 'select',
    options: SPONSOR_BG_STYLES,
  },
  {
    key: 'aspect',
    label: 'Image shape',
    description:
      'The aspect ratio of the logo. Helps ensure it displays at the right size and proportions.',
    type: 'select',
    options: SPONSOR_ASPECTS,
  },
  {
    key: 'enabled',
    label: 'Show sponsor',
    description:
      'Controls whether this sponsor is available for rendering and session association.',
    type: 'checkbox',
  },
];
const SESSION_FIELDS = [
  {
    key: 'title',
    label: 'Session title',
    description: 'The public title shown on schedule cards and detail views.',
    type: 'text',
    span: 2,
  },
  {
    key: 'startTime',
    label: 'Start time',
    description: "Enter the session start time in the event's local timezone.",
    type: 'datetime-local',
  },
  {
    key: 'endTime',
    label: 'End time',
    description: "Enter the session end time in the event's local timezone.",
    type: 'datetime-local',
  },
  {
    key: 'location',
    label: 'Room or location',
    description: 'The room, stage, or location for this session.',
    type: 'text',
  },
  {
    key: 'duration',
    label: 'Session duration',
    description: 'Calculated automatically from the start and end time.',
    type: 'text',
  },
  {
    key: 'kind',
    label: 'Kind',
    description:
      'What this item IS, as distinct from what it is about (that is Track). Sessions and ' +
      'workshops count toward the archive\u2019s session totals; social events and agenda ' +
      'items appear on the schedule with their room, times and sponsors, but are not counted.',
    type: 'select',
    options: [
      { value: 'session', label: 'Session — a talk, keynote, panel or BOF' },
      { value: 'workshop', label: 'Workshop — sprint, summit, training, hands-on' },
      { value: 'social', label: 'Social — trivia, dinner, apéro, tour, awards' },
      { value: 'agenda', label: 'Agenda — lunch, break, registration' },
    ],
    span: 2,
  },
  {
    key: 'cancelled',
    label: 'Cancelled',
    description:
      'The item was called off. It stays in the dataset as evidence but is hidden from the ' +
      'schedule and never counted — the archive should not show a talk that did not happen.',
    type: 'checkbox',
    span: 2,
  },
  {
    key: 'track',
    label: 'Track or topic',
    description: 'Use commas to separate multiple tracks or topics.',
    type: 'text',
  },
  {
    key: 'speakers',
    label: 'Speaker names',
    description: 'Use commas or new lines to separate multiple speakers.',
    type: 'textarea',
    span: 2,
  },
  {
    key: 'full_description',
    label: 'Session description',
    description: 'The full public description. Markdown formatting is supported.',
    type: 'textarea',
    span: 2,
  },
  {
    key: 'sponsorIds',
    label: 'Sponsors',
    description: 'Sponsors associated with this session.',
    type: 'sponsors',
    span: 2,
  },
  {
    key: 'link',
    label: 'Session page URL',
    description: 'The original or canonical web page for this session.',
    type: 'text',
    span: 2,
  },
  {
    key: 'video_url',
    label: 'Video URL',
    description: 'Optional recording URL shown with the session details.',
    type: 'text',
    span: 2,
  },
];

let fileLinkDbPromise = null;
let eventCatalog = [];
let _homeMetaCache = null;

const els = {
  blocked: document.getElementById('editorBlocked'),
  app: document.getElementById('editorApp'),
  home: document.getElementById('editorHome'),
  saveToast: document.getElementById('saveToast'),
  datasetSelect: document.getElementById('datasetSelect'),
  editorSearchEvents: document.getElementById('editorSearchEvents'),
  newDataset: document.getElementById('newDataset'),
  pathChip: document.getElementById('editorPathChip'),
  saveDataset: document.getElementById('saveDataset'),
  saveDatasetToggle: document.getElementById('saveDatasetToggle'),
  saveDatasetDropdown: document.getElementById('saveDatasetDropdown'),
  saveAsDataset: document.getElementById('saveAsDataset'),
  previewDataset: document.getElementById('previewDataset'),
  previewDatasetToggle: document.getElementById('previewDatasetToggle'),
  previewDatasetDropdown: document.getElementById('previewDatasetDropdown'),
  undoAction: document.getElementById('undoAction'),
  revertDataset: document.getElementById('revertDataset'),
  exportDataset: document.getElementById('exportDataset'),
  dirtyState: document.getElementById('dirtyState'),
  toggleEventMeta: document.getElementById('toggleEventMeta'),
  toggleEventMetaIcon: document.getElementById('toggleEventMetaIcon'),
  eventMetaBody: document.getElementById('eventMetaBody'),
  eventMetaForm: document.getElementById('eventMetaForm'),
  appearanceForm: document.getElementById('appearanceForm'),
  eventWorkspacePanel: document.getElementById('eventWorkspacePanel'),
  logoForm: document.getElementById('logoForm'),
  flickrForm: document.getElementById('flickrForm'),
  sessionSearchInput: document.getElementById('sessionSearchInput'),
  sessionList: document.getElementById('sessionList'),
  sessionWorkspace: document.getElementById('sessionWorkspace'),
  sessionWorkspacePanel: document.getElementById('sessionWorkspacePanel'),
  sessionSidebarPanel: document.getElementById('sessionSidebarPanel'),
  sessionEditorPanel: document.getElementById('sessionEditorPanel'),
  toggleSessionWorkspace: document.getElementById('toggleSessionWorkspace'),
  toggleSessionWorkspaceIcon: document.getElementById('toggleSessionWorkspaceIcon'),
  toggleSessionWorkspaceLabel: document.getElementById('toggleSessionWorkspaceLabel'),
  toggleQuickSessionEdit: document.getElementById('toggleQuickSessionEdit'),
  toggleQuickSessionEditIcon: document.getElementById('toggleQuickSessionEditIcon'),
  toggleQuickSessionEditLabel: document.getElementById('toggleQuickSessionEditLabel'),
  sessionForm: document.getElementById('sessionForm'),
  sessionIndexBadge: document.getElementById('sessionIndexBadge'),
  sessionDirtyState: document.getElementById('sessionDirtyState'),
  saveSession: document.getElementById('saveSession'),
  saveSessionLabel: document.getElementById('saveSessionLabel'),
  addSession: document.getElementById('addSession'),
  deleteSession: document.getElementById('deleteSession'),
  sponsorList: document.getElementById('sponsorList'),
  sponsorWorkspace: document.getElementById('sponsorWorkspace'),
  sponsorWorkspacePanel: document.getElementById('sponsorWorkspacePanel'),
  peopleWorkspacePanel: document.getElementById('peopleWorkspacePanel'),
  showPeopleTab: document.getElementById('showPeopleTab'),
  peopleGroups: document.getElementById('peopleGroups'),
  communityUrlInput: document.getElementById('communityUrlInput'),
  communityCapturedInput: document.getElementById('communityCapturedInput'),
  addPersonBtn: document.getElementById('addPersonBtn'),
  relatedWorkspacePanel: document.getElementById('relatedWorkspacePanel'),
  showRelatedTab: document.getElementById('showRelatedTab'),
  sponsorSidebarPanel: document.getElementById('sponsorSidebarPanel'),
  sponsorEditorPanel: document.getElementById('sponsorEditorPanel'),
  toggleSponsorWorkspace: document.getElementById('toggleSponsorWorkspace'),
  toggleSponsorWorkspaceIcon: document.getElementById('toggleSponsorWorkspaceIcon'),
  toggleSponsorWorkspaceLabel: document.getElementById('toggleSponsorWorkspaceLabel'),
  toggleQuickSponsorEdit: document.getElementById('toggleQuickSponsorEdit'),
  toggleQuickSponsorEditIcon: document.getElementById('toggleQuickSponsorEditIcon'),
  toggleQuickSponsorEditLabel: document.getElementById('toggleQuickSponsorEditLabel'),
  sponsorForm: document.getElementById('sponsorForm'),
  sponsorIndexBadge: document.getElementById('sponsorIndexBadge'),
  sponsorDirtyState: document.getElementById('sponsorDirtyState'),
  saveSponsor: document.getElementById('saveSponsor'),
  saveSponsorLabel: document.getElementById('saveSponsorLabel'),
  addSponsor: document.getElementById('addSponsor'),
  deleteSponsor: document.getElementById('deleteSponsor'),
  sponsorLogosDisabledToggle: document.getElementById('sponsorLogosDisabledToggle'),
  logoWorkspacePanel: document.getElementById('logoWorkspacePanel'),
  flickrWorkspacePanel: document.getElementById('flickrWorkspacePanel'),
  showEventTab: document.getElementById('showEventTab'),
  showLogoTab: document.getElementById('showLogoTab'),
  showFlickrTab: document.getElementById('showFlickrTab'),
  showSessionsTab: document.getElementById('showSessionsTab'),
  showSessionDetailsSubTab: document.getElementById('showSessionDetailsSubTab'),
  showSessionTimelineSubTab: document.getElementById('showSessionTimelineSubTab'),
  sessionDetailsPanel: document.getElementById('sessionDetailsPanel'),
  showSponsorsTab: document.getElementById('showSponsorsTab'),
  showSitemapTab: document.getElementById('showSitemapTab'),
  sitemapWorkspacePanel: document.getElementById('sitemapWorkspacePanel'),
  timelineWorkspacePanel: document.getElementById('timelineWorkspacePanel'),
  timelineCanvas: document.getElementById('timelineCanvas'),
  showAppearanceTab: document.getElementById('showAppearanceTab'),
  appearanceWorkspacePanel: document.getElementById('appearanceWorkspacePanel'),

  sponsorSessionPickerModal: document.getElementById('sponsorSessionPickerModal'),
  sponsorSessionPickerList: document.getElementById('sponsorSessionPickerList'),
  sponsorSessionPickerCount: document.getElementById('sponsorSessionPickerCount'),
  closeSponsorSessionPicker: document.getElementById('closeSponsorSessionPicker'),
  closeSponsorSessionPickerBack: document.getElementById('closeSponsorSessionPickerBack'),
  sessionSponsorPickerModal: document.getElementById('sessionSponsorPickerModal'),
  sessionSponsorPickerList: document.getElementById('sessionSponsorPickerList'),
  sessionSponsorPickerCount: document.getElementById('sessionSponsorPickerCount'),
  closeSessionSponsorPicker: document.getElementById('closeSessionSponsorPicker'),
  closeSessionSponsorPickerBack: document.getElementById('closeSessionSponsorPickerBack'),
};

// Ensure the search button is always enabled for quick event switching
if (els.editorSearchEvents) {
  els.editorSearchEvents.disabled = false;
  els.editorSearchEvents.removeAttribute('disabled');

  // Watch for any attempts to disable the button and immediately revert them
  const observer = new MutationObserver(() => {
    if (els.editorSearchEvents.disabled) {
      els.editorSearchEvents.disabled = false;
      els.editorSearchEvents.removeAttribute('disabled');
    }
  });
  observer.observe(els.editorSearchEvents, { attributes: true, attributeFilter: ['disabled'] });
}

function outputBasename(pathValue) {
  const normalized = String(pathValue || '')
    .replace(/\\/g, '/')
    .trim();
  if (!normalized) return '';
  const segments = normalized.split('/').filter(Boolean);
  return segments.length ? segments[segments.length - 1] : '';
}

function normalizeOutputPath(value, fallback = 'data/new-event.json') {
  const raw = String(value || '')
    .replace(/\\/g, '/')
    .trim();
  if (!raw) return fallback;
  const withExt = raw.toLowerCase().endsWith('.json') ? raw : `${raw}.json`;
  if (withExt.includes('/')) return withExt;
  return `data/${withExt}`;
}

function getFileLinkKey(pathValue) {
  return normalizeOutputPath(
    pathValue || state.outputPath || `data/${state.file || 'new-event.json'}`,
  );
}

function replaceOutputBasename(pathValue, filename) {
  const normalized = normalizeOutputPath(pathValue);
  const base = normalizeString(filename);
  if (!base) return normalized;
  const dir = normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : 'data';
  return `${dir}/${base}`;
}

function openFileLinkDb() {
  if (fileLinkDbPromise) return fileLinkDbPromise;
  fileLinkDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(FILE_LINK_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(FILE_LINK_STORE)) {
        db.createObjectStore(FILE_LINK_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return fileLinkDbPromise;
}

async function getLinkedHandle(pathKey) {
  const db = await openFileLinkDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FILE_LINK_STORE, 'readonly');
    const store = tx.objectStore(FILE_LINK_STORE);
    const req = store.get(pathKey);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function setStoredProjectDirHandle(handle) {
  await setLinkedHandle(DIR_HANDLE_KEY, handle);
}

async function setLinkedHandle(pathKey, handle) {
  const db = await openFileLinkDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FILE_LINK_STORE, 'readwrite');
    const store = tx.objectStore(FILE_LINK_STORE);
    const req = store.put(handle, pathKey);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function restoreLinkedHandleForCurrentPath() {
  if (!state.dataset) return;
  const pathKey = getFileLinkKey();
  try {
    const handle = await getLinkedHandle(pathKey);
    if (!handle) {
      state.fileHandle = null;
      return;
    }
    if (typeof handle.queryPermission === 'function') {
      const permission = await handle.queryPermission({ mode: 'readwrite' });
      if (permission !== 'granted') {
        state.fileHandle = null;
        return;
      }
    }
    state.fileHandle = handle;
  } catch {
    // Permission query failed or handle is stale → drop it and re-prompt later.
    state.fileHandle = null;
  }
}

async function resolveFileHandleFromProjectDir(pathValue) {
  const dir = state.projectDirHandle;
  if (!dir) return null;
  const normalized = normalizeOutputPath(pathValue);
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) return null;
  let current = dir;
  for (let i = 0; i < segments.length - 1; i += 1) {
    current = await current.getDirectoryHandle(segments[i]);
  }
  return current.getFileHandle(segments[segments.length - 1]);
}

async function connectProjectFolder() {
  if (!isFolderPickerSupported()) return;
  const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
  state.projectDirHandle = handle;
  state.folderConnectedInSession = true;
  await setStoredProjectDirHandle(handle);
  await renderDatasetOptionsFromConnectedFolder();
  setDatasetLoadingEnabled(true);
  setFolderConnectionButtonState();
  syncWelcomePanel();
  await refreshEditorSearch();

  const returnFile = readText(STORAGE_KEYS.editorReturnFile);
  if (returnFile) {
    removeKey(STORAGE_KEYS.editorReturnFile);
    const returnOption = Array.from(els.datasetSelect.options).find((o) => o.value === returnFile);
    if (returnOption) {
      closeWelcomeModal();
      els.datasetSelect.value = returnFile;
      state.lastDatasetSelectValue = returnFile;
      try {
        await loadDataset(returnFile);
      } catch (error) {
        window.alert(`Could not resume file: ${error.message}`);
      }
      return;
    }
  }

  const selectedFile = normalizeString(els.datasetSelect.value);
  if (selectedFile) {
    if (!state.dataset || (await confirmDiscardPendingChanges(`dataset ${selectedFile}`))) {
      try {
        await loadDataset(selectedFile);
      } catch (error) {
        els.datasetSelect.value = '';
        state.lastDatasetSelectValue = '';
        window.alert(`Could not load dataset: ${error.message}`);
      }
    } else {
      els.datasetSelect.value = '';
      state.lastDatasetSelectValue = '';
    }
  }

  if (state.dataset && !state.fileHandle) {
    try {
      const fromDir = await resolveFileHandleFromProjectDir(state.outputPath);
      if (fromDir) {
        state.fileHandle = fromDir;
        await setLinkedHandle(getFileLinkKey(), fromDir);
      }
    } catch {
      // Ignore if file does not exist at selected folder path.
    }
  }
}

async function closeCurrentDataset() {
  if (state.dirty && !(await confirmDiscardPendingChanges('this event'))) return;
  state.dataset = null;
  state.file = '';
  state.outputPath = '';
  state.lastDatasetSelectValue = '';
  state.selectedIndex = -1;
  state.selectedSponsorIndex = -1;
  state.sessionSearchQuery = '';
  state.fileHandle = null;
  _homeMetaCache = null;
  markDirty(false);
  markSessionDirty(false);
  markSponsorDirty(false);
  resetSessionQuickEditState();
  resetSponsorQuickEditState();
  setCurrentFilenameLabel();
  setEditorButtonsEnabled(false);
  setActiveEditorTab('event');
  syncWelcomePanel();
}

function disconnectProjectFolder() {
  state.projectDirHandle = null;
  state.folderConnectedInSession = false;
  state.fileHandle = null;
  state.dataset = null;
  state.file = '';
  state.outputPath = '';
  state.lastDatasetSelectValue = '';
  state.selectedIndex = -1;
  state.selectedSponsorIndex = -1;
  state.sessionSearchQuery = '';
  setCurrentFilenameLabel();
  setDatasetLoadingEnabled(false);
  setEditorButtonsEnabled(false);
  els.eventMetaForm.innerHTML = '';
  if (els.logoForm) {
    els.logoForm.innerHTML = '<p class="edt-muted">Open a project folder to get started.</p>';
  }
  if (els.flickrForm) {
    els.flickrForm.innerHTML = '<p class="edt-muted">Open a project folder to get started.</p>';
  }
  els.sessionList.innerHTML = '<li class="edt-empty">Open a project folder to get started.</li>';
  els.sessionForm.innerHTML = '<p class="edt-muted">Select a session on the left to edit it.</p>';
  els.sponsorList.innerHTML = '<li class="edt-empty">Open a project folder to get started.</li>';
  els.sponsorForm.innerHTML = '<p class="edt-muted">Select a sponsor row to edit it.</p>';
  if (els.sessionSearchInput) {
    els.sessionSearchInput.value = '';
  }
  renderDatasetOptionsFromConnectedFolder();
  markDirty(false);
  resetSessionQuickEditState();
  resetSponsorQuickEditState();
  markSessionDirty(false);
  markSponsorDirty(false);
  setFolderConnectionButtonState();
  _homeMetaCache = null;
  syncWelcomePanel();
  void refreshEditorSearch();
}

function setCurrentFilenameLabel() {
  const pathValue = state.outputPath || (state.file ? `data/${state.file}` : '');
  if (els.pathChip) {
    const text = els.pathChip.querySelector('.toolbar-path-text');
    if (text) text.textContent = pathValue || 'No file open';
  }
}

function setEditorDocumentTitle() {
  const ev = state.dataset?.event || {};
  const name = [ev.designation, ev.location, ev.year].filter(Boolean).join(' ').trim();
  document.title = name
    ? `${name} - Dataset Editor`
    : 'Dataset Editor - Drupal Event Schedule Builder';
}

function setEditorButtonsEnabled(enabled) {
  if (els.exportDataset) {
    els.exportDataset.disabled = !enabled;
  }
  els.saveDataset.disabled = !enabled;
  if (els.saveDatasetToggle) els.saveDatasetToggle.disabled = !enabled;
  if (els.previewDataset) els.previewDataset.disabled = !enabled;
  if (els.previewDatasetToggle) els.previewDatasetToggle.disabled = !enabled;
  if (els.revertDataset)
    els.revertDataset.disabled = !enabled || !state.dirty || !state.persistedSnapshot;
  if (els.saveSession) els.saveSession.disabled = !enabled || state.selectedIndex < 0;
  els.addSession.disabled = !enabled;
  els.deleteSession.disabled = !enabled || state.selectedIndex < 0;
  if (els.saveSponsor) els.saveSponsor.disabled = !enabled || state.selectedSponsorIndex < 0;
  els.addSponsor.disabled = !enabled;
  els.deleteSponsor.disabled = !enabled || state.selectedSponsorIndex < 0;
  syncQuickSessionEditToggle();
  syncQuickSponsorEditToggle();
  syncSessionSaveButton();
  syncSponsorSaveButton();
}

function isSessionEditorEnabled() {
  return Boolean(state.dataset) && !els.addSession.disabled;
}

function isQuickSessionEditEnabled() {
  return state.sessionListExpanded && state.sessionQuickEditEnabled && isSessionEditorEnabled();
}

function syncQuickSessionEditToggle() {
  if (!els.toggleQuickSessionEdit) return;
  const visible = state.sessionListExpanded;
  const enabled = visible && isSessionEditorEnabled();
  const active = state.sessionQuickEditEnabled && enabled;
  els.toggleQuickSessionEdit.classList.toggle('hidden', !visible);
  els.toggleQuickSessionEdit.disabled = !enabled;
  els.toggleQuickSessionEdit.classList.toggle('opacity-60', visible && !enabled);
  els.toggleQuickSessionEdit.classList.toggle('cursor-not-allowed', visible && !enabled);
  els.toggleQuickSessionEdit.classList.toggle('editor-quick-edit-toggle-active', active);
  if (els.toggleQuickSessionEditLabel) {
    els.toggleQuickSessionEditLabel.textContent = 'Quick edit';
  }
  if (els.toggleQuickSessionEditIcon) {
    els.toggleQuickSessionEditIcon.classList.toggle('fa-pen-to-square', !active);
    els.toggleQuickSessionEditIcon.classList.toggle('fa-pen', active);
  }
}

function setQuickSessionEditEnabled(enabled) {
  const nextEnabled = Boolean(enabled) && state.sessionListExpanded && isSessionEditorEnabled();
  state.sessionQuickEditEnabled = nextEnabled;
  syncQuickSessionEditToggle();
  markSessionDirty(state.sessionDirty);
  renderSessionForm();
}

function isSponsorEditorEnabled() {
  return Boolean(state.dataset) && !els.addSponsor.disabled;
}

function isQuickSponsorEditEnabled() {
  return state.sponsorListExpanded && state.sponsorQuickEditEnabled && isSponsorEditorEnabled();
}

function syncQuickSponsorEditToggle() {
  if (!els.toggleQuickSponsorEdit) return;
  const visible = state.sponsorListExpanded;
  const enabled = visible && isSponsorEditorEnabled();
  const active = state.sponsorQuickEditEnabled && enabled;
  els.toggleQuickSponsorEdit.classList.toggle('hidden', !visible);
  els.toggleQuickSponsorEdit.disabled = !enabled;
  els.toggleQuickSponsorEdit.classList.toggle('opacity-60', visible && !enabled);
  els.toggleQuickSponsorEdit.classList.toggle('cursor-not-allowed', visible && !enabled);
  els.toggleQuickSponsorEdit.classList.toggle('editor-quick-edit-toggle-active', active);
  if (els.toggleQuickSponsorEditLabel) {
    els.toggleQuickSponsorEditLabel.textContent = 'Quick edit';
  }
  if (els.toggleQuickSponsorEditIcon) {
    els.toggleQuickSponsorEditIcon.classList.toggle('fa-pen-to-square', !active);
    els.toggleQuickSponsorEditIcon.classList.toggle('fa-pen', active);
  }
}

function setQuickSponsorEditEnabled(enabled) {
  const nextEnabled = Boolean(enabled) && state.sponsorListExpanded && isSponsorEditorEnabled();
  state.sponsorQuickEditEnabled = nextEnabled;
  syncQuickSponsorEditToggle();
  markSponsorDirty(state.sponsorDirty);
  renderSponsorForm();
}

function isFolderPickerSupported() {
  return typeof window.showDirectoryPicker === 'function';
}

function setFolderConnectionButtonState() {
  const unsupportedTitle =
    'Folder access is not supported in this browser — use the API server instead';

  if (isApiMode()) {
    if (els.folderConnectionToggle) els.folderConnectionToggle.classList.add('hidden');
    return;
  }

  if (els.folderConnectionToggle) {
    els.folderConnectionToggle.classList.remove('hidden');
    if (!isFolderPickerSupported()) {
      els.folderConnectionToggle.disabled = true;
      els.folderConnectionToggle.title = unsupportedTitle;
      els.folderConnectionToggle.innerHTML = 'Connect Folder';
    } else {
      els.folderConnectionToggle.disabled = false;
      els.folderConnectionToggle.title = '';
      els.folderConnectionToggle.innerHTML =
        state.folderConnectedInSession && state.projectDirHandle
          ? 'Disconnect folder'
          : 'Open project folder';
    }
  }
}

function setDatasetLoadingEnabled(enabled) {
  els.datasetSelect.disabled = !enabled;
}

function cloneJsonValue(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function capturePersistedSnapshot() {
  state.persistedSnapshot = {
    dataset: cloneJsonValue(state.dataset),
    file: state.file,
    outputPath: state.outputPath,
  };
}

async function restorePersistedSnapshot() {
  if (!state.persistedSnapshot) return;
  state.dataset = cloneJsonValue(state.persistedSnapshot.dataset);
  state.file = state.persistedSnapshot.file || '';
  state.outputPath = state.persistedSnapshot.outputPath || '';
  normalizeDatasetShape();
  state.fileHandle = null;
  await restoreLinkedHandleForCurrentPath();
  setCurrentFilenameLabel();
  resetSessionQuickEditState();
  resetSponsorQuickEditState();
  markDirty(false);
  markSessionDirty(false);
  markSponsorDirty(false);
  renderEventMetaForm();
  renderAppearanceForm();
  renderLogoForm();
  renderFlickrForm();
  renderSessionList();
  renderSessionForm();
  renderSponsorList();
  renderSponsorForm();
  syncSessionSaveButton();
  syncSponsorSaveButton();
}

function saveRecoverySnapshot() {
  if (!state.dataset) return;
  writeJson(RECOVERY_KEY, {
    dataset: state.dataset,
    file: state.file,
    outputPath: state.outputPath,
    savedAt: Date.now(),
  });
}

function clearRecoverySnapshot() {
  removeKey(RECOVERY_KEY);
}

function loadRecoverySnapshot() {
  const data = readJson(RECOVERY_KEY, null);
  if (!data?.dataset || !data?.file) return null;
  if (data.savedAt && Date.now() - data.savedAt > RECOVERY_MAX_AGE_MS) {
    clearRecoverySnapshot();
    return null;
  }
  return data;
}

function applyRecovery(recovery) {
  state.dataset = recovery.dataset;
  state.file = recovery.file || '';
  state.outputPath = recovery.outputPath || '';
  state.selectedIndex = -1;
  state.selectedSponsorIndex = -1;
  state.sessionSearchQuery = '';
  normalizeDatasetShape();
  clearRecoverySnapshot();
  undoClear();
  markDirty(true);
  markSessionDirty(false);
  markSponsorDirty(false);
  setEditorButtonsEnabled(true);
  setCurrentFilenameLabel();
  renderEventMetaForm();
  renderAppearanceForm();
  renderSessionList();
  renderSessionForm();
  renderSponsorList();
  renderSponsorForm();
  syncSessionSaveButton();
  syncSponsorSaveButton();
  closeWelcomeModal();
  restorePendingEditorTab(); // return to the workspace the URL asked for
}

function showRecoveryBar(recovery) {
  const bar = document.getElementById('recoveryBar');
  const textEl = document.getElementById('recoveryBarText');
  if (!bar || !textEl) return;
  const ageMs = Date.now() - (recovery.savedAt || 0);
  const ageMin = Math.round(ageMs / 60_000);
  const ageText = ageMin < 1 ? 'just now' : ageMin === 1 ? '1 minute ago' : `${ageMin} minutes ago`;
  textEl.textContent = `Unsaved work from ${ageText} found for "${recovery.file}".`;
  bar.classList.remove('hidden');
  document.getElementById('recoveryRestore')?.addEventListener('click', () => {
    applyRecovery(recovery);
    bar.classList.add('hidden');
  });
  document.getElementById('recoveryDismiss')?.addEventListener('click', () => {
    if (!window.confirm('Discard the recovered work? This cannot be undone.')) return;
    clearRecoverySnapshot();
    bar.classList.add('hidden');
  });
}

function undoPush() {
  if (!state.dataset) return;
  UNDO_STACK.push({
    dataset: cloneJsonValue(state.dataset),
    selectedIndex: state.selectedIndex,
    selectedSponsorIndex: state.selectedSponsorIndex,
  });
  if (UNDO_STACK.length > UNDO_LIMIT) UNDO_STACK.shift();
  updateUndoButton();
}

function undoClear() {
  UNDO_STACK.length = 0;
  updateUndoButton();
}

function updateUndoButton() {
  if (els.undoAction) {
    els.undoAction.disabled = UNDO_STACK.length === 0;
    els.undoAction.title =
      UNDO_STACK.length > 0
        ? `Undo (${UNDO_STACK.length} step${UNDO_STACK.length === 1 ? '' : 's'}) — Ctrl+Z`
        : 'Nothing to undo';
  }
}

async function performUndo() {
  if (UNDO_STACK.length === 0) return;
  const entry = UNDO_STACK.pop();
  state.dataset = entry.dataset;
  state.selectedIndex = entry.selectedIndex;
  state.selectedSponsorIndex = entry.selectedSponsorIndex;
  state.quickEditSessionChanges = new Set();
  state.quickEditSponsorChanges = new Set();
  normalizeDatasetShape();
  const matchesSaved =
    state.persistedSnapshot &&
    JSON.stringify(state.dataset) === JSON.stringify(state.persistedSnapshot.dataset);
  markDirty(!matchesSaved);
  markSessionDirty(false);
  markSponsorDirty(false);
  updateUndoButton();
  renderEventMetaForm();
  renderAppearanceForm();
  renderSessionList();
  renderSessionForm();
  renderSponsorList();
  renderSponsorForm();
  syncSessionSaveButton();
  syncSponsorSaveButton();
  if (els.deleteSession) els.deleteSession.disabled = state.selectedIndex < 0;
  if (els.deleteSponsor) els.deleteSponsor.disabled = state.selectedSponsorIndex < 0;
}

function confirmDiscardPendingChanges(targetLabel = 'another file') {
  if (!state.dirty) return Promise.resolve(true);
  return new Promise((resolve) => {
    const modal = document.getElementById('unsavedChangesModal');
    if (!modal) {
      const proceed = window.confirm('You have unsaved changes. Discard and continue?');
      if (proceed) restorePersistedSnapshot().then(() => resolve(true));
      else resolve(false);
      return;
    }
    const targetEl = document.getElementById('unsavedChangesTarget');
    if (targetEl) targetEl.textContent = targetLabel;
    modal.classList.remove('hidden');
    document.body.classList.add('session-modal-open');

    const close = () => {
      modal.classList.add('hidden');
      document.body.classList.remove('session-modal-open');
    };

    document.getElementById('unsavedModalSave').addEventListener(
      'click',
      async () => {
        close();
        try {
          await saveDataset();
          resolve(true);
        } catch (err) {
          reportError('saveDataset (unsaved-changes prompt)', err);
          resolve(false);
        }
      },
      { once: true },
    );

    document.getElementById('unsavedModalDiscard').addEventListener(
      'click',
      async () => {
        close();
        await restorePersistedSnapshot();
        resolve(true);
      },
      { once: true },
    );

    document.getElementById('unsavedModalCancel').addEventListener(
      'click',
      () => {
        close();
        resolve(false);
      },
      { once: true },
    );

    modal.addEventListener(
      'click',
      (e) => {
        if (e.target === modal) {
          close();
          resolve(false);
        }
      },
      { once: true },
    );
  });
}

let _lastSavedAt = null;

function markDirty(nextDirty = true) {
  state.dirty = nextDirty;
  const unsaved = nextDirty;
  let label;
  if (nextDirty) {
    label = 'Unsaved changes';
  } else if (_lastSavedAt) {
    label = `Saved ${_lastSavedAt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
  } else {
    label = 'No changes';
  }
  els.dirtyState.innerHTML = `<span class="sidebar-dirty-dot${unsaved ? ' is-dirty' : ''}"></span><span>${label}</span>`;
  els.dirtyState.dataset.dirty = String(nextDirty);
  els.saveDataset.classList.toggle('is-dirty', nextDirty);
  els.saveDataset.title = nextDirty ? 'Save changes (Ctrl+S)' : 'No unsaved changes';
  if (els.revertDataset) {
    els.revertDataset.disabled = !nextDirty || !state.persistedSnapshot;
  }
}

let _saveToastTimer = null;
function showSaveToast() {
  if (!els.saveToast) return;
  _lastSavedAt = new Date();
  clearTimeout(_saveToastTimer);
  els.saveToast.classList.add('is-visible');
  _saveToastTimer = setTimeout(() => els.saveToast.classList.remove('is-visible'), 2500);
}

function syncWelcomePanel() {
  if (!els.home || !els.app) return;
  const show = isApiMode()
    ? !state.dataset
    : (!state.folderConnectedInSession || !state.projectDirHandle) && !state.dataset;

  els.home.classList.toggle('hidden', !show);
  els.app.classList.toggle('hidden', show);
  document.getElementById('editorSidebarNav')?.classList.toggle('hidden', show);

  if (show) {
    const connected = isApiMode()
      ? !!state.apiEndpoint
      : !!(state.folderConnectedInSession && state.projectDirHandle);
    if (connected) renderEditorHomePhase2();
    else renderEditorHomePhase1();
  }
}

function closeWelcomeModal() {
  if (!els.home || !els.app) return;
  els.home.classList.add('hidden');
  els.app.classList.remove('hidden');
  document.getElementById('editorSidebarNav')?.classList.remove('hidden');
}

// Connect the editor to an API endpoint (shared by the API-settings modal and the
// "Edit online (this server)" home card) and load its dataset list. Passing '' or
// nothing disconnects.
async function connectEditorApi(endpoint) {
  endpoint = String(endpoint || '')
    .trim()
    .replace(/\/$/, '');
  state.apiEndpoint = endpoint;
  if (endpoint) writeText(STORAGE_KEYS.editorApiEndpoint, endpoint);
  else removeKey(STORAGE_KEYS.editorApiEndpoint);
  syncApiModeUI();
  setFolderConnectionButtonState();
  if (endpoint && !state.dataset) {
    await renderDatasetOptionsFromConnectedFolder();
    setDatasetLoadingEnabled(true);
  }
  _homeMetaCache = null;
  syncWelcomePanel();
  await refreshEditorSearch();
}

function renderEditorHomePhase1() {
  if (!els.home) return;
  const folderSupported = isFolderPickerSupported();
  const recentHtml = _buildRecentFilesHtml();
  const settingsBtn = `<button type="button" class="hl-settings-btn" id="ehSettingsBtn" title="Settings" aria-label="Settings"><span class="hl-settings-btn-label">Settings</span></button>`;
  els.home.innerHTML = homeRoot(`
    ${heroPanel({ title: 'Dataset Editor', lead: 'Build and edit Drupal event schedules. Connect your project folder or an API server to get started.', actionsHtml: settingsBtn })}
    ${(() => {
      // "Edit online (this server)" uses the same-origin API — leading option when
      // the editor is served from a hosted server, otherwise offered after the
      // local choices.
      const hosted = !['localhost', '127.0.0.1', '0.0.0.0', ''].includes(location.hostname);
      const onlineCard = ctaCard({
        id: 'ehEditOnline',
        title: 'Edit online (this server)',
        desc: hosted
          ? 'Edit the datasets on this server directly. Requires an editor login.'
          : 'Edit the datasets served by this local server — no separate connection.',
      });
      const folderCard = ctaCard({
        id: 'ehConnectFolder',
        title: 'Open Project Folder',
        desc: folderSupported
          ? 'Grant access to your local project directory. Works in Chrome and Edge.'
          : 'Not available in this browser — use the API server instead.',
        disabled: !folderSupported,
        disabledReason: 'Folder access not supported in this browser — use the API server instead',
      });
      const apiCard = ctaCard({
        id: 'ehConnectApi',
        title: 'Connect to API Server',
        desc: 'Use a different / local server for Firefox-compatible saving and image uploads.',
      });
      return ctaGrid(
        hosted ? onlineCard + folderCard + apiCard : folderCard + apiCard + onlineCard,
      );
    })()}
    ${recentHtml}
  `);

  document.getElementById('ehSettingsBtn')?.addEventListener('click', openEditorSettings);
  document.getElementById('ehConnectFolder')?.addEventListener('click', connectProjectFolder);
  document
    .getElementById('ehEditOnline')
    ?.addEventListener('click', () => connectEditorApi(window.location.origin));
  document.getElementById('ehConnectApi')?.addEventListener('click', () => {
    const modal = document.getElementById('apiSettingsModal');
    const input = document.getElementById('apiEndpointInput');
    const result = document.getElementById('apiTestResult');
    if (input) input.value = state.apiEndpoint;
    if (result) {
      result.textContent = '';
      result.className = 'text-sm hidden';
    }
    if (modal) {
      modal.classList.remove('hidden');
      modal.setAttribute('aria-hidden', 'false');
    }
  });
  els.home.querySelectorAll('[data-eh-recent]').forEach((btn) => {
    btn.addEventListener('click', () => _openRecentFile(btn.dataset.ehRecent));
  });
}

async function renderEditorHomePhase2() {
  if (!els.home) return;
  const connectionLabel = isApiMode()
    ? state.apiEndpoint
    : state.projectDirHandle?.name || 'Project folder';

  els.home.innerHTML = homeRoot(`
    ${statusBar({ label: escapeHtml(connectionLabel), actionId: 'ehDisconnectBtn', actionText: isApiMode() ? 'Disconnect' : 'Disconnect folder' })}
    ${sectionHeader({ title: 'Events', primaryBtnId: 'ehNewEvent', primaryBtnLabel: 'New event', secondaryBtnId: 'ehSettingsBtn', secondaryBtnTitle: 'Settings' })}
    ${searchBar({ inputId: 'ehEventSearch', placeholder: 'Filter events…' })}
    ${cardGrid({ id: 'ehEventGrid', innerHtml: loadingState('Loading events…') })}
  `);

  document.getElementById('ehDisconnectBtn')?.addEventListener('click', () => {
    if (isApiMode()) {
      state.apiEndpoint = '';
      removeKey(STORAGE_KEYS.editorApiEndpoint);
      syncApiModeUI();
      setFolderConnectionButtonState();
      syncWelcomePanel();
    } else {
      disconnectProjectFolder();
    }
  });

  document.getElementById('ehSettingsBtn')?.addEventListener('click', openEditorSettings);
  document.getElementById('ehNewEvent')?.addEventListener('click', () => {
    const pathValue = promptForNewFilename();
    if (!pathValue) return;
    closeWelcomeModal();
    createDatasetScaffold(pathValue);
  });

  let records;
  try {
    if (isApiMode()) {
      const files = eventCatalog.map((e) => e.file).filter((f) => f && isEditorDatasetFile(f));
      records = await loadDatasetMetaForGroupingViaFetch(files);
    } else {
      if (!_homeMetaCache) {
        const files = await listDatasetFilesFromConnectedFolder();
        _homeMetaCache = await loadDatasetMetaForGrouping(files);
      }
      records = _homeMetaCache;
    }
  } catch {
    // Folder not connected or unreadable → render an empty home grid.
    records = [];
  }

  _renderEventCards(records);

  const searchInput = document.getElementById('ehEventSearch');
  if (searchInput) {
    searchInput.addEventListener('input', (e) =>
      _filterEventCards(e.target.value.trim().toLowerCase()),
    );
    searchInput.focus();
  }
}

function _renderEventCards(records) {
  const grid = document.getElementById('ehEventGrid');
  if (!grid) return;

  if (!records || !records.length) {
    grid.innerHTML = '<p class="hl-empty">No event files found.</p>';
    return;
  }

  const sorted = [...records].sort((a, b) => {
    const da = a.startDate ? new Date(a.startDate).getTime() : 0;
    const db = b.startDate ? new Date(b.startDate).getTime() : 0;
    return db - da;
  });

  grid.innerHTML = sorted
    .map((r) => {
      const isHidden = r.enabled === false;
      const statusChip = isHidden
        ? `<span class="eh-chip eh-chip--disabled">Hidden</span>`
        : `<span class="eh-chip eh-chip--ok">Enabled</span>`;
      const dateRange = _fmtEventDateRange(r.startDate, r.endDate);
      return `
      <button type="button" class="eh-event-card" data-eh-file="${escapeAttr(r.file)}">
        <div class="eh-event-card-header">
          ${r.designation ? `<span class="eh-desig-badge">${escapeHtml(r.designation.toUpperCase())}</span>` : ''}
          <div class="eh-chip-row">${statusChip}</div>
        </div>
        <h3 class="eh-event-title">${escapeHtml(r.label)}</h3>
        ${r.location ? `<p class="eh-event-meta">${escapeHtml(r.location)}</p>` : ''}
        ${dateRange ? `<p class="eh-event-meta">${escapeHtml(dateRange)}</p>` : ''}
        <div class="eh-event-file">${escapeHtml(r.file)}</div>
        </button>`;
    })
    .join('');

  grid.querySelectorAll('[data-eh-file]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const file = btn.dataset.ehFile;
      closeWelcomeModal();
      els.datasetSelect.value = file;
      state.lastDatasetSelectValue = file;
      try {
        await loadDataset(file);
      } catch (e) {
        window.alert(`Could not load event: ${e.message}`);
      }
    });
  });
}

function _filterEventCards(query) {
  const grid = document.getElementById('ehEventGrid');
  if (!grid) return;
  grid.querySelectorAll('.eh-event-card[data-eh-file]').forEach((card) => {
    const hide = query.length > 0 && !card.textContent.toLowerCase().includes(query);
    card.style.display = hide ? 'none' : '';
  });
}

function _fmtEventDateRange(startDate, endDate) {
  if (!startDate) return '';
  try {
    const s = new Date(startDate);
    const e = endDate ? new Date(endDate) : null;
    const opts = { month: 'short', day: 'numeric', year: 'numeric' };
    if (!e || startDate === endDate) return s.toLocaleDateString(undefined, opts);
    if (s.getFullYear() === e.getFullYear()) {
      const sStr = s.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      return `${sStr} – ${e.toLocaleDateString(undefined, opts)}`;
    }
    return `${s.toLocaleDateString(undefined, opts)} – ${e.toLocaleDateString(undefined, opts)}`;
  } catch {
    return ''; /* unparseable date range → render nothing */
  }
}

function _buildRecentFilesHtml() {
  const recent = (readJson(STORAGE_KEYS.editorRecentFiles, []) || []).slice(0, 5);
  if (!recent.length) return '';
  return `<div class="eh-recent">
    <h2 class="eh-recent-title">Recently opened</h2>
    <ul class="eh-recent-list">
      ${recent
        .map(
          (f) => `
        <li>
          <button type="button" class="eh-recent-item" data-eh-recent="${escapeAttr(f)}">
            <span class="eh-recent-label">${escapeHtml(f)}</span>
            </button>
        </li>`,
        )
        .join('')}
    </ul>
  </div>`;
}

async function _openRecentFile(file) {
  if (!file) return;
  if (!isApiMode() && (!state.folderConnectedInSession || !state.projectDirHandle)) {
    await connectProjectFolder();
    return;
  }
  closeWelcomeModal();
  els.datasetSelect.value = file;
  state.lastDatasetSelectValue = file;
  try {
    await loadDataset(file);
  } catch (e) {
    window.alert(`Could not load recent file: ${e.message}`);
  }
}

function markSessionDirty(nextDirty = true) {
  state.sessionDirty = nextDirty;
  if (!els.sessionDirtyState) return;
  const quickCount = state.quickEditSessionChanges.size;
  const hasQuickChanges = quickCount > 0 || state.sessionStructureDirty;
  const unsaved = state.sessionDirty || hasQuickChanges;
  let label = 'No changes';
  if (isQuickSessionEditEnabled()) {
    if (hasQuickChanges) {
      label =
        quickCount > 0
          ? `${quickCount} item${quickCount === 1 ? '' : 's'} modified`
          : 'Unsaved quick edits';
    }
  } else if (state.sessionDirty || hasQuickChanges) {
    label = 'Modified';
  }
  els.sessionDirtyState.innerHTML = `<span class="sidebar-dirty-dot${unsaved ? ' is-dirty' : ''}"></span><span>${label}</span>`;
  syncSessionSaveButton();
}

function markSponsorDirty(nextDirty = true) {
  state.sponsorDirty = nextDirty;
  if (!els.sponsorDirtyState) return;
  const quickCount = state.quickEditSponsorChanges.size;
  const hasQuickChanges = quickCount > 0 || state.sponsorStructureDirty;
  const unsaved = state.sponsorDirty || hasQuickChanges;
  let label = 'No changes';
  if (isQuickSponsorEditEnabled()) {
    if (hasQuickChanges) {
      label =
        quickCount > 0
          ? `${quickCount} item${quickCount === 1 ? '' : 's'} modified`
          : 'Unsaved quick edits';
    }
  } else if (state.sponsorDirty || hasQuickChanges) {
    label = 'Modified';
  }
  els.sponsorDirtyState.innerHTML = `<span class="sidebar-dirty-dot${unsaved ? ' is-dirty' : ''}"></span><span>${label}</span>`;
  syncSponsorSaveButton();
}

function trackQuickSessionChange(index = state.selectedIndex, structural = false) {
  if (index >= 0) {
    state.quickEditSessionChanges.add(index);
  }
  if (structural) {
    state.sessionStructureDirty = true;
  }
  markSessionDirty(
    Boolean(
      state.sessionDirty || state.quickEditSessionChanges.size > 0 || state.sessionStructureDirty,
    ),
  );
}

function trackQuickSponsorChange(index = state.selectedSponsorIndex, structural = false) {
  if (index >= 0) {
    state.quickEditSponsorChanges.add(index);
  }
  if (structural) {
    state.sponsorStructureDirty = true;
  }
  markSponsorDirty(
    Boolean(
      state.sponsorDirty || state.quickEditSponsorChanges.size > 0 || state.sponsorStructureDirty,
    ),
  );
}

function resetSessionQuickEditState() {
  state.quickEditSessionChanges = new Set();
  state.sessionStructureDirty = false;
}

function resetSponsorQuickEditState() {
  state.quickEditSponsorChanges = new Set();
  state.sponsorStructureDirty = false;
}

function moveTrackedIndex(set, from, to) {
  if (!(set instanceof Set) || from < 0 || to < 0 || from === to || set.size === 0) return;
  const next = new Set();
  set.forEach((index) => {
    if (index === from) {
      next.add(to);
    } else if (from < to && index > from && index <= to) {
      next.add(index - 1);
    } else if (to < from && index >= to && index < from) {
      next.add(index + 1);
    } else {
      next.add(index);
    }
  });
  set.clear();
  next.forEach((index) => set.add(index));
}

function removeTrackedIndex(set, removedIndex) {
  if (!(set instanceof Set) || removedIndex < 0 || set.size === 0) return;
  const next = new Set();
  set.forEach((index) => {
    if (index === removedIndex) return;
    next.add(index > removedIndex ? index - 1 : index);
  });
  set.clear();
  next.forEach((index) => set.add(index));
}

function syncSessionSaveButton() {
  if (!els.saveSession) return;
  const canSaveSelection = Boolean(state.dataset) && state.selectedIndex >= 0;
  const hasQuickChanges = state.quickEditSessionChanges.size > 0 || state.sessionStructureDirty;
  const saveAll = isQuickSessionEditEnabled();
  if (els.saveSessionLabel) {
    els.saveSessionLabel.textContent = saveAll ? 'Save all' : 'Save';
  }
  els.saveSession.disabled = saveAll
    ? !Boolean(state.dataset) || !hasQuickChanges
    : !canSaveSelection;
}

function syncSponsorSaveButton() {
  if (!els.saveSponsor) return;
  const canSaveSelection = Boolean(state.dataset) && state.selectedSponsorIndex >= 0;
  const hasQuickChanges = state.quickEditSponsorChanges.size > 0 || state.sponsorStructureDirty;
  const saveAll = isQuickSponsorEditEnabled();
  if (els.saveSponsorLabel) {
    els.saveSponsorLabel.textContent = saveAll ? 'Save all' : 'Save';
  }
  els.saveSponsor.disabled = saveAll
    ? !Boolean(state.dataset) || !hasQuickChanges
    : !canSaveSelection;
}

function toStringValue(value) {
  if (Array.isArray(value)) return value.join(', ');
  return value == null ? '' : String(value);
}

function syncAllSessionDurations() {
  if (!Array.isArray(state.dataset?.items)) return;
  state.dataset.items.forEach((item) => {
    syncSessionDuration(item);
  });
}

function markdownToHtml(text) {
  return formatTextBlock(text) || '<p class="edt-ink-2"><em>No description yet.</em></p>';
}

function isValidTimezone(value) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return true;
  } catch {
    // Intl throws on unknown zones → treat as invalid.
    return false;
  }
}

function safeTimezone(value) {
  const tz = normalizeString(value);
  if (tz && state.timezones.includes(tz)) return tz;
  if (tz && isValidTimezone(tz)) return tz;
  return 'UTC';
}

function buildTimezoneList() {
  let values = [];
  if (typeof Intl.supportedValuesOf === 'function') {
    try {
      values = Intl.supportedValuesOf('timeZone');
    } catch {
      // Older engines may reject this key → fall back to an empty list.
      values = [];
    }
  }
  if (!values.length) {
    values = [
      'UTC',
      'Australia/Sydney',
      'Australia/Melbourne',
      'Australia/Brisbane',
      'Australia/Adelaide',
      'Australia/Perth',
      'Australia/Canberra',
      'Pacific/Auckland',
      'Asia/Singapore',
      'Asia/Tokyo',
      'America/New_York',
      'America/Chicago',
      'America/Denver',
      'America/Los_Angeles',
      'Europe/London',
      'Europe/Paris',
      'Asia/Kolkata',
    ];
  }
  if (!values.includes('UTC')) values.unshift('UTC');
  state.timezones = [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function getEventTimezone() {
  return safeTimezone(state.dataset?.event?.timezone || 'UTC');
}

function formatSessionTimeForList(iso) {
  const local = utcIsoToLocalInput(iso, getEventTimezone());
  if (!local) return '';
  return local.replace('T', ' ');
}

function getManifestLabelByFile(file) {
  const found = eventCatalog.find((item) => item.file === file);
  return found?.label || file;
}

async function getDataDirectoryHandle(create = false) {
  if (!state.projectDirHandle) return null;
  return state.projectDirHandle.getDirectoryHandle('data', { create });
}

async function listDatasetFilesFromConnectedFolder() {
  const dataDir = await getDataDirectoryHandle(false);
  if (!dataDir) return [];
  const files = [];
  async function scanDir(dirHandle, prefix) {
    for await (const [name, handle] of dirHandle.entries()) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === 'directory') {
        await scanDir(handle, rel);
      } else if (isEditorDatasetFile(name)) {
        files.push(rel);
      }
    }
  }
  await scanDir(dataDir, '');
  return files.sort((a, b) => a.localeCompare(b));
}

// Load grouping records for `files`, reading each dataset's JSON via the supplied
// `read(file)` strategy (project-folder handle vs fetch), then sort by group+label.
async function loadDatasetMetaWith(files, read) {
  const records = await Promise.all(
    files.map(async (file) => {
      try {
        const parsed = await read(file);
        validateDatasetSchema(parsed, file);
        const eventMeta = parsed && typeof parsed === 'object' ? parsed.event || {} : {};
        return buildDatasetGroupingRecord(file, eventMeta, getManifestLabelByFile(file));
      } catch {
        return buildDatasetGroupingFallback(file, getManifestLabelByFile(file));
      }
    }),
  );
  records.sort((a, b) => {
    const groupCmp = a.group.localeCompare(b.group);
    return groupCmp !== 0 ? groupCmp : a.label.localeCompare(b.label);
  });
  return records;
}

async function loadDatasetMetaForGrouping(files) {
  if (!state.projectDirHandle) return [];
  return loadDatasetMetaWith(files, async (file) => {
    const handle = await resolveFileHandleFromProjectDir(`data/${file}`);
    const blob = await handle.getFile();
    return JSON.parse(await blob.text());
  });
}

async function loadDatasetMetaForGroupingViaFetch(files) {
  return loadDatasetMetaWith(files, async (file) => {
    const url = isApiMode()
      ? `${state.apiEndpoint}/api/data/${file.split('/').map(encodeURIComponent).join('/')}`
      : `./data/${file}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error();
    return res.json();
  });
}

async function renderDatasetOptionsFromConnectedFolder(preferred = '') {
  if (!isApiMode() && (!state.projectDirHandle || !state.folderConnectedInSession)) {
    els.datasetSelect.innerHTML = '<option value="">Connect folder to load datasets</option>';
    els.datasetSelect.value = '';
    return;
  }

  const files = isApiMode()
    ? eventCatalog
        .map((e) => e.file)
        .filter((f) => f && isEditorDatasetFile(f))
        .sort((a, b) => a.localeCompare(b))
    : await listDatasetFilesFromConnectedFolder();
  if (files.length === 0) {
    els.datasetSelect.innerHTML = '<option value="">No JSON files found in data/</option>';
    els.datasetSelect.value = '';
    return;
  }

  const groupedRecords = isApiMode()
    ? await loadDatasetMetaForGroupingViaFetch(files)
    : await loadDatasetMetaForGrouping(files);
  const groups = new Map();
  groupedRecords.forEach((record) => {
    if (!groups.has(record.group)) groups.set(record.group, []);
    groups.get(record.group).push(record);
  });

  els.datasetSelect.innerHTML = [...groups.entries()]
    .map(([groupName, records]) => {
      const options = records
        .map(
          (record) =>
            `<option value="${escapeAttr(record.file)}" data-enabled="${record.enabled !== false}">${escapeHtml(record.label)}</option>`,
        )
        .join('');
      return `<optgroup label="${escapeAttr(groupName)}">${options}</optgroup>`;
    })
    .join('');

  if (preferred && files.includes(preferred)) {
    els.datasetSelect.value = preferred;
    return;
  }

  const defaultItem = eventCatalog.find((i) => i.default);
  if (defaultItem && files.includes(defaultItem.file)) {
    els.datasetSelect.value = defaultItem.file;
    return;
  }

  els.datasetSelect.value = files[0];
}

// Bring a loaded dataset up to the current shape: ensure the base structure,
// then run each independent migration/normalization step in order.
function normalizeDatasetShape() {
  ensureDatasetBaseShape();
  const event = state.dataset.event;
  migrateEventMedia(event);
  applyEventDefaults(event);
  migrateThemeFields(event);
  syncAllSessionDurations();
  normalizeItemSponsorIds();
}

function ensureDatasetBaseShape() {
  if (!state.dataset || typeof state.dataset !== 'object') state.dataset = {};
  if (!state.dataset.event || typeof state.dataset.event !== 'object') state.dataset.event = {};
  if (!Array.isArray(state.dataset.items)) state.dataset.items = [];
  stripSummaryFields(state.dataset);
}

// Fold the legacy mediaPromo block into the flickr object, then normalize the
// flickr / logo / sponsor sub-objects and drop the obsolete mediaPromo field.
function migrateEventMedia(event) {
  const mediaPromo = event.mediaPromo;
  const flickrFromMediaPromo =
    mediaPromo && typeof mediaPromo === 'object'
      ? {
          enabled: true,
          groupUrl: mediaPromo.groupUrl,
          image: mediaPromo.image,
          imageAlt: mediaPromo.imageAlt,
          title: mediaPromo.title,
          text: mediaPromo.text,
          buttonLabel: mediaPromo.buttonLabel,
          mode: mediaPromo.mode,
        }
      : null;
  event.flickr = normalizeFlickrObject(event.flickr || flickrFromMediaPromo);
  event.logo = normalizeLogoObject(event.logo);
  event.sponsors = normalizeSponsorCollection(event.sponsors);
  // Related events are optional — only coerce when the dataset already carries them,
  // so untouched files don't gain an empty array on every save.
  if (event.relatedEvents != null) {
    event.relatedEvents = normalizeRelatedEventCollection(event.relatedEvents);
  }
  if (Object.prototype.hasOwnProperty.call(event, 'mediaPromo')) {
    delete event.mediaPromo;
  }
}

// Fill in defaults (timezone, columns) and normalize the URL arrays.
function applyEventDefaults(event) {
  if (!event.timezone) event.timezone = 'UTC';
  if (event.columns == null || event.columns === '') event.columns = 3;
  event.scheduleURLs = normalizeUrlArray(event.scheduleURLs);
  event.other_urls = normalizeUrlArray(event.other_urls || []);
}

// Migrate a legacy string theme and top-level color fields into the theme
// object, dropping any color that isn't a valid #rrggbb hex.
function migrateThemeFields(event) {
  const hexPattern = /^#[0-9a-fA-F]{6}$/;
  if (typeof event.theme === 'string') {
    event.theme = { id: event.theme };
  } else if (!event.theme || typeof event.theme !== 'object') {
    event.theme = {};
  }
  for (const colorField of ['primaryColor', 'secondaryColor', 'tertiaryColor']) {
    const topLevel = event[colorField];
    if (topLevel) {
      if (!event.theme[colorField]) event.theme[colorField] = topLevel;
      delete event[colorField];
    }
    const v = event.theme[colorField];
    if (v != null && !hexPattern.test(v)) delete event.theme[colorField];
  }
  if (Object.keys(event.theme).length === 0) delete event.theme;
}

// Collapse each item's sponsorIds to a single string when there are 0-1 ids.
function normalizeItemSponsorIds() {
  state.dataset.items.forEach((item) => {
    if (!item || typeof item !== 'object') return;
    const sponsorIds = parseMultiValue(item.sponsorIds || '');
    item.sponsorIds = sponsorIds.length <= 1 ? sponsorIds[0] || '' : sponsorIds;
  });
}

async function loadDataset(file) {
  if (!isApiMode() && (!state.projectDirHandle || !state.folderConnectedInSession)) {
    throw new Error('Connect folder first.');
  }
  // The lineage map is archive-wide, so it is fetched once and reused across
  // every dataset opened this session.
  await loadSeriesMap();
  if (readText(PHOTOS_BACKUP_KEY)) {
    await revertPendingPhotoUpload();
  }
  if (readText(LOGO_BACKUP_KEY)) {
    await revertPendingLogoUpload();
  }
  if (!isEditorDatasetFile(file)) {
    throw new Error(`${file} is not an editable dataset.`);
  }
  const targetPath = normalizeOutputPath(`data/${file}`);
  let handle = null;
  let parsed;
  let rawText = '';
  if (isApiMode()) {
    const res = await fetch(
      `${state.apiEndpoint}/api/data/${file.split('/').map(encodeURIComponent).join('/')}`,
      { cache: 'no-store' },
    );
    if (!res.ok) throw new Error(`Failed to load ${file}: HTTP ${res.status}`);
    rawText = await res.text();
    parsed = JSON.parse(rawText);
  } else {
    handle = await resolveFileHandleFromProjectDir(targetPath);
    const fileBlob = await handle.getFile();
    rawText = await fileBlob.text();
    parsed = JSON.parse(rawText);
  }
  validateDatasetSchema(parsed, file);
  // Fingerprint the exact bytes we loaded (before normalization mutates the
  // in-memory copy) — this is our reference for the concurrent-edit guard.
  state.loadedDiskFingerprint = contentFingerprint(rawText);
  state.dataset = parsed;
  state.file = file;
  state.outputPath = targetPath;
  state.lastDatasetSelectValue = file;
  state.fileHandle = handle;
  state.selectedIndex = -1;
  state.selectedSponsorIndex = -1;
  state.sessionSearchQuery = '';
  normalizeDatasetShape();
  if (!isApiMode()) {
    await restoreLinkedHandleForCurrentPath();
    if (!state.fileHandle && state.projectDirHandle) {
      try {
        const fromDir = await resolveFileHandleFromProjectDir(state.outputPath);
        if (fromDir) {
          state.fileHandle = fromDir;
          await setLinkedHandle(getFileLinkKey(), fromDir);
        }
      } catch {
        // Keep fallback behavior.
      }
    }
  }
  const prev = readJson(STORAGE_KEYS.editorRecentFiles, []);
  const updated = [file, ...prev.filter((f) => f !== file)].slice(0, 10);
  writeJson(STORAGE_KEYS.editorRecentFiles, updated);
  markDirty(false);
  markSessionDirty(false);
  markSponsorDirty(false);
  capturePersistedSnapshot();
  undoClear();
  clearRecoverySnapshot();
  setCurrentFilenameLabel();
  setEditorDocumentTitle();
  const themeObj = state.dataset?.event?.theme;
  applyThemeClass(themeObj?.id ? normalizeThemeId(themeObj.id) : getCurrentThemeId());
  applyEventColors(themeObj?.primaryColor, themeObj?.secondaryColor, themeObj?.tertiaryColor);
  renderEventMetaForm();
  renderAppearanceForm();
  renderLogoForm();
  renderFlickrForm();
  renderSessionList();
  renderSessionForm();
  renderSponsorList();
  renderSponsorForm();
  renderPeopleTab();
  if (state.activeEditorTab === 'sitemap') {
    renderSourcesEditor();
    renderSponsorSourceField();
    renderSitemap();
  }
  if (state.activeEditorTab === 'timeline' && els.timelineCanvas) {
    renderTimeline(els.timelineCanvas, state.dataset, {
      markDirty: () => markDirty(true),
      trackQuickSessionChange,
      undoPush,
      utcIsoToLocalInput,
      localInputToUtcIso,
      getEventTimezone,
    });
  }
  setEditorButtonsEnabled(true);
  restorePendingEditorTab(); // return to the workspace the URL asked for
  if (els.datasetSelect.value !== file) {
    els.datasetSelect.value = file;
  }
  if (els.sessionSearchInput) {
    els.sessionSearchInput.value = '';
  }
}

function createDatasetScaffold(pathValue) {
  const year = new Date().getUTCFullYear();
  state.dataset = {
    event: {
      id: '',
      name: '',
      designation: 'DrupalSouth',
      year: String(year),
      location: '',
      region: '',
      venue: '',
      website: '',
      scheduleURLs: [],
      other_urls: [],
      logo: normalizeLogoObject(),
      flickr: normalizeFlickrObject(),
      sponsors: [],
      timezone: 'UTC',
      columns: 3,
      enabled: true,
    },
    items: [],
  };
  state.outputPath = normalizeOutputPath(pathValue, 'data/new-event.json');
  state.file = outputBasename(state.outputPath) || 'new-event.json';
  state.fileHandle = null;
  state.selectedIndex = -1;
  state.selectedSponsorIndex = -1;
  markDirty(true);
  resetSessionQuickEditState();
  resetSponsorQuickEditState();
  markSessionDirty(false);
  markSponsorDirty(false);
  capturePersistedSnapshot();
  setCurrentFilenameLabel();
  renderEventMetaForm();
  renderAppearanceForm();
  renderLogoForm();
  renderFlickrForm();
  renderSessionList();
  renderSessionForm();
  renderSponsorList();
  renderSponsorForm();
  if (state.activeEditorTab === 'sitemap') {
    renderSourcesEditor();
    renderSponsorSourceField();
    renderSitemap();
  }
  setEditorButtonsEnabled(true);
}

function getFlickrImageTargetPath(file) {
  const designation = slugify(state.dataset?.event?.designation || 'event');
  const year = slugify(state.dataset?.event?.year || '');
  const location = slugify(state.dataset?.event?.location || '');
  const fallback =
    slugify(outputBasename(state.outputPath || state.file || 'event').replace(/\.json$/i, '')) ||
    'event';
  const baseName = [year, location].filter(Boolean).join('-') || fallback;
  // Preserve the uploaded file's real extension (matching the logo/sponsor
  // uploaders). Hardcoding .jpg mislabels PNG/SVG/WebP uploads — harmless for
  // raster formats the browser sniffs, but an SVG saved as .jpg is served as
  // image/jpeg under nosniff and fails to render on reload.
  const originalName = String(file?.name || '')
    .trim()
    .toLowerCase();
  const extMatch = originalName.match(/\.(svg|png|jpe?g|webp|gif)$/i);
  const ext = extMatch ? extMatch[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg';
  return `img/flickr/${designation || 'event'}/${baseName}.${ext}`;
}

function getLogoImageTargetPath(file) {
  const designation = slugify(state.dataset?.event?.designation || 'event');
  const year = slugify(state.dataset?.event?.year || '');
  const location = slugify(state.dataset?.event?.location || '');
  const fallback =
    slugify(outputBasename(state.outputPath || state.file || 'event').replace(/\.json$/i, '')) ||
    'event';
  const baseName = [year, location].filter(Boolean).join('-') || fallback;
  const originalName = String(file?.name || '')
    .trim()
    .toLowerCase();
  const extMatch = originalName.match(/\.(svg|png|jpe?g|webp|gif)$/i);
  const ext = extMatch ? extMatch[1].toLowerCase().replace('jpeg', 'jpg') : 'png';
  return `img/logos/${designation || 'event'}/${baseName}.${ext}`;
}

function getSponsorImageTargetPath(file, sponsor = null) {
  const designation = slugify(state.dataset?.event?.designation || 'event');
  const year = slugify(state.dataset?.event?.year || '');
  const location = slugify(state.dataset?.event?.location || '');
  const sponsorSlug =
    slugify(sponsor?.id || sponsor?.title || file?.name || 'sponsor') || 'sponsor';
  const originalName = String(file?.name || '')
    .trim()
    .toLowerCase();
  const extMatch = originalName.match(/\.(svg|png|jpe?g|webp|gif)$/i);
  const ext = extMatch ? extMatch[1].toLowerCase().replace('jpeg', 'jpg') : 'png';
  const eventSlug = [year, location].filter(Boolean).join('-') || 'event';
  return `img/sponsors/${designation || 'event'}/${eventSlug}/${sponsorSlug}.${ext}`;
}

async function ensureDirectoryPath(baseDirHandle, segments) {
  let current = baseDirHandle;
  for (const segment of segments) {
    if (!segment) continue;
    current = await current.getDirectoryHandle(segment, { create: true });
  }
  return current;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function dataUrlToBlob(dataUrl) {
  const [header, base64] = dataUrl.split(',');
  const mime = (header.match(/:(.*?);/) || [])[1] || 'image/jpeg';
  const binary = atob(base64);
  const buffer = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buffer[i] = binary.charCodeAt(i);
  return new Blob([buffer], { type: mime });
}

async function backupCurrentPhotoForRevert() {
  const currentPath = String(state.dataset?.event?.flickr?.image || '')
    .trim()
    .replace(/^\.\//, '');
  if (!currentPath || !state.projectDirHandle) return;
  try {
    const handle = await resolveFileHandleFromProjectDir(currentPath);
    if (!handle) return;
    const file = await handle.getFile();
    const base64 = arrayBufferToBase64(await file.arrayBuffer());
    writeJson(PHOTOS_BACKUP_KEY, {
      path: currentPath,
      data: `data:${file.type || 'image/jpeg'};base64,${base64}`,
    });
  } catch {
    // No existing file to back up, or too large — skip silently
  }
}

async function revertPendingPhotoUpload() {
  const backup = readJson(PHOTOS_BACKUP_KEY, null);
  removeKey(PHOTOS_BACKUP_KEY);
  if (!backup || !state.projectDirHandle) return;
  try {
    const { path, data } = backup;
    const segments = path.split('/').filter(Boolean);
    const fileName = segments.pop();
    const dir = await ensureDirectoryPath(state.projectDirHandle, segments);
    const writable = await (await dir.getFileHandle(fileName, { create: true })).createWritable();
    await writable.write(dataUrlToBlob(data));
    await writable.close();
  } catch {
    // Revert failed — dataset path will still reload correctly from JSON
  }
}

function clearPhotosBackup() {
  removeKey(PHOTOS_BACKUP_KEY);
}

async function backupCurrentLogoForRevert() {
  const currentPath = String(state.dataset?.event?.logo?.image || '')
    .trim()
    .replace(/^\.\//, '');
  if (!currentPath || !state.projectDirHandle) return;
  try {
    const handle = await resolveFileHandleFromProjectDir(currentPath);
    if (!handle) return;
    const file = await handle.getFile();
    const base64 = arrayBufferToBase64(await file.arrayBuffer());
    writeJson(LOGO_BACKUP_KEY, {
      path: currentPath,
      data: `data:${file.type || 'image/png'};base64,${base64}`,
    });
  } catch {
    // No existing file to back up, or too large — skip silently
  }
}

async function revertPendingLogoUpload() {
  const backup = readJson(LOGO_BACKUP_KEY, null);
  removeKey(LOGO_BACKUP_KEY);
  if (!backup || !state.projectDirHandle) return;
  try {
    const { path, data } = backup;
    const segments = path.split('/').filter(Boolean);
    const fileName = segments.pop();
    const dir = await ensureDirectoryPath(state.projectDirHandle, segments);
    const writable = await (await dir.getFileHandle(fileName, { create: true })).createWritable();
    await writable.write(dataUrlToBlob(data));
    await writable.close();
  } catch {
    // Revert failed — dataset path will still reload correctly from JSON
  }
}

function clearLogoBackup() {
  removeKey(LOGO_BACKUP_KEY);
}

async function uploadFlickrImageFromPicker() {
  if (!isApiMode() && (!state.projectDirHandle || !state.folderConnectedInSession)) {
    window.alert('Connect folder or configure an API server to upload images.');
    return;
  }
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = 'image/*';
  picker.click();

  await new Promise((resolve) => {
    picker.addEventListener('change', resolve, { once: true });
  });

  const file = picker.files && picker.files[0] ? picker.files[0] : null;
  if (!file) return;

  await backupCurrentPhotoForRevert();
  const relativePath = getFlickrImageTargetPath(file);
  if (isApiMode()) {
    await uploadViaApi(file, relativePath);
  } else {
    const segments = relativePath.split('/').filter(Boolean);
    const fileName = segments.pop();
    const dir = await ensureDirectoryPath(state.projectDirHandle, segments);
    const handle = await dir.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(file);
    await writable.close();
  }

  if (!state.dataset.event.flickr || typeof state.dataset.event.flickr !== 'object') {
    state.dataset.event.flickr = normalizeFlickrObject();
  }
  state.dataset.event.flickr.image = `./${relativePath}`;
  if (!state.dataset.event.flickr.imageAlt) {
    state.dataset.event.flickr.imageAlt = `${state.dataset.event.designation || 'Event'} Flickr image`;
  }
  markDirty(true);
  state.imageCacheBust.set(`./${relativePath}`, Date.now());
  renderFlickrForm();
  const blobUrl = URL.createObjectURL(file);
  const frame = document.querySelector('.event-promo-image-frame');
  if (frame)
    frame.innerHTML = `<img id="flickrImagePreview" class="event-promo-image" src="${blobUrl}" alt="${escapeAttr(state.dataset?.event?.flickr?.imageAlt || '')}">`;
}

async function uploadLogoImageFromPicker() {
  if (!isApiMode() && (!state.projectDirHandle || !state.folderConnectedInSession)) {
    window.alert('Connect folder or configure an API server to upload images.');
    return;
  }
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = '.svg,image/*';
  picker.click();

  await new Promise((resolve) => {
    picker.addEventListener('change', resolve, { once: true });
  });

  const file = picker.files && picker.files[0] ? picker.files[0] : null;
  if (!file) return;

  await backupCurrentLogoForRevert();

  const relativePath = getLogoImageTargetPath(file);
  if (isApiMode()) {
    await uploadViaApi(file, relativePath);
  } else {
    const segments = relativePath.split('/').filter(Boolean);
    const fileName = segments.pop();
    const dir = await ensureDirectoryPath(state.projectDirHandle, segments);
    const handle = await dir.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(file);
    await writable.close();
  }

  state.dataset.event.logo = normalizeLogoObject(state.dataset.event.logo);
  state.dataset.event.logo.image = `./${relativePath}`;
  if (!state.dataset.event.logo.imageAlt) {
    state.dataset.event.logo.imageAlt = `${state.dataset.event.designation || 'Event'} logo`;
  }
  markDirty(true);
  state.imageCacheBust.set(`./${relativePath}`, Date.now());
  renderLogoForm();
  const logoPreview = document.getElementById('logoImagePreview');
  if (logoPreview) {
    logoPreview.src = URL.createObjectURL(file);
    logoPreview.classList.remove('hidden');
  }
}

async function uploadSponsorImageFromPicker(index) {
  if (!isApiMode() && (!state.projectDirHandle || !state.folderConnectedInSession)) {
    window.alert('Connect folder or configure an API server to upload images.');
    return;
  }
  const sponsor = state.dataset?.event?.sponsors?.[index];
  if (!sponsor) return;

  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = '.svg,image/*';
  picker.click();

  await new Promise((resolve) => {
    picker.addEventListener('change', resolve, { once: true });
  });

  const file = picker.files && picker.files[0] ? picker.files[0] : null;
  if (!file) return;

  const relativePath = getSponsorImageTargetPath(file, sponsor);
  if (isApiMode()) {
    await uploadViaApi(file, relativePath);
  } else {
    const segments = relativePath.split('/').filter(Boolean);
    const fileName = segments.pop();
    const dir = await ensureDirectoryPath(state.projectDirHandle, segments);
    const handle = await dir.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(file);
    await writable.close();
  }

  sponsor.image = `./${relativePath}`;
  if (!sponsor.imageAlt) {
    sponsor.imageAlt = `${sponsor.title || 'Sponsor'} logo`;
  }
  markDirty(true);
  markSponsorDirty(true);
  state.imageCacheBust.set(`./${relativePath}`, Date.now());
  renderSponsorList();
  renderSponsorForm();
  renderSessionForm();
  const blobUrl = URL.createObjectURL(file);
  const surface = document.getElementById('sponsorPreviewSurface');
  if (surface)
    surface.innerHTML = `<img id="sponsorImagePreview" src="${blobUrl}" alt="${escapeAttr(sponsor?.imageAlt || '')}" class="sponsor-logo-image">`;
  const inline = document.getElementById('sponsorInlinePreview');
  if (inline)
    inline.innerHTML = `<img src="${blobUrl}" alt="${escapeAttr(sponsor?.imageAlt || '')}" class="sponsor-inline-image">`;
}

function getRelatedImageTargetPath(file, name) {
  const designation = slugify(state.dataset?.event?.designation || 'event');
  const year = slugify(state.dataset?.event?.year || '');
  const location = slugify(state.dataset?.event?.location || '');
  const slug = slugify(name || file?.name || 'related') || 'related';
  const originalName = String(file?.name || '')
    .trim()
    .toLowerCase();
  const extMatch = originalName.match(/\.(svg|png|jpe?g|webp|gif)$/i);
  const ext = extMatch ? extMatch[1].toLowerCase().replace('jpeg', 'jpg') : 'png';
  const eventSlug = [year, location].filter(Boolean).join('-') || 'event';
  return `img/related/${designation || 'event'}/${eventSlug}/${slug}.${ext}`;
}

// Injected into the related-events editor: uploads a logo (API or connected folder,
// same branch as sponsor logos) and returns the './'-relative path, or null.
async function uploadRelatedImage(file, name) {
  if (!isApiMode() && (!state.projectDirHandle || !state.folderConnectedInSession)) {
    window.alert('Connect a folder or configure an API server to upload images.');
    return null;
  }
  const relativePath = getRelatedImageTargetPath(file, name);
  if (isApiMode()) {
    await uploadViaApi(file, relativePath);
  } else {
    const segments = relativePath.split('/').filter(Boolean);
    const fileName = segments.pop();
    const dir = await ensureDirectoryPath(state.projectDirHandle, segments);
    const handle = await dir.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(file);
    await writable.close();
  }
  state.imageCacheBust.set(`./${relativePath}`, Date.now());
  return `./${relativePath}`;
}

function fieldDescriptionId(scope, key) {
  return `${scope}-${String(key).replace(/[^a-z0-9_-]+/gi, '-')}-description`;
}

function renderFieldIntro(scope, key, config) {
  const description = normalizeString(config.description);
  return `
    <span class="editor-field-label">${escapeHtml(config.label || key)}</span>
    ${
      description
        ? `<span id="${escapeAttr(fieldDescriptionId(scope, key))}" class="editor-field-description">${escapeHtml(description)}</span>`
        : ''
    }
  `;
}

function fieldDescriptionAttr(scope, key, config) {
  return config.description
    ? ` aria-describedby="${escapeAttr(fieldDescriptionId(scope, key))}"`
    : '';
}

function inferFlickrMode(eventMeta = null, items = []) {
  const now = new Date();
  const endDate = normalizeString(eventMeta?.endDate);
  if (endDate) {
    const parsed = new Date(endDate);
    if (!Number.isNaN(parsed.getTime())) return parsed <= now ? 'archive' : 'cta';
  }

  const lastSession = (Array.isArray(items) ? items : [])
    .map((item) => new Date(item?.endTime || item?.startTime || ''))
    .filter((date) => !Number.isNaN(date.getTime()))
    .sort((a, b) => b.getTime() - a.getTime())[0];
  if (lastSession) return lastSession <= now ? 'archive' : 'cta';

  return 'cta';
}

function getFlickrEventLabel(eventMeta = null) {
  return (
    [eventMeta?.designation, eventMeta?.year, eventMeta?.location]
      .filter(Boolean)
      .join(' ')
      .trim() || 'Event'
  );
}

function getAutomatedFlickrCopy(eventMeta = null, items = [], provider = '') {
  const mode = inferFlickrMode(eventMeta, items);
  const eventLabel = getFlickrEventLabel(eventMeta);
  const p = normalizeString(provider) || 'Flickr';
  return {
    mode,
    heading: mode === 'archive' ? `${eventLabel} Photo Archive` : `Share Your ${eventLabel} Photos`,
    description:
      mode === 'archive'
        ? `Browse the official ${p} page for photos from ${eventLabel}.`
        : `Upload and share your photos on ${p} before, during, and after the event.`,
    buttonText: mode === 'archive' ? 'View Photo Archive' : `Open on ${p}`,
  };
}

function renderFlickrBlock(flickr) {
  const automated = getAutomatedFlickrCopy(
    state.dataset?.event,
    state.dataset?.items,
    flickr.provider,
  );
  const imageSrc = (flickr.image || '').trim();
  const providerLabel = (flickr.provider || 'Photos').toUpperCase();
  return `
    <div class="col-span-full flex gap-5 items-start">
      <div class="flex-1 min-w-0 grid grid-cols-1 md:grid-cols-2 gap-3">
        <label class="editor-form-field md:col-span-2">
          ${renderFieldIntro('flickr', 'provider', FLICKR_FIELD_CONFIG.provider)}
          <input data-flickr-field="provider" type="text" value="${escapeAttr(flickr.provider)}" class="edt-field" placeholder="Flickr"${fieldDescriptionAttr('flickr', 'provider', FLICKR_FIELD_CONFIG.provider)}>
        </label>
        <label class="editor-form-field md:col-span-2">
          ${renderFieldIntro('flickr', 'groupUrl', FLICKR_FIELD_CONFIG.groupUrl)}
          <input data-flickr-field="groupUrl" type="text" value="${escapeAttr(flickr.groupUrl)}" class="edt-field" placeholder="https://flic.kr/g/..."${fieldDescriptionAttr('flickr', 'groupUrl', FLICKR_FIELD_CONFIG.groupUrl)}>
        </label>
        <label class="editor-form-field md:col-span-2">
          ${renderFieldIntro('flickr', 'image', FLICKR_FIELD_CONFIG.image)}
          <input data-flickr-field="image" type="text" value="${escapeAttr(flickr.image)}" class="edt-field" placeholder="./img/flickr/.../image.jpg"${fieldDescriptionAttr('flickr', 'image', FLICKR_FIELD_CONFIG.image)}>
        </label>
        <label class="editor-form-field md:col-span-2">
          ${renderFieldIntro('flickr', 'imageAlt', FLICKR_FIELD_CONFIG.imageAlt)}
          <input data-flickr-field="imageAlt" type="text" value="${escapeAttr(flickr.imageAlt)}" class="edt-field"${fieldDescriptionAttr('flickr', 'imageAlt', FLICKR_FIELD_CONFIG.imageAlt)}>
        </label>
        <div class="editor-form-field md:col-span-2">
          <span class="editor-field-label">Promo image upload</span>
          <span class="editor-field-description">Uploads to <code>img/flickr/${escapeHtml(
            slugify(state.dataset?.event?.designation || 'event') || 'event',
          )}</code> and stores a relative path.</span>
          <div class="flex items-center gap-2 flex-wrap">
            <label class="edt-btn select-none">
              <input data-flickr-field="enabled" type="checkbox" class="h-4 w-4" ${flickr.enabled ? 'checked' : ''}${fieldDescriptionAttr('flickr', 'enabled', FLICKR_FIELD_CONFIG.enabled)}>
              <span class="edt-body">Enabled</span>
            </label>
            <button id="flickrImageUpload" type="button" class="h-9 inline-flex items-center justify-center px-3 border edt-rule rounded-md text-sm font-medium edt-ink-1 edt-surface transition-colors whitespace-nowrap">
              Upload image
            </button>
            <button id="flickrImageClear" type="button" class="h-9 inline-flex items-center justify-center px-3 border edt-rule rounded-md text-sm font-medium edt-ink-1 edt-surface hover:edt-rule-bad hover:edt-bad transition-colors whitespace-nowrap"${!imageSrc ? ' disabled' : ''}>
              Delete image
            </button>
          </div>
        </div>
      </div>

      <aside class="flickr-editor-sidebar">
        <div class="flickr-preview-stage">
          <div id="flickrPreviewCard" class="event-promo-card rounded-lg border edt-rule edt-surface p-3${flickr.enabled ? '' : ' opacity-50'}">
            <div class="event-promo-image-frame">
              ${
                imageSrc
                  ? `<img id="flickrImagePreview" class="event-promo-image" src="${escapeAttr(bustSrc(imageSrc))}" alt="${escapeAttr(flickr.imageAlt || '')}">`
                  : `<div class="flickr-preview-placeholder"></div>`
              }
            </div>
            <div class="event-promo-body min-w-0">
              <div class="flickr-preview-provider text-xs font-semibold tracking-wide edt-ink-2 uppercase mb-0.5">${escapeHtml(providerLabel)}</div>
              <div class="flickr-preview-heading text-sm font-semibold edt-ink-0 leading-snug">${escapeHtml(automated.heading)}</div>
              <p class="flickr-preview-desc text-xs edt-ink-1 mt-1 leading-snug">${escapeHtml(automated.description)}</p>
              <span class="event-promo-action flickr-preview-btn mt-2">${escapeHtml(automated.buttonText)}</span>
            </div>
          </div>
        </div>
        <p class="flickr-preview-caption">Page preview</p>
      </aside>
    </div>
  `;
}

const LOGO_FA_DEFAULT = 'fa-solid fa-calendar-days';

// Trademark caution: any "drupalcon" event forcibly hides its logo image on the
// public schedule (see updateHeaderBranding in events.js). The editor mirrors that
// by locking the "Disable image" checkbox on + disabled.
function eventSlugForcesLogoOff() {
  const e = state.dataset?.event || {};
  const slug = slugify([e.designation, e.year, e.location].filter(Boolean).join(' '));
  return slug.includes('drupalcon');
}

function renderLogoBlock(logo) {
  const imageSrc = (logo.image || '').trim();
  const plateClass = logo.usePlate ? ' header-logo-use-plate' : '';
  const faIcon = (logo.faIcon || '').trim() || LOGO_FA_DEFAULT;
  const forcedOff = eventSlugForcesLogoOff();
  const logoDisabledChecked = logo.logoDisabled || forcedOff;
  const showFaIcon = logoDisabledChecked;
  return `
    <div class="col-span-full flex gap-5 items-start">
      <div class="flex-1 min-w-0 grid grid-cols-1 md:grid-cols-2 gap-3">
        <label class="editor-form-field md:col-span-2">
          ${renderFieldIntro('logo', 'image', LOGO_FIELD_CONFIG.image)}
          <input data-logo-field="image" type="text" value="${escapeAttr(logo.image)}" class="edt-field" placeholder="./img/logos/.../logo.png"${fieldDescriptionAttr('logo', 'image', LOGO_FIELD_CONFIG.image)}>
        </label>
        <label class="editor-form-field md:col-span-2">
          ${renderFieldIntro('logo', 'imageAlt', LOGO_FIELD_CONFIG.imageAlt)}
          <input data-logo-field="imageAlt" type="text" value="${escapeAttr(logo.imageAlt)}" class="edt-field"${fieldDescriptionAttr('logo', 'imageAlt', LOGO_FIELD_CONFIG.imageAlt)}>
        </label>
        <div class="editor-form-field md:col-span-2">
          <span class="editor-field-label">Logo upload</span>
          <span class="editor-field-description">Uploads to <code>img/logos/${escapeHtml(
            slugify(state.dataset?.event?.designation || 'event') || 'event',
          )}</code> and stores a relative path.</span>
          <div class="flex items-center gap-2 flex-wrap">
            <label class="edt-btn select-none">
              <input data-logo-field="usePlate" type="checkbox" class="h-4 w-4" ${logo.usePlate ? 'checked' : ''}${fieldDescriptionAttr('logo', 'usePlate', LOGO_FIELD_CONFIG.usePlate)}>
              <span class="edt-body">Background plate</span>
            </label>
            <label class="h-9 inline-flex items-center gap-2.5 rounded-md border edt-rule px-3 edt-surface select-none ${forcedOff ? 'opacity-70 cursor-not-allowed' : 'cursor-pointer'}"${forcedOff ? ' title="Forced off for DrupalCon events"' : ''}>
              <input data-logo-field="logoDisabled" type="checkbox" class="h-4 w-4" ${logoDisabledChecked ? 'checked' : ''}${forcedOff ? ' disabled' : ''}${fieldDescriptionAttr('logo', 'logoDisabled', LOGO_FIELD_CONFIG.logoDisabled)}>
              <span class="edt-body">Disable image${forcedOff ? ' <span class="edt-warn font-medium">(forced)</span>' : ''}</span>
            </label>
            <button id="logoImageUpload" type="button" class="h-9 inline-flex items-center justify-center px-3 border edt-rule rounded-md text-sm font-medium edt-ink-1 edt-surface transition-colors whitespace-nowrap">
              Upload logo
            </button>
            <button id="logoImageClear" type="button" class="h-9 inline-flex items-center justify-center px-3 border edt-rule rounded-md text-sm font-medium edt-ink-1 edt-surface hover:edt-rule-bad hover:edt-bad transition-colors whitespace-nowrap"${!imageSrc ? ' disabled' : ''}>
              Delete logo
            </button>
          </div>
          ${forcedOff ? '<p class="text-xs edt-warn mt-2">Logo image is forced off for DrupalCon events — the fallback icon is shown on the public schedule regardless of this setting.</p>' : ''}
        </div>
        <label class="editor-form-field md:col-span-2">
          ${renderFieldIntro('logo', 'faIcon', LOGO_FIELD_CONFIG.faIcon)}
          <input data-logo-field="faIcon" type="text" value="${escapeAttr(logo.faIcon)}" class="edt-field" placeholder="${escapeAttr(LOGO_FA_DEFAULT)}"${fieldDescriptionAttr('logo', 'faIcon', LOGO_FIELD_CONFIG.faIcon)}>
        </label>
      </div>

      <aside class="logo-editor-sidebar">
        <div class="logo-preview-stage">
          <div id="logoPreviewContainer" class="header-logo${escapeAttr(plateClass)}">
            <span id="logoIconPreview" class="edt-logo-none${!showFaIcon && imageSrc ? ' hidden' : ''}">${escapeHtml(showFaIcon ? faIcon : 'No image')}</span>
            <img id="logoImagePreview" class="header-logo-image${imageSrc && !showFaIcon ? '' : ' hidden'}"
              src="${escapeAttr(bustSrc(imageSrc))}" alt="${escapeAttr(logo.imageAlt || '')}">
          </div>
        </div>
        <p class="logo-preview-caption">Header preview</p>
      </aside>
    </div>
  `;
}

function bindFlickrFormEvents(container) {
  if (!container) return;
  container.querySelectorAll('[data-flickr-field]').forEach((input) => {
    const key = input.dataset.flickrField;
    const updateFlickrField = () => {
      const eventFlickr = normalizeFlickrObject(state.dataset.event.flickr);
      if (key === 'enabled') {
        eventFlickr.enabled = Boolean(input.checked);
      } else {
        eventFlickr[key] = input.value;
      }
      state.dataset.event.flickr = normalizeFlickrObject(eventFlickr);
      markDirty(true);

      const card = container.querySelector('#flickrPreviewCard');

      if (key === 'enabled') {
        if (card) card.classList.toggle('opacity-50', !input.checked);
      }

      if (key === 'provider' || key === 'groupUrl') {
        const flickrNow = normalizeFlickrObject(state.dataset.event.flickr);
        const auto = getAutomatedFlickrCopy(
          state.dataset?.event,
          state.dataset?.items,
          flickrNow.provider,
        );
        const providerEl = container.querySelector('.flickr-preview-provider');
        const headingEl = container.querySelector('.flickr-preview-heading');
        const descEl = container.querySelector('.flickr-preview-desc');
        const btnEl = container.querySelector('.flickr-preview-btn');
        if (providerEl) providerEl.textContent = (flickrNow.provider || 'Photos').toUpperCase();
        if (headingEl) headingEl.textContent = auto.heading;
        if (descEl) descEl.textContent = auto.description;
        if (btnEl) btnEl.textContent = auto.buttonText;
      }

      if (key === 'image') {
        const newSrc = input.value.trim();
        const frame = container.querySelector('.event-promo-image-frame');
        const clearBtn = container.querySelector('#flickrImageClear');
        if (frame) {
          frame.innerHTML = newSrc
            ? `<img id="flickrImagePreview" class="event-promo-image" src="${escapeAttr(newSrc)}" alt="${escapeAttr(eventFlickr.imageAlt || '')}">`
            : `<div class="flickr-preview-placeholder"></div>`;
        }
        if (clearBtn) clearBtn.disabled = !newSrc;
      }

      if (key === 'imageAlt') {
        const img = container.querySelector('#flickrImagePreview');
        if (img) img.alt = input.value;
      }
    };
    input.addEventListener('input', updateFlickrField);
    input.addEventListener('change', updateFlickrField);
  });

  const uploadButton = container.querySelector('#flickrImageUpload');
  if (uploadButton) {
    uploadButton.addEventListener('click', async () => {
      try {
        await uploadFlickrImageFromPicker();
      } catch (error) {
        window.alert(`Flickr image upload failed: ${error.message}`);
      }
    });
  }

  const clearButton = container.querySelector('#flickrImageClear');
  if (clearButton) {
    clearButton.addEventListener('click', () => {
      const eventFlickr = normalizeFlickrObject(state.dataset.event.flickr);
      eventFlickr.image = '';
      eventFlickr.imageAlt = '';
      state.dataset.event.flickr = normalizeFlickrObject(eventFlickr);
      markDirty(true);
      renderFlickrForm();
    });
  }
}

function bindLogoFormEvents(container) {
  if (!container) return;
  container.querySelectorAll('[data-logo-field]').forEach((input) => {
    const key = input.dataset.logoField;
    const updateLogoField = () => {
      const eventLogo = normalizeLogoObject(state.dataset.event.logo);
      if (key === 'usePlate' || key === 'logoDisabled') {
        eventLogo[key] = Boolean(input.checked);
      } else {
        eventLogo[key] = input.value;
      }
      state.dataset.event.logo = normalizeLogoObject(eventLogo);
      markDirty(true);

      const img = container.querySelector('#logoImagePreview');
      const iconEl = container.querySelector('#logoIconPreview');
      const clearBtn = container.querySelector('#logoImageClear');
      const currentLogo = state.dataset.event.logo;
      const hasSrc = Boolean((currentLogo.image || '').trim());
      const disabled = currentLogo.logoDisabled;
      const resolvedIcon = (currentLogo.faIcon || '').trim() || LOGO_FA_DEFAULT;

      if (key === 'image') {
        const newSrc = input.value.trim();
        if (img) {
          img.src = newSrc;
          img.classList.toggle('hidden', !newSrc || disabled);
        }
        if (clearBtn) clearBtn.disabled = !newSrc;
      }
      if (key === 'imageAlt') {
        if (img) img.alt = input.value;
      }
      if (key === 'usePlate') {
        const preview = container.querySelector('#logoPreviewContainer');
        if (preview) preview.classList.toggle('header-logo-use-plate', input.checked);
      }
      if (key === 'logoDisabled' || key === 'faIcon') {
        if (iconEl) {
          iconEl.className = disabled
            ? resolvedIcon
            : hasSrc
              ? 'edt-logo-none hidden'
              : 'edt-logo-none';
        }
        if (img) img.classList.toggle('hidden', disabled || !hasSrc);
      }
    };
    input.addEventListener('input', updateLogoField);
    input.addEventListener('change', updateLogoField);
  });

  const logoUploadButton = container.querySelector('#logoImageUpload');
  if (logoUploadButton) {
    logoUploadButton.addEventListener('click', async () => {
      try {
        await uploadLogoImageFromPicker();
      } catch (error) {
        window.alert(`Logo upload failed: ${error.message}`);
      }
    });
  }

  const logoClearButton = container.querySelector('#logoImageClear');
  if (logoClearButton) {
    logoClearButton.addEventListener('click', () => {
      const eventLogo = normalizeLogoObject(state.dataset.event.logo);
      eventLogo.image = '';
      state.dataset.event.logo = normalizeLogoObject(eventLogo);
      markDirty(true);
      renderLogoForm();
    });
  }
}

function renderLogoForm() {
  if (!els.logoForm) return;
  if (!state.dataset) {
    els.logoForm.innerHTML = '<p class="edt-muted">Load a dataset to edit the event logo.</p>';
    return;
  }
  const logo = normalizeLogoObject(state.dataset?.event?.logo);
  els.logoForm.innerHTML = renderLogoBlock(logo);
  bindLogoFormEvents(els.logoForm);
}

function renderFlickrForm() {
  if (!els.flickrForm) return;
  if (!state.dataset) {
    els.flickrForm.innerHTML = '<p class="edt-muted">Load a dataset to edit the photos block.</p>';
    return;
  }
  const flickr = normalizeFlickrObject(state.dataset?.event?.flickr);
  els.flickrForm.innerHTML = renderFlickrBlock(flickr);
  bindFlickrFormEvents(els.flickrForm);
}

function renderUrlMultifieldHtml(scope, field, config, urls) {
  const spanClass = 'md:col-span-2 xl:col-span-3';
  const rows = urls
    .map(
      (url, i) => `
    <div class="url-multifield-row">
      <input type="text"
        class="url-multifield-input"
        data-url-field="${escapeAttr(field)}"
        data-url-index="${i}"
        value="${escapeAttr(url)}"
        placeholder="https://"
        ${fieldDescriptionAttr(scope, field, config)}>
      <button type="button"
        class="url-multifield-remove"
        data-url-remove="${escapeAttr(field)}"
        data-url-index="${i}"
        aria-label="Remove URL">
        </button>
    </div>
  `,
    )
    .join('');

  return `
    <div class="editor-form-field ${spanClass}">
      ${renderFieldIntro(scope, field, config)}
      <div class="url-multifield-list" data-url-list="${escapeAttr(field)}">
        ${rows || '<p class="url-multifield-empty">No URLs configured.</p>'}
      </div>
      <button type="button" class="url-multifield-add" data-url-add="${escapeAttr(field)}">
        Add URL
      </button>
    </div>
  `;
}

function setEventColor(field, value) {
  if (!state.dataset?.event) return;
  if (!state.dataset.event.theme || typeof state.dataset.event.theme !== 'object')
    state.dataset.event.theme = {};
  state.dataset.event.theme[field] = value;
  markDirty(true);
  const resetIds = {
    primaryColor: 'clearPrimaryColor',
    secondaryColor: 'clearSecondaryColor',
    tertiaryColor: 'clearTertiaryColor',
  };
  document.getElementById(resetIds[field])?.classList.remove('hidden');
  applyEventColors(
    state.dataset.event.theme.primaryColor,
    state.dataset.event.theme.secondaryColor,
    state.dataset.event.theme.tertiaryColor,
  );
}

function clearEventColor(field, picker, hex, clearBtn, defaultColor) {
  if (!state.dataset?.event) return;
  if (state.dataset.event.theme) delete state.dataset.event.theme[field];
  markDirty(true);
  picker.value = defaultColor;
  hex.value = '';
  hex.placeholder = defaultColor;
  clearBtn.classList.add('hidden');
  applyEventColors(
    state.dataset.event.theme?.primaryColor,
    state.dataset.event.theme?.secondaryColor,
    state.dataset.event.theme?.tertiaryColor,
  );
}

let _editingThemeId = null;
let _editingThemeSnapshot = null;
let _preEditThemeId = null;

const _THEME_EDIT_FIELDS = [
  { key: 'bg', label: 'Background', def: '#010810' },
  { key: 'primary', label: 'Primary', def: '#00cfff' },
  { key: 'secondary', label: 'Secondary', def: '#4a90d9' },
  { key: 'tertiary', label: 'Tertiary', def: '#7c3aed' },
  { key: 'text', label: 'Text', def: '#eaf2fc' },
  { key: 'border', label: 'Border', def: '#162c4c' },
];

function _blendHex(hex, toward, amount) {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex) || !/^#[0-9a-fA-F]{6}$/.test(toward)) return hex;
  const lerp = (a, b) =>
    Math.round(a + (b - a) * amount)
      .toString(16)
      .padStart(2, '0');
  const r = lerp(parseInt(hex.slice(1, 3), 16), parseInt(toward.slice(1, 3), 16));
  const g = lerp(parseInt(hex.slice(3, 5), 16), parseInt(toward.slice(3, 5), 16));
  const b = lerp(parseInt(hex.slice(5, 7), 16), parseInt(toward.slice(5, 7), 16));
  return `#${r}${g}${b}`;
}

function _themeCardHtml(t, selectedId, nameAttr, liveThemeId, savedThemeId) {
  const c = t.colors || {};
  const selected = t.id === selectedId;
  const isSaved = !!savedThemeId && t.id === savedThemeId;
  const isLive = !!liveThemeId && t.id === liveThemeId;
  const isDirty = selected && !isSaved && state.dirty;
  let badgeClass = '';
  let badgeText = '';
  if (isLive) {
    badgeClass = 'theme-card-live-badge';
    badgeText = 'Live';
  } else if (isSaved) {
    badgeClass = 'theme-card-saved-badge';
    badgeText = 'Saved';
  } else if (isDirty) {
    badgeClass = 'theme-card-dirty-badge';
    badgeText = 'Unsaved';
  }
  return `<label class="appearance-theme-card${selected ? ' is-selected' : ''}${isLive ? ' is-live' : ''}${isSaved ? ' is-saved' : ''}${isDirty ? ' is-dirty' : ''}" title="${escapeAttr(t.label)}">
    <input type="radio" name="${nameAttr}" value="${escapeAttr(t.id)}" ${selected ? 'checked' : ''} class="sr-only">
    <div class="theme-card-swatch-row">
      <span class="theme-swatch-chip" style="background:${c.bg || '#000'}"></span>
      <span class="theme-swatch-chip" style="background:${c.primary || '#00cfff'}"></span>
      <span class="theme-swatch-chip" style="background:${c.text || '#fff'}"></span>
    </div>
    <span class="theme-card-label">${escapeHtml(t.label)}</span>
    ${badgeText ? `<span class="${badgeClass}">${badgeText}</span>` : ''}
  </label>`;
}

async function saveThemesJson() {
  const json = JSON.stringify(getThemes(), null, 2) + '\n';
  if (isApiMode()) {
    const res = await fetch(`${state.apiEndpoint}/api/data/themes.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: json,
    });
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    return true;
  }
  window.alert('Theme editing requires the API server.\nStart it with: node server.js');
  return false;
}

function renderAppearanceForm() {
  if (!els.appearanceForm) return;
  const event = state.dataset?.event || null;
  const themes = getThemes();

  // --- Per-event section ---
  const eventThemeObj = event?.theme || {};
  const eventThemeId = eventThemeObj.id || '';
  const effectiveThemeId = eventThemeId || getCurrentThemeId();
  const themeColors = getThemeById(effectiveThemeId)?.colors || {};
  const primaryColor = eventThemeObj.primaryColor || '';
  const secondaryColor = eventThemeObj.secondaryColor || '';
  const tertiaryColor = eventThemeObj.tertiaryColor || '';
  const disabled = !event;
  const colorDisabledAttr = disabled ? ' disabled' : '';
  const savedThemeId = state.persistedSnapshot?.dataset?.event?.theme?.id || '';

  const eventThemeCards = themes
    .map((t) =>
      _themeCardHtml(t, eventThemeId || '__none__', 'eventTheme', _editingThemeId, savedThemeId),
    )
    .join('');
  const pickerPrimary = primaryColor || themeColors.primary || '#00cfff';
  const pickerSecondary = secondaryColor || themeColors.secondary || '#4a90d9';
  const pickerTertiary = tertiaryColor || themeColors.tertiary || '#7c3aed';

  els.appearanceForm.innerHTML = `
    <section class="appearance-panel-section">
      <div class="appearance-panel-header">
        <div>
          <h3 class="appearance-panel-title">Event Appearance</h3>
          <p class="appearance-panel-desc">Theme and accent colours for this event.${disabled ? ' <span class="appearance-hint">Open an event to customise.</span>' : ''}</p>
        </div>
      </div>
      <div class="${disabled ? 'appearance-section--disabled' : ''}">
        <div class="appearance-section-label">Theme</div>
        <div class="appearance-theme-selector" id="eventThemeSelector">
          <label class="appearance-theme-card${!eventThemeId ? ' is-selected' : ''}${!savedThemeId ? ' is-saved' : ''}${!eventThemeId && state.dirty && savedThemeId ? ' is-dirty' : ''}" title="Use global default">
            <input type="radio" name="eventTheme" value="" ${!eventThemeId ? 'checked' : ''} class="sr-only"${colorDisabledAttr}>
            <div class="theme-card-swatch-row">
              <span class="theme-swatch-chip" style="background:#f5f5f5"></span>
              <span class="theme-swatch-chip" style="background:#006aa9"></span>
              <span class="theme-swatch-chip" style="background:#1f2937"></span>
            </div>
            <span class="theme-card-label">Default</span>
            ${!savedThemeId ? '<span class="theme-card-saved-badge">Saved</span>' : ''}${!eventThemeId && state.dirty && savedThemeId ? '<span class="theme-card-dirty-badge">Unsaved</span>' : ''}
          </label>
          ${eventThemeCards}
        </div>
        <div class="appearance-section mt-4">
          <div class="appearance-section-label">Accent colours</div>
          <div class="appearance-color-fields">
            <div class="appearance-color-row">
              <span class="appearance-color-label">Primary</span>
              <div class="appearance-color-pair">
                <input type="color" id="primaryColorPicker" value="${escapeAttr(pickerPrimary)}"${colorDisabledAttr}>
                <input type="text" id="primaryColorHex" value="${escapeAttr(primaryColor)}" placeholder="${escapeAttr(pickerPrimary)}" maxlength="7"${colorDisabledAttr}>
                <button type="button" id="clearPrimaryColor" class="appearance-color-reset${primaryColor ? '' : ' hidden'}"${colorDisabledAttr}>Reset</button>
              </div>
            </div>
            <div class="appearance-color-row">
              <span class="appearance-color-label">Secondary</span>
              <div class="appearance-color-pair">
                <input type="color" id="secondaryColorPicker" value="${escapeAttr(pickerSecondary)}"${colorDisabledAttr}>
                <input type="text" id="secondaryColorHex" value="${escapeAttr(secondaryColor)}" placeholder="${escapeAttr(pickerSecondary)}" maxlength="7"${colorDisabledAttr}>
                <button type="button" id="clearSecondaryColor" class="appearance-color-reset${secondaryColor ? '' : ' hidden'}"${colorDisabledAttr}>Reset</button>
              </div>
            </div>
            <div class="appearance-color-row">
              <span class="appearance-color-label">Tertiary</span>
              <div class="appearance-color-pair">
                <input type="color" id="tertiaryColorPicker" value="${escapeAttr(pickerTertiary)}"${colorDisabledAttr}>
                <input type="text" id="tertiaryColorHex" value="${escapeAttr(tertiaryColor)}" placeholder="${escapeAttr(pickerTertiary)}" maxlength="7"${colorDisabledAttr}>
                <button type="button" id="clearTertiaryColor" class="appearance-color-reset${tertiaryColor ? '' : ' hidden'}"${colorDisabledAttr}>Reset</button>
              </div>
            </div>
          </div>
        </div>
        <div class="appearance-preview mt-4">
          <div class="appearance-preview-label">Live preview</div>
          <div class="appearance-preview-swatches">
            <div class="appearance-preview-swatch"><div class="appearance-preview-chip" style="background:var(--bg-1)"></div><span>Background</span></div>
            <div class="appearance-preview-swatch"><div class="appearance-preview-chip" style="background:var(--surface-1)"></div><span>Surface</span></div>
            <div class="appearance-preview-swatch"><div class="appearance-preview-chip" style="background:var(--accent)"></div><span>Primary</span></div>
            <div class="appearance-preview-swatch"><div class="appearance-preview-chip" style="background:var(--color-secondary)"></div><span>Secondary</span></div>
            <div class="appearance-preview-swatch"><div class="appearance-preview-chip" style="background:var(--color-tertiary)"></div><span>Tertiary</span></div>
            <div class="appearance-preview-swatch"><div class="appearance-preview-chip" style="background:var(--text-0)"></div><span>Text</span></div>
            <div class="appearance-preview-swatch"><div class="appearance-preview-chip" style="background:var(--line-0)"></div><span>Border</span></div>
          </div>
        </div>
      </div>
    </section>

    </section>`;

  applyThemeClass(effectiveThemeId);
  applyEventColors(primaryColor, secondaryColor, tertiaryColor);

  // --- Per-event theme radios ---
  els.appearanceForm.querySelectorAll('input[name="eventTheme"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      if (!radio.checked || !state.dataset?.event) return;
      const val = radio.value;
      if (!state.dataset.event.theme || typeof state.dataset.event.theme !== 'object')
        state.dataset.event.theme = {};
      if (val) {
        state.dataset.event.theme.id = val;
      } else {
        delete state.dataset.event.theme.id;
      }
      markDirty(true);
      const newEffective = val || getCurrentThemeId();
      applyThemeClass(newEffective);
      applyEventColors(
        state.dataset.event.theme.primaryColor,
        state.dataset.event.theme.secondaryColor,
        state.dataset.event.theme.tertiaryColor,
      );
      renderAppearanceForm();
    });
  });

  // --- Accent color pickers ---
  if (!disabled) {
    const primaryPicker = document.getElementById('primaryColorPicker');
    const primaryHex = document.getElementById('primaryColorHex');
    const clearPrimary = document.getElementById('clearPrimaryColor');
    const secondaryPicker = document.getElementById('secondaryColorPicker');
    const secondaryHex = document.getElementById('secondaryColorHex');
    const clearSecondary = document.getElementById('clearSecondaryColor');

    primaryPicker?.addEventListener('input', () => {
      primaryHex.value = primaryPicker.value.toUpperCase();
      setEventColor('primaryColor', primaryPicker.value);
    });
    primaryHex?.addEventListener('input', () => {
      const v = primaryHex.value.trim();
      if (/^#[0-9a-fA-F]{6}$/.test(v)) {
        primaryPicker.value = v;
        setEventColor('primaryColor', v);
      }
    });
    clearPrimary?.addEventListener('click', () => {
      const c = getThemeById(effectiveThemeId)?.colors || {};
      clearEventColor(
        'primaryColor',
        primaryPicker,
        primaryHex,
        clearPrimary,
        c.primary || '#00cfff',
      );
    });
    secondaryPicker?.addEventListener('input', () => {
      secondaryHex.value = secondaryPicker.value.toUpperCase();
      setEventColor('secondaryColor', secondaryPicker.value);
    });
    secondaryHex?.addEventListener('input', () => {
      const v = secondaryHex.value.trim();
      if (/^#[0-9a-fA-F]{6}$/.test(v)) {
        secondaryPicker.value = v;
        setEventColor('secondaryColor', v);
      }
    });
    clearSecondary?.addEventListener('click', () => {
      const c = getThemeById(effectiveThemeId)?.colors || {};
      clearEventColor(
        'secondaryColor',
        secondaryPicker,
        secondaryHex,
        clearSecondary,
        c.secondary || '#4a90d9',
      );
    });
    const tertiaryPicker = document.getElementById('tertiaryColorPicker');
    const tertiaryHex = document.getElementById('tertiaryColorHex');
    const clearTertiary = document.getElementById('clearTertiaryColor');
    tertiaryPicker?.addEventListener('input', () => {
      tertiaryHex.value = tertiaryPicker.value.toUpperCase();
      setEventColor('tertiaryColor', tertiaryPicker.value);
    });
    tertiaryHex?.addEventListener('input', () => {
      const v = tertiaryHex.value.trim();
      if (/^#[0-9a-fA-F]{6}$/.test(v)) {
        tertiaryPicker.value = v;
        setEventColor('tertiaryColor', v);
      }
    });
    clearTertiary?.addEventListener('click', () => {
      const c = getThemeById(effectiveThemeId)?.colors || {};
      clearEventColor(
        'tertiaryColor',
        tertiaryPicker,
        tertiaryHex,
        clearTertiary,
        c.tertiary || '#7c3aed',
      );
    });
  }
}

function _buildThemeLibraryHtml(themes) {
  const items = themes
    .map((t) => {
      const c = t.colors || {};
      if (_editingThemeId === t.id) {
        const colorPairs = _THEME_EDIT_FIELDS
          .map((f) => {
            const v = c[f.key] || f.def;
            return `<div class="appearance-add-field">
          <span>${f.label}</span>
          <div class="appearance-color-pair">
            <input type="color" id="editColor-${f.key}" value="${escapeAttr(v)}">
            <input type="text" id="editColorHex-${f.key}" value="${escapeAttr(v)}" maxlength="7" class="appearance-hex-input" placeholder="${escapeAttr(f.def)}">
          </div>
        </div>`;
          })
          .join('');
        return `<div class="appearance-library-item appearance-library-item--editing">
        <div style="width:100%">
          <p class="theme-edit-live-note"><span class="theme-edit-live-dot"></span>Previewing live — changes apply instantly</p>
          <div class="appearance-add-theme-fields">
            <label class="appearance-add-field">
              <span>Name</span>
              <input type="text" id="editThemeLabel" value="${escapeAttr(t.label)}" maxlength="32">
            </label>
            <label class="appearance-add-field appearance-add-field--check">
              <input type="checkbox" id="editThemeDark"${t.dark ? ' checked' : ''}>
              <span>Dark bg</span>
            </label>
            ${colorPairs}
          </div>
          <div class="flex gap-2 mt-2">
            <button type="button" id="doneEditTheme" class="appearance-btn-primary">Done</button>
            <button type="button" id="cancelEditTheme" class="appearance-btn-secondary">Cancel</button>
          </div>
        </div>
      </div>`;
      }
      return `<div class="appearance-library-item" data-theme-id="${escapeAttr(t.id)}">
      <div class="theme-card-swatch-row">
        <span class="theme-swatch-chip" style="background:${c.bg || '#000'}"></span>
        <span class="theme-swatch-chip" style="background:${c.primary || '#00cfff'}"></span>
        <span class="theme-swatch-chip" style="background:${c.secondary || c.primary || '#888'}"></span>
        <span class="theme-swatch-chip" style="background:${c.text || '#fff'}"></span>
      </div>
      <span class="appearance-library-label">${escapeHtml(t.label)}</span>
      <button type="button" class="appearance-library-edit" data-edit-theme="${escapeAttr(t.id)}" title="Edit theme">
        </button>
      <button type="button" class="appearance-library-delete" data-delete-theme="${escapeAttr(t.id)}" title="Delete theme">
        </button>
    </div>`;
    })
    .join('');

  return `
    <div id="themeLibraryList" class="appearance-library-list">${items}</div>
    <div id="addThemeFormWrap" class="hidden appearance-add-theme-form mt-3">
      <div class="appearance-add-theme-fields">
        <label class="appearance-add-field">
          <span>Name</span>
          <input type="text" id="newThemeLabel" placeholder="My Theme" maxlength="32">
        </label>
        <label class="appearance-add-field appearance-add-field--check">
          <input type="checkbox" id="newThemeDark" checked>
          <span>Dark background</span>
        </label>
        <div class="appearance-add-field">
          <span>Background</span>
          <div class="appearance-color-pair">
            <input type="color" id="newThemeBg" value="#010810">
            <input type="text" id="newThemeBgHex" value="#010810" maxlength="7" class="appearance-hex-input" placeholder="#010810">
          </div>
        </div>
        <div class="appearance-add-field">
          <span>Primary</span>
          <div class="appearance-color-pair">
            <input type="color" id="newThemePrimary" value="#00cfff">
            <input type="text" id="newThemePrimaryHex" value="#00cfff" maxlength="7" class="appearance-hex-input" placeholder="#00cfff">
          </div>
        </div>
        <div class="appearance-add-field">
          <span>Secondary</span>
          <div class="appearance-color-pair">
            <input type="color" id="newThemeSecondary" value="#4a90d9">
            <input type="text" id="newThemeSecondaryHex" value="#4a90d9" maxlength="7" class="appearance-hex-input" placeholder="#4a90d9">
          </div>
        </div>
        <div class="appearance-add-field">
          <span>Tertiary</span>
          <div class="appearance-color-pair">
            <input type="color" id="newThemeTertiary" value="#7c3aed">
            <input type="text" id="newThemeTertiaryHex" value="#7c3aed" maxlength="7" class="appearance-hex-input" placeholder="#7c3aed">
          </div>
        </div>
        <div class="appearance-add-field">
          <span>Text</span>
          <div class="appearance-color-pair">
            <input type="color" id="newThemeText" value="#eaf2fc">
            <input type="text" id="newThemeTextHex" value="#eaf2fc" maxlength="7" class="appearance-hex-input" placeholder="#eaf2fc">
          </div>
        </div>
      </div>
      <div class="flex gap-2 mt-2">
        <button type="button" id="confirmAddTheme" class="appearance-btn-primary">Add</button>
        <button type="button" id="cancelAddTheme" class="appearance-btn-secondary">Cancel</button>
      </div>
    </div>
    <div class="flex gap-2 mt-3">
      <button type="button" id="showAddThemeForm" class="appearance-btn-secondary">Add theme</button>
      <button type="button" id="saveThemesBtn" class="appearance-btn-primary">Save themes</button>
    </div>`;
}

function _wireThemeLibraryControls(container, rerender, fallbackThemeId) {
  container.querySelectorAll('[data-delete-theme]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.deleteTheme;
      if (getThemes().length <= 1) {
        window.alert('Cannot delete the last theme.');
        return;
      }
      if (!window.confirm(`Delete theme "${id}"?`)) return;
      setThemes(getThemes().filter((t) => t.id !== id));
      if (_editingThemeId === id) {
        _editingThemeId = null;
        _editingThemeSnapshot = null;
      }
      rerender();
    });
  });

  container.querySelectorAll('[data-edit-theme]').forEach((btn) => {
    btn.addEventListener('click', () => {
      _preEditThemeId = _editingThemeId || fallbackThemeId;
      _editingThemeId = btn.dataset.editTheme;
      _editingThemeSnapshot = JSON.parse(JSON.stringify(getThemeById(_editingThemeId)));
      rerender();
    });
  });

  document.getElementById('doneEditTheme')?.addEventListener('click', () => {
    const restoreId = _preEditThemeId || fallbackThemeId;
    _editingThemeId = null;
    _editingThemeSnapshot = null;
    _preEditThemeId = null;
    applyThemeClass(restoreId);
    rerender();
  });

  document.getElementById('cancelEditTheme')?.addEventListener('click', () => {
    if (_editingThemeSnapshot) {
      setThemes(getThemes().map((t) => (t.id === _editingThemeId ? _editingThemeSnapshot : t)));
    }
    const restoreId = _preEditThemeId || fallbackThemeId;
    _editingThemeId = null;
    _editingThemeSnapshot = null;
    _preEditThemeId = null;
    applyThemeClass(restoreId);
    rerender();
  });

  _THEME_EDIT_FIELDS.forEach(({ key }) => {
    const picker = document.getElementById(`editColor-${key}`);
    const hexInp = document.getElementById(`editColorHex-${key}`);
    if (!picker) return;
    picker.addEventListener('input', () => {
      if (hexInp) hexInp.value = picker.value.toUpperCase();
      _applyLiveEditColor(key, picker.value);
    });
    hexInp?.addEventListener('input', () => {
      const v = hexInp.value.trim();
      if (/^#[0-9a-fA-F]{6}$/.test(v)) {
        picker.value = v;
        _applyLiveEditColor(key, v);
      }
    });
  });

  document.getElementById('editThemeLabel')?.addEventListener('input', _applyLiveEditMeta);
  document.getElementById('editThemeDark')?.addEventListener('change', _applyLiveEditMeta);

  [
    ['newThemeBg', 'newThemeBgHex'],
    ['newThemePrimary', 'newThemePrimaryHex'],
    ['newThemeSecondary', 'newThemeSecondaryHex'],
    ['newThemeTertiary', 'newThemeTertiaryHex'],
    ['newThemeText', 'newThemeTextHex'],
  ].forEach(([pickerId, hexId]) => {
    const picker = document.getElementById(pickerId);
    const hexInp = document.getElementById(hexId);
    if (!picker || !hexInp) return;
    picker.addEventListener('input', () => {
      hexInp.value = picker.value.toUpperCase();
    });
    hexInp.addEventListener('input', () => {
      const v = hexInp.value.trim();
      if (/^#[0-9a-fA-F]{6}$/.test(v)) picker.value = v;
    });
  });

  document.getElementById('showAddThemeForm')?.addEventListener('click', () => {
    document.getElementById('addThemeFormWrap')?.classList.remove('hidden');
    document.getElementById('showAddThemeForm')?.classList.add('hidden');
  });
  document.getElementById('newThemeDark')?.addEventListener('change', () => {
    const isDark = document.getElementById('newThemeDark')?.checked ?? true;
    const textPicker = document.getElementById('newThemeText');
    const textHex = document.getElementById('newThemeTextHex');
    if (!textPicker || !textHex) return;
    const defaultText = isDark ? '#eaf2fc' : '#0f172a';
    textPicker.value = defaultText;
    textHex.value = defaultText;
    textHex.placeholder = defaultText;
  });
  document.getElementById('cancelAddTheme')?.addEventListener('click', () => {
    document.getElementById('addThemeFormWrap')?.classList.add('hidden');
    document.getElementById('showAddThemeForm')?.classList.remove('hidden');
  });
  document.getElementById('confirmAddTheme')?.addEventListener('click', () => {
    const label = document.getElementById('newThemeLabel')?.value.trim();
    if (!label) {
      window.alert('Please enter a theme name.');
      return;
    }
    const id = label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    if (getThemes().some((t) => t.id === id)) {
      window.alert(`A theme named "${id}" already exists.`);
      return;
    }
    const dark = document.getElementById('newThemeDark')?.checked ?? true;
    const bg = document.getElementById('newThemeBg')?.value || '#010810';
    const primary = document.getElementById('newThemePrimary')?.value || '#00cfff';
    const secondary = document.getElementById('newThemeSecondary')?.value || '#4a90d9';
    const tertiary = document.getElementById('newThemeTertiary')?.value || secondary;
    const textPicked = document.getElementById('newThemeText')?.value || '';
    const baseDefaults = dark
      ? {
          surface: 'rgba(3,10,22,0.93)',
          surfaceAlt: 'rgba(7,18,36,0.96)',
          surfaceDeep: 'rgba(12,28,52,0.84)',
          text: textPicked || '#eaf2fc',
          textAlt: '#cdd9ee',
          textMuted: '#8eaacc',
          textFaint: '#6a8cb0',
        }
      : {
          surface: 'rgba(255,255,255,0.97)',
          surfaceAlt: 'rgba(248,250,252,0.99)',
          surfaceDeep: 'rgba(241,245,249,0.95)',
          text: textPicked || '#0f172a',
          textAlt: '#1e293b',
          textMuted: '#475569',
          textFaint: '#64748b',
        };
    const bgAlt = _blendHex(bg, dark ? '#ffffff' : '#000000', 0.06);
    const border = dark ? _blendHex(bg, '#ffffff', 0.12) : _blendHex(bg, '#000000', 0.18);
    setThemes([
      ...getThemes(),
      {
        id,
        label,
        dark,
        colors: { bg, bgAlt, primary, secondary, tertiary, border, ...baseDefaults },
      },
    ]);
    rerender();
  });

  document.getElementById('saveThemesBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('saveThemesBtn');
    if (btn) btn.disabled = true;
    try {
      const ok = await saveThemesJson();
      if (ok) showSaveToast();
    } catch (e) {
      window.alert(`Failed to save themes: ${e.message}`);
    } finally {
      if (btn) btn.disabled = false;
    }
  });
}

function openEditorSettings() {
  const modal = document.getElementById('editorSettingsModal');
  if (!modal) return;
  renderEditorSettings();
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('session-modal-open');
}

function closeEditorSettings() {
  const modal = document.getElementById('editorSettingsModal');
  if (!modal) return;
  _editingThemeId = null;
  _editingThemeSnapshot = null;
  _preEditThemeId = null;
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('session-modal-open');
}

function renderEditorSettings() {
  const card = document.getElementById('editorSettingsCard');
  if (!card) return;
  const themes = getThemes();
  const globalThemeId = getCurrentThemeId();
  const globalThemeCards = themes
    .map((t) => _themeCardHtml(t, globalThemeId, 'globalTheme', _editingThemeId, globalThemeId))
    .join('');

  card.innerHTML = `
    <div class="es-header">
      <h2 id="editorSettingsTitle" class="es-title">Settings</h2>
      <button type="button" class="es-close-btn" id="esCloseBtn" aria-label="Close settings">
        </button>
    </div>
    <div class="es-body">
      <section class="es-section">
        <h3 class="es-section-title">Editor Theme</h3>
        <p class="es-section-desc">Sets the default appearance across the editor.</p>
        <div class="appearance-theme-selector" id="esGlobalThemeSelector">
          ${globalThemeCards}
        </div>
      </section>
      <section class="es-section">
        <h3 class="es-section-title">Theme Library</h3>
        <p class="es-section-desc">Add or remove themes available to all events. Changes are saved to <code>data/themes.json</code>.</p>
        ${_buildThemeLibraryHtml(themes)}
      </section>
      ${editorS3SectionHtml()}
    </div>
    <div class="es-footer">
      <button type="button" class="es-done-btn" id="esDoneBtn">Done</button>
    </div>`;

  document.getElementById('esCloseBtn')?.addEventListener('click', closeEditorSettings);
  document.getElementById('esDoneBtn')?.addEventListener('click', closeEditorSettings);
  wireEditorS3();
  document.getElementById('editorSettingsModal')?.addEventListener(
    'click',
    (e) => {
      if (e.target === document.getElementById('editorSettingsModal')) closeEditorSettings();
    },
    { once: true },
  );

  card.querySelectorAll('input[name="globalTheme"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      setCurrentThemeId(radio.value);
      applyThemeClass(radio.value);
      if (state.dataset?.event && !state.dataset.event.theme?.id) {
        applyEventColors(
          state.dataset.event.theme?.primaryColor,
          state.dataset.event.theme?.secondaryColor,
          state.dataset.event.theme?.tertiaryColor,
        );
      }
      renderEditorSettings();
    });
  });

  _wireThemeLibraryControls(card, renderEditorSettings, globalThemeId);
}

function _applyLiveEditColor(key, value) {
  if (!_editingThemeId) return;
  const updated = getThemes().map((t) => {
    if (t.id !== _editingThemeId) return t;
    const newColors = { ...t.colors, [key]: value };
    if (key === 'bg') {
      newColors.bgAlt = _blendHex(value, t.dark ? '#ffffff' : '#000000', 0.06);
    }
    return { ...t, colors: newColors };
  });
  setThemes(updated);
}

function _applyLiveEditMeta() {
  if (!_editingThemeId) return;
  const label = document.getElementById('editThemeLabel')?.value.trim() || '';
  const dark = document.getElementById('editThemeDark')?.checked ?? true;
  const updated = getThemes().map((t) => {
    if (t.id !== _editingThemeId) return t;
    return { ...t, label: label || t.label, dark };
  });
  setThemes(updated);
  applyThemeClass(_editingThemeId);
}

// ── "Part of series" — lineage, not a dataset field ──────────────────────────
//
// What an event was CALLED and what it BELONGED TO are different facts, and the
// dataset only has a field for the first (`designation`). DrupalSouth 2011 and
// 2012 were marketed as Drupal Down Under (2011.drupaldownunder.org); DrupalGov
// 2020 ran on drupalsouth.org while 2013–2017 stood alone; DrupalCamp Australia
// 2008 is DrupalSouth prehistory.
//
// This is stored in the private curation ledger, NOT in the dataset — same
// contract as the speaker/sponsor mappings, so datasets stay byte-identical and
// the archive's own record of what an event called itself is never overwritten.
// It is therefore saved on its own, immediately, and takes no part in the
// dirty/undo machinery that the dataset fields share.
function partOfSeriesFieldHtml() {
  const current = state.seriesMap?.[state.file] || '';
  const known = [...new Set([...(state.seriesOptions || []), current].filter(Boolean))].sort(
    (a, b) => a.localeCompare(b),
  );
  const opts = known.map((n) => `<option value="${escapeAttr(n)}"></option>`).join('');
  const disabled = !isApiMode() || !state.file;
  return `
    <label class="editor-form-field" id="partOfSeriesField">
      <span class="edt-label">Part of series</span>
      <span class="edt-hint">The series this event BELONGS to, when that differs from what it
      was called — Drupal Down Under 2011 was a DrupalSouth event. Leave blank for the usual
      case. Saved to the curation ledger, so the dataset is not changed.</span>
      <input id="partOfSeriesInput" list="partOfSeriesList" type="text" class="edt-field"
             value="${escapeAttr(current)}" placeholder="e.g. DrupalSouth"
             autocomplete="off" spellcheck="false" ${disabled ? 'disabled' : ''}>
      <datalist id="partOfSeriesList">${opts}</datalist>
      <span class="edt-hint" id="partOfSeriesStatus" aria-live="polite">${
        disabled ? 'Available when a dataset is open on the server.' : ''
      }</span>
    </label>`;
}

function wirePartOfSeriesField() {
  const input = document.getElementById('partOfSeriesInput');
  if (!input || input.disabled) return;
  const status = document.getElementById('partOfSeriesStatus');
  const say = (msg) => {
    if (status) status.textContent = msg;
  };
  // 'change', not 'input': this writes straight through to the ledger, and
  // saving on every keystroke would file a mapping for every prefix typed.
  input.addEventListener('change', async () => {
    const series = input.value.trim();
    try {
      const res = await fetch('/api/curation/series', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: state.file, series }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) return say(body?.error || 'Could not save that.');
      state.seriesMap = body.series || {};
      say(series ? `Saved — grouped under ${series}.` : 'Cleared — grouped under its own name.');
    } catch {
      say('Offline — nothing saved.');
    }
  });
}

/** The lineage map, loaded once per editor session. */
async function loadSeriesMap() {
  if (!isApiMode() || state.seriesMap) return;
  try {
    const res = await fetch('/api/curation/series');
    state.seriesMap = res.ok ? ((await res.json()).series ?? {}) : {};
  } catch {
    state.seriesMap = {};
  }
  // Offer the series the archive already knows, so a lineage is picked rather
  // than retyped — a typo here silently creates a one-event series.
  try {
    const res = await fetch('./data/catalog.json');
    const cat = res.ok ? await res.json() : null;
    const names = (cat?.events || []).map((e) => e.event?.designation).filter(Boolean);
    state.seriesOptions = [...new Set([...names, ...Object.values(state.seriesMap)])];
  } catch {
    state.seriesOptions = [...new Set(Object.values(state.seriesMap))];
  }
}

function renderEventMetaForm() {
  const event = state.dataset?.event || {};
  const visibleFields = EVENT_META_FIELDS.filter(
    (field) => !['id', 'name', 'logo', 'flickr'].includes(field),
  );

  const html = visibleFields
    .map((field) => {
      const config = EVENT_META_FIELD_CONFIG[field] || { label: field, description: '' };
      const isWide = field === 'website' || field === 'scheduleURLs';
      const spanClass = isWide ? 'md:col-span-2 xl:col-span-3' : '';

      if (field === 'attendance') {
        const a = event.attendance || {};
        return `
        <div class="editor-form-field md:col-span-2 xl:col-span-3">
          ${renderFieldIntro('event', field, config)}
          <div class="edt-attendance">
            <label class="edt-attendance__count">
              <span class="edt-sublabel">Final count</span>
              <input data-event-field="attendance.count" type="number" min="0" step="1"
                     value="${escapeAttr(a.count ?? '')}" placeholder="e.g. 412" class="edt-field">
            </label>
            <label class="edt-attendance__source">
              <span class="edt-sublabel">Source</span>
              <input data-event-field="attendance.source" type="text"
                     value="${escapeAttr(a.source || '')}" placeholder="Report URL, or who supplied it" class="edt-field">
            </label>
            <label class="edt-attendance__note">
              <span class="edt-sublabel">Note</span>
              <input data-event-field="attendance.note" type="text"
                     value="${escapeAttr(a.note || '')}" placeholder="e.g. in person only" class="edt-field">
            </label>
          </div>
        </div>`;
      }

      if (field === 'scheduleURLs') {
        const urls = normalizeUrlArray(event[field]);
        return renderUrlMultifieldHtml('event', field, config, urls);
      }

      if (field === 'timezone') {
        const current = safeTimezone(event[field] || 'UTC');
        const timezoneValues = state.timezones.includes(current)
          ? state.timezones
          : [current, ...state.timezones];
        const options = timezoneValues
          .map(
            (tz) =>
              `<option value="${escapeAttr(tz)}" ${tz === current ? 'selected' : ''}>${escapeHtml(tz)}</option>`,
          )
          .join('');
        return `
        <label class="editor-form-field ${spanClass}">
          ${renderFieldIntro('event', field, config)}
          <select data-event-field="timezone" class="edt-field pr-10"${fieldDescriptionAttr(
            'event',
            field,
            config,
          )}>${options}</select>
        </label>
      `;
      }

      if (field === 'ecosystem') {
        // Values mirror the schema enum. Extend both together — the schema is
        // authoritative and a value it rejects cannot be saved.
        const current = event[field] || '';
        const options = ['', 'drupal', 'wordpress', 'symfony', 'php', 'javascript', 'other']
          .map(
            (v) =>
              `<option value="${escapeAttr(v)}" ${v === current ? 'selected' : ''}>${
                v ? escapeHtml(v[0].toUpperCase() + v.slice(1)) : '— not set —'
              }</option>`,
          )
          .join('');
        return `
        <label class="editor-form-field ${spanClass}">
          ${renderFieldIntro('event', field, config)}
          <select data-event-field="ecosystem" class="edt-field pr-10"${fieldDescriptionAttr(
            'event',
            field,
            config,
          )}>${options}</select>
        </label>
      `;
      }

      if (field === 'enabled') {
        const checked = event.enabled === true || String(event.enabled).toLowerCase() === 'true';
        return `
        <label class="editor-form-field ${spanClass}">
          ${renderFieldIntro('event', field, config)}
          <span class="edt-btn">
            <input data-event-field="${field}" type="checkbox" class="h-4 w-4" ${checked ? 'checked' : ''}${fieldDescriptionAttr(
              'event',
              field,
              config,
            )}>
            <span class="text-sm edt-ink-1">Show this event in planner</span>
          </span>
        </label>
      `;
      }

      if (field === 'scheduleComplete') {
        const checked =
          event.scheduleComplete === true ||
          String(event.scheduleComplete).toLowerCase() === 'true';
        return `
        <label class="editor-form-field ${spanClass}">
          ${renderFieldIntro('event', field, config)}
          <span class="edt-btn">
            <input data-event-field="${field}" type="checkbox" class="h-4 w-4" ${checked ? 'checked' : ''}${fieldDescriptionAttr(
              'event',
              field,
              config,
            )}>
            <span class="text-sm edt-ink-1">Event has passed, schedule is final</span>
          </span>
        </label>
      `;
      }

      if (field === 'startDate' || field === 'endDate') {
        const raw = toStringValue(event[field]);
        const dateValue = raw ? raw.split('T')[0] : '';
        return `
        <label class="editor-form-field ${spanClass}">
          ${renderFieldIntro('event', field, config)}
          <input data-event-field="${field}" type="date" value="${escapeAttr(dateValue)}" class="edt-field"${fieldDescriptionAttr(
            'event',
            field,
            config,
          )}>
        </label>
      `;
      }

      if (field === 'columns') {
        const value = Number.isFinite(Number(event[field])) ? Number(event[field]) : 3;
        return `
        <label class="editor-form-field ${spanClass}">
          ${renderFieldIntro('event', field, config)}
          <input data-event-field="columns" type="number" min="1" max="8" step="1" value="${value}" class="edt-field"${fieldDescriptionAttr(
            'event',
            field,
            config,
          )}>
        </label>
      `;
      }

      if (field === 'regionCode') {
        const current = toStringValue(event[field]).toUpperCase();
        const REGION_LABELS = {
          EMEA: 'Europe, Middle East & Africa',
          APAC: 'Asia-Pacific',
          AMER: 'North America',
          LATAM: 'Latin America',
        };
        const options = ['', 'EMEA', 'APAC', 'AMER', 'LATAM']
          .map(
            (code) =>
              `<option value="${code}" ${code === current ? 'selected' : ''}>${code ? `${code} — ${REGION_LABELS[code]}` : '— none —'}</option>`,
          )
          .join('');
        return `
        <label class="editor-form-field ${spanClass}">
          ${renderFieldIntro('event', field, config)}
          <select data-event-field="regionCode" class="edt-field pr-10"${fieldDescriptionAttr(
            'event',
            field,
            config,
          )}>${options}</select>
        </label>
      `;
      }

      // Longitude is rendered together with latitude (below), so skip it here.
      if (field === 'longitude') return '';

      if (field === 'latitude') {
        // Render latitude + longitude side by side on one row, with the map picker
        // beneath them.
        const numInput = (f) => {
          const cfg = EVENT_META_FIELD_CONFIG[f] || { label: f, description: '' };
          const val =
            event[f] === '' || event[f] == null || !Number.isFinite(Number(event[f]))
              ? ''
              : String(event[f]);
          const range = f === 'latitude' ? 'min="-90" max="90"' : 'min="-180" max="180"';
          const ph = f === 'latitude' ? '-41.2865' : '174.7762';
          return `<label class="editor-form-field">
            ${renderFieldIntro('event', f, cfg)}
            <input data-event-field="${f}" type="number" step="any" ${range} value="${escapeAttr(val)}" placeholder="${ph}" class="edt-field"${fieldDescriptionAttr(
              'event',
              f,
              cfg,
            )}>
          </label>`;
        };
        return `
        <div class="md:col-span-2 xl:col-span-3">
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            ${numInput('latitude')}
            ${numInput('longitude')}
          </div>
          <div class="mt-2">
            <button type="button" id="pickVenueLocationBtn" class="h-9 px-3 border edt-rule rounded-md text-sm font-medium edt-ink-1 edt-surface transition-colors inline-flex items-center">Pick location on map</button>
          </div>
        </div>
      `;
      }

      const value = toStringValue(event[field]);
      return `
      <label class="editor-form-field ${spanClass}">
        ${renderFieldIntro('event', field, config)}
        <input data-event-field="${field}" type="text" value="${escapeAttr(value)}" class="edt-field"${fieldDescriptionAttr(
          'event',
          field,
          config,
        )}>
      </label>
    `;
    })
    .join('');

  els.eventMetaForm.innerHTML = html + partOfSeriesFieldHtml();
  wirePartOfSeriesField();

  els.eventMetaForm.querySelectorAll('[data-event-field]').forEach((input) => {
    input.addEventListener('focus', undoPush);
    input.addEventListener('input', () => {
      const field = input.dataset.eventField;
      if (field.startsWith('attendance.')) {
        // One nested block, three inputs. The count is what makes the block worth
        // keeping, so clearing it removes the whole thing rather than leaving a
        // source pointing at a number that is no longer there.
        const key = field.slice('attendance.'.length);
        const next = { ...(state.dataset.event.attendance || {}) };
        const raw = input.value.trim();
        if (key === 'count') {
          const n = Number.parseInt(raw, 10);
          if (raw === '' || !Number.isFinite(n) || n < 0) delete next.count;
          else next.count = n;
        } else if (raw === '') delete next[key];
        else next[key] = raw;
        if (next.count === undefined) delete state.dataset.event.attendance;
        else {
          // Stamp when the figure was recorded, the same way community credits do.
          next.capturedAt = next.capturedAt || new Date().toISOString().slice(0, 10);
          state.dataset.event.attendance = next;
        }
      } else if (field === 'columns') {
        const parsed = Number.parseInt(input.value || '3', 10);
        state.dataset.event.columns = Number.isFinite(parsed) ? parsed : 3;
      } else if (field === 'timezone') {
        state.dataset.event.timezone = safeTimezone(input.value);
        renderSessionList();
        renderSessionForm();
        renderFlickrForm();
      } else if (field === 'enabled' || field === 'scheduleComplete') {
        state.dataset.event[field] = Boolean(input.checked);
      } else if (field === 'startDate' || field === 'endDate') {
        // The <input type="date"> yields a bare "YYYY-MM-DD"; the schema requires a
        // full date-time, so merge in the previous time-of-day (UTC midnight if none).
        state.dataset.event[field] = mergeDateIntoIso(
          input.value,
          toStringValue(state.dataset.event[field]),
        );
      } else if (field === 'latitude' || field === 'longitude') {
        // Schema requires a number — store one, or drop the field when cleared.
        const raw = input.value.trim();
        const n = Number(raw);
        if (raw === '' || !Number.isFinite(n)) delete state.dataset.event[field];
        else state.dataset.event[field] = n;
      } else if (field === 'regionCode' || field === 'country' || field === 'ecosystem') {
        // Canonical facet fields — drop them entirely when blank (their enums have
        // no empty option), rather than storing an empty string. The "— not set —"
        // option exists to CLEAR the field; storing "" would fail validation on save.
        const raw = input.value.trim();
        if (raw === '') delete state.dataset.event[field];
        else state.dataset.event[field] = field === 'regionCode' ? raw.toUpperCase() : raw;
      } else {
        state.dataset.event[field] = input.value;
      }
      markDirty(true);
      if (field === 'designation' || field === 'year' || field === 'location') {
        renderLogoForm();
        renderFlickrForm();
      }
      if (
        (field === 'startDate' || field === 'endDate') &&
        state.activeEditorTab === 'timeline' &&
        els.timelineCanvas
      ) {
        renderTimeline(els.timelineCanvas, state.dataset, {
          markDirty: () => markDirty(true),
          trackQuickSessionChange,
          undoPush,
          utcIsoToLocalInput,
          localInputToUtcIso,
          getEventTimezone,
        });
      }
    });
  });

  document.getElementById('pickVenueLocationBtn')?.addEventListener('click', () => {
    const ev = state.dataset?.event || {};
    const lat = Number(ev.latitude);
    const lon = Number(ev.longitude);
    openMapPicker({
      title: 'Pick venue location',
      searchPlaceholder: 'Search a venue, address or city…',
      lat: Number.isFinite(lat) && ev.latitude !== '' ? lat : null,
      lon: Number.isFinite(lon) && ev.longitude !== '' ? lon : null,
      query: [ev.venue, ev.location, ev.region].filter(Boolean).join(', '),
      onConfirm: (la, lo) => {
        undoPush();
        state.dataset.event.latitude = la;
        state.dataset.event.longitude = lo;
        markDirty(true);
        renderEventMetaForm();
      },
    });
  });

  els.eventMetaForm.querySelectorAll('[data-url-field]').forEach((input) => {
    input.addEventListener('input', () => {
      const field = input.dataset.urlField;
      const index = Number(input.dataset.urlIndex);
      if (!Array.isArray(state.dataset.event[field])) state.dataset.event[field] = [];
      state.dataset.event[field][index] = input.value;
      markDirty(true);
    });
  });

  els.eventMetaForm.querySelectorAll('[data-url-add]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const field = btn.dataset.urlAdd;
      if (!Array.isArray(state.dataset.event[field])) state.dataset.event[field] = [];
      state.dataset.event[field].push('');
      markDirty(true);
      renderEventMetaForm();
    });
  });

  els.eventMetaForm.querySelectorAll('[data-url-remove]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const field = btn.dataset.urlRemove;
      const index = Number(btn.dataset.urlIndex);
      if (!Array.isArray(state.dataset.event[field])) return;
      state.dataset.event[field].splice(index, 1);
      markDirty(true);
      renderEventMetaForm();
    });
  });

  renderLogoForm();
  renderFlickrForm();
}

function setEventMetaCollapsed(collapsed) {
  if (!els.eventMetaBody || !els.toggleEventMetaIcon) return;
  els.eventMetaBody.classList.toggle('hidden', collapsed);
  els.toggleEventMetaIcon.classList.toggle('fa-chevron-up', !collapsed);
  els.toggleEventMetaIcon.classList.toggle('fa-chevron-down', collapsed);
}

function syncSessionEditorPanelVisibility() {
  if (!els.sessionEditorPanel) return;
  const shouldHide = state.sessionListExpanded && state.selectedIndex < 0;
  els.sessionEditorPanel.classList.toggle('hidden', shouldHide);
}

function syncSponsorEditorPanelVisibility() {
  if (!els.sponsorEditorPanel) return;
  const shouldHide = state.sponsorListExpanded && state.selectedSponsorIndex < 0;
  els.sponsorEditorPanel.classList.toggle('hidden', shouldHide);
}

function setSessionWorkspaceExpanded(expanded) {
  const nextExpanded = Boolean(expanded);
  const wasExpanded = state.sessionListExpanded;
  if (nextExpanded && !wasExpanded) {
    state.selectedIndex = -1;
    if (!state.sessionQuickEditEnabled) {
      markSessionDirty(false);
    }
  }
  state.sessionListExpanded = nextExpanded;
  if (!state.sessionListExpanded) {
    state.sessionQuickEditEnabled = false;
  }
  if (!els.sessionWorkspace || !els.sessionSidebarPanel || !els.sessionEditorPanel) return;

  els.sessionWorkspace.classList.toggle(
    'editor-session-workspace-expanded',
    state.sessionListExpanded,
  );
  els.sessionSidebarPanel.classList.toggle('xl:col-span-2', state.sessionListExpanded);
  els.sessionEditorPanel.classList.toggle('xl:col-span-2', state.sessionListExpanded);

  if (els.toggleSessionWorkspaceIcon) {
    els.toggleSessionWorkspaceIcon.classList.toggle('fa-expand-alt', !state.sessionListExpanded);
    els.toggleSessionWorkspaceIcon.classList.toggle('fa-compress-alt', state.sessionListExpanded);
  }
  if (els.toggleSessionWorkspaceLabel) {
    els.toggleSessionWorkspaceLabel.textContent = state.sessionListExpanded
      ? 'Collapse list'
      : 'Expand list';
  }
  syncSessionEditorPanelVisibility();
  syncQuickSessionEditToggle();
  markSessionDirty(state.sessionDirty);
}

function setSponsorWorkspaceExpanded(expanded) {
  const nextExpanded = Boolean(expanded);
  const wasExpanded = state.sponsorListExpanded;
  if (nextExpanded && !wasExpanded) {
    state.selectedSponsorIndex = -1;
    if (!state.sponsorQuickEditEnabled) {
      markSponsorDirty(false);
    }
  }
  state.sponsorListExpanded = nextExpanded;
  if (!state.sponsorListExpanded) {
    state.sponsorQuickEditEnabled = false;
  }
  if (!els.sponsorWorkspace || !els.sponsorSidebarPanel || !els.sponsorEditorPanel) return;

  els.sponsorWorkspace.classList.toggle(
    'editor-session-workspace-expanded',
    state.sponsorListExpanded,
  );
  els.sponsorSidebarPanel.classList.toggle('xl:col-span-2', state.sponsorListExpanded);
  els.sponsorEditorPanel.classList.toggle('xl:col-span-2', state.sponsorListExpanded);

  if (els.toggleSponsorWorkspaceIcon) {
    els.toggleSponsorWorkspaceIcon.classList.toggle('fa-expand-alt', !state.sponsorListExpanded);
    els.toggleSponsorWorkspaceIcon.classList.toggle('fa-compress-alt', state.sponsorListExpanded);
  }
  if (els.toggleSponsorWorkspaceLabel) {
    els.toggleSponsorWorkspaceLabel.textContent = state.sponsorListExpanded
      ? 'Collapse list'
      : 'Expand list';
  }
  syncSponsorEditorPanelVisibility();
  syncQuickSponsorEditToggle();
  markSponsorDirty(state.sponsorDirty);
}

const EDITOR_TABS = [
  'event',
  'people',
  'logo',
  'flickr',
  'sessions',
  'timeline',
  'sponsors',
  'related',
  'sitemap',
  'appearance',
];

// The dataset and the workspace both live in the path — /editor/<dataset>/<tab>,
// see editorRoute.js. Captured at init() before the default 'event' tab
// overwrites it, then applied by restorePendingEditorTab() after a dataset loads.
let _initialEditorTab = null;
/** Dataset named by the URL at boot, opened once the editor can read files. */
let _initialDatasetFile = '';

// Writes the CURRENT dataset + tab into the address bar. replaceState, not push:
// switching workspace is not a page you should have to press Back through, and
// the dataset you are editing is the same record either way.
function writeEditorUrl(tab) {
  try {
    // Don't blank a deep link before it has had its chance: init() sets the
    // default 'event' tab BEFORE the requested dataset is open, and writing then
    // would replace /editor/<dataset>/<tab> with a bare /editor and lose the very
    // thing we are about to load.
    if (!state.file && _initialDatasetFile) return;
    const path = editorPath(state.file || '', tab || state.activeEditorTab, EDITOR_TABS);
    history.replaceState(null, '', path);
  } catch {
    /* history API blocked (e.g. sandboxed) → ignore */
  }
}

function restorePendingEditorTab() {
  const tab = _initialEditorTab;
  _initialEditorTab = null;
  if (tab && tab !== 'event' && EDITOR_TABS.includes(tab)) setActiveEditorTab(tab);
  // Whatever tab we landed on, the address bar must now name the dataset that is
  // actually open — including when a dataset was picked from the welcome grid,
  // where nothing else would have written the URL.
  else writeEditorUrl();
}

// The route, rendered: Home → Editor → <dataset> → <workspace>. Same contract
// as the planner's and the archive's, so the three sections read alike. The
// dataset's own home IS its first workspace, so that one is not a step of its
// own in the trail.
const EDITOR_TAB_LABELS = {
  event: 'Event',
  logo: 'Logo',
  flickr: 'Photos',
  sessions: 'Sessions',
  timeline: 'Timeline',
  sponsors: 'Sponsors',
  people: 'People',
  related: 'Related events',
  sitemap: 'Sources',
  appearance: 'Appearance',
};

// ── People tab ───────────────────────────────────────────────────────────────
// Organisers and volunteers are editable; speakers are a read-only projection of
// the schedule (see modules/editorPeople.js for why).

/** The credits container, created on demand so an older dataset can gain one. */
function ensureCommunity() {
  const ev = state.dataset.event;
  if (!ev.community || typeof ev.community !== 'object') {
    ev.community = { url: '', people: [] };
  }
  if (!Array.isArray(ev.community.people)) ev.community.people = [];
  return ev.community;
}

/**
 * Drop the container when it holds nothing worth keeping. The schema requires
 * `url` and `people`, so a half-empty object written by an idle visit to this
 * tab would fail validation on save — better to have no block than an invalid one.
 */
function pruneCommunity() {
  const c = state.dataset?.event?.community;
  if (!c) return;
  const hasPeople = Array.isArray(c.people) && c.people.length > 0;
  const hasUrl = typeof c.url === 'string' && c.url.trim() !== '';
  if (!hasPeople && !hasUrl) delete state.dataset.event.community;
  else if (!c.url) c.url = '';
}

function renderPeopleTab() {
  if (!els.peopleGroups) return;
  if (!state.dataset) {
    els.peopleGroups.innerHTML = '';
    return;
  }
  const c = state.dataset.event?.community || {};
  if (els.communityUrlInput) els.communityUrlInput.value = c.url || '';
  if (els.communityCapturedInput) els.communityCapturedInput.value = c.capturedAt || '';
  els.peopleGroups.innerHTML = peopleGroupsHtml(state.dataset);
}

// The add/edit dialog. Uses the editor's existing modal shell (the same
// `session-modal-overlay` / `session-modal-card` markup as the API settings and
// sponsor pickers) rather than window.prompt: three chained prompts could not
// validate as a set, could not offer the role as a CHOICE, and gave no way back
// once you had started.
const personModal = {
  /** @type {null | ((p: object|null) => void)} resolver for the open dialog */
  _resolve: null,
  _index: -1,
};

function personModalEls() {
  return {
    overlay: document.getElementById('personModal'),
    title: document.getElementById('personModalTitle'),
    username: document.getElementById('personUsernameInput'),
    name: document.getElementById('personNameInput'),
    role: document.getElementById('personRoleSelect'),
    error: document.getElementById('personModalError'),
    save: document.getElementById('personModalSave'),
    cancel: document.getElementById('personModalCancel'),
    close: document.getElementById('personModalClose'),
  };
}

function closePersonModal(result) {
  const { overlay } = personModalEls();
  overlay?.classList.add('hidden');
  overlay?.setAttribute('aria-hidden', 'true');
  const resolve = personModal._resolve;
  personModal._resolve = null;
  personModal._index = -1;
  if (resolve) resolve(result ?? null);
}

/**
 * Open the dialog. Resolves with the person, or null if dismissed.
 * @param {object|null} existing
 * @returns {Promise<object|null>}
 */
function openPersonModal(existing) {
  const el = personModalEls();
  if (!el.overlay) return Promise.resolve(null);
  el.title.textContent = existing ? 'Edit person' : 'Add person';
  el.username.value = existing?.username || '';
  el.name.value = existing?.name || '';
  el.role.value = existing?.role || 'organiser';
  el.error.classList.add('hidden');
  el.overlay.classList.remove('hidden');
  el.overlay.setAttribute('aria-hidden', 'false');
  el.username.focus();
  return new Promise((resolve) => {
    personModal._resolve = resolve;
  });
}

/** Read the form, or return null and show why. */
function readPersonForm() {
  const el = personModalEls();
  // Accept a pasted profile URL as well as a bare slug — the URL is what is on
  // the clipboard when you are looking at someone's profile.
  const username = el.username.value
    .trim()
    .replace(/^.*\/u\//, '')
    .replace(/[/?#].*$/, '');
  if (!username) {
    el.error.textContent = 'A username is required — it is how the person is identified.';
    el.error.classList.remove('hidden');
    el.username.focus();
    return null;
  }
  const role = el.role.value;
  if (!CREDIT_ROLES.includes(role)) {
    el.error.textContent = `Role must be one of: ${CREDIT_ROLES.join(', ')}`;
    el.error.classList.remove('hidden');
    return null;
  }
  const name = el.name.value.trim();
  const person = { username, role };
  if (name && name !== username) person.name = name;
  return person;
}

function wirePersonModal() {
  const el = personModalEls();
  if (!el.overlay) return;
  el.close?.addEventListener('click', () => closePersonModal(null));
  el.cancel?.addEventListener('click', () => closePersonModal(null));
  el.overlay.addEventListener('click', (e) => {
    if (e.target === el.overlay) closePersonModal(null);
  });
  el.overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePersonModal(null);
    if (e.key === 'Enter' && e.target !== el.role) {
      e.preventDefault();
      const person = readPersonForm();
      if (person) closePersonModal(person);
    }
  });
  el.save?.addEventListener('click', () => {
    const person = readPersonForm();
    if (person) closePersonModal(person);
  });
}

function wirePeopleTab() {
  els.communityUrlInput?.addEventListener('input', () => {
    ensureCommunity().url = els.communityUrlInput.value.trim();
    pruneCommunity();
    markDirty(true);
  });
  els.communityCapturedInput?.addEventListener('input', () => {
    const v = els.communityCapturedInput.value;
    const c = ensureCommunity();
    if (v) c.capturedAt = v;
    else delete c.capturedAt;
    pruneCommunity();
    markDirty(true);
  });

  els.addPersonBtn?.addEventListener('click', async () => {
    if (!state.dataset) return;
    const person = await openPersonModal(null);
    if (!person) return;
    undoPush();
    ensureCommunity().people.push(person);
    markDirty(true);
    renderPeopleTab();
  });

  // Delegated: the rows are rebuilt on every render.
  els.peopleGroups?.addEventListener('click', async (e) => {
    const editBtn = e.target.closest('[data-person-edit]');
    const removeBtn = e.target.closest('[data-person-remove]');
    if (!editBtn && !removeBtn) return;
    const people = state.dataset?.event?.community?.people;
    if (!Array.isArray(people)) return;
    const index = Number(
      (editBtn || removeBtn).getAttribute(editBtn ? 'data-person-edit' : 'data-person-remove'),
    );
    const current = people[index];
    if (!current) return;

    if (removeBtn) {
      if (!window.confirm(`Remove ${current.name || current.username} from the credits?`)) return;
      undoPush();
      people.splice(index, 1);
      pruneCommunity();
    } else {
      const updated = await openPersonModal(current);
      if (!updated) return;
      undoPush();
      people[index] = updated;
    }
    markDirty(true);
    renderPeopleTab();
  });
}

function renderEditorCrumbs() {
  const nav = document.getElementById('editorCrumbs');
  if (!nav) return;
  // The dataset's own name if it has one, else the file it came from.
  const ev = state.dataset?.event || {};
  const name = state.dataset
    ? [ev.designation, ev.location, ev.year].filter(Boolean).join(' ').trim() || state.file || ''
    : '';
  const tab = state.activeEditorTab;
  // The dataset crumb goes back to that dataset's first workspace, not to a bare
  // editor — clicking the record you are editing should not close it. editorPath
  // now picks the form itself, so this no longer needs its own served check: as
  // plain files it returns ./editor.html?file=… , which is a real address there
  // rather than the /editor path a static host cannot serve.
  const datasetHref = editorPath(state.file, 'event', EDITOR_TABS);
  const trail = [{ label: 'Home', href: './home.html' }];
  trail.push(name ? { label: 'Editor', href: './editor.html' } : { label: 'Editor' });
  if (name) {
    const showTab = tab && tab !== 'event';
    trail.push(showTab ? { label: name, href: datasetHref } : { label: name });
    if (showTab) trail.push({ label: EDITOR_TAB_LABELS[tab] || tab });
  }
  nav.innerHTML = trail
    .map((c, i) =>
      i === trail.length - 1
        ? `<span aria-current="page">${escapeHtml(c.label)}</span>`
        : `<a href="${escapeHtml(c.href)}">${escapeHtml(c.label)}</a>`,
    )
    .join('<span class="app-crumbs__sep" aria-hidden="true">&rarr;</span>');
}

function setActiveEditorTab(tab) {
  const nextTab = EDITOR_TABS.includes(tab) ? tab : 'event';
  state.activeEditorTab = nextTab;
  writeEditorUrl(nextTab);

  renderEditorCrumbs();

  const inSessionsArea = nextTab === 'sessions' || nextTab === 'timeline';

  // Main panel visibility
  els.eventWorkspacePanel?.classList.toggle('hidden', nextTab !== 'event');
  els.logoWorkspacePanel?.classList.toggle('hidden', nextTab !== 'logo');
  els.flickrWorkspacePanel?.classList.toggle('hidden', nextTab !== 'flickr');
  els.sessionWorkspacePanel?.classList.toggle('hidden', !inSessionsArea);
  els.sponsorWorkspacePanel?.classList.toggle('hidden', nextTab !== 'sponsors');
  els.peopleWorkspacePanel?.classList.toggle('hidden', nextTab !== 'people');
  els.relatedWorkspacePanel?.classList.toggle('hidden', nextTab !== 'related');
  els.sitemapWorkspacePanel?.classList.toggle('hidden', nextTab !== 'sitemap');
  els.appearanceWorkspacePanel?.classList.toggle('hidden', nextTab !== 'appearance');

  // Sessions sub-panels
  els.sessionDetailsPanel?.classList.toggle('hidden', nextTab !== 'sessions');
  els.timelineWorkspacePanel?.classList.toggle('hidden', nextTab !== 'timeline');

  // Main tab buttons
  const tabButtonMap = {
    event: els.showEventTab,
    logo: els.showLogoTab,
    flickr: els.showFlickrTab,
    sponsors: els.showSponsorsTab,
    people: els.showPeopleTab,
    related: els.showRelatedTab,
    sitemap: els.showSitemapTab,
    appearance: els.showAppearanceTab,
  };
  for (const [key, btn] of Object.entries(tabButtonMap)) {
    if (!btn) continue;
    const active = nextTab === key;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  }
  // Sessions tab is active for both sessions and timeline sub-tabs
  if (els.showSessionsTab) {
    els.showSessionsTab.classList.toggle('is-active', inSessionsArea);
    els.showSessionsTab.setAttribute('aria-selected', inSessionsArea ? 'true' : 'false');
  }

  // Sessions sub-tab buttons
  if (els.showSessionDetailsSubTab) {
    const active = nextTab === 'sessions';
    els.showSessionDetailsSubTab.classList.toggle('is-active', active);
    els.showSessionDetailsSubTab.setAttribute('aria-selected', active ? 'true' : 'false');
  }
  if (els.showSessionTimelineSubTab) {
    const active = nextTab === 'timeline';
    els.showSessionTimelineSubTab.classList.toggle('is-active', active);
    els.showSessionTimelineSubTab.setAttribute('aria-selected', active ? 'true' : 'false');
  }

  document.dispatchEvent(new CustomEvent('editor-tab-changed'));

  // Side-effects on activation
  if (nextTab === 'sitemap') {
    renderSourcesEditor();
    renderSponsorSourceField();
    renderSitemap();
  }
  if (nextTab === 'related') renderRelatedList();
  if (nextTab === 'sponsors' && els.sponsorLogosDisabledToggle) {
    els.sponsorLogosDisabledToggle.checked = state.dataset?.event?.sponsorLogosDisabled === true;
  }
  if (nextTab === 'appearance') renderAppearanceForm();
  if (nextTab === 'timeline' && state.dataset && els.timelineCanvas) {
    renderTimeline(els.timelineCanvas, state.dataset, {
      markDirty: () => markDirty(true),
      trackQuickSessionChange,
      undoPush,
      utcIsoToLocalInput,
      localInputToUtcIso,
      getEventTimezone,
    });
  }
}

function switchEditorTab(tab) {
  const nextTab = EDITOR_TABS.includes(tab) ? tab : 'event';
  if (nextTab === state.activeEditorTab) return;
  setActiveEditorTab(nextTab);
}

function selectSessionForm(index, options = {}) {
  const { collapseWorkspace = false } = options;
  if (index === state.selectedIndex && !collapseWorkspace) return;
  state.selectedIndex = index;
  if (!isQuickSessionEditEnabled()) {
    markSessionDirty(false);
  } else {
    markSessionDirty(state.sessionDirty);
  }
  if (collapseWorkspace && state.sessionListExpanded) {
    setSessionWorkspaceExpanded(false);
  }
  renderSessionList();
  renderSessionForm();
  syncSessionSaveButton();
  els.deleteSession.disabled = index < 0;
  return true;
}

function selectSponsorForm(index, options = {}) {
  const { collapseWorkspace = false } = options;
  if (index === state.selectedSponsorIndex && !collapseWorkspace) return;
  state.selectedSponsorIndex = index;
  if (!isQuickSponsorEditEnabled()) {
    markSponsorDirty(false);
  } else {
    markSponsorDirty(state.sponsorDirty);
  }
  if (collapseWorkspace && state.sponsorListExpanded) {
    setSponsorWorkspaceExpanded(false);
  }
  renderSponsorList();
  renderSponsorForm();
  syncSponsorSaveButton();
  els.deleteSponsor.disabled = index < 0;
  return true;
}

function getSessionTimingSummary(item) {
  const start = item?.startTime ? formatSessionTimeForList(item.startTime) : '';
  const end = item?.endTime ? formatSessionTimeForList(item.endTime) : '';
  if (start && end) return `${start} to ${end}`;
  return start || end || '';
}

function formatDateHeading(dateKey) {
  const utcNoon = localInputToUtcIso(dateKey + 'T12:00', getEventTimezone());
  if (!utcNoon) return dateKey;
  return new Intl.DateTimeFormat('en', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: getEventTimezone(),
  }).format(new Date(utcNoon));
}

function scrollToSessionRow(index) {
  els.sessionList
    .querySelector(`[data-session-index="${index}"]`)
    ?.scrollIntoView({ block: 'nearest' });
}

function scrollToSponsorRow(index) {
  els.sponsorList
    .querySelector(`[data-sponsor-index="${index}"]`)
    ?.scrollIntoView({ block: 'nearest' });
}

function datasetJsonText() {
  stripSummaryFields(state.dataset);
  syncAllSessionDurations();
  return `${JSON.stringify(state.dataset, null, 2)}\n`;
}

// FNV-1a 32-bit — a fast, dependency-free content hash. Used only to detect that
// a dataset file changed on disk since we loaded it (not for security).
function contentFingerprint(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

// The current on-disk text for the loaded dataset (API or folder mode), or null
// when it can't be read — in which case the caller treats it as "can't verify"
// and allows the save rather than blocking on a transient hiccup.
async function readCurrentDiskText() {
  try {
    if (isApiMode()) {
      if (!state.file) return null;
      const res = await fetch(
        `${state.apiEndpoint}/api/data/${state.file.split('/').map(encodeURIComponent).join('/')}`,
        { cache: 'no-store' },
      );
      if (!res.ok) return null;
      return await res.text();
    }
    if (state.fileHandle) {
      const fileBlob = await state.fileHandle.getFile();
      return await fileBlob.text();
    }
  } catch {
    /* ignore — treat as unverifiable */
  }
  return null;
}

// The stale-write modal — resolves to 'reload', 'overwrite', or 'cancel'. Falls
// back to window.confirm if the modal markup is unavailable.
function promptStaleWrite() {
  return new Promise((resolve) => {
    const modal = document.getElementById('staleWriteModal');
    if (!modal) {
      resolve(
        window.confirm('This dataset changed on disk. Overwrite it with your version?')
          ? 'overwrite'
          : 'cancel',
      );
      return;
    }
    const targetEl = document.getElementById('staleWriteTarget');
    if (targetEl)
      targetEl.textContent = outputBasename(state.outputPath) || state.file || 'This dataset';
    modal.classList.remove('hidden');
    document.body.classList.add('session-modal-open');

    const done = (result) => {
      modal.classList.add('hidden');
      document.body.classList.remove('session-modal-open');
      resolve(result);
    };
    const wire = (id, result) =>
      document.getElementById(id)?.addEventListener('click', () => done(result), { once: true });
    wire('staleWriteReload', 'reload');
    wire('staleWriteOverwrite', 'overwrite');
    wire('staleWriteCancel', 'cancel');
    modal.addEventListener(
      'click',
      (e) => {
        if (e.target === modal) done('cancel');
      },
      { once: true },
    );
  });
}

// Guard against silently overwriting external edits. Re-reads the file and, if it
// changed since we loaded/last saved it, asks the user what to do. Returns true to
// proceed with the save; false to abort (Cancel keeps your edits, Reload latest
// discards them and loads the on-disk version).
async function confirmNoStaleOverwrite() {
  if (!state.loadedDiskFingerprint) return true; // nothing to compare (new file / Save As)
  const current = await readCurrentDiskText();
  if (current == null) return true; // couldn't verify — don't block on a hiccup
  if (contentFingerprint(current) === state.loadedDiskFingerprint) return true;
  const choice = await promptStaleWrite();
  if (choice === 'overwrite') return true;
  if (choice === 'reload') {
    try {
      await loadDataset(state.file);
    } catch (err) {
      reportError('reload after stale-write', err);
    }
  }
  return false; // 'reload' and 'cancel' both abort the current save
}

// Record that the current in-memory dataset now matches disk (call right after a
// successful write — the server and folder writer both persist datasetJsonText()
// verbatim, so it is the authoritative on-disk content).
function markDiskFingerprintSaved() {
  state.loadedDiskFingerprint = contentFingerprint(datasetJsonText());
}

function exportDataset() {
  if (!state.dataset) return;
  const fileName = outputBasename(state.outputPath) || state.file || 'dataset.json';
  const blob = new Blob([datasetJsonText()], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function writeFileHandle(handle) {
  const writable = await handle.createWritable();
  await writable.write(datasetJsonText());
  await writable.close();
}

async function saveAsDataset() {
  if (!state.dataset) return;

  if (isApiMode()) {
    const suggested = outputBasename(state.outputPath) || state.file || 'new-event.json';
    const raw = window.prompt('Save As — enter filename (in data/):', suggested);
    if (!raw) return;
    const cleanName =
      String(raw)
        .trim()
        .toLowerCase()
        .replace(/\.json$/i, '')
        .replace(/[^a-z0-9-]/g, '-') + '.json';
    state.outputPath = `data/${cleanName}`;
    state.file = cleanName;
    setCurrentFilenameLabel();
    await saveViaApi();
    markDiskFingerprintSaved();
    clearPhotosBackup();
    clearLogoBackup();
    markDirty(false);
    resetSessionQuickEditState();
    resetSponsorQuickEditState();
    markSessionDirty(false);
    markSponsorDirty(false);
    capturePersistedSnapshot();
    clearRecoverySnapshot();
    showSaveToast();
    return;
  }

  if (typeof window.showSaveFilePicker !== 'function') {
    exportDataset();
    markDirty(false);
    markSessionDirty(false);
    markSponsorDirty(false);
    capturePersistedSnapshot();
    clearRecoverySnapshot();
    window.alert('File System Access API is unavailable in this browser. Exported JSON instead.');
    return;
  }

  const handle = await window.showSaveFilePicker({
    suggestedName: outputBasename(state.outputPath) || state.file || 'new-event.json',
    types: [
      {
        description: 'JSON files',
        accept: { 'application/json': ['.json'] },
      },
    ],
  });

  await writeFileHandle(handle);
  state.fileHandle = handle;
  state.file = handle.name || state.file;
  state.outputPath = replaceOutputBasename(state.outputPath || `data/${state.file}`, state.file);
  markDiskFingerprintSaved();
  await setLinkedHandle(getFileLinkKey(), handle);
  setCurrentFilenameLabel();
  markDirty(false);
  resetSessionQuickEditState();
  resetSponsorQuickEditState();
  markSessionDirty(false);
  markSponsorDirty(false);
  capturePersistedSnapshot();
  clearRecoverySnapshot();
  showSaveToast();
}

async function saveDataset() {
  if (!state.dataset) return;
  const { valid, errors } = await validateDataset(state.dataset);
  if (!valid) {
    console.error('Validation errors:', errors);
    console.error('Formatted errors:', formatValidationErrors(errors, state.dataset));
    showValidationErrorModal({
      title: "Couldn't save this dataset",
      intro: `It has ${errors.length} schema issue${errors.length === 1 ? '' : 's'} to fix before saving:`,
      errors,
    });
    return;
  }
  console.log('Dataset validation passed, saving...');
  if (isApiMode()) {
    if (!(await confirmNoStaleOverwrite())) return;
    await saveViaApi();
    markDiskFingerprintSaved();
    clearPhotosBackup();
    clearLogoBackup();
    markDirty(false);
    resetSessionQuickEditState();
    resetSponsorQuickEditState();
    markSessionDirty(false);
    markSponsorDirty(false);
    capturePersistedSnapshot();
    clearRecoverySnapshot();
    showSaveToast();
    renderAppearanceForm();
    return;
  }
  if (!state.fileHandle) {
    if (state.projectDirHandle) {
      try {
        const fromDir = await resolveFileHandleFromProjectDir(state.outputPath);
        if (fromDir) {
          state.fileHandle = fromDir;
          await setLinkedHandle(getFileLinkKey(), fromDir);
        }
      } catch {
        // no-op
      }
    }
  }
  if (!state.fileHandle) {
    window.alert(
      'No save file linked yet. Use "Open project folder" to connect your folder, or use Save As to choose a file.',
    );
    return;
  }
  if (typeof state.fileHandle.queryPermission === 'function') {
    const permission = await state.fileHandle.queryPermission({ mode: 'readwrite' });
    if (permission !== 'granted') {
      window.alert('Write permission is not available for the linked file. Use Save As to relink.');
      return;
    }
  }
  if (!(await confirmNoStaleOverwrite())) return;
  await writeFileHandle(state.fileHandle);
  markDiskFingerprintSaved();
  clearPhotosBackup();
  clearLogoBackup();
  markDirty(false);
  resetSessionQuickEditState();
  resetSponsorQuickEditState();
  markSessionDirty(false);
  markSponsorDirty(false);
  capturePersistedSnapshot();
  clearRecoverySnapshot();
  showSaveToast();
  renderAppearanceForm();
}

function promptForNewFilename() {
  const value = window.prompt('New dataset path (.json):', 'data/new-event.json');
  if (value == null) return '';
  return normalizeOutputPath(value, 'data/new-event.json');
}

async function buildSponsorEventCounts() {
  const files = eventCatalog
    .map((e) => e.file)
    .filter((f) => f && f.endsWith('.json') && f !== 'sponsors.json');
  const results = await Promise.allSettled(
    files.map((f) => {
      const url = isApiMode()
        ? `${state.apiEndpoint}/api/data/${f.split('/').map(encodeURIComponent).join('/')}`
        : `./data/${f}`;
      return fetch(url).then((r) => r.json());
    }),
  );
  const counts = new Map();
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    const sponsors = result.value?.event?.sponsors;
    if (!Array.isArray(sponsors)) continue;
    const seen = new Set(sponsors.map((s) => (s.title || '').toLowerCase().trim()).filter(Boolean));
    for (const t of seen) counts.set(t, (counts.get(t) || 0) + 1);
  }
  state.sponsorEventCounts = counts;
}

function getSponsorEventCount(title) {
  if (!state.sponsorEventCounts) return null;
  return state.sponsorEventCounts.get((title || '').toLowerCase().trim()) || 0;
}

function bustSrc(src) {
  if (!src) return src;
  const ts = state.imageCacheBust.get(src);
  return ts ? `${src}?cb=${ts}` : src;
}

function bustDatasetForPreview(dataset) {
  if (!state.imageCacheBust.size) return dataset;
  const walk = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (typeof val === 'string' && key === 'image') {
        const ts = state.imageCacheBust.get(val);
        if (ts) obj[key] = `${val}?cb=${ts}`;
      } else if (Array.isArray(val)) {
        val.forEach(walk);
      } else if (val && typeof val === 'object') {
        walk(val);
      }
    }
  };
  const clone = JSON.parse(JSON.stringify(dataset));
  walk(clone);
  return clone;
}

// ── Calendar feed: check, and import ────────────────────────────────────────
//
// Both go to the server, which runs the same Go reconciliation the weekly cron
// job runs. Nothing about the comparison happens here — this is the trigger, the
// modal, and putting the dataset back on screen afterwards.

/** POST to one of the feed routes. */
async function callFeed(route, body) {
  const res = await fetch(`${state.apiEndpoint}/api/feed/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    /* a non-JSON body is handled by the status check below */
  }
  if (!res.ok) {
    throw new Error(payload?.error || payload?.message || `Feed ${route} failed (${res.status})`);
  }
  return payload;
}

async function checkCalendarFeed() {
  if (!isApiMode()) {
    showFeedMessage(
      'The backend is not connected',
      'Checking a feed fetches it from upstream, which the browser cannot do on its own. Connect to the API to use this.',
      'hold',
    );
    return;
  }
  const docPath = datasetDocPath(state.file);
  if (!docPath) {
    showFeedMessage(
      'Save this dataset first',
      'The feed is compared against the file in the archive, and this one has not been saved there yet.',
      'hold',
    );
    return;
  }

  showFeedMessage('Reading the feed…', 'Fetching the published schedule and comparing it.');
  try {
    const result = await callFeed('check', { file: docPath });
    showFeedDiff(result, {
      file: state.file,
      // The editor always offers the whole programme. A partial import would
      // leave the dataset in a state neither side chose, and no later run could
      // tell "we rejected that" from "that is not imported yet".
      mirror: true,
      onImport: () => importCalendarFeed(),
    });
  } catch (error) {
    showFeedMessage('Could not read the feed', error.message, 'bad');
  }
}

async function importCalendarFeed() {
  try {
    const result = await callFeed('import', { file: datasetDocPath(state.file), mirror: true });
    if (!result.written) {
      showFeedMessage(
        'Nothing was written',
        result.note || 'The comparison found nothing to apply.',
        'hold',
      );
      return;
    }
    // The server has rewritten the file. Anything held in memory now describes
    // a dataset that no longer exists, so it is reloaded rather than patched —
    // and reloading is also what proves the import produced something readable.
    state.dirty = false;
    await loadDataset(state.file);
    // Shown AFTER the reload, in the frame the diff was in: the numbers land
    // where they were just read as predictions, and the panel behind them is
    // already showing the imported data.
    showFeedImported(result, { mirror: true });
  } catch (error) {
    showFeedMessage('The import failed', `${error.message} Nothing was written.`, 'bad');
  }
}

function isApiMode() {
  return Boolean(state.apiEndpoint);
}

async function saveViaApi() {
  const relativePath = state.outputPath
    ? state.outputPath.replace(/^data\//, '')
    : outputBasename(state.outputPath) || state.file;
  if (!relativePath) throw new Error('No output filename configured.');
  const apiPath = relativePath.split('/').map(encodeURIComponent).join('/');
  const res = await fetch(`${state.apiEndpoint}/api/data/${apiPath}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: datasetJsonText(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
}

async function uploadViaApi(file, relativePath) {
  const form = new FormData();
  form.append('file', file, file.name || 'upload');
  form.append('targetPath', relativePath.replace(/^\.\//, ''));
  const res = await fetch(`${state.apiEndpoint}/api/upload`, { method: 'POST', body: form });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
}

function syncApiModeUI() {
  const dot = document.getElementById('apiStatusDot');
  if (dot) {
    dot.className = `ml-2 w-2 h-2 rounded-full ${isApiMode() ? 'bg-green-500' : 'bg-gray-300'} inline-block`;
  }
  if (els.folderConnectionToggle) {
    els.folderConnectionToggle.classList.toggle('hidden', isApiMode());
  }
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/\n/g, '&#10;');
}

function renderSitemap() {
  const container = document.getElementById('sitemapContent');
  if (!container) return;

  const meta = state.dataset?.event || {};
  const items = state.dataset?.items || [];

  const rawUrl = normalizeString(meta.website || meta.scheduleURLs?.[0]);
  if (!rawUrl) {
    container.innerHTML =
      '<p class="edt-empty">No event website URL is configured. Set the <strong>Website</strong> field in the Event tab.</p>';
    return;
  }

  let parsedBase;
  try {
    parsedBase = new URL(rawUrl);
  } catch {
    // Malformed event URL → show an inline message instead of building the panel.
    container.innerHTML = `<p class="edt-empty">Could not parse event URL: ${escapeHtml(rawUrl)}</p>`;
    return;
  }
  const domain = parsedBase.hostname;

  const eventUrls = [];
  if (meta.website) eventUrls.push(meta.website);
  for (const u of meta.scheduleURLs ?? []) {
    if (u && u !== meta.website) eventUrls.push(u);
  }

  const sessionEntries = [];
  const seen = new Set(eventUrls);
  items.forEach((item) => {
    const link = normalizeString(item?.link);
    if (!link || seen.has(link)) return;
    try {
      if (new URL(link).hostname === domain) {
        seen.add(link);
        sessionEntries.push({ title: normalizeString(item?.title) || '(Untitled)', url: link });
      }
    } catch {
      /* skip session links that aren't valid URLs */
    }
  });

  const sponsorEntries = [];
  (meta.sponsors || []).forEach((sponsor) => {
    const link = normalizeString(sponsor?.link);
    if (!link || seen.has(link)) return;
    try {
      if (new URL(link).hostname === domain) {
        seen.add(link);
        sponsorEntries.push({
          title: normalizeString(sponsor?.title) || '(Untitled sponsor)',
          url: link,
        });
      }
    } catch {
      /* skip sponsor links that aren't valid URLs */
    }
  });

  // The registered sources on this domain that no other section already lists.
  // `other_urls` used to fill this slot; it is now drained into the registry, so
  // the map reads from the register rather than from the grab bag it replaced.
  const sourceEntries = [];
  for (const source of meta.sources ?? []) {
    const url = normalizeString(source?.url);
    if (!url || seen.has(url)) continue;
    try {
      if (new URL(url).hostname !== domain) continue;
    } catch {
      continue;
    }
    seen.add(url);
    sourceEntries.push({ title: source.kind ?? 'source', url });
  }
  // Anything still sitting in the legacy field, so a half-filed dataset does not
  // silently drop URLs out of the map.
  const otherUrls = normalizeUrlArray(meta.other_urls).filter((u) => u && !seen.has(u));

  const total =
    eventUrls.length +
    sessionEntries.length +
    sponsorEntries.length +
    sourceEntries.length +
    otherUrls.length;
  const allUrls = [
    ...eventUrls,
    ...sessionEntries.map((e) => e.url),
    ...sponsorEntries.map((e) => e.url),
    ...sourceEntries.map((e) => e.url),
    ...otherUrls,
  ].join('\n');

  function urlRow(url, label = '') {
    const display = url.replace(/^https?:\/\//, '');
    return `<li class="sitemap-url-item">
      ${label ? `<span class="sitemap-item-label">${escapeHtml(label)}</span>` : ''}
      <a class="sitemap-item-url" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(display)}</a>
    </li>`;
  }

  container.innerHTML = `
    <div class="sitemap-toolbar">
      <span class="sitemap-domain">${escapeHtml(domain)}</span>
      <span class="sitemap-total">${total} URL${total !== 1 ? 's' : ''}</span>
      <button id="sitemapCopyAll" type="button" class="sitemap-copy-btn">
        Copy all
      </button>
    </div>
    ${
      eventUrls.length
        ? `
      <section class="sitemap-section">
        <h3 class="sitemap-section-heading">Event pages <span class="sitemap-count-badge">${eventUrls.length}</span></h3>
        <ul class="sitemap-url-list">${eventUrls.map((u) => urlRow(u)).join('')}</ul>
      </section>`
        : ''
    }
    ${
      sessionEntries.length
        ? `
      <section class="sitemap-section">
        <h3 class="sitemap-section-heading">Sessions <span class="sitemap-count-badge">${sessionEntries.length}</span></h3>
        <ul class="sitemap-url-list">${sessionEntries.map((e) => urlRow(e.url, e.title)).join('')}</ul>
      </section>`
        : ''
    }
    ${
      sponsorEntries.length
        ? `
      <section class="sitemap-section">
        <h3 class="sitemap-section-heading">Sponsors <span class="sitemap-count-badge">${sponsorEntries.length}</span></h3>
        <ul class="sitemap-url-list">${sponsorEntries.map((e) => urlRow(e.url, e.title)).join('')}</ul>
      </section>`
        : ''
    }
    ${
      sourceEntries.length
        ? `
      <section class="sitemap-section">
        <h3 class="sitemap-section-heading">Sources <span class="sitemap-count-badge">${sourceEntries.length}</span></h3>
        <ul class="sitemap-url-list">${sourceEntries.map((e) => urlRow(e.url, e.title)).join('')}</ul>
      </section>`
        : ''
    }
    ${
      otherUrls.length
        ? `
      <section class="sitemap-section">
        <h3 class="sitemap-section-heading">Not yet filed <span class="sitemap-count-badge">${otherUrls.length}</span></h3>
        <ul class="sitemap-url-list">${otherUrls.map((u) => urlRow(u)).join('')}</ul>
      </section>`
        : ''
    }
    ${total === 0 ? '<p class="edt-empty">No URLs found for this domain in the dataset.</p>' : ''}
  `;

  document.getElementById('sitemapCopyAll')?.addEventListener('click', () => {
    navigator.clipboard.writeText(allUrls).then(() => {
      const btn = document.getElementById('sitemapCopyAll');
      if (btn) {
        btn.textContent = 'Copied!';
        setTimeout(() => {
          btn.innerHTML = 'Copy all';
        }, 1800);
      }
    });
  });
}

function doPreview(mode = 'tab') {
  if (!state.dataset) return;
  if (!writeJson(STORAGE_KEYS.preview, bustDatasetForPreview(state.dataset))) {
    window.alert('Could not open preview: browser storage is full or unavailable.');
    return;
  }
  if (mode === 'same') {
    if (state.file) writeText(STORAGE_KEYS.editorReturnFile, state.file);
    window.location.assign('./index.html?preview=1');
  } else {
    window.open('./index.html?preview=1', '_blank');
  }
}

function bindEvents() {
  bindDatasetToolbar();
  bindApiSettings();
  bindPreviewAndSave();
  bindSessionSponsorActions();
  bindWorkspaceToggles();
  bindEditorTabs();
  bindPickerModals();
  bindHistoryAndGlobalKeys();
}

function bindDatasetToolbar() {
  els.datasetSelect.addEventListener('change', async () => {
    const nextFile = normalizeString(els.datasetSelect.value);
    const previousValue = state.lastDatasetSelectValue || '';

    if (!nextFile) {
      els.datasetSelect.value = previousValue;
      return;
    }
    if (nextFile === previousValue) {
      return;
    }

    if (!(await confirmDiscardPendingChanges(`dataset ${nextFile}`))) {
      els.datasetSelect.value = previousValue;
      return;
    }

    try {
      await loadDataset(nextFile);
    } catch (error) {
      els.datasetSelect.value = previousValue;
      window.alert(`Could not load dataset: ${error.message}`);
    }
  });

  els.newDataset.addEventListener('click', async () => {
    if (!(await confirmDiscardPendingChanges('a new dataset'))) return;
    const pathValue = promptForNewFilename();
    if (!pathValue) return;
    createDatasetScaffold(pathValue);
  });

  document.getElementById('editorHomeBtn')?.addEventListener('click', closeCurrentDataset);
  document.getElementById('editorBackBtn')?.addEventListener('click', closeCurrentDataset);
}

function bindApiSettings() {
  const apiSettingsModal = document.getElementById('apiSettingsModal');
  const closeApiSettingsBtn = document.getElementById('closeApiSettings');
  const apiEndpointInput = document.getElementById('apiEndpointInput');
  const apiTestBtn = document.getElementById('apiTestBtn');
  const apiSaveBtn = document.getElementById('apiSaveBtn');
  const apiClearBtn = document.getElementById('apiClearBtn');
  const apiTestResult = document.getElementById('apiTestResult');

  if (apiSettingsModal) {
    const closeApiModal = () => {
      apiSettingsModal.classList.add('hidden');
      apiSettingsModal.setAttribute('aria-hidden', 'true');
    };

    if (closeApiSettingsBtn) closeApiSettingsBtn.addEventListener('click', closeApiModal);
    apiSettingsModal.addEventListener('click', (e) => {
      if (e.target === apiSettingsModal) closeApiModal();
    });

    async function checkApiCompatibility(endpoint, resultEl) {
      resultEl.classList.remove('hidden');
      resultEl.textContent = 'Testing…';
      resultEl.className = 'text-sm text-gray-500';
      try {
        const res = await fetch(`${endpoint}/api/health`);
        if (res.ok) {
          const data = await res.json().catch(() => null);
          if (data?.app === 'conference-planner-api') {
            resultEl.textContent = 'Connected — compatible API detected.';
            resultEl.className = 'text-sm text-green-600';
            return true;
          }
          resultEl.textContent =
            'Server responded but does not appear to be a compatible API. Check the endpoint URL.';
          resultEl.className = 'text-sm text-yellow-600';
          return false;
        }
        resultEl.textContent = `Server responded with HTTP ${res.status}.`;
        resultEl.className = 'text-sm text-red-600';
        return false;
      } catch (e) {
        resultEl.textContent = `Could not connect: ${e.message}`;
        resultEl.className = 'text-sm text-red-600';
        return false;
      }
    }

    if (apiTestBtn && apiEndpointInput && apiTestResult) {
      apiTestBtn.addEventListener('click', async () => {
        const endpoint = apiEndpointInput.value.trim().replace(/\/$/, '');
        if (!endpoint) {
          apiTestResult.textContent = 'Enter an endpoint URL first.';
          apiTestResult.className = 'text-sm text-yellow-600';
          return;
        }
        apiTestBtn.disabled = true;
        await checkApiCompatibility(endpoint, apiTestResult);
        apiTestBtn.disabled = false;
      });
    }

    if (apiSaveBtn && apiEndpointInput) {
      apiSaveBtn.addEventListener('click', async () => {
        const endpoint = apiEndpointInput.value.trim().replace(/\/$/, '');
        if (endpoint) {
          apiSaveBtn.disabled = true;
          const ok = await checkApiCompatibility(endpoint, apiTestResult);
          apiSaveBtn.disabled = false;
          if (!ok) return;
        }
        closeApiModal();
        await connectEditorApi(endpoint);
      });
    }

    if (apiClearBtn) {
      apiClearBtn.addEventListener('click', () => {
        if (apiEndpointInput) apiEndpointInput.value = '';
        state.apiEndpoint = '';
        removeKey(STORAGE_KEYS.editorApiEndpoint);
        syncApiModeUI();
        setFolderConnectionButtonState();
        closeApiModal();
        if (!state.dataset) {
          renderDatasetOptionsFromConnectedFolder().then(() => {
            setDatasetLoadingEnabled(!!(state.projectDirHandle && state.folderConnectedInSession));
            syncWelcomePanel();
          });
        }
      });
    }
  }
}

function bindPreviewAndSave() {
  if (els.previewDataset) {
    els.previewDataset.addEventListener('click', () => doPreview('tab'));
  }

  if (els.previewDatasetToggle && els.previewDatasetDropdown) {
    els.previewDatasetToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = !els.previewDatasetDropdown.classList.contains('hidden');
      els.previewDatasetDropdown.classList.toggle('hidden', open);
      els.previewDatasetToggle.setAttribute('aria-expanded', String(!open));
    });

    els.previewDatasetDropdown.addEventListener('click', (e) => {
      const item = e.target.closest('[data-preview-mode]');
      if (!item) return;
      els.previewDatasetDropdown.classList.add('hidden');
      els.previewDatasetToggle.setAttribute('aria-expanded', 'false');
      doPreview(item.dataset.previewMode);
    });

    document.addEventListener('click', () => {
      els.previewDatasetDropdown.classList.add('hidden');
      els.previewDatasetToggle.setAttribute('aria-expanded', 'false');
    });
  }

  if (els.saveDatasetToggle && els.saveDatasetDropdown) {
    els.saveDatasetToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = !els.saveDatasetDropdown.classList.contains('hidden');
      els.saveDatasetDropdown.classList.toggle('hidden', open);
      els.saveDatasetToggle.setAttribute('aria-expanded', String(!open));
    });

    document.addEventListener('click', () => {
      els.saveDatasetDropdown.classList.add('hidden');
      if (els.saveDatasetToggle) els.saveDatasetToggle.setAttribute('aria-expanded', 'false');
    });
  }

  els.saveDataset.addEventListener('click', async () => {
    try {
      await saveDataset();
    } catch (error) {
      window.alert(`Save failed: ${error.message}`);
    }
  });

  if (els.saveAsDataset) {
    els.saveAsDataset.addEventListener('click', async () => {
      if (els.saveDatasetDropdown) {
        els.saveDatasetDropdown.classList.add('hidden');
        if (els.saveDatasetToggle) els.saveDatasetToggle.setAttribute('aria-expanded', 'false');
      }
      try {
        await saveAsDataset();
      } catch (error) {
        if (error && error.name === 'AbortError') return;
        window.alert(`Save As failed: ${error.message}`);
      }
    });
  }
}

function bindSessionSponsorActions() {
  if (els.exportDataset) {
    els.exportDataset.addEventListener('click', exportDataset);
  }
  if (els.saveSession) {
    els.saveSession.addEventListener('click', async () => {
      try {
        await saveCurrentSession();
      } catch (error) {
        window.alert(`Save failed: ${error.message}`);
      }
    });
  }
  if (els.saveSponsor) {
    els.saveSponsor.addEventListener('click', async () => {
      try {
        await saveCurrentSponsor();
      } catch (error) {
        window.alert(`Save failed: ${error.message}`);
      }
    });
  }
  els.addSession.addEventListener('click', async () => {
    try {
      await addSession();
    } catch (error) {
      window.alert(`Add session failed: ${error.message}`);
    }
  });
  els.deleteSession.addEventListener('click', async () => {
    try {
      await deleteSession();
    } catch (error) {
      window.alert(`Delete session failed: ${error.message}`);
    }
  });
  els.addSponsor.addEventListener('click', async () => {
    try {
      await addSponsor();
    } catch (error) {
      window.alert(`Add sponsor failed: ${error.message}`);
    }
  });
  els.deleteSponsor.addEventListener('click', async () => {
    try {
      await deleteSponsor();
    } catch (error) {
      window.alert(`Delete sponsor failed: ${error.message}`);
    }
  });
  if (els.sessionSearchInput) {
    els.sessionSearchInput.addEventListener('input', () => {
      state.sessionSearchQuery = String(els.sessionSearchInput.value || '');
      renderSessionList();
    });
  }
}

function bindWorkspaceToggles() {
  if (els.toggleEventMeta && els.eventMetaBody) {
    els.toggleEventMeta.addEventListener('click', () => {
      const isCollapsed = els.eventMetaBody.classList.contains('hidden');
      setEventMetaCollapsed(!isCollapsed);
    });
  }

  if (els.toggleSessionWorkspace) {
    els.toggleSessionWorkspace.addEventListener('click', () => {
      setSessionWorkspaceExpanded(!state.sessionListExpanded);
      renderSessionList();
      renderSessionForm();
      syncSessionSaveButton();
      els.deleteSession.disabled = state.selectedIndex < 0;
    });
  }

  if (els.toggleQuickSessionEdit) {
    els.toggleQuickSessionEdit.addEventListener('click', () => {
      if (!state.sessionListExpanded || !isSessionEditorEnabled()) return;
      setQuickSessionEditEnabled(!state.sessionQuickEditEnabled);
      renderSessionList();
    });
  }

  if (els.toggleSponsorWorkspace) {
    els.toggleSponsorWorkspace.addEventListener('click', () => {
      setSponsorWorkspaceExpanded(!state.sponsorListExpanded);
      renderSponsorList();
      renderSponsorForm();
      syncSponsorSaveButton();
      els.deleteSponsor.disabled = state.selectedSponsorIndex < 0;
    });
  }

  if (els.toggleQuickSponsorEdit) {
    els.toggleQuickSponsorEdit.addEventListener('click', () => {
      if (!state.sponsorListExpanded || !isSponsorEditorEnabled()) return;
      setQuickSponsorEditEnabled(!state.sponsorQuickEditEnabled);
      renderSponsorList();
    });
  }
}

function bindEditorTabs() {
  if (els.showEventTab) {
    els.showEventTab.addEventListener('click', async () => {
      switchEditorTab('event');
    });
  }

  if (els.showSessionsTab) {
    els.showSessionsTab.addEventListener('click', async () => {
      switchEditorTab('sessions');
    });
  }

  if (els.showLogoTab) {
    els.showLogoTab.addEventListener('click', async () => {
      switchEditorTab('logo');
    });
  }

  if (els.showFlickrTab) {
    els.showFlickrTab.addEventListener('click', async () => {
      switchEditorTab('flickr');
    });
  }

  if (els.showSponsorsTab) {
    els.showSponsorsTab.addEventListener('click', async () => {
      switchEditorTab('sponsors');
    });
  }

  if (els.showPeopleTab) {
    els.showPeopleTab.addEventListener('click', () => {
      switchEditorTab('people');
    });
  }

  if (els.showRelatedTab) {
    els.showRelatedTab.addEventListener('click', () => {
      switchEditorTab('related');
    });
  }

  if (els.sponsorLogosDisabledToggle) {
    els.sponsorLogosDisabledToggle.addEventListener('change', () => {
      if (!state.dataset?.event) return;
      state.dataset.event.sponsorLogosDisabled = els.sponsorLogosDisabledToggle.checked;
      markDirty(true);
    });
  }

  if (els.showSitemapTab) {
    els.showSitemapTab.addEventListener('click', async () => {
      switchEditorTab('sitemap');
    });
  }

  if (els.showSessionDetailsSubTab) {
    els.showSessionDetailsSubTab.addEventListener('click', () => switchEditorTab('sessions'));
  }

  if (els.showSessionTimelineSubTab) {
    els.showSessionTimelineSubTab.addEventListener('click', () => switchEditorTab('timeline'));
  }

  if (els.showAppearanceTab) {
    els.showAppearanceTab.addEventListener('click', () => {
      switchEditorTab('appearance');
    });
  }
}

function bindPickerModals() {
  if (els.closeSponsorSessionPicker) {
    els.closeSponsorSessionPicker.addEventListener('click', closeSponsorSessionPicker);
  }

  if (els.closeSponsorSessionPickerBack) {
    els.closeSponsorSessionPickerBack.addEventListener('click', closeSponsorSessionPicker);
  }

  if (els.sponsorSessionPickerModal) {
    els.sponsorSessionPickerModal.addEventListener('click', (event) => {
      if (event.target === els.sponsorSessionPickerModal) {
        closeSponsorSessionPicker();
      }
    });
    els.sponsorSessionPickerModal.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeSponsorSessionPicker();
      }
    });
  }

  if (els.closeSessionSponsorPicker) {
    els.closeSessionSponsorPicker.addEventListener('click', closeSessionSponsorPicker);
  }

  if (els.closeSessionSponsorPickerBack) {
    els.closeSessionSponsorPickerBack.addEventListener('click', closeSessionSponsorPicker);
  }

  if (els.sessionSponsorPickerModal) {
    els.sessionSponsorPickerModal.addEventListener('click', (event) => {
      if (event.target === els.sessionSponsorPickerModal) {
        closeSessionSponsorPicker();
      }
    });
    els.sessionSponsorPickerModal.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeSessionSponsorPicker();
      }
    });
  }
}

function bindHistoryAndGlobalKeys() {
  if (els.undoAction) {
    els.undoAction.addEventListener('click', async () => {
      await performUndo();
    });
  }

  if (els.revertDataset) {
    els.revertDataset.addEventListener('click', async () => {
      if (!state.persistedSnapshot) return;
      const okay = window.confirm('Revert all unsaved changes and restore the last saved version?');
      if (!okay) return;
      await restorePersistedSnapshot();
    });
  }

  document.addEventListener('keydown', async (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 's') {
      event.preventDefault();
      try {
        await saveDataset();
      } catch (e) {
        window.alert(e?.message || String(e));
      }
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'z' && !event.shiftKey) {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      event.preventDefault();
      await performUndo();
    }
  });

  window.addEventListener('beforeunload', (event) => {
    if (!state.dirty || !state.dataset) return;
    saveRecoverySnapshot();
    event.preventDefault();
    event.returnValue = '';
  });
}

function _mapApiSearchRecords(records) {
  return records
    .filter((r) => isEditorDatasetFile(r.file))
    .map((r) => ({
      file: r.file,
      category: r.designation || 'Other',
      designation: r.designation,
      location: r.location,
      year: r.year,
      region: r.region,
      venue: r.venue,
      label: r.label,
      enabled: r.enabled,
    }))
    .sort((a, b) => {
      const ya = Number.parseInt(a.year, 10);
      const yb = Number.parseInt(b.year, 10);
      if (Number.isFinite(ya) && Number.isFinite(yb) && ya !== yb) return yb - ya;
      return a.label.localeCompare(b.label);
    });
}

async function buildApiSearchCatalog() {
  try {
    if (isApiMode()) {
      // Single request returns metadata for all files — no items arrays transferred.
      const res = await fetch(`${state.apiEndpoint}/api/meta`);
      if (!res.ok) return [];
      const metas = await res.json();
      if (!Array.isArray(metas) || metas.length === 0) return [];
      return metas
        .filter((m) => m && isEditorDatasetFile(m.file))
        .map((m) => ({
          file: m.file,
          category: m.designation || 'Other',
          designation: m.designation,
          location: m.location,
          year: m.year,
          region: m.region,
          venue: m.venue,
          label: buildDatasetOptionLabel(m.file, m, getManifestLabelByFile(m.file)),
          enabled: m.enabled,
        }))
        .sort((a, b) => {
          const ya = Number.parseInt(a.year, 10);
          const yb = Number.parseInt(b.year, 10);
          if (Number.isFinite(ya) && Number.isFinite(yb) && ya !== yb) return yb - ya;
          return a.label.localeCompare(b.label);
        });
    }

    // Non-API mode (no folder connected): fetch the consolidated catalog and
    // individual metadata via static URLs.
    // (handles the case where loadEventCatalog() failed or was memoized before the server was reachable)
    const res = await fetch('./data/catalog.json');
    if (!res.ok) return [];
    const payload = await res.json();
    const files = (Array.isArray(payload?.events) ? payload.events : [])
      .map((e) => (typeof e === 'string' ? e : e?.file))
      .filter((f) => f && isEditorDatasetFile(f));
    if (files.length === 0) return [];
    const records = await loadDatasetMetaForGroupingViaFetch(files);
    return _mapApiSearchRecords(records);
  } catch {
    // API unreachable or bad payload → empty search catalog.
    return [];
  }
}

async function buildConnectedFolderSearchCatalog() {
  const files = await listDatasetFilesFromConnectedFolder();
  const dataDir = await getDataDirectoryHandle(false);
  if (!dataDir || files.length === 0) return [];

  const entries = await Promise.all(
    files.map(async (file) => {
      try {
        const handle = await dataDir.getFileHandle(file);
        const blob = await handle.getFile();
        const text = await blob.text();
        const parsed = JSON.parse(text);
        const meta = parsed?.event || {};
        const designation = normalizeString(meta.designation);
        const year = normalizeString(meta.year);
        const location = normalizeString(meta.location);
        const label =
          designation && year && location
            ? `${designation} ${year}: ${location}`
            : [designation, year, location].filter(Boolean).join(' ') ||
              file.replace(/\.json$/i, '');
        return {
          file,
          category: designation || 'Other',
          designation,
          location,
          year,
          region: normalizeString(meta.region),
          venue: normalizeString(meta.venue),
          label,
          enabled: meta.enabled !== false,
        };
      } catch {
        // Skip a dataset file that can't be read or parsed.
        return null;
      }
    }),
  );

  return entries.filter(Boolean).sort((a, b) => {
    const ya = Number.parseInt(a.year, 10);
    const yb = Number.parseInt(b.year, 10);
    if (Number.isFinite(ya) && Number.isFinite(yb) && ya !== yb) return yb - ya;
    return a.label.localeCompare(b.label);
  });
}

async function refreshEditorSearch() {
  const hasFolder = state.projectDirHandle && state.folderConnectedInSession;

  try {
    const searchableEvents = hasFolder
      ? await buildConnectedFolderSearchCatalog()
      : await buildApiSearchCatalog();

    configureEventSearch({
      getEvents: () => searchableEvents,
      onSelect: async (_category, file) => {
        if (!state.dataset || (await confirmDiscardPendingChanges(`dataset ${file}`))) {
          try {
            els.datasetSelect.value = file;
            await loadDataset(file);
          } catch (error) {
            els.datasetSelect.value = state.lastDatasetSelectValue || '';
            window.alert(`Could not load dataset: ${error.message}`);
          }
        }
      },
    });
  } catch (e) {
    console.error('[refreshEditorSearch]', e);
    configureEventSearch({ getEvents: () => [], onSelect: async () => {} });
  }

  // Always enable the search button so users can quickly access the search modal
  if (els.editorSearchEvents) els.editorSearchEvents.disabled = false;
}

function revealPage() {
  document.documentElement.style.opacity = '1';
}

async function init() {
  // Capture what the URL asked for before the default 'event' tab overwrites it.
  // `?tab=` is still read, so links minted before the path form keep working.
  const route = parseEditorPath(location.pathname, EDITOR_TABS, location.search);
  _initialDatasetFile = route.file;
  _initialEditorTab = route.tab || new URLSearchParams(location.search).get('tab');
  initEditorS3({ apiBase: () => state.apiEndpoint });
  initEditorRelatedEvents({ state, markDirty, uploadImage: uploadRelatedImage });
  wireRelatedEventsPanel();
  wirePeopleTab();
  wirePersonModal();
  // Filing a stray URL moves it out of an event field, so the meta form and the
  // URL map both stop being true the moment it happens.
  initSources({
    state,
    markDirty,
    escapeHtml,
    escapeAttr,
    onChange: () => {
      renderSitemap();
      renderSponsorSourceField();
    },
    onCheckFeed: checkCalendarFeed,
  });
  initFeedModal({
    escapeHtml,
    escapeAttr,
    // The modal warns before an import when there are edits open, because the
    // server writes the file underneath them.
    isDirty: () => Boolean(state.dirty),
  });
  initEditorSponsors({
    state,
    els,
    SPONSOR_FIELDS,
    getEventTimezone,
    markDirty,
    markSessionDirty,
    markSponsorDirty,
    trackQuickSessionChange,
    trackQuickSponsorChange,
    undoPush,
    renderSessionForm,
    selectSponsorForm,
    isQuickSponsorEditEnabled,
    syncSponsorSaveButton,
    syncSponsorEditorPanelVisibility,
    buildSponsorEventCounts,
    getSponsorEventCount,
    uploadSponsorImageFromPicker,
    bustSrc,
    escapeAttr,
    toStringValue,
    fieldDescriptionAttr,
    renderFieldIntro,
    moveTrackedIndex,
    removeTrackedIndex,
    scrollToSponsorRow,
    saveDataset,
  });
  initEditorSessions({
    state,
    els,
    SESSION_FIELDS,
    getEventTimezone,
    formatDateHeading,
    isQuickSessionEditEnabled,
    escapeAttr,
    toStringValue,
    getSessionTimingSummary,
    selectSessionForm,
    undoPush,
    moveTrackedIndex,
    markDirty,
    markSessionDirty,
    trackQuickSessionChange,
    syncSessionEditorPanelVisibility,
    syncSessionSaveButton,
    renderFieldIntro,
    fieldDescriptionAttr,
    fieldDescriptionId,
    markdownToHtml,
    scrollToSessionRow,
    saveDataset,
    removeTrackedIndex,
    trackQuickSponsorChange,
    cloneJsonValue,
  });
  await loadThemes();
  applyThemeClass(getCurrentThemeId());

  eventCatalog = await loadEventCatalog().catch(() => []);
  buildTimezoneList();
  if (els.editorSearchEvents) {
    els.editorSearchEvents.addEventListener('click', openEventSearchModal);
  }
  // In API mode, populate select from catalog and enable loading immediately.
  // In FS mode, require explicit "Connect Folder" each session.
  await renderDatasetOptionsFromConnectedFolder();
  setDatasetLoadingEnabled(isApiMode());
  syncApiModeUI();
  await refreshEditorSearch();
  bindEvents();
  markDirty(false);
  resetSessionQuickEditState();
  resetSponsorQuickEditState();
  markSessionDirty(false);
  markSponsorDirty(false);
  setCurrentFilenameLabel();
  setEditorButtonsEnabled(false);
  setEventMetaCollapsed(false);
  setSessionWorkspaceExpanded(false);
  setSponsorWorkspaceExpanded(false);
  setActiveEditorTab('event');
  setFolderConnectionButtonState();
  if (els.logoForm) {
    els.logoForm.innerHTML = '<p class="edt-muted">Open a project folder to get started.</p>';
  }
  if (els.flickrForm) {
    els.flickrForm.innerHTML = '<p class="edt-muted">Open a project folder to get started.</p>';
  }
  els.sponsorList.innerHTML = '<li class="edt-empty">Open a project folder to get started.</li>';
  els.sponsorForm.innerHTML = '<p class="edt-muted">Select a sponsor row to edit it.</p>';

  // A URL that names a dataset opens it. Only in API mode: the filesystem mode
  // has no read permission until someone picks a folder in this session, so the
  // link cannot honour itself and the welcome panel asks for the folder instead —
  // the request is not lost, it is waiting on a gesture the browser requires.
  if (_initialDatasetFile && isApiMode()) {
    const wanted = _initialDatasetFile;
    _initialDatasetFile = ''; // the request has been made; the URL is ours again
    try {
      els.datasetSelect.value = wanted;
      state.lastDatasetSelectValue = wanted;
      await loadDataset(wanted);
    } catch (e) {
      // A stale or renamed link must not strand you on a dead editor: say so,
      // leave the welcome panel up, and put the URL back to a plain /editor.
      reportError('editor route', e, {
        toast: true,
        message: `Could not open ${wanted} — pick an event to get started.`,
      });
      els.datasetSelect.value = '';
      state.lastDatasetSelectValue = '';
      writeEditorUrl();
    }
  }

  const pendingRecovery = loadRecoverySnapshot();
  if (pendingRecovery) showRecoveryBar(pendingRecovery);

  setInterval(() => {
    if (state.dirty && state.dataset) saveRecoverySnapshot();
  }, 30_000);

  syncWelcomePanel();
}

// The page starts at `opacity: 0` so it can fade in once built. That means a
// throw anywhere in `init()` used to leave a permanently BLANK page with
// nothing in the console but the original error — which is exactly what a stale
// module import produced. Revealing in a `finally` turns a silent blank into a
// visible, reportable failure.
initThemePicker();
initAppMenu({ adopt: ['.app-nav'] });
void init()
  .catch((err) =>
    reportError('editor init', err, {
      toast: true,
      message: 'The editor failed to start. Check the console for details.',
    }),
  )
  .finally(revealPage);
