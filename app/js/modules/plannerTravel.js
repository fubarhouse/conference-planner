// Shared travel/leg primitives for the trip domain — travel modes, statuses,
// their badges/icons, leg sorting, a blank-leg factory, and the timeline colour
// palette. These are the leaf layer the map, documents, dashboard, team,
// itinerary, and org-planning code all build on, so they are imported directly
// (no init injection) and free of planner state.

import { escapeHtml as esc } from './utils.js';
import { makeItemId } from './plannerStorage.js';

export const TRAVEL_MODES = {
  flight: { label: '✈ Flight', icon: 'fas fa-plane-departure', returnIcon: 'fas fa-plane-arrival' },
  train: { label: '🚂 Train', icon: 'fas fa-train' },
  bus: { label: '🚌 Bus', icon: 'fas fa-bus' },
  ferry: { label: '⛴ Ferry', icon: 'fas fa-ship' },
  car: { label: '🚗 Transfer', icon: 'fas fa-car' },
  taxi: { label: '🚕 Taxi', icon: 'fas fa-taxi' },
  rideshare: { label: '📱 Rideshare', icon: 'fas fa-car-side' },
  other: { label: '↔ Other', icon: 'fas fa-route' },
};

export const TRAVEL_STATUSES = [
  { value: '', label: '— No status —' },
  { value: 'needs-booking', label: 'Needs Booking' },
  { value: 'shortlisted', label: 'Shortlisted' },
  { value: 'booked', label: 'Booked' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'paid', label: 'Paid' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'refunded', label: 'Refunded' },
];

export function travelStatusBadge(status) {
  if (!status) return '';
  const entry = TRAVEL_STATUSES.find((s) => s.value === status);
  if (!entry || !entry.value) return '';
  // The status is carried as data, and the stylesheet decides how it looks.
  // It used to ship seven Tailwind colour pairs — a different hue per status,
  // which reads as decoration rather than as a scale. Booked/confirmed/paid are
  // all "this is sorted"; cancelled and refunded are not states you want a
  // colour for at all.
  return `<span class="pl-pill" data-status="${esc(status)}">${esc(entry.label)}</span>`;
}

export function travelIcon(mode, isReturn) {
  const m = TRAVEL_MODES[mode] || TRAVEL_MODES.other;
  return isReturn && m.returnIcon ? m.returnIcon : m.icon;
}

export function sortLegs(legs) {
  return [...legs].sort((a, b) => {
    const ka = `${a.date || '9999-99-99'}${a.departTime || ''}`;
    const kb = `${b.date || '9999-99-99'}${b.departTime || ''}`;
    return ka.localeCompare(kb);
  });
}

export function makeLeg() {
  return {
    id: makeItemId('leg'),
    mode: 'flight',
    status: '',
    date: '',
    arriveDate: '',
    ref: '',
    from: '',
    to: '',
    departTime: '',
    arriveTime: '',
    departTz: '',
    arriveTz: '',
    confirmation: '',
    notes: '',
    filePath: '',
    fileLabel: '',
    receiptId: '',
  };
}

// Stripe colours for the timeline, drawn from the product's ONE validated
// categorical ramp (`--viz-*` in foundation.css) rather than a private set of
// pastels. The colour is doing real work here — it is what ties a legend chip
// to its band on the timeline — so it stays; it just stops being a sixth
// palette nobody checked for colour-blind separation.
// Each entry keeps the three roles the timeline actually has: a FILL the band is
// painted with, a RULE under it, and TEXT printed on top of the fill. Pointing
// all three at the same `--viz-*` step (as the first pass did) painted a band at
// full chroma and then printed its own colour on it — the row labels became
// invisible and five saturated bands read as a rainbow. The fill is a tint of
// the hue mixed into the page, so the identity survives, the label stays
// legible, and the accent lands on the rule where it belongs.
const stripe = (v) => ({
  bg: `color-mix(in srgb, ${v} 20%, var(--paper-1))`,
  border: v,
  text: v,
});

export const TIMELINE_COLORS = [
  stripe('var(--viz-1)'),
  stripe('var(--viz-3)'),
  stripe('var(--viz-7)'),
  stripe('var(--viz-2)'),
  stripe('var(--viz-5)'),
];

/**
 * Background style for an accommodation cell on the planner timelines. Interior
 * nights are solid; the day you leave fades the colour out; a day you move (check
 * out of one place, into another) blends from the place you leave (left) to the
 * place you arrive (right). Soft gradients replace the old hard 50/50 split.
 * @param {object} opts
 * @param {{bg:string,border:string}} [opts.color] - the day's primary stay colour
 * @param {{bg:string,border:string}} [opts.splitColor] - the place being left (split days)
 * @param {'stay'|'checkout'|'split'} [opts.kind]
 * @returns {string} inline style (background + bottom border), or '' when no stay
 */
export function accomCellBg({ color, splitColor, kind = 'stay' } = {}) {
  if (!color) return '';
  const border = `border-bottom:2px solid ${color.border}`;
  if (kind === 'split' && splitColor) {
    return `background:linear-gradient(to right, ${splitColor.bg} 0%, ${splitColor.bg} 28%, ${color.bg} 72%, ${color.bg} 100%);border-bottom:2px solid ${color.border}`;
  }
  if (kind === 'checkout') {
    return `background:linear-gradient(to right, ${color.bg} 0%, ${color.bg} 42%, transparent 100%);${border}`;
  }
  return `background:${color.bg};${border}`;
}
