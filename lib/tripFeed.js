// Server-side calendar feed for a planner. Resolves a planner by its UUID, loads
// its associated event dataset(s) to reconstruct tracked-session times, and renders
// the whole trip to an .ics using the SAME pure builders the client uses. Kept out
// of server.js so it can be unit-tested against fixtures.

import { readFile, readdir, stat } from 'fs/promises';
import { join, resolve, sep, basename } from 'path';
import {
  buildTripCalEvents,
  buildIcsCalendar,
  scheduleSessionsToCalEvents,
} from '../app/js/modules/plannerCalendar.js';

// Same session id the client derives (planner.js loadOneSchedule / makeSessionId):
// `${startTime}-${location}-${title}` slugified. Must match so trackedSessions
// (which store only sessionId) resolve to the right session.
const makeSessionId = (s) =>
  `${s.startTime}-${s.location}-${s.title}`.replace(/[^a-zA-Z0-9-]/g, '-');

function safeJoin(base, sub) {
  const full = resolve(join(base, sub));
  return full === base || full.startsWith(base + sep) ? full : null;
}
async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// A planner stores the nested dataset path (e.g. "events/ddd/2025-leuven.json").
// Older planners saved a flattened name — map those back via the catalog, mirroring
// the client's resolveEventFile.
async function resolveDatasetPath(file, dataDir) {
  const direct = safeJoin(dataDir, file);
  if (direct && (await exists(direct))) return direct;
  try {
    const catalog = JSON.parse(await readFile(join(dataDir, 'catalog.json'), 'utf8'));
    const files = (catalog.events || []).map((e) => e.file).filter(Boolean);
    const flatten = (f) => f.replace(/^events\//, '').replace(/\//g, '-');
    const match = files.find((f) => flatten(f) === file);
    if (match) {
      const p = safeJoin(dataDir, match);
      if (p && (await exists(p))) return p;
    }
  } catch {
    /* no catalog / unreadable → give up on this file */
  }
  return null;
}

// Load every associated event's sessions (id-tagged) + the primary event timezone.
async function loadEventData(eventFiles, dataDir) {
  let timezone = '';
  const sessions = [];
  for (let i = 0; i < eventFiles.length; i++) {
    const path = await resolveDatasetPath(eventFiles[i], dataDir);
    if (!path) continue;
    try {
      const data = JSON.parse(await readFile(path, 'utf8'));
      if (!timezone) timezone = data.event?.timezone || '';
      (data.items || []).forEach((s) => sessions.push({ ...s, id: makeSessionId(s) }));
    } catch {
      /* skip a corrupt dataset, keep the rest */
    }
  }
  return { sessions, timezone };
}

// Whole-trip .ics for a loaded planner object. Pure aside from the dataset reads.
export async function buildPlannerFeedIcs(planner, { dataDir } = {}) {
  const eventFiles =
    planner?._eventFiles?.length > 0
      ? planner._eventFiles
      : planner?._eventFile
        ? [planner._eventFile]
        : [];
  const { sessions, timezone } = await loadEventData(eventFiles, dataDir);
  // redactRefs: keep booking references (PNRs / confirmation numbers) OUT of the
  // public feed — a leaked link exposes the schedule, never booking credentials.
  const events = buildTripCalEvents(planner, {
    allSessions: sessions,
    timezone,
    include: {},
    redactRefs: true,
  });
  const calName = String(planner?._displayName || 'My trip').trim() || 'My trip';
  // 6h refresh hint — a change lands in the attendee's calendar within hours
  // (the in-app Now/Next covers the live minute-by-minute layer).
  return buildIcsCalendar(events, { calName, uidFor: (ev) => ev.uid, refreshMinutes: 360 });
}

// Public calendar feed of an ENTIRE event's programme (every session), for the
// schedule page's "subscribe to all sessions". No token — it's the same public
// data the schedule shows. `eventParam` is whitelisted against the catalog so it
// can't be used to read arbitrary files. Returns { ics, path } or null (→ 404).
export async function buildEventScheduleIcs(eventParam, { dataDir } = {}) {
  if (!eventParam) return null;
  let catalog;
  try {
    catalog = JSON.parse(await readFile(join(dataDir, 'catalog.json'), 'utf8'));
  } catch {
    return null;
  }
  const files = (catalog.events || []).map((e) => e.file).filter(Boolean);
  const flatten = (f) => f.replace(/^events\//, '').replace(/\//g, '-');
  // Whitelist: the request must name a known catalog dataset (nested or flattened).
  const match = files.find((f) => f === eventParam || flatten(f) === eventParam);
  if (!match) return null;
  const path = safeJoin(dataDir, match);
  if (!path) return null;
  let data;
  try {
    data = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
  const meta = data.event || {};
  const tz = meta.timezone || '';
  // Event map location: the dataset's own coords, else the geocode cache (see
  // scripts/geocode-events.mjs) — so a session gets a real map pin, not a blank.
  let geocache = {};
  try {
    geocache = JSON.parse(await readFile(join(dataDir, 'geocache.json'), 'utf8'));
  } catch {
    /* no geocache → sessions just carry text locations */
  }
  const place = [meta.venue, meta.location].filter((x) => x && String(x).trim()).join(', ');
  const evCoords = (() => {
    if (Number.isFinite(meta.latitude) && Number.isFinite(meta.longitude))
      return { lat: meta.latitude, lon: meta.longitude };
    const g = geocache[String(meta.location || '').trim()];
    return g && Number.isFinite(g.lat) ? { lat: g.lat, lon: g.lon } : null;
  })();
  // Tag items with the same session id the client derives, then map via the SHARED
  // builder so the feed and the schedule-page download produce identical VEVENTs.
  const items = (data.items || []).map((s) => ({ ...s, id: makeSessionId(s) }));
  const events = scheduleSessionsToCalEvents(items, {
    timezone: tz,
    place,
    coords: evCoords,
    uidBase: match,
  });
  const calName =
    [meta.designation, meta.location, meta.year].filter(Boolean).join(' ') || 'Schedule';
  // 12h refresh — a published programme changes far less often than a live trip.
  const ics = buildIcsCalendar(events, { calName, uidFor: (ev) => ev.uid, refreshMinutes: 720 });
  return { ics, path };
}

// Yield every stored planner (root files + one level of per-user subdirs, for
// multi-user mode) so we can find one by its UUID.
async function* scanPlanners(plannerDir) {
  let entries;
  try {
    entries = await readdir(plannerDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent.isFile() && ent.name.endsWith('.json')) {
      const path = join(plannerDir, ent.name);
      const planner = await readJsonSafe(path);
      if (planner) yield { planner, userId: null, file: ent.name, path };
    } else if (ent.isDirectory()) {
      let sub;
      try {
        sub = await readdir(join(plannerDir, ent.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const f of sub) {
        if (f.isFile() && f.name.endsWith('.json')) {
          const path = join(plannerDir, ent.name, f.name);
          const planner = await readJsonSafe(path);
          if (planner) yield { planner, userId: ent.name, file: f.name, path };
        }
      }
    }
  }
}
async function readJsonSafe(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

// A short-TTL in-memory index (uuid → file path) so the directory scan runs at most
// ~once/minute regardless of request volume — an unauthenticated poller (valid OR
// bogus uuid) can't amplify into a full scan per hit.
let _idxCache = { at: 0, dir: '', map: null };
const IDX_TTL_MS = 60_000;
async function getIndex(plannerDir) {
  const warm =
    _idxCache.map && _idxCache.dir === plannerDir && Date.now() - _idxCache.at < IDX_TTL_MS;
  if (warm) return _idxCache.map;
  const map = new Map();
  for await (const rec of scanPlanners(plannerDir)) {
    if (rec.planner?._id) map.set(rec.planner._id, rec.path);
  }
  _idxCache = { at: Date.now(), dir: plannerDir, map };
  return map;
}

// Find the planner whose `_id` matches `uuid`. The matched file is re-read fresh so
// token rotation / edits take effect immediately; only the scan is cached. A newly
// created planner becomes resolvable within the index TTL (≤ 60s).
export async function findPlannerById(uuid, { plannerDir } = {}) {
  if (!uuid) return null;
  const map = await getIndex(plannerDir);
  const path = map.get(uuid);
  if (!path) return null; // unknown id → answered from the cached index, no rescan
  const planner = await readJsonSafe(path);
  if (planner?._id !== uuid) {
    _idxCache = { at: 0, dir: '', map: null }; // stale mapping → rebuild next call
    return null;
  }
  return { planner, path, file: basename(path) };
}
