export const STORAGE_PREFIX = 'drupalconPlanner_';
export const GLOBAL_KEY = 'drupalconPlanner_global';
export const PLANNER_VERSION = 7;

// A stable per-planner UUID — the external handle a calendar feed URL references
// (and the namespace for stable VEVENT UIDs). Prefers the platform crypto UUID.
export function makeUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ── Storage key registry ──────────────────────────────────────────────────────
// Every localStorage key the app owns, declared in one place. Previously these
// literals were scattered across planner.js / editor.js / s3Settings.js — the
// deleted-planners key was even defined twice under different names, which is
// exactly the kind of drift this registry prevents. Per-event and global planner
// stores keep their existing keys via getPlannerKey()/GLOBAL_KEY above.
export const STORAGE_KEYS = {
  // Planner app
  deletedPlanners: `${STORAGE_PREFIX}_deleted`, // was DELETED_KEY / DELETED_SLUGS_KEY
  rates: '__plannerRates_v2__',
  geocodeCache: 'drupalconPlanner_geocache',
  sectionCollapse: 'plannerSectionCollapse',
  storageNoticeDismissed: 'plannerStorageNoticeDismissed',
  sidebarCollapsed: 'plannerSidebarCollapsed',
  scheduleInstructionsDismissed: 'scheduleInstructionsDismissed',
  // Index / schedule app
  selectedEventFile: 'selectedEventFile',
  themeMode: 'scheduleThemeMode', // mirrored by THEME_STORAGE_KEY in theme.js
  // Mode is its own axis from the brand work: 'light' | 'dark' | '' (follow OS).
  // Distinct from themeMode, which names a legacy palette id.
  colourMode: 'scheduleColourMode',
  currentThemeId: 'scheduleCurrentThemeId',
  themeOverride: 'scheduleThemeOverride', // explicit viewer pick (wins over the event's theme)
  // Editor app
  editorApiEndpoint: 'editorApiEndpoint',
  editorRecovery: '__editor_recovery__',
  photosBackup: '__photos_prev__',
  logoBackup: '__logo_prev__',
  projectDirHandle: '__project_dir_handle__',
  editorReturnFile: '__editor_return_file__',
  editorRecentFiles: '__editor_recent_files__',
  preview: '__preview__',
};

export function getPlannerKey(eventFile) {
  return `${STORAGE_PREFIX}${eventFile}`;
}

export function makeItemId(prefix = 'item') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// ── Generic localStorage helpers ──────────────────────────────────────────────
// Single choke point for reads/writes so every access is guarded consistently
// (absent/corrupt → fallback, quota/unavailable → best-effort no-op) and no
// module needs to touch localStorage directly.

export function readJson(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const parsed = JSON.parse(raw);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback; // absent or corrupt → caller's fallback
  }
}

export function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false; // storage full/unavailable → best-effort
  }
}

export function readText(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : raw;
  } catch {
    return fallback;
  }
}

export function writeText(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function removeKey(key) {
  try {
    localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

// Enumerate stored keys beginning with `prefix`. Centralizes the raw
// localStorage.length / localStorage.key(i) iteration so callers that need to
// scan all planner entries don't reach into localStorage directly.
export function listKeys(prefix = '') {
  const keys = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key != null && key.startsWith(prefix)) keys.push(key);
    }
  } catch {
    // Storage unavailable → no keys.
  }
  return keys;
}

// Slugs that share the STORAGE_PREFIX but are never planner data.
const NON_PLANNER_SLUGS = new Set(['geocache', 'rates', 'exchangerates']);

// Display name for a stored planner: its explicit label, else a name derived from
// its event file, else the plannerKey de-slugified.
export function plannerDisplayName(planner, plannerKey) {
  if (planner?._displayName) return planner._displayName;
  if (planner?._eventFile) return (planner._eventFile || '').replace('.json', '');
  return (plannerKey || '').replace(/^planner-/, '').replace(/-/g, ' ');
}

// True only for a slug+data pair that represents actual planner data (used when
// listing stored planners so cache/rate entries are skipped).
export function isPlannerEntry(slug, data) {
  if (NON_PLANNER_SLUGS.has(slug)) return false;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  return !!(data._displayName || data._eventFile || data.mode || data.personal || data.org);
}

// ── Exchange-rate cache persistence ───────────────────────────────────────────
// The rate cache is stored as one JSON object keyed by `${base}:${date}`. These
// wrappers are consumed by the currency logic (extracted in a later step).

export function loadRates() {
  return readJson(STORAGE_KEYS.rates, {}) || {};
}

export function saveRates(rateMapObject) {
  return writeJson(STORAGE_KEYS.rates, rateMapObject);
}

// ── Global (cross-event) store ────────────────────────────────────────────────

export function makeEmptyGlobal() {
  return {
    teamMembers: [],
    defaultCurrency: '',
    budgetCategories: [],
    defaultMode: '',
    personalContacts: [],
    tempUnit: 'C',
  };
}

export function loadGlobal() {
  try {
    const raw = localStorage.getItem(GLOBAL_KEY);
    if (!raw) return makeEmptyGlobal();
    return { ...makeEmptyGlobal(), ...JSON.parse(raw) };
  } catch {
    // Absent or corrupt storage → start from an empty global store.
    return makeEmptyGlobal();
  }
}

export function saveGlobal(data) {
  localStorage.setItem(GLOBAL_KEY, JSON.stringify(data));
}

// ── Per-event planner store ───────────────────────────────────────────────────

// Keep the multi-event association coherent: `_eventFiles` is the source of truth
// (a de-duped list of associated event paths) and `_eventFile` mirrors the first
// entry (the "primary" event that drives timezone/theme/weather/header). Older
// planners have only `_eventFile` — derive the list from it. Mutates + returns the
// planner. Safe to call repeatedly (idempotent).
export function normalizeEventFiles(planner) {
  if (!planner || typeof planner !== 'object') return planner;
  let files = Array.isArray(planner._eventFiles) ? planner._eventFiles.slice() : [];
  if (!files.length && planner._eventFile) files = [planner._eventFile];
  // Drop blanks and duplicates while preserving order (primary first).
  const seen = new Set();
  files = files.filter((f) => f && typeof f === 'string' && !seen.has(f) && seen.add(f));
  planner._eventFiles = files;
  planner._eventFile = files[0] || '';
  return planner;
}

export function makeEmptyPlanner(plannerKey, eventFile = '') {
  return {
    _version: PLANNER_VERSION,
    _id: makeUuid(),
    _plannerKey: plannerKey,
    _eventFile: eventFile,
    _eventFiles: eventFile ? [eventFile] : [],
    _displayName: '',
    _lastModified: new Date().toISOString(),
    mode: 'personal',
    isConference: true,
    // Preferred roll-up currency for totals; '' falls back to the trip currency.
    // The create form seeds this from the user's global default.
    displayCurrency: '',
    sessionNotes: {},
    contacts: [],
    tasks: [],
    org: {
      boothInfo: '',
      boothNotes: '',
      teamAssignments: [],
      accommodations: [],
      timeline: { startDate: '', endDate: '' },
      swag: [],
      deliverables: [],
      sponsorBudget: '',
      sponsorActual: '',
      sponsorCurrency: 'AUD',
      sponsorId: '',
      trackedSessions: [],
      autoAddedSponsoredSessions: [],
      documents: [],
      budgetItems: [],
      budgetCategories: [],
      categoryBudgets: {},
      tickets: [],
      disabledTabs: ['weather'],
      tabOrder: [],
      itinerary: [],
      memberItinerary: [],
      checklists: [],
    },
    receipts: [],
    personal: {
      outboundLegs: [],
      returnLegs: [],
      localLegs: [],
      accommodations: [],
      budget: '',
      budgetActual: '',
      currency: 'AUD',
      notes: '',
      noteList: [],
      trackedSessions: [],
      hostedEvents: [],
      itinerary: [],
      documents: [],
      budgetItems: [],
      budgetCategories: [],
      categoryBudgets: {},
      tickets: [],
      disabledTabs: ['weather'],
      tabOrder: [],
      tripAssignments: [],
      localCompanions: [],
      splitExpenses: [],
      checklists: [],
      gpxTrack: null,
      meContactId: null,
    },
  };
}

// v5 migration — "receipts as the single financial primitive". Moves every
// cost-bearing entity's money onto a newly-created linked receipt (`entity.receiptId`)
// and clears the entity's own cost fields. Value-preserving for the summary's ACTUAL
// totals (each receipt carries the entity's actual and the summary reads it back into
// the same category); per-entity PLANNED budgets are intentionally dropped (receipts
// are actuals only — category budgets remain the planned targets). Originals are
// stashed in `planner._preMigrationFinancials` for in-app recovery.
//
// Deliberately NOT migrated: budget items (already receipt-backed via `budgetItemId`),
// shared-cost splits (already amount records), the "My travel" lump + org sponsor
// totals (aggregates, not entities), and travel legs (already carry a receipt).
export function migrateFinancialsToReceipts(planner) {
  if (!planner || typeof planner !== 'object') return planner;
  const receipts = (planner.receipts = Array.isArray(planner.receipts) ? planner.receipts : []);
  const mode = planner.mode || 'personal';
  const p = planner.personal || {};
  const o = planner.org || {};
  const defCurr = mode === 'sponsor' ? o.sponsorCurrency || 'AUD' : p.currency || 'AUD';
  const num = (v) => {
    const n = parseFloat(String(v ?? ''));
    return Number.isNaN(n) ? 0 : n;
  };
  const stash = [];

  // Create a receipt from an entity and link it; stash + clear the entity's cost
  // fields. Skips entities already linked or with no cost. Returns true if migrated.
  const move = (entity, { name, amount, currency, date, category, keys, kind, id }) => {
    if (!entity || entity.receiptId || !amount) return false;
    const rc = {
      id: makeItemId('rc'),
      name: name || 'Receipt',
      date: date || '',
      amount: String(amount),
      currency: currency || defCurr,
      category: category || 'misc',
      budgetItemId: '',
      filePath: '',
      fileLabel: '',
      notes: '',
    };
    receipts.push(rc);
    entity.receiptId = rc.id;
    const before = {};
    keys.forEach((k) => {
      before[k] = entity[k];
    });
    stash.push({ kind, id: id || entity.id || '', receiptId: rc.id, fields: before });
    keys.forEach((k) => {
      delete entity[k];
    });
    return true;
  };

  // Personal itinerary items → Misc
  (p.itinerary || []).forEach((it) =>
    move(it, {
      name: it.title || 'Itinerary item',
      amount: num(it.actual),
      currency: it.currency,
      date: it.purchaseDate || it.date || '',
      category: 'misc',
      keys: ['budget', 'actual', 'currency', 'purchaseDate'],
      kind: 'itinerary',
    }),
  );

  // Tickets (personal + org): cost = unitPrice × quantity. Keep `quantity` (it's the
  // pass count, descriptive) — only the money (unitPrice) moves to the receipt.
  const migrateTickets = (list) =>
    (list || []).forEach((t) =>
      move(t, {
        name: t.name || 'Ticket',
        amount: num(t.unitPrice) * (num(t.quantity) || 1),
        currency: t.currency,
        date: t.purchaseDate || '',
        category: 'tickets',
        keys: ['unitPrice', 'currency', 'purchaseDate'],
        kind: 'ticket',
      }),
    );
  migrateTickets(p.tickets);
  migrateTickets(o.tickets);

  // Accommodation: each per-member stay, then the accommodation-level cost.
  const migrateAccom = (list) =>
    (list || []).forEach((acc) => {
      (acc.assignments || []).forEach((stay) =>
        move(stay, {
          name: acc.name || 'Accommodation',
          amount: num(stay.budgetActual),
          currency: stay.currency || acc.currency,
          date: stay.purchaseDate || acc.purchaseDate || '',
          category: 'accommodation',
          keys: ['budget', 'budgetActual', 'currency', 'purchaseDate'],
          kind: 'accom-stay',
          id: `${acc.id || ''}:${stay.memberId || ''}`,
        }),
      );
      move(acc, {
        name: acc.name || 'Accommodation',
        amount: num(acc.budgetActual),
        currency: acc.currency,
        date: acc.purchaseDate || '',
        category: 'accommodation',
        keys: ['budget', 'budgetActual', 'currency', 'purchaseDate'],
        kind: 'accom',
      });
    });
  migrateAccom(p.accommodations);
  migrateAccom(o.accommodations);

  // Org team assignments → Travel
  (o.teamAssignments || []).forEach((a) =>
    move(a, {
      name: 'Team travel',
      amount: num(a.budgetActual),
      currency: a.currency,
      date: a.purchaseDate || '',
      category: 'travel',
      keys: ['budget', 'budgetActual', 'currency', 'purchaseDate'],
      kind: 'team-assignment',
      id: a.memberId,
    }),
  );

  // Org swag → Swag
  (o.swag || []).forEach((s) =>
    move(s, {
      name: s.name || 'Swag',
      amount: num(s.actual),
      currency: s.currency,
      date: '',
      category: 'swag',
      keys: ['budget', 'actual', 'currency'],
      kind: 'swag',
    }),
  );

  // Org itinerary → Team
  (o.itinerary || []).forEach((it) =>
    move(it, {
      name: it.title || 'Team event',
      amount: num(it.actual),
      currency: it.currency,
      date: it.purchaseDate || '',
      category: 'team',
      keys: ['budget', 'actual', 'currency', 'purchaseDate'],
      kind: 'org-itinerary',
    }),
  );

  if (stash.length) planner._preMigrationFinancials = stash;
  return planner;
}

// v6 migration — retire the personal "My travel" trip-budget lump. `personal.budget`
// (planned) becomes a normal "Travel" budget line item; `personal.budgetActual` (spend)
// becomes a receipt linked to it (Pattern A: actual = sum of linked receipts). The
// originals are cleared and stashed. Idempotent-guarded by the version stamp.
export function migratePersonalTravelToLineItem(planner) {
  if (!planner || typeof planner !== 'object') return planner;
  const p = planner.personal;
  if (!p) return planner;
  const num = (v) => {
    const n = parseFloat(String(v ?? ''));
    return Number.isNaN(n) ? 0 : n;
  };
  const budget = num(p.budget);
  const actual = num(p.budgetActual);
  if (!budget && !actual) {
    // Nothing to migrate, but still drop any empty lump fields.
    delete p.budget;
    delete p.budgetActual;
    delete p.purchaseDate;
    return planner;
  }
  const curr = p.currency || 'AUD';
  const items = (p.budgetItems = Array.isArray(p.budgetItems) ? p.budgetItems : []);
  const item = {
    id: makeItemId('bi'),
    name: 'Travel',
    category: 'travel',
    currency: curr,
    budget: budget ? String(budget) : '',
    notes: '',
    memberId: '',
  };
  items.push(item);
  if (actual) {
    const receipts = (planner.receipts = Array.isArray(planner.receipts) ? planner.receipts : []);
    receipts.push({
      id: makeItemId('rc'),
      name: 'Travel',
      date: p.purchaseDate || '',
      amount: String(actual),
      currency: curr,
      category: 'travel',
      budgetItemId: item.id,
      filePath: '',
      fileLabel: '',
      notes: '',
    });
  }
  const stash = planner._preMigrationFinancials || [];
  stash.push({
    kind: 'my-travel-lump',
    id: '',
    budgetItemId: item.id,
    fields: { budget: p.budget, budgetActual: p.budgetActual, purchaseDate: p.purchaseDate },
  });
  planner._preMigrationFinancials = stash;
  delete p.budget;
  delete p.budgetActual;
  delete p.purchaseDate;
  return planner;
}

export function loadPlanner(plannerKey, defaultEventFile = '') {
  try {
    const raw = localStorage.getItem(getPlannerKey(plannerKey));
    if (!raw) return makeEmptyPlanner(plannerKey, defaultEventFile);
    const parsed = JSON.parse(raw);
    const empty = makeEmptyPlanner(plannerKey, parsed._eventFile || defaultEventFile);
    // Strip legacy top-level keys before spreading
    const {
      trip: _trip,
      individual: _individual,
      itinerary: _legacyItinerary,
      ...cleanParsed
    } = parsed;
    const merged = {
      ...empty,
      ...cleanParsed,
      mode: cleanParsed.mode === 'individual' ? 'personal' : cleanParsed.mode,
      org: (() => {
        // Strip org-level legacy/unknown fields (attendees was an early unused feature)
        const { attendees: _att, ...po } = cleanParsed.org || {};
        // Migrate old swag items {label, done} → {name, quantity, budget, actual, currency, done, notes}
        const swag = (po.swag || []).map((item) =>
          item.name !== undefined
            ? item
            : {
                ...item,
                name: item.label || '',
                quantity: 1,
                budget: '',
                actual: '',
                currency: 'AUD',
                notes: '',
              },
        );
        // Migrate v2 top-level itinerary (team-member items) into org.memberItinerary
        const memberItinerary = po.memberItinerary || _legacyItinerary || [];
        return { ...empty.org, ...po, swag, memberItinerary };
      })(),
      receipts: cleanParsed.receipts || [],
      personal: (() => {
        const pi = cleanParsed.personal || _individual || {};
        // Strip the old single-object accommodation key; its data has already been migrated to the array
        const { accommodation: _accom, ...cleanPi } = pi;
        let accommodations = Array.isArray(cleanPi.accommodations) ? cleanPi.accommodations : [];
        if (!accommodations.length && _accom && Object.values(_accom).some(Boolean)) {
          const o = _accom;
          accommodations = [
            {
              id: makeItemId('ia'),
              name: o.name || '',
              address: o.address || '',
              checkIn: o.checkIn || '',
              checkOut: o.checkOut || '',
              confirmation: o.confirmation || '',
              budget: o.budget || '',
              budgetActual: o.budgetActual || '',
              currency: o.currency || 'AUD',
              notes: o.notes || '',
            },
          ];
        }
        // Migrate the old single free-text `notes` string into a discrete note list.
        let noteList = Array.isArray(cleanPi.noteList) ? cleanPi.noteList : [];
        if (!noteList.length && typeof cleanPi.notes === 'string' && cleanPi.notes.trim()) {
          noteList = [{ id: makeItemId('note'), title: '', body: cleanPi.notes }];
        }
        return { ...empty.personal, ...cleanPi, accommodations, noteList, notes: '' };
      })(),
    };
    // v4: the Weather tab is opt-in (disabled by default). Disable it on planners
    // that predate v4 so it stays hidden until the user enables it in Settings.
    if (!(parsed._version >= 4)) {
      for (const c of [merged.personal, merged.org]) {
        if (c && Array.isArray(c.disabledTabs) && !c.disabledTabs.includes('weather')) {
          c.disabledTabs = [...c.disabledTabs, 'weather'];
        }
      }
    }
    // v5: consolidate every entity's cost onto a linked receipt (see
    // migrateFinancialsToReceipts). Value-preserving for the summary's actuals.
    const financialsMigrated = !(parsed._version >= 5);
    if (financialsMigrated) migrateFinancialsToReceipts(merged);
    // v6: retire the personal "My travel" trip-budget lump — turn it into a normal
    // "Travel" budget line item (planned) + a linked receipt (actual).
    const travelMigrated = !(parsed._version >= 6);
    if (travelMigrated) migratePersonalTravelToLineItem(merged);
    // v7: every planner gets a stable UUID (the merge base already supplied a fresh
    // one; flag it so it's persisted below and stays stable across loads).
    const idAssigned = !parsed._id;
    // Stamp the current version once any migration has run.
    if (!(parsed._version >= PLANNER_VERSION)) merged._version = PLANNER_VERSION;
    // Multi-event: derive `_eventFiles` from a legacy single `_eventFile` and keep
    // the two in sync (primary = first).
    normalizeEventFiles(merged);
    // The financial migration is NOT idempotent (it creates receipts) — persist the
    // migrated blob immediately so a subsequent load doesn't re-run it on the still
    // -unsaved v4 data and create duplicate receipts.
    if (financialsMigrated || travelMigrated || idAssigned) savePlanner(plannerKey, merged);
    return merged;
  } catch {
    // Absent or corrupt storage → start from an empty planner.
    return makeEmptyPlanner(plannerKey, defaultEventFile);
  }
}

export function savePlanner(plannerKey, data) {
  const toSave = { ...data, _lastModified: new Date().toISOString() };
  localStorage.setItem(getPlannerKey(plannerKey), JSON.stringify(toSave));
}

// Derives the same session ID used by events.js line 982
export function makeSessionId(session) {
  return `${session.startTime}-${session.location}-${session.title}`.replace(/[^a-zA-Z0-9-]/g, '-');
}

export function exportPlannerJson(plannerKey, data) {
  // Subscriptions never ride along in a shared backup. `_feeds` holds only
  // SHA-256 hashes, so it is not a credential — but it does list the reader's
  // devices and when each last polled, which is nobody else's business. The
  // legacy `_feedToken` WAS a live bearer credential and is still stripped in
  // case an old planner is imported and re-exported.
  const { _feedToken: _dropToken, _feeds: _dropFeeds, ...safe } = data;
  const json = JSON.stringify({ ...safe, _lastModified: new Date().toISOString() }, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `planner-${plannerFilename(plannerKey)}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// Map a planner key to its flat on-disk filename. Keys are usually clean slugs,
// but a schedule-linked planner can carry an event-file *path* as its key
// (e.g. "events/drupalcon/eu/2026-rotterdam.json"). Collapse any path separators
// so a planner is always ONE flat file in planner/, never a nested path — which
// could land in a non-writable/root-owned subdirectory and fail to save (EACCES).
export function plannerFilename(plannerKey) {
  const key = String(plannerKey || '');
  const withJson = key.endsWith('.json') ? key : `${key}.json`;
  return withJson.replace(/[\\/]+/g, '-').replace(/^-+/, '');
}

export function parsePlannerImport(jsonText) {
  const parsed = JSON.parse(jsonText); // throws on invalid JSON
  if (!parsed || typeof parsed !== 'object') throw new Error('Not a valid planner file');
  if (!parsed._eventFile && !parsed._plannerKey && !parsed._displayName)
    throw new Error('Missing identity fields — this does not look like a planner export');
  return parsed;
}

export async function listPlannerFiles(apiEndpoint) {
  const url = `${apiEndpoint.replace(/\/$/, '')}/api/planner`;
  const res = await fetch(url);
  if (!res.ok) return [];
  return res.json();
}

// Best-effort per-collection receipt sync via the v1 CRUD API. The whole-blob save
// (savePlannerViaApi, a manual "Save to file") stays authoritative and reconciles any
// drift; this just pushes an individual receipt change to the server immediately so it
// isn't stranded in localStorage until the next manual save.
//
// `op` is 'upsert' (create or edit) or 'delete'. Upsert uses PUT (idempotent, id
// preserved) and falls back to POST when the element doesn't exist yet — so it never
// duplicates a receipt the blob save already wrote. Delete tolerates a missing element.
// Throws on genuine failures; callers treat it as best-effort and swallow errors.
export async function saveReceiptViaApi(apiEndpoint, plannerKey, op, receipt) {
  const base = (apiEndpoint || '').replace(/\/$/, '');
  const file = plannerFilename(plannerKey); // e.g. "trip.json"
  const coll = `${base}/api/v1/planners/${file}/receipts`;
  const id = receipt?.id;
  if (op === 'delete') {
    if (!id) return false;
    const res = await fetch(`${coll}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
    return true;
  }
  // upsert: PUT the element; if it doesn't exist yet (404) POST to create it.
  if (!id) return false;
  const body = JSON.stringify(receipt);
  const put = await fetch(`${coll}/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (put.ok) return true;
  if (put.status !== 404) throw new Error(`HTTP ${put.status}`);
  const post = await fetch(coll, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!post.ok) throw new Error(`HTTP ${post.status}`);
  return true;
}

export async function savePlannerViaApi(apiEndpoint, plannerKey, data) {
  const filename = plannerFilename(plannerKey);
  // An empty endpoint means "the server hosting this app" — a root-relative,
  // same-origin PUT (this is how planner *reads* already work). A configured
  // endpoint is only needed to target a different/remote server.
  const base = (apiEndpoint || '').replace(/\/$/, '');
  const url = `${base}/api/planner/${filename}`;
  const body = JSON.stringify({ ...data, _lastModified: new Date().toISOString() }, null, 2);
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const e = new Error(err.message || err.error || `HTTP ${res.status}`);
    e.code = err.error;
    e.status = res.status;
    // Schema validation failures (422) carry a per-field error list — keep it so
    // the caller can render it instead of a bare message.
    e.errors = err.errors || null;
    throw e;
  }
  return true;
}
