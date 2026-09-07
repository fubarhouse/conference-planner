// Entry point for the standalone archive dashboard at /archive.
//
// The dashboard itself still lives in archiveDashboard.js, which was written
// as a full-screen overlay inside the editor. Nothing about its rendering is
// editor-specific, so this page supplies the same container IDs and drives it
// directly — no fork, no copy. Extracting the module out of `editor*` naming
// comes with the visual conversion, not before it.
import {
  openObservatory,
  getTopicInsights,
  isTopicOn,
  toggleTopic,
  togglePin,
  getPlottedTopics,
  getChartMode,
  addKeyword,
  getYearSpan,
  communitySubtitle,
  getSearchBreakdown,
  openDrillFromPath,
  openTopicDrill,
  openDebutDrill,
  showDrill,
  showSessionSearch,
} from './modules/archiveDashboard.js';
import {
  listAnnotations,
  getAnnotation,
  saveAnnotation,
  removeAnnotation,
  toggleAnnotation,
  yearRangeLabel,
  annotationColor,
  nextColor,
  PALETTE_SIZE,
  MAX_LABEL,
  MAX_NOTE,
  YEAR_MIN,
  YEAR_MAX,
} from './modules/archiveAnnotations.js';
import { loadThemes, applyThemeClass, getCurrentThemeId } from './modules/theme.js';
import { initThemePicker } from './modules/themePicker.js';
import { initAppMenu } from './modules/appMenu.js';
import { initRail, openRail } from './modules/rail.js';

document.addEventListener('DOMContentLoaded', async () => {
  await loadThemes();
  applyThemeClass(getCurrentThemeId());
  initThemePicker();
  // `.header-actions` goes with the nav, the way the schedule already sends its
  // Subscribe control down. Left in the bar, the Annotations button squeezed the
  // lockup to about 90px on a phone and wrapped "The whole community, year by
  // year" over five lines — the masthead ends up mostly chrome, and the thing
  // the page is named after is the part that gives way.
  initAppMenu({ adopt: ['.app-nav', '.header-actions'] });

  // No scroll-lock to undo any more: openObservatory() used to lock body scroll
  // for the editor overlay it was written for, and this line put it back. The
  // lock is gone at the source, along with the Escape-to-close that hid the
  // page's own <main>.
  openObservatory();

  initRail();
  wireKeywordRail();
  wireAnnotationsButton();
  wireSubtitle();
  wireSearchBreakdown();

  // A deep link (/archive/speaker/some-name) restores that drill-down once
  // the archive has loaded. The dashboard renders asynchronously, so wait for
  // the body to fill rather than racing it.
  // A drill is /archive/<type>/<slug>; a view mode is just /archive/videos or
  // /archive/sources. Both are addresses worth restoring.
  //
  // Deliberately ANY segment rather than a list of the modes that exist today.
  // The list form had to be edited every time a view mode was added, and when
  // `sources` was added and the list was not, refreshing /archive/sources
  // silently dropped the reader on the overview. openDrillFromPath already
  // decides what is routable; this guard only needs to know that something
  // follows /archive/.
  if (/\/archive\/[a-z]+/i.test(location.pathname)) {
    const body = document.getElementById('obsBody');
    const tryRoute = () => openDrillFromPath() && obs.disconnect();
    const obs = new MutationObserver(tryRoute);
    obs.observe(body, { childList: true, subtree: true });
    tryRoute();
  }

  window.addEventListener('popstate', (e) => {
    if (e.state?.sessions) showSessionSearch(e.state.sessions, e.state.match);
    else if (e.state?.topic) openTopicDrill(e.state.topic, e.state.year);
    else if (e.state?.debuts) openDebutDrill(e.state.debuts);
    else if (e.state?.drill) showDrill(e.state.drill, e.state.key);
    else openDrillFromPath() || location.reload();
  });
});

// Two rail surfaces, deliberately separated:
//
//   Discover  — "what was popular?", answered by ranking. Read-only browsing
//               that happens to let you plot something.
//   Keywords  — managing what is currently plotted: toggle, pin, remove.
//
// They were one panel and it read as a muddle: a ranked list and an editable
// set are different jobs. The legend now STAYS under the chart (a chart with
// two or more series always needs its legend in view) and the rail lists the
// same terms independently rather than stealing the node.
function wireKeywordRail() {
  const body = document.getElementById('obsBody');
  if (!body) return;

  const ensureTriggers = () => {
    const legend = document.getElementById('obsTopicLegend');
    // Keywords belong to the Topics view alone. Sessions plots one gold line and
    // People plots the cast — neither has anything to discover or manage, so the
    // controls must not survive the switch into either.
    if (!legend || getChartMode() !== 'topics') {
      document.querySelectorAll('.obs-rail-triggers').forEach((n) => n.remove());
      return;
    }
    if (legend.previousElementSibling?.classList.contains('obs-rail-triggers')) return;

    const bar = document.createElement('div');
    bar.className = 'obs-rail-triggers';
    bar.innerHTML = `
      <button type="button" class="app-btn" data-rail="discover">Discover keywords</button>
      <button type="button" class="app-btn" data-rail="manage">Manage keywords</button>`;
    bar.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-rail]');
      if (!btn) return;
      if (btn.dataset.rail === 'discover') openDiscoverRail();
      else openManageRail();
    });
    legend.parentElement.insertBefore(bar, legend);
  };

  ensureTriggers();
  new MutationObserver(ensureTriggers).observe(body, { childList: true, subtree: true });
}

// ── Annotations ──────────────────────────────────────────────────────────────
//
// The reader's own layer over the time axis: "COVID, 2020–2021" written once and
// drawn on every chart that plots years. See modules/archiveAnnotations.js for
// why they are local and why they are global rather than per-series.
//
// A masthead control rather than a chart control, and that IS the argument: a
// button on the topic chart would say these notes belong to that chart, when the
// whole point is that one note explains a shape appearing in all of them.

/** Which annotation the form is editing, or null when it is adding a new one. */
let _annEdit = null;

function wireAnnotationsButton() {
  const btn = document.getElementById('archiveAnnotationsBtn');
  btn?.addEventListener('click', () => {
    _annEdit = null;
    openAnnotationsRail();
  });
}

const attr = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// A real radio group, not buttons: eleven swatches ARE one choice among many, so
// the browser's own roving focus, arrow keys and form serialisation are exactly
// right and none of it has to be rebuilt. The label carries the slot number so
// the control is not colour-alone for anyone who cannot see the difference.
function annSwatchesHtml(a) {
  const current = a ? a.color : nextColor();
  const slots = Array.from({ length: PALETTE_SIZE }, (_, i) => {
    const on = current === i;
    return `<label class="obs-ann-sw${on ? ' is-on' : ''}" style="--ann-color:var(--viz-${i + 1})">
      <input type="radio" name="color" value="${i}"${on ? ' checked' : ''}>
      <span class="sr-only">Colour ${i + 1}</span>
    </label>`;
  }).join('');
  return `
    <span class="obs-ann-l" id="annColourL">Colour</span>
    <p class="obs-kw-note">From the same eleven the charts plot with — a note takes the
    first one nothing else is using.</p>
    <div class="obs-ann-swatches" role="radiogroup" aria-labelledby="annColourL">${slots}</div>`;
}

function annFormHtml() {
  const a = _annEdit ? getAnnotation(_annEdit) : null;
  return `
    <form class="obs-ann-form" data-ann-form>
      <h3 class="obs-kw-h">${a ? 'Edit note' : 'Add a note'}</h3>
      <p class="obs-kw-note">Something that happened <em>to</em> the community rather than
      in it — a pandemic, a platform release, a year the event moved. One year, or a span.</p>
      <input type="hidden" name="id" value="${attr(a?.id || '')}">
      <label class="obs-ann-l" for="annLabel">What happened</label>
      <input id="annLabel" name="label" class="obs-kw-input" type="text" required
             maxlength="${MAX_LABEL}" autocomplete="off" placeholder="e.g. COVID-19"
             value="${attr(a?.label || '')}">
      <div class="obs-ann-years">
        <div>
          <label class="obs-ann-l" for="annFrom">From year</label>
          <input id="annFrom" name="from" class="obs-kw-input" type="number" required
                 inputmode="numeric" min="${YEAR_MIN}" max="${YEAR_MAX}" step="1" placeholder="2020"
                 value="${attr(a ? a.from : '')}">
        </div>
        <div>
          <label class="obs-ann-l" for="annTo">To year</label>
          <input id="annTo" name="to" class="obs-kw-input" type="number"
                 inputmode="numeric" min="${YEAR_MIN}" max="${YEAR_MAX}" step="1" placeholder="same year"
                 value="${a && a.to !== a.from ? attr(a.to) : ''}">
        </div>
      </div>
      ${annSwatchesHtml(a)}
      <label class="obs-ann-l" for="annNote">Detail <span class="obs-kw-note">(optional)</span></label>
      <textarea id="annNote" name="note" class="obs-kw-input obs-ann-text" rows="3"
                maxlength="${MAX_NOTE}" placeholder="Shown on hover, and in the rail.">${attr(a?.note || '')}</textarea>
      <p class="obs-ann-err" data-ann-err hidden></p>
      <div class="obs-ann-actions">
        <button type="submit" class="app-btn">${a ? 'Save changes' : 'Add note'}</button>
        ${a ? '<button type="button" class="app-btn" data-ann-cancel>Cancel</button>' : ''}
      </div>
    </form>`;
}

function annListHtml() {
  const rows = listAnnotations();
  if (!rows.length)
    return `<p class="obs-kw-note">No notes yet. The first one most archives need is the
      two years the conferences stopped.</p>`;
  return `<ul class="obs-kw-list">${rows
    .map(
      (
        a,
      ) => `<li class="obs-ann-row${a.hidden ? ' is-off' : ''}" style="--ann-color:${annotationColor(a)}"${_annEdit === a.id ? ' data-ann-editing' : ''}>
        <button type="button" class="obs-ann-eye" data-ann-toggle="${attr(a.id)}"
                aria-pressed="${!a.hidden}">
          <span class="obs-ann-chip" aria-hidden="true"></span>
          <span class="sr-only">${a.hidden ? 'Show' : 'Hide'} ${attr(a.label)} on the charts</span>
        </button>
        <span class="obs-ann-years-l">${yearRangeLabel(a)}</span>
        <span class="obs-ann-name">${attr(a.label)}</span>
        ${a.note ? `<p class="obs-ann-detail">${attr(a.note)}</p>` : ''}
        <span class="obs-ann-row-actions">
          <button type="button" class="obs-kw-btn" data-ann-toggle="${attr(a.id)}" aria-pressed="${!a.hidden}">${a.hidden ? 'Hidden' : 'Shown'}</button>
          <button type="button" class="obs-kw-btn" data-ann-edit="${attr(a.id)}">Edit</button>
          <button type="button" class="obs-kw-btn" data-ann-del="${attr(a.id)}">Delete</button>
        </span>
      </li>`,
    )
    .join('')}</ul>`;
}

export function openAnnotationsRail() {
  const body = openRail('Annotations');
  if (!body) return;

  body.innerHTML = `
    ${panelHead('Annotations')}
    <p class="obs-kw-note">Notes on the years themselves, drawn on every chart with a time
    axis. Kept in this browser only — they are your reading of the archive, not part of it.</p>
    ${annFormHtml()}
    <h3 class="obs-kw-h">Your notes</h3>
    ${annListHtml()}`;

  body.addEventListener('click', (e) => {
    // The chip and the word are one control in two places — the chip for anyone
    // scanning the list of colours, the word for anyone reading it.
    const tog = e.target.closest('[data-ann-toggle]');
    if (tog) {
      toggleAnnotation(tog.dataset.annToggle);
      return openAnnotationsRail();
    }
    const del = e.target.closest('[data-ann-del]');
    if (del) {
      // The row carries its own label, so a confirm can name what it is about to
      // destroy rather than asking about "this item".
      const a = getAnnotation(del.dataset.annDel);
      if (a && !confirm(`Delete “${a.label}” (${yearRangeLabel(a)})?`)) return;
      removeAnnotation(del.dataset.annDel);
      if (_annEdit === del.dataset.annDel) _annEdit = null;
      return openAnnotationsRail();
    }
    const edit = e.target.closest('[data-ann-edit]');
    if (edit) {
      _annEdit = edit.dataset.annEdit;
      openAnnotationsRail();
      document.getElementById('annLabel')?.focus();
      return;
    }
    if (e.target.closest('[data-ann-cancel]')) {
      _annEdit = null;
      openAnnotationsRail();
    }
  });

  body.querySelector('[data-ann-form]')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target).entries());
    const err = body.querySelector('[data-ann-err]');
    const saved = saveAnnotation(data);
    if (!saved) {
      // The store validates; the form only has to report. Duplicating the rules
      // here is how the two drift apart.
      err.textContent = `Needs a description and a year between ${YEAR_MIN} and ${YEAR_MAX}.`;
      err.hidden = false;
      return;
    }
    _annEdit = null;
    openAnnotationsRail();
  });
}

// The masthead used to hardcode "Nineteen years", which drifted the moment the
// archive gained a year. Derived from the data instead — and from the ELAPSED
// years, not the count of years with events: it read "20 years of the community ·
// 2007–2026", and 2007 to 2026 is 19 years. See `communitySubtitle`.
function wireSubtitle() {
  const el = document.getElementById('archiveSubtitle');
  if (!el) return;
  const fill = () => {
    const line = communitySubtitle(getYearSpan());
    if (!line) return false;
    el.textContent = line;
    return true;
  };
  if (fill()) return;
  const obs = new MutationObserver(() => fill() && obs.disconnect());
  obs.observe(document.getElementById('obsBody') || document.body, {
    childList: true,
    subtree: true,
  });
}

// The rail is otherwise an empty column on a search page, and a search has a
// shape worth reading: which series, where, who. On desktop it fills itself; on
// mobile the rail is a sheet, so it waits to be asked.
function wireSearchBreakdown() {
  document.addEventListener('archive:search', () => {
    if (window.matchMedia('(min-width: 86rem)').matches) openBreakdownRail();
  });
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-breakdown]')) openBreakdownRail();
  });
}

// A row reads "55 of 57" — matches, then how many that bucket has in the searched
// scope. The bare count invited a comparison it could not survive: a reader
// browser-finds the name in the results list, counts two, and concludes the
// tally is broken. It was never counting the visible page.
//
// The BAR still encodes the raw count, not the share, and deliberately: this is a
// ranking of who talked about the subject most, so 55-of-57 must not out-draw
// 200-of-1000. The ratio is in the number for anyone who wants it.
function tallyList(rows, label) {
  if (!rows?.length) return '';
  const max = Math.max(...rows.map((r) => r.count), 1);
  const val = (r) => (r.total > r.count ? `${r.count} of ${r.total}` : `${r.count}`);
  return `
    <section class="obs-kw-group">
      <h3 class="obs-kw-h">${label}</h3>
      <ul class="obs-kw-list">
        ${rows
          .map(
            (r) => `<li class="obs-bd-row">
              <span class="obs-bd-name">${r.name}</span>
              <span class="obs-bd-bar"><i style="inline-size:${((r.count / max) * 100).toFixed(1)}%"></i></span>
              <span class="obs-kw-val">${val(r)}</span>
            </li>`,
          )
          .join('')}
      </ul>
    </section>`;
}

const REGION_NAMES = {
  EUR: 'Europe',
  MEA: 'Middle East & Africa',
  APAC: 'Asia-Pacific',
  AMER: 'North America',
  LATAM: 'Latin America',
};

export function openBreakdownRail() {
  const info = getSearchBreakdown();
  const body = openRail('Search breakdown');
  if (!body || !info) return;
  const b = info.breakdown || {};
  const regions = (b.region || []).map((r) => ({ ...r, name: REGION_NAMES[r.name] || r.name }));
  // The results list is capped; these tallies are not. Say so where the numbers
  // are, not only in the page heading above them.
  const capped =
    info.shown && info.total > info.shown
      ? ` Every match is counted here — the list shows the newest ${info.shown}.`
      : '';

  body.innerHTML = `
    ${panelHead('Breakdown')}
    <p class="obs-kw-note">${info.total} session${info.total === 1 ? '' : 's'} across
      ${b.events || 0}${b.eventsTotal ? ` of ${b.eventsTotal}` : ''} event${b.events === 1 ? '' : 's'}${b.span ? `, ${b.span.min}–${b.span.max}` : ''}.${capped}</p>
    ${tallyList(b.series, 'By series')}
    ${tallyList(regions, 'By region')}
    ${tallyList((b.country || []).slice(0, 8), 'By country')}
    ${tallyList(b.city, 'By city')}
    ${tallyList(b.speakers, 'Most present speakers')}`;
}

// This head used to carry no close button, on the reasoning that the rail is the
// margin of the page rather than a dialog: it already yields to Escape, to
// opening a session, and to running another search.
//
// That reasoning only holds on a desktop, where the rail IS a margin. Under
// 86rem the same element is `position: fixed; inset: 0` with the body locked
// (section-chrome.css) — a full-screen sheet over the results, on a device with
// no Escape key and no visible way back. Every other rail in the product ships
// the button (see sponsors.js); this one was the outlier, and on a phone it was
// a dead end.
function panelHead(title) {
  return `
    <div class="app-panel__head">
      <span class="app-panel__eyebrow">${title}</span>
      <button type="button" class="app-panel__close" data-rail-close>Close</button>
    </div>`;
}

function kwList(rows, fmt) {
  return `<ul class="obs-kw-list">${rows
    .map(
      (
        r,
      ) => `<li><button type="button" class="obs-kw-add${isTopicOn(r.term) ? ' is-on' : ''}" data-kw="${r.term.replace(/"/g, '&quot;')}">
        <span class="obs-kw-term">${r.term}</span>
        <span class="obs-kw-val">${fmt(r.value)}</span>
      </button></li>`,
    )
    .join('')}</ul>`;
}

let _kwOffset = 0;

function openDiscoverRail(offset = 0) {
  _kwOffset = offset;
  const body = openRail('Discover keywords');
  if (!body) return;
  const { top, rising, more, year } = getTopicInsights({ offset });

  body.innerHTML = `
    ${panelHead('Discover')}
    <section class="obs-kw-group">
      <h3 class="obs-kw-h">Most discussed</h3>
      <p class="obs-kw-note">${year ? `Across every session in ${year}, in the current scope.` : 'Across every session in the current scope.'}</p>
      ${kwList(top, (v) => `${v}`)}
    </section>
    ${
      rising.length
        ? `<section class="obs-kw-group">
      <h3 class="obs-kw-h">Rising</h3>
      <p class="obs-kw-note">Gaining share over the last five years.</p>
      ${kwList(rising, (v) => `+${v.toFixed(1)}%`)}
    </section>`
        : `<section class="obs-kw-group">
      <h3 class="obs-kw-h">Rising</h3>
      <p class="obs-kw-note">Not shown while a single year is selected — a trend needs more than one.</p>
    </section>`
    }
    ${more ? '<button type="button" class="app-btn obs-kw-more" data-kw-more>Show another set</button>' : ''}`;

  body.addEventListener('click', (e) => {
    if (e.target.closest('[data-kw-more]')) return openDiscoverRail(_kwOffset + 8);
    const add = e.target.closest('[data-kw]');
    if (!add) return;
    toggleTopic(add.dataset.kw);
    add.classList.toggle('is-on', isTopicOn(add.dataset.kw));
  });
}

function openManageRail() {
  const body = openRail('Manage keywords');
  if (!body) return;
  const rows = getPlottedTopics();

  body.innerHTML = `
    ${panelHead('Keywords')}
    <form class="obs-kw-form" data-kw-form>
      <label class="obs-kw-h" for="railKwAdd">Add a keyword</label>
      <p class="obs-kw-note">Any word or phrase — it searches titles and descriptions, so
      it does not have to be one we mined.</p>
      <input id="railKwAdd" class="obs-kw-input" type="search"
             placeholder="e.g. display suite" autocomplete="off" spellcheck="false">
    </form>
    <p class="obs-kw-note">Plotted now. Pin the ones you want back on every visit.</p>
    ${
      rows.length
        ? `<ul class="obs-kw-list">${rows
            .map(
              (r) => `<li class="obs-kw-manage">
          <span class="obs-kw-sw" style="background:${r.color}"></span>
          <span class="obs-kw-term">${r.term}</span>
          <button type="button" class="obs-kw-btn" data-pin="${r.term.replace(/"/g, '&quot;')}" aria-pressed="${r.pinned}">${r.pinned ? 'Pinned' : 'Pin'}</button>
          <button type="button" class="obs-kw-btn" data-off="${r.term.replace(/"/g, '&quot;')}">Remove</button>
        </li>`,
            )
            .join('')}</ul>`
        : '<p class="obs-kw-note">Nothing plotted yet — try Discover.</p>'
    }`;

  body.addEventListener('click', (e) => {
    const pin = e.target.closest('[data-pin]');
    if (pin) return (togglePin(pin.dataset.pin), openManageRail());
    const off = e.target.closest('[data-off]');
    if (off) return (toggleTopic(off.dataset.off), openManageRail());
  });

  const form = body.querySelector('[data-kw-form]');
  const input = body.querySelector('#railKwAdd');
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const term = input.value.trim();
    if (!term) return;
    input.disabled = true;
    const ok = await addKeyword(term);
    input.disabled = false;
    if (ok) openManageRail();
    else {
      input.value = '';
      input.placeholder = `Nothing matches “${term}”`;
      input.focus();
    }
  });
}
