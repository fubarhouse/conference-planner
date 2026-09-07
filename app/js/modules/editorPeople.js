// @ts-check
// The People tab: who ran the event, and who spoke at it.
//
// Two populations that look alike and are not:
//
//   - ORGANISERS and VOLUNTEERS live in `event.community.people`, captured from
//     the event's drupal.org community page. Their identity is a profile SLUG
//     (`/u/<slug>`), which is stable and resolvable.
//   - SPEAKERS live in `items[].speakers` as free display strings ("Gábor
//     Hojtsy"). There are ~4,300 distinct ones across the archive and they have
//     no profile, no id, and no guaranteed spelling between events.
//
// So speakers are DERIVED and read-only here: they are a projection of the
// schedule, and the schedule is where they are edited. Offering a delete button
// next to a name that is really a string inside six sessions would be a lie.
//
// The two populations do not join. Nothing in this file pretends otherwise —
// see `crossReference` for the one honest, opt-in bridge.

import { escapeHtml as esc } from './utils.js';

/** @typedef {{username: string, name?: string, role: string}} Person */
/** @typedef {{title: string, startTime?: string, link?: string}} Talk */

/** Roles that live in `event.community.people`, in display order. */
export const CREDIT_ROLES = /** @type {const} */ (['organiser', 'volunteer']);

/**
 * What to show for a credited person: the page's own wording when it differs
 * from the slug, else the slug.
 * @param {Person} p
 */
export function displayName(p) {
  return p?.name || p?.username || '';
}

/** Profile URL for a credited person. @param {Person} p */
export function profileUrl(p) {
  return p?.username ? `https://www.drupal.org/u/${encodeURIComponent(p.username)}` : '';
}

/**
 * Credited people for one role, sorted by display name.
 * @param {*} dataset
 * @param {string} role
 * @returns {Person[]}
 */
export function creditedBy(dataset, role) {
  const people = dataset?.event?.community?.people;
  if (!Array.isArray(people)) return [];
  return people
    .filter((p) => p && p.role === role)
    .slice()
    .sort((a, b) => displayName(a).localeCompare(displayName(b), undefined, { numeric: true }));
}

/**
 * Speakers projected from the schedule, each with the sessions they appear in.
 *
 * Source is `dataset.items` and nothing else — the OFFICIAL schedule. Hosted
 * events are deliberately excluded: they live on a planner
 * (`personal.hostedEvents`), they are one person's private annotation of a trip,
 * and folding them in here would put unverified names into the event's public
 * record of who spoke. Different provenance, different trust level, so they do
 * not mix.
 *
 * Grouped by the EXACT string, deliberately: "Gábor Hojtsy" and "gabor hojtsy"
 * stay separate rows, because merging them here would silently rewrite what the
 * dataset says. Near-duplicates are a curation problem with its own audit
 * (`npm run audit:archive`), not something to paper over in a listing.
 *
 * @param {*} dataset
 * @returns {Array<{name: string, talks: Talk[]}>}
 */
export function speakersFromSchedule(dataset) {
  const items = Array.isArray(dataset?.items) ? dataset.items : [];
  /** @type {Map<string, Talk[]>} */
  const byName = new Map();
  for (const item of items) {
    const names = Array.isArray(item?.speakers) ? item.speakers : [];
    for (const raw of names) {
      const name = String(raw || '').trim();
      if (!name) continue;
      if (!byName.has(name)) byName.set(name, []);
      /** @type {Talk[]} */ (byName.get(name)).push({
        title: String(item.title || 'Untitled session'),
        startTime: item.startTime,
        link: item.link,
      });
    }
  }
  return [...byName.entries()]
    .map(([name, talks]) => ({
      name,
      talks: talks.slice().sort((a, b) => String(a.startTime).localeCompare(String(b.startTime))),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/**
 * The only honest bridge between the two populations: an exact, case-insensitive
 * match between a speaker's display string and a credited person's display name
 * or slug.
 *
 * It is reported, never applied. On the sample event it matches a handful — most
 * speakers are credited under a completely different string, or not at all — and
 * a fuzzy match here would invent facts about real people. Capturing the
 * community page's own Speakers section (which lists drupal.org accounts) is the
 * real fix; see docs/todo.md.
 *
 * @param {*} dataset
 * @returns {Map<string, Person>} speaker display string -> credited person
 */
export function crossReference(dataset) {
  /** @type {Map<string, Person>} */
  const out = new Map();
  const people = dataset?.event?.community?.people;
  if (!Array.isArray(people)) return out;
  /** @type {Map<string, Person>} */
  const index = new Map();
  for (const p of people) {
    if (!p?.username) continue;
    index.set(String(p.username).toLowerCase(), p);
    if (p.name) index.set(String(p.name).toLowerCase(), p);
  }
  for (const { name } of speakersFromSchedule(dataset)) {
    const hit = index.get(name.toLowerCase());
    if (hit) out.set(name, hit);
  }
  return out;
}

// ── HTML (pure; the caller owns the DOM) ─────────────────────────────────────

/**
 * One editable credit row.
 * @param {Person} p
 * @param {number} index position in `event.community.people`
 */
export function creditRowHtml(p, index) {
  const differs = p.name && p.name !== p.username;
  return `<li class="edt-row people-row" data-person-index="${index}">
    <div class="people-row-main">
      <a class="people-row-name" href="${esc(profileUrl(p))}" target="_blank" rel="noopener">${esc(displayName(p))}</a>
      ${differs ? `<span class="people-row-slug">/u/${esc(p.username)}</span>` : ''}
    </div>
    <div class="people-row-actions">
      <button type="button" class="edt-act" data-person-edit="${index}">Edit</button>
      <button type="button" class="edt-act edt-act--del" data-person-remove="${index}">Remove</button>
    </div>
  </li>`;
}

/**
 * One derived speaker row, with the sessions they are on.
 * @param {{name: string, talks: Talk[]}} s
 * @param {Person|undefined} credited matching credit, when one exists
 */
export function speakerRowHtml(s, credited) {
  const talks = s.talks
    .map(
      (t) =>
        `<li class="people-talk">${
          t.link
            ? `<a href="${esc(t.link)}" target="_blank" rel="noopener">${esc(t.title)}</a>`
            : esc(t.title)
        }</li>`,
    )
    .join('');
  return `<li class="edt-row people-row people-row--speaker">
    <div class="people-row-main">
      <span class="people-row-name">${esc(s.name)}</span>
      ${
        credited
          ? `<span class="people-row-slug">also credited · /u/${esc(credited.username)}</span>`
          : ''
      }
      <ul class="people-talks">${talks}</ul>
    </div>
    <div class="people-row-actions">
      <span class="people-row-count">${s.talks.length} ${s.talks.length === 1 ? 'talk' : 'talks'}</span>
    </div>
  </li>`;
}

/**
 * The whole tab body: three groups, each with its own empty state.
 * @param {*} dataset
 */
export function peopleGroupsHtml(dataset) {
  const xref = crossReference(dataset);
  /**
   * @param {string} title
   * @param {string} note
   * @param {string[]} rows
   * @param {string} empty
   */
  const group = (title, note, rows, empty) =>
    // NOT .doc-divider — that lives in section-planner.css and the editor does
    // not load it, so the heading rendered as bare text ("Organisers5").
    `<section class="people-group">
      <div class="people-group-head">
        <h3 class="people-group-title">${esc(title)}</h3>
        <span class="people-group-count">${rows.length}</span>
      </div>
      <p class="edt-hint">${note}</p>
      ${rows.length ? `<ul class="edt-rows">${rows.join('')}</ul>` : `<p class="edt-empty">${esc(empty)}</p>`}
    </section>`;

  const people = Array.isArray(dataset?.event?.community?.people)
    ? dataset.event.community.people
    : [];
  // Index against the live array so edits address the right entry.
  /** @param {string} role */
  const rowsFor = (role) =>
    /** @type {Person[]} */ (people)
      .map((/** @type {Person} */ p, /** @type {number} */ i) => ({ p, i }))
      .filter((/** @type {{p: Person}} */ e) => e.p?.role === role)
      .sort((/** @type {*} */ a, /** @type {*} */ b) =>
        displayName(a.p).localeCompare(displayName(b.p), undefined, { numeric: true }),
      )
      .map((/** @type {{p: Person, i: number}} */ e) => creditRowHtml(e.p, e.i));

  const speakers = speakersFromSchedule(dataset);

  return (
    group(
      'Organisers',
      'From the drupal.org community page. Identity is the profile slug, not the display name.',
      rowsFor('organiser'),
      'No organisers captured. Add the community page URL above, then add them here.',
    ) +
    group(
      'Volunteers',
      'From the same page. Someone who both organised and volunteered appears in both lists.',
      rowsFor('volunteer'),
      'No volunteers captured.',
    ) +
    group(
      'Speakers',
      'Read from the schedule — edit these on the Sessions tab. Names are free text, so they do not link to profiles.',
      speakers.map((s) => speakerRowHtml(s, xref.get(s.name))),
      'No speakers in the schedule yet.',
    )
  );
}
