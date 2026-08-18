// Session search across the whole archive.
//
// The insights payload deliberately carries no session titles or descriptions —
// it is a compact index of term membership, and adding 6,500 descriptions to it
// would multiply a payload the client already downloads in full. Searching text
// therefore happens here, over the datasets on disk, and returns only matches.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { countsAsSession, sessionMinutes } from './archiveInsights.js';

async function datasetFiles(dir, out = []) {
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    if ((await stat(path)).isDirectory()) await datasetFiles(path, out);
    else if (name.endsWith('.json')) out.push(path);
  }
  return out;
}

const norm = (v) => String(v || '').toLowerCase();

/**
 * The searchable text reduced to space-separated words, padded at both ends.
 *
 * This is how "exact words" matching is done without regex lookbehind (Safari
 * only grew it in 16.4): every run of non-letter/non-digit becomes one space, so
 * a term wrapped in spaces can only match on word boundaries. " ai " is in
 * " artificial intelligence ai the good " and is NOT in " maintain the standard ".
 */
function wordText(v) {
  return ` ${norm(v)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()} `;
}

/**
 * Does `haystack` match `term` under this mode?
 *
 * `contains` is the original rule and stays the default: substring matching is
 * what makes a phrase like "display suite" behave as a reader expects. Its cost
 * is that a short term has no word boundary — "ai" matches "maintain", "email",
 * "available", and a search for it returned 2,824 sessions of which a handful
 * were about AI. `exact` is the answer to that, per search rather than per term,
 * because only the person typing knows which they meant.
 *
 * @param {string} haystack raw searchable text
 * @param {string} term already lowercased
 * @param {'contains'|'exact'} mode
 */
export function matchesTerm(haystack, term, mode = 'contains') {
  if (mode !== 'exact') return norm(haystack).includes(term);
  const t = wordText(term).trim();
  return t ? wordText(haystack).includes(` ${t} `) : false;
}

/** Speaker display strings, split out of a dataset's comma-joined list. */
export function speakerNames(joined) {
  return String(joined || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * One breakdown list: how many MATCHES fell in each bucket, and how big that
 * bucket is in the searched scope.
 *
 * The count alone was being read as "how many results are on the page", which it
 * never was — the list is capped at `limit` while the tallies count every match,
 * so a speaker credited with 55 sessions showed up twice in the visible list.
 * The denominator answers the question that actually makes the number useful:
 * 55 of Gábor's 210 talks are about this, and DrupalCon contributed 1,200 of its
 * 8,000 sessions. A share, not a raw tally that can only be compared to itself.
 *
 * Sorted by matches descending — the subject is what was searched for, so the
 * ranking is "who/what has the most of it" — then by name, so equal counts keep
 * a stable order between requests instead of following file-read order.
 *
 * @param {Record<string, number>} counts matches per bucket
 * @param {Record<string, number>} [totals] every in-scope session per bucket
 * @param {number} [limit]
 * @returns {Array<{name: string, count: number, total: number}>}
 */
export function rankTally(counts, totals = {}, limit = 0) {
  const rows = Object.entries(counts || {})
    .map(([name, count]) => ({ name, count, total: totals?.[name] ?? count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return limit > 0 ? rows.slice(0, limit) : rows;
}

/**
 * Every session whose title, description or speaker matches `query`, newest
 * first. Phrases are matched as substrings so "display suite" behaves the way a
 * reader expects rather than as two independent words.
 *
 * @param {string} dataDir  the app's data directory
 * @param {string} query
 * @param {{limit?:number}} [opts]
 */
/**
 * @param {{limit?:number, offset?:number, mode?:'contains'|'exact', series?:string,
 *   region?:string, country?:string, year?:string}} [opts]
 *   Facets mirror the archive overview exactly — same field names, same "All"
 *   sentinel — so a filtered search and a filtered dashboard mean the same thing.
 *   `mode` picks how a term matches: see matchesTerm.
 */
export async function searchSessions(dataDir, query, opts = {}) {
  const {
    limit = 200,
    offset = 0,
    // Whole words by default. Substring matching is the more surprising rule of
    // the two — a two-letter term reaches inside "maintain", "email" and
    // "available", and `ai` returned 2,810 sessions of which a handful were about
    // AI. `contains` remains one click away for the times a fragment IS the query.
    mode = 'exact',
    series = 'All',
    region = 'All',
    country = 'All',
    year = 'All',
    // The video view is a search over recordings rather than over sessions, and
    // it opens with no query at all: "show me everything that was filmed" is a
    // reasonable first question. So in this mode an empty query browses instead
    // of returning nothing.
    hasVideo = false,
  } = opts;
  const match = mode === 'contains' ? 'contains' : 'exact';
  // The whole result set is computed either way — the scan is over the datasets,
  // not over a page of them — so paging is a slice, and `total`, the trend chart
  // and the breakdown stay whole-archive answers at every offset.
  const from = Math.max(0, Number(offset) || 0);
  const wanted = (v, actual) => v === 'All' || !v || String(actual || '') === String(v);
  const q = norm(query).trim();
  // Commas mean OR: "layout builder, paragraphs" finds sessions matching either,
  // and the trend chart plots one line per term so they can be compared.
  const terms = q
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  const browsing = hasVideo && !terms.length;
  if (!terms.length && !browsing)
    return {
      query: q,
      terms: [],
      total: 0,
      offset: from,
      byYear: {},
      byTerm: {},
      results: [],
    };

  const eventsDir = join(dataDir, 'events');
  const files = await datasetFiles(eventsDir);
  const results = [];
  // Denominators: every session the search COULD have matched in this scope,
  // tallied in the same pass. Without them a breakdown row can only be compared
  // to the other rows, never to the archive it came from.
  const pool = { series: {}, region: {}, country: {}, city: {}, speakers: {}, events: new Set() };
  const bump = (m, k) => {
    if (k) m[k] = (m[k] || 0) + 1;
  };

  for (const path of files) {
    let data;
    try {
      data = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      continue; // a malformed dataset must not break the whole search
    }
    const ev = data.event || {};
    // Facet the EVENT once rather than every session inside it.
    if (
      !wanted(series, ev.designation) ||
      !wanted(region, ev.regionCode) ||
      !wanted(country, ev.country) ||
      !wanted(year, ev.year)
    )
      continue;
    const label = [ev.designation, ev.location, ev.year].filter(Boolean).join(' ');
    const file = path.slice(path.indexOf('events/'));

    for (const item of data.items || []) {
      // Lunch and morning tea are not search results. The dashboard has always
      // excluded them from its counts; search did not, so the same archive
      // answered "how many sessions" and "which sessions" differently.
      if (!countsAsSession(item)) continue;
      const speakers = (item.speakers || []).join(', ');
      // Counted BEFORE the match test — this is the pool the search ran over.
      bump(pool.series, ev.designation);
      bump(pool.region, ev.regionCode);
      bump(pool.country, ev.country);
      bump(pool.city, ev.location);
      for (const nm of speakerNames(speakers)) bump(pool.speakers, nm);
      pool.events.add(label);
      const video = String(item.video_url || '').trim();
      if (hasVideo && !video) continue;
      // The event's own name is part of the haystack here: on the video view
      // "barcelona" is a search someone will type, and it is the event that has
      // the place, not the session.
      const haystack = `${item.title || ''} ${item.full_description || ''} ${speakers}${
        hasVideo ? ` ${label}` : ''
      }`;
      const matched = browsing ? [] : terms.filter((t) => matchesTerm(haystack, t, match));
      if (!browsing && !matched.length) continue;
      results.push({
        matched,
        title: item.title || 'Untitled session',
        description: item.full_description || '',
        speakers,
        track: (item.track || [])[0] || '',
        location: item.location || '',
        startTime: item.startTime || '',
        year: Number(ev.year) || Number(String(item.startTime || '').slice(0, 4)) || null,
        event: label,
        series: ev.designation || '',
        region: ev.regionCode || '',
        country: ev.country || '',
        city: ev.location || '',
        file,
        link: item.link || '',
        video,
        // For the video card: a recording's length is the session's length.
        minutes: sessionMinutes(item),
      });
    }
  }

  // Newest first, and genuinely chronological: by the session's own start time,
  // so an event's own days and slots fall in order and the events themselves
  // cluster without needing a separate event sort. `year` is the fallback for
  // datasets that never recorded times.
  // Year-only sessions must sort AMONG their year, not above everything. The
  // obvious fallback — `year * 1e10` — produces a number an order of magnitude
  // larger than any real epoch ms, so one dataset imported without times would
  // silently take over the top of every search. Mid-year is the honest guess.
  const when = (s) => {
    const t = Date.parse(s.startTime || '');
    if (Number.isFinite(t)) return t;
    return s.year ? Date.UTC(Number(s.year), 5, 1) : 0;
  };
  results.sort((a, b) => when(b) - when(a) || String(a.title).localeCompare(String(b.title)));

  // Counted over EVERY match, before the page limit — a histogram built from the
  // returned slice would silently under-report the older years, which is exactly
  // the part of the trend people are looking at.
  const byYear = {};
  const byTerm = Object.fromEntries(terms.map((t) => [t, {}]));
  for (const r of results) {
    if (!r.year) continue;
    byYear[r.year] = (byYear[r.year] || 0) + 1;
    // A session matching two terms counts once for each — the lines answer "how
    // much was X talked about", not "which bucket does this session belong in".
    for (const t of r.matched) byTerm[t][r.year] = (byTerm[t][r.year] || 0) + 1;
  }

  // Breakdown of the whole result set, not the returned page — the rail is
  // summarising the search, so it must count every match. Each row also carries
  // the size of its bucket in scope; see rankTally.
  const hits = { series: {}, region: {}, country: {}, city: {}, speakers: {} };
  for (const r of results) {
    bump(hits.series, r.series);
    bump(hits.region, r.region);
    bump(hits.country, r.country);
    bump(hits.city, r.city);
    for (const nm of speakerNames(r.speakers)) bump(hits.speakers, nm);
  }
  const years = results.map((r) => r.year).filter(Boolean);
  const breakdown = {
    series: rankTally(hits.series, pool.series),
    region: rankTally(hits.region, pool.region),
    country: rankTally(hits.country, pool.country),
    city: rankTally(hits.city, pool.city, 12),
    speakers: rankTally(hits.speakers, pool.speakers, 10),
    events: new Set(results.map((r) => r.event)).size,
    eventsTotal: pool.events.size,
    span: years.length ? { min: Math.min(...years), max: Math.max(...years) } : null,
  };

  return {
    query: q,
    terms,
    mode: match,
    facets: { series, region, country, year },
    total: results.length,
    offset: from,
    byYear,
    byTerm,
    breakdown,
    results: results.slice(from, from + limit),
  };
}
