// Personal tab + budget-breakdown renders — the personal trip timeline,
// accommodation/notes lists, and the per-event budget breakdown tables (personal
// + sponsor) that other tabs re-render after edits. Extracted from planner.js:
// planner-internal collaborators are injected via initPersonal(); shared
// field/travel/org render helpers are imported directly.

import { escapeHtml as esc } from './utils.js';
import { formatTextBlock } from './markdown.js';
import { formatAmount, plannerDisplayCurrency } from './plannerFields.js';
import {
  buildConvFn,
  fetchRates,
  hasRate,
  ensureRatesForDates,
  clampRateDate,
} from './currency.js';
import {
  TIMELINE_COLORS,
  sortLegs,
  TRAVEL_MODES,
  accomCellBg,
  travelStatusBadge,
} from './plannerTravel.js';
import { personalLegRowHtml } from './plannerOrg.js';

// Timeline day marks. The grid used a coloured Font Awesome glyph per travel
// mode; the icon font is gone, and a three-letter mono code says which mode it
// was without one. The full mode name rides along as the title.
const MODE_MARKS = {
  flight: 'FLT',
  train: 'TRN',
  bus: 'BUS',
  ferry: 'FRY',
  car: 'CAR',
  taxi: 'TXI',
  rideshare: 'RDE',
  other: 'TRV',
};
const modeMark = (mode) => MODE_MARKS[mode] || MODE_MARKS.other;
const modeLabel = (mode) => (TRAVEL_MODES[mode] || TRAVEL_MODES.other).label.replace(/^\S+\s*/, '');
import { renderTrackedSessions } from './plannerTrackedSessions.js';
import {
  conferenceSpanDaysMulti,
  conferenceNamesMulti,
  conferenceLegendChip,
  personTicketDays,
  CONFERENCE_ROW_ACCENT,
  TICKET_ROW_ACCENT,
} from './plannerConferenceBand.js';

// ── Injected planner collaborators ────────────────────────────────────────────
let state;
let getMeLabel;
let getTimezone;
let localDateStr;
let renderListPanel;
let buildEventBudgetData;
let buildPersonalBudgetData;
let renderBudgetItems;
let renderPersonalCompanionsSection;
let renderPersonalConflicts;
let syncEventTitleField;
let renderItineraryWeather;

export function initPersonal(deps) {
  ({
    state,
    getMeLabel,
    getTimezone,
    localDateStr,
    renderListPanel,
    buildEventBudgetData,
    buildPersonalBudgetData,
    renderBudgetItems,
    renderPersonalCompanionsSection,
    renderPersonalConflicts,
    syncEventTitleField,
    renderItineraryWeather,
  } = deps);
}

export function renderPersonalItinerary() {
  renderPersonalTimeline();
}

export function renderPersonalTimeline() {
  const container = document.getElementById('personalTimeline');
  if (!container) return;
  const personal = state.planner.personal;
  if (!personal) return;

  // The vertical day agenda that used to sit under this Gantt is gone — it was
  // the Itinerary tab's content rendered a second time. dayAgendaHtml() is
  // still the Itinerary tab's own renderer; it is simply not called from here.

  const outLegs = personal.outboundLegs || [];
  const retLegs = personal.returnLegs || [];
  const localLegs = personal.showLocalTravel ? personal.localLegs || [] : [];
  const accoms = personal.accommodations || [];
  const items = personal.itinerary || [];

  // Derive date range from inputs, falling back to leg/accom/event/item dates
  const si = document.getElementById('personalTimelineStart');
  const ei = document.getElementById('personalTimelineEnd');
  let startStr = si?.value || '';
  let endStr = ei?.value || '';

  if (!startStr || !endStr) {
    const all = [
      ...outLegs.map((l) => l.date),
      ...retLegs.map((l) => l.date),
      ...localLegs.map((l) => l.date),
      ...accoms.flatMap((a) => {
        // Resolve the same __me__ stay dates the shading uses, so the range spans
        // the whole stay (incl. the checkout day) even when dates live only in the
        // assignment rather than the top-level fields.
        const meStay = (a.assignments || []).find((s) => s.memberId === '__me__');
        const ci = meStay?.checkIn || a.checkIn;
        const co = meStay?.checkOut || a.checkOut;
        if (a.type === 'waypoints') {
          const legDates = (a.stops || []).map((cl) => cl.date).filter(Boolean);
          return legDates.length ? legDates : [ci, co];
        }
        return [ci, co];
      }),
      ...state.allSessions.map((s) => s.startTime.slice(0, 10)),
      ...items.map((i) => i.date),
      // Every associated conference's own span, so each indicator has columns to sit in.
      ...(state.planner?.isConference !== false ? conferenceSpanDaysMulti(state.events) : []),
      // Ticket days, so a ticketed day (incl. outside the conference) has a column.
      ...(personal.tickets || []).flatMap((t) => (Array.isArray(t.days) ? t.days : [])),
    ]
      .filter(Boolean)
      .sort();
    if (!all.length) {
      container.innerHTML =
        '<p class="pl-hint py-2">Add travel legs or accommodation dates to see the timeline.</p>';
      return;
    }
    const first = new Date(all[0] + 'T00:00:00');
    first.setDate(first.getDate() - 1);
    const last = new Date(all[all.length - 1] + 'T00:00:00');
    last.setDate(last.getDate() + 1);
    if (!startStr) {
      startStr = localDateStr(first);
      if (si && !si.value) si.value = startStr;
    }
    if (!endStr) {
      endStr = localDateStr(last);
      if (ei && !ei.value) ei.value = endStr;
    }
  }

  const days = [];
  const cur = new Date(startStr + 'T00:00:00');
  const end = new Date(endStr + 'T00:00:00');
  if (cur > end || (end - cur) / 86400000 > 90) {
    container.innerHTML = '<p class="pl-hint py-2">Date range is invalid or exceeds 90 days.</p>';
    return;
  }
  while (cur <= end) {
    days.push(localDateStr(cur));
    cur.setDate(cur.getDate() + 1);
  }

  // Append any itinerary item dates that fall outside the range
  const daySet = new Set(days);
  const extraDays = [...new Set(items.map((i) => i.date).filter(Boolean))]
    .filter((d) => !daySet.has(d))
    .sort();
  const allDays = [...days, ...extraDays];

  const eventDaySet = new Set(
    state.allSessions.map((s) =>
      new Date(s.startTime).toLocaleDateString('en-CA', { timeZone: getTimezone() }),
    ),
  );
  // Every associated conference's date span (a trip can span several co-located
  // events) — highlights those days and drives the amber indicator band below.
  const isConf = state.planner?.isConference !== false;
  const confSpan = isConf ? conferenceSpanDaysMulti(state.events) : [];
  confSpan.forEach((d) => eventDaySet.add(d));
  const confChip = conferenceLegendChip(confSpan, conferenceNamesMulti(state.events));
  // The global conference indicator lives in the header (an amber underline under
  // the conference dates); per-person ticket accents ride each row.
  // Per-person ticket days drive each row's accent: amber on conference days, slate
  // on ticketed days outside the conference. The trip owner falls back to the full
  // span when they hold no ticket, so the indicator is present before tickets exist.
  const confSpanSet = new Set(confSpan);
  const ticketList = personal.tickets || [];
  const hasTicket = (pid) => ticketList.some((t) => t && t.assignedTo === pid);
  const bandFor = (personId, isPrimary = false) => {
    if (hasTicket(personId)) return personTicketDays(personId, ticketList, confSpan);
    return new Set(isPrimary ? confSpan : []);
  };
  // Accent style for a person's row on a given day (or '').
  const rowAccent = (band, day) =>
    band.has(day) ? (confSpanSet.has(day) ? CONFERENCE_ROW_ACCENT : TICKET_ROW_ACCENT) : '';
  const bandMe = bandFor('__me__', true);
  const todayStr = localDateStr(new Date());

  // Day → legs arrays sorted chronologically by departure time
  const outDayLegs = {};
  const retDayLegs = {};
  const localDayLegs = {};
  outLegs
    .filter((l) => l.date)
    .forEach((l) => {
      (outDayLegs[l.date] ??= []).push({ mode: l.mode || 'other', time: l.departTime || '' });
    });
  retLegs
    .filter((l) => l.date)
    .forEach((l) => {
      (retDayLegs[l.date] ??= []).push({ mode: l.mode || 'other', time: l.departTime || '' });
    });
  localLegs
    .filter((l) => l.date)
    .forEach((l) => {
      (localDayLegs[l.date] ??= []).push({ mode: l.mode || 'other', time: l.departTime || '' });
    });
  const byTime = (a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'); // undated legs last, matching the itinerary
  Object.values(outDayLegs).forEach((legs) => legs.sort(byTime));
  Object.values(retDayLegs).forEach((legs) => legs.sort(byTime));
  Object.values(localDayLegs).forEach((legs) => legs.sort(byTime));

  // Per-accommodation day maps for "Me" row: use __me__ stay records, fall back to top-level dates for old data
  // For waypoints: fall back further to first/last leg date when embarkation/disembarkation not set
  const accomPrimary = {}; // day → { acc, color }
  const accomCheckout = {}; // day → { acc, color }
  const waypointsByAccom = {}; // accId → Set<date> — used for port icons in all rows
  accoms.forEach((acc, i) => {
    const color = TIMELINE_COLORS[i % TIMELINE_COLORS.length];
    const meStay = (acc.assignments || []).find((s) => s.memberId === '__me__');
    let checkIn = meStay ? meStay.checkIn || acc.checkIn : acc.checkIn;
    let checkOut = meStay ? meStay.checkOut || acc.checkOut : acc.checkOut;
    if (acc.type === 'waypoints') {
      const legDates = (acc.stops || [])
        .map((cl) => cl.date)
        .filter(Boolean)
        .sort();
      if (!checkIn && legDates.length) checkIn = legDates[0];
      if (!checkOut && legDates.length) checkOut = legDates[legDates.length - 1];
      waypointsByAccom[acc.id] = new Set(legDates);
    }
    if (!checkIn || !checkOut) return;
    accomCheckout[checkOut] = { acc, color };
    const d = new Date(checkIn + 'T00:00:00');
    const e = new Date(checkOut + 'T00:00:00');
    e.setDate(e.getDate() - 1);
    while (d <= e) {
      accomPrimary[localDateStr(d)] = { acc, color };
      d.setDate(d.getDate() + 1);
    }
  });

  function accomForDay(day) {
    const primary = accomPrimary[day];
    const checkout = accomCheckout[day];
    if (primary && checkout && primary.acc.id !== checkout.acc.id) {
      return {
        acc: primary.acc,
        color: primary.color,
        splitAcc: checkout.acc,
        splitColor: checkout.color,
        kind: 'split',
      };
    }
    if (primary) return { acc: primary.acc, color: primary.color, kind: 'stay' };
    if (checkout) return { acc: checkout.acc, color: checkout.color, kind: 'checkout' };
    return null;
  }

  // Itinerary items by date
  const byDate = {};
  items.forEach((item) => {
    (byDate[item.date] ??= []).push(item);
  });

  const headerCells = allDays
    .map((day) => {
      const isToday = day === todayStr;
      const isEvent = eventDaySet.has(day);
      const cls = isToday ? 'tl-head-today' : isEvent ? 'tl-head-event' : 'tl-head-normal';
      // Subtle amber underline marks the conference span right in the header.
      const confHead = confSpanSet.has(day) ? 'border-bottom:2px solid #f59e0b;' : '';
      const label = new Date(day + 'T00:00:00').toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
      });
      return `<th style="min-width:80px;${confHead}" class="${cls} text-center text-[0.65rem] px-1 py-2 whitespace-nowrap pl-divide-l">${label}${isToday ? '<br>' : ''}<span class="itin-wx-col" data-wx-day="${day}"></span></th>`;
    })
    .join('');

  // Row 1: travel + accommodation
  const travelCells = allDays
    .map((day) => {
      const match = accomForDay(day);
      const outLegs = outDayLegs[day] || [];
      const retLegs = retDayLegs[day] || [];
      const localTrips = localDayLegs[day] || [];
      const isToday = day === todayStr;
      const isEvent = eventDaySet.has(day);
      const cellCls = match ? '' : isToday ? 'tl-cell-today' : isEvent ? 'tl-cell-event' : '';
      // Per-person accent along the top of this (flights + accommodation) row.
      const bgStyle = accomCellBg(match || {}) + rowAccent(bandMe, day);
      let content = '';
      if (outLegs.length || retLegs.length) {
        const hasBoth = outLegs.length && retLegs.length;
        const tip = hasBoth ? 'Outbound + return' : outLegs.length ? 'Outbound' : 'Return';
        const icons = [
          ...outLegs.map(
            (l) =>
              `<span class="pl-daymark" title="${esc(modeLabel(l.mode))}">${esc(modeMark(l.mode))}</span>`,
          ),
          ...retLegs.map(
            (l) =>
              `<span class="pl-daymark" title="${esc(modeLabel(l.mode))}">${esc(modeMark(l.mode))}</span>`,
          ),
        ].join('');
        content = `<span class="inline-flex flex-wrap justify-center gap-1" title="${tip}">${icons}</span>`;
      }
      if (localTrips.length) {
        const licons = localTrips
          .map(
            (l) =>
              `<span class="pl-daymark" title="${esc(modeLabel(l.mode))}">${esc(modeMark(l.mode))}</span>`,
          )
          .join('');
        content += `<span class="inline-flex flex-wrap justify-center gap-1" title="Getting around">${licons}</span>`;
      }
      if (match?.acc.type === 'waypoints' && waypointsByAccom[match.acc.id]?.has(day)) {
        const portLegs = (match.acc.stops || []).filter((cl) => cl.date === day);
        const tip = portLegs.map((cl) => cl.location || 'Port').join(', ');
        content += `<span class="pl-daymark" title="${esc(tip)}">PORT</span>`;
      }
      return `<td style="${bgStyle}" class="${cellCls} text-center px-1 py-1.5 pl-divide-l">${content}</td>`;
    })
    .join('');

  // Row 2: itinerary items
  const itinCells = allDays
    .map((day) => {
      const dayItems = (byDate[day] || []).sort((a, b) =>
        (a.time || '').localeCompare(b.time || ''),
      );
      const isToday = day === todayStr;
      const isEvent = eventDaySet.has(day);
      const cellCls = isToday ? 'tl-cell-today' : isEvent ? 'tl-cell-event' : '';
      // Read-only pills — itinerary is managed in the day agenda / Itinerary tab.
      const pills = dayItems
        .map(
          (item) =>
            `<span class="tl-pill${item.done ? ' is-done' : ''}" title="${esc(item.title)}">${esc(item.title.slice(0, 15))}${item.title.length > 15 ? '…' : ''}</span>`,
        )
        .join('');
      return `<td class="${cellCls} px-1 py-1 pl-divide-l align-top" style="min-width:80px">${pills}</td>`;
    })
    .join('');

  const accomChips = accoms
    .map((acc, i) => {
      const c = TIMELINE_COLORS[i % TIMELINE_COLORS.length];
      return `<span class="pl-legend"><span class="pl-legend__swatch" style="background:${c.bg}" aria-hidden="true"></span>${esc(acc.name || (acc.type === 'waypoints' ? 'Waypoint' : 'Accommodation'))}</span>`;
    })
    .join('');
  const legendChips = confChip + accomChips;
  const legend = legendChips ? `<div class="pl-legend-row">${legendChips}</div>` : '';

  const meContactId = state.planner.personal?.meContactId || null;
  const companions = (state.planner.personal?.tripAssignments || []).filter(
    (a) => a.memberId !== meContactId,
  );
  const contacts = state.global?.personalContacts || [];

  if (companions.length === 0) {
    container.innerHTML = `<div class="tl-scroll overflow-x-auto pl-bordered"><table class="min-w-full text-sm" style="border-collapse:collapse"><thead class="pl-surface-2"><tr>${headerCells}</tr></thead><tbody><tr class="pl-divide">${travelCells}</tr><tr class="pl-divide">${itinCells}</tr></tbody></table></div>${legend}`;
  } else {
    const nameHeaderCell = `<th class="text-left text-xs font-semibold pl-ink-2 pr-3 py-2 whitespace-nowrap pl-divide-r pl-surface-2" style="min-width:90px">Person</th>`;
    const meLabel = `<td class="text-xs font-medium pl-ink-1 pr-3 py-2 whitespace-nowrap pl-divide-r" style="min-width:90px">${esc(getMeLabel())}</td>`;

    const companionRows = companions
      .map((assignment) => {
        const contact = contacts.find((c) => c.id === assignment.memberId);
        if (!contact) return '';
        const bandC = bandFor(assignment.memberId);
        const compAccomPrimary = {};
        const compAccomCheckout = {};
        accoms.forEach((acc, i) => {
          const stay = (acc.assignments || []).find((s) => s.memberId === assignment.memberId);
          if (!stay) return;
          let checkIn = stay.checkIn || acc.checkIn;
          let checkOut = stay.checkOut || acc.checkOut;
          if (acc.type === 'waypoints') {
            const legDates = (acc.stops || [])
              .map((cl) => cl.date)
              .filter(Boolean)
              .sort();
            if (!checkIn && legDates.length) checkIn = legDates[0];
            if (!checkOut && legDates.length) checkOut = legDates[legDates.length - 1];
          }
          const color = TIMELINE_COLORS[i % TIMELINE_COLORS.length];
          if (checkOut) compAccomCheckout[checkOut] = { acc, color };
          if (checkIn && checkOut) {
            const d = new Date(checkIn + 'T00:00:00');
            const e2 = new Date(checkOut + 'T00:00:00');
            e2.setDate(e2.getDate() - 1);
            while (d <= e2) {
              compAccomPrimary[localDateStr(d)] = { acc, color };
              d.setDate(d.getDate() + 1);
            }
          }
        });

        const cOutDayLegs = {};
        const cRetDayLegs = {};
        (assignment.outboundLegs || [])
          .filter((l) => l.date)
          .forEach((l) => {
            (cOutDayLegs[l.date] ??= []).push({
              mode: l.mode || 'other',
              time: l.departTime || '',
            });
          });
        (assignment.returnLegs || [])
          .filter((l) => l.date)
          .forEach((l) => {
            (cRetDayLegs[l.date] ??= []).push({
              mode: l.mode || 'other',
              time: l.departTime || '',
            });
          });
        Object.values(cOutDayLegs).forEach((legs) =>
          legs.sort((a, b) => a.time.localeCompare(b.time)),
        );
        Object.values(cRetDayLegs).forEach((legs) =>
          legs.sort((a, b) => a.time.localeCompare(b.time)),
        );

        const cells = allDays
          .map((day) => {
            const primary = compAccomPrimary[day];
            const checkout = compAccomCheckout[day];
            const match =
              primary && checkout && primary.acc.id !== checkout.acc.id
                ? {
                    acc: primary.acc,
                    color: primary.color,
                    splitAcc: checkout.acc,
                    splitColor: checkout.color,
                    kind: 'split',
                  }
                : primary
                  ? { acc: primary.acc, color: primary.color, kind: 'stay' }
                  : checkout
                    ? { acc: checkout.acc, color: checkout.color, kind: 'checkout' }
                    : null;
            const outLegs = cOutDayLegs[day] || [];
            const retLegs = cRetDayLegs[day] || [];
            const isToday = day === todayStr;
            const isEvent = eventDaySet.has(day);
            const cellCls = match ? '' : isToday ? 'tl-cell-today' : isEvent ? 'tl-cell-event' : '';
            const bgStyle = accomCellBg(match || {}) + rowAccent(bandC, day);
            let content = '';
            if (outLegs.length || retLegs.length) {
              const hasBoth = outLegs.length && retLegs.length;
              const tip = hasBoth
                ? `${esc(contact.name)} outbound + return`
                : outLegs.length
                  ? `${esc(contact.name)} outbound`
                  : `${esc(contact.name)} return`;
              const icons = [
                ...outLegs.map(
                  (l) =>
                    `<span class="pl-daymark" title="${esc(modeLabel(l.mode))}">${esc(modeMark(l.mode))}</span>`,
                ),
                ...retLegs.map(
                  (l) =>
                    `<span class="pl-daymark" title="${esc(modeLabel(l.mode))}">${esc(modeMark(l.mode))}</span>`,
                ),
              ].join('');
              content = `<span class="inline-flex flex-wrap justify-center gap-1" title="${tip}">${icons}</span>`;
            }
            if (match?.acc.type === 'waypoints' && waypointsByAccom[match.acc.id]?.has(day)) {
              const portLegs = (match.acc.stops || []).filter((cl) => cl.date === day);
              const portTip = portLegs.map((cl) => cl.location || 'Port').join(', ');
              content += `<span class="pl-daymark" title="${esc(portTip)}">PORT</span>`;
            }
            return `<td style="${bgStyle}" class="${cellCls} text-center px-1 py-1.5 pl-divide-l">${content}</td>`;
          })
          .join('');
        return `<tr class="pl-divide"><td class="text-xs font-medium pl-ink-1 pr-3 py-2 whitespace-nowrap pl-divide-r" style="min-width:90px">${esc(contact.name || 'Unnamed')}</td>${cells}</tr>`;
      })
      .filter(Boolean)
      .join('');

    // Local companion rows (trip-specific, only shown if they have flights or accommodation)
    const localCompanions = (state.planner.personal?.localCompanions || []).filter(
      (lc) => lc.id !== meContactId,
    );
    const localRows = localCompanions
      .map((lc) => {
        const bandL = bandFor(lc.id);
        const lcOutDayLegs = {};
        const lcRetDayLegs = {};
        (lc.outboundLegs || [])
          .filter((l) => l.date)
          .forEach((l) => {
            (lcOutDayLegs[l.date] ??= []).push({
              mode: l.mode || 'other',
              time: l.departTime || '',
            });
          });
        (lc.returnLegs || [])
          .filter((l) => l.date)
          .forEach((l) => {
            (lcRetDayLegs[l.date] ??= []).push({
              mode: l.mode || 'other',
              time: l.departTime || '',
            });
          });
        if (!Object.keys(lcOutDayLegs).length && !Object.keys(lcRetDayLegs).length) return '';
        const cells = allDays
          .map((day) => {
            const outL = lcOutDayLegs[day] || [];
            const retL = lcRetDayLegs[day] || [];
            const confTop = rowAccent(bandL, day);
            if (!outL.length && !retL.length)
              return `<td class="px-1 py-1.5 pl-divide-l" style="${confTop}"></td>`;
            const icons = [
              ...outL.map(
                (l) =>
                  `<span class="pl-daymark" title="${esc(modeLabel(l.mode))}">${esc(modeMark(l.mode))}</span>`,
              ),
              ...retL.map(
                (l) =>
                  `<span class="pl-daymark" title="${esc(modeLabel(l.mode))}">${esc(modeMark(l.mode))}</span>`,
              ),
            ].join('');
            return `<td class="text-center px-1 py-1.5 pl-divide-l" style="${confTop}"><span class="inline-flex flex-wrap justify-center gap-1">${icons}</span></td>`;
          })
          .join('');
        return `<tr class="pl-divide"><td class="text-xs font-medium pl-ink-1 pr-3 py-2 whitespace-nowrap pl-divide-r" style="min-width:90px">${esc(lc.name || 'Unnamed')}<span class="ml-1 text-[0.55rem] pl-accent">(trip)</span></td>${cells}</tr>`;
      })
      .filter(Boolean)
      .join('');

    const itinLabelCell = `<td class="pl-hint pr-3 py-1 whitespace-nowrap pl-divide-r italic" style="min-width:90px">Itinerary</td>`;

    container.innerHTML = `<div class="tl-scroll overflow-x-auto pl-bordered"><table class="min-w-full text-sm" style="border-collapse:collapse"><thead class="pl-surface-2"><tr>${nameHeaderCell}${headerCells}</tr></thead><tbody><tr class="pl-divide">${meLabel}${travelCells}</tr>${companionRows}${localRows}<tr class="pl-divide">${itinLabelCell}${itinCells}</tr></tbody></table></div>${legend}`;
  }
  renderItineraryWeather(); // fill the per-day weather chips on the Gantt + mobile agenda
}

function personalAccomCardHtml(accom) {
  const checkIn = accom.checkIn
    ? new Date(accom.checkIn + 'T12:00:00').toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : '';
  const checkOut = accom.checkOut
    ? new Date(accom.checkOut + 'T12:00:00').toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : '';
  const dates = checkIn && checkOut ? `${checkIn} → ${checkOut}` : checkIn || checkOut || '';
  const stays = accom.assignments || [];
  const meStaying = stays.some((s) => s.memberId === '__me__');
  const meContactId = state.planner.personal?.meContactId || null;
  const localCompanions = state.planner.personal?.localCompanions || [];
  const companionNames = [
    ...(meStaying ? [getMeLabel()] : []),
    ...(state.planner.personal?.tripAssignments || [])
      .filter(
        (a) =>
          a.memberId !== meContactId &&
          stays.some((s) => s.memberId === a.memberId && s.memberId !== '__me__'),
      )
      .map((a) => (state.global?.personalContacts || []).find((c) => c.id === a.memberId)?.name)
      .filter(Boolean),
    ...localCompanions
      .filter((lc) => lc.id !== meContactId && stays.some((s) => s.memberId === lc.id))
      .map((lc) => lc.name || 'Unnamed'),
  ];
  const meta = [
    dates,
    accom.confirmation ? `#${accom.confirmation}` : '',
    companionNames.length ? companionNames.join(', ') : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const ai = esc(accom.id);
  // Whole card opens the read-only detail modal; Edit / Remove / Calendar live
  // inside it. `data-view-*` is read by the shared handler in plannerItinerary.
  return `<button type="button" class="pl-stay pl-open" data-view-type="accom" data-view-accom-id="${ai}" aria-label="View ${esc(accom.name || 'accommodation')}">
    <div class="flex-1 min-w-0">
      <div class="flex items-center gap-1.5 min-w-0">
        <p class="pl-stay-name truncate">${esc(accom.name || 'Unnamed accommodation')}</p>
        ${travelStatusBadge(accom.status)}
      </div>
      ${meta ? `<p class="pl-stay-meta truncate">${esc(meta)}</p>` : ''}
    </div>
  </button>`;
}

export function renderPersonalAccomList() {
  renderListPanel(
    'personalAccomList',
    'personalAccomEmpty',
    state.planner?.personal?.accommodations || [],
    personalAccomCardHtml,
  );
}

function personalNoteCardHtml(note) {
  const ni = esc(note.id);
  const title = (note.title || '').trim() || 'Untitled note';
  const label = esc(note.title || 'note');
  // Notes support Markdown (+ emoji). Render the body through the shared markdown
  // helper — the same one the schedule/editor use — clamped to a short preview.
  const bodyHtml = formatTextBlock(note.body || '');
  // A note can carry its own emoji, which replaces the default sticky-note icon.
  const icon = note.emoji
    ? `<span class="pl-stay-emoji" aria-hidden="true">${esc(note.emoji)}</span>`
    : '';
  return `<div class="nts-note">
    <span class="nts-note-ic">${icon}</span>
    <div class="nts-note-main">
      <p class="nts-note-title">${esc(title)}</p>
      ${bodyHtml ? `<div class="nts-note-body">${bodyHtml}</div>` : ''}
    </div>
    <div class="nts-note-acts">
      <button type="button" class="nts-act personal-note-edit-btn" data-note-id="${ni}" aria-label="Edit ${label}" title="Edit">
      </button>
      <button type="button" class="nts-act nts-act--del personal-note-remove-btn" data-note-id="${ni}" aria-label="Remove ${label}" title="Remove">
      </button>
    </div>
  </div>`;
}

export function renderPersonalNotes() {
  renderListPanel(
    'personalNotesList',
    'personalNotesEmpty',
    state.planner?.personal?.noteList || [],
    personalNoteCardHtml,
  );
}

// Category-grouped budget breakdown. `cats` is already rolled up into `currency`
// (built with a conv fn upstream), so each category's `budget`/`actual` are read
// directly — no per-item conversion here. Categories are grouped and sorted
// worst-first, each showing planned-vs-actual, a progress bar, and an explicit
// "over / left / no budget set" status, so *why* a category is over is obvious.
export function renderBudgetBreakdownInto(containerId, cats, currency) {
  const container = document.getElementById(containerId);
  if (!container) return;
  // Keep a category if it has any line items or receipts — not just a non-zero
  // total. Otherwise a category whose items net to zero (e.g. a +1500 cost and a
  // −1500 credit/allowance) would be dropped entirely, hiding both line items.
  const activeCats = Object.entries(cats).filter(
    ([, c]) =>
      (c.items || []).length || (c.receipts || []).length || c.budget !== 0 || c.actual !== 0,
  );
  if (!activeCats.length) {
    container.classList.add('hidden');
    return;
  }

  // A "≈" hint whenever any amount was converted from another currency.
  const mixed = activeCats.some(
    ([, c]) =>
      (c.items || []).some((i) => i.curr && i.curr !== currency) ||
      (c.receipts || []).some((r) => (r.currency || currency) !== currency),
  );
  const approx = mixed ? '≈' : '';
  const money = (n) => (n === 0 ? '—' : `${approx}${formatAmount(n)}`);

  // Worst-first: over-budget categories float to the top. Categories with no budget
  // set sort by spend so the biggest unbudgeted spend is still prominent.
  const usage = ([, c]) =>
    c.budget > 0 ? c.actual / c.budget : c.actual > 0 ? Number.POSITIVE_INFINITY : -1;
  const sorted = activeCats.slice().sort((a, b) => usage(b) - usage(a));

  let grandB = 0;
  let grandA = 0;
  const blocks = sorted
    .map(([, c]) => {
      grandB += c.budget;
      grandA += c.actual;
      const hasBudget = c.budget > 0;
      const over = hasBudget && c.actual > c.budget;
      const remaining = c.budget - c.actual;
      const pct = hasBudget ? Math.min(100, Math.max(0, (c.actual / c.budget) * 100)) : 0;
      const stateCls = over
        ? 'is-over'
        : !hasBudget
          ? 'is-nobudget'
          : pct >= 90
            ? 'is-warn'
            : 'is-ok';
      const status = over
        ? `${money(Math.abs(remaining))} over`
        : !hasBudget
          ? 'no budget set'
          : remaining < 0
            ? `${money(Math.abs(remaining))} credit`
            : `${money(remaining)} left`;
      // Line items first, then unlinked receipts, as detail under the category.
      const rows = [
        ...(c.items || []).map((i) => ({ label: i.label, budget: i.budget, actual: i.actual })),
        ...(c.receipts || []).map((r) => ({
          label: r.label,
          budget: 0,
          actual: r.amount,
          isReceipt: true,
        })),
      ];
      const detail = rows
        .map(
          (r) => `
        <div class="pl-cat-item">
          <span class="pl-cat-item-name">${esc(r.label)}${r.isReceipt ? ' <span class="pl-cat-item-tag">receipt</span>' : ''}</span>
          <span class="pl-cat-item-num">${r.budget ? money(r.budget) : ''}</span>
          <span class="pl-cat-item-num ${r.actual < 0 ? 'is-credit' : r.budget > 0 && r.actual > r.budget ? 'is-over' : ''}">${r.actual ? money(r.actual) : '—'}</span>
        </div>`,
        )
        .join('');
      return `
      <div class="pl-cat ${stateCls}">
        <div class="pl-cat-head">
          <span class="pl-cat-name">${esc(c.label)}</span>
          <span class="pl-cat-figs"><span class="pl-cat-actual">${money(c.actual)}</span><span class="pl-cat-of"> of </span><span class="pl-cat-budget">${hasBudget ? money(c.budget) : '—'}</span></span>
        </div>
        <div class="pl-cat-bar" role="img" aria-label="${esc(c.label)}: ${Math.round(pct)}% of budget used"><div class="pl-cat-bar-fill" style="width:${pct}%"></div></div>
        <div class="pl-cat-status">${status}</div>
        ${detail ? `<div class="pl-cat-items">${detail}</div>` : ''}
      </div>`;
    })
    .join('');

  const grandOver = grandB > 0 && grandA > grandB;
  const grandRemaining = grandB - grandA;
  const grandPct = grandB > 0 ? Math.min(100, Math.max(0, (grandA / grandB) * 100)) : 0;

  container.classList.remove('hidden');
  container.innerHTML = `
    <div class="pl-catbreak">${blocks}</div>
    ${
      grandB !== 0
        ? `
      <div class="pl-ledger-foot ${grandOver ? 'is-over' : ''}">
        <div class="pl-ledger-foot-row">
          <span>${grandOver ? 'Over budget' : grandRemaining < 0 ? 'Net credit' : 'Remaining'}</span>
          <span>${approx}${esc(currency)} ${formatAmount(Math.abs(grandRemaining))}</span>
        </div>
        <div class="pl-ledger-bar" role="img" aria-label="${Math.round(grandPct)}% of total budget used"><div class="pl-ledger-bar-fill" style="width:${grandPct}%"></div></div>
      </div>
    `
        : ''
    }
    ${mixed ? `<p class="pl-catbreak-note">≈ converted to ${esc(currency)}</p>` : ''}
  `;
}

// The event's start date drives which historical exchange rates to use, keeping
// the breakdown's converted total in step with the Summary tab. Future event
// dates (an upcoming trip) fall back to current rates — historical data can't
// exist yet, and requesting it 404s upstream (which would leave totals unconverted).
function eventRateDate() {
  return clampRateDate(state.eventMeta?.startDate?.slice(0, 10) || '');
}

// Distinct purchase/receipt dates carried by a cats map's line items — the extra
// rate days a per-date conversion needs beyond the base event date.
function catsItemDates(cats) {
  const dates = [];
  for (const c of Object.values(cats || {})) {
    (c.items || []).forEach((i) => i.date && dates.push(i.date));
    (c.receipts || []).forEach((r) => r.date && dates.push(r.date));
  }
  return dates;
}

// Fetch exchange rates for the trip currency at the event date AND at each line
// item's purchase date (if a breakdown mixes currencies), then re-render so the
// converted total can refine to per-day rates.
function ensureRatesFor(currency, rateDate, rerender, itemDates = []) {
  if (!currency) return;
  if (!hasRate(currency, rateDate)) {
    fetchRates(currency, rateDate)
      .then(() => rerender())
      .catch(() => {});
  }
  ensureRatesForDates(currency, itemDates, rerender);
}

export function renderPersonalBudgetBreakdown() {
  // Roll every amount up into the planner's preferred display currency first, so the
  // breakdown can read each category's budget/actual directly. buildConvFn returns null
  // until rates cache; ensureRatesFor re-renders once they load (identity meanwhile).
  const currency = plannerDisplayCurrency(state.planner);
  const rateDate = eventRateDate();
  const data = buildPersonalBudgetData(state.planner, buildConvFn(currency, rateDate));
  renderBudgetBreakdownInto('personalBudgetBreakdown', data, currency);
  renderBudgetBreakdownInto('personalBudgetTabBreakdown', data, currency);
  ensureRatesFor(currency, rateDate, renderPersonalBudgetBreakdown, catsItemDates(data));
}

export function renderSponsorBudgetBreakdown() {
  const currency = plannerDisplayCurrency(state.planner);
  const rateDate = eventRateDate();
  const data = buildEventBudgetData(state.planner, null, buildConvFn(currency, rateDate));
  renderBudgetBreakdownInto('sponsorBudgetBreakdown', data, currency);
  ensureRatesFor(currency, rateDate, renderSponsorBudgetBreakdown, catsItemDates(data));
}

export function renderPersonalTab() {
  const personal = state.planner.personal;
  if (!personal) return;

  syncEventTitleField('plannerPersonalTitle', 'plannerPersonalTitleHint');
  renderPersonalConflicts();

  // The "My travel" budget lump was retired (migrated to a "Travel" line item);
  // the personal budget section is now line-items-only.
  renderPersonalNotes();

  // Legs
  const outContainer = document.getElementById('personalOutboundLegs');
  const retContainer = document.getElementById('personalReturnLegs');
  const outEmpty = document.getElementById('personalOutboundEmpty');
  const retEmpty = document.getElementById('personalReturnEmpty');

  const outLegs = sortLegs(personal.outboundLegs || []);
  const retLegs = sortLegs(personal.returnLegs || []);
  const localLegs = sortLegs(personal.localLegs || []);

  if (outContainer)
    outContainer.innerHTML = outLegs.map((l) => personalLegRowHtml(l, 'outbound')).join('');
  if (retContainer)
    retContainer.innerHTML = retLegs.map((l) => personalLegRowHtml(l, 'return')).join('');
  if (outEmpty) outEmpty.classList.toggle('hidden', outLegs.length > 0);
  if (retEmpty) retEmpty.classList.toggle('hidden', retLegs.length > 0);

  // "Getting around" is an opt-in, per-planner setting (off by default).
  const showLocal = !!personal.showLocalTravel;
  document.getElementById('personalLocalTravelSection')?.classList.toggle('hidden', !showLocal);
  const localContainer = document.getElementById('personalLocalLegs');
  const localEmpty = document.getElementById('personalLocalEmpty');
  if (localContainer)
    localContainer.innerHTML = localLegs.map((l) => personalLegRowHtml(l, 'local')).join('');
  if (localEmpty) localEmpty.classList.toggle('hidden', localLegs.length > 0);

  renderPersonalTimeline();
  renderPersonalItinerary();
  renderPersonalCompanionsSection();
  renderTrackedSessions('personal');
  renderPersonalAccomList();
  renderBudgetItems('personal');
  renderPersonalBudgetBreakdown();
}

// Static shell for this tab panel — injected into #plannerPersonalPanel at boot (#7 co-location).
export function personalPanelHtml() {
  return `
          <section class="pl-surface p-4">
            <div data-wx-summary></div>
            <div class="space-y-6">

              <!-- Event / trip name -->
              <div class="space-y-1">
                <label class="editor-form-field">
                  <span class="editor-field-label">Event / trip name</span>
                  <input type="text" id="plannerPersonalTitle" placeholder="e.g. My Prague trip"
                    class="pl-field disabled:pl-ink-2 disabled:cursor-not-allowed">
                </label>
                <p id="plannerPersonalTitleHint" class="hidden pl-hint pl-0.5">Inherited from the associated schedule — disassociate to override</p>
              </div>

              <!-- Conflict banner -->
              <div id="personalConflictBanner" class="hidden rounded-md border pl-rule-bad pl-surface-2 px-3 py-2 space-y-0.5"></div>

              <!-- Outbound + Return side-by-side -->
              <div class="pl-divide pt-2" data-collapse="personal-travel">
                <h3 class="pl-label mb-3">Travel</h3>
                <div data-collapse-body="personal-travel" class="space-y-5">
                <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div class="space-y-3">
                  <div class="flex items-center justify-between flex-wrap gap-3">
                    <h3 class="pl-label">Outbound Travel</h3>
                    <button id="addPersonalOutboundLegBtn" type="button"
                      class="pl-btn">Add leg
                    </button>
                  </div>
                  <div id="personalOutboundLegs" class="space-y-2"></div>
                  <p id="personalOutboundEmpty" class="pl-hint">No outbound legs added.</p>
                </div>

                <div class="space-y-3">
                  <div class="flex items-center justify-between flex-wrap gap-3">
                    <h3 class="pl-label">Return Travel</h3>
                    <button id="addPersonalReturnLegBtn" type="button"
                      class="pl-btn">Add leg
                    </button>
                  </div>
                  <div id="personalReturnLegs" class="space-y-2"></div>
                  <p id="personalReturnEmpty" class="pl-hint">No return legs added.</p>
                </div>
              </div><!-- /outbound + return grid -->

              <div id="personalLocalTravelSection" class="hidden space-y-3">
                <div class="flex items-center justify-between flex-wrap gap-3">
                  <h3 class="pl-label">Getting Around</h3>
                  <button id="addPersonalLocalLegBtn" type="button"
                    class="pl-btn">Add leg
                  </button>
                </div>
                <div id="personalLocalLegs" class="space-y-2"></div>
                <p id="personalLocalEmpty" class="pl-hint">No local trips yet — trains, taxis, cable cars &amp; more while you're there.</p>
              </div>
              </div><!-- /personal-travel collapse body -->
              </div><!-- /personal-travel section -->

              <!-- Accommodation -->
              <div class="space-y-3 pl-divide pt-2" data-collapse="personal-accommodation">
                <div class="flex items-center justify-between">
                  <h3 class="pl-label">Accommodation</h3>
                  <button id="addPersonalAccomBtn" type="button"
                    class="h-7 inline-flex items-center px-2.5 border pl-rule rounded-md pl-hint transition-colors">Add
                  </button>
                </div>
                <div data-collapse-body="personal-accommodation" class="space-y-2">
                  <div id="personalAccomList" class="space-y-2"></div>
                  <p id="personalAccomEmpty" class="pl-hint py-1">No accommodation added yet.</p>
                </div>
              </div>

              <!-- Trip Companions -->
              <div id="personalCompanionsSection" class="hidden space-y-3">
                <div class="flex items-center justify-between">
                  <h3 class="pl-label">Trip Companions</h3>
                </div>
                <p id="personalCompanionsEmpty" class="hidden pl-hint">No companions assigned to this trip. Add them in Settings.</p>
                <div id="personalCompanionsList" class="space-y-2"></div>
              </div>

              <!-- Timeline -->
              <div class="space-y-3 pl-divide pt-2" data-collapse="personal-timeline">
                <div class="flex items-center justify-between flex-wrap gap-3">
                  <h3 class="pl-label">Timeline</h3>
                  <div id="personalTimelineRange" class="flex items-center gap-3 text-xs pl-ink-2 flex-wrap">
                    <label class="flex items-center gap-1.5">
                      From
                      <input type="date" id="personalTimelineStart" class="pl-field">
                    </label>
                    <label class="flex items-center gap-1.5">
                      To
                      <input type="date" id="personalTimelineEnd" class="pl-field">
                    </label>
                  </div>
                </div>
                <div data-collapse-body="personal-timeline">
                  <!-- The Gantt stays: it is this panel's overview and exists
                       nowhere else. The vertical day agenda that used to sit
                       below it (#personalTimelineAgenda) is gone — that WAS a
                       duplicate, rendered from dayAgendaHtml(), the same
                       function that fills the Itinerary tab's
                       #itineraryDayList. Its click handlers are delegated at
                       document level and already served both places, so the
                       Itinerary tab is unaffected. -->
                  <div id="personalTimeline"></div>
                </div>
              </div>

              <!-- Budget moved to the Budget tab, which already carried the
                   whole feature under its own ids (#personalBudgetTabItems,
                   #addPersonalBudgetTabItemBtn, #personalBudgetTabFilter).
                   renderBudgetItems('personal') wrote the same list into both. -->

              <!-- Trip notes moved to the Notes tab (session + trip notes on one page) -->

              <!-- Tracked Sessions (Personal) -->
              <div id="personalTrackedSessionsSection" class="pl-divide pt-2" data-collapse="personal-tracked">
                <div class="flex items-center gap-2 mb-3">
                  <h3 class="pl-label">Tracked Sessions</h3>
                  <span id="personalTrackedCount" class="hidden text-[0.65rem] font-semibold pl-ink-2 pl-surface-2 rounded-full px-1.5 leading-4"></span>
                </div>
                <div data-collapse-body="personal-tracked" class="space-y-3">
                  <div class="relative">
                    <input type="text" id="personalSessionSearchInput" placeholder="Search sessions to track…"
                      class="h-9 w-full rounded-md pl-rule drupal-blue-focus text-sm pl-surface pl-8 pr-3"
                      autocomplete="off">
                  </div>
                  <div id="personalSessionSearchResults" class="hidden rounded-md border pl-rule pl-surface text-sm overflow-hidden max-h-48 overflow-y-auto"></div>
                  <div id="personalTrackedSessionsList" class="space-y-1.5"></div>
                  <p id="personalTrackedSessionsEmpty" class="hidden pl-hint py-2">No sessions tracked yet. Search above to add one.</p>
                </div>
              </div>

            </div>
          </section>
        `;
}
