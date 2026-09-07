// Trip Dashboard render — the home grid of trip cards (across all saved
// planners) with next-trip banner, mini timeline, and per-trip budget dot from
// event dates + travel/accommodation data. Extracted from planner.js:
// planner-internal collaborators are injected via initDashboard(); storage,
// escapeHtml, and the shared home-layout helpers are imported directly.

import { escapeHtml as esc } from './utils.js';
import { plannerHref } from './plannerRoute.js';
import {
  listKeys,
  readJson,
  STORAGE_PREFIX,
  GLOBAL_KEY,
  plannerFilename,
} from './plannerStorage.js';
import { homeRoot, sectionHeader, cardGrid, emptyState } from './homeLayout.js';
import { sortLegs } from './plannerTravel.js';

// Canonical fingerprint of a planner for equality — recursively key-sorted and
// with the save-only `_lastModified` stamp stripped (the disk copy gets a fresh
// one on every write, so it's never part of "did the content change?").
function _canon(v) {
  if (Array.isArray(v)) return v.map(_canon);
  if (v && typeof v === 'object')
    return Object.keys(v)
      .sort()
      .reduce((o, k) => ((o[k] = _canon(v[k])), o), {});
  return v;
}
export function plannerFingerprint(obj) {
  const rest = { ...(obj || {}) };
  delete rest._lastModified;
  return JSON.stringify(_canon(rest));
}

// Which localStorage planners differ from their on-disk copy (missing OR stale).
// Best-effort: any fetch failure (offline / no server) is treated as "unknown"
// so we never show a false badge. Returns a Set of slugs.
async function _unsavedSlugs(rawPlanners) {
  const unsaved = new Set();
  await Promise.all(
    rawPlanners.map(async ({ data, slug }) => {
      try {
        const res = await fetch(`./api/planner/${plannerFilename(slug)}`);
        if (res.status === 404) {
          unsaved.add(slug); // exists locally, never saved to disk
          return;
        }
        if (!res.ok) return; // server error — don't guess
        const disk = await res.json();
        if (plannerFingerprint(disk) !== plannerFingerprint(data)) unsaved.add(slug);
      } catch {
        /* offline — leave unflagged */
      }
    }),
  );
  return unsaved;
}

// ── Injected planner collaborators ────────────────────────────────────────────
let isPlannerEntry;
let _eventDates;
let fetchEventDates;

export function initDashboard(deps) {
  ({ isPlannerEntry, _eventDates, fetchEventDates } = deps);
}

function _tripFmtDate(iso) {
  if (!iso) return '';
  return new Date(iso + 'T12:00:00').toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

function _tripFmtRange(startIso, endIso) {
  if (!startIso) return '';
  const s = new Date(startIso + 'T12:00:00');
  const e = endIso ? new Date(endIso + 'T12:00:00') : null;
  const sYear = s.getFullYear();
  const sMonth = s.toLocaleDateString(undefined, { month: 'short' });
  const sDay = s.getDate();
  if (!e) return `${sMonth} ${sDay}, ${sYear}`;
  const eYear = e.getFullYear();
  const eMonth = e.toLocaleDateString(undefined, { month: 'short' });
  const eDay = e.getDate();
  if (sYear === eYear && sMonth === eMonth) return `${sMonth} ${sDay}–${eDay}, ${sYear}`;
  return sYear === eYear
    ? `${sMonth} ${sDay} – ${eMonth} ${eDay}, ${sYear}`
    : `${sMonth} ${sDay}, ${sYear} – ${eMonth} ${eDay}, ${eYear}`;
}

function _tripCountdown(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T12:00:00');
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const diff = Math.round((d - today) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff > 1) return `in ${diff} days`;
  return '';
}

function _tripCardHtml(trip) {
  const modeLabel = trip.mode === 'sponsor' ? 'Sponsor' : 'Personal';
  const modeCls = trip.mode === 'sponsor' ? 'trip-mode-sponsor' : 'trip-mode-personal';
  const confDates = _tripFmtRange(trip.evStart, trip.evEnd);
  const countdown = _tripCountdown(trip.refDateStr);
  const dotHtml = trip.budgetDot
    ? `<span class="trip-budget-dot trip-budget-dot--${esc(trip.budgetDot)}"></span>`
    : '';

  const rows = [];
  if (trip.outDate) {
    rows.push(
      `<div class="trip-card-travel-row"><span>${_tripFmtDate(trip.outDate)} outbound</span></div>`,
    );
  }
  if (trip.checkIn && trip.checkOut) {
    rows.push(
      `<div class="trip-card-travel-row"><span>${_tripFmtDate(trip.checkIn)}–${_tripFmtDate(trip.checkOut)} stay</span></div>`,
    );
  }
  if (trip.retDate) {
    rows.push(
      `<div class="trip-card-travel-row"><span>${_tripFmtDate(trip.retDate)} return</span></div>`,
    );
  }

  const missing = [];
  if (!trip.hasFlights) missing.push('No flights');
  if (!trip.hasAccom) missing.push('No hotel');
  if (!trip.hasReturn) missing.push('No return');

  return `
    <div class="trip-card-wrap">
      <a href="${plannerHref(trip.slug)}" class="trip-card">
        <div class="trip-card-header">
          <span class="trip-mode-badge ${modeCls}">${modeLabel}</span>
          ${trip.unsaved ? '<span class="trip-unsaved-badge" title="This planner\'s local copy differs from the saved file — use Save to write it to disk">Unsaved</span>' : ''}
          ${dotHtml}
          ${countdown ? `<span class="trip-countdown">${esc(countdown)}</span>` : ''}
        </div>
        <h3 class="trip-card-title">${esc(trip.name)}</h3>
        ${confDates ? `<p class="trip-card-dates">${esc(confDates)}</p>` : '<p class="trip-card-dates trip-card-dates--unknown">No dates set</p>'}
        ${rows.length ? `<div class="trip-card-travel">${rows.join('')}</div>` : ''}
        ${missing.length ? `<div class="trip-card-missing">${missing.map((m) => `<span class="trip-missing-chip">${esc(m)}</span>`).join('')}</div>` : ''}
        ${trip.eventCount > 1 ? `<span class="trip-events-badge" title="Spans ${trip.eventCount} conferences">${trip.eventCount} events</span>` : ''}
      </a>
      <button type="button" class="trip-card-cog"
        data-slug="${esc(trip.slug)}"
        data-name="${esc(trip.name)}"
        data-event-file="${esc(trip.eventFile || '')}"
        data-event-label="${esc(trip.eventLabel || '')}"
        aria-label="Planner options">
        &#8942;
      </button>
    </div>`;
}

function _buildTimelineHtml(trips) {
  const allStarts = trips
    .map((t) => t.refDateStr)
    .filter(Boolean)
    .sort();
  const allEnds = trips
    .map((t) => t.endDateStr || t.refDateStr)
    .filter(Boolean)
    .sort();
  if (allStarts.length < 2) return '';

  const rangeStart = new Date(allStarts[0] + 'T12:00:00');
  rangeStart.setDate(1);
  const rangeEnd = new Date(allEnds[allEnds.length - 1] + 'T12:00:00');
  rangeEnd.setDate(1);
  rangeEnd.setMonth(rangeEnd.getMonth() + 1);

  const totalMs = rangeEnd - rangeStart;
  if (totalMs <= 0) return '';

  const bars = trips
    .map((trip) => {
      if (!trip.refDateStr) return '';
      const s = new Date(trip.refDateStr + 'T12:00:00');
      const e = new Date((trip.endDateStr || trip.refDateStr) + 'T12:00:00');
      const left = Math.max(0, ((s - rangeStart) / totalMs) * 100);
      const right = Math.min(100, ((e - rangeStart) / totalMs) * 100);
      const width = Math.max(right - left, 0.75);
      const cls = trip.mode === 'sponsor' ? 'trip-tl-bar--sponsor' : 'trip-tl-bar--personal';
      return `<a href="${plannerHref(trip.slug)}"
        class="trip-tl-bar ${cls}"
        data-slug="${esc(trip.slug)}"
        style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%"
        title="${esc(trip.name)}"
      ></a>`;
    })
    .filter(Boolean);

  return `<div class="trip-timeline">
    <div class="trip-tl-track">${bars.join('')}</div>
  </div>`;
}

function _buildDashboardHtml(upcoming, past, nextTrip, tlHtml) {
  let bannerHtml = '';
  if (nextTrip) {
    const countdown = _tripCountdown(nextTrip.refDateStr);
    bannerHtml = `<div class="trip-next-banner">
      <div class="trip-next-content">
        <p class="trip-next-label">Next trip</p>
        <h2 class="trip-next-name">${esc(nextTrip.name)}</h2>
        ${nextTrip.evStart ? `<p class="trip-next-dates">${_tripFmtRange(nextTrip.evStart, nextTrip.evEnd)}</p>` : ''}
      </div>
      <div class="trip-next-right">
        ${countdown ? `<p class="trip-next-countdown">${esc(countdown)}</p>` : ''}
        <a href="${plannerHref(nextTrip.slug)}" class="trip-next-open">Open planner</a>
      </div>
    </div>`;
  }

  const upcomingHtml = upcoming.length
    ? upcoming.map(_tripCardHtml).join('')
    : emptyState('No upcoming trips. Create a new planner to get started.');

  const pastHtml = past.length
    ? `<details class="trip-past-section">
        <summary class="trip-past-summary">Past trips (${past.length})</summary>
        <div class="hl-card-grid trip-cards--past">${past.map(_tripCardHtml).join('')}</div>
      </details>`
    : '';

  return homeRoot(`
    ${bannerHtml}
    ${tlHtml ? `<div class="trip-timeline-wrap">${tlHtml}</div>` : ''}
    <div class="trip-dashboard-section">
      ${sectionHeader({ title: 'Upcoming trips', primaryBtnId: 'newPlannerBtnNoEvent', primaryBtnLabel: 'New planner', secondaryBtnId: 'dashboardSettingsBtn', secondaryBtnTitle: 'Settings' })}
      ${cardGrid({ id: 'tripCardsGrid', innerHtml: upcomingHtml })}
    </div>
    ${pastHtml}
  `);
}

export async function renderTripDashboard() {
  const container = document.getElementById('plannerNoEvent');
  if (!container) return;

  // Gather all planners
  const rawPlanners = [];
  for (const key of listKeys(STORAGE_PREFIX)) {
    if (key === GLOBAL_KEY) continue;
    const slug = key.slice(STORAGE_PREFIX.length);
    const data = readJson(key, {});
    if (!isPlannerEntry(slug, data)) continue;
    rawPlanners.push({ data, slug });
  }

  // In parallel: (a) fetch event dates — skip only if cached with a real value;
  // retry null (prior failure/miss) — and (b) compare each planner to its disk copy.
  const [, unsavedSlugs] = await Promise.all([
    Promise.all(
      rawPlanners
        .filter((p) => p.data._eventFile && !_eventDates.get(p.data._eventFile)?.start)
        .map((p) => {
          _eventDates.delete(p.data._eventFile); // clear stale null so fetchEventDates retries
          return fetchEventDates(p.data._eventFile);
        }),
    ),
    _unsavedSlugs(rawPlanners),
  ]);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const trips = rawPlanners.map(({ data, slug }) => {
    const ef = data._eventFile || null;
    const evStart = ef ? _eventDates.get(ef)?.start || null : null;
    const evEnd = ef ? _eventDates.get(ef)?.end || null : null;
    const personal = data.personal || {};
    const outLegs = sortLegs(personal.outboundLegs || []);
    const retLegs = sortLegs(personal.returnLegs || []);
    const accoms = personal.accommodations || [];

    const outDate = outLegs.find((l) => l.date)?.date || null;
    const retDate = [...retLegs].reverse().find((l) => l.date)?.date || null;
    const checkIn = accoms.reduce(
      (e, a) => (!a.checkIn ? e : !e || a.checkIn < e ? a.checkIn : e),
      null,
    );
    const checkOut = accoms.reduce(
      (l, a) => (!a.checkOut ? l : !l || a.checkOut > l ? a.checkOut : l),
      null,
    );

    const refDateStr = outDate || evStart;
    const endDateStr = retDate || evEnd;
    const refDate = refDateStr ? new Date(refDateStr + 'T12:00:00') : null;
    const endDate = endDateStr ? new Date(endDateStr + 'T12:00:00') : null;
    const isUpcoming = endDate ? endDate >= today : refDate ? refDate >= today : true;

    const mode = data.mode === 'sponsor' ? 'sponsor' : 'personal';
    const budget = Number(mode === 'sponsor' ? data.org?.sponsorBudget || 0 : personal.budget || 0);
    const actual = Number(
      mode === 'sponsor' ? data.org?.sponsorActual || 0 : personal.budgetActual || 0,
    );
    const ratio = budget > 0 ? actual / budget : -1;

    return {
      slug,
      name: data._displayName || (ef || slug).replace('.json', ''),
      eventFile: ef || '',
      eventLabel: ef ? ef.replace('.json', '').replace(/[-_]/g, ' ') : '',
      eventCount: Array.isArray(data._eventFiles) ? data._eventFiles.length : ef ? 1 : 0,
      unsaved: unsavedSlugs.has(slug),
      mode,
      evStart,
      evEnd,
      outDate,
      retDate,
      checkIn,
      checkOut,
      refDateStr,
      endDateStr,
      refDate,
      endDate,
      isUpcoming,
      budgetDot: ratio < 0 ? '' : ratio < 0.7 ? 'green' : ratio < 1 ? 'amber' : 'red',
      hasFlights: outLegs.length > 0,
      hasReturn: retLegs.length > 0,
      hasAccom: accoms.length > 0,
      outLegMode: outLegs[0]?.mode || 'flight',
    };
  });

  const sortByDate = (a, b) => {
    if (!a.refDate && !b.refDate) return a.name.localeCompare(b.name);
    if (!a.refDate) return 1;
    if (!b.refDate) return -1;
    return a.refDate - b.refDate;
  };
  const upcoming = trips.filter((t) => t.isUpcoming).sort(sortByDate);
  const past = trips.filter((t) => !t.isUpcoming).sort((a, b) => sortByDate(b, a));
  const nextTrip = upcoming.find((t) => t.refDate);
  const tlHtml = _buildTimelineHtml(trips.filter((t) => t.refDateStr));

  const pastWasOpen = container.querySelector('details.trip-past-section')?.open ?? false;
  container.innerHTML = _buildDashboardHtml(upcoming, past, nextTrip, tlHtml);
  if (pastWasOpen) {
    const details = container.querySelector('details.trip-past-section');
    if (details) details.open = true;
  }
}
