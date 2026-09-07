// Shared archive-audit engine: scans every event dataset and builds the coverage
// report + the speaker/sponsor identity CLUSTERS (near-duplicate names) with enough
// context (which events, years, talks, tiers, logos) to judge whether a cluster is
// really one entity. Used by both the CLI audit (scripts/audit-archive.mjs) and the
// editor's curation endpoints. Pure aside from reading the data dir.
//
// Curation decisions live in CURATION_ROOT/decisions.json (private — the ledger
// names real people; see lib/roots.js):
//   { aliases: { "<normKey>": "<canonical name/title>" },   // variants → one name
//     distinct: ["<normKey>", …] }                            // asserted NOT the same
// Applying them makes the audit smarter: resolved clusters stop being flagged.

import { existsSync } from 'node:fs';
import { readFile as readFileP, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CURATION_ROOT, LEGACY_CURATION_ROOT } from './roots.js';

export const str = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());
export const has = (v) => str(v).length > 0;

// Collapse a name for de-duplication: lowercase, strip accents, drop company
// suffixes and punctuation. "Acquia Inc." and "acquia" → "acquia".
export function normName(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(inc|incorporated|ltd|limited|llc|gmbh|b\.?v|pty|co)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// A stronger de-dup key: normName with its words SORTED, so word-order variants
// collide too \u2014 "G\u00e1bor Hojtsy" and "Hojtsy G\u00e1bor" both fingerprint to "gabor hojtsy"
// (common with reversed given/family name order). Clusters + the read-time `canon`
// use this so those pairs surface as one identity to reconcile.
export function fingerprint(s) {
  return normName(s).split(' ').filter(Boolean).sort().join(' ');
}

export function imgPath(appDir, p) {
  const rel = String(p || '').replace(/^\.?\//, '');
  return rel ? join(appDir, rel) : '';
}

// ── The decisions store ──────────────────────────────────────────────────────
// Reading and writing the ledger is separated from deciding what it should
// contain, because WHERE it lives depends on the caller. The CLI audit reads the
// file beside the datasets; the server reads S3 first, since a container's disk
// does not survive a deploy and this file is the only record of the curation
// work. Both get the same decision logic by passing a different store.
//
/** @typedef {{ read(): Promise<string|null>, write(text: string): Promise<void> }} DecisionStore */

/**
 * The default store: the file on local disk.
 *
 * The ledger lives under CURATION_ROOT (private), not beside the datasets. Reads
 * fall back to the legacy public location so an existing install keeps its
 * decisions; writes only ever land in the new one, so the first decision after an
 * upgrade migrates the ledger and the old copy goes inert.
 *
 * Takes no arguments on purpose. It used to take `dataDir` — and every caller
 * that never touched the ledger threaded that parameter through anyway, purely so
 * this function could build one path from it.
 *
 * @returns {DecisionStore}
 */
export function diskDecisionStore() {
  const file = join(CURATION_ROOT, 'decisions.json');
  const legacy = join(LEGACY_CURATION_ROOT, 'decisions.json');
  return {
    async read() {
      try {
        return await readFileP(file, 'utf8');
      } catch {
        if (legacy === file) return null;
        try {
          return await readFileP(legacy, 'utf8');
        } catch {
          return null;
        }
      }
    },
    async write(text) {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, text, 'utf8');
    },
  };
}

/** Tolerant parse — a missing or malformed ledger is an empty one, never a throw. */
/** A plain object, or {}. An ARRAY is typeof 'object' and truthy, so a ledger
 *  holding `"series": []` would otherwise survive as an array and break every
 *  lookup on it. */
const plainObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

export function parseDecisions(raw) {
  try {
    const d = JSON.parse(raw ?? '');
    return {
      aliases: plainObject(d?.aliases),
      distinct: Array.isArray(d?.distinct) ? d.distinct : [],
      // Coverage decisions: `<file>::<check>` → { state, until, note }. Same
      // ledger as identity because it is the same kind of fact — a judgement a
      // person made about the archive that must outlive the container.
      snoozes: plainObject(d?.snoozes),
      // Series lineage: `<event file>` → the series it BELONGS to, which is not
      // always what it was called. Two DrupalSouth editions were marketed as
      // Drupal Down Under (2011.drupaldownunder.org, 2012.drupaldownunder.org);
      // DrupalGov 2020 ran on drupalsouth.org while 2013–2017 stood alone.
      // Per event, not per designation, because a series can change hands
      // mid-run and a per-designation rule cannot say that.
      series: plainObject(d?.series),
    };
  } catch {
    return { aliases: {}, distinct: [], snoozes: {}, series: {} };
  }
}

export function serializeDecisions(d) {
  return (
    JSON.stringify(
      {
        aliases: d.aliases || {},
        distinct: d.distinct || [],
        snoozes: d.snoozes || {},
        series: d.series || {},
      },
      null,
      2,
    ) + '\n'
  );
}

/** Record one decision. Pure — takes a ledger, returns the next one. */
export function applyDecision(current, { type, key, canonical, state, until, note } = {}) {
  const next = {
    aliases: { ...(current.aliases || {}) },
    distinct: [...(current.distinct || [])],
    snoozes: { ...(current.snoozes || {}) },
    series: { ...(current.series || {}) },
  };
  if (type === 'alias' && key) next.aliases[key] = canonical || key;
  if (type === 'distinct' && key && !next.distinct.includes(key)) next.distinct.push(key);
  // A coverage decision with no state is the "open this back up" case: drop the
  // record rather than storing a third state meaning "never mind".
  if (type === 'coverage' && key) {
    if (!state) delete next.snoozes[key];
    else next.snoozes[key] = { state, ...(until ? { until } : {}), ...(note ? { note } : {}) };
  }
  // Clearing is sending no canonical — an event that belongs to no wider series
  // is the normal case, so it is an absence rather than a stored "none".
  if (type === 'series' && key) {
    if (!canonical) delete next.series[key];
    else next.series[key] = canonical;
  }
  return next;
}

/** Take one decision back. Pure. */
export function dropDecision(current, { type, key } = {}) {
  const next = {
    aliases: { ...(current.aliases || {}) },
    distinct: [...(current.distinct || [])],
    snoozes: { ...(current.snoozes || {}) },
    series: { ...(current.series || {}) },
  };
  if (type === 'alias' && key) delete next.aliases[key];
  if (type === 'distinct' && key) next.distinct = next.distinct.filter((k) => k !== key);
  if (type === 'coverage' && key) delete next.snoozes[key];
  if (type === 'series' && key) delete next.series[key];
  return next;
}

export async function loadDecisions(store) {
  const raw = await (store || diskDecisionStore()).read();
  const d = parseDecisions(raw);
  return {
    aliases: d.aliases,
    distinct: new Set(d.distinct),
    snoozes: d.snoozes,
    series: d.series,
  };
}

function existsCb(appDir, p) {
  const full = imgPath(appDir, p);
  return full ? existsSync(full) : false;
}

// Scan the whole archive once. Returns per-event coverage + raw occurrence maps for
// speakers/sponsors (each occurrence keeps its context for the cluster view).
export async function scanArchive(dataDir, appDir) {
  const catalog = JSON.parse(await readFileP(join(dataDir, 'catalog.json'), 'utf8'));
  const files = (catalog.events || []).map((e) => e.file).filter(Boolean);

  const events = [];
  const speakers = new Map(); // normKey → { key, variants: Map<name,{name,count,events:Map>} }
  const sponsors = new Map(); // normKey → { key, variants: Map<title,{title,ids:Set,count,events:Map>} }
  // Community credits (organisers + volunteers). Not clustered — they are keyed by
  // drupal.org username, so they have no duplicate-spelling problem of their own.
  // They are scanned because an ALIAS reaches them: curation maps display names,
  // and a name that appears as both a speaker and a volunteer is exactly the case
  // where an undo needs to show you what it is about to un-merge.
  const people = new Map();
  const brokenImages = [];

  const addVariant = (bucket, key, name) => {
    if (!bucket.has(key)) bucket.set(key, { key, variants: new Map() });
    const grp = bucket.get(key);
    if (!grp.variants.has(name))
      grp.variants.set(name, {
        name,
        count: 0,
        events: new Map(),
        ids: new Set(),
        roles: new Set(),
      });
    return grp.variants.get(name);
  };

  for (const file of files) {
    let data;
    try {
      data = JSON.parse(await readFileP(join(dataDir, file), 'utf8'));
    } catch {
      continue;
    }
    const ev = data.event || {};
    const label = [ev.designation, ev.location, ev.year].filter(Boolean).join(' ') || file;
    const items = Array.isArray(data.items) ? data.items : [];

    // coverage bits (mirrors the CLI)
    const metaFields = ['logo', 'venue', 'location', 'dates', 'region', 'website', 'timezone'];
    const metaPresent = (f) =>
      f === 'logo'
        ? !!(ev.logo?.image || ev.logo?.faIcon)
        : f === 'dates'
          ? has(ev.startDate) && has(ev.endDate)
          : has(ev[f]);
    const missingMeta = metaFields.filter((f) => !metaPresent(f));
    let sSpeaker = 0;
    let sTrack = 0;
    let sTime = 0;
    let sDesc = 0;
    const trackOk = (t) => (Array.isArray(t) ? t.length > 0 : has(t));
    for (const s of items) {
      if (Array.isArray(s.speakers) ? s.speakers.length : has(s.speakers)) sSpeaker++;
      if (trackOk(s.track)) sTrack++;
      if (has(s.startTime)) sTime++;
      if (has(s.full_description) || has(s.description)) sDesc++;
      // speaker occurrences (with the talk title for context)
      for (const sp of s.speakers || []) {
        const name = str(typeof sp === 'string' ? sp : sp?.name);
        const key = fingerprint(name);
        if (!key) continue;
        const v = addVariant(speakers, key, name);
        v.count++;
        if (!v.events.has(file))
          v.events.set(file, { label, year: ev.year || '', file, talks: [] });
        if (s.title) v.events.get(file).talks.push(str(s.title));
      }
    }
    if (ev.logo?.image && !existsCb(appDir, ev.logo.image))
      brokenImages.push({ event: label, kind: 'logo', title: label, path: ev.logo.image });

    // sponsor occurrences (with tier + logo for context)
    for (const sp of Array.isArray(ev.sponsors) ? ev.sponsors : []) {
      const title = str(sp.title) || str(sp.id) || 'sponsor';
      const key = fingerprint(title);
      if (has(sp.image) && !existsCb(appDir, sp.image))
        brokenImages.push({ event: label, kind: 'sponsor', title, path: sp.image });
      if (!key) continue;
      const v = addVariant(sponsors, key, title);
      v.count++;
      if (sp.id) v.ids.add(sp.id);
      if (!v.events.has(file))
        v.events.set(file, {
          label,
          year: ev.year || '',
          file,
          tier: str(sp.tier),
          image: str(sp.image),
        });
    }

    // community credits (role kept, so an impact line can say WHICH hat this was)
    for (const p of Array.isArray(ev.community?.people) ? ev.community.people : []) {
      const name = str(p?.name) || str(p?.username);
      const key = fingerprint(name);
      if (!key) continue;
      const v = addVariant(people, key, name);
      v.count++;
      v.roles.add(p?.role === 'volunteer' ? 'volunteer' : 'organiser');
      if (!v.events.has(file)) v.events.set(file, { label, year: ev.year || '', file });
    }

    const metaScore = (metaFields.length - missingMeta.length) / metaFields.length;
    const sessionScore =
      items.length === 0 ? 0 : (sSpeaker + sTrack + sTime + sDesc) / (4 * items.length);
    events.push({
      file,
      label,
      year: ev.year || '',
      sessions: items.length,
      missingMeta,
      score: Math.round(100 * (0.55 * metaScore + 0.45 * sessionScore)),
    });
  }
  return { events, speakers, sponsors, people, brokenImages };
}

// What a recorded decision actually covers, per decision key.
//
// A log row can say `kim pepper → Kim Pepper` without saying that the mapping
// merged a conference speaker with an event volunteer. Undo is only reversible in
// the trivial sense unless you can see what you are reversing, so every row carries
// the spellings the key resolves and the weight behind them.
//
// Keyed by the SAME fingerprint the decision is: one lookup per bucket, so this is
// linear in the number of decisions rather than in the size of the archive.
export function decisionImpact({ speakers, sponsors, people }, keys) {
  const out = {};
  for (const key of keys) {
    const rec = { variants: [], talks: 0, sponsorships: 0, credits: 0, events: 0, roles: [] };
    const files = new Set();
    const take = (bucket, field) => {
      for (const v of bucket?.get(key)?.variants.values() || []) {
        rec.variants.push(v.name);
        rec[field] += v.count;
        for (const f of v.events.keys()) files.add(f);
        for (const r of v.roles || []) if (!rec.roles.includes(r)) rec.roles.push(r);
      }
    };
    take(speakers, 'talks');
    take(sponsors, 'sponsorships');
    take(people, 'credits');
    rec.events = files.size;
    // One person can be a speaker AND a volunteer under the same spelling.
    rec.variants = [...new Set(rec.variants)];
    out[key] = rec;
  }
  return out;
}

// Turn a raw occurrence bucket into cluster objects (variants → plain arrays),
// keeping only genuine clusters (>1 distinct spelling) and applying decisions:
// alias-collapsed variants merge under the canonical; distinct-marked keys drop out.
function toClusters(bucket, { aliases, distinct }, kind) {
  const out = [];
  for (const [key, grp] of bucket) {
    if (distinct.has(key)) continue;
    const canonical = aliases[key];
    const variants = [...grp.variants.values()]
      .map((v) => ({
        name: v.name,
        count: v.count,
        ids: [...(v.ids || [])],
        events: [...v.events.values()],
      }))
      .sort((a, b) => b.count - a.count);
    // Already resolved → no longer a cluster to show.
    //
    // The test used to be "every spelling in the data IS the canonical", which
    // never becomes true: an alias is a READ-TIME mapping and the datasets keep
    // their original spellings on purpose. So a cluster stayed flagged after it
    // had been decided, and the audit's headline count could not go down no
    // matter how much curation was done — 115 merges, same 128 clusters.
    //
    // An alias is keyed by the cluster's fingerprint, so it covers every spelling
    // in the cluster AND any new one that arrives later with the same fingerprint.
    // Recording it is what "resolved" means; the decisions log is where it goes to
    // be reviewed or undone.
    if (canonical) continue;
    if (variants.length < 2) continue;
    out.push({
      key,
      kind,
      canonical: canonical || variants[0].name,
      variants,
      eventCount: new Set(variants.flatMap((v) => v.events.map((e) => e.file))).size,
      total: variants.reduce((n, v) => n + v.count, 0),
    });
  }
  // Messiest first (most spellings, then most appearances).
  return out.sort((a, b) => b.variants.length - a.variants.length || b.total - a.total);
}

// Full curation payload for the editor.
export async function buildCurationData(dataDir, appDir, store) {
  const { events, speakers, sponsors, people, brokenImages } = await scanArchive(dataDir, appDir);
  const decisions = await loadDecisions(store);
  const speakerClusters = toClusters(speakers, decisions, 'speaker');
  const sponsorClusters = toClusters(sponsors, decisions, 'sponsor');
  const avg = Math.round(events.reduce((s, e) => s + e.score, 0) / (events.length || 1));
  return {
    stats: {
      events: events.length,
      avgCoverage: avg,
      brokenImages: brokenImages.length,
      speakerClusters: speakerClusters.length,
      sponsorClusters: sponsorClusters.length,
    },
    speakerClusters,
    sponsorClusters,
    brokenImages,
    events: events.sort((a, b) => a.score - b.score),
    // Decisions made so far — powers the desk's overview + decisions log.
    decisions: { aliases: decisions.aliases, distinct: [...decisions.distinct] },
    // What each of those decisions covers, so a log row can be read and undone
    // without leaving the page to find out what it did.
    impact: decisionImpact({ speakers, sponsors, people }, [
      ...Object.keys(decisions.aliases),
      ...decisions.distinct,
    ]),
  };
}

// NOTE: identity reconciliation is MAPPING-ONLY and never rewrites the source
// datasets — the original programmes are preserved verbatim (data preservation is the
// project's founding goal). A merge just records an alias (see saveDecision), applied
// at READ TIME by the Observatory's `canon()`. The old destructive `applyMerge` that
// rewrote dataset JSON was removed on purpose.

// Record a curation decision durably (alias = variants resolved to a canonical;
// distinct = this cluster is genuinely different, stop flagging it).
export async function saveDecision({ type, key, canonical } = {}, store) {
  const s = store || diskDecisionStore();
  const next = applyDecision(parseDecisions(await s.read()), { type, key, canonical });
  await s.write(serializeDecisions(next));
  return next;
}

// Undo a recorded decision (used by the desk's decisions log). Removing a
// `distinct` makes that cluster resurface for review; removing an `alias` drops the
// mapping, so the spellings show separately again. Nothing else has to be reverted:
// a decision only ever existed in this file — the datasets were never touched.
export async function removeDecision({ type, key } = {}, store) {
  const s = store || diskDecisionStore();
  const raw = await s.read();
  if (raw == null) return { aliases: {}, distinct: [] }; // nothing recorded → nothing to undo
  const next = dropDecision(parseDecisions(raw), { type, key });
  await s.write(serializeDecisions(next));
  return next;
}
