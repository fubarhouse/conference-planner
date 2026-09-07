// @ts-check
//
// Reader-owned annotations on the archive's time axis.
//
// Every chart in the archive plots years, and years are not neutral: 2020 is
// only a hole in the programme because the world stopped. The data cannot say
// that — nothing in an event dataset records why an event did not happen — so
// this is the reader's own margin note, written once and drawn on every chart
// that has a year axis.
//
// LOCAL, on purpose. These are not facts about the archive, they are one
// person's reading of it, and publishing them would put an unsourced claim
// beside sourced data. They live in localStorage and travel with the browser.
//
// GLOBAL, on purpose. An annotation is about a period, not about a series: the
// pandemic did not happen to DrupalCon and skip DrupalSouth. Scoping them to
// the series filter would have hidden the note the moment you narrowed the view
// — which is exactly when the gap it explains appears.
//
// A note covers one year or a span of them ("2020", "2020 to 2021"). Nothing
// finer: the charts have no sub-year resolution, so a date range would promise
// a precision no chart here can draw.

import { escapeHtml as esc } from './utils.js';

const KEY = 'archive.annotations.v1';

// The archive's own span plus room either side. Wide enough that no real event
// year is refused, narrow enough that a mistyped "202" or "20200" is.
export const YEAR_MIN = 1980;
export const YEAR_MAX = 2100;

export const MAX_LABEL = 60;
export const MAX_NOTE = 400;

// Colour comes from the SAME eleven-hue scale the topic lines use — the
// product-wide categorical instrument in foundation.css, already validated with
// the dataviz checker against both surfaces. A second palette invented for
// annotations would be a second unvalidated one, and would break the rule the
// scale exists to enforce: one meaning for "the third colour".
//
// Stored as an INDEX, not a hex. The scale is stepped separately for light and
// dark, so a stored `#2a78d6` would be the light-mode blue burnt into a note and
// carried unchanged onto the dark surface it was never validated against. An
// index resolves through the custom property and re-steps with the theme.
export const PALETTE_SIZE = 11;

/**
 * The CSS colour for a note. Past the eleventh slot the scale stops claiming
 * identity — the same neutral the topic chart falls back to, for the same
 * reason: two greys tell you they are both "other", where two near-identical
 * hues would lie.
 *
 * @param {{color?: number|null}} [a]
 * @returns {string}
 */
export function annotationColor(a) {
  const i = a?.color;
  // `typeof`, not Number.isInteger: only the former narrows number|null away for
  // the checker, and the integer-ness is already guaranteed by normalisation.
  return typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < PALETTE_SIZE
    ? `var(--viz-${i + 1})`
    : 'var(--viz-overflow)';
}

/**
 * The lowest slot no existing note is using — fixed order, never cycled, so a
 * note keeps its hue when another is deleted. Returns null once the scale is
 * exhausted, which resolves to the neutral above.
 *
 * @param {Annotation[]} [list]
 * @returns {number|null}
 */
export function nextColor(list = listAnnotations()) {
  const taken = new Set(list.map((a) => a.color));
  for (let i = 0; i < PALETTE_SIZE; i++) if (!taken.has(i)) return i;
  return null;
}

/**
 * @typedef {Object} Annotation
 * @property {string} id
 * @property {number} from   first year covered (inclusive)
 * @property {number} to     last year covered (inclusive; equals `from` for one year)
 * @property {string} label  the short name drawn on the chart
 * @property {string} note   optional longer text, shown on hover and in the rail
 * @property {number|null} color  index into the shared categorical scale, or null for the neutral
 * @property {boolean} hidden  kept, but not drawn on any chart
 */

/** @returns {Storage|null} */
function store() {
  // Private browsing can throw on ACCESS, not just on write — hence the try
  // around the read rather than around each call site.
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function newId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Coerce whatever came out of storage (or off a form) into a valid annotation.
 *
 * Returns null rather than throwing for anything unusable: a corrupt entry in
 * localStorage must cost that one note, not the whole list.
 *
 * @param {any} raw
 * @returns {Annotation|null}
 */
export function normaliseAnnotation(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const label = String(raw.label ?? '')
    .trim()
    .slice(0, MAX_LABEL);
  if (!label) return null;
  const from = Math.trunc(Number(raw.from));
  // A missing `to` is a one-year note, which is the common case — the form
  // leaves the second field empty for it rather than making you type the year
  // twice.
  const toRaw = raw.to === '' || raw.to == null ? from : Math.trunc(Number(raw.to));
  if (!Number.isFinite(from) || !Number.isFinite(toRaw)) return null;
  // Entered backwards is still an unambiguous range; refusing it would be
  // pedantry about the order of two numbers.
  const lo = Math.min(from, toRaw);
  const hi = Math.max(from, toRaw);
  if (lo < YEAR_MIN || hi > YEAR_MAX) return null;
  // A form hands this over as a string, storage as a number, and a note written
  // before colour existed hands over nothing at all — all three land on either a
  // valid slot or null, and null is resolved at save time, not here.
  const ci = Math.trunc(Number(raw.color));
  return {
    id: String(raw.id || '') || newId(),
    from: lo,
    to: hi,
    label,
    note: String(raw.note ?? '')
      .trim()
      .slice(0, MAX_NOTE),
    color: Number.isFinite(ci) && ci >= 0 && ci < PALETTE_SIZE ? ci : null,
    // Hiding is not deleting. A note you switched off is still written down —
    // this is the "clear the chart for a moment" control, not a way to lose the
    // sentence you wrote.
    hidden: raw.hidden === true || raw.hidden === 'true' || raw.hidden === 'on',
  };
}

/**
 * Earliest first, then shortest — so a one-year note draws over its span.
 * @param {Annotation} a
 * @param {Annotation} b
 */
const byYear = (a, b) => a.from - b.from || a.to - b.to || a.label.localeCompare(b.label);

/**
 * Every annotation, ordered along the time axis.
 * @returns {Annotation[]}
 */
export function listAnnotations() {
  const s = store();
  if (!s) return [];
  let raw;
  try {
    raw = JSON.parse(s.getItem(KEY) || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return /** @type {Annotation[]} */ (raw.map(normaliseAnnotation).filter(Boolean)).sort(byYear);
}

/** @param {Annotation[]} list */
function write(list) {
  const s = store();
  if (!s) return false;
  try {
    s.setItem(KEY, JSON.stringify(list));
  } catch {
    return false;
  }
  // One event for every mutation, so the charts have a single thing to listen
  // for and the rail does not have to know which of them are on screen.
  if (typeof document !== 'undefined' && typeof CustomEvent === 'function')
    document.dispatchEvent(new CustomEvent('archive:annotations', { detail: { list } }));
  return true;
}

/**
 * Create or update. An `id` that already exists is an edit; anything else is new.
 *
 * @param {any} input
 * @returns {Annotation|null} the stored annotation, or null if the input was unusable
 */
export function saveAnnotation(input) {
  const next = normaliseAnnotation(input);
  if (!next) return null;
  const list = listAnnotations();
  const at = list.findIndex((a) => a.id === next.id);
  // Only a note that has never had a colour gets one assigned. Re-deriving it on
  // every save would repaint a note the moment an earlier one was deleted, and
  // colour has to follow the entity rather than its position in the list.
  if (next.color === null) next.color = at >= 0 ? list[at].color : nextColor(list);
  if (at >= 0) list[at] = next;
  else list.push(next);
  return write(list.sort(byYear)) ? next : null;
}

/**
 * @param {string} id
 * @returns {boolean} true if something was removed
 */
export function removeAnnotation(id) {
  const list = listAnnotations();
  const next = list.filter((a) => a.id !== id);
  if (next.length === list.length) return false;
  return write(next);
}

/** @param {string} id */
export function getAnnotation(id) {
  return listAnnotations().find((a) => a.id === id) || null;
}

/**
 * Switch one note's marks on or off. Its own function rather than a `saveAnnotation`
 * call from the rail, because the rail would have to round-trip the whole record
 * to flip one flag — and a toggle that can fail validation is a toggle that can
 * silently eat a note whose text predates a rule.
 *
 * @param {string} id
 * @returns {boolean|null} the new hidden state, or null if there is no such note
 */
export function toggleAnnotation(id) {
  const list = listAnnotations();
  const a = list.find((x) => x.id === id);
  if (!a) return null;
  a.hidden = !a.hidden;
  return write(list) ? a.hidden : null;
}

/**
 * Annotations that overlap a plotted span, clipped to it.
 *
 * CLIPPED, not filtered: a note running 2019–2022 on a chart that starts in
 * 2020 is still about the years on screen, and dropping it would remove the
 * explanation from the only chart narrow enough to need it. The clipped copy
 * carries `clipped` so the drawing can say the band runs off the edge.
 *
 * Switched-off notes ARE dropped, here rather than at each call site: this is
 * the one road every chart takes to the list, so a note that is off is off
 * everywhere by construction instead of by four call sites remembering.
 *
 * @param {number} min
 * @param {number} max
 * @param {Annotation[]} [list]
 * @returns {Array<Annotation & {clipped: boolean}>}
 */
export function annotationsInSpan(min, max, list = listAnnotations()) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  const out = [];
  for (const a of list) {
    if (a.hidden) continue;
    if (a.to < min || a.from > max) continue;
    const from = Math.max(a.from, min);
    const to = Math.min(a.to, max);
    out.push({ ...a, from, to, clipped: from !== a.from || to !== a.to });
  }
  return out;
}

/**
 * "2020" or "2020–2021" — the en dash is deliberate, it is a range not a minus.
 * @param {{from: number, to: number}} a
 */
export function yearRangeLabel(a) {
  return a.from === a.to ? String(a.from) : `${a.from}–${a.to}`;
}

/**
 * Fractional position of a year within an ascending, possibly GAPPY year list.
 *
 * The sources trend plots `years[i]` at index `i`, and that list skips years
 * with no events — so year 2021 sitting between the 2019 and 2022 entries is at
 * index 1.67, not at any index the chart has a point for. Without this an
 * annotation for 2021 landed on 2019's tick.
 *
 * @param {number[]} years ascending
 * @param {number} year
 * @returns {number} index-space position, clamped to the list
 */
export function yearPos(years, year) {
  if (!years?.length) return 0;
  if (year <= years[0]) return 0;
  const last = years.length - 1;
  if (year >= years[last]) return last;
  for (let i = 0; i < last; i++) {
    if (year === years[i]) return i;
    if (year > years[i] && year < years[i + 1])
      return i + (year - years[i]) / (years[i + 1] - years[i]);
  }
  return last;
}

/**
 * SVG for the annotation layer of one chart.
 *
 * The caller owns its own geometry, so this takes a year→x function rather than
 * a box: four charts in this archive map years to pixels four different ways
 * (linear over the archive's full span, linear over the plotted span, by index,
 * by fractional index) and none of them is worth reproducing here.
 *
 * A single-year note is a dashed rule; a span is a band between two rules.
 *
 * Each note carries its own hue from the shared categorical scale, so colour
 * encodes WHICH note — the thing that actually distinguishes one from another
 * once there are several. It never encodes rank or recency.
 *
 * The mark FORM is what keeps a note from being read as a plotted series: a
 * full-height vertical band with dashed edges is nothing else on these charts,
 * where data is always a horizontal 2px run with dots. The band is also held at
 * a low fill-opacity so it reads as ground, not as a filled area chart.
 *
 * NO TEXT ON THE PLOT. The labels used to be set at the top of each band, and
 * they were the loudest thing on a chart whose subject is the data: four notes
 * put four strings across the drawing, they collided with each other and with
 * the line, and they had to be dropped on mobile — where the drawing is at its
 * most crowded and a reader most wants to know what the band is. The name now
 * lives in the tooltip, which is where the reader already goes to ask about a
 * year, and which has room to give the whole note rather than a 60-character
 * label. The <title> below keeps the same text reachable natively for the
 * charts with no tooltip layer of their own, and for assistive tech.
 *
 * Brand gold is still off-limits here — it already means "the year you filtered
 * to" on these charts, and a second gold thing reads as a second selection.
 *
 * @param {{
 *   x: (year: number) => number,
 *   top: number,
 *   bottom: number,
 *   min: number,
 *   max: number,
 *   list?: Annotation[],
 * }} opts
 * @returns {string}
 */
export function annotationMarks({ x, top, bottom, min, max, list }) {
  const rows = annotationsInSpan(min, max, list);
  if (!rows.length) return '';
  const h = bottom - top;
  if (!(h > 0)) return '';
  const parts = rows.map((a) => {
    const x1 = x(a.from);
    const x2 = x(a.to);
    const text = `${a.label} · ${yearRangeLabel(a)}${a.note ? ` — ${a.note}` : ''}`;
    const title = `<title>${esc(text)}</title>`;
    // A one-year note has no width to fill, so the rule IS the mark. A span
    // gets a band as well, which is what makes "these years, together" legible
    // at a glance.
    const col = annotationColor(a);
    const band =
      x2 - x1 > 0.5
        ? `<rect class="obs-ann-band" x="${x1.toFixed(1)}" y="${top.toFixed(1)}" width="${(x2 - x1).toFixed(1)}" height="${h.toFixed(1)}" style="fill:${col}"/>`
        : '';
    const edges = [x1, ...(x2 - x1 > 0.5 ? [x2] : [])]
      .map(
        (px) =>
          `<line class="obs-ann-rule" x1="${px.toFixed(1)}" y1="${top.toFixed(1)}" x2="${px.toFixed(1)}" y2="${bottom.toFixed(1)}" style="stroke:${col}"/>`,
      )
      .join('');
    // Named in the accessibility tree rather than hidden from it. With the text
    // gone from the plot, a reader who cannot use a tooltip would otherwise meet
    // a chart with an unexplained hole in it — the note is the explanation, so
    // it has to be reachable without hovering.
    return `<g role="img" aria-label="Note: ${esc(text)}" data-annotation="${esc(a.id)}">${band}${edges}${title}</g>`;
  });
  return `<g class="obs-ann-layer">${parts.join('')}</g>`;
}

/**
 * Years an annotation covers, as a Set — for the non-SVG charts (the year bars)
 * that mark whole columns rather than drawing on an axis.
 *
 * @param {Annotation[]} [list]
 * @returns {Map<number, Annotation[]>}
 */
export function annotationsByYear(list = listAnnotations()) {
  /** @type {Map<number, Annotation[]>} */
  const map = new Map();
  for (const a of list) {
    if (a.hidden) continue;
    for (let y = a.from; y <= a.to; y++) map.set(y, [...(map.get(y) || []), a]);
  }
  return map;
}
