// Is this item a session, or is it lunch?
//
// The archive measures a community's PROGRAMME — talks, keynotes, BOFs. Coffee
// breaks, registration and the closing drinks are on the schedule and belong in
// the schedule view, but counting them as sessions inflates every total, drags
// the topic vocabulary toward "lunch", and puts a page called Registration in a
// list of session pages.
//
// Lives under app/js/modules rather than lib/ because the archive's client needs
// it and only `app/` is served — the same reason sources.js sits here. Pure ESM,
// no Node imports, so the server reads it from here happily. lib/archiveInsights.js
// re-exports it so existing importers are untouched.
//
// PORTED: tools/server/sessionkind.go implements this rule for the Go coverage
// report, so this is no longer the only copy. The two are held together by
// tools/server/testdata/session-kind-cases.json, which both test suites read —
// change the vocabulary or the precedence here and the Go build fails. Add a
// case to that fixture when you change the behaviour; never change one side
// alone. See docs/go-port.md.

// Agenda/logistics items ("Lunch", "Morning Tea", "Registration & Coffee") — not
// real sessions. We only drop a title when EVERY word is a logistics/modifier word
// (and at least one is a real logistics word), so a single content word rescues it:
// "Registration" → dropped, but "Rethinking Event Registration" → kept.
const AGENDA_WORDS = new Set([
  'lunch',
  'breakfast',
  'dinner',
  'brunch',
  'supper',
  'tea',
  'coffee',
  'drinks',
  'refreshments',
  'snacks',
  'registration',
  'checkin',
  'signin',
  'welcome',
  'opening',
  'closing',
  'remarks',
  'networking',
  'social',
  'party',
  'afterparty',
  'reception',
  'photo',
  'photos',
  'announcements',
  'housekeeping',
  'arrivals',
  'arrival',
  'doors',
  'break',
  'breaks',
  'pause',
  'wrapup',
  'mingling',
  'icebreaker',
]);
const AGENDA_MOD = new Set([
  'morning',
  'afternoon',
  'evening',
  'short',
  'quick',
  'group',
  'mid',
  'light',
  'optional',
]);
const AGENDA_FILLER = new Set([
  'time',
  'session',
  'sessions',
  'and',
  'with',
  'the',
  'a',
  'an',
  'to',
  'amp',
  'your',
  'our',
  'min',
  'mins',
  'minute',
  'minutes',
  'hr',
  'hrs',
  'hour',
  'hours',
  'am',
  'pm',
  'room',
  'hall',
]);

/** True when a session title is pure agenda/logistics (see AGENDA_WORDS note). */
export function isAgendaTitle(title) {
  const toks = String(title || '')
    .toLowerCase()
    .replace(/['’.]/g, '')
    .replace(/-/g, '')
    .replace(/[()[\]{}:;!?"“”]/g, ' ')
    .split(/[\s&/+,–—]+/)
    .filter((w) => w && !/^\d+$/.test(w) && !AGENDA_FILLER.has(w));
  if (!toks.length) return false;
  return (
    toks.every((w) => AGENDA_WORDS.has(w) || AGENDA_MOD.has(w)) &&
    toks.some((w) => AGENDA_WORDS.has(w))
  );
}

/**
 * What sort of thing is this item?
 *
 * `track` answers "what is it about"; this answers "what is it". They are
 * different questions and must not share a field — track drives the topic
 * charts and the track filter, so a "Social" track would put the pub quiz in
 * the topic vocabulary, which is the exact failure this module exists to
 * prevent.
 *
 *   session   a talk, keynote, panel, BOF — the default
 *   workshop  hands-on programme: sprints, summits, training, workshops
 *   social    trivia, dinners, apéros, tours, awards — real programme, but not
 *             content, and not a session for counting purposes
 *   agenda    lunch, breaks, registration — logistics
 *
 * `kind` is the authority when present; `isAgendaItem` is the older spelling of
 * `kind: 'agenda'` and is still honoured, because most of the archive predates
 * this field. Title heuristics remain the last resort.
 *
 * @param {{kind?: string, title?: string, isAgendaItem?: boolean}} item
 * @returns {'session'|'workshop'|'social'|'agenda'}
 */
export function itemKind(item) {
  const raw = String(item?.kind || '').toLowerCase();
  if (raw === 'session' || raw === 'workshop' || raw === 'social' || raw === 'agenda') return raw;
  if (typeof item?.isAgendaItem === 'boolean') return item.isAgendaItem ? 'agenda' : 'session';
  return isAgendaTitle(item?.title) ? 'agenda' : 'session';
}

/**
 * Was this item called off?
 *
 * A cancelled session is recorded but never shown: the archive's job is to say
 * what happened, and a talk that did not happen must not sit in the programme
 * looking like it did. Keeping the row (rather than deleting it) preserves the
 * evidence — Drupal Mountain Camp 2022's schedule really does say
 * "CANCELLED! Social activity: Dinner & drinks".
 *
 * @param {{cancelled?: boolean}} item
 */
export function isCancelled(item) {
  return item?.cancelled === true;
}

/** Kinds that count as programme content for session totals. */
const COUNTING_KINDS = new Set(['session', 'workshop']);

/**
 * Should this item count as a session in the archive?
 *
 * The archive measures the community's PROGRAMME — talks, keynotes, BOFs — so
 * lunch, morning tea and registration must not inflate session counts, topic
 * charts or search results. Until now that judgement came only from the title,
 * which is a guess and wrong in both directions:
 *
 *   - A sponsored break is a real, named thing. "Morning Tea, proudly sponsored
 *     by Acme" has a sponsor, a room and a time, and reads like a session to any
 *     heuristic — but it is not one.
 *   - A genuine talk can be named after logistics. "Rethinking Event
 *     Registration" is a session; "Registration" is not.
 *
 * So `isAgendaItem` on the item is the authority when it is present, in BOTH
 * directions, and the title heuristic is only the fallback for the datasets
 * (all 84 of them today) written before the field existed.
 *
 * @param {{title?: string, isAgendaItem?: boolean}} item
 * @returns {boolean} true when the item is a real session
 */
export function countsAsSession(item) {
  if (isCancelled(item)) return false;
  return COUNTING_KINDS.has(itemKind(item));
}
