// How good the data is, as distinct from how much of it there is.
//
// The coverage report answers "what is missing". It cannot answer "what is here
// but wrong", because every defect it would need to see sits inside a field that
// is technically filled: a description whose paragraphs were flattened into one
// block, a room called "Location Hall C" because a scrape took the field's label
// along with its value, a sponsor logo with no link behind it, an `&amp;` that
// was never decoded. Those all read as present and count towards coverage.
//
// So this is the second half of the same question. Each PROBE is one defect with
// a shape specific enough to detect without guessing, and each finding names the
// sessions it applies to, so the output is a worklist rather than a score.
//
// A probe earns its place by having been found in real data at least once — none
// of these are hypothetical.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { countsAsSession } from './archiveInsights.js';

const text = (v) => String(v || '').trim().length > 0;

/**
 * The defects, in the order they matter: text fidelity first (it is the part a
 * reader actually sees), then structure, then the event's own metadata.
 *
 * `find` returns the offending sessions; the caller counts them. `scope: 'event'`
 * probes look at the event record instead and return a count with no sessions.
 */
const PROBES = [
  {
    key: 'flattened',
    label: 'Flattened descriptions',
    detail:
      'a long description with no blank line — the paragraphs the author wrote were ' +
      'lost by the scrape, and the text renders as one wall',
    repair: 're-derive from the session page',
    find: (ev) =>
      ev.sessions.filter((s) => {
        const d = String(s.full_description || '');
        return d.length > 400 && !d.includes('\n\n');
      }),
  },
  {
    key: 'entities',
    label: 'Undecoded HTML entities',
    detail: 'text still carrying &amp; / &gt; / &nbsp; — the scrape never decoded them',
    repair: 're-derive from the session page',
    find: (ev) =>
      ev.sessions.filter((s) =>
        /&(?:amp|lt|gt|nbsp|quot|#\d+);/.test(String(s.full_description || '')),
      ),
  },
  {
    key: 'truncated-links',
    label: 'Truncated link labels',
    detail:
      'a Markdown link whose text is an ellipsised URL — the page displayed a shortened ' +
      'label and the scrape stored what it saw',
    repair: 're-derive from the session page',
    find: (ev) =>
      ev.sessions.filter((s) => /\[[^\]]*(?:…|\.\.\.)\]\(/.test(String(s.full_description || ''))),
  },
  {
    key: 'boilerplate',
    label: 'Boilerplate descriptions',
    detail:
      'the same short text on many sessions — usually page furniture (a newsletter ' +
      'block, a footer) captured because the session itself had no description',
    repair: 'clear them; the sessions have no description',
    find: (ev) => {
      const counts = new Map();
      for (const s of ev.sessions) {
        const d = String(s.full_description || '').trim();
        if (d && d.length < 200) counts.set(d, (counts.get(d) || 0) + 1);
      }
      // Eight is past coincidence: repeated coffee breaks legitimately share a line,
      // but a dozen different talks do not describe themselves identically.
      const suspect = new Set([...counts].filter(([, n]) => n >= 8).map(([d]) => d));
      return suspect.size
        ? ev.sessions.filter((s) => suspect.has(String(s.full_description || '').trim()))
        : [];
    },
  },
  {
    key: 'double-slash',
    label: 'Malformed session links',
    detail: 'a doubled slash after the host — every one of these redirects before it resolves',
    repair: 'collapse the slash',
    find: (ev) => ev.all.filter((s) => /^https?:\/\/[^/]+\/\//.test(String(s.link || ''))),
  },
  {
    key: 'room-label',
    label: 'Rooms carrying a field label',
    detail: '"Location Hall C" — the scrape took the label and the value together',
    repair: 'strip the leading label',
    find: (ev) => ev.all.filter((s) => /^Location\s+\S/.test(String(s.location || ''))),
  },
  {
    key: 'sponsor-no-link',
    label: 'Sponsors with no link',
    detail: 'a logo with nothing behind it — the sponsor cannot be followed or matched by URL',
    repair: 'take the link from the sponsors page',
    scope: 'event',
    count: (ev) => (ev.event.sponsors || []).filter((s) => !text(s.link)).length,
  },
  {
    key: 'sponsor-no-image',
    label: 'Sponsors with no logo',
    detail: 'recorded by name only — the sponsor grid renders a blank',
    repair: 'extract logos from a capture of the sponsors page',
    scope: 'event',
    count: (ev) => (ev.event.sponsors || []).filter((s) => !text(s.image)).length,
  },
];

/** Session-level fields whose completeness is worth tracking over time. */
const FIELDS = [
  ['descriptions', (s) => text(s.full_description)],
  ['speakers', (s) => (s.speakers || []).length > 0],
  ['tracks', (s) => (s.track || []).length > 0],
  ['rooms', (s) => text(s.location)],
  ['recordings', (s) => text(s.video_url)],
];

/** Event-level metadata, the same way. */
const META = [
  ['sponsors', (e) => (e.sponsors || []).length > 0],
  ['coordinates', (e) => Number.isFinite(e.latitude) && Number.isFinite(e.longitude)],
  ['attendance', (e) => Boolean(e.attendance && Number.isFinite(e.attendance.count))],
  ['community credits', (e) => Boolean(e.community)],
  ['photo album', (e) => text((e.flickr || {}).groupUrl)],
];

const ERAS = [
  [2007, 2012],
  [2013, 2017],
  [2018, 2021],
  [2022, 2030],
];

async function datasetFiles(dir, out = []) {
  for (const name of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) await datasetFiles(p, out);
    else if (name.name.endsWith('.json')) out.push(p);
  }
  return out;
}

const pct = (part, whole) => (whole ? Math.round((1000 * part) / whole) / 10 : 0);

/**
 * Read every dataset once and report both halves: how complete it is, and what is
 * wrong with what is there.
 *
 * @param {string} dataDir path to `app/data`
 * @returns {Promise<{events: object[], probes: object[], fields: object[], meta: object[], eras: object[], series: object[], totals: object}>}
 */
export async function buildQuality(dataDir) {
  const files = await datasetFiles(join(dataDir, 'events'));
  const events = [];

  for (const path of files) {
    let data;
    try {
      data = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      continue; // a dataset that will not parse is the validator's problem, not this one
    }
    const event = data.event || {};
    const all = data.items || [];
    const sessions = all.filter((s) => countsAsSession(s));
    if (!sessions.length) continue;

    const ev = { event, all, sessions };
    const findings = [];
    for (const probe of PROBES) {
      const hits = probe.scope === 'event' ? probe.count(ev) : probe.find(ev).length;
      if (hits)
        findings.push({ key: probe.key, label: probe.label, repair: probe.repair, count: hits });
    }

    const file = path
      .split(`${join(dataDir, 'events')}/`)
      .pop()
      .replace(/\.json$/, '');
    events.push({
      file,
      name: `${event.designation || '?'} ${event.location || '?'} ${String(event.startDate || '').slice(0, 4)}`.trim(),
      year: Number(String(event.startDate || '').slice(0, 4)) || 0,
      series: event.designation || '?',
      sessions: sessions.length,
      fields: Object.fromEntries(FIELDS.map(([k, ok]) => [k, sessions.filter(ok).length])),
      meta: Object.fromEntries(META.map(([k, ok]) => [k, ok(event) ? 1 : 0])),
      findings,
      defects: findings.reduce((n, f) => n + f.count, 0),
    });
  }

  const totalSessions = events.reduce((n, e) => n + e.sessions, 0);
  const sum = (key) => events.reduce((n, e) => n + e.fields[key], 0);

  const fields = FIELDS.map(([k]) => ({
    key: k,
    have: sum(k),
    total: totalSessions,
    pct: pct(sum(k), totalSessions),
  }));
  const meta = META.map(([k]) => {
    const have = events.reduce((n, e) => n + e.meta[k], 0);
    return { key: k, have, total: events.length, pct: pct(have, events.length) };
  });

  const eras = ERAS.map(([lo, hi]) => {
    const grp = events.filter((e) => e.year >= lo && e.year <= hi);
    const n = grp.reduce((x, e) => x + e.sessions, 0);
    return {
      label: `${lo}–${hi === 2030 ? 'now' : hi}`,
      events: grp.length,
      sessions: n,
      descriptions: pct(
        grp.reduce((x, e) => x + e.fields.descriptions, 0),
        n,
      ),
      recordings: pct(
        grp.reduce((x, e) => x + e.fields.recordings, 0),
        n,
      ),
      sponsors: grp.filter((e) => e.meta.sponsors).length,
    };
  }).filter((e) => e.events);

  const bySeries = new Map();
  for (const e of events) {
    const s = bySeries.get(e.series) || {
      series: e.series,
      events: 0,
      sessions: 0,
      descriptions: 0,
      recordings: 0,
    };
    s.events += 1;
    s.sessions += e.sessions;
    s.descriptions += e.fields.descriptions;
    s.recordings += e.fields.recordings;
    bySeries.set(e.series, s);
  }
  const series = [...bySeries.values()]
    .map((s) => ({
      ...s,
      descPct: pct(s.descriptions, s.sessions),
      vidPct: pct(s.recordings, s.sessions),
    }))
    .sort((a, b) => b.sessions - a.sessions);

  const probes = PROBES.map((p) => {
    const hits = events.filter((e) => e.findings.some((f) => f.key === p.key));
    return {
      key: p.key,
      label: p.label,
      detail: p.detail,
      repair: p.repair,
      count: hits.reduce((n, e) => n + e.findings.find((f) => f.key === p.key).count, 0),
      events: hits.length,
      worst: hits
        .map((e) => ({
          file: e.file,
          name: e.name,
          count: e.findings.find((f) => f.key === p.key).count,
        }))
        .sort((a, b) => b.count - a.count),
    };
  }).filter((p) => p.count);

  events.sort((a, b) => b.defects - a.defects || a.name.localeCompare(b.name));
  return {
    events,
    probes,
    fields,
    meta,
    eras,
    series,
    totals: {
      events: events.length,
      sessions: totalSessions,
      defects: probes.reduce((n, p) => n + p.count, 0),
      eventsWithDefects: events.filter((e) => e.defects).length,
    },
  };
}
