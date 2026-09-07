// What each event is missing, and whether anyone still wants to be told.
//
// The audit already scores coverage, but a score is not a worklist: it says an
// event is at 66% without saying that 92 of its sessions have no description and
// 74 of those carry a link you could fetch one from. This turns the same scan
// into per-event, per-CHECK rows with a count, a fixable count, and a state.
//
// The state is the part that makes it usable twice. Some gaps will never close —
// DrupalCon Barcelona 2007 has no session recordings and never will — and a
// worklist that keeps reporting them trains you to ignore it. So a check can be
// `ignored` (never applicable here) or snoozed until a date (`later`), and both
// live in the curation ledger beside the identity decisions, for the same reason:
// a container's disk does not survive a deploy.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { countsAsSession } from './archiveInsights.js';
import { loadDecisions } from './archiveAudit.js';

/**
 * The checks, in the order a person would work through them: can this event be
 * read at all, then what it says, then what surrounds it.
 *
 * `fixable` counts the subset you could act on today — a session with no
 * description but WITH a link is a scrape away; one with neither needs a human
 * who was in the room.
 */
const CHECKS = [
  {
    key: 'sessions',
    label: 'Sessions',
    detail: 'the programme itself',
    test: (ev) => ({ missing: ev.sessions.length ? 0 : 1, total: 1, fixable: 0 }),
  },
  {
    key: 'descriptions',
    label: 'Descriptions',
    detail: 'what each session was about — feeds search and the topic charts',
    // Scrapable: the session page is where this field came from in the first place.
    fetchable: true,
    gap: (s) => !text(s.full_description),
    test: (ev) => {
      const missing = ev.sessions.filter((s) => !text(s.full_description));
      return {
        missing: missing.length,
        total: ev.sessions.length,
        fixable: missing.filter((s) => text(s.link)).length,
      };
    },
  },
  {
    key: 'speakers',
    label: 'Speakers',
    detail: 'who gave each session',
    test: (ev) => {
      const missing = ev.sessions.filter((s) => !(s.speakers || []).length);
      return { missing: missing.length, total: ev.sessions.length, fixable: 0 };
    },
  },
  {
    key: 'videos',
    label: 'Recordings',
    // Only answerable after the event: nothing is recorded, counted or photographed
    // in advance. Before then it is pending, not missing.
    after: true,
    detail: 'the session on video',
    fetchable: true,
    gap: (s) => !text(s.video_url),
    test: (ev) => {
      const missing = ev.sessions.filter((s) => !text(s.video_url));
      return {
        missing: missing.length,
        total: ev.sessions.length,
        fixable: missing.filter((s) => text(s.link)).length,
      };
    },
  },
  {
    key: 'tracks',
    label: 'Tracks',
    detail: 'the organisers’ own grouping',
    test: (ev) => ({
      missing: ev.sessions.filter((s) => !(s.track || []).length).length,
      total: ev.sessions.length,
      fixable: 0,
    }),
  },
  {
    key: 'links',
    label: 'Session links',
    detail: 'the page each session came from — what everything else is backfilled through',
    test: (ev) => ({
      missing: ev.sessions.filter((s) => !text(s.link)).length,
      total: ev.sessions.length,
      fixable: 0,
    }),
  },
  {
    key: 'sponsors',
    label: 'Sponsors',
    detail: 'who paid for it',
    test: (ev) => ({ missing: (ev.event.sponsors || []).length ? 0 : 1, total: 1, fixable: 0 }),
  },
  {
    key: 'credits',
    label: 'Community credits',
    detail: 'organisers and volunteers from the drupal.org event page',
    test: (ev) => ({
      missing: (ev.event.community?.people || []).length ? 0 : 1,
      total: 1,
      fixable: 0,
    }),
  },
  {
    key: 'attendance',
    label: 'Attendance',
    // Only answerable after the event: nothing is recorded, counted or photographed
    // in advance. Before then it is pending, not missing.
    after: true,
    detail: 'the final headcount, as the organisers reported it',
    test: (ev) => ({
      missing: Number.isFinite(ev.event.attendance?.count) ? 0 : 1,
      total: 1,
      fixable: 0,
    }),
  },
  {
    key: 'photos',
    label: 'Photo album',
    // Only answerable after the event: nothing is recorded, counted or photographed
    // in advance. Before then it is pending, not missing.
    after: true,
    detail: 'the event’s own photos',
    test: (ev) => ({
      missing: text(ev.event.flickr?.groupUrl) || text(ev.event.flickr?.url) ? 0 : 1,
      total: 1,
      fixable: 0,
    }),
  },
  {
    key: 'place',
    label: 'Place',
    detail: 'venue and coordinates — without them the event is off every map',
    test: (ev, geo) => {
      const mapped =
        Number.isFinite(ev.event.latitude) || Number.isFinite(geo?.[ev.event.location]?.lat);
      const missing = (text(ev.event.venue) ? 0 : 1) + (mapped ? 0 : 1);
      return { missing, total: 2, fixable: 0 };
    },
  },
  // ── Provenance ──────────────────────────────────────────────────────────
  //
  // The archive's claim is that every fact is traceable. These are the places
  // where it currently is not — and unlike a missing description, nobody sees
  // them by reading a page. The Sources view makes the gaps visible to a
  // reader; these make them workable.
  //
  // Undated sources are deliberately NOT a check here. 258 of them span all 90
  // events, and most cannot be dated at all — much of this archive was gathered
  // before provenance was recorded. A check every event fails is one nobody
  // reads, and it would bury the 59 events that have a real, fixable gap.
  // `pnpm run report:sources` carries that figure instead.
  {
    key: 'sponsorSource',
    label: 'Sponsor listing',
    detail: 'the page that said who sponsored this — sponsors otherwise fall back to the schedule',
    test: (ev) => {
      const sponsors = (ev.event.sponsors || []).length;
      if (!sponsors) return { missing: 0, total: 0, fixable: 0 };
      const listed = (ev.event.sources || []).some((s) => s?.kind === 'sponsors' && s?.url);
      // Fixable today: the sponsors exist and somebody can go and find the page.
      return { missing: listed ? 0 : 1, total: 1, fixable: listed ? 0 : 1 };
    },
  },
  {
    key: 'unsourced',
    label: 'Unsourced records',
    detail: 'sessions, sponsors or people citing nothing at all',
    test: (ev) => {
      const records = [
        ...ev.sessions,
        ...(ev.event.sponsors || []),
        ...(ev.event.community?.people || []),
      ];
      if (!records.length) return { missing: 0, total: 0, fixable: 0 };
      const bare = records.filter((r) => !(Array.isArray(r?.sourceIds) && r.sourceIds.length));
      return { missing: bare.length, total: records.length, fixable: 0 };
    },
  },
];

const text = (v) => String(v || '').trim().length > 0;

/** `<file>::<check>` — one state per gap, not per event: videos may be hopeless while descriptions are not. */
export function snoozeKey(file, check) {
  return `${file}::${check}`;
}

/**
 * Is this check still asking to be looked at?
 *
 * `ignored` is forever, `later` until its date passes. Anything else — including
 * a snooze whose date has come — is open.
 */
export function isOpen(snooze, today = new Date().toISOString().slice(0, 10)) {
  if (!snooze) return true;
  if (snooze.state === 'ignored') return false;
  if (snooze.state === 'later') return !snooze.until || snooze.until <= today;
  return true;
}

async function datasetFiles(dir, out = []) {
  for (const name of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) await datasetFiles(p, out);
    else if (name.name.endsWith('.json')) out.push(p);
  }
  return out;
}

/**
 * Per-event coverage, worst first.
 *
 * @param {string} dataDir
 * @param {*} [store] decisions store (the server passes its S3-backed one)
 * @param {{today?: string}} [opts]
 */
export async function buildCoverage(dataDir, store, { today } = {}) {
  const eventsDir = join(dataDir, 'events');
  const files = await datasetFiles(eventsDir);
  let geo = {};
  try {
    geo = JSON.parse(await readFile(join(dataDir, 'geocache.json'), 'utf8'));
  } catch {
    /* no geocache → every event reads as unmapped, which is the truth */
  }
  const { snoozes = {} } = await loadDecisions(store);

  const events = [];
  for (const path of files) {
    let data;
    try {
      data = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      continue;
    }
    const file = path.slice(path.indexOf('events/'));
    const ev = {
      event: data.event || {},
      sessions: (data.items || []).filter(countsAsSession),
    };
    const label =
      [ev.event.designation, ev.event.location, ev.event.year].filter(Boolean).join(' ') || file;
    // Has the event finished? A conference six weeks away has no recordings, no
    // attendance figure and no photo album — and reporting those as gaps put a
    // future event at the top of a worklist nobody could action, with a score
    // dragged down by facts that do not exist yet.
    const now = today || new Date().toISOString().slice(0, 10);
    const ends = String(ev.event.endDate || ev.event.startDate || '').slice(0, 10);
    const ended = !ends || ends < now;
    const checks = CHECKS.map((c) => {
      const r = c.test(ev, geo);
      const snooze = snoozes[snoozeKey(file, c.key)] || null;
      const pending = !!c.after && !ended;
      return {
        key: c.key,
        label: c.label,
        detail: c.detail,
        missing: r.missing,
        total: r.total,
        fixable: r.fixable,
        pct: r.total ? Math.round(((r.total - r.missing) / r.total) * 100) : 100,
        snooze,
        // Waiting on the event itself, so neither a gap nor a mark against it.
        pending,
        open: !pending && r.missing > 0 && isOpen(snooze, today),
      };
    });
    const open = checks.filter((c) => c.open);
    events.push({
      file,
      label,
      year: Number(ev.event.year) || null,
      series: ev.event.designation || '',
      sessions: ev.sessions.length,
      checks,
      openCount: open.length,
      // GAPS, not sessions: a session missing both its description and its
      // recording is two gaps against one page. Kept because it is the size of
      // the job — but reported as gaps, never as sessions.
      fixable: open.reduce((n, c) => n + c.fixable, 0),
      // SESSIONS whose page would be visited: the union, so the same page is not
      // counted twice. This is the number of fetches, and the honest headline.
      fixableSessions: ev.sessions.filter(
        (sn) =>
          text(sn.link) &&
          CHECKS.filter((c) => c.fetchable).some(
            (c) => c.gap(sn) && open.some((o) => o.key === c.key),
          ),
      ).length,
      // Scored over what CAN be answered today. Averaging in a pending check would
      // score an unheld conference against a recording that cannot exist.
      score: (() => {
        const scored = checks.filter((c) => !c.pending);
        return scored.length
          ? Math.round(scored.reduce((n, c) => n + c.pct, 0) / scored.length)
          : 100;
      })(),
      pending: checks.filter((c) => c.pending).map((c) => c.label),
    });
  }
  events.sort(
    (a, b) => b.openCount - a.openCount || a.score - b.score || a.label.localeCompare(b.label),
  );
  return {
    events,
    checks: CHECKS.map(({ key, label, detail }) => ({ key, label, detail })),
    totals: {
      events: events.length,
      withGaps: events.filter((e) => e.openCount).length,
      fixable: events.reduce((n, e) => n + e.fixable, 0),
      fixableSessions: events.reduce((n, e) => n + e.fixableSessions, 0),
      snoozed: Object.keys(snoozes).length,
    },
  };
}
