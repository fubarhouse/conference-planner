// Shared conference-span helpers for the planner timelines and day agenda. A
// planner's associated event (state.eventMeta) has a start/end; these derive the
// day span, a display name, and the amber "band" row that marks the conference on
// the personal and sponsor timelines — consistent with the itinerary banner and
// the map pin. Pure (no DOM state); imported directly by the render modules.

import { escapeHtml as esc } from './utils.js';

/**
 * Inclusive list of the conference's own days (YYYY-MM-DD) from the event meta.
 * Callers gate on isConference; returns [] when there is no associated event.
 * @param {*} eventMeta - state.eventMeta
 * @returns {string[]}
 */
export function conferenceSpanDays(eventMeta) {
  const em = eventMeta || {};
  if (!em.startDate) return [];
  const out = [];
  const cur = new Date(`${String(em.startDate).slice(0, 10)}T00:00:00`);
  const end = new Date(`${String(em.endDate || em.startDate).slice(0, 10)}T00:00:00`);
  let guard = 0;
  while (cur <= end && guard++ < 62) {
    const m = String(cur.getMonth() + 1).padStart(2, '0');
    const d = String(cur.getDate()).padStart(2, '0');
    out.push(`${cur.getFullYear()}-${m}-${d}`);
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

/** @param {*} eventMeta */
export function conferenceName(eventMeta) {
  const em = eventMeta || {};
  return [em.designation, em.year].filter(Boolean).join(' ') || 'Conference';
}

/**
 * Union of conference days across ALL associated events (a trip can span several
 * co-located conferences). Sorted, de-duped. For a single event this equals
 * conferenceSpanDays(that event) — no change for the common case.
 * @param {{ meta: any }[]} events - state.events
 * @returns {string[]}
 */
export function conferenceSpanDaysMulti(events) {
  const set = new Set();
  for (const e of events || []) conferenceSpanDays(e.meta).forEach((d) => set.add(d));
  return [...set].sort();
}

/** Combined display label for several events, e.g. "DrupalCon 2026 + Summit 2026".
 * @param {{ meta: any }[]} events */
export function conferenceNamesMulti(events) {
  const names = (events || []).map((e) => conferenceName(e.meta)).filter(Boolean);
  return [...new Set(names)].join(' + ') || 'Conference';
}

/** Row accents: amber for a conference day, slate for a ticketed day that falls
 * outside the conference (a side event, workshop, or a non-conference trip). */
export const CONFERENCE_ROW_ACCENT = ';border-top:3px solid #f59e0b';
export const TICKET_ROW_ACCENT = ';border-top:3px solid #64748b';

/**
 * Every day a person holds a ticket for, derived from their tickets — NOT clamped
 * to the conference (so non-conference ticket days survive, to be shown in a
 * distinct colour). A ticket with an explicit `days` list covers those days; a
 * ticket with no `days` covers the full conference span. A person with no ticket
 * returns an empty set (the caller decides any full-span fallback).
 * @param {string} personId
 * @param {any[]} tickets - the context's ticket list (personal.tickets / org.tickets)
 * @param {string[]} fullSpan - conferenceSpanDays(eventMeta)
 * @returns {Set<string>}
 */
export function personTicketDays(personId, tickets, fullSpan) {
  const set = new Set();
  for (const t of tickets || []) {
    if (!t || t.assignedTo !== personId) continue;
    const days = Array.isArray(t.days) ? t.days.filter(Boolean) : [];
    if (days.length) days.forEach((d) => set.add(d));
    else fullSpan.forEach((d) => set.add(d)); // undated ticket → full conference span
  }
  return set;
}

/**
 * A readable amber legend chip naming the conference — shown alongside the
 * accommodation legend chips beneath the timeline (replaces the tiny in-cell
 * label). Empty string when there's no conference span.
 * @param {string[]} spanDays
 * @param {string} name
 * @returns {string}
 */
export function conferenceLegendChip(spanDays, name) {
  if (!spanDays.length) return '';
  // Same chip as every other legend entry — a swatch plus a name. The
  // conference band's own colour is the brand accent, since the conference is
  // the one thing on this timeline that IS the event.
  return `<span class="pl-legend"><span class="pl-legend__swatch" style="background:var(--brand-1-ink)" aria-hidden="true"></span>${esc(name)}</span>`;
}
