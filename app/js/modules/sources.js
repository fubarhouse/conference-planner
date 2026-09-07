// @ts-check
// Source attribution — where each fact in a dataset came from.
//
// The schema and its reasoning live in docs/sources.md. This module is the pure
// half: parsing, normalising and validating source entries, with no filesystem
// and no dataset loading, so the backfill script, the audit script, the catalog
// build and the editor can all share one implementation.
//
// Not to be confused with lib/provenance.js, which injects the site-wide
// disclosure notice. Different concern, unfortunate adjacency of English.

/** Source kinds. Anything outside this set is an authoring error, not a category. */
export const SOURCE_KINDS = Object.freeze([
  'schedule',
  'sessions',
  'sponsors',
  'video',
  'photos',
  'community',
  'speaker',
  'venue',
  'stats',
  'other',
]);

// How a source was obtained. Absent `via` means fetched live from `url`.
//
// `stated` is the one that carries no URL: a source that is a statement rather
// than an address — "attendance reported by the organisers", "counted from the
// badge list". It exists because attendance figures, organiser lists and
// volunteer lists frequently have no citable page, and the honest options are a
// sentence or nothing. A sentence a reader can see beats an unattributed number.
const VIA_PROVIDERS = Object.freeze(['wayback', 'stated']);

/**
 * @typedef {object} SourceVia
 * @property {string} provider one of VIA_PROVIDERS
 * @property {string} [timestamp] wayback 14-digit capture stamp
 * @property {string} [captureUrl] the full wayback URL
 */

/**
 * @typedef {object} Source
 * @property {string} id stable slug, unique within the dataset
 * @property {string} kind one of SOURCE_KINDS
 * @property {string} [url] the ORIGINAL address, not the archive wrapper
 * @property {string} [title] human label for the UI
 * @property {string} [retrievedAt] ISO date/datetime — when we took the data
 * @property {SourceVia} [via]
 * @property {string} [capture] repo-relative path to a local copy
 * @property {string} [verifiedAt] ISO date this source was confirmed
 * @property {'human'|'policy'} [verifiedBy] who confirmed it — policy means nobody looked
 * @property {string} [notes]
 */

// Kinds where a source does not need a person to confirm it.
//
// A YouTube or photo-album link IS the artefact — opening it to confirm it is
// itself proves nothing. Schedule, session and homepage URLs are accepted by
// policy because they are structural: they are the page the dataset was built
// from, and that relationship is what the backfill already recorded.
//
// `sponsors` was held back for a long time on the grounds that sponsor
// attribution is the archive's weakest point — ~1,400 entries attributed to a
// schedule page by fallback rather than to a sponsor listing. That reasoning
// turned out to be aimed at the wrong axis. Those fallback entries do not cite a
// `sponsors` source at all; they cite a `schedule` one, and `attributionStrength`
// is what reports it. Excluding the kind therefore never touched the fallback
// problem — it only kept the handful of GENUINE sponsor-listing pages on the
// worklist, which are the one part of that story already doing its job.
//
// So a `sponsors` source is now accepted by policy, on the same structural
// grounds as `schedule`: it is the page the tiers were read off. What still
// needs a person is the tier and ORDER of any sponsor citing it, and that is a
// claim about the record, not about the source — see `attributionStrength` and
// `pnpm run audit:sources`.
//
// `stats`, `community`, `venue` and `speaker` stay absent: those carry claims
// about people and numbers, where being wrong matters most.
export const AUTO_VERIFY_KINDS = Object.freeze([
  'video',
  'photos',
  'schedule',
  'sessions',
  'sponsors',
  'other',
]);

/**
 * Whether policy alone can accept this source.
 *
 * A stated source never qualifies however it is kinded — there is nothing to
 * open, and accepting an unverifiable claim by policy is how a provenance
 * system starts lying.
 *
 * @param {any} source
 */
export function autoVerifiable(source) {
  if (!source?.url) return false;
  if (source?.via?.provider === 'stated') return false;
  return AUTO_VERIFY_KINDS.includes(source?.kind);
}

/**
 * The confidence tier of one source — how good the EVIDENCE is.
 *
 * Separate from how good the CLAIM is. A source can be a perfect archived
 * capture while the assertion that a given session came off it is still an
 * inference; `attributionStrength` below answers that second question. Rolling
 * the two together produces a single number that hides whichever one is worse.
 *
 * @param {any} source
 * @returns {'stated'|'live'|'captured'|'accepted'|'verified'}
 */
export function sourceConfidence(source) {
  // `accepted` sits below `verified` on purpose. Policy is a decision that a
  // check is unnecessary, not the check — collapsing the two would let a few
  // hundred auto-stamped rows report as human-confirmed, which is precisely the
  // overstatement this module exists to prevent.
  if (source?.verifiedAt) return source.verifiedBy === 'policy' ? 'accepted' : 'verified';
  if (source?.via?.provider === 'stated') return 'stated';
  if (source?.capture || source?.via?.provider === 'wayback') return 'captured';
  return 'live';
}

/**
 * Whether a record's attribution is evidence or inference.
 *
 * `exact` means the record's own link is the source's address — the session was
 * read from that specific page and we can show it. `page` means the record was
 * attributed to a page the whole dataset came from, which is true of how the
 * archive was assembled but is not a record about that row.
 *
 * Derived rather than stored: it is a fact about the relationship between two
 * fields, and storing it would let it drift out of step with them.
 *
 * @param {any} record a record carrying sourceIds and possibly a link
 * @param {Map<string, any>} byId the dataset's sources, keyed by id
 * @returns {'exact'|'page'|'none'}
 */
export function attributionStrength(record, byId) {
  const refs = record?.sourceIds ?? [];
  if (!refs.length) return 'none';
  const link = record?.link;
  if (typeof link === 'string' && link.trim()) {
    const target = link.trim();
    for (const id of refs) {
      const source = byId.get(id);
      if (source?.url && source.url === target) return 'exact';
    }
  }
  return 'page';
}

/**
 * How many records in a dataset cite each source.
 *
 * Verification effort should follow reach: a source 300 sessions rest on is
 * worth an afternoon; one cited by a single row is worth a minute. Without this
 * the worklist is just an alphabetical list of URLs.
 *
 * @param {any} dataset
 * @returns {Map<string, number>}
 */
export function sourceReach(dataset) {
  /** @type {Map<string, number>} */
  const reach = new Map();
  const bump = (/** @type {any} */ record) => {
    for (const id of record?.sourceIds ?? []) reach.set(id, (reach.get(id) ?? 0) + 1);
  };
  const event = dataset?.event ?? {};
  bump(event);
  bump(event.attendance);
  bump(event.community);
  for (const person of event.community?.people ?? []) bump(person);
  for (const sponsor of event.sponsors ?? []) bump(sponsor);
  for (const item of dataset?.items ?? []) bump(item);
  return reach;
}

/**
 * What kind a bare URL most likely represents, judged by its path.
 *
 * The archive's loose URL fields (`other_urls` above all) are a grab bag —
 * sponsor pages, about pages, programme indexes, travel notes — and the path is
 * the only signal available without fetching. A wrong guess is a dropdown away
 * from being right in the editor and never touches the URL itself, so guessing
 * beats filing everything under `other`.
 *
 * @param {string} url
 * @returns {string} one of SOURCE_KINDS
 */
export function classifyUrl(url) {
  const u = String(url ?? '').toLowerCase();
  if (/sponsor|partner/.test(u)) return 'sponsors';
  // `association` sits with the organiser words on purpose, and ahead of the
  // venue test: drupal.org/association/drupalcon/locations is the Association's
  // page about who runs these events, and matching it on "locations" filed the
  // organisers' own page under Venue & travel.
  if (/organiser|organizer|volunteer|team|about|community|committee|association/.test(u)) {
    return 'community';
  }
  if (/venue|location|hotel|travel|accomodation|accommodation/.test(u)) return 'venue';
  if (/speaker/.test(u)) return 'speaker';
  if (/schedule|programme|program|agenda|session/.test(u)) return 'schedule';
  return 'other';
}

/**
 * When a source was last known to be good, and what says so.
 *
 * Three fields can each date a source and none of them alone is "the" date: a
 * capture stamp says when a copy was taken, `retrievedAt` when we read it, and
 * `verifiedAt` when a person last confirmed it. The useful answer for an editor
 * triaging a list is the most RECENT of those, plus which one it was — a 2013
 * capture and a check last month are very different states of the same row, and
 * showing only the capture would misreport the second as stale.
 *
 * @param {any} source
 * @returns {{ date: string|null, basis: 'verified'|'retrieved'|'captured'|'unknown' }}
 */
export function sourceLastUsed(source) {
  /** @type {Array<{ date: string, basis: 'verified'|'retrieved'|'captured' }>} */
  const dated = [];
  const verified = isoDay(source?.verifiedAt);
  if (verified) dated.push({ date: verified, basis: 'verified' });
  const retrieved = isoDay(source?.retrievedAt);
  if (retrieved) dated.push({ date: retrieved, basis: 'retrieved' });
  if (source?.via?.provider === 'wayback') {
    const captured = waybackTimestampToIso(source.via.timestamp);
    if (captured) dated.push({ date: captured, basis: 'captured' });
  }
  if (!dated.length) return { date: null, basis: 'unknown' };
  // Sort by date, then let the strongest claim win a tie: a source verified and
  // retrieved on the same day should read as verified.
  const rank = { verified: 3, retrieved: 2, captured: 1 };
  dated.sort((a, b) =>
    a.date === b.date ? rank[b.basis] - rank[a.basis] : b.date < a.date ? -1 : 1,
  );
  return dated[0];
}

/**
 * A date-ish value as a plain ISO day, or null when it is not a date at all.
 * @param {any} value
 * @returns {string|null}
 */
function isoDay(value) {
  if (typeof value !== 'string') return null;
  const day = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(day)) ? day : null;
}

// The event fields that hold a URL which is really a source, and how each one
// should be treated once it is filed.
//
// `move` fields exist only to hold URLs — draining them into the registry is
// the whole point, and leaving a copy behind means the same address is edited
// in two places and drifts. `copy` fields are read by the app for something
// other than provenance (`website` and `scheduleURLs[0]` become the event's
// public link; `attendance.source` is displayed next to the figure), so the
// field stays and the source is an addition rather than a relocation.
const URL_FIELDS = Object.freeze([
  { field: 'other_urls', label: 'Other URLs', mode: 'move', kind: null },
  { field: 'scheduleURLs', label: 'Schedule URLs', mode: 'copy', kind: 'schedule' },
  { field: 'website', label: 'Event website', mode: 'copy', kind: 'other' },
  { field: 'community.url', label: 'Community page', mode: 'copy', kind: 'community' },
  { field: 'attendance.source', label: 'Attendance figure', mode: 'copy', kind: 'stats' },
  // The upstream feed is an operational address AND a citable one: it is the
  // page the schedule can be re-derived from. It keeps its own field, because
  // the polling job reads that field and not the registry.
  { field: 'calendarFeed.ics', label: 'Calendar feed', mode: 'copy', kind: 'schedule' },
  { field: 'calendarFeed.json', label: 'Calendar feed', mode: 'copy', kind: 'schedule' },
]);

/**
 * The leading URL in a value that may be a URL followed by prose.
 *
 * `attendance.source` is documented as "a URL, a post-event report, or the
 * person who supplied it", and in practice several entries are a URL with an
 * explanatory clause after it. Taking the URL out is what makes them citable.
 *
 * @param {any} value
 * @returns {string|null}
 */
export function leadingUrl(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^https?:\/\/\S+/i);
  if (!match) return null;
  // A trailing dash or bracket belongs to the sentence, not the address.
  const url = match[0].replace(/[),.;]+$/, '');
  return looksLikeUrl(url) ? url : null;
}

/**
 * URLs the event carries in its own fields that the source registry does not
 * know about — the consolidation worklist.
 *
 * These are real provenance sitting outside the one place that records
 * provenance, which is why nothing can report on them: they are not counted in
 * coverage, they carry no date, no kind and no verification, and the audit
 * cannot see them. Listing them next to the registry is the first step to there
 * being one list instead of five.
 *
 * Deliberately excludes `videoPlaylist`, `flickr.groupUrl`, per-session `link`
 * and `video_url`, and sponsor `link`: those are the artefacts themselves —
 * what the dataset points AT rather than what it was built FROM — and each has
 * its own field and its own UI for good reason.
 *
 * @param {any} dataset
 * @returns {Array<{ url: string, field: string, label: string, mode: 'move'|'copy', index: number|null, kind: string }>}
 */
export function strayEventUrls(dataset) {
  const event = dataset?.event;
  if (!event) return [];
  const known = new Set(
    (Array.isArray(event.sources) ? event.sources : [])
      .map((/** @type {any} */ s) => s?.url)
      .filter(Boolean),
  );
  /** @type {Array<{ url: string, field: string, label: string, mode: 'move'|'copy', index: number|null, kind: string }>} */
  const out = [];
  const seen = new Set();
  for (const { field, label, mode, kind } of URL_FIELDS) {
    const raw = field.includes('.')
      ? field.split('.').reduce((/** @type {any} */ o, /** @type {string} */ k) => o?.[k], event)
      : event[field];
    const values = Array.isArray(raw) ? raw : [raw];
    values.forEach((/** @type {any} */ value, /** @type {number} */ i) => {
      const url = leadingUrl(value);
      if (!url || known.has(url) || seen.has(url)) return;
      seen.add(url);
      out.push({
        url,
        field,
        label,
        mode: /** @type {'move'|'copy'} */ (mode),
        index: Array.isArray(raw) ? i : null,
        kind: kind ?? classifyUrl(url),
      });
    });
  }
  return out;
}

// The calendar-feed fields a person may edit. `checkedAt`, `importedAt` are
// written by the polling job and are read-only in the editor.
const FEED_EDITABLE = Object.freeze(['ics', 'json', 'autoUpdate', 'note']);

/**
 * Apply an edit to `event.calendarFeed`, creating or removing the object.
 *
 * The object is deleted once nothing is left in it rather than being kept as
 * `{}`: an empty container in every one of 127 datasets is noise in the diff
 * and a lie in the schema, which says the feed is optional.
 *
 * @param {any} event
 * @param {Partial<{ ics: string, json: string, autoUpdate: boolean, note: string }>} patch
 * @returns {any} the feed object, or null when it was removed
 */
export function setCalendarFeed(event, patch) {
  if (!event) return null;
  const feed = { ...(event.calendarFeed ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (!FEED_EDITABLE.includes(key)) continue;
    const empty = typeof value === 'string' ? !value.trim() : !value;
    if (empty) delete feed[key];
    else feed[key] = typeof value === 'string' ? value.trim() : value;
  }
  // `autoUpdate` is a permission granted over `ics`, so it cannot outlive it.
  // Leaving it set on a feed that was cleared stores "a job may rewrite this
  // dataset" with nothing to rewrite it from — and it would silently come back
  // into force the moment somebody pasted a new address in.
  if (!feed.ics) delete feed.autoUpdate;

  // The job's own timestamps must not keep the object alive on their own —
  // a record of having checked a feed that no longer exists says nothing.
  const meaningful = FEED_EDITABLE.some((key) => feed[key] !== undefined);
  if (!meaningful) {
    delete event.calendarFeed;
    return null;
  }
  event.calendarFeed = feed;
  return feed;
}

/**
 * What the polling job would do with this event, as a sentence.
 *
 * The whole point of `autoUpdate` is that the two states are visibly different
 * before anything runs. A field that silently means "a job may rewrite this
 * dataset" is exactly the kind of thing that should never be a surprise.
 *
 * @param {any} feed
 * @returns {{ state: 'none'|'report'|'auto', message: string }}
 */
export function calendarFeedStatus(feed) {
  if (!feed?.ics) {
    return {
      state: 'none',
      message: 'No feed recorded — nothing to check this event against.',
    };
  }
  const seen = feed.checkedAt
    ? ` Last checked ${String(feed.checkedAt).slice(0, 10)}.`
    : ' Never checked yet.';
  const done = feed.importedAt ? ` Last import ${String(feed.importedAt).slice(0, 10)}.` : '';
  if (feed.autoUpdate) {
    return {
      state: 'auto',
      message: `Differences from this feed will be APPLIED to the dataset.${seen}${done}`,
    };
  }
  return {
    state: 'report',
    message: `Differences from this feed will be reported, not applied.${seen}${done}`,
  };
}

/**
 * For each source, the recordings of the sessions that cite it.
 *
 * A `sessions` source is the page one session was read off, so the obvious
 * question when looking at it — "did we ever get the recording?" — is answerable
 * from data already in the file, and today is not answered anywhere. 4,623 of
 * the archive's 8,924 items carry a `video_url` and 986 session sources have
 * none, which is a gap worth being able to see while reading the register.
 *
 * Read-only on purpose: a recording belongs to the session, and the Sessions tab
 * is where a session is edited. This only reports.
 *
 * @param {any} dataset
 * @returns {Map<string, { total: number, withVideo: number, url: string|null }>}
 */
export function sessionVideosBySource(dataset) {
  /** @type {Map<string, { total: number, withVideo: number, url: string|null }>} */
  const out = new Map();
  for (const item of dataset?.items ?? []) {
    for (const id of item?.sourceIds ?? []) {
      const entry = out.get(id) ?? { total: 0, withVideo: 0, url: null };
      entry.total += 1;
      const url = typeof item?.video_url === 'string' ? item.video_url.trim() : '';
      if (url) {
        entry.withVideo += 1;
        // The first recording is enough to link to. A source cited by many
        // sessions gets a count instead, which is the honest summary.
        if (!entry.url) entry.url = url;
      }
      out.set(id, entry);
    }
  }
  return out;
}

/**
 * The Sources tab's headline numbers.
 *
 * Built from the registry rather than stored, so it cannot disagree with the
 * list underneath it. `attention` is the count the tab is really for: rows a
 * person still has to do something about.
 *
 * @param {any} dataset
 * @returns {{ total: number, kinds: Record<string, number>, verified: number, accepted: number, unverified: number, undated: number, stated: number, captured: number, invalid: number, cited: number, uncited: number, strays: number, from: string|null, to: string|null, attention: number }}
 */
export function sourcesOverview(dataset) {
  const list = Array.isArray(dataset?.event?.sources) ? dataset.event.sources : [];
  const reach = sourceReach(dataset);
  /** @type {Record<string, number>} */
  const kinds = {};
  /** @type {string[]} */
  const days = [];
  let verified = 0;
  let accepted = 0;
  let undated = 0;
  let stated = 0;
  let captured = 0;
  let invalid = 0;
  let cited = 0;
  for (const source of list) {
    if (source?.kind) kinds[source.kind] = (kinds[source.kind] ?? 0) + 1;
    const confidence = sourceConfidence(source);
    if (confidence === 'verified') verified += 1;
    if (confidence === 'accepted') accepted += 1;
    if (confidence === 'stated') stated += 1;
    if (confidence === 'captured') captured += 1;
    if (validateSource(source).length) invalid += 1;
    if (reach.get(source?.id)) cited += 1;
    const { date } = sourceLastUsed(source);
    if (date) days.push(date);
    else undated += 1;
  }
  days.sort();
  const strays = strayEventUrls(dataset).length;
  return {
    total: list.length,
    kinds,
    verified,
    accepted,
    unverified: list.length - verified - accepted,
    undated,
    stated,
    captured,
    invalid,
    cited,
    uncited: list.length - cited,
    strays,
    from: days[0] ?? null,
    to: days[days.length - 1] ?? null,
    // What the tab exists to burn down: anything unverified, undated, broken or
    // still sitting outside the registry.
    attention: list.length - verified - accepted + undated + invalid + strays,
  };
}

// `id_` and `if_` style suffixes are the archive's own; the wrapper may also be
// `http://web.archive.org` on older records, hence the loose host match.
const WAYBACK_RE = /^https?:\/\/web\.archive\.org\/web\/(\d{4,14})([a-z_]{0,3})\/(https?:\/\/.+)$/i;

/**
 * Split a Wayback URL into its capture stamp and the original address.
 *
 * Wayback URLs are self-describing, which is exactly why this must exist once:
 * the same three-line regex written in the backfill, the audit and the editor
 * will disagree about trailing modifiers (`/20130826155852id_/…`) and about
 * timestamps shorter than 14 digits, both of which occur in cache/wayback.
 *
 * @param {string} [url]
 * @returns {{ timestamp: string, originalUrl: string } | null} null when not a Wayback URL
 */
export function parseWaybackUrl(url) {
  if (typeof url !== 'string') return null;
  const m = WAYBACK_RE.exec(url.trim());
  if (!m) return null;
  return { timestamp: m[1], originalUrl: m[3] };
}

/**
 * True when `url` points at the Internet Archive.
 * @param {string} [url]
 */
export function isWaybackUrl(url) {
  return parseWaybackUrl(url) !== null;
}

/**
 * A Wayback stamp (`20130826155852`) as an ISO date (`2013-08-26`).
 *
 * Stamps are padded, not truncated: archive.org accepts and returns short forms
 * like `2013` and `201308`, and a naive slice turns those into invalid dates.
 *
 * @param {string} [timestamp]
 * @returns {string|null}
 */
export function waybackTimestampToIso(timestamp) {
  if (typeof timestamp !== 'string' || !/^\d{4,14}$/.test(timestamp)) return null;
  const p = timestamp.padEnd(14, '0');
  const [y, mo, d] = [p.slice(0, 4), p.slice(4, 6), p.slice(6, 8)];
  // A short stamp pads to month/day `00`; clamp to the first of the period so
  // the result is a real date rather than 2013-00-00.
  const month = mo === '00' ? '01' : mo;
  const day = d === '00' ? '01' : d;
  const iso = `${y}-${month}-${day}`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

/**
 * Build a source entry from a URL, deriving Wayback provenance when present.
 *
 * This is the function the backfill leans on: cache/wayback/*\/raw/urls.json
 * stores full Wayback URLs, so the original address and the capture date are
 * both recoverable without a network call.
 *
 * @param {object} input
 * @param {string} input.id
 * @param {string} input.kind
 * @param {string} [input.url] live or Wayback URL
 * @param {string} [input.title]
 * @param {string} [input.retrievedAt]
 * @param {string} [input.capture]
 * @param {string} [input.notes]
 * @returns {Source}
 */
export function makeSource({ id, kind, url, title, retrievedAt, capture, notes }) {
  /** @type {Source} */
  const source = { id, kind };
  const wayback = parseWaybackUrl(url);
  if (wayback) {
    source.url = wayback.originalUrl;
  } else if (url) {
    source.url = url;
  }
  if (title) source.title = title;
  if (retrievedAt) source.retrievedAt = retrievedAt;
  if (wayback) {
    source.via = {
      provider: 'wayback',
      timestamp: wayback.timestamp,
      captureUrl: String(url),
    };
  }
  if (capture) source.capture = capture;
  if (notes) source.notes = notes;
  return source;
}

/**
 * True when a value is something we could actually fetch.
 *
 * Deliberately strict about the scheme. A bare `drupal.org/foo` is a plausible
 * URL to a human but not a link a reader can follow, and silently promoting it
 * to `https://` would invent a claim about where the data came from. It becomes
 * a stated source instead, which is honest and still visible.
 *
 * @param {string} [value]
 */
export function looksLikeUrl(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return false;
  try {
    return Boolean(new URL(trimmed).hostname);
  } catch {
    return false;
  }
}

/**
 * Build a source from one free-text input: a URL if it is one, otherwise a
 * stated source carrying the text.
 *
 * This is the seam behind the editor's single "source" field, and behind the
 * rule that a source which is not a URL is shown to readers as the text it is.
 * Attendance figures, organiser lists and volunteer lists routinely have no
 * citable page — "reported by the organisers at the closing session" is the
 * whole truth available, and it is worth more on the page than nothing.
 *
 * @param {object} input
 * @param {string} input.value a URL or a sentence
 * @param {string} input.kind
 * @param {string} [input.id] derived when omitted
 * @param {string} [input.retrievedAt]
 * @param {Iterable<string>} [input.taken] ids already used in this dataset
 * @param {string} [input.notes]
 * @returns {Source|null} null when `value` is blank
 */
export function sourceFromInput({ value, kind, id, retrievedAt, taken = [], notes }) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (looksLikeUrl(text)) {
    return makeSource({
      id: id ?? deriveSourceId(text, kind, taken),
      kind,
      url: text,
      retrievedAt,
      notes,
    });
  }
  /** @type {Source} */
  const source = {
    id: id ?? deriveSourceId(undefined, `${kind}-${text}`, taken),
    kind,
    title: text,
    via: { provider: 'stated' },
  };
  if (retrievedAt) source.retrievedAt = retrievedAt;
  if (notes) source.notes = notes;
  return source;
}

/**
 * A stable, readable id for a source, derived from its host and path.
 *
 * Ids are referenced by every record the source supports, so they must not
 * change when a source is edited or re-fetched — which is why this derives from
 * the address rather than from an index into the array. `taken` keeps a dataset
 * with two sources on one host from colliding.
 *
 * @param {string} [url] live or Wayback URL
 * @param {string} [kind] used when there is no usable URL
 * @param {Iterable<string>} [taken] ids already in use
 * @returns {string}
 */
export function deriveSourceId(url, kind = 'other', taken = []) {
  const used = new Set(taken);
  const parsed = parseWaybackUrl(url);
  const target = parsed ? parsed.originalUrl : url;
  let base = '';
  if (target) {
    try {
      const u = new URL(target);
      const host = u.hostname.replace(/^www\./, '').replace(/\.(com|org|net|nl|au)$/, '');
      const path = u.pathname.replace(/\/+$/, '').split('/').filter(Boolean).slice(-1)[0] ?? '';
      base = slug(`${host}-${path}`);
    } catch {
      base = '';
    }
  }
  if (!base) base = slug(kind);
  let id = base;
  let n = 2;
  while (used.has(id)) id = `${base}-${n++}`;
  return id;
}

/** @param {string} value */
function slug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/**
 * Validate one source entry. Returns problem strings; empty means valid.
 *
 * @param {any} source
 * @param {number} [index] position in the array, for the message
 * @returns {string[]}
 */
export function validateSource(source, index) {
  const at = index === undefined ? 'source' : `sources[${index}]`;
  const problems = [];
  if (!source || typeof source !== 'object') return [`${at}: not an object`];
  if (!source.id || typeof source.id !== 'string') problems.push(`${at}: missing id`);
  if (!SOURCE_KINDS.includes(source.kind)) {
    problems.push(`${at} (${source.id ?? '?'}): unknown kind ${JSON.stringify(source.kind)}`);
  }
  // A MISSING retrievedAt is not an error. Much of this archive was assembled
  // before provenance was recorded, so "we do not know when this was fetched"
  // is the truth for a large share of it; making that invalid would bury the
  // real defects under hundreds of unfixable ones. It is reported separately as
  // coverage. A retrievedAt that is present but nonsense is still an error.
  if (source.retrievedAt && Number.isNaN(Date.parse(source.retrievedAt))) {
    problems.push(`${at} (${source.id ?? '?'}): unparseable retrievedAt`);
  }
  if (source.url && isWaybackUrl(source.url)) {
    // The whole point of the url/via split: `url` holds the original address.
    problems.push(`${at} (${source.id}): url is a Wayback wrapper — put it in via.captureUrl`);
  }
  if (source.via !== undefined) problems.push(...validateVia(source.via, at, source.id));
  else if (!source.url) problems.push(`${at} (${source.id}): needs a url or a via`);
  if (source.via?.provider === 'stated') {
    // A stated source IS its text. Without it there is nothing to show a reader
    // and nothing to distinguish it from an empty claim.
    if (!source.title || !String(source.title).trim()) {
      problems.push(`${at} (${source.id}): a stated source needs a title — the text to display`);
    }
    if (source.url) {
      problems.push(
        `${at} (${source.id}): stated sources carry no url — drop via, or drop the url`,
      );
    }
  }
  return problems;
}

/**
 * @param {any} via
 * @param {string} at
 * @param {string} [id]
 * @returns {string[]}
 */
function validateVia(via, at, id) {
  const label = `${at} (${id ?? '?'})`;
  if (!via || typeof via !== 'object') return [`${label}: via is not an object`];
  /** @type {string[]} */
  const problems = [];
  if (!VIA_PROVIDERS.includes(via.provider)) {
    problems.push(`${label}: unknown via.provider ${JSON.stringify(via.provider)}`);
    return problems;
  }
  if (via.provider === 'stated') return problems; // nothing further to check
  if (via.provider === 'wayback') {
    const parsed = parseWaybackUrl(via.captureUrl);
    if (!parsed) {
      problems.push(`${label}: via.captureUrl is not a Wayback URL`);
    } else if (via.timestamp && via.timestamp !== parsed.timestamp) {
      // Stored fields are a cache of what captureUrl already says. When they
      // drift, the cache is what's wrong.
      problems.push(
        `${label}: via.timestamp ${via.timestamp} disagrees with captureUrl (${parsed.timestamp})`,
      );
    }
  }
  return problems;
}

/**
 * Validate a dataset's whole source registry and the references into it.
 *
 * Dangling references are the failure mode that motivates this: renaming a
 * source id breaks every record pointing at it without breaking any page, so
 * nothing surfaces it except a check like this one.
 *
 * @param {any} dataset a parsed event dataset
 * @returns {{ problems: string[], unreferenced: string[], undated: string[], unsourced: { items: number, sponsors: number, people: number, event: boolean } }}
 */
export function validateDatasetSources(dataset) {
  const event = dataset?.event ?? {};
  /** @type {any[]} */
  const sources = Array.isArray(event.sources) ? event.sources : [];
  /** @type {string[]} */
  const problems = [];
  /** @type {Set<string>} */
  const ids = new Set();
  sources.forEach((/** @type {any} */ source, /** @type {number} */ i) => {
    problems.push(...validateSource(source, i));
    if (source?.id) {
      if (ids.has(source.id)) problems.push(`sources[${i}]: duplicate id ${source.id}`);
      ids.add(source.id);
    }
  });

  const referenced = new Set();
  /**
   * @param {any} record
   * @param {string} label
   */
  const checkRefs = (record, label) => {
    const refs = record?.sourceIds;
    if (refs === undefined) return false;
    if (!Array.isArray(refs)) {
      problems.push(`${label}: sourceIds is not an array`);
      return false;
    }
    for (const ref of refs) {
      referenced.add(ref);
      if (!ids.has(ref)) problems.push(`${label}: sourceIds references unknown id ${ref}`);
    }
    return refs.length > 0;
  };

  const eventSourced = checkRefs(event, 'event');
  // Sub-records that own their provenance rather than inheriting the event's:
  // both arrive with a capturedAt, so they are the best-dated data in the file.
  checkRefs(event.attendance, 'event.attendance');
  checkRefs(event.community, 'event.community');
  let peopleUnsourced = 0;
  (event.community?.people ?? []).forEach((/** @type {any} */ person, /** @type {number} */ i) => {
    if (!checkRefs(person, `community.people[${i}]`)) peopleUnsourced += 1;
  });
  let itemsUnsourced = 0;
  (Array.isArray(dataset?.items) ? dataset.items : []).forEach(
    (/** @type {any} */ item, /** @type {number} */ i) => {
      if (!checkRefs(item, `items[${i}]`)) itemsUnsourced += 1;
    },
  );
  let sponsorsUnsourced = 0;
  (Array.isArray(event.sponsors) ? event.sponsors : []).forEach(
    (/** @type {any} */ sponsor, /** @type {number} */ i) => {
      if (!checkRefs(sponsor, `sponsors[${i}]`)) sponsorsUnsourced += 1;
    },
  );

  return {
    problems,
    unreferenced: [...ids].filter((id) => !referenced.has(id)),
    undated: sources.filter((s) => s?.id && !s.retrievedAt).map((s) => s.id),
    unsourced: {
      items: itemsUnsourced,
      sponsors: sponsorsUnsourced,
      people: peopleUnsourced,
      event: !eventSourced,
    },
  };
}

/**
 * The per-event summary the catalog carries, so the archive can be filtered on
 * provenance without loading every dataset.
 *
 * **This function is ported.** `tools/server/sources.go` implements the same
 * rule for the Go catalog builder, so this is no longer the only copy — the
 * property the rest of this file relies on. The two are held together by
 * `tools/server/testdata/sources-cases.json`, which both test suites read:
 * change the rule here and the Go build fails, and vice versa. Add a case to
 * that fixture when you change the behaviour; do not change one side alone.
 *
 * Note that the key order of `kinds` is part of the contract, not an artefact —
 * the catalog carries it in first-seen order. See docs/go-port.md.
 *
 * @param {any} dataset
 * @returns {{ count: number, kinds: Record<string, number>, wayback: boolean, stated: number, oldestCapture: string|null, retrievedFrom: string|null, retrievedTo: string|null }}
 */
export function summarizeSources(dataset) {
  const sources = Array.isArray(dataset?.event?.sources) ? dataset.event.sources : [];
  /** @type {Record<string, number>} */
  const kinds = {};
  let wayback = false;
  // Sources that rest on a statement rather than a link. Surfaced so a reader
  // can tell at a glance which figures they can go and check for themselves.
  let stated = 0;
  /** @type {string[]} */
  const captures = [];
  /** @type {string[]} */
  const retrieved = [];
  for (const source of sources) {
    if (source?.kind) kinds[source.kind] = (kinds[source.kind] ?? 0) + 1;
    if (source?.via?.provider === 'stated') stated += 1;
    if (source?.via?.provider === 'wayback') {
      wayback = true;
      const iso = waybackTimestampToIso(source.via.timestamp);
      if (iso) captures.push(iso);
    }
    if (source?.retrievedAt) retrieved.push(String(source.retrievedAt).slice(0, 10));
  }
  captures.sort();
  retrieved.sort();
  return {
    count: sources.length,
    kinds,
    wayback,
    stated,
    oldestCapture: captures[0] ?? null,
    retrievedFrom: retrieved[0] ?? null,
    retrievedTo: retrieved[retrieved.length - 1] ?? null,
  };
}
