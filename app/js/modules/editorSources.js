// The Sources panel — authoring where this event's data came from.
//
// One field per source, because that is what an editor actually has: a thing
// they pasted or a sentence they know. `sourceFromInput` decides what it is —
// a URL becomes a normal source, a Wayback URL is split into `url` + `via`
// automatically, and anything else becomes a `stated` source shown to readers
// as the text it is. Nobody should ever have to type `via{}` by hand.
//
// The panel is grouped, filtered and summarised rather than a flat list because
// of what the data actually looks like: the median event has four sources that
// are not per-session pages, and the largest has 169 that are. A flat list is
// fine for the first number and unusable for the second, and it is the four
// that need a person's attention.
//
// See docs/sources.md for the schema and why it is shaped this way.

import {
  AUTO_VERIFY_KINDS,
  SOURCE_KINDS,
  autoVerifiable,
  looksLikeUrl,
  parseWaybackUrl,
  sourceConfidence,
  calendarFeedStatus,
  sessionVideosBySource,
  setCalendarFeed,
  sourceFromInput,
  sourceLastUsed,
  sourceReach,
  sourcesOverview,
  strayEventUrls,
  validateSource,
} from './sources.js';

/** @type {{ state: any, markDirty: (v?: boolean) => void, escapeHtml: (s: string) => string, escapeAttr: (s: string) => string, onChange?: () => void, onCheckFeed?: () => void }} */
let deps;

// Panel UI state. Module-level because the panel re-renders wholesale after
// every edit, and a filter or an open group that reset on each keystroke would
// make the list unusable for exactly the events that need it.
const ui = {
  query: '',
  kind: 'all',
  sort: 'kind',
  attentionOnly: false,
  /** @type {Set<string>} kinds whose group is expanded */
  open: new Set(),
  /** @type {boolean} whether the group open-set has been seeded for this dataset */
  seeded: false,
  /** @type {string|null} the dataset the open-set was seeded for */
  seededFor: null,
};

/**
 * @param {object} injected
 * @param {any} injected.state
 * @param {(v?: boolean) => void} injected.markDirty
 * @param {(s: string) => string} injected.escapeHtml
 * @param {(s: string) => string} injected.escapeAttr
 * @param {() => void} [injected.onChange] re-render siblings that read the same URLs
 * @param {() => void} [injected.onCheckFeed] the editor's feed check — it owns the
 *   network call and the modal, so this module stays free of both
 */
export function initSources(injected) {
  deps = injected;
}

/** The dataset's sources array, created on demand. */
function sources() {
  const event = deps.state?.dataset?.event;
  if (!event) return null;
  if (!Array.isArray(event.sources)) event.sources = [];
  return event.sources;
}

/** Tell the rest of the editor that the URLs it mirrors have moved. */
function changed() {
  deps.markDirty(true);
  deps.onChange?.();
}

/** Human label for a source: its title, else the shape of its URL. */
export function sourceLabel(source) {
  if (source?.title) return source.title;
  if (!source?.url) return source?.id ?? '';
  try {
    const url = new URL(source.url);
    const path = url.pathname.replace(/\/$/, '');
    return `${url.hostname.replace(/^www\./, '')}${path}`;
  } catch {
    return source.url;
  }
}

/**
 * What to tell the editor about a value they are typing, before they commit it.
 *
 * The point is that the two outcomes are never a surprise. Pasting a Wayback URL
 * silently rewriting itself into a different `url` field would look like a bug
 * if it were not announced.
 *
 * @param {string} value
 * @returns {{ tone: 'url'|'wayback'|'stated'|'empty', message: string }}
 */
export function inputPreview(value) {
  const text = String(value ?? '').trim();
  if (!text) return { tone: 'empty', message: '' };
  const wayback = parseWaybackUrl(text);
  if (wayback) {
    return {
      tone: 'wayback',
      message: `Internet Archive capture of ${wayback.originalUrl} — the original address is stored, with the capture kept alongside it.`,
    };
  }
  if (looksLikeUrl(text)) return { tone: 'url', message: 'Saved as a link.' };
  return {
    tone: 'stated',
    message: 'Not a link — saved as a stated source and shown to readers as this text.',
  };
}

const KIND_HINT = {
  schedule: 'The programme or schedule page.',
  sessions: 'A per-session detail page.',
  sponsors: 'A sponsor listing. Needs checking by a person.',
  video: 'A recording or playlist.',
  photos: 'A photo album or group.',
  community: 'Organiser, volunteer or community page. Needs checking by a person.',
  speaker: 'A speaker listing or profile.',
  venue: 'Venue, travel or accommodation.',
  stats: 'Where a reported figure came from. Needs checking by a person.',
  other: 'Anything else — usually the event homepage.',
};

// Plural headings, so a group reads as a shelf rather than a tag.
const KIND_TITLE = {
  schedule: 'Schedule pages',
  sessions: 'Session pages',
  sponsors: 'Sponsor listings',
  video: 'Recordings',
  photos: 'Photo albums',
  community: 'Community & organisers',
  speaker: 'Speaker pages',
  venue: 'Venue & travel',
  stats: 'Reported figures',
  other: 'Other pages',
};

// Every shelf arrives shut. The register is long — 129 rows on a mid-sized
// event, 173 on the largest — and a page that opens with all of it unrolled
// makes the reader do the closing. The counts and the "to check" flags on the
// headers are enough to decide which one to open.

/**
 * A source's triage state — what, if anything, a person still owes it.
 *
 * @param {any} source
 * @param {number} reach
 * @returns {{ needsWork: boolean, problems: string[], undated: boolean, orphan: boolean }}
 */
export function triage(source, reach) {
  const problems = validateSource(source);
  const confidence = sourceConfidence(source);
  const undated = sourceLastUsed(source).date === null;
  return {
    problems,
    undated,
    // An uncited source supports nothing. Usually that means a record lost its
    // reference, occasionally that the source was added ahead of the data.
    orphan: reach === 0,
    needsWork:
      problems.length > 0 ||
      undated ||
      confidence === 'live' ||
      confidence === 'stated' ||
      reach === 0,
  };
}

/**
 * The rows to show, after the toolbar's filters.
 *
 * Pure so the filtering rules are testable without a DOM: this is the part that
 * decides whether an editor can find one row among 169.
 *
 * @param {any[]} list
 * @param {Map<string, number>} reach
 * @param {{ query: string, kind: string, attentionOnly: boolean }} filters
 * @returns {Array<{ source: any, index: number }>}
 */
export function filterSources(list, reach, { query, kind, attentionOnly }) {
  const needle = String(query ?? '')
    .trim()
    .toLowerCase();
  return list
    .map((source, index) => ({ source, index }))
    .filter(({ source }) => {
      if (kind && kind !== 'all' && source?.kind !== kind) return false;
      if (attentionOnly && !triage(source, reach.get(source?.id) ?? 0).needsWork) return false;
      if (!needle) return true;
      const hay = `${source?.id ?? ''} ${source?.url ?? ''} ${source?.title ?? ''}`.toLowerCase();
      return hay.includes(needle);
    });
}

/**
 * Order rows for a flat (non-grouped) view.
 *
 * @param {Array<{ source: any, index: number }>} rows
 * @param {Map<string, number>} reach
 * @param {string} sort
 */
export function sortSources(rows, reach, sort) {
  const copy = [...rows];
  if (sort === 'reach') {
    copy.sort((a, b) => (reach.get(b.source?.id) ?? 0) - (reach.get(a.source?.id) ?? 0));
  } else if (sort === 'date') {
    // Undated last: they are the ones with nothing to sort by, and burying them
    // among 2013 captures is how they stay undated.
    copy.sort((a, b) => {
      const x = sourceLastUsed(a.source).date;
      const y = sourceLastUsed(b.source).date;
      if (!x && !y) return 0;
      if (!x) return 1;
      if (!y) return -1;
      return y.localeCompare(x);
    });
  } else if (sort === 'attention') {
    const score = (/** @type {any} */ r) => {
      const t = triage(r.source, reach.get(r.source?.id) ?? 0);
      return (t.problems.length ? 4 : 0) + (t.orphan ? 2 : 0) + (t.undated ? 1 : 0);
    };
    copy.sort((a, b) => score(b) - score(a));
  }
  return copy;
}

/**
 * The kind selector's options, each carrying its own explanation.
 *
 * A bare list of nine words ("schedule, sessions, sponsors, video…") does not
 * tell an editor that picking `sponsors` means a person will have to check it
 * later, which is the only part of the choice with consequences.
 *
 * @param {string} selected
 */
function kindOptions(selected) {
  return SOURCE_KINDS.map((kind) => {
    // Short enough that the closed control does not have to be wide enough to
    // hold a sentence; the sentence is in the option's title and in KIND_HINT.
    const policy = AUTO_VERIFY_KINDS.includes(kind) ? '' : ' — check';
    return `<option value="${kind}"${kind === selected ? ' selected' : ''} title="${deps.escapeAttr(
      KIND_HINT[kind] ?? '',
    )}">${kind}${policy}</option>`;
  }).join('');
}

/** Seed the open groups once per dataset: everything but the noisy ones. */
function seedOpenGroups() {
  const key = deps.state?.file ?? deps.state?.dataset?.event?.id ?? '';
  if (ui.seeded && ui.seededFor === key) return;
  ui.open = new Set();
  ui.seeded = true;
  ui.seededFor = key;
}

/** Render the whole panel. */
export function renderSourcesEditor() {
  const container = document.getElementById('sourcesEditorContent');
  if (!container) return;
  const list = sources();
  if (!list) {
    container.innerHTML = '<p class="url-multifield-empty">Load a dataset to edit its sources.</p>';
    return;
  }

  seedOpenGroups();
  const dataset = deps.state.dataset;
  const reach = sourceReach(dataset);
  const videos = sessionVideosBySource(dataset);
  const overview = sourcesOverview(dataset);
  const rows = filterSources(list, reach, ui);

  const body =
    ui.sort === 'kind'
      ? renderGroups(rows, reach, videos)
      : `<div class="src-list">${sortSources(rows, reach, ui.sort)
          .map(({ source, index }) =>
            renderRow(source, index, reach.get(source.id) ?? 0, videos.get(source.id)),
          )
          .join('')}</div>`;

  container.innerHTML = `
    ${renderOverview(overview)}
    ${renderFeed(dataset)}
    ${renderStrays(dataset)}
    <section class="src-register">
      <h3 class="src-head">The register</h3>
      ${renderToolbar(overview, rows.length, list.length)}
      ${rows.length ? body : `<p class="src-empty">${emptyMessage(list.length)}</p>`}
    </section>
    ${renderAddRow()}
  `;

  wireSourcesPanel();
}

/** @param {number} total */
function emptyMessage(total) {
  if (!total) return 'No sources recorded yet.';
  return 'No sources match the current filter.';
}

/** The headline strip: what this event's provenance amounts to, in numbers. */
function renderOverview(o) {
  const span = o.from
    ? `${o.from}${o.to && o.to !== o.from ? ` → ${o.to}` : ''}`
    : '<span class="src-stat__none">never</span>';
  const tile = (label, value, tone = '') =>
    `<div class="src-stat${tone ? ` src-stat--${tone}` : ''}">
       <span class="src-stat__value">${value}</span>
       <span class="src-stat__label">${label}</span>
     </div>`;
  return `
    <div class="src-overview">
      ${tile('sources', o.total)}
      ${tile('verified', o.verified, o.verified ? 'good' : '')}
      ${tile('accepted', o.accepted)}
      ${tile('cited', o.cited)}
      ${tile('undated', o.undated, o.undated ? 'warn' : '')}
      ${tile('unfiled', o.strays, o.strays ? 'warn' : '')}
      ${o.invalid ? tile('invalid', o.invalid, 'bad') : ''}
      <div class="src-stat src-stat--span">
        <span class="src-stat__value src-stat__value--date">${span}</span>
        <span class="src-stat__label">last used</span>
      </div>
    </div>
  `;
}

/**
 * The upstream calendar feed — the address this dataset can be re-checked
 * against, and the one field a scheduled job will read.
 *
 * Kept out of the register and given its own section because it answers a
 * different question. Every other URL on this page is evidence for what the
 * dataset already says; this one is a standing connection to what the
 * organisers say NOW. It is also the only field here that can cause something
 * to happen on its own, so what would happen is stated in full before it can.
 *
 * ICS is the polled form. The JSON export is recorded where organisers publish
 * one, but importing structured data is a deliberate act with choices in it —
 * which fields win, what to do with sessions that vanished — and that is not
 * something a background job should decide.
 */
function renderFeed(dataset) {
  const { escapeAttr, escapeHtml } = deps;
  const feed = dataset?.event?.calendarFeed ?? {};
  const status = calendarFeedStatus(feed);
  return `
    <section class="src-panel">
      <div class="src-panel__head">
        <h3 class="src-head">Calendar feed</h3>
        <span class="src-tag src-tag--${status.state}">${
          status.state === 'none'
            ? 'not set'
            : status.state === 'auto'
              ? 'auto-update'
              : 'report only'
        }</span>
      </div>
      <p class="src-note">
        The organisers&rsquo; own machine-readable schedule, if they publish one — not this
        app&rsquo;s <code>/schedule.ics</code> output. Recorded now so that a scheduled job can
        later fetch it, compare it against this dataset and tell you what moved.
      </p>
      <div class="src-fields">
        <label class="src-field">
          <span class="src-field__label">ICS feed <span class="src-field__note">polled</span></span>
          <input type="url" class="src-input" id="feedIcs" placeholder="https://…/schedule.ics"
            value="${escapeAttr(feed.ics ?? '')}">
        </label>
        <label class="src-field">
          <span class="src-field__label">JSON export <span class="src-field__note">recorded only</span></span>
          <input type="url" class="src-input" id="feedJson" placeholder="https://…/schedule.json"
            value="${escapeAttr(feed.json ?? '')}">
        </label>
      </div>
      <div class="src-fields">
        <label class="src-field src-field--wide">
          <span class="src-field__label">Note</span>
          <input type="text" class="src-input" id="feedNote"
            placeholder="A quirk of this feed, or why auto-update is off"
            value="${escapeAttr(feed.note ?? '')}">
        </label>
        <label class="src-check">
          <input type="checkbox" id="feedAuto"${feed.autoUpdate ? ' checked' : ''}${
            feed.ics ? '' : ' disabled'
          }>
          <span>Apply changes automatically</span>
        </label>
      </div>
      <p class="src-status src-status--${status.state}">${escapeHtml(status.message)}</p>
      <div class="src-feed__act">
        <button type="button" class="src-btn src-btn--go" id="feedCheck"${
          feed.ics ? '' : ' disabled'
        }>Check the feed</button>
        <span class="src-sub" id="feedCheckNote">${
          feed.ics
            ? 'Fetches it and shows you what differs. Writes nothing.'
            : 'Set an ICS URL to check against.'
        }</span>
      </div>
    </section>
  `;
}

/**
 * The consolidation worklist: URLs the event carries in its own fields that the
 * registry has never heard of.
 *
 * This is the whole reason a URL can be in a dataset and still be invisible to
 * the audit, the coverage report and the reader — it was typed into a field
 * that only stores strings. Filing one turns it into a dated, kinded, citable
 * source; until then it is a link nobody is accountable for.
 */
function renderStrays(dataset) {
  const strays = strayEventUrls(dataset);
  if (!strays.length) return '';
  const { escapeAttr, escapeHtml } = deps;
  const rows = strays
    .map((stray, i) => {
      // Most of a list like this comes off one field, and repeating its name
      // down twelve rows says nothing. It appears where the field changes.
      const from =
        i > 0 && strays[i - 1].field === stray.field
          ? ''
          : `${escapeHtml(stray.label)}${stray.mode === 'move' ? '' : ' · stays in place'}`;
      return `
      <li class="src-stray" data-stray-index="${i}">
        <div class="src-stray__main">
          <a class="src-url" href="${escapeAttr(stray.url)}" target="_blank"
             rel="noopener noreferrer">${escapeHtml(stray.url.replace(/^https?:\/\//, ''))}</a>
          <span class="src-sub">${from}</span>
        </div>
        <select class="src-select" data-stray-kind="${i}"
          aria-label="Kind for ${escapeAttr(stray.url)}">${kindOptions(stray.kind)}</select>
        <button type="button" class="src-btn" data-stray-file="${i}">File</button>
      </li>`;
    })
    .join('');
  return `
    <section class="src-panel src-panel--act">
      <div class="src-panel__head">
        <h3 class="src-head">Unfiled URLs</h3>
        <span class="src-tag src-tag--warn">${strays.length}</span>
        <button type="button" class="src-btn src-btn--go" id="fileAllStrays">File all</button>
      </div>
      <p class="src-note">
        These sit in the event&rsquo;s own fields, so nothing dates them, kinds them or checks
        them. Filing adds each as a source — the ones marked <em>stays in place</em> are read by
        the app elsewhere and keep their field too.
      </p>
      <ul class="src-stray-list">${rows}</ul>
    </section>
  `;
}

function renderToolbar(overview, shown, total) {
  const kinds = Object.entries(overview.kinds).sort((a, b) => b[1] - a[1]);
  const options = [
    `<option value="all"${ui.kind === 'all' ? ' selected' : ''}>every kind (${total})</option>`,
    ...kinds.map(
      ([kind, n]) =>
        `<option value="${kind}"${ui.kind === kind ? ' selected' : ''}>${
          KIND_TITLE[kind] ?? kind
        } (${n})</option>`,
    ),
  ].join('');
  const sorts = [
    ['kind', 'grouped by kind'],
    ['attention', 'needs attention first'],
    ['reach', 'most cited first'],
    ['date', 'most recently used first'],
  ]
    .map(([v, l]) => `<option value="${v}"${ui.sort === v ? ' selected' : ''}>${l}</option>`)
    .join('');
  return `
    <div class="src-toolbar">
      <input type="search" id="sourceSearch" class="src-input"
        placeholder="Find a source…" value="${deps.escapeAttr(ui.query)}"
        aria-label="Filter sources">
      <select id="sourceKindFilter" class="src-select src-select--wide"
        aria-label="Filter by kind">${options}</select>
      <select id="sourceSort" class="src-select src-select--wide"
        aria-label="Sort order">${sorts}</select>
      <label class="src-check">
        <input type="checkbox" id="sourceAttentionOnly"${ui.attentionOnly ? ' checked' : ''}>
        <span>needs attention</span>
      </label>
      <span class="src-toolbar__count">${
        shown === total ? `${total} shown` : `${shown} of ${total}`
      }</span>
    </div>
  `;
}

/**
 * @param {Array<{ source: any, index: number }>} rows
 * @param {Map<string, number>} reach
 * @param {Map<string, { total: number, withVideo: number, url: string|null }>} videos
 */
function renderGroups(rows, reach, videos) {
  /** @type {Map<string, Array<{ source: any, index: number }>>} */
  const groups = new Map();
  for (const row of rows) {
    const kind = row.source?.kind ?? 'other';
    if (!groups.has(kind)) groups.set(kind, []);
    groups.get(kind).push(row);
  }
  // Registry order, not alphabetical: SOURCE_KINDS runs from the pages a
  // dataset is built from down to the odds and ends, which is the order an
  // editor reads them in.
  const ordered = [...groups.entries()].sort(
    (a, b) => SOURCE_KINDS.indexOf(a[0]) - SOURCE_KINDS.indexOf(b[0]),
  );

  return ordered
    .map(([kind, items]) => {
      // A search narrows to what was asked for; honouring a collapsed group
      // then would hide the hit that was just searched for.
      const open = ui.open.has(kind) || Boolean(ui.query.trim()) || ui.attentionOnly;
      const attention = items.filter(
        ({ source, index: _i }) => triage(source, reach.get(source?.id) ?? 0).needsWork,
      ).length;
      // Recordings only mean something for the pages a session was read off.
      // A column of "no video" against sponsor listings would be noise dressed
      // as a gap.
      const showVideo = kind === 'sessions';
      const missing = showVideo
        ? items.filter(({ source }) => {
            const v = videos.get(source?.id);
            return v && v.withVideo === 0;
          }).length
        : 0;
      return `
        <section class="src-group${open ? ' is-open' : ''}">
          <button type="button" class="src-group__head" data-group-toggle="${kind}"
            aria-expanded="${open}">
            <span class="src-group__caret" aria-hidden="true"></span>
            <span class="src-group__title">${KIND_TITLE[kind] ?? kind}</span>
            <span class="src-tag">${items.length}</span>
            <span class="src-group__flags">
              ${missing ? `<span class="src-tag">${missing} no video</span>` : ''}
              ${attention ? `<span class="src-tag src-tag--warn">${attention} to check</span>` : ''}
            </span>
          </button>
          ${
            open
              ? `<div class="src-list${showVideo ? ' src-list--video' : ''}">${items
                  .map(({ source, index }) =>
                    renderRow(
                      source,
                      index,
                      reach.get(source.id) ?? 0,
                      showVideo ? videos.get(source.id) : undefined,
                    ),
                  )
                  .join('')}</div>`
              : ''
          }
        </section>`;
    })
    .join('');
}

/**
 * The recordings cell: whether the sessions read off this page were ever
 * captured on video.
 *
 * Read-only. A recording belongs to the session, and the Sessions tab is where
 * a session is edited — putting an editable field here would create a second
 * place to change one value. What it is for is seeing the gap while reading the
 * register, which is the moment you would notice it.
 *
 * @param {{ total: number, withVideo: number, url: string|null } | undefined} video
 */
function renderVideo(video) {
  if (!video) return '';
  const { escapeAttr } = deps;
  if (!video.withVideo) {
    return `<div class="src-row__video"><span class="src-sub">no video</span></div>`;
  }
  const label =
    video.withVideo === video.total && video.total === 1
      ? 'video'
      : `${video.withVideo}/${video.total} video`;
  return `<div class="src-row__video">
    <a class="src-btn src-btn--quiet" href="${escapeAttr(video.url)}" target="_blank"
       rel="noopener noreferrer">${label}</a>
  </div>`;
}

/**
 * The line under a row's date box: what the source's real last-used date is,
 * when it is not the one in the box.
 *
 * The box holds `retrievedAt` and nothing else, because that is the only date
 * a person may type. But a source can also be dated by a capture stamp or by a
 * check, and either can be the more recent fact. Saying so under the box is how
 * a 2013 capture stops reading as "undated" and a check last month stops
 * reading as "stale".
 *
 * @param {{ date: string|null, basis: string }} used
 * @param {any} source
 */
function usedNote(used, source) {
  const typed = (source?.retrievedAt ?? '').slice(0, 10);
  if (!used.date) return 'never dated';
  if (used.basis === 'retrieved' && used.date === typed) return 'retrieved';
  return `${used.basis === 'verified' ? 'checked' : 'captured'} ${used.date}`;
}

function renderRow(source, index, reach, video) {
  const { escapeAttr, escapeHtml } = deps;
  const confidence = sourceConfidence(source);
  const problems = validateSource(source, index);
  const stated = source?.via?.provider === 'stated';
  const wayback = source?.via?.provider === 'wayback';
  const used = sourceLastUsed(source);

  const link = source.url
    ? `<a class="src-url" href="${escapeAttr(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(sourceLabel(source))}</a>`
    : `<span class="src-url src-url--stated">${escapeHtml(sourceLabel(source))}</span>`;

  // The capture is offered as its own control, not in place of the original. A
  // reader following provenance wants both: what the address was, and what
  // survives. The archive view stopped rendering per-source capture links — one
  // standing note covers them — but an EDITOR is the one person who needs to
  // open the capture: they are checking whether the source says what the dataset
  // claims. So it stays here, and only here. It is a button rather than a link
  // in prose so that everything clickable on this row looks clickable the same way.
  const capture = wayback
    ? `<a class="src-btn src-btn--quiet" href="${escapeAttr(source.via.captureUrl)}"
         target="_blank" rel="noopener noreferrer"
         title="Open the archive.org capture">capture</a>`
    : '';

  return `
    <div class="src-row${problems.length ? ' src-row--invalid' : ''}" data-source-index="${index}">
      <div class="src-row__main">
        <div class="src-row__label">${link}</div>
        <div class="src-row__meta">
          <span class="src-tag src-tag--${confidence}">${confidence}</span>
          <select class="src-select" data-source-kind="${index}"
            title="${escapeAttr(KIND_HINT[source.kind] ?? '')}"
            aria-label="Kind">${kindOptions(source.kind)}</select>
          ${stated ? '<span class="src-tag src-tag--dash">no link</span>' : ''}
          <span class="src-sub${reach ? '' : ' src-sub--flag'}">${
            reach ? `${reach} record${reach === 1 ? '' : 's'}` : 'cited by nothing'
          }</span>
        </div>
        ${problems.length ? `<p class="src-problem">${escapeHtml(problems[0])}</p>` : ''}
      </div>
      ${renderVideo(video)}
      <div class="src-row__used">
        <input type="date" class="src-input src-input--date" data-source-retrieved="${index}"
          value="${escapeAttr((source.retrievedAt ?? '').slice(0, 10))}"
          title="When this source was last read. Clear it to record that nobody knows."
          aria-label="Date retrieved">
        <span class="src-sub">${usedNote(used, source)}</span>
      </div>
      <div class="src-row__actions">
        ${capture}
        ${renderVerify(source, index)}
        <button type="button" class="src-btn src-btn--drop" data-source-remove="${index}"
          title="Remove this source" aria-label="Remove source"><span aria-hidden="true">&times;</span></button>
      </div>
    </div>
  `;
}

function renderVerify(source, index) {
  if (source.verifiedAt && source.verifiedBy !== 'policy') {
    return `<button type="button" class="src-btn src-btn--on" data-source-unverify="${index}"
      title="Verified ${deps.escapeAttr(source.verifiedAt)} — click to undo">verified</button>`;
  }
  // A policy-accepted source can still be confirmed by hand; that is an upgrade,
  // not a no-op, so the button stays available and says what it would do.
  const label = source.verifiedBy === 'policy' ? 'confirm' : 'verify';
  const note =
    source.verifiedBy === 'policy' ? ' title="Accepted by policy — confirm by hand"' : '';
  return `<button type="button" class="src-btn" data-source-verify="${index}"${note}>${label}</button>`;
}

function renderAddRow() {
  return `
    <section class="src-panel src-panel--act">
      <div class="src-panel__head">
        <h3 class="src-head">Add a source</h3>
      </div>
      <div class="src-add">
        <input type="text" id="newSourceValue" class="src-input"
          placeholder="https://… or describe where it came from"
          aria-label="Source URL or statement">
        <select id="newSourceKind" class="src-select src-select--wide"
          aria-label="Kind">${kindOptions('schedule')}</select>
        <button type="button" class="src-btn src-btn--go" id="addSource">Add</button>
      </div>
      <p class="src-note src-note--live" id="newSourcePreview"></p>
    </section>
  `;
}

/**
 * Turn one stray URL into a source, draining its field when the field exists
 * only to hold URLs.
 *
 * Exported and pure-ish (it mutates the dataset it is handed, nothing else) so
 * the move-vs-copy rule is testable: getting it wrong either loses a URL or
 * leaves the same address being edited in two places.
 *
 * @param {any} dataset
 * @param {{ url: string, field: string, mode: 'move'|'copy', index: number|null }} stray
 * @param {string} kind
 * @returns {any|null} the source that was added, or null when it could not be
 */
export function fileStray(dataset, stray, kind) {
  const event = dataset?.event;
  if (!event) return null;
  if (!Array.isArray(event.sources)) event.sources = [];
  const source = sourceFromInput({
    value: stray.url,
    kind,
    taken: event.sources.map((/** @type {any} */ s) => s.id),
  });
  if (!source) return null;
  event.sources.push(source);
  if (stray.mode === 'move' && Array.isArray(event[stray.field])) {
    // Match by value rather than by the index the list was rendered with: the
    // array may have shifted under a "file all" that removed an earlier entry.
    const at = event[stray.field].findIndex(
      (/** @type {any} */ v) => typeof v === 'string' && v.trim() === stray.url,
    );
    if (at !== -1) event[stray.field].splice(at, 1);
  }
  return source;
}

/** Wire the panel's controls. Called by render; safe to call again. */
export function wireSourcesPanel() {
  const container = document.getElementById('sourcesEditorContent');
  if (!container) return;
  const list = sources();
  if (!list) return;

  container.querySelectorAll('[data-group-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.groupToggle;
      if (ui.open.has(kind)) ui.open.delete(kind);
      else ui.open.add(kind);
      renderSourcesEditor();
    });
  });

  const search = /** @type {HTMLInputElement|null} */ (document.getElementById('sourceSearch'));
  search?.addEventListener('input', () => {
    ui.query = search.value;
    renderSourcesEditor();
    // Re-rendering blows away focus, and a filter box that loses the caret on
    // every keystroke cannot be typed into.
    const next = /** @type {HTMLInputElement|null} */ (document.getElementById('sourceSearch'));
    next?.focus();
    next?.setSelectionRange(next.value.length, next.value.length);
  });

  document.getElementById('sourceKindFilter')?.addEventListener('change', (event) => {
    ui.kind = /** @type {HTMLSelectElement} */ (event.target).value;
    renderSourcesEditor();
  });

  document.getElementById('sourceSort')?.addEventListener('change', (event) => {
    ui.sort = /** @type {HTMLSelectElement} */ (event.target).value;
    renderSourcesEditor();
  });

  document.getElementById('sourceAttentionOnly')?.addEventListener('change', (event) => {
    ui.attentionOnly = /** @type {HTMLInputElement} */ (event.target).checked;
    renderSourcesEditor();
  });

  wireFeed();
  wireStrays(container);

  container.querySelectorAll('[data-source-kind]').forEach((select) => {
    select.addEventListener('change', () => {
      const source = list[Number(select.dataset.sourceKind)];
      if (!source) return;
      source.kind = select.value;
      // Changing the kind can change whether policy covers it, so a
      // policy-accepted source must lose that acceptance rather than carry it
      // across to a kind the policy never covered.
      if (source.verifiedBy === 'policy' && !autoVerifiable(source)) {
        delete source.verifiedAt;
        delete source.verifiedBy;
      }
      changed();
      renderSourcesEditor();
    });
  });

  container.querySelectorAll('[data-source-retrieved]').forEach((input) => {
    input.addEventListener('change', () => {
      const source = list[Number(input.dataset.sourceRetrieved)];
      if (!source) return;
      if (input.value) source.retrievedAt = input.value;
      else delete source.retrievedAt;
      changed();
      renderSourcesEditor();
    });
  });

  container.querySelectorAll('[data-source-verify]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const source = list[Number(btn.dataset.sourceVerify)];
      if (!source) return;
      source.verifiedAt = new Date().toISOString().slice(0, 10);
      source.verifiedBy = 'human';
      changed();
      renderSourcesEditor();
    });
  });

  container.querySelectorAll('[data-source-unverify]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const source = list[Number(btn.dataset.sourceUnverify)];
      if (!source) return;
      delete source.verifiedAt;
      delete source.verifiedBy;
      changed();
      renderSourcesEditor();
    });
  });

  container.querySelectorAll('[data-source-remove]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const index = Number(btn.dataset.sourceRemove);
      const source = list[index];
      if (!source) return;
      const reach = sourceReach(deps.state.dataset).get(source.id) ?? 0;
      // Removing a cited source leaves dangling references that break no page
      // and so would go unnoticed until the audit ran. Say so first.
      if (reach && !window.confirm(`${reach} record(s) cite this source. Remove it anyway?`)) {
        return;
      }
      list.splice(index, 1);
      changed();
      renderSourcesEditor();
    });
  });

  const input = /** @type {HTMLInputElement|null} */ (document.getElementById('newSourceValue'));
  const preview = document.getElementById('newSourcePreview');
  const kind = /** @type {HTMLSelectElement|null} */ (document.getElementById('newSourceKind'));

  input?.addEventListener('input', () => {
    if (!preview) return;
    const { tone, message } = inputPreview(input.value);
    preview.textContent = message;
    preview.className = `src-note src-note--live src-note--${tone}`;
  });

  const add = () => {
    if (!input || !kind) return;
    const source = sourceFromInput({
      value: input.value,
      kind: kind.value,
      taken: list.map((s) => s.id),
    });
    if (!source) return;
    list.push(source);
    input.value = '';
    // A source added by hand into a group that is collapsed would vanish on
    // save, which reads as the Add button not working.
    ui.open.add(source.kind);
    changed();
    renderSourcesEditor();
    document.getElementById('newSourceValue')?.focus();
  };

  document.getElementById('addSource')?.addEventListener('click', add);
  input?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      add();
    }
  });
}

/**
 * Wire the calendar-feed fields.
 *
 * Re-renders the whole panel on change rather than patching in place, because
 * every one of these edits changes something else on the page: setting the ICS
 * URL enables the auto-update box and adds a row to the unfiled worklist,
 * clearing it does the reverse, and the toggle rewrites the status sentence.
 */
function wireFeed() {
  const event = deps.state?.dataset?.event;
  if (!event) return;

  /** @param {string} key @param {any} value */
  const apply = (key, value) => {
    setCalendarFeed(event, { [key]: value });
    changed();
    renderSourcesEditor();
  };

  for (const [id, key] of [
    ['feedIcs', 'ics'],
    ['feedJson', 'json'],
    ['feedNote', 'note'],
  ]) {
    const input = /** @type {HTMLInputElement|null} */ (document.getElementById(id));
    input?.addEventListener('change', () => apply(key, input.value));
  }

  const auto = /** @type {HTMLInputElement|null} */ (document.getElementById('feedAuto'));
  auto?.addEventListener('change', () => apply('autoUpdate', auto.checked));

  document.getElementById('feedCheck')?.addEventListener('click', () => deps.onCheckFeed?.());
}

/** @param {Element} container */
function wireStrays(container) {
  const strays = strayEventUrls(deps.state.dataset);
  if (!strays.length) return;

  const kindOf = (/** @type {number} */ i) => {
    const select = /** @type {HTMLSelectElement|null} */ (
      container.querySelector(`[data-stray-kind="${i}"]`)
    );
    return select?.value ?? strays[i].kind;
  };

  container.querySelectorAll('[data-stray-file]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const i = Number(btn.dataset.strayFile);
      const stray = strays[i];
      if (!stray) return;
      const source = fileStray(deps.state.dataset, stray, kindOf(i));
      if (source) ui.open.add(source.kind);
      changed();
      renderSourcesEditor();
    });
  });

  document.getElementById('fileAllStrays')?.addEventListener('click', () => {
    strays.forEach((stray, i) => {
      const source = fileStray(deps.state.dataset, stray, kindOf(i));
      if (source) ui.open.add(source.kind);
    });
    changed();
    renderSourcesEditor();
  });
}

/**
 * The Sponsors tab's "sponsor listing page" field.
 *
 * Sponsor attribution is the archive's weakest link: most sponsor entries are
 * attributed to a schedule page by fallback, because no sponsors page was ever
 * captured — and a schedule page did not say who sponsored the event. This is
 * the one field that fixes that, so it lives where the sponsors are edited
 * rather than making someone go and find the Sources tab.
 *
 * Setting it creates (or updates) a `sponsors` source and points every sponsor
 * at it, replacing whatever fallback they were carrying. Clearing it removes
 * the source and leaves the sponsors to be re-attributed by the backfill.
 */
export function renderSponsorSourceField() {
  const input = /** @type {HTMLInputElement|null} */ (document.getElementById('sponsorSourceUrl'));
  const note = document.getElementById('sponsorSourceNote');
  if (!input) return;
  const list = sources();
  const sponsors = deps.state?.dataset?.event?.sponsors ?? [];
  const existing = list?.find((s) => s.kind === 'sponsors');
  input.value = existing?.url ?? '';
  if (note) note.textContent = sponsorSourceNote(existing, sponsors.length);

  if (input.dataset.wired) return;
  input.dataset.wired = '1';
  input.addEventListener('change', () => {
    const all = sources();
    if (!all) return;
    const current = all.find((s) => s.kind === 'sponsors');
    const value = input.value.trim();

    if (!value) {
      if (current) {
        const gone = current.id;
        all.splice(all.indexOf(current), 1);
        for (const sponsor of deps.state.dataset.event.sponsors ?? []) {
          if (Array.isArray(sponsor.sourceIds)) {
            sponsor.sourceIds = sponsor.sourceIds.filter((id) => id !== gone);
            if (!sponsor.sourceIds.length) delete sponsor.sourceIds;
          }
        }
      }
    } else if (current) {
      // Same source, new address — keep the id so every sponsor pointing at it
      // stays pointed at it. Re-deriving would orphan the lot.
      const rebuilt = sourceFromInput({ value, kind: 'sponsors', id: current.id });
      if (rebuilt) Object.assign(current, rebuilt, { id: current.id });
    } else {
      const created = sourceFromInput({
        value,
        kind: 'sponsors',
        retrievedAt: new Date().toISOString().slice(0, 10),
        taken: all.map((s) => s.id),
      });
      if (created) {
        all.push(created);
        for (const sponsor of deps.state.dataset.event.sponsors ?? []) {
          sponsor.sourceIds = [created.id];
        }
      }
    }
    deps.markDirty(true);
    renderSponsorSourceField();
    renderSourcesEditor();
  });
}

/** @param {any} source @param {number} count */
function sponsorSourceNote(source, count) {
  if (!count) return 'No sponsors recorded for this event yet.';
  if (!source) {
    return `${count} sponsor${count === 1 ? '' : 's'} recorded, with no listing page — they fall back to the schedule, which never said who sponsored anything. Add the page here.`;
  }
  return `${count} sponsor${count === 1 ? '' : 's'} attributed to this page.`;
}
