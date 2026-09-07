// @ts-check
// Reading a reconciliation report.
//
// The server hands back `reconcile.Report` from the Go tool untouched — it is a
// pipe for it, and only this file knows the shape. Everything here is pure: it
// turns a report into the sections a person reads, and decides what an import
// would actually do. No DOM, so the rules are testable without one.
//
// The organising idea is that a report has two halves that must not be mixed.
// Some rows are things an import WILL change; others are things it will not,
// which the person is being shown so they can go and deal with them by hand.
// Presenting them as one undifferentiated diff is how somebody presses Import
// expecting the second half to be handled.
//
// See docs/sources.md and tools/drupalcon-sync/README.md.

/**
 * @typedef {object} DiffRow
 * @property {string} title
 * @property {string} [detail] a secondary line — a URL, a time, a fate
 * @property {string} [from]
 * @property {string} [to]
 */

/**
 * @typedef {object} DiffSection
 * @property {string} key
 * @property {string} title
 * @property {string} note what this section means, in one sentence
 * @property {'add'|'remove'|'change'|'hold'} kind
 * @property {boolean} applied whether importing acts on these rows
 * @property {DiffRow[]} rows
 */

/**
 * A time as `2026-09-28 07:30Z`, or the raw value when it is not one.
 * @param {any} value
 */
function clock(value) {
  const text = String(value ?? '');
  const match = text.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  return match ? `${match[1]} ${match[2]}Z` : text;
}

/** @param {any[]|undefined} list */
const rows = (list) => (Array.isArray(list) ? list : []);

/**
 * What an import would do to this dataset, split into what it changes and what
 * it only reports.
 *
 * `mirror` matters because the two imports are genuinely different operations:
 * without it, sessions are never added or removed and the corresponding
 * sections are shown as held rather than as pending changes. Telling somebody a
 * session will be added when it will not is the failure this guards against.
 *
 * @param {any} report the reconciliation report, as returned by the server
 * @param {{ mirror?: boolean }} [options]
 * @returns {DiffSection[]} only the sections with rows in them
 */
export function diffSections(report, { mirror = true } = {}) {
  if (!report) return [];
  /** @type {DiffSection[]} */
  const sections = [
    {
      key: 'upstreamOnly',
      title: 'Sessions the archive does not have',
      note: mirror
        ? 'These will be added, with their times, links and descriptions. The feed carries no room, track or speakers — those stay for you to fill in.'
        : 'These exist upstream only. Importing will NOT add them unless you adopt the whole programme.',
      kind: 'add',
      applied: mirror,
      rows: rows(report.upstreamOnly).map((s) => ({
        title: s.title,
        detail: [clock(s.start), s.url].filter(Boolean).join('  ·  '),
      })),
    },
    {
      key: 'timeDrift',
      title: 'Times that moved',
      note: 'The feed and the archive disagree about when these run. The feed wins.',
      kind: 'change',
      applied: true,
      rows: rows(report.timeDrift).map((s) => ({
        title: s.title,
        from: clock(s.fromStart),
        to: clock(s.toStart),
      })),
    },
    {
      key: 'fillable',
      title: 'Descriptions the archive is missing',
      note: 'The archive has no description for these and the feed does.',
      kind: 'change',
      applied: true,
      rows: rows(report.fillable).map((s) => ({
        title: s.title ?? s.Title ?? '',
        detail: s.field ?? 'full_description',
      })),
    },
    {
      key: 'titleDrift',
      title: 'Titles that differ',
      note: mirror
        ? 'The feed’s spelling will be taken, including renames.'
        : 'Only cosmetic differences — case, spacing, punctuation — are written. A rename is never taken automatically.',
      kind: 'change',
      applied: true,
      rows: rows(report.titleDrift).map((s) => ({
        title: s.title ?? '',
        from: s.from,
        to: s.to,
      })),
    },
    {
      key: 'datasetOnly',
      title: 'Sessions the feed no longer lists',
      note: mirror
        ? 'These will be removed or marked cancelled, according to what the publisher says became of them.'
        : 'The feed has dropped these. Nothing will be removed.',
      kind: 'remove',
      applied: mirror,
      rows: rows(report.datasetOnly).map((s) => ({
        title: s.title,
        detail: s.fate ? `upstream says: ${s.fate}` : 'no longer in the feed',
      })),
    },
    {
      key: 'ambiguous',
      title: 'Could not be matched',
      note: 'These could be the same session as something upstream, or not. Nothing is written for them either way — they need a person.',
      kind: 'hold',
      applied: false,
      rows: rows(report.ambiguous).map((s) => ({
        title: s.title ?? '',
        detail: s.kept ? `kept: ${s.kept}` : undefined,
      })),
    },
  ];
  return sections.filter((section) => section.rows.length > 0);
}

/**
 * The one-line answer, for the modal's header.
 *
 * A count of rows is not it: "38 differences" does not tell somebody whether
 * pressing Import is safe. What they need is how many things it will CHANGE and
 * whether anything is being held back from it.
 *
 * @param {any} report
 * @param {{ mirror?: boolean }} [options]
 */
export function diffSummary(report, options = {}) {
  const sections = diffSections(report, options);
  let changing = 0;
  let held = 0;
  for (const section of sections) {
    if (section.applied) changing += section.rows.length;
    else held += section.rows.length;
  }
  return {
    sections,
    changing,
    held,
    total: changing + held,
    // Nothing to do is a real and common answer, and it deserves to be said
    // rather than shown as an empty modal.
    clean: changing === 0 && held === 0,
  };
}

// What the panel says about a feed it has just asked about. Keyed by the
// report's own status so an unexpected one still produces a sentence.
const STATUS_MESSAGE = {
  'no-export': {
    tone: 'hold',
    message:
      'The feed is published but empty. That normally means the programme is not out yet — it never means the sessions were cancelled, so nothing will be imported.',
  },
  'not-hosted': {
    tone: 'hold',
    message:
      'There is no feed to read. Set an ICS URL above, or this event is not one that publishes a machine-readable schedule.',
  },
  error: {
    tone: 'bad',
    message: 'The feed could not be read. Nothing was changed.',
  },
};

/**
 * Turn a check result into something to say.
 *
 * @param {any} result the server's response
 * @param {{ mirror?: boolean }} [options]
 * @returns {{ tone: 'ok'|'change'|'hold'|'bad', headline: string, detail: string }}
 */
export function checkMessage(result, options = {}) {
  if (!result) return { tone: 'bad', headline: 'No answer', detail: '' };
  const known = /** @type {Record<string, { tone: string, message: string }>} */ (STATUS_MESSAGE)[
    result.status
  ];
  if (known) {
    return {
      tone: /** @type {any} */ (known.tone),
      headline: result.status === 'error' ? 'Could not read the feed' : 'Nothing to import',
      detail: result.note ? `${known.message} (${result.note})` : known.message,
    };
  }

  const { changing, held, clean } = diffSummary(result.report, options);
  const counted = `${result.upstream} upstream, ${result.local} here`;
  if (clean) {
    return {
      tone: 'ok',
      headline: 'Already matches the feed',
      detail: `${counted}. Nothing has moved since this was last imported.`,
    };
  }
  const parts = [`${changing} change${changing === 1 ? '' : 's'} to make`];
  if (held) parts.push(`${held} for you to look at`);
  return {
    tone: 'change',
    headline: parts.join(', '),
    detail: `${counted}${result.fetch === 'stale' ? ' — read from the last good copy, not from upstream' : ''}.`,
  };
}

/**
 * The receipt for an import that has happened.
 *
 * Deliberately not the same shape as the message before it. Beforehand the
 * useful thing is what WOULD change; afterwards it is what DID, in the past
 * tense, plus the one thing an import cannot do for you — the rows it held back
 * are still sitting there, and this is the last moment anybody is looking.
 *
 * @param {any} result the import response
 * @param {{ mirror?: boolean }} [options]
 * @returns {{ headline: string, counts: Array<{ label: string, value: number, tone: string }>, held: number, detail: string }}
 */
export function importedMessage(result, options = {}) {
  const changed = result?.changed ?? 0;
  const added = result?.added ?? 0;
  const removed = result?.removed ?? 0;
  const { held } = diffSummary(result?.report, options);

  // The headline names the biggest thing that happened rather than adding the
  // three numbers up: "5 sessions added" is what somebody remembers, and
  // "13 changes" is not something they can check.
  let headline = 'Imported from the feed';
  if (added && !removed) headline = `${added} session${added === 1 ? '' : 's'} added`;
  else if (removed && !added) headline = `${removed} session${removed === 1 ? '' : 's'} removed`;
  else if (added && removed) headline = `${added} added, ${removed} removed`;
  else if (changed) headline = `${changed} field${changed === 1 ? '' : 's'} updated`;

  return {
    headline,
    counts: [
      { label: 'fields updated', value: changed, tone: changed ? 'good' : '' },
      { label: 'sessions added', value: added, tone: added ? 'good' : '' },
      { label: 'sessions removed', value: removed, tone: removed ? 'bad' : '' },
    ],
    held,
    detail: held
      ? held === 1
        ? '1 row could not be matched and was left alone — it still needs a person.'
        : `${held} rows could not be matched and were left alone — they still need a person.`
      : 'The dataset now matches the feed.',
  };
}

/**
 * Whether the Import button should do anything.
 *
 * False for every status that is not `ok`, and for a report with nothing to
 * apply — importing "no changes" writes a file for no reason and makes the
 * archive's history harder to read.
 *
 * @param {any} result
 * @param {{ mirror?: boolean }} [options]
 */
export function canImport(result, options = {}) {
  if (!result || result.status !== 'ok') return false;
  return diffSummary(result.report, options).changing > 0;
}
