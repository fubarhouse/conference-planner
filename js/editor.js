import { loadEventCatalog } from './modules/eventCatalog.js';
import { formatTextBlock } from './modules/markdown.js';
import { isLocalhost, slugify } from './modules/utils.js';
import { configureEventSearch, openEventSearchModal } from './modules/eventSearch.js';
import { renderTimeline } from './modules/timeline.js';
import { validateDataset, formatValidationErrors } from './modules/validator.js';
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

const state = {
  dataset: null,
  file: '',
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
  quickEditSessionChanges: new Set(),
  quickEditSponsorChanges: new Set(),
  sessionStructureDirty: false,
  sponsorStructureDirty: false,
  timezones: [],
  sponsorSessionPickerOpen: false,
  sessionSponsorPickerOpen: false,
  imageCacheBust: new Map(),
  sponsorEventCounts: null,
  apiEndpoint: localStorage.getItem('editorApiEndpoint') || ''
};


const UNDO_STACK = [];
const UNDO_LIMIT = 50;
const RECOVERY_KEY = '__editor_recovery__';
const PHOTOS_BACKUP_KEY = '__photos_prev__';
const LOGO_BACKUP_KEY = '__logo_prev__';
const RECOVERY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const FILE_LINK_DB = 'dataset-editor-file-links';
const FILE_LINK_STORE = 'links';
const DIR_HANDLE_KEY = '__project_dir_handle__';
const EVENT_META_FIELDS = [
  'id',
  'name',
  'designation',
  'year',
  'location',
  'region',
  'venue',
  'website',
  'scheduleURLs',
  'other_urls',
  'startDate',
  'endDate',
  'logo',
  'flickr',
  'timezone',
  'columns',
  'enabled'
];
const EVENT_META_FIELD_CONFIG = {
  designation: {
    label: 'Event series',
    description: 'The public event family name, such as DrupalSouth, DrupalCon, or DrupalGov.'
  },
  year: {
    label: 'Event year',
    description: 'The calendar year used for sorting, grouping, and display.'
  },
  location: {
    label: 'Host city',
    description: 'The city or primary location shown in the event picker.'
  },
  region: {
    label: 'Country or region',
    description: 'The broader region used for context and filtering, such as Australia or New Zealand.'
  },
  venue: {
    label: 'Venue',
    description: 'The main venue name shown in the event details.'
  },
  website: {
    label: 'Event website',
    description: 'The official event website URL.'
  },
  scheduleURLs: {
    label: 'Schedule URLs',
    description: 'One or more source schedule URLs used when this dataset was created or checked.'
  },
  other_urls: {
    label: 'Other URLs',
    description: 'Additional URLs associated with this event. These are only shown in the sitemap.'
  },
  logo: {
    label: 'Event logo',
    description: 'Upload and store the exact logo used in the public schedule header for this event.'
  },
  timezone: {
    label: 'Event time zone',
    description: 'The local time zone for session editing. Session times are saved as UTC.'
  },
  columns: {
    label: 'Schedule columns',
    description: 'The preferred number of columns for the public schedule layout.'
  },
  startDate: {
    label: 'Conference start date',
    description: 'First day of the event. Populates the timeline day tabs even when no sessions are scheduled yet.'
  },
  endDate: {
    label: 'Conference end date',
    description: 'Last day of the event. All dates between start and end appear as timeline days.'
  },
  enabled: {
    label: 'Show this event',
    description: 'Controls whether this dataset is available in the public planner.'
  }
};
const FLICKR_FIELD_CONFIG = {
  enabled: {
    label: 'Show photos block',
    description: 'Displays the photo callout on the public event page when a URL is provided.'
  },
  provider: {
    label: 'Photo provider',
    description: 'Name of the photo platform shown in the callout (e.g. Flickr, Google Photos, SmugMug).'
  },
  groupUrl: {
    label: 'Photos URL',
    description: 'The public link to the photo album, group, or gallery used by the call-to-action button.'
  },
  image: {
    label: 'Promo image path',
    description: 'A relative path to the square promo image shown beside the photos block text.'
  },
  imageAlt: {
    label: 'Image alternative text',
    description: 'A short description of the promo image for screen readers.'
  }
};
const LOGO_FIELD_CONFIG = {
  image: {
    label: 'Logo image path',
    description: 'A relative path to the logo shown in the public schedule header.'
  },
  imageAlt: {
    label: 'Logo alternative text',
    description: 'A short description of the logo for screen readers.'
  },
  usePlate: {
    label: 'Use background plate',
    description: 'Enable a soft white plate behind the logo for images without transparency.'
  }
};
const SPONSOR_FIELDS = [
  { key: 'title', label: 'Sponsor title', description: 'Public sponsor name used in the editor and rendered placements.', type: 'text', span: 2 },
  { key: 'subtitle', label: 'Subtitle text', description: 'Optional display name shown on the schedule instead of the company name. Falls back to the sponsor title if blank.', type: 'text', span: 2 },
  { key: 'id', label: 'Sponsor ID', description: 'Stable identifier used by sessions to reference this sponsor.', type: 'text' },
  { key: 'tier', label: 'Tier', description: 'Grouping label such as Platinum, Gold, Silver, or Partner.', type: 'text' },
  { key: 'row', label: 'Display row', description: 'Which row this sponsor appears in. Lower numbers appear first.', type: 'number' },
  { key: 'priority', label: 'Display order', description: 'Position within the row. Lower numbers appear earlier.', type: 'number' },
  { key: 'link', label: 'Sponsor URL', description: 'Optional external link for the sponsor logo or card.', type: 'text', span: 2 },
  { key: 'image', label: 'Image path', description: 'Relative path to the uploaded sponsor image asset.', type: 'text', span: 2 },
  { key: 'imageAlt', label: 'Image alternative text', description: 'Short accessible description for the sponsor image.', type: 'text', span: 2 },
  { key: 'bgStyle', label: 'Logo background', description: 'How the logo image background is treated. Use "light-plate" or "dark-plate" if the logo has no transparent background.', type: 'select', options: ['auto', 'transparent', 'light-plate', 'dark-plate', 'brand-fill'] },
  { key: 'aspect', label: 'Image shape', description: 'The aspect ratio of the logo. Helps ensure it displays at the right size and proportions.', type: 'select', options: ['auto', 'square', 'landscape', 'banner'] },
  { key: 'enabled', label: 'Show sponsor', description: 'Controls whether this sponsor is available for rendering and session association.', type: 'checkbox' }
];
const SESSION_FIELDS = [
  { key: 'title', label: 'Session title', description: 'The public title shown on schedule cards and detail views.', type: 'text', span: 2 },
  { key: 'startTime', label: 'Start time', description: 'Enter the session start time in the event\'s local timezone.', type: 'datetime-local' },
  { key: 'endTime', label: 'End time', description: 'Enter the session end time in the event\'s local timezone.', type: 'datetime-local' },
  { key: 'location', label: 'Room or location', description: 'The room, stage, or location for this session.', type: 'text' },
  { key: 'duration', label: 'Session duration', description: 'Calculated automatically from the start and end time.', type: 'text' },
  { key: 'track', label: 'Track or topic', description: 'Use commas to separate multiple tracks or topics.', type: 'text' },
  { key: 'speakers', label: 'Speaker names', description: 'Use commas or new lines to separate multiple speakers.', type: 'textarea', span: 2 },
  { key: 'full_description', label: 'Session description', description: 'The full public description. Markdown formatting is supported.', type: 'textarea', span: 2 },
  { key: 'sponsorIds', label: 'Sponsors', description: 'Sponsors associated with this session.', type: 'sponsors', span: 2 },
  { key: 'link', label: 'Session page URL', description: 'The original or canonical web page for this session.', type: 'text', span: 2 },
  { key: 'video_url', label: 'Video URL', description: 'Optional recording URL shown with the session details.', type: 'text', span: 2 }
];

const dtfCache = new Map();
let fileLinkDbPromise = null;
let eventCatalog = [];

const els = {
  blocked: document.getElementById('editorBlocked'),
  app: document.getElementById('editorApp'),
  welcome: document.getElementById('editorWelcome'),
  saveToast: document.getElementById('saveToast'),
  datasetSelect: document.getElementById('datasetSelect'),
  editorSearchEvents: document.getElementById('editorSearchEvents'),
  folderConnectionToggle: document.getElementById('folderConnectionToggle'),
  newDataset: document.getElementById('newDataset'),
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
  currentFilenameInput: document.getElementById('currentFilenameInput'),
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
  logoWorkspacePanel: document.getElementById('logoWorkspacePanel'),
  flickrWorkspacePanel: document.getElementById('flickrWorkspacePanel'),
  showEventTab: document.getElementById('showEventTab'),
  showLogoTab: document.getElementById('showLogoTab'),
  showFlickrTab: document.getElementById('showFlickrTab'),
  showSessionsTab: document.getElementById('showSessionsTab'),
  showSponsorsTab: document.getElementById('showSponsorsTab'),
  showSitemapTab: document.getElementById('showSitemapTab'),
  sitemapWorkspacePanel: document.getElementById('sitemapWorkspacePanel'),
  showTimelineTab: document.getElementById('showTimelineTab'),
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
  closeSessionSponsorPickerBack: document.getElementById('closeSessionSponsorPickerBack')
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
  const normalized = String(pathValue || '').replace(/\\/g, '/').trim();
  if (!normalized) return '';
  const segments = normalized.split('/').filter(Boolean);
  return segments.length ? segments[segments.length - 1] : '';
}

function normalizeOutputPath(value, fallback = 'data/new-event.json') {
  const raw = String(value || '').replace(/\\/g, '/').trim();
  if (!raw) return fallback;
  const withExt = raw.toLowerCase().endsWith('.json') ? raw : `${raw}.json`;
  if (withExt.includes('/')) return withExt;
  return `data/${withExt}`;
}

function getFileLinkKey(pathValue) {
  return normalizeOutputPath(pathValue || state.outputPath || `data/${state.file || 'new-event.json'}`);
}

function replaceOutputBasename(pathValue, filename) {
  const normalized = normalizeOutputPath(pathValue);
  const base = String(filename || '').trim();
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

async function getStoredProjectDirHandle() {
  return getLinkedHandle(DIR_HANDLE_KEY);
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

async function clearLinkedHandle(pathKey) {
  const db = await openFileLinkDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FILE_LINK_STORE, 'readwrite');
    const store = tx.objectStore(FILE_LINK_STORE);
    const req = store.delete(pathKey);
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
  showWelcomeScreen2();
  await refreshEditorSearch();

  const returnFile = localStorage.getItem('__editor_return_file__');
  if (returnFile) {
    localStorage.removeItem('__editor_return_file__');
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

  const selectedFile = String(els.datasetSelect.value || '').trim();
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
    els.logoForm.innerHTML = '<p class="text-sm text-gray-400">Open a project folder to get started.</p>';
  }
  if (els.flickrForm) {
    els.flickrForm.innerHTML = '<p class="text-sm text-gray-400">Open a project folder to get started.</p>';
  }
  els.sessionList.innerHTML = '<li class="text-sm text-gray-400 px-3 py-2 border border-dashed border-gray-700 rounded-md">Open a project folder to get started.</li>';
  els.sessionForm.innerHTML = '<p class="text-sm text-gray-400">Select a session on the left to edit it.</p>';
  els.sponsorList.innerHTML = '<li class="text-sm text-gray-400 px-3 py-2 border border-dashed border-gray-700 rounded-md">Open a project folder to get started.</li>';
  els.sponsorForm.innerHTML = '<p class="text-sm text-gray-400">Select a sponsor row to edit it.</p>';
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
  syncWelcomePanel();
  void refreshEditorSearch();
}

function setCurrentFilenameLabel() {
  const pathValue = state.outputPath || (state.file ? `data/${state.file}` : '');
  els.currentFilenameInput.value = pathValue;
  els.currentFilenameInput.disabled = !state.dataset;
}

function setEditorButtonsEnabled(enabled) {
  if (els.exportDataset) {
    els.exportDataset.disabled = !enabled;
  }
  els.saveDataset.disabled = !enabled;
  if (els.saveDatasetToggle) els.saveDatasetToggle.disabled = !enabled;
  if (els.previewDataset) els.previewDataset.disabled = !enabled;
  if (els.previewDatasetToggle) els.previewDatasetToggle.disabled = !enabled;
  if (els.revertDataset) els.revertDataset.disabled = true;
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
  const welcomeBtn = document.getElementById('welcomeConnectFolder');
  const unsupportedTitle = 'Folder access is not supported in this browser — use the API server instead';

  if (isApiMode()) {
    if (els.folderConnectionToggle) els.folderConnectionToggle.classList.add('hidden');
    return;
  }

  if (els.folderConnectionToggle) {
    els.folderConnectionToggle.classList.remove('hidden');
    if (!isFolderPickerSupported()) {
      els.folderConnectionToggle.disabled = true;
      els.folderConnectionToggle.title = unsupportedTitle;
      els.folderConnectionToggle.innerHTML = '<i class="fas fa-folder-open mr-2"></i>Connect Folder';
    } else {
      els.folderConnectionToggle.disabled = false;
      els.folderConnectionToggle.title = '';
      els.folderConnectionToggle.innerHTML = state.folderConnectedInSession && state.projectDirHandle
        ? '<i class="fas fa-unlink mr-2"></i>Disconnect folder'
        : '<i class="fas fa-folder-open mr-2"></i>Open project folder';
    }
  }

  if (welcomeBtn) {
    if (!isFolderPickerSupported()) {
      welcomeBtn.disabled = true;
      welcomeBtn.title = unsupportedTitle;
    } else {
      welcomeBtn.disabled = false;
      welcomeBtn.title = '';
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
    outputPath: state.outputPath
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
  try {
    localStorage.setItem(RECOVERY_KEY, JSON.stringify({
      dataset: state.dataset,
      file: state.file,
      outputPath: state.outputPath,
      savedAt: Date.now(),
    }));
  } catch {
    // localStorage full or unavailable
  }
}

function clearRecoverySnapshot() {
  try { localStorage.removeItem(RECOVERY_KEY); } catch {}
}

function loadRecoverySnapshot() {
  try {
    const raw = localStorage.getItem(RECOVERY_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data?.dataset || !data?.file) return null;
    if (data.savedAt && Date.now() - data.savedAt > RECOVERY_MAX_AGE_MS) {
      clearRecoverySnapshot();
      return null;
    }
    return data;
  } catch {
    return null;
  }
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
    els.undoAction.title = UNDO_STACK.length > 0
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
  markDirty(true);
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

    document.getElementById('unsavedModalSave').addEventListener('click', async () => {
      close();
      try { await saveDataset(); resolve(true); } catch { resolve(false); }
    }, { once: true });

    document.getElementById('unsavedModalDiscard').addEventListener('click', async () => {
      close();
      await restorePersistedSnapshot();
      resolve(true);
    }, { once: true });

    document.getElementById('unsavedModalCancel').addEventListener('click', () => {
      close(); resolve(false);
    }, { once: true });

    modal.addEventListener('click', (e) => {
      if (e.target === modal) { close(); resolve(false); }
    }, { once: true });
  });
}

let _lastSavedAt = null;

function markDirty(nextDirty = true) {
  state.dirty = nextDirty;
  const color = nextDirty ? 'text-amber-300' : 'text-emerald-300';
  let label;
  if (nextDirty) {
    label = 'Unsaved changes';
  } else if (_lastSavedAt) {
    label = `Saved ${_lastSavedAt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
  } else {
    label = 'No changes';
  }
  els.dirtyState.innerHTML = `<i class="fas fa-circle mr-2 text-xs ${color}"></i><span>${label}</span>`;
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
  if (!els.welcome) return;
  const show = isApiMode()
    ? !state.dataset
    : (!state.folderConnectedInSession || !state.projectDirHandle) && !state.dataset;
  if (show) {
    document.getElementById('welcomeScreen1')?.classList.remove('hidden');
    document.getElementById('welcomeScreen2')?.classList.add('hidden');
    syncWelcomeScreen1State();
  }
  els.welcome.classList.toggle('hidden', !show);
  els.welcome.setAttribute('aria-hidden', String(!show));
  document.body.classList.toggle('session-modal-open', show);
}

function syncWelcomeScreen1State() {
  const row = document.getElementById('welcomeApiConnectedRow');
  const label = document.getElementById('welcomeApiConnectedLabel');
  if (!row) return;
  if (isApiMode()) {
    if (label) label.textContent = state.apiEndpoint;
    row.classList.remove('hidden');
  } else {
    row.classList.add('hidden');
  }
}

function closeWelcomeModal() {
  if (!els.welcome) return;
  els.welcome.classList.add('hidden');
  els.welcome.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('session-modal-open');
}

function showWelcomeScreen2() {
  if (!els.welcome) return;
  document.getElementById('welcomeScreen1')?.classList.add('hidden');
  const screen2 = document.getElementById('welcomeScreen2');
  if (screen2) {
    screen2.classList.remove('hidden');
    const lead = screen2.querySelector('.editor-welcome-lead');
    if (lead) {
      lead.textContent = isApiMode()
        ? 'API server connected. Select an event to start editing, or create a new one.'
        : 'Your project folder is connected. Select an event to start editing, or create a new one.';
    }
  }

  const eventList = document.getElementById('welcomeEventList');
  if (eventList) {
    const extractYear = (text) => { const m = text.match(/\b(20\d{2}|19\d{2})\b/); return m ? parseInt(m[1], 10) : 0; };
    const options = Array.from(els.datasetSelect.options)
      .filter((o) => o.value.trim())
      .sort((a, b) => extractYear(b.text) - extractYear(a.text));
    eventList.innerHTML = options.length
      ? options.map((o) => {
          const isHidden = o.dataset.enabled === 'false';
          return `
          <button type="button" class="editor-welcome-event-btn" data-welcome-load="${escapeAttr(o.value)}">
            <i class="fas fa-file-code welcome-btn-icon"></i>
            <span class="welcome-btn-label">${escapeHtml(o.text)}</span>
            ${isHidden ? '<span class="welcome-btn-hidden-badge"><i class="fas fa-eye-slash"></i> Hidden</span>' : ''}
            <i class="fas fa-chevron-right welcome-btn-arrow"></i>
          </button>`;
        }).join('')
      : '<p class="editor-welcome-empty">No event files found in this folder yet.</p>';

    eventList.querySelectorAll('[data-welcome-load]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const file = btn.dataset.welcomeLoad;
        closeWelcomeModal();
        try {
          els.datasetSelect.value = file;
          state.lastDatasetSelectValue = file;
          await loadDataset(file);
        } catch (e) {
          window.alert(`Could not load event: ${e.message}`);
        }
      });
    });

    const searchInput = document.getElementById('welcomeEventSearch');
    if (searchInput) {
      searchInput.value = '';
      searchInput.focus();
    }
  }

  const newEventBtn = document.getElementById('welcomeNewEvent');
  if (newEventBtn) {
    newEventBtn.onclick = () => {
      const pathValue = promptForNewFilename();
      if (!pathValue) return;
      closeWelcomeModal();
      createDatasetScaffold(pathValue);
    };
  }
}

function markSessionDirty(nextDirty = true) {
  state.sessionDirty = nextDirty;
  if (!els.sessionDirtyState) return;
  const quickCount = state.quickEditSessionChanges.size;
  const hasQuickChanges = quickCount > 0 || state.sessionStructureDirty;
  const color = (state.sessionDirty || hasQuickChanges) ? 'text-amber-300' : 'text-emerald-300';
  let label = 'No changes';
  if (isQuickSessionEditEnabled()) {
    if (hasQuickChanges) {
      label = quickCount > 0 ? `${quickCount} item${quickCount === 1 ? '' : 's'} modified` : 'Unsaved quick edits';
    }
  } else if (state.sessionDirty || hasQuickChanges) {
    label = 'Modified';
  }
  els.sessionDirtyState.innerHTML = `<i class="fas fa-circle mr-2 text-[0.55rem] ${color}"></i><span>${label}</span>`;
  syncSessionSaveButton();
}

function markSponsorDirty(nextDirty = true) {
  state.sponsorDirty = nextDirty;
  if (!els.sponsorDirtyState) return;
  const quickCount = state.quickEditSponsorChanges.size;
  const hasQuickChanges = quickCount > 0 || state.sponsorStructureDirty;
  const color = (state.sponsorDirty || hasQuickChanges) ? 'text-amber-300' : 'text-emerald-300';
  let label = 'No changes';
  if (isQuickSponsorEditEnabled()) {
    if (hasQuickChanges) {
      label = quickCount > 0 ? `${quickCount} item${quickCount === 1 ? '' : 's'} modified` : 'Unsaved quick edits';
    }
  } else if (state.sponsorDirty || hasQuickChanges) {
    label = 'Modified';
  }
  els.sponsorDirtyState.innerHTML = `<i class="fas fa-circle mr-2 text-[0.55rem] ${color}"></i><span>${label}</span>`;
  syncSponsorSaveButton();
}

function trackQuickSessionChange(index = state.selectedIndex, structural = false) {
  if (index >= 0) {
    state.quickEditSessionChanges.add(index);
  }
  if (structural) {
    state.sessionStructureDirty = true;
  }
  markSessionDirty(Boolean(state.sessionDirty || state.quickEditSessionChanges.size > 0 || state.sessionStructureDirty));
}

function trackQuickSponsorChange(index = state.selectedSponsorIndex, structural = false) {
  if (index >= 0) {
    state.quickEditSponsorChanges.add(index);
  }
  if (structural) {
    state.sponsorStructureDirty = true;
  }
  markSponsorDirty(Boolean(state.sponsorDirty || state.quickEditSponsorChanges.size > 0 || state.sponsorStructureDirty));
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
  els.saveSession.disabled = saveAll ? !Boolean(state.dataset) || !hasQuickChanges : !canSaveSelection;
}

function syncSponsorSaveButton() {
  if (!els.saveSponsor) return;
  const canSaveSelection = Boolean(state.dataset) && state.selectedSponsorIndex >= 0;
  const hasQuickChanges = state.quickEditSponsorChanges.size > 0 || state.sponsorStructureDirty;
  const saveAll = isQuickSponsorEditEnabled();
  if (els.saveSponsorLabel) {
    els.saveSponsorLabel.textContent = saveAll ? 'Save all' : 'Save';
  }
  els.saveSponsor.disabled = saveAll ? !Boolean(state.dataset) || !hasQuickChanges : !canSaveSelection;
}

function toStringValue(value) {
  if (Array.isArray(value)) return value.join(', ');
  return value == null ? '' : String(value);
}

function normalizeUrlArray(value) {
  if (Array.isArray(value)) return value.map((v) => String(v || '').trim());
  const s = String(value || '').trim();
  return s ? [s] : [];
}

function parseMultiValue(value) {
  return String(value || '')
    .split(/\n|,/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function stripSummaryFields(dataset) {
  if (!dataset || !Array.isArray(dataset.items)) return;
  dataset.items.forEach((item) => {
    if (!item || typeof item !== 'object') return;
    if (Object.prototype.hasOwnProperty.call(item, 'summary')) delete item.summary;
    if (Object.prototype.hasOwnProperty.call(item, 'description')) delete item.description;
  });
}


function normalizeFlickrObject(raw = null) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const enabled = !(input.enabled === false || String(input.enabled || '').toLowerCase() === 'false');
  return {
    enabled,
    provider: String(input.provider || '').trim(),
    groupUrl: String(input.groupUrl || '').trim(),
    image: String(input.image || '').trim(),
    imageAlt: String(input.imageAlt || '').trim()
  };
}

function normalizeLogoObject(raw = null) {
  const input = raw && typeof raw === 'object' ? raw : {};
  return {
    image: String(input.image || '').trim(),
    imageAlt: String(input.imageAlt || '').trim(),
    usePlate: input.usePlate === true || String(input.usePlate || '').toLowerCase() === 'true'
  };
}

function normalizeSponsorId(value, fallback = '') {
  const normalized = slugify(value || fallback || '');
  return normalized || '';
}

function normalizeSponsorObject(raw = null, fallbackTitle = '') {
  const input = raw && typeof raw === 'object' ? raw : {};
  const title = String(input.title || fallbackTitle || '').trim();
  const row = Number.parseInt(String(input.row ?? '').trim(), 10);
  return {
    id: normalizeSponsorId(input.id, title),
    title,
    tier: String(input.tier || '').trim(),
    row: Number.isFinite(row) ? row : 1,
    priority: Number.isFinite(Number(input.priority)) ? Number(input.priority) : 100,
    image: String(input.image || '').trim(),
    imageAlt: String(input.imageAlt || '').trim(),
    link: String(input.link || '').trim(),
    bgStyle: ['auto', 'transparent', 'light-plate', 'dark-plate', 'brand-fill'].includes(String(input.bgStyle || '').trim())
      ? String(input.bgStyle || '').trim()
      : 'auto',
    aspect: ['auto', 'square', 'landscape', 'banner'].includes(String(input.aspect || '').trim())
      ? String(input.aspect || '').trim()
      : 'auto',
    enabled: !(input.enabled === false || String(input.enabled || '').toLowerCase() === 'false')
  };
}

function normalizeSponsorCollection(raw = null) {
  if (!Array.isArray(raw)) return [];
  return raw.map((item, index) => normalizeSponsorObject(item, `Sponsor ${index + 1}`));
}

function extractDurationMinutes(value) {
  const input = String(value || '').trim();
  if (!input) return null;

  const directPm = input.match(/^p\s*(\d+)\s*m$/i);
  if (directPm) return Number.parseInt(directPm[1], 10);

  const isoLike = input.match(/^p?t?\s*(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m)?$/i);
  if (isoLike && (isoLike[1] || isoLike[2])) {
    const hours = isoLike[1] ? Number.parseFloat(isoLike[1]) : 0;
    const minutes = isoLike[2] ? Number.parseFloat(isoLike[2]) : 0;
    return Math.round(hours * 60 + minutes);
  }

  const compact = input.match(/^(\d+(?:\.\d+)?)h(\d+(?:\.\d+)?)m$/i);
  if (compact) {
    const hours = Number.parseFloat(compact[1]);
    const minutes = Number.parseFloat(compact[2]);
    return Math.round(hours * 60 + minutes);
  }

  const units = [...input.matchAll(/(\d+(?:\.\d+)?)\s*([hm])/gi)];
  if (units.length > 0) {
    let total = 0;
    units.forEach((match) => {
      const valueNum = Number.parseFloat(match[1]);
      if (match[2].toLowerCase() === 'h') {
        total += valueNum * 60;
      } else {
        total += valueNum;
      }
    });
    return Math.round(total);
  }

  if (/^\d+(?:\.\d+)?$/.test(input)) {
    return Math.round(Number.parseFloat(input));
  }

  return null;
}

function durationMinutesToHuman(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return '';
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  if (hours > 0 && rem > 0) return `${hours}h${rem}m`;
  if (hours > 0) return `${hours}h`;
  return `${rem}m`;
}

function durationToEditorValue(value) {
  const minutes = extractDurationMinutes(value);
  if (minutes == null) return String(value || '');
  return durationMinutesToHuman(minutes);
}

function durationToCanonical(value) {
  const minutes = extractDurationMinutes(value);
  if (minutes == null) return String(value || '').trim();
  return `P${minutes}M`;
}

function deriveSessionDurationValue(startTime, endTime) {
  if (!startTime || !endTime) return '';
  const startMs = new Date(startTime).getTime();
  const endMs = new Date(endTime).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return '';
  const minutes = Math.round((endMs - startMs) / 60000);
  if (!Number.isFinite(minutes) || minutes <= 0) return '';
  return durationToCanonical(minutes);
}

const _DURATION_RE = /^P\d+M$/;
function syncSessionDuration(item) {
  if (!item || typeof item !== 'object') return 'P0M';
  const derived = deriveSessionDurationValue(item.startTime, item.endTime);
  const existing = item.duration;
  item.duration = _DURATION_RE.test(derived) ? derived
    : _DURATION_RE.test(existing) ? existing
    : 'P0M';
  return item.duration;
}

function syncAllSessionDurations() {
  if (!Array.isArray(state.dataset?.items)) return;
  state.dataset.items.forEach((item) => {
    syncSessionDuration(item);
  });
}

function markdownToHtml(text) {
  return formatTextBlock(text) || '<p class="text-gray-500"><em>No description yet.</em></p>';
}

function isValidTimezone(value) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function safeTimezone(value) {
  const tz = String(value || '').trim();
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
      'Asia/Kolkata'
    ];
  }
  if (!values.includes('UTC')) values.unshift('UTC');
  state.timezones = [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function getFormatter(timeZone) {
  const tz = safeTimezone(timeZone);
  if (dtfCache.has(tz)) return dtfCache.get(tz);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });
  dtfCache.set(tz, formatter);
  return formatter;
}

function getLocalPartsFromUtcMs(utcMs, timeZone) {
  const parts = getFormatter(timeZone).formatToParts(new Date(utcMs));
  const mapped = {};
  for (const part of parts) {
    if (part.type !== 'literal') mapped[part.type] = part.value;
  }
  return {
    year: Number(mapped.year || 0),
    month: Number(mapped.month || 0),
    day: Number(mapped.day || 0),
    hour: Number(mapped.hour || 0),
    minute: Number(mapped.minute || 0),
    second: Number(mapped.second || 0)
  };
}

function localPartsToWallMs(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0);
}

function utcIsoToLocalInput(iso, timeZone) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const p = getLocalPartsFromUtcMs(date.getTime(), timeZone);
  const pad = (n) => String(n).padStart(2, '0');
  return `${String(p.year).padStart(4, '0')}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

function parseLocalInput(value) {
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!m) return null;
  return {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
    second: 0
  };
}

function localInputToUtcIso(localValue, timeZone) {
  const desired = parseLocalInput(localValue);
  if (!desired) return '';
  const desiredWallMs = localPartsToWallMs(desired);
  let utcMs = desiredWallMs;

  for (let i = 0; i < 4; i += 1) {
    const actualLocal = getLocalPartsFromUtcMs(utcMs, timeZone);
    const actualWallMs = localPartsToWallMs(actualLocal);
    const diff = actualWallMs - desiredWallMs;
    if (diff === 0) break;
    utcMs -= diff;
  }

  return new Date(utcMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
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

function buildDatasetOptionLabel(file, eventMeta = null) {
  const designation = String(eventMeta?.designation || '').trim();
  const year = String(eventMeta?.year || '').trim();
  const location = String(eventMeta?.location || '').trim();
  const fromMeta = [designation, year, location].filter(Boolean).join(' ').trim();
  return fromMeta || getManifestLabelByFile(file);
}

function getDatasetGroupName(eventMeta = null) {
  const designation = String(eventMeta?.designation || '').trim();
  return designation || 'Other';
}

function isEditorDatasetFile(name) {
  const normalized = String(name || '').trim().toLowerCase();
  return normalized.endsWith('.json') && normalized !== 'index.json';
}

function validateDatasetSchema(dataset, file = 'dataset') {
  if (!dataset || typeof dataset !== 'object' || Array.isArray(dataset)) {
    throw new Error(`${file} is not a dataset object.`);
  }
  if (!dataset.event || typeof dataset.event !== 'object' || Array.isArray(dataset.event)) {
    throw new Error(`${file} is missing a valid "event" object.`);
  }
  if (!Array.isArray(dataset.items)) {
    throw new Error(`${file} is missing a valid "items" array.`);
  }
}

async function getDataDirectoryHandle(create = false) {
  if (!state.projectDirHandle) return null;
  return state.projectDirHandle.getDirectoryHandle('data', { create });
}

async function listDatasetFilesFromConnectedFolder() {
  const dataDir = await getDataDirectoryHandle(false);
  if (!dataDir) return [];
  const files = [];
  // eslint-disable-next-line no-restricted-syntax
  for await (const [name, handle] of dataDir.entries()) {
    if (handle.kind !== 'file') continue;
    if (!isEditorDatasetFile(name)) continue;
    files.push(name);
  }
  return files.sort((a, b) => a.localeCompare(b));
}

async function loadDatasetMetaForGrouping(files) {
  const dataDir = await getDataDirectoryHandle(false);
  if (!dataDir) return [];

  const records = await Promise.all(
    files.map(async (file) => {
      try {
        const handle = await dataDir.getFileHandle(file);
        const blob = await handle.getFile();
        const text = await blob.text();
        const parsed = JSON.parse(text);
        validateDatasetSchema(parsed, file);
        const eventMeta = parsed && typeof parsed === 'object' ? parsed.event || {} : {};
        return {
          file,
          group: getDatasetGroupName(eventMeta),
          label: buildDatasetOptionLabel(file, eventMeta),
          enabled: eventMeta.enabled !== false,
        };
      } catch {
        return {
          file,
          group: 'Other',
          label: getManifestLabelByFile(file),
          enabled: true,
        };
      }
    })
  );

  records.sort((a, b) => {
    const groupCmp = a.group.localeCompare(b.group);
    if (groupCmp !== 0) return groupCmp;
    return a.label.localeCompare(b.label);
  });
  return records;
}

async function loadDatasetMetaForGroupingViaFetch(files) {
  const records = await Promise.all(
    files.map(async (file) => {
      try {
        const url = isApiMode() ? `${state.apiEndpoint}/api/data/${encodeURIComponent(file)}` : `./data/${file}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error();
        const parsed = await res.json();
        validateDatasetSchema(parsed, file);
        const m = parsed && typeof parsed === 'object' ? parsed.event || {} : {};
        return {
          file,
          group: getDatasetGroupName(m),
          label: buildDatasetOptionLabel(file, m),
          enabled: m.enabled !== false,
          designation: String(m.designation || '').trim(),
          location: String(m.location || '').trim(),
          year: String(m.year || '').trim(),
          region: String(m.region || '').trim(),
          venue: String(m.venue || '').trim(),
        };
      } catch {
        return { file, group: 'Other', label: getManifestLabelByFile(file), enabled: true, designation: '', location: '', year: '', region: '', venue: '' };
      }
    })
  );
  records.sort((a, b) => {
    const groupCmp = a.group.localeCompare(b.group);
    return groupCmp !== 0 ? groupCmp : a.label.localeCompare(b.label);
  });
  return records;
}

async function renderDatasetOptionsFromConnectedFolder(preferred = '') {
  if (!isApiMode() && (!state.projectDirHandle || !state.folderConnectedInSession)) {
    els.datasetSelect.innerHTML = '<option value="">Connect folder to load datasets</option>';
    els.datasetSelect.value = '';
    return;
  }

  const files = isApiMode()
    ? eventCatalog.map((e) => e.file).filter((f) => f && isEditorDatasetFile(f)).sort((a, b) => a.localeCompare(b))
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
        .map((record) => `<option value="${escapeAttr(record.file)}" data-enabled="${record.enabled !== false}">${escapeHtml(record.label)}</option>`)
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

function normalizeDatasetShape() {
  if (!state.dataset || typeof state.dataset !== 'object') state.dataset = {};
  if (!state.dataset.event || typeof state.dataset.event !== 'object') state.dataset.event = {};
  if (!Array.isArray(state.dataset.items)) state.dataset.items = [];
  stripSummaryFields(state.dataset);
  const mediaPromo = state.dataset.event.mediaPromo;
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
          mode: mediaPromo.mode
        }
      : null;
  state.dataset.event.flickr = normalizeFlickrObject(state.dataset.event.flickr || flickrFromMediaPromo);
  state.dataset.event.logo = normalizeLogoObject(state.dataset.event.logo);
  state.dataset.event.sponsors = normalizeSponsorCollection(state.dataset.event.sponsors);
  if (Object.prototype.hasOwnProperty.call(state.dataset.event, 'mediaPromo')) {
    delete state.dataset.event.mediaPromo;
  }
  if (!state.dataset.event.timezone) state.dataset.event.timezone = 'UTC';
  if (state.dataset.event.columns == null || state.dataset.event.columns === '') state.dataset.event.columns = 3;
  state.dataset.event.scheduleURLs = normalizeUrlArray(state.dataset.event.scheduleURLs);
  state.dataset.event.other_urls = normalizeUrlArray(state.dataset.event.other_urls || []);
  const hexPattern = /^#[0-9a-fA-F]{6}$/;
  // Migrate legacy string theme and top-level color fields into the theme object
  if (typeof state.dataset.event.theme === 'string') {
    state.dataset.event.theme = { id: state.dataset.event.theme };
  } else if (!state.dataset.event.theme || typeof state.dataset.event.theme !== 'object') {
    state.dataset.event.theme = {};
  }
  for (const colorField of ['primaryColor', 'secondaryColor', 'tertiaryColor']) {
    const topLevel = state.dataset.event[colorField];
    if (topLevel) {
      if (!state.dataset.event.theme[colorField]) state.dataset.event.theme[colorField] = topLevel;
      delete state.dataset.event[colorField];
    }
    const v = state.dataset.event.theme[colorField];
    if (v != null && !hexPattern.test(v)) delete state.dataset.event.theme[colorField];
  }
  if (Object.keys(state.dataset.event.theme).length === 0) delete state.dataset.event.theme;
  syncAllSessionDurations();
  state.dataset.items.forEach((item) => {
    if (!item || typeof item !== 'object') return;
    const sponsorIds = parseMultiValue(item.sponsorIds || '');
    item.sponsorIds = sponsorIds.length <= 1 ? (sponsorIds[0] || '') : sponsorIds;
  });
}

async function loadDataset(file) {
  if (!isApiMode() && (!state.projectDirHandle || !state.folderConnectedInSession)) {
    throw new Error('Connect folder first.');
  }
  if (localStorage.getItem(PHOTOS_BACKUP_KEY)) {
    await revertPendingPhotoUpload();
  }
  if (localStorage.getItem(LOGO_BACKUP_KEY)) {
    await revertPendingLogoUpload();
  }
  if (!isEditorDatasetFile(file)) {
    throw new Error(`${file} is not an editable dataset.`);
  }
  const targetPath = normalizeOutputPath(`data/${file}`);
  let handle = null;
  let parsed;
  if (isApiMode()) {
    const res = await fetch(`${state.apiEndpoint}/api/data/${encodeURIComponent(file)}`);
    if (!res.ok) throw new Error(`Failed to load ${file}: HTTP ${res.status}`);
    parsed = await res.json();
  } else {
    handle = await resolveFileHandleFromProjectDir(targetPath);
    const fileBlob = await handle.getFile();
    parsed = JSON.parse(await fileBlob.text());
  }
  validateDatasetSchema(parsed, file);
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
  markDirty(false);
  markSessionDirty(false);
  markSponsorDirty(false);
  capturePersistedSnapshot();
  undoClear();
  clearRecoverySnapshot();
  setCurrentFilenameLabel();
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
  if (state.activeEditorTab === 'sitemap') renderSitemap();
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
      enabled: true
    },
    items: []
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
  if (state.activeEditorTab === 'sitemap') renderSitemap();
  setEditorButtonsEnabled(true);
}

function getFlickrImageTargetPath() {
  const designation = slugify(state.dataset?.event?.designation || 'event');
  const year = slugify(state.dataset?.event?.year || '');
  const location = slugify(state.dataset?.event?.location || '');
  const fallback = slugify(outputBasename(state.outputPath || state.file || 'event').replace(/\.json$/i, '')) || 'event';
  const baseName = [year, location].filter(Boolean).join('-') || fallback;
  return `img/flickr/${designation || 'event'}/${baseName}.jpg`;
}

function getLogoImageTargetPath(file) {
  const designation = slugify(state.dataset?.event?.designation || 'event');
  const year = slugify(state.dataset?.event?.year || '');
  const location = slugify(state.dataset?.event?.location || '');
  const fallback = slugify(outputBasename(state.outputPath || state.file || 'event').replace(/\.json$/i, '')) || 'event';
  const baseName = [year, location].filter(Boolean).join('-') || fallback;
  const originalName = String(file?.name || '').trim().toLowerCase();
  const extMatch = originalName.match(/\.(svg|png|jpe?g|webp|gif)$/i);
  const ext = extMatch ? extMatch[1].toLowerCase().replace('jpeg', 'jpg') : 'png';
  return `img/logos/${designation || 'event'}/${baseName}.${ext}`;
}

function getSponsorImageTargetPath(file, sponsor = null) {
  const designation = slugify(state.dataset?.event?.designation || 'event');
  const year = slugify(state.dataset?.event?.year || '');
  const location = slugify(state.dataset?.event?.location || '');
  const sponsorSlug = slugify(sponsor?.id || sponsor?.title || file?.name || 'sponsor') || 'sponsor';
  const originalName = String(file?.name || '').trim().toLowerCase();
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
  const currentPath = String(state.dataset?.event?.flickr?.image || '').trim().replace(/^\.\//, '');
  if (!currentPath || !state.projectDirHandle) return;
  try {
    const handle = await resolveFileHandleFromProjectDir(currentPath);
    if (!handle) return;
    const file = await handle.getFile();
    const base64 = arrayBufferToBase64(await file.arrayBuffer());
    localStorage.setItem(PHOTOS_BACKUP_KEY, JSON.stringify({
      path: currentPath,
      data: `data:${file.type || 'image/jpeg'};base64,${base64}`
    }));
  } catch {
    // No existing file to back up, or too large — skip silently
  }
}

async function revertPendingPhotoUpload() {
  const raw = localStorage.getItem(PHOTOS_BACKUP_KEY);
  localStorage.removeItem(PHOTOS_BACKUP_KEY);
  if (!raw || !state.projectDirHandle) return;
  try {
    const { path, data } = JSON.parse(raw);
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
  localStorage.removeItem(PHOTOS_BACKUP_KEY);
}

async function backupCurrentLogoForRevert() {
  const currentPath = String(state.dataset?.event?.logo?.image || '').trim().replace(/^\.\//, '');
  if (!currentPath || !state.projectDirHandle) return;
  try {
    const handle = await resolveFileHandleFromProjectDir(currentPath);
    if (!handle) return;
    const file = await handle.getFile();
    const base64 = arrayBufferToBase64(await file.arrayBuffer());
    localStorage.setItem(LOGO_BACKUP_KEY, JSON.stringify({
      path: currentPath,
      data: `data:${file.type || 'image/png'};base64,${base64}`
    }));
  } catch {
    // No existing file to back up, or too large — skip silently
  }
}

async function revertPendingLogoUpload() {
  const raw = localStorage.getItem(LOGO_BACKUP_KEY);
  localStorage.removeItem(LOGO_BACKUP_KEY);
  if (!raw || !state.projectDirHandle) return;
  try {
    const { path, data } = JSON.parse(raw);
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
  localStorage.removeItem(LOGO_BACKUP_KEY);
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
  const relativePath = getFlickrImageTargetPath();
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
  if (frame) frame.innerHTML = `<img id="flickrImagePreview" class="event-promo-image" src="${blobUrl}" alt="${escapeAttr(state.dataset?.event?.flickr?.imageAlt || '')}">`;
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
  if (logoPreview) { logoPreview.src = URL.createObjectURL(file); logoPreview.classList.remove('hidden'); }
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
  if (surface) surface.innerHTML = `<img id="sponsorImagePreview" src="${blobUrl}" alt="${escapeAttr(sponsor?.imageAlt || '')}" class="sponsor-logo-image">`;
  const inline = document.getElementById('sponsorInlinePreview');
  if (inline) inline.innerHTML = `<img src="${blobUrl}" alt="${escapeAttr(sponsor?.imageAlt || '')}" class="sponsor-inline-image">`;
}

function fieldDescriptionId(scope, key) {
  return `${scope}-${String(key).replace(/[^a-z0-9_-]+/gi, '-')}-description`;
}

function renderFieldIntro(scope, key, config) {
  const description = String(config.description || '').trim();
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
  return config.description ? ` aria-describedby="${escapeAttr(fieldDescriptionId(scope, key))}"` : '';
}

function inferFlickrMode(eventMeta = null, items = []) {
  const now = new Date();
  const endDate = String(eventMeta?.endDate || '').trim();
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
  return [eventMeta?.designation, eventMeta?.year, eventMeta?.location].filter(Boolean).join(' ').trim() || 'Event';
}

function getAutomatedFlickrCopy(eventMeta = null, items = [], provider = '') {
  const mode = inferFlickrMode(eventMeta, items);
  const eventLabel = getFlickrEventLabel(eventMeta);
  const p = String(provider || '').trim() || 'Flickr';
  return {
    mode,
    heading: mode === 'archive' ? `${eventLabel} Photo Archive` : `Share Your ${eventLabel} Photos`,
    description:
      mode === 'archive'
        ? `Browse the official ${p} page for photos from ${eventLabel}.`
        : `Upload and share your photos on ${p} before, during, and after the event.`,
    buttonText: mode === 'archive' ? 'View Photo Archive' : `Open on ${p}`
  };
}

function renderFlickrCopyPreviewContent(automated) {
  return `
    <div><span class="block text-xs font-semibold text-gray-700 uppercase tracking-wide mb-0.5">Mode</span><span class="text-gray-800">${escapeHtml(automated.mode === 'archive' ? 'Photo archive' : 'Share photos')}</span></div>
    <div><span class="block text-xs font-semibold text-gray-700 uppercase tracking-wide mb-0.5">Button</span><span class="text-gray-800">${escapeHtml(automated.buttonText)}</span></div>
    <div class="col-span-2"><span class="block text-xs font-semibold text-gray-700 uppercase tracking-wide mb-0.5">Heading</span><span class="text-gray-800">${escapeHtml(automated.heading)}</span></div>
    <div class="col-span-2"><span class="block text-xs font-semibold text-gray-700 uppercase tracking-wide mb-0.5">Description</span><span class="text-gray-800">${escapeHtml(automated.description)}</span></div>
  `;
}

function renderFlickrBlock(flickr) {
  const automated = getAutomatedFlickrCopy(state.dataset?.event, state.dataset?.items, flickr.provider);
  const imageSrc = (flickr.image || '').trim();
  const providerLabel = (flickr.provider || 'Photos').toUpperCase();
  return `
    <div class="col-span-full flex gap-5 items-start">
      <div class="flex-1 min-w-0 grid grid-cols-1 md:grid-cols-2 gap-3">
        <label class="editor-form-field md:col-span-2">
          ${renderFieldIntro('flickr', 'provider', FLICKR_FIELD_CONFIG.provider)}
          <input data-flickr-field="provider" type="text" value="${escapeAttr(flickr.provider)}" class="w-full h-11 rounded-md border-gray-300 shadow-sm drupal-blue-focus text-sm bg-white px-3" placeholder="Flickr"${fieldDescriptionAttr('flickr', 'provider', FLICKR_FIELD_CONFIG.provider)}>
        </label>
        <label class="editor-form-field md:col-span-2">
          ${renderFieldIntro('flickr', 'groupUrl', FLICKR_FIELD_CONFIG.groupUrl)}
          <input data-flickr-field="groupUrl" type="text" value="${escapeAttr(flickr.groupUrl)}" class="w-full h-11 rounded-md border-gray-300 shadow-sm drupal-blue-focus text-sm bg-white px-3" placeholder="https://flic.kr/g/..."${fieldDescriptionAttr('flickr', 'groupUrl', FLICKR_FIELD_CONFIG.groupUrl)}>
        </label>
        <label class="editor-form-field md:col-span-2">
          ${renderFieldIntro('flickr', 'image', FLICKR_FIELD_CONFIG.image)}
          <input data-flickr-field="image" type="text" value="${escapeAttr(flickr.image)}" class="w-full h-11 rounded-md border-gray-300 shadow-sm drupal-blue-focus text-sm bg-white px-3" placeholder="./img/flickr/.../image.jpg"${fieldDescriptionAttr('flickr', 'image', FLICKR_FIELD_CONFIG.image)}>
        </label>
        <label class="editor-form-field md:col-span-2">
          ${renderFieldIntro('flickr', 'imageAlt', FLICKR_FIELD_CONFIG.imageAlt)}
          <input data-flickr-field="imageAlt" type="text" value="${escapeAttr(flickr.imageAlt)}" class="w-full h-11 rounded-md border-gray-300 shadow-sm drupal-blue-focus text-sm bg-white px-3"${fieldDescriptionAttr('flickr', 'imageAlt', FLICKR_FIELD_CONFIG.imageAlt)}>
        </label>
        <div class="editor-form-field md:col-span-2">
          <span class="editor-field-label">Promo image upload</span>
          <span class="editor-field-description">Uploads to <code>img/flickr/${escapeHtml(
            slugify(state.dataset?.event?.designation || 'event') || 'event'
          )}</code> and stores a relative path.</span>
          <div class="flex items-center gap-2 flex-wrap">
            <label class="h-9 inline-flex items-center gap-2.5 rounded-md border border-gray-300 px-3 bg-white cursor-pointer select-none">
              <input data-flickr-field="enabled" type="checkbox" class="h-4 w-4" ${flickr.enabled ? 'checked' : ''}${fieldDescriptionAttr('flickr', 'enabled', FLICKR_FIELD_CONFIG.enabled)}>
              <span class="text-sm text-gray-700">Enabled</span>
            </label>
            <button id="flickrImageUpload" type="button" class="h-9 inline-flex items-center justify-center px-3 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 transition-colors whitespace-nowrap">
              <i class="fas fa-upload mr-1.5 text-[0.72rem]"></i>Upload image
            </button>
            <button id="flickrImageClear" type="button" class="h-9 inline-flex items-center justify-center px-3 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-red-50 hover:border-red-300 hover:text-red-600 transition-colors whitespace-nowrap"${!imageSrc ? ' disabled' : ''}>
              <i class="fas fa-trash mr-1.5 text-[0.72rem]"></i>Delete image
            </button>
          </div>
        </div>
      </div>

      <aside class="flickr-editor-sidebar">
        <div class="flickr-preview-stage">
          <div id="flickrPreviewCard" class="event-promo-card rounded-lg border border-gray-200 bg-white p-3${flickr.enabled ? '' : ' opacity-50'}">
            <div class="event-promo-image-frame">
              ${imageSrc
                ? `<img id="flickrImagePreview" class="event-promo-image" src="${escapeAttr(bustSrc(imageSrc))}" alt="${escapeAttr(flickr.imageAlt || '')}">`
                : `<div class="flickr-preview-placeholder"><i class="fas fa-image"></i></div>`}
            </div>
            <div class="event-promo-body min-w-0">
              <div class="flickr-preview-provider text-xs font-semibold tracking-wide text-gray-500 uppercase mb-0.5">${escapeHtml(providerLabel)}</div>
              <div class="flickr-preview-heading text-sm font-semibold text-gray-900 leading-snug">${escapeHtml(automated.heading)}</div>
              <p class="flickr-preview-desc text-xs text-gray-600 mt-1 leading-snug">${escapeHtml(automated.description)}</p>
              <span class="event-promo-action flickr-preview-btn mt-2">${escapeHtml(automated.buttonText)}</span>
            </div>
          </div>
        </div>
        <p class="flickr-preview-caption">Page preview</p>
      </aside>
    </div>
  `;
}

function renderLogoBlock(logo) {
  const imageSrc = (logo.image || '').trim();
  const plateClass = logo.usePlate ? ' header-logo-use-plate' : '';
  return `
    <div class="col-span-full flex gap-5 items-start">
      <div class="flex-1 min-w-0 grid grid-cols-1 md:grid-cols-2 gap-3">
        <label class="editor-form-field md:col-span-2">
          ${renderFieldIntro('logo', 'image', LOGO_FIELD_CONFIG.image)}
          <input data-logo-field="image" type="text" value="${escapeAttr(logo.image)}" class="w-full h-11 rounded-md border-gray-300 shadow-sm drupal-blue-focus text-sm bg-white px-3" placeholder="./img/logos/.../logo.png"${fieldDescriptionAttr('logo', 'image', LOGO_FIELD_CONFIG.image)}>
        </label>
        <label class="editor-form-field md:col-span-2">
          ${renderFieldIntro('logo', 'imageAlt', LOGO_FIELD_CONFIG.imageAlt)}
          <input data-logo-field="imageAlt" type="text" value="${escapeAttr(logo.imageAlt)}" class="w-full h-11 rounded-md border-gray-300 shadow-sm drupal-blue-focus text-sm bg-white px-3"${fieldDescriptionAttr('logo', 'imageAlt', LOGO_FIELD_CONFIG.imageAlt)}>
        </label>
        <div class="editor-form-field md:col-span-2">
          <span class="editor-field-label">Logo upload</span>
          <span class="editor-field-description">Uploads to <code>img/logos/${escapeHtml(
            slugify(state.dataset?.event?.designation || 'event') || 'event'
          )}</code> and stores a relative path.</span>
          <div class="flex items-center gap-2 flex-wrap">
            <label class="h-9 inline-flex items-center gap-2.5 rounded-md border border-gray-300 px-3 bg-white cursor-pointer select-none">
              <input data-logo-field="usePlate" type="checkbox" class="h-4 w-4" ${logo.usePlate ? 'checked' : ''}${fieldDescriptionAttr('logo', 'usePlate', LOGO_FIELD_CONFIG.usePlate)}>
              <span class="text-sm text-gray-700">Background plate</span>
            </label>
            <button id="logoImageUpload" type="button" class="h-9 inline-flex items-center justify-center px-3 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 transition-colors whitespace-nowrap">
              <i class="fas fa-upload mr-1.5 text-[0.72rem]"></i>Upload logo
            </button>
            <button id="logoImageClear" type="button" class="h-9 inline-flex items-center justify-center px-3 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-red-50 hover:border-red-300 hover:text-red-600 transition-colors whitespace-nowrap"${!imageSrc ? ' disabled' : ''}>
              <i class="fas fa-trash mr-1.5 text-[0.72rem]"></i>Delete logo
            </button>
          </div>
        </div>
      </div>

      <aside class="logo-editor-sidebar">
        <div class="logo-preview-stage">
          <div id="logoPreviewContainer" class="header-logo${escapeAttr(plateClass)}">
            <i class="fas fa-image${imageSrc ? ' hidden' : ''}"></i>
            <img id="logoImagePreview" class="header-logo-image${imageSrc ? '' : ' hidden'}"
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
        const auto = getAutomatedFlickrCopy(state.dataset?.event, state.dataset?.items, flickrNow.provider);
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
            : `<div class="flickr-preview-placeholder"><i class="fas fa-image"></i></div>`;
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
      eventLogo[key] = key === 'usePlate' ? Boolean(input.checked) : input.value;
      state.dataset.event.logo = normalizeLogoObject(eventLogo);
      markDirty(true);

      if (key === 'image') {
        const newSrc = input.value.trim();
        const img = container.querySelector('#logoImagePreview');
        const icon = container.querySelector('#logoPreviewContainer > i');
        const clearBtn = container.querySelector('#logoImageClear');
        if (img) { img.src = newSrc; img.classList.toggle('hidden', !newSrc); }
        if (icon) icon.classList.toggle('hidden', Boolean(newSrc));
        if (clearBtn) clearBtn.disabled = !newSrc;
      }
      if (key === 'imageAlt') {
        const img = container.querySelector('#logoImagePreview');
        if (img) img.alt = input.value;
      }
      if (key === 'usePlate') {
        const preview = container.querySelector('#logoPreviewContainer');
        if (preview) preview.classList.toggle('header-logo-use-plate', input.checked);
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
    els.logoForm.innerHTML = '<p class="text-sm text-gray-400">Load a dataset to edit the event logo.</p>';
    return;
  }
  const logo = normalizeLogoObject(state.dataset?.event?.logo);
  els.logoForm.innerHTML = renderLogoBlock(logo);
  bindLogoFormEvents(els.logoForm);
}

function renderFlickrForm() {
  if (!els.flickrForm) return;
  if (!state.dataset) {
    els.flickrForm.innerHTML = '<p class="text-sm text-gray-400">Load a dataset to edit the photos block.</p>';
    return;
  }
  const flickr = normalizeFlickrObject(state.dataset?.event?.flickr);
  els.flickrForm.innerHTML = renderFlickrBlock(flickr);
  bindFlickrFormEvents(els.flickrForm);
}

function renderUrlMultifieldHtml(scope, field, config, urls) {
  const spanClass = 'md:col-span-2 xl:col-span-3';
  const rows = urls.map((url, i) => `
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
        <i class="fas fa-times"></i>
      </button>
    </div>
  `).join('');

  return `
    <div class="editor-form-field ${spanClass}">
      ${renderFieldIntro(scope, field, config)}
      <div class="url-multifield-list" data-url-list="${escapeAttr(field)}">
        ${rows || '<p class="url-multifield-empty">No URLs configured.</p>'}
      </div>
      <button type="button" class="url-multifield-add" data-url-add="${escapeAttr(field)}">
        <i class="fas fa-plus"></i> Add URL
      </button>
    </div>
  `;
}

function setEventColor(field, value) {
  if (!state.dataset?.event) return;
  if (!state.dataset.event.theme || typeof state.dataset.event.theme !== 'object') state.dataset.event.theme = {};
  state.dataset.event.theme[field] = value;
  markDirty(true);
  const resetIds = { primaryColor: 'clearPrimaryColor', secondaryColor: 'clearSecondaryColor', tertiaryColor: 'clearTertiaryColor' };
  document.getElementById(resetIds[field])?.classList.remove('hidden');
  applyEventColors(state.dataset.event.theme.primaryColor, state.dataset.event.theme.secondaryColor, state.dataset.event.theme.tertiaryColor);
}

function clearEventColor(field, picker, hex, clearBtn, defaultColor) {
  if (!state.dataset?.event) return;
  if (state.dataset.event.theme) delete state.dataset.event.theme[field];
  markDirty(true);
  picker.value = defaultColor;
  hex.value = '';
  hex.placeholder = defaultColor;
  clearBtn.classList.add('hidden');
  applyEventColors(state.dataset.event.theme?.primaryColor, state.dataset.event.theme?.secondaryColor, state.dataset.event.theme?.tertiaryColor);
}

let _editingThemeId = null;
let _editingThemeSnapshot = null;
let _preEditThemeId = null;

const _THEME_EDIT_FIELDS = [
  { key: 'bg',        label: 'Background', def: '#010810' },
  { key: 'primary',   label: 'Primary',    def: '#00cfff' },
  { key: 'secondary', label: 'Secondary',  def: '#4a90d9' },
  { key: 'tertiary',  label: 'Tertiary',   def: '#7c3aed' },
  { key: 'text',      label: 'Text',       def: '#eaf2fc' },
  { key: 'border',    label: 'Border',     def: '#162c4c' },
];

function _blendHex(hex, toward, amount) {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex) || !/^#[0-9a-fA-F]{6}$/.test(toward)) return hex;
  const lerp = (a, b) => Math.round(a + (b - a) * amount).toString(16).padStart(2, '0');
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

  const eventThemeCards = themes.map((t) => _themeCardHtml(t, eventThemeId || '__none__', 'eventTheme', _editingThemeId, savedThemeId)).join('');
  const pickerPrimary = primaryColor || themeColors.primary || '#00cfff';
  const pickerSecondary = secondaryColor || themeColors.secondary || '#4a90d9';
  const pickerTertiary = tertiaryColor || themeColors.tertiary || '#7c3aed';

  // --- Theme library section ---
  const libraryItems = themes.map((t) => {
    const c = t.colors || {};
    if (_editingThemeId === t.id) {
      const colorPairs = _THEME_EDIT_FIELDS.map((f) => {
        const v = c[f.key] || f.def;
        return `<div class="appearance-add-field">
          <span>${f.label}</span>
          <div class="appearance-color-pair">
            <input type="color" id="editColor-${f.key}" value="${escapeAttr(v)}">
            <input type="text" id="editColorHex-${f.key}" value="${escapeAttr(v)}" maxlength="7" class="appearance-hex-input" placeholder="${escapeAttr(f.def)}">
          </div>
        </div>`;
      }).join('');
      return `<div class="appearance-library-item appearance-library-item--editing">
        <div style="width:100%">
          <p class="theme-edit-live-note"><span class="theme-edit-live-dot"></span>Previewing live on page — changes apply instantly</p>
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
        <i class="fas fa-pen text-[0.72rem]"></i>
      </button>
      <button type="button" class="appearance-library-delete" data-delete-theme="${escapeAttr(t.id)}" title="Delete theme">
        <i class="fas fa-trash text-[0.72rem]"></i>
      </button>
    </div>`;
  }).join('');

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

    <section class="appearance-panel-section mt-4">
      <div class="appearance-panel-header">
        <div>
          <h3 class="appearance-panel-title">Theme Library</h3>
          <p class="appearance-panel-desc">Add or remove themes. Changes are saved to <code>data/themes.json</code>.</p>
        </div>
      </div>
      <div id="themeLibraryList" class="appearance-library-list">${libraryItems}</div>
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
        <button type="button" id="showAddThemeForm" class="appearance-btn-secondary"><i class="fas fa-plus mr-1.5 text-[0.72rem]"></i>Add theme</button>
        <button type="button" id="saveThemesBtn" class="appearance-btn-primary"><i class="fas fa-floppy-disk mr-1.5 text-[0.72rem]"></i>Save themes</button>
      </div>
    </section>`;

  applyThemeClass(_editingThemeId || effectiveThemeId);
  applyEventColors(primaryColor, secondaryColor, tertiaryColor);

  // --- Per-event theme radios ---
  els.appearanceForm.querySelectorAll('input[name="eventTheme"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      if (!radio.checked || !state.dataset?.event) return;
      const val = radio.value;
      if (!state.dataset.event.theme || typeof state.dataset.event.theme !== 'object') state.dataset.event.theme = {};
      if (val) {
        state.dataset.event.theme.id = val;
      } else {
        delete state.dataset.event.theme.id;
      }
      markDirty(true);
      const newEffective = val || getCurrentThemeId();
      applyThemeClass(newEffective);
      applyEventColors(state.dataset.event.theme.primaryColor, state.dataset.event.theme.secondaryColor, state.dataset.event.theme.tertiaryColor);
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
      if (/^#[0-9a-fA-F]{6}$/.test(v)) { primaryPicker.value = v; setEventColor('primaryColor', v); }
    });
    clearPrimary?.addEventListener('click', () => {
      const c = getThemeById(effectiveThemeId)?.colors || {};
      clearEventColor('primaryColor', primaryPicker, primaryHex, clearPrimary, c.primary || '#00cfff');
    });
    secondaryPicker?.addEventListener('input', () => {
      secondaryHex.value = secondaryPicker.value.toUpperCase();
      setEventColor('secondaryColor', secondaryPicker.value);
    });
    secondaryHex?.addEventListener('input', () => {
      const v = secondaryHex.value.trim();
      if (/^#[0-9a-fA-F]{6}$/.test(v)) { secondaryPicker.value = v; setEventColor('secondaryColor', v); }
    });
    clearSecondary?.addEventListener('click', () => {
      const c = getThemeById(effectiveThemeId)?.colors || {};
      clearEventColor('secondaryColor', secondaryPicker, secondaryHex, clearSecondary, c.secondary || '#4a90d9');
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
      if (/^#[0-9a-fA-F]{6}$/.test(v)) { tertiaryPicker.value = v; setEventColor('tertiaryColor', v); }
    });
    clearTertiary?.addEventListener('click', () => {
      const c = getThemeById(effectiveThemeId)?.colors || {};
      clearEventColor('tertiaryColor', tertiaryPicker, tertiaryHex, clearTertiary, c.tertiary || '#7c3aed');
    });
  }

  // --- Theme library controls ---
  els.appearanceForm.querySelectorAll('[data-delete-theme]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.deleteTheme;
      if (getThemes().length <= 1) {
        window.alert('Cannot delete the last theme.');
        return;
      }
      if (!window.confirm(`Delete theme "${id}"?`)) return;
      const updated = getThemes().filter((t) => t.id !== id);
      setThemes(updated);
      if (_editingThemeId === id) { _editingThemeId = null; _editingThemeSnapshot = null; }
      renderAppearanceForm();
    });
  });

  els.appearanceForm.querySelectorAll('[data-edit-theme]').forEach((btn) => {
    btn.addEventListener('click', () => {
      _preEditThemeId = _editingThemeId || effectiveThemeId;
      _editingThemeId = btn.dataset.editTheme;
      _editingThemeSnapshot = JSON.parse(JSON.stringify(getThemeById(_editingThemeId)));
      renderAppearanceForm();
    });
  });

  document.getElementById('doneEditTheme')?.addEventListener('click', () => {
    const restoreId = _preEditThemeId || effectiveThemeId;
    _editingThemeId = null;
    _editingThemeSnapshot = null;
    _preEditThemeId = null;
    applyThemeClass(restoreId);
    renderAppearanceForm();
  });

  document.getElementById('cancelEditTheme')?.addEventListener('click', () => {
    if (_editingThemeSnapshot) {
      const reverted = getThemes().map((t) => t.id === _editingThemeId ? _editingThemeSnapshot : t);
      setThemes(reverted);
    }
    const restoreId = _preEditThemeId || effectiveThemeId;
    _editingThemeId = null;
    _editingThemeSnapshot = null;
    _preEditThemeId = null;
    applyThemeClass(restoreId);
    renderAppearanceForm();
  });

  // Live color + meta updates while editing a theme
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
      if (/^#[0-9a-fA-F]{6}$/.test(v)) { picker.value = v; _applyLiveEditColor(key, v); }
    });
  });

  document.getElementById('editThemeLabel')?.addEventListener('input', _applyLiveEditMeta);
  document.getElementById('editThemeDark')?.addEventListener('change', _applyLiveEditMeta);

  // Hex↔picker sync for add form
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
    picker.addEventListener('input', () => { hexInp.value = picker.value.toUpperCase(); });
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
    if (!label) { window.alert('Please enter a theme name.'); return; }
    const id = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (getThemes().some((t) => t.id === id)) {
      window.alert(`A theme with id "${id}" already exists. Choose a different name.`);
      return;
    }
    const dark = document.getElementById('newThemeDark')?.checked ?? true;
    const bg = document.getElementById('newThemeBg')?.value || '#010810';
    const primary = document.getElementById('newThemePrimary')?.value || '#00cfff';
    const secondary = document.getElementById('newThemeSecondary')?.value || '#4a90d9';
    const tertiary = document.getElementById('newThemeTertiary')?.value || secondary;
    const textPicked = document.getElementById('newThemeText')?.value || '';
    const baseDefaults = dark
      ? { surface: 'rgba(3,10,22,0.93)', surfaceAlt: 'rgba(7,18,36,0.96)', surfaceDeep: 'rgba(12,28,52,0.84)', text: textPicked || '#eaf2fc', textAlt: '#cdd9ee', textMuted: '#8eaacc', textFaint: '#6a8cb0' }
      : { surface: 'rgba(255,255,255,0.97)', surfaceAlt: 'rgba(248,250,252,0.99)', surfaceDeep: 'rgba(241,245,249,0.95)', text: textPicked || '#0f172a', textAlt: '#1e293b', textMuted: '#475569', textFaint: '#64748b' };
    const bgAlt = _blendHex(bg, dark ? '#ffffff' : '#000000', 0.06);
    const border = dark ? _blendHex(bg, '#ffffff', 0.12) : _blendHex(bg, '#000000', 0.18);
    const newTheme = { id, label, dark, colors: { bg, bgAlt, primary, secondary, tertiary, border, ...baseDefaults } };
    setThemes([...getThemes(), newTheme]);
    renderAppearanceForm();
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

function renderEventMetaForm() {
  const event = state.dataset?.event || {};
  const visibleFields = EVENT_META_FIELDS.filter((field) => !['id', 'name', 'logo', 'flickr'].includes(field));

  const html = visibleFields.map((field) => {
    const config = EVENT_META_FIELD_CONFIG[field] || { label: field, description: '' };
    const isWide = field === 'website' || field === 'scheduleURLs' || field === 'other_urls';
    const spanClass = isWide ? 'md:col-span-2 xl:col-span-3' : '';

    if (field === 'scheduleURLs' || field === 'other_urls') {
      const urls = normalizeUrlArray(event[field]);
      return renderUrlMultifieldHtml('event', field, config, urls);
    }

    if (field === 'timezone') {
      const current = safeTimezone(event[field] || 'UTC');
      const timezoneValues = state.timezones.includes(current) ? state.timezones : [current, ...state.timezones];
      const options = timezoneValues
        .map((tz) => `<option value="${escapeAttr(tz)}" ${tz === current ? 'selected' : ''}>${escapeHtml(tz)}</option>`)
        .join('');
      return `
        <label class="editor-form-field ${spanClass}">
          ${renderFieldIntro('event', field, config)}
          <select data-event-field="timezone" class="w-full h-11 pr-10 rounded-md border-gray-300 shadow-sm drupal-blue-focus text-base font-medium bg-white px-3"${fieldDescriptionAttr(
            'event',
            field,
            config
          )}>${options}</select>
        </label>
      `;
    }

    if (field === 'enabled') {
      const checked = event.enabled === true || String(event.enabled).toLowerCase() === 'true';
      return `
        <label class="editor-form-field ${spanClass}">
          ${renderFieldIntro('event', field, config)}
          <span class="h-11 inline-flex items-center gap-3 rounded-md border border-gray-300 px-3 bg-white">
            <input data-event-field="${field}" type="checkbox" class="h-4 w-4" ${checked ? 'checked' : ''}${fieldDescriptionAttr(
              'event',
              field,
              config
            )}>
            <span class="text-sm text-gray-200">Show this event in planner</span>
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
          <input data-event-field="${field}" type="date" value="${escapeAttr(dateValue)}" class="w-full h-11 rounded-md border-gray-300 shadow-sm drupal-blue-focus text-base font-medium bg-white px-3"${fieldDescriptionAttr(
            'event',
            field,
            config
          )}>
        </label>
      `;
    }

    if (field === 'columns') {
      const value = Number.isFinite(Number(event[field])) ? Number(event[field]) : 3;
      return `
        <label class="editor-form-field ${spanClass}">
          ${renderFieldIntro('event', field, config)}
          <input data-event-field="columns" type="number" min="1" max="8" step="1" value="${value}" class="w-full h-11 rounded-md border-gray-300 shadow-sm drupal-blue-focus text-base font-medium bg-white px-3"${fieldDescriptionAttr(
            'event',
            field,
            config
          )}>
        </label>
      `;
    }

    const value = toStringValue(event[field]);
    return `
      <label class="editor-form-field ${spanClass}">
        ${renderFieldIntro('event', field, config)}
        <input data-event-field="${field}" type="text" value="${escapeAttr(value)}" class="w-full h-11 rounded-md border-gray-300 shadow-sm drupal-blue-focus text-base font-medium bg-white px-3"${fieldDescriptionAttr(
          'event',
          field,
          config
        )}>
      </label>
    `;
  }).join('');

  els.eventMetaForm.innerHTML = html;

  els.eventMetaForm.querySelectorAll('[data-event-field]').forEach((input) => {
    input.addEventListener('focus', undoPush);
    input.addEventListener('input', () => {
      const field = input.dataset.eventField;
      if (field === 'columns') {
        const parsed = Number.parseInt(input.value || '3', 10);
        state.dataset.event.columns = Number.isFinite(parsed) ? parsed : 3;
      } else if (field === 'timezone') {
        state.dataset.event.timezone = safeTimezone(input.value);
        renderSessionList();
        renderSessionForm();
        renderFlickrForm();
      } else if (field === 'enabled') {
        state.dataset.event[field] = Boolean(input.checked);
      } else {
        state.dataset.event[field] = input.value;
      }
      markDirty(true);
      if (field === 'designation' || field === 'year' || field === 'location') {
        renderLogoForm();
        renderFlickrForm();
      }
      if ((field === 'startDate' || field === 'endDate') && state.activeEditorTab === 'timeline' && els.timelineCanvas) {
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

  els.sessionWorkspace.classList.toggle('editor-session-workspace-expanded', state.sessionListExpanded);
  els.sessionSidebarPanel.classList.toggle('xl:col-span-2', state.sessionListExpanded);
  els.sessionEditorPanel.classList.toggle('xl:col-span-2', state.sessionListExpanded);

  if (els.toggleSessionWorkspaceIcon) {
    els.toggleSessionWorkspaceIcon.classList.toggle('fa-expand-alt', !state.sessionListExpanded);
    els.toggleSessionWorkspaceIcon.classList.toggle('fa-compress-alt', state.sessionListExpanded);
  }
  if (els.toggleSessionWorkspaceLabel) {
    els.toggleSessionWorkspaceLabel.textContent = state.sessionListExpanded ? 'Collapse list' : 'Expand list';
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

  els.sponsorWorkspace.classList.toggle('editor-session-workspace-expanded', state.sponsorListExpanded);
  els.sponsorSidebarPanel.classList.toggle('xl:col-span-2', state.sponsorListExpanded);
  els.sponsorEditorPanel.classList.toggle('xl:col-span-2', state.sponsorListExpanded);

  if (els.toggleSponsorWorkspaceIcon) {
    els.toggleSponsorWorkspaceIcon.classList.toggle('fa-expand-alt', !state.sponsorListExpanded);
    els.toggleSponsorWorkspaceIcon.classList.toggle('fa-compress-alt', state.sponsorListExpanded);
  }
  if (els.toggleSponsorWorkspaceLabel) {
    els.toggleSponsorWorkspaceLabel.textContent = state.sponsorListExpanded ? 'Collapse list' : 'Expand list';
  }
  syncSponsorEditorPanelVisibility();
  syncQuickSponsorEditToggle();
  markSponsorDirty(state.sponsorDirty);
}

function setActiveEditorTab(tab) {
  const nextTab = ['event', 'logo', 'flickr', 'sessions', 'sponsors', 'sitemap', 'timeline', 'appearance'].includes(tab) ? tab : 'event';
  state.activeEditorTab = nextTab;

  if (els.eventWorkspacePanel) {
    els.eventWorkspacePanel.classList.toggle('hidden', nextTab !== 'event');
  }
  if (els.logoWorkspacePanel) {
    els.logoWorkspacePanel.classList.toggle('hidden', nextTab !== 'logo');
  }
  if (els.flickrWorkspacePanel) {
    els.flickrWorkspacePanel.classList.toggle('hidden', nextTab !== 'flickr');
  }
  if (els.sessionWorkspacePanel) {
    els.sessionWorkspacePanel.classList.toggle('hidden', nextTab !== 'sessions');
  }
  if (els.sponsorWorkspacePanel) {
    els.sponsorWorkspacePanel.classList.toggle('hidden', nextTab !== 'sponsors');
  }
  if (els.sitemapWorkspacePanel) {
    els.sitemapWorkspacePanel.classList.toggle('hidden', nextTab !== 'sitemap');
  }
  if (els.showEventTab) {
    const active = nextTab === 'event';
    els.showEventTab.classList.toggle('is-active', active);
    els.showEventTab.setAttribute('aria-selected', active ? 'true' : 'false');
  }
  if (els.showLogoTab) {
    const active = nextTab === 'logo';
    els.showLogoTab.classList.toggle('is-active', active);
    els.showLogoTab.setAttribute('aria-selected', active ? 'true' : 'false');
  }
  if (els.showFlickrTab) {
    const active = nextTab === 'flickr';
    els.showFlickrTab.classList.toggle('is-active', active);
    els.showFlickrTab.setAttribute('aria-selected', active ? 'true' : 'false');
  }
  if (els.showSessionsTab) {
    const active = nextTab === 'sessions';
    els.showSessionsTab.classList.toggle('is-active', active);
    els.showSessionsTab.setAttribute('aria-selected', active ? 'true' : 'false');
  }
  if (els.showSponsorsTab) {
    const active = nextTab === 'sponsors';
    els.showSponsorsTab.classList.toggle('is-active', active);
    els.showSponsorsTab.setAttribute('aria-selected', active ? 'true' : 'false');
  }
  if (els.showSitemapTab) {
    const active = nextTab === 'sitemap';
    els.showSitemapTab.classList.toggle('is-active', active);
    els.showSitemapTab.setAttribute('aria-selected', active ? 'true' : 'false');
    if (active) renderSitemap();
  }
  if (els.sitemapWorkspacePanel) {
    els.sitemapWorkspacePanel.classList.toggle('hidden', nextTab !== 'sitemap');
  }
  if (els.timelineWorkspacePanel) {
    els.timelineWorkspacePanel.classList.toggle('hidden', nextTab !== 'timeline');
  }
  if (els.showTimelineTab) {
    const active = nextTab === 'timeline';
    els.showTimelineTab.classList.toggle('is-active', active);
    els.showTimelineTab.setAttribute('aria-selected', active ? 'true' : 'false');
    if (active && state.dataset && els.timelineCanvas) {
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
  if (els.appearanceWorkspacePanel) {
    els.appearanceWorkspacePanel.classList.toggle('hidden', nextTab !== 'appearance');
  }
  if (els.showAppearanceTab) {
    const active = nextTab === 'appearance';
    els.showAppearanceTab.classList.toggle('is-active', active);
    els.showAppearanceTab.setAttribute('aria-selected', active ? 'true' : 'false');
    if (active) renderAppearanceForm();
  }
}

function switchEditorTab(tab) {
  const nextTab = ['event', 'logo', 'flickr', 'sessions', 'sponsors', 'sitemap', 'timeline', 'appearance'].includes(tab) ? tab : 'event';
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

function getSessionLabel(item, index) {
  const title = item?.title ? String(item.title) : '(Untitled session)';
  const when = item?.startTime ? formatSessionTimeForList(item.startTime) : '';
  return `${index + 1}. ${title}${when ? ` - ${when}` : ''}`;
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
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    timeZone: getEventTimezone()
  }).format(new Date(utcNoon));
}

function scrollToSessionRow(index) {
  els.sessionList.querySelector(`[data-session-index="${index}"]`)?.scrollIntoView({ block: 'nearest' });
}

function scrollToSponsorRow(index) {
  els.sponsorList.querySelector(`[data-sponsor-index="${index}"]`)?.scrollIntoView({ block: 'nearest' });
}

function renderSessionList() {
  const items = state.dataset?.items || [];
  if (items.length === 0) {
    els.sessionList.innerHTML = '<li class="text-sm text-gray-400 px-3 py-2 border border-dashed border-gray-700 rounded-md">No sessions yet.</li>';
    return;
  }

  const query = String(state.sessionSearchQuery || '').trim().toLowerCase();
  const visibleItems = query
    ? items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => String(item?.title || '').toLowerCase().includes(query))
    : items.map((item, index) => ({ item, index }));

  if (visibleItems.length === 0) {
    els.sessionList.innerHTML = '<li class="text-sm text-gray-400 px-3 py-2 border border-dashed border-gray-700 rounded-md">No sessions match this search.</li>';
    return;
  }

  const groups = new Map();
  for (const entry of visibleItems) {
    const local = utcIsoToLocalInput(entry.item?.startTime, getEventTimezone());
    const dateKey = local ? local.slice(0, 10) : '';
    if (!groups.has(dateKey)) groups.set(dateKey, []);
    groups.get(dateKey).push(entry);
  }

  const sortedKeys = [...groups.keys()].sort((a, b) => {
    if (!a) return 1;
    if (!b) return -1;
    return a.localeCompare(b);
  });

  els.sessionList.innerHTML = sortedKeys.map((dateKey) => {
    const label = dateKey ? formatDateHeading(dateKey) : 'Unscheduled';
    const header = `<li class="session-date-header px-2 py-1 text-xs font-semibold text-gray-400 uppercase tracking-wide border-b border-white mt-2 first:mt-0">${escapeHtml(label)}</li>`;
    const rows = groups.get(dateKey).map(({ item: rowItem, index: rowIndex }) => {
      const active = rowIndex === state.selectedIndex ? 'border-blue-400 bg-blue-500/20' : 'border-gray-700 bg-gray-900/30';
      if (isQuickSessionEditEnabled()) {
        const startValue = utcIsoToLocalInput(rowItem?.startTime, getEventTimezone());
        const endValue = utcIsoToLocalInput(rowItem?.endTime, getEventTimezone());
        return `
          <li draggable="true" data-session-index="${rowIndex}" class="session-row session-row-expanded cursor-move px-3 py-3 border rounded-md ${active}">
            <div class="session-row-expanded-grid">
              <div class="session-row-handle text-gray-500">
                <i class="fas fa-grip-vertical"></i>
              </div>
              <div class="min-w-0">
                <label class="session-inline-field">
                  <span class="session-inline-label">Title</span>
                  <input
                    data-inline-session-field="title"
                    data-session-index="${rowIndex}"
                    type="text"
                    value="${escapeAttr(toStringValue(rowItem?.title))}"
                    class="w-full h-10 rounded-md border-gray-300 shadow-sm drupal-blue-focus text-sm bg-white px-3"
                  >
                </label>
              </div>
              <div>
                <label class="session-inline-field">
                  <span class="session-inline-label">Start time</span>
                  <input
                    data-inline-session-field="startTime"
                    data-session-index="${rowIndex}"
                    type="datetime-local"
                    value="${escapeAttr(startValue)}"
                    class="w-full h-10 rounded-md border-gray-300 shadow-sm drupal-blue-focus text-sm bg-white px-3"
                  >
                </label>
              </div>
              <div>
                <label class="session-inline-field">
                  <span class="session-inline-label">End time</span>
                  <input
                    data-inline-session-field="endTime"
                    data-session-index="${rowIndex}"
                    type="datetime-local"
                    value="${escapeAttr(endValue)}"
                    class="w-full h-10 rounded-md border-gray-300 shadow-sm drupal-blue-focus text-sm bg-white px-3"
                  >
                </label>
              </div>
              <div class="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  data-open-session-form="${rowIndex}"
                  class="editor-inline-open h-10 inline-flex items-center justify-center px-3 border border-gray-300 rounded-md text-xs font-medium text-gray-700 bg-white hover:bg-gray-50 transition-colors whitespace-nowrap"
                >
                  <i class="fas fa-up-right-from-square mr-1.5 text-[0.72rem]"></i><span>Open</span>
                </button>
                <button type="button" data-duplicate-session="${rowIndex}" title="Duplicate session"
                  class="h-10 inline-flex items-center justify-center px-3 border border-gray-300 rounded-md text-xs font-medium text-gray-700 bg-white hover:bg-gray-50 transition-colors whitespace-nowrap">
                  <i class="fas fa-copy mr-1.5 text-[0.72rem]"></i><span>Duplicate</span>
                </button>
                ${state.sessionListExpanded ? `
                <button type="button" data-move-top="${rowIndex}" title="Send to top"
                  class="h-10 inline-flex items-center justify-center px-2 border border-gray-300 rounded-md text-xs font-medium text-gray-700 bg-white hover:bg-gray-50 transition-colors">↑↑</button>
                <button type="button" data-move-bottom="${rowIndex}" title="Send to bottom"
                  class="h-10 inline-flex items-center justify-center px-2 border border-gray-300 rounded-md text-xs font-medium text-gray-700 bg-white hover:bg-gray-50 transition-colors">↓↓</button>
                <button type="button" data-move-to="${rowIndex}" title="Send to position…"
                  class="h-10 inline-flex items-center justify-center px-2 border border-gray-300 rounded-md text-xs font-medium text-gray-700 bg-white hover:bg-gray-50 transition-colors">#</button>
                ` : ''}
              </div>
            </div>
          </li>
        `;
      }
      return `
        <li draggable="true" data-session-index="${rowIndex}" class="session-row cursor-move select-none px-3 py-2 border rounded-md ${active}">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <div class="text-sm font-medium text-gray-100 truncate">${escapeHtml(`${rowIndex + 1}. ${rowItem?.title ? String(rowItem.title) : '(Untitled session)'}`)}</div>
              <div class="text-xs text-gray-400 truncate">${escapeHtml([getSessionTimingSummary(rowItem), rowItem?.location || ''].filter(Boolean).join(' | '))}</div>
            </div>
            <div class="flex items-center gap-0.5 shrink-0">
              <button type="button" data-duplicate-session="${rowIndex}" title="Duplicate session"
                class="text-xs px-1 py-0.5 rounded text-gray-400 hover:text-white border border-gray-700 hover:border-gray-500 bg-gray-900/50">
                <i class="fas fa-copy"></i>
              </button>
              ${state.sessionListExpanded ? `
              <button type="button" data-move-top="${rowIndex}" title="Send to top"
                class="text-xs px-1 py-0.5 rounded text-gray-400 hover:text-white border border-gray-700 hover:border-gray-500 bg-gray-900/50">↑↑</button>
              <button type="button" data-move-bottom="${rowIndex}" title="Send to bottom"
                class="text-xs px-1 py-0.5 rounded text-gray-400 hover:text-white border border-gray-700 hover:border-gray-500 bg-gray-900/50">↓↓</button>
              <button type="button" data-move-to="${rowIndex}" title="Send to position…"
                class="text-xs px-1 py-0.5 rounded text-gray-400 hover:text-white border border-gray-700 hover:border-gray-500 bg-gray-900/50">#</button>
              ` : ''}
              <i class="fas fa-grip-vertical text-gray-500 ml-1"></i>
            </div>
          </div>
        </li>
      `;
    }).join('');
    return header + rows;
  }).join('');

  function moveSessionTo(from, to) {
    const items = state.dataset.items;
    const clampedTo = Math.max(0, Math.min(to, items.length - 1));
    if (from === clampedTo) return;
    undoPush();
    const moved = items.splice(from, 1)[0];
    items.splice(clampedTo, 0, moved);
    moveTrackedIndex(state.quickEditSessionChanges, from, clampedTo);
    state.selectedIndex = clampedTo;
    markDirty(true);
    trackQuickSessionChange(clampedTo, true);
    renderSessionList();
    renderSessionForm();
  }

  els.sessionList.querySelectorAll('.session-row').forEach((row) => {
    const index = Number.parseInt(row.dataset.sessionIndex || '-1', 10);

    row.addEventListener('click', async () => {
      if (index === state.selectedIndex) return;
      selectSessionForm(index, { collapseWorkspace: state.sessionListExpanded });
    });

    row.addEventListener('dragstart', (event) => {
      state.draggingIndex = index;
      row.classList.add('opacity-50');
      event.dataTransfer.effectAllowed = 'move';
    });

    row.addEventListener('dragend', () => {
      state.draggingIndex = -1;
      row.classList.remove('opacity-50');
      els.sessionList.querySelectorAll('.session-row').forEach((r) => r.classList.remove('ring-2', 'ring-blue-400'));
    });

    row.addEventListener('dragover', (event) => {
      event.preventDefault();
      row.classList.add('ring-2', 'ring-blue-400');
    });

    row.addEventListener('dragleave', () => {
      row.classList.remove('ring-2', 'ring-blue-400');
    });

    row.addEventListener('drop', (event) => {
      event.preventDefault();
      row.classList.remove('ring-2', 'ring-blue-400');
      const from = state.draggingIndex;
      const to = index;
      if (from < 0 || to < 0 || from === to) return;
      undoPush();
      const moved = state.dataset.items.splice(from, 1)[0];
      state.dataset.items.splice(to, 0, moved);
      moveTrackedIndex(state.quickEditSessionChanges, from, to);
      state.selectedIndex = to;
      markDirty(true);
      trackQuickSessionChange(to, true);
      renderSessionList();
      renderSessionForm();
    });

    row.querySelector('[data-move-top]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      moveSessionTo(index, 0);
    });

    row.querySelector('[data-move-bottom]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      moveSessionTo(index, state.dataset.items.length - 1);
    });

    row.querySelector('[data-move-to]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const total = state.dataset.items.length;
      const input = prompt(`Move to position (1–${total}):`, String(index + 1));
      if (input === null) return;
      const n = parseInt(input, 10);
      if (!isNaN(n)) moveSessionTo(index, n - 1);
    });

    row.querySelector('[data-duplicate-session]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      duplicateSession(index);
    });
  });

  const syncExpandedSelectionState = () => {
    els.sessionList.querySelectorAll('.session-row').forEach((row) => {
      const rowIndex = Number.parseInt(row.dataset.sessionIndex || '-1', 10);
      const isActive = rowIndex === state.selectedIndex;
      row.classList.toggle('border-blue-400', isActive);
      row.classList.toggle('bg-blue-500/20', isActive);
      row.classList.toggle('border-gray-700', !isActive);
      row.classList.toggle('bg-gray-900/30', !isActive);
    });
  };

  els.sessionList.querySelectorAll('[data-inline-session-field]').forEach((input) => {
    const rowIndex = Number.parseInt(input.dataset.sessionIndex || '-1', 10);
    const key = input.dataset.inlineSessionField;

    const selectRow = () => {
      if (rowIndex === state.selectedIndex) return;
      selectSessionForm(rowIndex);
      syncExpandedSelectionState();
    };

    input.addEventListener('click', (event) => {
      event.stopPropagation();
    });

    input.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
    });

    input.addEventListener('focus', async (event) => {
      event.stopPropagation();
      if (isQuickSessionEditEnabled()) {
        undoPush();
        return;
      }
      await selectRow();
    });

    input.addEventListener('input', (event) => {
      event.stopPropagation();
      const item = state.dataset?.items?.[rowIndex];
      if (!item) return;
      const raw = input.value;

      if (key === 'startTime' || key === 'endTime') {
        item[key] = localInputToUtcIso(raw, getEventTimezone());
      } else {
        item[key] = raw;
      }

      markDirty(true);
      trackQuickSessionChange(rowIndex);

      if (rowIndex === state.selectedIndex) {
        renderSessionForm();
      }
    });

    input.addEventListener('change', (event) => {
      event.stopPropagation();
      if (key === 'startTime' || key === 'endTime') {
        renderSessionList();
      }
    });
  });

  els.sessionList.querySelectorAll('[data-open-session-form]').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      const rowIndex = Number.parseInt(button.dataset.openSessionForm || '-1', 10);
      if (rowIndex < 0) return;
      selectSessionForm(rowIndex, { collapseWorkspace: true });
    });
  });
}

function renderSessionField(field, item) {
  const spanClass = field.span === 2 ? 'md:col-span-2' : '';
  const describedBy = fieldDescriptionAttr('session', field.key, field);

  if (field.key === 'sponsorIds') {
    const linkedIds = parseMultiValue(item[field.key] || '');
    const sponsors = state.dataset?.event?.sponsors || [];
    const linkedSponsors = linkedIds.map((id) => sponsors.find((s) => s.id === id)).filter(Boolean);
    const linkedHtml = linkedSponsors.length
      ? `<div class="space-y-2">${linkedSponsors.map((sponsor) => `
          <div class="editor-linked-item">
            <div class="editor-linked-item-copy">
              <div class="editor-linked-item-title">${escapeHtml(sponsor.title || sponsor.id)}</div>
              <div class="editor-linked-item-meta">${escapeHtml(sponsor.id)}</div>
            </div>
            <button type="button" class="editor-linked-item-action" data-remove-session-sponsor="${escapeAttr(sponsor.id)}" aria-label="Remove ${escapeAttr(sponsor.title || sponsor.id)}">
              <i class="fas fa-trash"></i><span>Remove</span>
            </button>
          </div>
        `).join('')}</div>`
      : '';
    return `
      <div class="${spanClass}">
        <div class="rounded-md border border-gray-700 bg-gray-900/30 px-3 py-3 text-sm text-gray-200 space-y-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <span class="text-xs text-gray-400">${linkedSponsors.length ? `${linkedSponsors.length} linked sponsor${linkedSponsors.length === 1 ? '' : 's'}` : 'No sponsors linked yet.'}</span>
            <button id="addLinkedSessionSponsor" type="button" class="h-9 inline-flex items-center justify-center px-3 border border-gray-300 rounded-md text-xs font-medium text-gray-700 bg-white hover:bg-gray-50 transition-colors whitespace-nowrap">
              <i class="fas fa-plus mr-1.5 text-[0.72rem]"></i>Add sponsor
            </button>
          </div>
          ${linkedHtml}
        </div>
        ${field.description ? `<span id="${escapeAttr(fieldDescriptionId('session', field.key))}" class="editor-field-description">${escapeHtml(field.description)}</span>` : ''}
      </div>
    `;
  }

  if (field.type === 'textarea') {
    const value = toStringValue(item[field.key]);
    const markdownPreview =
      field.key === 'full_description'
        ? `<div class="mt-2 p-3 rounded-md border border-gray-700 bg-gray-900/30">
            <div class="text-xs font-semibold text-gray-400 mb-2">Markdown Preview</div>
            <div data-md-preview="full_description" class="session-description-preview text-sm text-gray-200">${markdownToHtml(value)}</div>
          </div>`
        : '';
    return `
      <label class="editor-form-field ${spanClass}">
        ${renderFieldIntro('session', field.key, field)}
          <textarea data-session-field="${field.key}" rows="${field.key.includes('description') ? 7 : 3}" class="w-full rounded-md border-gray-300 shadow-sm drupal-blue-focus text-sm bg-white px-3 py-2"${describedBy}>${escapeHtml(
          value
        )}</textarea>
        ${markdownPreview}
      </label>
    `;
  }

  if (field.type === 'datetime-local') {
    const localValue = utcIsoToLocalInput(item[field.key], getEventTimezone());
    const tzHint = field.key === 'startTime'
      ? `<span class="editor-tz-note"><i class="fas fa-clock mr-1"></i>Times are shown in <strong>${escapeHtml(getEventTimezone())}</strong></span>`
      : '';
    return `
      <label class="editor-form-field ${spanClass}">
        ${renderFieldIntro('session', field.key, field)}
        ${tzHint}
        <input data-session-field="${field.key}" type="datetime-local" value="${escapeAttr(localValue)}" class="w-full h-11 rounded-md border-gray-300 shadow-sm drupal-blue-focus text-sm bg-white px-3"${describedBy}>
      </label>
    `;
  }

  const value = field.key === 'duration' ? durationToEditorValue(syncSessionDuration(item)) : toStringValue(item[field.key]);
  if (field.key === 'duration') {
    return `
      <label class="editor-form-field ${spanClass}">
        ${renderFieldIntro('session', field.key, field)}
        <input data-session-derived-field="${field.key}" type="text" value="${escapeAttr(value)}" class="w-full h-11 rounded-md border-gray-300 shadow-sm text-sm bg-gray-100 text-gray-600 px-3 cursor-not-allowed" readonly tabindex="-1"${describedBy}>
      </label>
    `;
  }
  if (field.key === 'location') {
    const rooms = [...new Set(
      (state.dataset?.items || [])
        .map((s) => String(s.location || '').trim())
        .filter(Boolean)
    )].sort();
    const datalistHtml = rooms.length
      ? `<datalist id="roomSuggestions">${rooms.map((r) => `<option value="${escapeAttr(r)}">`).join('')}</datalist>`
      : '';
    return `
      <label class="editor-form-field ${spanClass}">
        ${renderFieldIntro('session', field.key, field)}
        <input data-session-field="${field.key}" type="text" value="${escapeAttr(value)}"${rooms.length ? ' list="roomSuggestions"' : ''} class="w-full h-11 rounded-md border-gray-300 shadow-sm drupal-blue-focus text-sm bg-white px-3"${describedBy}>
        ${datalistHtml}
      </label>
    `;
  }

  return `
    <label class="editor-form-field ${spanClass}">
      ${renderFieldIntro('session', field.key, field)}
      <input data-session-field="${field.key}" type="text" value="${escapeAttr(value)}" class="w-full h-11 rounded-md border-gray-300 shadow-sm drupal-blue-focus text-sm bg-white px-3"${describedBy}>
    </label>
  `;
}

function renderSessionForm() {
  const item = state.dataset?.items?.[state.selectedIndex] || null;
  syncSessionEditorPanelVisibility();
  if (!item) {
    els.sessionIndexBadge.textContent = 'No session selected';
    els.sessionForm.innerHTML = '<p class="text-sm text-gray-400">Select a session on the left to edit it.</p>';
    markSessionDirty(false);
    syncSessionSaveButton();
    return;
  }

  if (isQuickSessionEditEnabled()) {
    els.sessionIndexBadge.textContent = `Session ${state.selectedIndex + 1} of ${state.dataset.items.length}`;
    els.sessionForm.innerHTML = `
      <div class="editor-quick-open-state md:col-span-2">
        <div class="editor-quick-open-card">
          <div class="text-sm font-semibold text-gray-100 mb-2">${escapeHtml(item?.title || '(Untitled session)')}</div>
          <p class="text-sm text-gray-400 mb-4">This row is selected in quick edit. Open it to switch back to the full form.</p>
          <button type="button" id="openSelectedSessionForm" class="h-10 inline-flex items-center justify-center px-4 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 transition-colors whitespace-nowrap">
            <i class="fas fa-up-right-from-square mr-2 text-[0.72rem]"></i>Open session
          </button>
        </div>
      </div>
    `;
    const openButton = document.getElementById('openSelectedSessionForm');
    if (openButton) {
      openButton.addEventListener('click', () => {
        selectSessionForm(state.selectedIndex, { collapseWorkspace: true });
      });
    }
    markSessionDirty(state.sessionDirty);
    syncSessionSaveButton();
    return;
  }

  els.sessionIndexBadge.textContent = `Session ${state.selectedIndex + 1} of ${state.dataset.items.length}`;
  syncSessionSaveButton();
  els.sessionForm.innerHTML = SESSION_FIELDS.map((field) => renderSessionField(field, item)).join('');

  els.sessionForm.querySelectorAll('[data-session-field]').forEach((input) => {
    input.addEventListener('focus', undoPush);
    input.addEventListener('input', () => {
      const key = input.dataset.sessionField;
      const raw = input.value;

      if (key === 'track' || key === 'speakers') {
        const values = parseMultiValue(raw);
        item[key] = values.length <= 1 ? (values[0] || '') : values;
      } else if (key === 'startTime' || key === 'endTime') {
        const utcIso = localInputToUtcIso(raw, getEventTimezone());
        item[key] = utcIso;
        syncSessionDuration(item);
        const durationField = els.sessionForm.querySelector('[data-session-derived-field="duration"]');
        if (durationField) durationField.value = durationToEditorValue(item.duration);
      } else {
        item[key] = raw;
        if (key === 'full_description') {
          const markdownPreview = els.sessionForm.querySelector('[data-md-preview="full_description"]');
          if (markdownPreview) markdownPreview.innerHTML = markdownToHtml(raw);
        }
      }

      markDirty(true);
      markSessionDirty(true);
      trackQuickSessionChange(state.selectedIndex);
      renderSessionList();
    });
  });

  const addLinkedSponsorButton = els.sessionForm.querySelector('#addLinkedSessionSponsor');
  if (addLinkedSponsorButton) {
    addLinkedSponsorButton.addEventListener('click', () => openSessionSponsorPicker());
  }

  els.sessionForm.querySelectorAll('[data-remove-session-sponsor]').forEach((button) => {
    button.addEventListener('click', () => {
      removeSponsorFromSession(button.dataset.removeSessionSponsor);
    });
  });
}

async function addSession() {
  if (!state.dataset) return;
  undoPush();
  const seed = state.dataset.items[state.selectedIndex] || {};
  const newItem = {
    title: 'New session',
    startTime: seed.startTime || '',
    endTime: seed.endTime || '',
    location: seed.location || '',
    duration: '',
    track: seed.track || [],
    speakers: [],
    full_description: '',
    sponsorIds: '',
    link: '',
    video_url: ''
  };
  syncSessionDuration(newItem);

  const insertAt = state.selectedIndex >= 0 ? state.selectedIndex + 1 : state.dataset.items.length;
  state.dataset.items.splice(insertAt, 0, newItem);
  state.selectedIndex = insertAt;
  markDirty(true);
  trackQuickSessionChange(state.selectedIndex, true);
  renderSessionList();
  scrollToSessionRow(state.selectedIndex);
  renderSessionForm();
  renderSponsorForm();
  syncSessionSaveButton();
  els.deleteSession.disabled = false;
  await saveDataset();
}

function getSponsorListLabel(sponsor, index) {
  const title = String(sponsor?.title || '').trim() || '(Untitled sponsor)';
  const row = Number.isFinite(Number(sponsor?.row)) ? `Row ${Number(sponsor.row)}` : '';
  const tier = String(sponsor?.tier || '').trim();
  return `${index + 1}. ${title}${tier || row ? ` - ${[tier, row].filter(Boolean).join(' / ')}` : ''}`;
}

function renderSponsorList() {
  const sponsors = state.dataset?.event?.sponsors || [];
  if (!sponsors.length) {
    els.sponsorList.innerHTML = '<li class="text-sm text-gray-400 px-3 py-2 border border-dashed border-gray-700 rounded-md">No sponsors yet.</li>';
    return;
  }

  els.sponsorList.innerHTML = sponsors
    .map((sponsor, index) => {
      const active = index === state.selectedSponsorIndex ? 'border-blue-400 bg-blue-500/20' : 'border-gray-700 bg-gray-900/30';
      if (isQuickSponsorEditEnabled()) {
        return `
          <li draggable="true" data-sponsor-index="${index}" class="sponsor-row session-row-expanded cursor-move px-3 py-3 border rounded-md ${active}">
            <div class="sponsor-row-grid">
              <div class="session-row-handle text-gray-500">
                <i class="fas fa-grip-vertical"></i>
              </div>
              <div class="min-w-0">
                <label class="session-inline-field">
                  <span class="session-inline-label">Title</span>
                  <input
                    data-inline-sponsor-field="title"
                    data-sponsor-index="${index}"
                    type="text"
                    value="${escapeAttr(toStringValue(sponsor?.title))}"
                    class="w-full h-10 rounded-md border-gray-300 shadow-sm drupal-blue-focus text-sm bg-white px-3"
                  >
                </label>
              </div>
              <div>
                <label class="session-inline-field">
                  <span class="session-inline-label">Tier</span>
                  <input
                    data-inline-sponsor-field="tier"
                    data-sponsor-index="${index}"
                    type="text"
                    value="${escapeAttr(toStringValue(sponsor?.tier))}"
                    class="w-full h-10 rounded-md border-gray-300 shadow-sm drupal-blue-focus text-sm bg-white px-3"
                  >
                </label>
              </div>
              <div>
                <label class="session-inline-field">
                  <span class="session-inline-label">Row</span>
                  <input
                    data-inline-sponsor-field="row"
                    data-sponsor-index="${index}"
                    type="number"
                    min="1"
                    step="1"
                    value="${escapeAttr(toStringValue(sponsor?.row))}"
                    class="w-full h-10 rounded-md border-gray-300 shadow-sm drupal-blue-focus text-sm bg-white px-3"
                  >
                </label>
              </div>
              <div>
                <label class="session-inline-field">
                  <span class="session-inline-label">Priority</span>
                  <input
                    data-inline-sponsor-field="priority"
                    data-sponsor-index="${index}"
                    type="number"
                    value="${escapeAttr(toStringValue(sponsor?.priority))}"
                    class="w-full h-10 rounded-md border-gray-300 shadow-sm drupal-blue-focus text-sm bg-white px-3"
                  >
                </label>
              </div>
              <button
                type="button"
                data-open-sponsor-form="${index}"
                class="editor-inline-open h-10 inline-flex items-center justify-center px-3 border border-gray-300 rounded-md text-xs font-medium text-gray-700 bg-white hover:bg-gray-50 transition-colors whitespace-nowrap"
              >
                <i class="fas fa-up-right-from-square mr-1.5 text-[0.72rem]"></i><span>Open</span>
              </button>
            </div>
          </li>
        `;
      }
      return `
        <li draggable="true" data-sponsor-index="${index}" class="sponsor-row cursor-move select-none px-3 py-2 border rounded-md ${active}">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <div class="text-sm font-medium text-gray-100 truncate">${escapeHtml(getSponsorListLabel(sponsor, index))}</div>
              <div class="text-xs text-gray-400 truncate">${escapeHtml([sponsor?.id || '', sponsor?.link || ''].filter(Boolean).join(' | '))}</div>
            </div>
            <i class="fas fa-grip-vertical text-gray-500 mt-1"></i>
          </div>
        </li>
      `;
    })
    .join('');

  els.sponsorList.querySelectorAll('.sponsor-row').forEach((row) => {
    const index = Number.parseInt(row.dataset.sponsorIndex || '-1', 10);

    row.addEventListener('click', async () => {
      if (index === state.selectedSponsorIndex) return;
      selectSponsorForm(index, { collapseWorkspace: state.sponsorListExpanded });
    });

    row.addEventListener('dragstart', (event) => {
      state.draggingSponsorIndex = index;
      row.classList.add('opacity-50');
      event.dataTransfer.effectAllowed = 'move';
    });

    row.addEventListener('dragend', () => {
      state.draggingSponsorIndex = -1;
      row.classList.remove('opacity-50');
      els.sponsorList.querySelectorAll('.sponsor-row').forEach((r) => r.classList.remove('ring-2', 'ring-blue-400'));
    });

    row.addEventListener('dragover', (event) => {
      event.preventDefault();
      row.classList.add('ring-2', 'ring-blue-400');
    });

    row.addEventListener('dragleave', () => {
      row.classList.remove('ring-2', 'ring-blue-400');
    });

    row.addEventListener('drop', (event) => {
      event.preventDefault();
      row.classList.remove('ring-2', 'ring-blue-400');
      const from = state.draggingSponsorIndex;
      const to = index;
      if (from < 0 || to < 0 || from === to) return;

      const moved = state.dataset.event.sponsors.splice(from, 1)[0];
      state.dataset.event.sponsors.splice(to, 0, moved);
      moveTrackedIndex(state.quickEditSponsorChanges, from, to);
      state.selectedSponsorIndex = to;
      markDirty(true);
      trackQuickSponsorChange(to, true);
      renderSponsorList();
      renderSponsorForm();
    });
  });

  const syncSponsorSelectionState = () => {
    els.sponsorList.querySelectorAll('.sponsor-row').forEach((row) => {
      const rowIndex = Number.parseInt(row.dataset.sponsorIndex || '-1', 10);
      const isActive = rowIndex === state.selectedSponsorIndex;
      row.classList.toggle('border-blue-400', isActive);
      row.classList.toggle('bg-blue-500/20', isActive);
      row.classList.toggle('border-gray-700', !isActive);
      row.classList.toggle('bg-gray-900/30', !isActive);
    });
  };

  els.sponsorList.querySelectorAll('[data-inline-sponsor-field]').forEach((input) => {
    const rowIndex = Number.parseInt(input.dataset.sponsorIndex || '-1', 10);
    const key = input.dataset.inlineSponsorField;

    const selectRow = () => {
      if (rowIndex === state.selectedSponsorIndex) return;
      selectSponsorForm(rowIndex);
      syncSponsorSelectionState();
    };

    input.addEventListener('click', (event) => {
      event.stopPropagation();
    });

    input.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
    });

    input.addEventListener('focus', async (event) => {
      event.stopPropagation();
      if (isQuickSponsorEditEnabled()) return;
      await selectRow();
    });

    input.addEventListener('input', (event) => {
      event.stopPropagation();
      const sponsor = state.dataset?.event?.sponsors?.[rowIndex];
      if (!sponsor) return;
      if (key === 'priority') {
        sponsor[key] = Number.parseInt(input.value || '100', 10) || 100;
      } else if (key === 'row') {
        sponsor[key] = Number.parseInt(input.value || '1', 10) || 1;
      } else {
        sponsor[key] = input.value;
      }
      if (key === 'title' && !String(sponsor.id || '').trim()) {
        sponsor.id = normalizeSponsorId(input.value);
      }
      markDirty(true);
      trackQuickSponsorChange(rowIndex);
      if (rowIndex === state.selectedSponsorIndex) {
        renderSponsorForm();
      }
    });
  });

  els.sponsorList.querySelectorAll('[data-open-sponsor-form]').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      const rowIndex = Number.parseInt(button.dataset.openSponsorForm || '-1', 10);
      if (rowIndex < 0) return;
      selectSponsorForm(rowIndex, { collapseWorkspace: true });
    });
  });
}

function renderSponsorField(field, sponsor) {
  const spanClass = field.span === 2 ? 'md:col-span-2' : field.span === 3 ? 'md:col-span-2 xl:col-span-3' : '';
  const describedBy = fieldDescriptionAttr('sponsor', field.key, field);

  if (field.type === 'checkbox') {
    return `
      <label class="editor-form-field ${spanClass}">
        ${renderFieldIntro('sponsor', field.key, field)}
        <span class="h-11 inline-flex items-center gap-3 rounded-md border border-gray-300 px-3 bg-white">
          <input data-sponsor-field="${field.key}" type="checkbox" class="h-4 w-4" ${sponsor[field.key] ? 'checked' : ''}${describedBy}>
          <span class="text-sm text-gray-200">Enabled</span>
        </span>
      </label>
    `;
  }

  if (field.type === 'select') {
    const options = field.options
      .map((option) => `<option value="${escapeAttr(option)}" ${sponsor[field.key] === option ? 'selected' : ''}>${escapeHtml(option)}</option>`)
      .join('');
    return `
      <label class="editor-form-field ${spanClass}">
        ${renderFieldIntro('sponsor', field.key, field)}
        <select data-sponsor-field="${field.key}" class="w-full h-11 pr-10 rounded-md border-gray-300 shadow-sm drupal-blue-focus text-sm bg-white px-3"${describedBy}>${options}</select>
      </label>
    `;
  }

  const type = field.type === 'number' ? 'number' : 'text';
  const numericAttrs = field.type === 'number'
    ? `${field.key === 'row' ? ' min="1" step="1"' : ''}`
    : '';
  return `
    <label class="editor-form-field ${spanClass}">
      ${renderFieldIntro('sponsor', field.key, field)}
      <input data-sponsor-field="${field.key}" type="${type}"${numericAttrs} value="${escapeAttr(toStringValue(sponsor[field.key]))}" class="w-full h-11 rounded-md border-gray-300 shadow-sm drupal-blue-focus text-sm bg-white px-3"${describedBy}>
    </label>
  `;
}

function renderSponsorForm() {
  const sponsor = state.dataset?.event?.sponsors?.[state.selectedSponsorIndex] || null;
  syncSponsorEditorPanelVisibility();
  if (!sponsor) {
    els.sponsorIndexBadge.textContent = 'No sponsor selected';
    els.sponsorForm.innerHTML = '<p class="text-sm text-gray-400">Select a sponsor row to edit it.</p>';
    markSponsorDirty(false);
    syncSponsorSaveButton();
    els.deleteSponsor.disabled = true;
    return;
  }

  if (isQuickSponsorEditEnabled()) {
    els.sponsorIndexBadge.textContent = `Sponsor ${state.selectedSponsorIndex + 1} of ${state.dataset.event.sponsors.length}`;
    els.sponsorForm.innerHTML = `
      <div class="editor-quick-open-state md:col-span-2 xl:col-span-3">
        <div class="editor-quick-open-card">
          <div class="text-sm font-semibold text-gray-100 mb-2">${escapeHtml(getSponsorListLabel(sponsor, state.selectedSponsorIndex))}</div>
          <p class="text-sm text-gray-400 mb-4">This row is selected in quick edit. Open it to switch back to the full sponsor form.</p>
          <button type="button" id="openSelectedSponsorForm" class="h-10 inline-flex items-center justify-center px-4 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 transition-colors whitespace-nowrap">
            <i class="fas fa-up-right-from-square mr-2 text-[0.72rem]"></i>Open sponsor
          </button>
        </div>
      </div>
    `;
    const openButton = document.getElementById('openSelectedSponsorForm');
    if (openButton) {
      openButton.addEventListener('click', async () => {
        selectSponsorForm(state.selectedSponsorIndex, { collapseWorkspace: true });
      });
    }
    markSponsorDirty(state.sponsorDirty);
    syncSponsorSaveButton();
    return;
  }

  const linkedSessions = (state.dataset?.items || [])
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => parseMultiValue(item?.sponsorIds || '').includes(sponsor.id));

  els.sponsorIndexBadge.textContent = `Sponsor ${state.selectedSponsorIndex + 1} of ${state.dataset.event.sponsors.length}`;
  syncSponsorSaveButton();
  els.deleteSponsor.disabled = false;

  if (!state.sponsorEventCounts) {
    const selectedAtLoad = state.selectedSponsorIndex;
    buildSponsorEventCounts()
      .catch(() => { state.sponsorEventCounts = new Map(); })
      .then(() => { if (state.selectedSponsorIndex === selectedAtLoad) renderSponsorForm(); });
  }

  const imageSrc = (sponsor.image || '').trim();
  const bgStyle = sponsor.bgStyle || 'auto';
  const aspect = sponsor.aspect || 'auto';
  const eventCount = getSponsorEventCount(sponsor.title);
  const eventCountDisplay = eventCount === null ? '—' : String(eventCount);

  els.sponsorForm.innerHTML = `
    <div class="col-span-full flex gap-5 items-start">
      <div class="flex-1 min-w-0 grid grid-cols-1 md:grid-cols-2 gap-3">
        ${SPONSOR_FIELDS.filter((f) => f.key !== 'enabled').map((field) => renderSponsorField(field, sponsor)).join('')}
        <div class="editor-form-field md:col-span-2">
          <span class="editor-field-label">Sponsor image</span>
          <span class="editor-field-description">Uploads to <code>img/sponsors/${escapeHtml(
            slugify(state.dataset?.event?.designation || 'event') || 'event'
          )}</code> and stores a relative path.</span>
          <div class="flex items-center gap-2 flex-wrap">
            <label class="h-9 inline-flex items-center gap-2.5 rounded-md border border-gray-300 px-3 bg-white cursor-pointer select-none">
              <input data-sponsor-field="enabled" type="checkbox" class="h-4 w-4" ${sponsor.enabled ? 'checked' : ''}>
              <span class="text-sm text-gray-700">Enabled</span>
            </label>
            <button id="sponsorImageUpload" type="button" class="h-9 inline-flex items-center justify-center px-3 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 transition-colors whitespace-nowrap">
              <i class="fas fa-upload mr-1.5 text-[0.72rem]"></i>Upload image
            </button>
            <button id="sponsorImageClear" type="button" class="h-9 inline-flex items-center justify-center px-3 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-red-50 hover:border-red-300 hover:text-red-600 transition-colors whitespace-nowrap"${!imageSrc ? ' disabled' : ''}>
              <i class="fas fa-trash mr-1.5 text-[0.72rem]"></i>Delete image
            </button>
            <div id="sponsorInlinePreview" class="sponsor-inline-preview sponsor-bg-${escapeAttr(bgStyle)} sponsor-aspect-${escapeAttr(aspect)} ml-auto">
              ${imageSrc
                ? `<img src="${escapeAttr(bustSrc(imageSrc))}" alt="${escapeAttr(sponsor.imageAlt || '')}" class="sponsor-inline-image">`
                : `<i class="fas fa-image sponsor-preview-empty-icon"></i>`}
            </div>
          </div>
        </div>
        <div class="editor-form-field md:col-span-2">
          <span class="editor-field-label">Linked sessions</span>
          <span class="editor-field-description">Manage sessions currently referencing <code>${escapeHtml(sponsor.id || '(missing id)')}</code>.</span>
          <div class="rounded-md border border-gray-700 bg-gray-900/30 px-3 py-3 text-sm text-gray-200 space-y-3">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <span class="text-xs text-gray-400">${linkedSessions.length ? `${linkedSessions.length} linked session${linkedSessions.length === 1 ? '' : 's'}` : 'No sessions linked yet.'}</span>
              <button id="addLinkedSponsorSession" type="button" class="h-9 inline-flex items-center justify-center px-3 border border-gray-300 rounded-md text-xs font-medium text-gray-700 bg-white hover:bg-gray-50 transition-colors whitespace-nowrap">
                <i class="fas fa-plus mr-1.5 text-[0.72rem]"></i>Add session
              </button>
            </div>
            <div class="space-y-2">
              ${linkedSessions.length
                ? linkedSessions.map(({ item, index }) => `
                    <div class="editor-linked-item">
                      <div class="editor-linked-item-copy">
                        <div class="editor-linked-item-title">${escapeHtml(item?.title || '(Untitled session)')}</div>
                        <div class="editor-linked-item-meta">${escapeHtml(formatSponsorLinkedSessionMeta(item, index))}</div>
                      </div>
                      <button type="button" class="editor-linked-item-action" data-remove-linked-session="${index}" aria-label="Remove linked session ${escapeAttr(item?.title || '(Untitled session)')}">
                        <i class="fas fa-trash"></i><span>Remove</span>
                      </button>
                    </div>
                  `).join('')
                : ''}
            </div>
          </div>
        </div>
      </div>

      <aside class="sponsor-editor-sidebar">
        <div id="sponsorPreviewSurface" class="sponsor-preview-surface sponsor-bg-${escapeAttr(bgStyle)} sponsor-aspect-${escapeAttr(aspect)}">
          ${imageSrc
            ? `<img id="sponsorImagePreview" src="${escapeAttr(bustSrc(imageSrc))}" alt="${escapeAttr(sponsor.imageAlt || '')}" class="sponsor-logo-image">`
            : `<div id="sponsorImagePreview" class="sponsor-preview-empty">
                 <i class="fas fa-image text-2xl"></i>
                 <span>No image set</span>
               </div>`}
        </div>
        <div class="sponsor-event-stat">
          <i class="fas fa-trophy sponsor-event-stat-icon"></i>
          <span class="sponsor-event-stat-count">${escapeHtml(eventCountDisplay)}</span>
          <span class="sponsor-event-stat-label">Events Sponsored</span>
        </div>
      </aside>
    </div>
  `;

  els.sponsorForm.querySelectorAll('[data-sponsor-field]').forEach((input) => {
    input.addEventListener('input', () => {
      const key = input.dataset.sponsorField;
      if (key === 'enabled') {
        sponsor[key] = Boolean(input.checked);
      } else if (key === 'priority') {
        sponsor[key] = Number.parseInt(input.value || '100', 10) || 100;
      } else if (key === 'row') {
        sponsor[key] = Number.parseInt(input.value || '1', 10) || 1;
      } else if (key === 'id') {
        const previousId = sponsor.id;
        sponsor.id = normalizeSponsorId(input.value, sponsor.title);
        if (previousId && previousId !== sponsor.id) {
          (state.dataset?.items || []).forEach((item) => {
            const ids = parseMultiValue(item?.sponsorIds || '');
            if (!ids.includes(previousId)) return;
            const nextIds = ids.map((id) => (id === previousId ? sponsor.id : id)).filter(Boolean);
            item.sponsorIds = nextIds.length <= 1 ? (nextIds[0] || '') : nextIds;
          });
          renderSessionForm();
        }
      } else if (key === 'title') {
        sponsor[key] = input.value;
        const countEl = els.sponsorForm.querySelector('.sponsor-event-stat-count');
        if (countEl) {
          const c = getSponsorEventCount(input.value);
          countEl.textContent = c === null ? '—' : String(c);
        }
      } else {
        sponsor[key] = input.value;
      }
      if (key === 'image') {
        const surface = els.sponsorForm.querySelector('#sponsorPreviewSurface');
        const inline = els.sponsorForm.querySelector('#sponsorInlinePreview');
        const newSrc = input.value.trim();
        if (surface) {
          surface.innerHTML = newSrc
            ? `<img id="sponsorImagePreview" src="${escapeAttr(newSrc)}" alt="${escapeAttr(sponsor.imageAlt || '')}" class="sponsor-logo-image">`
            : `<div id="sponsorImagePreview" class="sponsor-preview-empty"><i class="fas fa-image text-2xl"></i><span>No image set</span></div>`;
        }
        if (inline) {
          inline.innerHTML = newSrc
            ? `<img src="${escapeAttr(newSrc)}" alt="${escapeAttr(sponsor.imageAlt || '')}" class="sponsor-inline-image">`
            : `<i class="fas fa-image sponsor-preview-empty-icon"></i>`;
        }
        const clearBtn = els.sponsorForm.querySelector('#sponsorImageClear');
        if (clearBtn) clearBtn.disabled = !newSrc;
      }
      if (key === 'imageAlt') {
        els.sponsorForm.querySelectorAll('#sponsorImagePreview, #sponsorInlinePreview img').forEach((el) => { el.alt = input.value; });
      }
      if (key === 'bgStyle') {
        const val = input.value || 'auto';
        els.sponsorForm.querySelectorAll('#sponsorPreviewSurface, #sponsorInlinePreview').forEach((el) => {
          el.className = el.className.replace(/\bsponsor-bg-\S+/g, `sponsor-bg-${val}`);
        });
      }
      if (key === 'aspect') {
        const val = input.value || 'auto';
        els.sponsorForm.querySelectorAll('#sponsorPreviewSurface, #sponsorInlinePreview').forEach((el) => {
          el.className = el.className.replace(/\bsponsor-aspect-\S+/g, `sponsor-aspect-${val}`);
        });
      }
      markDirty(true);
      markSponsorDirty(true);
      trackQuickSponsorChange(state.selectedSponsorIndex);
      renderSponsorList();
    });
    input.addEventListener('change', () => {
      const key = input.dataset.sponsorField;
      if (key === 'enabled') {
        sponsor[key] = Boolean(input.checked);
        markDirty(true);
        markSponsorDirty(true);
        trackQuickSponsorChange(state.selectedSponsorIndex);
        renderSponsorList();
      }
    });
  });

  const uploadButton = els.sponsorForm.querySelector('#sponsorImageUpload');
  if (uploadButton) {
    uploadButton.addEventListener('click', async () => {
      try {
        await uploadSponsorImageFromPicker(state.selectedSponsorIndex);
      } catch (error) {
        window.alert(`Sponsor image upload failed: ${error.message}`);
      }
    });
  }

  const clearButton = els.sponsorForm.querySelector('#sponsorImageClear');
  if (clearButton) {
    clearButton.addEventListener('click', () => {
      sponsor.image = '';
      sponsor.imageAlt = '';
      markDirty(true);
      markSponsorDirty(true);
      trackQuickSponsorChange(state.selectedSponsorIndex);
      renderSponsorList();
      renderSponsorForm();
    });
  }

  const addLinkedSessionButton = els.sponsorForm.querySelector('#addLinkedSponsorSession');
  if (addLinkedSessionButton) {
    addLinkedSessionButton.addEventListener('click', () => {
      openSponsorSessionPicker();
    });
  }

  els.sponsorForm.querySelectorAll('[data-remove-linked-session]').forEach((button) => {
    button.addEventListener('click', () => {
      const itemIndex = Number.parseInt(button.dataset.removeLinkedSession || '-1', 10);
      removeLinkedSessionFromSponsor(itemIndex);
    });
  });
}

function formatSponsorLinkedSessionMeta(item, index) {
  const bits = [];
  if (item?.startTime) {
    bits.push(utcIsoToLocalInput(item.startTime, getEventTimezone()));
  }
  if (item?.location) {
    bits.push(String(item.location));
  }
  bits.push(`Session ${index + 1}`);
  return bits.filter(Boolean).join(' | ');
}

function getSelectedSponsor() {
  return state.dataset?.event?.sponsors?.[state.selectedSponsorIndex] || null;
}

function getAvailableSessionsForSponsor(sponsor) {
  if (!sponsor) return [];
  return (state.dataset?.items || [])
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !parseMultiValue(item?.sponsorIds || '').includes(sponsor.id));
}

function closeSponsorSessionPicker() {
  if (!els.sponsorSessionPickerModal) return;
  state.sponsorSessionPickerOpen = false;
  els.sponsorSessionPickerModal.classList.add('hidden');
  els.sponsorSessionPickerModal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('session-modal-open');
}

function openSponsorSessionPicker() {
  const sponsor = getSelectedSponsor();
  if (!sponsor || !els.sponsorSessionPickerModal || !els.sponsorSessionPickerList) return;

  const availableSessions = getAvailableSessionsForSponsor(sponsor);
  state.sponsorSessionPickerOpen = true;
  els.sponsorSessionPickerModal.classList.remove('hidden');
  els.sponsorSessionPickerModal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('session-modal-open');
  const titleEl = document.getElementById('sponsorSessionPickerTitle');
  if (titleEl) {
    titleEl.textContent = `Add session to ${sponsor.title || 'sponsor'}`;
  }
  if (els.sponsorSessionPickerCount) {
    els.sponsorSessionPickerCount.textContent = `${availableSessions.length} available`;
  }
  els.sponsorSessionPickerList.innerHTML = availableSessions.length
    ? availableSessions
      .map(({ item, index }) => `
        <article class="speaker-session-card">
          <div>
            <h3 class="speaker-session-title">${escapeHtml(item?.title || '(Untitled session)')}</h3>
            <p class="speaker-session-meta">${escapeHtml(formatSponsorLinkedSessionMeta(item, index))}</p>
          </div>
          <div class="session-modal-links">
            <button type="button" class="session-modal-link" data-add-linked-session="${index}">
              <i class="fas fa-plus"></i><span>Add session</span>
            </button>
          </div>
        </article>
      `)
      .join('')
    : '<p class="speaker-session-summary">All sessions in this event are already linked to this sponsor.</p>';

  els.sponsorSessionPickerList.querySelectorAll('[data-add-linked-session]').forEach((button) => {
    button.addEventListener('click', () => {
      const itemIndex = Number.parseInt(button.dataset.addLinkedSession || '-1', 10);
      addLinkedSessionToSponsor(itemIndex);
    });
  });
}

function addLinkedSessionToSponsor(itemIndex) {
  const sponsor = getSelectedSponsor();
  const item = state.dataset?.items?.[itemIndex];
  if (!sponsor || !item) return;
  const ids = parseMultiValue(item?.sponsorIds || '');
  if (!ids.includes(sponsor.id)) {
    const nextIds = [...ids, sponsor.id].filter(Boolean);
    item.sponsorIds = nextIds.length <= 1 ? (nextIds[0] || '') : nextIds;
    markDirty(true);
    markSessionDirty(true);
    markSponsorDirty(true);
    trackQuickSessionChange(itemIndex);
    trackQuickSponsorChange(state.selectedSponsorIndex);
  }
  closeSponsorSessionPicker();
  renderSponsorForm();
  renderSessionForm();
}

function removeLinkedSessionFromSponsor(itemIndex) {
  const sponsor = getSelectedSponsor();
  const item = state.dataset?.items?.[itemIndex];
  if (!sponsor || !item) return;
  const ids = parseMultiValue(item?.sponsorIds || '').filter((id) => id !== sponsor.id);
  item.sponsorIds = ids.length <= 1 ? (ids[0] || '') : ids;
  markDirty(true);
  markSessionDirty(true);
  markSponsorDirty(true);
  trackQuickSessionChange(itemIndex);
  trackQuickSponsorChange(state.selectedSponsorIndex);
  renderSponsorForm();
  renderSessionForm();
}

function getAvailableSponsorsForSession(item) {
  const linkedIds = parseMultiValue(item?.sponsorIds || '');
  return (state.dataset?.event?.sponsors || [])
    .map((sponsor, index) => ({ sponsor, index }))
    .filter(({ sponsor }) => sponsor.id && !linkedIds.includes(sponsor.id));
}

function openSessionSponsorPicker() {
  const item = state.dataset?.items?.[state.selectedIndex];
  if (!item || !els.sessionSponsorPickerModal || !els.sessionSponsorPickerList) return;
  const availableSponsors = getAvailableSponsorsForSession(item);
  state.sessionSponsorPickerOpen = true;
  els.sessionSponsorPickerModal.classList.remove('hidden');
  els.sessionSponsorPickerModal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('session-modal-open');
  if (els.sessionSponsorPickerCount) {
    els.sessionSponsorPickerCount.textContent = `${availableSponsors.length} available`;
  }
  els.sessionSponsorPickerList.innerHTML = availableSponsors.length
    ? availableSponsors.map(({ sponsor, index }) => `
        <article class="speaker-session-card">
          <div>
            <h3 class="speaker-session-title">${escapeHtml(sponsor.title || sponsor.id || '(Untitled sponsor)')}</h3>
            <p class="speaker-session-meta">${escapeHtml(sponsor.id || '')}</p>
          </div>
          <div class="session-modal-links">
            <button type="button" class="session-modal-link" data-add-session-sponsor="${index}">
              <i class="fas fa-plus"></i><span>Add sponsor</span>
            </button>
          </div>
        </article>
      `).join('')
    : '<p class="speaker-session-summary">All sponsors are already linked to this session.</p>';
  els.sessionSponsorPickerList.querySelectorAll('[data-add-session-sponsor]').forEach((button) => {
    button.addEventListener('click', () => {
      addSponsorToSession(Number.parseInt(button.dataset.addSessionSponsor || '-1', 10));
    });
  });
}

function closeSessionSponsorPicker() {
  if (!els.sessionSponsorPickerModal) return;
  state.sessionSponsorPickerOpen = false;
  els.sessionSponsorPickerModal.classList.add('hidden');
  els.sessionSponsorPickerModal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('session-modal-open');
}

function addSponsorToSession(sponsorIndex) {
  const item = state.dataset?.items?.[state.selectedIndex];
  const sponsor = state.dataset?.event?.sponsors?.[sponsorIndex];
  if (!item || !sponsor?.id) return;
  const ids = parseMultiValue(item?.sponsorIds || '');
  if (!ids.includes(sponsor.id)) {
    undoPush();
    const nextIds = [...ids, sponsor.id].filter(Boolean);
    item.sponsorIds = nextIds.length <= 1 ? (nextIds[0] || '') : nextIds;
    markDirty(true);
    markSessionDirty(true);
    markSponsorDirty(true);
    trackQuickSessionChange(state.selectedIndex);
    trackQuickSponsorChange(state.selectedSponsorIndex);
  }
  closeSessionSponsorPicker();
  renderSessionForm();
  renderSponsorForm();
}

function removeSponsorFromSession(sponsorId) {
  const item = state.dataset?.items?.[state.selectedIndex];
  if (!item || !sponsorId) return;
  undoPush();
  const ids = parseMultiValue(item?.sponsorIds || '');
  const nextIds = ids.filter((id) => id !== sponsorId);
  item.sponsorIds = nextIds.length <= 1 ? (nextIds[0] || '') : nextIds;
  markDirty(true);
  markSessionDirty(true);
  markSponsorDirty(true);
  trackQuickSessionChange(state.selectedIndex);
  renderSessionForm();
  renderSponsorForm();
}

async function addSponsor() {
  if (!state.dataset) return;
  undoPush();
  const sponsors = state.dataset.event.sponsors || (state.dataset.event.sponsors = []);
  const seed = sponsors[state.selectedSponsorIndex] || {};
  const nextNumber = sponsors.length + 1;
  const sponsor = normalizeSponsorObject({
    title: `Sponsor ${nextNumber}`,
    tier: seed.tier || '',
    row: seed.row ?? 1,
    priority: nextNumber * 10,
    bgStyle: 'auto',
    aspect: 'auto',
    enabled: true
  });
  if (!sponsor.id) sponsor.id = `sponsor-${nextNumber}`;
  const insertAt = state.selectedSponsorIndex >= 0 ? state.selectedSponsorIndex + 1 : sponsors.length;
  sponsors.splice(insertAt, 0, sponsor);
  state.selectedSponsorIndex = insertAt;
  markDirty(true);
  trackQuickSponsorChange(state.selectedSponsorIndex, true);
  renderSponsorList();
  scrollToSponsorRow(state.selectedSponsorIndex);
  renderSponsorForm();
  renderSessionForm();
  syncSponsorSaveButton();
  els.deleteSponsor.disabled = false;
  await saveDataset();
}

async function deleteSponsor() {
  const sponsors = state.dataset?.event?.sponsors || [];
  if (state.selectedSponsorIndex < 0 || state.selectedSponsorIndex >= sponsors.length) return;
  const sponsor = sponsors[state.selectedSponsorIndex];
  const okay = window.confirm(`Delete sponsor "${sponsor?.title || 'Untitled'}"?`);
  if (!okay) return;
  undoPush();
  const [removed] = sponsors.splice(state.selectedSponsorIndex, 1);
  removeTrackedIndex(state.quickEditSponsorChanges, state.selectedSponsorIndex);
  if (removed?.id) {
    (state.dataset?.items || []).forEach((item) => {
      const ids = parseMultiValue(item?.sponsorIds || '').filter((id) => id !== removed.id);
      item.sponsorIds = ids.length <= 1 ? (ids[0] || '') : ids;
    });
  }
  if (sponsors.length === 0) {
    state.selectedSponsorIndex = -1;
  } else if (state.selectedSponsorIndex >= sponsors.length) {
    state.selectedSponsorIndex = sponsors.length - 1;
  }
  markDirty(true);
  trackQuickSponsorChange(state.selectedSponsorIndex, true);
  trackQuickSessionChange(-1, true);
  renderSponsorList();
  scrollToSponsorRow(state.selectedSponsorIndex);
  renderSponsorForm();
  renderSessionForm();
  syncSponsorSaveButton();
  els.deleteSponsor.disabled = state.selectedSponsorIndex < 0;
  await saveDataset();
}

async function saveCurrentSponsor() {
  if (!state.dataset) {
    window.alert('No dataset loaded.');
    return;
  }
  if (!isQuickSponsorEditEnabled() && state.selectedSponsorIndex < 0) {
    window.alert('No sponsor selected.');
    return;
  }
  await saveDataset();
}

async function deleteSession() {
  if (!state.dataset || state.selectedIndex < 0) return;
  const item = state.dataset.items[state.selectedIndex];
  const okay = window.confirm(`Delete session "${item?.title || 'Untitled'}"?`);
  if (!okay) return;
  undoPush();
  state.dataset.items.splice(state.selectedIndex, 1);
  removeTrackedIndex(state.quickEditSessionChanges, state.selectedIndex);
  if (state.dataset.items.length === 0) {
    state.selectedIndex = -1;
  } else if (state.selectedIndex >= state.dataset.items.length) {
    state.selectedIndex = state.dataset.items.length - 1;
  }

  markDirty(true);
  trackQuickSessionChange(state.selectedIndex, true);
  trackQuickSponsorChange(-1, true);
  renderSessionList();
  scrollToSessionRow(state.selectedIndex);
  renderSessionForm();
  renderSponsorForm();
  syncSessionSaveButton();
  els.deleteSession.disabled = state.selectedIndex < 0;
  await saveDataset();
}

function duplicateSession(index) {
  if (!state.dataset || index < 0 || index >= state.dataset.items.length) return;
  undoPush();
  const copy = cloneJsonValue(state.dataset.items[index]);
  copy.title = `${copy.title || 'Untitled'} (copy)`;
  state.dataset.items.splice(index + 1, 0, copy);
  state.selectedIndex = index + 1;
  markDirty(true);
  trackQuickSessionChange(index + 1, true);
  renderSessionList();
  scrollToSessionRow(state.selectedIndex);
  renderSessionForm();
  renderSponsorForm();
  syncSessionSaveButton();
  els.deleteSession.disabled = false;
}

function datasetJsonText() {
  stripSummaryFields(state.dataset);
  syncAllSessionDurations();
  return `${JSON.stringify(state.dataset, null, 2)}\n`;
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
    const cleanName = String(raw).trim().toLowerCase().replace(/\.json$/i, '').replace(/[^a-z0-9-]/g, '-') + '.json';
    state.outputPath = `data/${cleanName}`;
    state.file = cleanName;
    setCurrentFilenameLabel();
    await saveViaApi();
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
        accept: { 'application/json': ['.json'] }
      }
    ]
  });

  await writeFileHandle(handle);
  state.fileHandle = handle;
  state.file = handle.name || state.file;
  state.outputPath = replaceOutputBasename(state.outputPath || `data/${state.file}`, state.file);
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
    const errorDetails = formatValidationErrors(errors, state.dataset);
    console.error('Formatted errors:', errorDetails);
    window.alert(
      `Cannot save: dataset has ${errors.length} schema error${errors.length === 1 ? '' : 's'}.\n\n${errorDetails}`
    );
    return;
  }
  console.log('Dataset validation passed, saving...');
  if (isApiMode()) {
    await saveViaApi();
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
    window.alert('No save file linked yet. Use "Open project folder" to connect your folder, or use Save As to choose a file.');
    return;
  }
  if (typeof state.fileHandle.queryPermission === 'function') {
    const permission = await state.fileHandle.queryPermission({ mode: 'readwrite' });
    if (permission !== 'granted') {
      window.alert('Write permission is not available for the linked file. Use Save As to relink.');
      return;
    }
  }
  await writeFileHandle(state.fileHandle);
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

async function saveCurrentSession() {
  if (!state.dataset) {
    window.alert('No dataset loaded.');
    return;
  }
  if (!isQuickSessionEditEnabled() && state.selectedIndex < 0) {
    window.alert('No session selected.');
    return;
  }
  await saveDataset();
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
      const url = isApiMode() ? `${state.apiEndpoint}/api/data/${encodeURIComponent(f)}` : `./data/${f}`;
      return fetch(url).then((r) => r.json());
    })
  );
  const counts = new Map();
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    const sponsors = result.value?.event?.sponsors;
    if (!Array.isArray(sponsors)) continue;
    const seen = new Set(
      sponsors.map((s) => (s.title || '').toLowerCase().trim()).filter(Boolean)
    );
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

function isApiMode() {
  return Boolean(state.apiEndpoint);
}

async function saveViaApi() {
  const filename = outputBasename(state.outputPath) || state.file;
  if (!filename) throw new Error('No output filename configured.');
  const res = await fetch(`${state.apiEndpoint}/api/data/${encodeURIComponent(filename)}`, {
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

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/\n/g, '&#10;');
}

function renderSitemap() {
  const container = document.getElementById('sitemapContent');
  if (!container) return;

  const meta = state.dataset?.event || {};
  const items = state.dataset?.items || [];

  const rawUrl = String(meta.website || meta.scheduleURLs?.[0] || '').trim();
  if (!rawUrl) {
    container.innerHTML = '<p class="text-sm text-gray-400 py-4">No event website URL is configured. Set the <strong>Website</strong> field in the Event tab.</p>';
    return;
  }

  let parsedBase;
  try { parsedBase = new URL(rawUrl); } catch {
    container.innerHTML = `<p class="text-sm text-gray-400 py-4">Could not parse event URL: ${escapeHtml(rawUrl)}</p>`;
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
    const link = String(item?.link || '').trim();
    if (!link || seen.has(link)) return;
    try {
      if (new URL(link).hostname === domain) {
        seen.add(link);
        sessionEntries.push({ title: String(item?.title || '').trim() || '(Untitled)', url: link });
      }
    } catch {}
  });

  const sponsorEntries = [];
  (meta.sponsors || []).forEach((sponsor) => {
    const link = String(sponsor?.link || '').trim();
    if (!link || seen.has(link)) return;
    try {
      if (new URL(link).hostname === domain) {
        seen.add(link);
        sponsorEntries.push({ title: String(sponsor?.title || '').trim() || '(Untitled sponsor)', url: link });
      }
    } catch {}
  });

  const otherUrls = normalizeUrlArray(meta.other_urls).filter(Boolean);

  const total = eventUrls.length + sessionEntries.length + sponsorEntries.length + otherUrls.length;
  const allUrls = [...eventUrls, ...sessionEntries.map(e => e.url), ...sponsorEntries.map(e => e.url), ...otherUrls].join('\n');

  function urlRow(url, label = '') {
    const display = url.replace(/^https?:\/\//, '');
    return `<li class="sitemap-url-item">
      ${label ? `<span class="sitemap-item-label">${escapeHtml(label)}</span>` : ''}
      <a class="sitemap-item-url" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(display)}</a>
    </li>`;
  }

  container.innerHTML = `
    <div class="sitemap-toolbar">
      <span class="sitemap-domain"><i class="fas fa-globe mr-1.5"></i>${escapeHtml(domain)}</span>
      <span class="sitemap-total">${total} URL${total !== 1 ? 's' : ''}</span>
      <button id="sitemapCopyAll" type="button" class="sitemap-copy-btn">
        <i class="fas fa-copy mr-1.5 text-[0.72rem]"></i>Copy all
      </button>
    </div>
    ${eventUrls.length ? `
      <section class="sitemap-section">
        <h3 class="sitemap-section-heading">Event pages <span class="sitemap-count-badge">${eventUrls.length}</span></h3>
        <ul class="sitemap-url-list">${eventUrls.map(u => urlRow(u)).join('')}</ul>
      </section>` : ''}
    ${sessionEntries.length ? `
      <section class="sitemap-section">
        <h3 class="sitemap-section-heading">Sessions <span class="sitemap-count-badge">${sessionEntries.length}</span></h3>
        <ul class="sitemap-url-list">${sessionEntries.map(e => urlRow(e.url, e.title)).join('')}</ul>
      </section>` : ''}
    ${sponsorEntries.length ? `
      <section class="sitemap-section">
        <h3 class="sitemap-section-heading">Sponsors <span class="sitemap-count-badge">${sponsorEntries.length}</span></h3>
        <ul class="sitemap-url-list">${sponsorEntries.map(e => urlRow(e.url, e.title)).join('')}</ul>
      </section>` : ''}
    ${otherUrls.length ? `
      <section class="sitemap-section">
        <h3 class="sitemap-section-heading">Other URLs <span class="sitemap-count-badge">${otherUrls.length}</span></h3>
        <ul class="sitemap-url-list">${otherUrls.map(u => urlRow(u)).join('')}</ul>
      </section>` : ''}
    ${total === 0 ? '<p class="text-sm text-gray-400 py-4">No URLs found for this domain in the dataset.</p>' : ''}
  `;

  document.getElementById('sitemapCopyAll')?.addEventListener('click', () => {
    navigator.clipboard.writeText(allUrls).then(() => {
      const btn = document.getElementById('sitemapCopyAll');
      if (btn) { btn.textContent = 'Copied!'; setTimeout(() => { btn.innerHTML = '<i class="fas fa-copy mr-1.5 text-[0.72rem]"></i>Copy all'; }, 1800); }
    });
  });
}

function doPreview(mode = 'tab') {
  if (!state.dataset) return;
  try {
    localStorage.setItem('__preview__', JSON.stringify(bustDatasetForPreview(state.dataset)));
    if (mode === 'same') {
      if (state.file) localStorage.setItem('__editor_return_file__', state.file);
      window.location.assign('./index.html?preview=1');
    } else {
      window.open('./index.html?preview=1', '_blank');
    }
  } catch (e) {
    window.alert('Could not open preview: ' + e.message);
  }
}

function bindEvents() {
  const welcomeSearch = document.getElementById('welcomeEventSearch');
  if (welcomeSearch) {
    welcomeSearch.addEventListener('input', () => {
      const query = welcomeSearch.value.trim().toLowerCase();
      const eventList = document.getElementById('welcomeEventList');
      if (!eventList) return;
      eventList.querySelectorAll('[data-welcome-load]').forEach((btn) => {
        const label = btn.querySelector('.welcome-btn-label')?.textContent.toLowerCase() ?? '';
        btn.style.display = Boolean(query) && !label.includes(query) ? 'none' : '';
      });
    });
  }

  els.datasetSelect.addEventListener('change', async () => {
    const nextFile = String(els.datasetSelect.value || '').trim();
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

  async function handleConnectFolder() {
    try {
      await connectProjectFolder();
    } catch (error) {
      if (error && error.name === 'AbortError') return;
      window.alert(`Could not open folder: ${error.message}`);
    }
  }

  els.folderConnectionToggle.addEventListener('click', async () => {
    if (state.folderConnectedInSession && state.projectDirHandle) {
      disconnectProjectFolder();
      return;
    }
    await handleConnectFolder();
  });

  const welcomeConnectBtn = document.getElementById('welcomeConnectFolder');
  if (welcomeConnectBtn) {
    welcomeConnectBtn.addEventListener('click', () => handleConnectFolder());
  }

  const welcomeApiSettingsBtn = document.getElementById('welcomeApiSettings');
  if (welcomeApiSettingsBtn) {
    welcomeApiSettingsBtn.addEventListener('click', () => {
      const modal = document.getElementById('apiSettingsModal');
      const input = document.getElementById('apiEndpointInput');
      const result = document.getElementById('apiTestResult');
      if (input) input.value = state.apiEndpoint;
      if (result) { result.textContent = ''; result.className = 'text-sm hidden'; }
      if (modal) { modal.classList.remove('hidden'); modal.setAttribute('aria-hidden', 'false'); }
    });
  }

  const welcomeApiContinueBtn = document.getElementById('welcomeApiContinue');
  if (welcomeApiContinueBtn) {
    welcomeApiContinueBtn.addEventListener('click', () => showWelcomeScreen2());
  }

  const welcomeApiDisconnectBtn = document.getElementById('welcomeApiDisconnectBtn');
  if (welcomeApiDisconnectBtn) {
    welcomeApiDisconnectBtn.addEventListener('click', () => {
      state.apiEndpoint = '';
      localStorage.removeItem('editorApiEndpoint');
      syncApiModeUI();
      setFolderConnectionButtonState();
      syncWelcomeScreen1State();
    });
  }

  const apiSettingsBtn = document.getElementById('apiSettingsBtn');
  const apiSettingsModal = document.getElementById('apiSettingsModal');
  const closeApiSettingsBtn = document.getElementById('closeApiSettings');
  const apiEndpointInput = document.getElementById('apiEndpointInput');
  const apiTestBtn = document.getElementById('apiTestBtn');
  const apiSaveBtn = document.getElementById('apiSaveBtn');
  const apiClearBtn = document.getElementById('apiClearBtn');
  const apiTestResult = document.getElementById('apiTestResult');

  if (apiSettingsBtn && apiSettingsModal) {
    const openApiModal = () => {
      if (apiEndpointInput) apiEndpointInput.value = state.apiEndpoint;
      if (apiTestResult) { apiTestResult.textContent = ''; apiTestResult.className = 'text-sm hidden'; }
      apiSettingsModal.classList.remove('hidden');
      apiSettingsModal.setAttribute('aria-hidden', 'false');
    };
    const closeApiModal = () => {
      apiSettingsModal.classList.add('hidden');
      apiSettingsModal.setAttribute('aria-hidden', 'true');
    };

    apiSettingsBtn.addEventListener('click', openApiModal);
    if (closeApiSettingsBtn) closeApiSettingsBtn.addEventListener('click', closeApiModal);
    apiSettingsModal.addEventListener('click', (e) => { if (e.target === apiSettingsModal) closeApiModal(); });

    if (apiTestBtn && apiEndpointInput && apiTestResult) {
      apiTestBtn.addEventListener('click', async () => {
        const endpoint = apiEndpointInput.value.trim().replace(/\/$/, '');
        if (!endpoint) {
          apiTestResult.textContent = 'Enter an endpoint URL first.';
          apiTestResult.className = 'text-sm text-yellow-600';
          return;
        }
        apiTestBtn.disabled = true;
        apiTestResult.textContent = 'Testing…';
        apiTestResult.className = 'text-sm text-gray-500';
        try {
          const res = await fetch(`${endpoint}/api/health`);
          if (res.ok) {
            apiTestResult.textContent = 'Connected successfully.';
            apiTestResult.className = 'text-sm text-green-600';
          } else {
            apiTestResult.textContent = `Server responded with HTTP ${res.status}.`;
            apiTestResult.className = 'text-sm text-red-600';
          }
        } catch (e) {
          apiTestResult.textContent = `Could not connect: ${e.message}`;
          apiTestResult.className = 'text-sm text-red-600';
        }
        apiTestBtn.disabled = false;
      });
    }

    if (apiSaveBtn && apiEndpointInput) {
      apiSaveBtn.addEventListener('click', async () => {
        const endpoint = apiEndpointInput.value.trim().replace(/\/$/, '');
        state.apiEndpoint = endpoint;
        if (endpoint) {
          localStorage.setItem('editorApiEndpoint', endpoint);
        } else {
          localStorage.removeItem('editorApiEndpoint');
        }
        syncApiModeUI();
        setFolderConnectionButtonState();
        closeApiModal();
        if (endpoint && !state.dataset) {
          await renderDatasetOptionsFromConnectedFolder();
          setDatasetLoadingEnabled(true);
          showWelcomeScreen2();
        } else {
          syncWelcomeScreen1State();
        }
        await refreshEditorSearch();
      });
    }

    if (apiClearBtn) {
      apiClearBtn.addEventListener('click', () => {
        if (apiEndpointInput) apiEndpointInput.value = '';
        state.apiEndpoint = '';
        localStorage.removeItem('editorApiEndpoint');
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

  if (els.exportDataset) {
    els.exportDataset.addEventListener('click', exportDataset);
  }
  if (els.saveSession) {
    els.saveSession.addEventListener('click', async () => {
      try { await saveCurrentSession(); } catch (error) { window.alert(`Save failed: ${error.message}`); }
    });
  }
  if (els.saveSponsor) {
    els.saveSponsor.addEventListener('click', async () => {
      try { await saveCurrentSponsor(); } catch (error) { window.alert(`Save failed: ${error.message}`); }
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

  els.currentFilenameInput.addEventListener('input', () => {
    if (!state.dataset) return;
    const previousKey = getFileLinkKey();
    state.outputPath = normalizeOutputPath(els.currentFilenameInput.value, state.outputPath || 'data/new-event.json');
    els.currentFilenameInput.value = state.outputPath;
    const basename = outputBasename(state.outputPath);
    state.file = basename || state.file;
    state.fileHandle = null;
    void clearLinkedHandle(previousKey).catch(() => {});
    void restoreLinkedHandleForCurrentPath();
    markDirty(true);
  });

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

  if (els.showSitemapTab) {
    els.showSitemapTab.addEventListener('click', async () => {
      switchEditorTab('sitemap');
    });
  }

  if (els.showTimelineTab) {
    els.showTimelineTab.addEventListener('click', async () => {
      switchEditorTab('timeline');
    });
  }

  if (els.showAppearanceTab) {
    els.showAppearanceTab.addEventListener('click', () => {
      switchEditorTab('appearance');
    });
  }

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
      try { await saveDataset(); } catch (e) { window.alert(e?.message || String(e)); }
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
          label: buildDatasetOptionLabel(m.file, m),
          enabled: m.enabled,
        }))
        .sort((a, b) => {
          const ya = Number.parseInt(a.year, 10);
          const yb = Number.parseInt(b.year, 10);
          if (Number.isFinite(ya) && Number.isFinite(yb) && ya !== yb) return yb - ya;
          return a.label.localeCompare(b.label);
        });
    }

    // Non-API mode (no folder connected): fetch index and individual metadata via static URLs.
    // (handles the case where loadEventCatalog() failed or was memoized before the server was reachable)
    const res = await fetch('./data/index.json');
    if (!res.ok) return [];
    const payload = await res.json();
    const files = (Array.isArray(payload?.files) ? payload.files : [])
      .map((e) => (typeof e === 'string' ? e : e?.file))
      .filter((f) => f && isEditorDatasetFile(f));
    if (files.length === 0) return [];
    const records = await loadDatasetMetaForGroupingViaFetch(files);
    return _mapApiSearchRecords(records);
  } catch {
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
        const designation = String(meta.designation || '').trim();
        const year = String(meta.year || '').trim();
        const location = String(meta.location || '').trim();
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
          region: String(meta.region || '').trim(),
          venue: String(meta.venue || '').trim(),
          label,
          enabled: meta.enabled !== false,
        };
      } catch {
        return null;
      }
    })
  );

  return entries
    .filter(Boolean)
    .sort((a, b) => {
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
  await loadThemes();
  applyThemeClass(getCurrentThemeId());

  if (!isLocalhost()) {
    els.blocked.classList.remove('hidden');
    els.app.classList.add('hidden');
    revealPage();
    return;
  }

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
    els.logoForm.innerHTML = '<p class="text-sm text-gray-400">Open a project folder to get started.</p>';
  }
  if (els.flickrForm) {
    els.flickrForm.innerHTML = '<p class="text-sm text-gray-400">Open a project folder to get started.</p>';
  }
  els.sponsorList.innerHTML = '<li class="text-sm text-gray-400 px-3 py-2 border border-dashed border-gray-700 rounded-md">Open a project folder to get started.</li>';
  els.sponsorForm.innerHTML = '<p class="text-sm text-gray-400">Select a sponsor row to edit it.</p>';

  const pendingRecovery = loadRecoverySnapshot();
  if (pendingRecovery) showRecoveryBar(pendingRecovery);

  setInterval(() => {
    if (state.dirty && state.dataset) saveRecoverySnapshot();
  }, 30_000);

  syncWelcomePanel();
  revealPage();
}

void init();
