// Shared "person detail" modal — a read-only, consolidated view of everyone
// associated with a trip: team members (sponsor planners) and companions
// (personal planners). The Team and Companions tabs each build a normalized
// `person` descriptor and hand it to openPersonDetail(); the section rendering
// is pure and shared here, so both planner types stay in lockstep and there is a
// single place to evolve the layout.
//
// Normalized `person` shape:
//   { name, subtitle, badges: [{ text, tone }],
//     phone, notes,
//     legs:      [{ from, to, date, mode, dir, status }],
//     stays:     [{ name, checkIn, checkOut }],
//     tickets:   [{ name, status, relation }],
//     itinerary: [{ title, date, time, location }],
//     budget:    { mode: 'categories'|'simple'|'skipped'|'none', ... } }

import { escapeHtml as esc } from './utils.js';
import { showModal, hideModal } from './modal.js';
import { travelIcon, travelStatusBadge } from './plannerTravel.js';
import { ticketStatusBadge } from './plannerTickets.js';
import { formatAmount } from './plannerFields.js';

const MODAL_ID = 'personDetailModal';

const BADGE_TONES = {
  muted: 'bg-gray-100 text-gray-400',
  amber: 'bg-amber-50 text-amber-600',
  blue: 'bg-blue-50 text-blue-700',
};

const muted = (text) => `<p class="pl-hint italic">${esc(text)}</p>`;

function fmtShort(dateStr) {
  const d = String(dateStr || '').slice(0, 10);
  if (!d) return '';
  const parsed = new Date(d + 'T12:00:00');
  return Number.isNaN(parsed.getTime())
    ? ''
    : parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Section shell — an uppercase label (themed gold/mono in the planner) + body.
function section(label, bodyHtml) {
  return `<div class="space-y-1.5">
    <p class="text-[0.65rem] font-semibold uppercase tracking-widest pl-ink-1">${esc(label)}</p>
    <div class="space-y-1">${bodyHtml}</div>
  </div>`;
}

function badgeHtml({ text, tone }) {
  return `<span class="text-[0.6rem] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${
    BADGE_TONES[tone] || BADGE_TONES.muted
  }">${esc(text)}</span>`;
}

function travelRowHtml(l) {
  const route = [l.from, l.to].filter(Boolean).join(' → ') || 'No route';
  const date = fmtShort(l.date);
  const icon = travelIcon(l.mode, l.dir === 'return');
  return `<div class="flex items-center gap-2 pl-hint">
    <i class="${icon} pl-ink-2 w-4 text-center flex-shrink-0"></i>
    <span>${esc(route)}</span>
    ${date ? `<span class="pl-ink-2">${date}</span>` : ''}
    ${travelStatusBadge(l.status)}
  </div>`;
}

function stayRowHtml(s) {
  const dates = [s.checkIn, s.checkOut].filter(Boolean).map(fmtShort).filter(Boolean).join(' – ');
  return `<div class="flex items-center gap-2 pl-hint">
    <i class="fas fa-bed pl-ink-2 w-4 text-center flex-shrink-0"></i>
    <span>${esc(s.name || 'Accommodation')}</span>
    ${dates ? `<span class="pl-ink-2">${dates}</span>` : ''}
  </div>`;
}

function ticketRowHtml(t) {
  return `<div class="flex items-center gap-2 pl-hint">
    ${ticketStatusBadge(t.status || 'planned')}
    <span>${esc(t.name || 'Unnamed ticket')}</span>
    ${t.relation ? `<span class="pl-ink-2">(${esc(t.relation)})</span>` : ''}
  </div>`;
}

function itineraryRowHtml(i) {
  const when = [fmtShort(i.date), i.time].filter(Boolean).join(' ');
  return `<div class="flex items-center gap-2 pl-hint">
    <i class="fas fa-calendar-check pl-ink-2 w-4 text-center flex-shrink-0"></i>
    <span>${esc(i.title || 'Item')}</span>
    ${when ? `<span class="pl-ink-2">${esc(when)}</span>` : ''}
    ${i.location ? `<span class="pl-ink-2">· ${esc(i.location)}</span>` : ''}
  </div>`;
}

// Category budget grid (sponsor members) — per-item budget vs actual + total.
function categoriesBudgetHtml(b) {
  const fmt = (n) => (n !== 0 ? formatAmount(n) : '—');
  const rows = (b.items || [])
    .map(
      (item) => `
      <span class="pl-ink-2 truncate">${esc(item.label)} <span class="pl-ink-2">(${esc(item.cat)})</span></span>
      <span class="pl-ink-2 tabular-nums text-right">${fmt(item.budget)}</span>
      <span class="tabular-nums text-right ${item.actual > item.budget && item.budget > 0 ? 'pl-req' : 'pl-ink-1'}">${fmt(item.actual)}</span>`,
    )
    .join('');
  const total =
    (b.items || []).length > 1
      ? `<div class="col-span-3 h-px pl-surface-2 my-0.5"></div>
         <span class="pl-ink-1 font-medium">Total</span>
         <span class="pl-ink-2 font-medium tabular-nums text-right">${fmt(b.totalB)}</span>
         <span class="pl-ink-1 font-medium tabular-nums text-right">${fmt(b.totalA)}</span>`
      : '';
  const summary =
    b.totalB !== 0
      ? `<div class="flex items-center justify-between mt-2 pt-1.5 pl-divide font-medium ${
          b.totalA > b.totalB ? 'pl-req' : 'text-emerald-600'
        }">
        <span>${b.totalA > b.totalB ? 'Over budget' : 'Remaining'}</span>
        <span class="tabular-nums">${esc(b.currency || '')} ${fmt(Math.abs(b.totalB - b.totalA))}</span>
      </div>`
      : '';
  return `<div class="grid grid-cols-[1fr_auto_auto] gap-x-4 gap-y-1 text-xs">
    <span class="text-[0.6rem] font-semibold uppercase tracking-widest pl-ink-2 pb-0.5">Item</span>
    <span class="text-[0.6rem] font-semibold uppercase tracking-widest pl-ink-2 text-right pb-0.5">Budget</span>
    <span class="text-[0.6rem] font-semibold uppercase tracking-widest pl-ink-2 text-right pb-0.5">Actual</span>
    ${rows}${total}
  </div>${summary}`;
}

// Simple budget (companions) — a free-text budget/actual pair + remaining/over.
function simpleBudgetHtml(b) {
  const cur = b.currency || '';
  if (!b.budget && !b.actual) return '';
  const row = (label, val) =>
    `<div class="flex justify-between text-xs"><span class="pl-ink-2">${label}</span><span class="pl-ink-1 tabular-nums">${
      val ? `${esc(String(val))} ${esc(cur)}` : '—'
    }</span></div>`;
  const nb = parseFloat(b.budget);
  const na = parseFloat(b.actual);
  let diffRow = '';
  if (!Number.isNaN(nb) && !Number.isNaN(na)) {
    const diff = nb - na;
    const over = diff < 0;
    diffRow = `<div class="flex justify-between text-xs font-medium mt-1 pt-1 pl-divide ${
      over ? 'pl-req' : 'text-emerald-600'
    }"><span>${over ? 'Over budget' : 'Remaining'}</span><span class="tabular-nums">${esc(cur)} ${Math.abs(
      diff,
    )}</span></div>`;
  }
  return `${row('Budget', b.budget)}${row('Actual', b.actual)}${diffRow}`;
}

function budgetSectionBody(b) {
  if (!b || b.mode === 'none') return '';
  if (b.mode === 'skipped') return muted('Finance tracking is disabled for this person.');
  if (b.mode === 'categories') return categoriesBudgetHtml(b);
  if (b.mode === 'simple') return simpleBudgetHtml(b);
  return '';
}

// Pure: the modal body for a normalized person. Empty sections are omitted; a
// person with nothing recorded yet gets a single friendly placeholder.
export function personDetailBodyHtml(person) {
  const parts = [];
  if (person.phone)
    parts.push(section('Phone', `<p class="text-sm pl-ink-1">${esc(person.phone)}</p>`));
  if (person.notes)
    parts.push(
      section('Notes', `<p class="text-sm pl-ink-1 whitespace-pre-line">${esc(person.notes)}</p>`),
    );
  if (person.legs?.length) parts.push(section('Travel', person.legs.map(travelRowHtml).join('')));
  if (person.stays?.length)
    parts.push(section('Accommodation', person.stays.map(stayRowHtml).join('')));
  if (person.tickets?.length)
    parts.push(section('Tickets', person.tickets.map(ticketRowHtml).join('')));
  const budgetBody = budgetSectionBody(person.budget);
  if (budgetBody) parts.push(section('Budget', budgetBody));
  if (person.itinerary?.length)
    parts.push(section('Itinerary', person.itinerary.map(itineraryRowHtml).join('')));

  if (!parts.length) return muted('No trip details recorded yet.');
  return parts.join('');
}

export function openPersonDetail(person) {
  const nameEl = document.getElementById('personDetailName');
  if (nameEl) nameEl.textContent = person.name || 'Unnamed';
  const badgesEl = document.getElementById('personDetailBadges');
  if (badgesEl) badgesEl.innerHTML = (person.badges || []).map(badgeHtml).join('');
  const subEl = document.getElementById('personDetailSubtitle');
  if (subEl) {
    subEl.textContent = person.subtitle || '';
    subEl.classList.toggle('hidden', !person.subtitle);
  }
  const bodyEl = document.getElementById('personDetailBody');
  if (bodyEl) bodyEl.innerHTML = personDetailBodyHtml(person);
  showModal(MODAL_ID);
}

export function wirePersonDetailModal() {
  const modal = document.getElementById(MODAL_ID);
  if (!modal) return;
  const close = () => hideModal(MODAL_ID);
  document.getElementById('personDetailClose')?.addEventListener('click', close);
  document.getElementById('personDetailClose2')?.addEventListener('click', close);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) close();
  });
}
