export const STORAGE_PREFIX = 'drupalconPlanner_';
export const GLOBAL_KEY     = 'drupalconPlanner_global';
export const PLANNER_VERSION = 2;

export function getPlannerKey(eventFile) {
  return `${STORAGE_PREFIX}${eventFile}`;
}

export function makeItemId(prefix = 'item') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// ── Global (cross-event) store ────────────────────────────────────────────────

export function makeEmptyGlobal() {
  return { teamMembers: [] };
}

export function loadGlobal() {
  try {
    const raw = localStorage.getItem(GLOBAL_KEY);
    if (!raw) return makeEmptyGlobal();
    return { ...makeEmptyGlobal(), ...JSON.parse(raw) };
  } catch {
    return makeEmptyGlobal();
  }
}

export function saveGlobal(data) {
  localStorage.setItem(GLOBAL_KEY, JSON.stringify(data));
}

// ── Per-event planner store ───────────────────────────────────────────────────

export function makeEmptyPlanner(plannerKey, eventFile = '') {
  return {
    _version: PLANNER_VERSION,
    _plannerKey: plannerKey,
    _eventFile: eventFile,
    _displayName: '',
    _lastModified: new Date().toISOString(),
    mode: 'personal',
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
      itinerary: [],
    },
    itinerary: [],
    receipts: [],
    personal: {
      outboundLegs:   [],
      returnLegs:     [],
      accommodations: [],
      budget:         '',
      budgetActual:   '',
      currency:       'AUD',
      notes:          '',
      trackedSessions: [],
      itinerary:      [],
      documents:      [],
      budgetItems:    [],
    },
  };
}

export function loadPlanner(plannerKey, defaultEventFile = '') {
  try {
    const raw = localStorage.getItem(getPlannerKey(plannerKey));
    if (!raw) return makeEmptyPlanner(plannerKey, defaultEventFile);
    const parsed = JSON.parse(raw);
    const empty  = makeEmptyPlanner(plannerKey, parsed._eventFile || defaultEventFile);
    // Strip legacy top-level keys before spreading
    const { trip: _trip, individual: _individual, ...cleanParsed } = parsed;
    return {
      ...empty,
      ...cleanParsed,
      mode: cleanParsed.mode === 'individual' ? 'personal' : cleanParsed.mode,
      org: (() => {
        // Strip org-level legacy/unknown fields (attendees was an early unused feature)
        const { attendees: _att, ...po } = cleanParsed.org || {};
        // Migrate old swag items {label, done} → {name, quantity, budget, actual, currency, done, notes}
        const swag = (po.swag || []).map((item) =>
          item.name !== undefined ? item
            : { ...item, name: item.label || '', quantity: 1, budget: '', actual: '', currency: 'AUD', notes: '' }
        );
        return { ...empty.org, ...po, swag };
      })(),
      itinerary: cleanParsed.itinerary || [],
      receipts:  cleanParsed.receipts  || [],
      personal: (() => {
        const pi = cleanParsed.personal || _individual || {};
        // Strip the old single-object accommodation key; its data has already been migrated to the array
        const { accommodation: _accom, ...cleanPi } = pi;
        let accommodations = Array.isArray(cleanPi.accommodations) ? cleanPi.accommodations : [];
        if (!accommodations.length && _accom && Object.values(_accom).some(Boolean)) {
          const o = _accom;
          accommodations = [{ id: makeItemId('ia'), name: o.name || '', address: o.address || '', checkIn: o.checkIn || '', checkOut: o.checkOut || '', confirmation: o.confirmation || '', budget: o.budget || '', budgetActual: o.budgetActual || '', currency: o.currency || 'AUD', notes: o.notes || '' }];
        }
        return { ...empty.personal, ...cleanPi, accommodations };
      })(),
    };
  } catch {
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
  const json = JSON.stringify({ ...data, _lastModified: new Date().toISOString() }, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const basename = plannerKey.endsWith('.json') ? plannerKey : `${plannerKey}.json`;
  a.download = `planner-${basename}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function parsePlannerImport(jsonText) {
  const parsed = JSON.parse(jsonText); // throws on invalid JSON
  if (!parsed || typeof parsed !== 'object') throw new Error('Not a valid planner file');
  if (!parsed._eventFile && !parsed._plannerKey && !parsed._displayName) throw new Error('Missing identity fields — this does not look like a planner export');
  return parsed;
}

export async function listPlannerFiles(apiEndpoint) {
  const url = `${apiEndpoint.replace(/\/$/, '')}/api/planner`;
  const res = await fetch(url);
  if (!res.ok) return [];
  return res.json();
}

export async function savePlannerViaApi(apiEndpoint, plannerKey, data) {
  const filename = plannerKey.endsWith('.json') ? plannerKey : `${plannerKey}.json`;
  const url = `${apiEndpoint.replace(/\/$/, '')}/api/planner/${filename}`;
  const body = JSON.stringify({ ...data, _lastModified: new Date().toISOString() }, null, 2);
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return true;
}
