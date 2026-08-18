// Curation — the archive-wide identity desk. Walks near-duplicate
// speaker/sponsor spellings one case at a time, showing each spelling's
// twenty-year appearance timeline and context so you can confidently merge
// (canonicalise across all datasets), mark distinct, or skip.
//
// Backed by /api/curation/*. It NEVER auto-merges — every change is
// human-confirmed with a dry-run preview and lands as a git-reviewable diff.
//
// It was a full-screen overlay inside the editor; it is its own page at
// /curation now, for the same reason the archive stopped being one: it is a
// place you go and work, not a mode another tool drops into.
import { escapeHtml as esc } from './utils.js';

const Y0 = 2007;
const Y1 = 2026;

const state = {
  kind: 'speaker', // 'speaker' | 'sponsor' | 'coverage'
  clusters: { speaker: [], sponsor: [], coverage: [] },
  // The coverage worklist: what each event is missing. A third deck rather than a
  // separate page — it is the same job as the identity decks (walk a list, decide,
  // move on) and it writes to the same ledger.
  coverage: null,
  coverageFilter: 'fixable', // 'fixable' | 'all'

  stats: null,
  idx: { speaker: 0, sponsor: 0, coverage: 0 },
  canonical: '',
  previewed: false,
  busy: false,
  view: 'review', // 'review' (one case at a time) | 'overview' (grid + decisions log)
  decisions: { aliases: {}, distinct: [] },
  impact: {}, // decision key → what it covers (talks / sponsorships / credits / events)
  logFilter: '', // text filter over the decisions log
  remapKey: null, // the log row with its "change target" form open
};

const $ = (id) => document.getElementById(id);
// Tolerant of a kind that is not an identity deck: Coverage is a worklist, not a
// deck of cases, and `state.clusters.coverage` is deliberately absent. Without the
// fallback `render()` threw on `deck().length` the moment Coverage was selected —
// which left whatever was already on screen (for a tidied archive, "All clusters
// reviewed") sitting there looking like an answer.
const deck = () => state.clusters[state.kind] || [];
const current = () => deck()[state.idx[state.kind] || 0];

function timelineHtml(years) {
  const set = new Set((years || []).map(Number));
  let s = '<span class="cur-tl" aria-hidden="true">';
  for (let y = Y0; y <= Y1; y++) s += `<i class="${set.has(y) ? 'on' : ''}"></i>`;
  return s + '</span>';
}

function variantYears(v) {
  return (v.events || []).map((e) => e.year).filter(Boolean);
}
function variantTalk(v) {
  const t = (v.events || []).flatMap((e) => e.talks || [])[0];
  return t || '';
}
function variantLogo(v) {
  const e = (v.events || []).find((x) => x.image);
  return e ? e.image : '';
}

async function loadClusters() {
  const res = await fetch('/api/curation/clusters');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  state.clusters.speaker = data.speakerClusters || [];
  state.clusters.sponsor = data.sponsorClusters || [];
  state.stats = data.stats;
  state.decisions = data.decisions || { aliases: {}, distinct: [] };
  state.impact = data.impact || {};
}

function clusterYears(c) {
  return [
    ...new Set((c.variants || []).flatMap((v) => (v.events || []).map((e) => e.year))),
  ].filter(Boolean);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// A decisions-log row, resolved for display.
//
// The stored key is a FINGERPRINT — "baddy baddysonja breidert sonja" — which is the
// right identity and the wrong label. So a row shows the spellings that key actually
// covers in the archive, and keeps the fingerprint as the tooltip and the undo handle.
// Both sides are carried on the row because both sides are searchable: you look for a
// decision by whichever name you remember.
export function decisionRows(decisions, impact = {}) {
  const make = (type, key, canonical) => {
    const imp = impact[key] || {};
    const variants = (imp.variants || []).filter((n) => n !== canonical);
    return { type, key, canonical, impact: imp, variants, from: variants.join(', ') || key };
  };
  return [
    ...Object.entries(decisions.aliases || {}).map(([key, canon]) => make('alias', key, canon)),
    ...(decisions.distinct || []).map((key) => make('distinct', key, '')),
  ];
}

// 193 rows is a list you search, not one you scroll. Matches either side of the
// mapping — the spellings, the canonical name, and the fingerprint underneath.
export function filterDecisionRows(rows, q) {
  const needle = String(q || '')
    .trim()
    .toLowerCase();
  if (!needle) return rows;
  return rows.filter((r) =>
    [r.key, r.canonical, ...r.variants].join(' ').toLowerCase().includes(needle),
  );
}

// What the decision covers, in one line. A mapping that merges a conference speaker
// with an event volunteer says so, because that is the case where an undo is a
// judgement call rather than a formality.
export function impactText(imp = {}) {
  const bits = [];
  if (imp.talks) bits.push(plural(imp.talks, 'talk'));
  if (imp.sponsorships) bits.push(plural(imp.sponsorships, 'sponsorship'));
  if (imp.credits)
    bits.push(
      `${imp.credits} ${(imp.roles || []).join('/') || 'community'} credit${imp.credits === 1 ? '' : 's'}`,
    );
  if (imp.events) bits.push(plural(imp.events, 'event'));
  return bits.join(' · ') || 'Nothing in the archive carries this spelling now';
}

// Targets offered when changing a mapping: the canonical names already in use, plus
// every spelling still sitting in an unreviewed cluster. No new endpoint — it is the
// same payload the desk already loaded, which is also why it is honest about scope.
function canonicalOptions() {
  const names = new Set(Object.values(state.decisions.aliases || {}));
  for (const kind of ['speaker', 'sponsor'])
    for (const c of state.clusters[kind]) for (const v of c.variants) names.add(v.name);
  return [...names].sort((a, b) => a.localeCompare(b)).slice(0, 600);
}

function logRowHtml(r) {
  const isAlias = r.type === 'alias';
  const undoAttr = isAlias ? 'data-undo-alias' : 'data-undo-distinct';
  const headline = isAlias
    ? `<b>${esc(r.from)}</b> → <b>${esc(r.canonical)}</b>`
    : `Kept distinct: <b>${esc(r.from)}</b>`;
  // Remap in one step. Before, changing a target meant undo → find the cluster
  // again → re-map; the server already overwrites aliases[key], so the round trip
  // was the interface's idea, not the data's.
  const remap =
    isAlias && state.remapKey === r.key
      ? `<div class="cur-log-remap">
          <input class="cur-log-remap-input" id="curRemapInput" list="curRemapList" value="${esc(r.canonical)}" placeholder="Canonical name…" autocomplete="off" spellcheck="false">
          <button type="button" class="cur-log-undo" data-remap-save="${esc(r.key)}">Save</button>
          <button type="button" class="cur-log-undo" data-remap-cancel>Cancel</button>
        </div>`
      : '';
  return `<div class="cur-log-row${remap ? ' is-open' : ''}">
    <span class="cur-log-i cur-log-i--${isAlias ? 'merge' : 'distinct'}"><i class="fas ${isAlias ? 'fa-code-merge' : 'fa-code-branch'}" aria-hidden="true"></i></span>
    <div class="cur-log-main">
      <span class="cur-log-txt" title="${esc(r.key)}">${headline}</span>
      <span class="cur-log-impact">${esc(impactText(r.impact))}</span>
      ${remap}
    </div>
    ${isAlias ? `<button type="button" class="cur-log-undo" data-remap="${esc(r.key)}">Remap</button>` : ''}
    <button type="button" class="cur-log-undo" ${undoAttr}="${esc(r.key)}">Undo</button>
  </div>`;
}

const logCountText = (shown, total) => (shown === total ? String(total) : `${shown} / ${total}`);

// Just the rows — re-rendered on every keystroke of the filter, while the input
// itself stays put and keeps focus.
function logListHtml() {
  const rows = filterDecisionRows(decisionRows(state.decisions, state.impact), state.logFilter);
  if (!rows.length)
    return `<p class="cur-ov-empty cur-ov-empty--sm">${
      state.logFilter
        ? `No decision matches “${esc(state.logFilter)}”.`
        : 'No decisions yet — merges and “not the same” calls land here, and you can stop any time.'
    }</p>`;
  return `<div class="cur-log">${rows.map(logRowHtml).join('')}</div>`;
}

// Overview: a jump-anywhere grid of what's left + a running decisions log (undo the
// safe ones). The half that makes the 186-case grind survivable and resumable.
function overviewHtml() {
  const remaining = deck();
  const all = decisionRows(state.decisions, state.impact);
  const shown = filterDecisionRows(all, state.logFilter).length;
  const grid = remaining.length
    ? `<div class="cur-ov-grid">${remaining
        .map(
          (c, i) => `<button type="button" class="cur-ov-card" data-jump="${i}">
        <span class="cur-ov-card-key">${esc(c.key)}</span>
        <span class="cur-ov-card-meta">${c.variants.length} spellings · ${plural(c.total, 'appearance')} · ${plural(c.eventCount, 'event')}</span>
        ${timelineHtml(clusterYears(c))}</button>`,
        )
        .join('')}</div>`
    : `<p class="cur-ov-empty">All ${state.kind} clusters reviewed.</p>`;
  // The log was gated on `done` — it appeared only once every cluster had been
  // reviewed, so 193 recorded decisions rendered as "No decisions yet" and undo was
  // unreachable. A decision is reversible from the moment it is made, especially now
  // that mappings can also be made from the archive person page.
  return `<div class="cur-ov">
    <div class="cur-ov-col">
      <h2 class="cur-ov-h">Remaining ${state.kind}s <span class="cur-ov-n">${remaining.length}</span></h2>
      ${grid}
    </div>
    <div class="cur-ov-col cur-ov-col--log">
      <h2 class="cur-ov-h">Decisions <span class="cur-ov-n" id="curLogCount">${logCountText(shown, all.length)}</span></h2>
      <input type="search" class="cur-log-filter" id="curLogFilter" value="${esc(state.logFilter)}" placeholder="Filter decisions — either name…" autocomplete="off" spellcheck="false">
      <div id="curLogList">${logListHtml()}</div>
      <datalist id="curRemapList">${canonicalOptions()
        .map((n) => `<option value="${esc(n)}"></option>`)
        .join('')}</datalist>
    </div>
  </div>`;
}

function candidateHtml(cluster, v) {
  const isCanon = v.name === state.canonical;
  const isSponsor = state.kind === 'sponsor';
  const logo = isSponsor ? variantLogo(v) : '';
  const tier = isSponsor ? v.events?.[0]?.tier || '' : '';
  const talk = !isSponsor ? variantTalk(v) : '';
  return `<button type="button" class="cur-cand${isCanon ? ' is-canonical' : ''}" data-variant="${esc(v.name)}">
    <span class="cur-cand-crown"><i class="fas ${isCanon ? 'fa-crown' : 'fa-circle-dot'}" aria-hidden="true"></i></span>
    <span class="cur-cand-main">
      <span class="cur-cand-name">${esc(v.name)}</span>
      <span class="cur-cand-meta">${v.count} appearance${v.count === 1 ? '' : 's'} · ${v.events.length} event${v.events.length === 1 ? '' : 's'}${tier ? ` · <span class="cur-tier">${esc(tier)}</span>` : ''}${talk ? ` · <span class="cur-cand-talk">“${esc(talk)}”</span>` : ''}</span>
    </span>
    ${logo ? `<img class="cur-cand-logo" src="${esc(logo)}" alt="" onerror="this.style.visibility='hidden'">` : ''}
    <span>${timelineHtml(variantYears(v))}</span>
  </button>`;
}

function caseHtml(cluster) {
  const q = state.kind === 'speaker' ? 'Are these the same person?' : 'Are these the same sponsor?';
  return `
    <div class="cur-case">
      <div class="cur-case-head">
        <span class="cur-case-q">${q}</span>
        <span class="cur-case-key">${esc(cluster.key)} · 2007→2026</span>
      </div>
      <div class="cur-cands">${cluster.variants.map((v) => candidateHtml(cluster, v)).join('')}</div>
      <div class="cur-canonical">
        <label class="cur-canonical-label" for="curCanonical">Canonical</label>
        <input type="text" id="curCanonical" class="cur-canonical-input" value="${esc(state.canonical)}" spellcheck="false">
      </div>
      <div class="cur-preview" id="curPreview"></div>
      <div class="cur-actions">
        <button type="button" class="cur-btn cur-btn--ghost" data-act="distinct">Not the same</button>
        <button type="button" class="cur-btn cur-btn--skip" data-act="skip">Skip</button>
        <button type="button" class="cur-btn cur-btn--gold" data-act="merge">${state.previewed ? 'Map to canonical' : 'Preview mapping'}</button>
      </div>
    </div>`;
}

function doneHtml() {
  const other = state.kind === 'speaker' ? 'sponsor' : 'speaker';
  const otherLeft = state.clusters[other].length - state.idx[other];
  return `<div class="cur-done">
    <div class="cur-done-badge"></div>
    <p style="font-size:1.15rem;font-weight:700;color:#fff">All ${state.kind === 'speaker' ? 'speaker' : 'sponsor'} clusters reviewed.</p>
    <p>Nice work tidying the archive.${otherLeft > 0 ? ` ${otherLeft} ${other} cluster${otherLeft === 1 ? '' : 's'} still waiting.` : ''}</p>
    <button type="button" class="obs-cta" data-act="observatory">Explore the archive you tidied</button>
  </div>`;
}

/**
 * The coverage worklist.
 *
 * Grouped by EVENT rather than by kind of gap, because that is how the work is
 * actually done — you open one event's datasets and fix several things at once.
 * Each gap carries its own decision: "Ignore" for the ones that will never close
 * (a 2007 conference has no recordings and never will) and "Later" for the ones
 * waiting on someone else. A worklist that keeps reporting the impossible is a
 * worklist you stop reading.
 */
/**
 * One event per case, worked the way the identity decks are: read it, decide, move
 * on. It began as a long scrollable list, which is a different activity — a list
 * is for browsing, and this is a queue you clear.
 *
 * The per-gap buttons stay, because a decision belongs to a GAP and not to an
 * event: recordings can be beyond hope while descriptions are still worth
 * fetching. The footer acts on the whole case for when the answer is the same for
 * all of them ("this 2008 camp left no digital trace at all").
 */
function coverageCaseHtml(ev) {
  const gaps = ev.checks.filter((c) =>
    state.coverageFilter === 'fixable' ? c.open && c.fixable : c.open,
  );
  const file = ev.file.replace(/^events\//, '').replace(/\.json$/, '');
  return `
    <div class="cur-case">
      <div class="cur-case-head">
        <span class="cur-case-q">${esc(ev.label)}</span>
        <span class="cur-case-key">${esc(file)} · ${ev.sessions} sessions · ${ev.score}% coverage</span>
      </div>
      <p class="cur-cov-sub">${
        ev.fixableSessions
          ? `${ev.fixableSessions} session page${ev.fixableSessions === 1 ? '' : 's'} to visit, closing ${ev.fixable} gap${ev.fixable === 1 ? '' : 's'}.`
          : 'Nothing here can be fetched from a link — these need someone who was there.'
      }</p>
      ${
        ev.pending?.length
          ? `<p class="cur-cov-pending">Waits for the event: ${ev.pending.map((x) => esc(x)).join(', ')} — not counted while it is still to come.</p>`
          : ''
      }
      <ul class="cur-cov-list">${gaps
        .map(
          (c) => `<li class="cur-cov-gap">
            <span class="cur-cov-what"><b>${esc(c.label)}</b> ${
              c.total === 1
                ? 'none recorded'
                : `${c.missing} of ${c.total} missing${c.fixable ? ` · ${c.fixable} have a link to fetch from` : ''}`
            }<span class="cur-cov-detail">${esc(c.detail)}</span></span>
            <span class="cur-cov-acts">
              <button type="button" class="cur-mini" data-cov="later" data-file="${esc(ev.file)}" data-check="${esc(c.key)}">Later</button>
              <button type="button" class="cur-mini" data-cov="ignored" data-file="${esc(ev.file)}" data-check="${esc(c.key)}">Ignore</button>
            </span>
          </li>`,
        )
        .join('')}</ul>
      <div class="cur-actions">
        <button type="button" class="cur-btn cur-btn--ghost" data-act="cov-ignore-all">Ignore all here</button>
        <button type="button" class="cur-btn cur-btn--skip" data-act="skip">Skip</button>
        <button type="button" class="cur-btn cur-btn--gold" data-act="cov-later-all">Remind me in 30 days</button>
      </div>
    </div>`;
}

/** The deck is empty when every event has been answered. */
function coverageDoneHtml() {
  return `<div class="cur-done">
    <div class="cur-done-badge"></div>
    <p style="font-size:1.15rem;font-weight:700;color:#fff">Nothing left in this filter.</p>
    <p>Every event either has what it needs, or you have said it never will.</p>
    <button type="button" class="cur-btn cur-btn--ghost" data-covfilter="${state.coverageFilter === 'fixable' ? 'all' : 'fixable'}">Show ${state.coverageFilter === 'fixable' ? 'every gap' : 'only fetchable'}</button>
  </div>`;
}

function coverageHtml() {
  const cov = state.coverage;
  if (!cov) return `<p class="cur-ov-empty">Reading the archive…</p>`;
  const onlyFixable = state.coverageFilter === 'fixable';
  const t = cov.totals;
  const ev = current();
  return `<div class="cur-cov">
    <div class="cur-cov-head">
      <h2 class="cur-ov-h">Coverage <span class="cur-ov-n">${deck().length} to work</span></h2>
      <p class="cur-cov-sub">${t.fixableSessions} session pages across the archive · ${t.fixable} gaps${
        t.snoozed ? ` · ${t.snoozed} ignored or snoozed` : ''
      }</p>
      <div class="cur-cov-filters">
        <button type="button" class="cur-seg-btn${onlyFixable ? ' is-active' : ''}" data-covfilter="fixable">Fetchable now</button>
        <button type="button" class="cur-seg-btn${onlyFixable ? '' : ' is-active'}" data-covfilter="all">Every gap</button>
      </div>
    </div>
    ${ev ? coverageCaseHtml(ev) : coverageDoneHtml()}
  </div>`;
}

function render() {
  const s = state.stats || {};
  const spLeft = state.clusters.speaker.length - state.idx.speaker;
  const spoLeft = state.clusters.sponsor.length - state.idx.sponsor;
  const toResolve = spLeft + spoLeft;
  $('curStats').innerHTML = `
    <span class="cur-stat"><b>${s.events ?? '—'}</b>events</span>
    <span class="cur-stat"><b>${s.avgCoverage ?? '—'}%</b>coverage</span>
    <span class="cur-stat cur-stat--warn"><b>${s.brokenImages ?? '—'}</b>broken imgs</span>
    <span class="cur-stat cur-stat--gold"><b>${toResolve}</b>to resolve</span>`;
  $('curSegSpeaker').textContent = spLeft;
  $('curSegSponsor').textContent = spoLeft;
  const covSeg = $('curSegCoverage');
  if (covSeg) covSeg.textContent = state.coverage ? state.coverage.totals.withGaps : '·';
  // Progress and the Overview toggle belong to the identity decks; the coverage
  // list is not a deck of cases you advance through.
  // Coverage is a deck like the others, so it keeps the progress rail; only the
  // Overview/Review toggle is meaningless there (its overview IS the report file).
  $('curViewBtn')?.classList.toggle('hidden', state.kind === 'coverage');
  document
    .querySelectorAll('.cur-seg-btn')
    .forEach((b) => b.classList.toggle('is-active', b.dataset.kind === state.kind));

  const total = deck().length;
  const pos = state.idx[state.kind] || 0;
  const cluster = state.kind === 'coverage' ? null : current();
  const unit = state.kind === 'coverage' ? 'Event' : 'Case';
  $('curProgress').innerHTML = (state.kind === 'coverage' ? current() : cluster)
    ? `<span class="cur-progress-label">${unit} <b>${pos + 1}</b> of ${total}</span><div class="cur-progress-rail"><i style="width:${total ? (pos / total) * 100 : 0}%"></i></div>`
    : `<span class="cur-progress-label">${total} reviewed</span><div class="cur-progress-rail"><i style="width:100%"></i></div>`;

  const viewBtn = $('curViewBtn');
  const viewLbl = $('curViewLbl');
  if (viewBtn) viewBtn.classList.toggle('is-active', state.view === 'overview');
  if (viewLbl) viewLbl.textContent = state.view === 'overview' ? 'Review' : 'Overview';

  if (state.kind === 'coverage') {
    $('curStage').innerHTML = coverageHtml();
  } else if (state.view === 'overview') {
    $('curStage').innerHTML = overviewHtml();
  } else if (cluster) {
    if (!state.canonical || !cluster.variants.some((v) => v.name === state.canonical))
      state.canonical = cluster.canonical;
    $('curStage').innerHTML = caseHtml(cluster);
  } else {
    $('curStage').innerHTML = doneHtml();
  }
}

function advance() {
  state.idx[state.kind]++;
  state.canonical = '';
  state.previewed = false;
  render();
}

async function doMerge(cluster) {
  const canonical = ($('curCanonical')?.value || state.canonical).trim();
  if (!canonical) return;
  if (!state.previewed) {
    // Mapping-only: the preview is computed from the cluster (the source datasets are
    // never touched) — it shows what the read-time alias WILL resolve.
    const others = cluster.variants.filter((v) => v.name !== canonical);
    const appearances = others.reduce((n, v) => n + v.count, 0);
    const events = new Set(others.flatMap((v) => v.events.map((e) => e.file))).size;
    const rows = others
      .map(
        (v) =>
          `<div class="cur-preview-row"><span>${esc(v.name)}</span><b>${v.count} appearance${v.count === 1 ? '' : 's'}</b></div>`,
      )
      .join('');
    $('curPreview').innerHTML = appearances
      ? `<p class="cur-preview-head">Maps <b>${appearances} appearance${appearances === 1 ? '' : 's'}</b> to <b>${esc(canonical)}</b> across <b>${events} event${events === 1 ? '' : 's'}</b> — a private mapping, the datasets stay untouched:</p><div class="cur-preview-list">${rows}</div>`
      : `<p class="cur-preview-head">Nothing to map — every spelling already matches.</p>`;
    state.previewed = true;
    const btn = document.querySelector('[data-act="merge"]');
    if (btn) btn.innerHTML = 'Map to canonical';
    return;
  }
  // Record the mapping (an alias in the private decisions file). No dataset rewrite.
  await fetch('/api/curation/merge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: state.kind, key: cluster.key, canonical }),
  });
  advance();
}

async function doDistinct(cluster) {
  await fetch('/api/curation/distinct', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: cluster.key }),
  });
  advance();
}

async function undoDecision(type, key) {
  await fetch('/api/curation/undo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, key }),
  });
  await loadClusters(); // the un-mapped / un-distinct cluster resurfaces
  render();
}

// Point an existing mapping at a different canonical name. The server overwrites
// aliases[key], so this is the same call a first mapping makes — what was missing
// was a way to say it without undoing first.
async function remapDecision(key, canonical) {
  const target = String(canonical || '').trim();
  if (!target) return;
  await fetch('/api/curation/merge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: state.kind, key, canonical: target }),
  });
  state.remapKey = null;
  await loadClusters();
  render();
}

// Re-render the log alone, so typing in the filter does not rebuild (and blur) the
// input the typing is happening in.
function renderLog() {
  const list = $('curLogList');
  if (!list) return;
  list.innerHTML = logListHtml();
  const all = decisionRows(state.decisions, state.impact);
  const count = $('curLogCount');
  if (count)
    count.textContent = logCountText(filterDecisionRows(all, state.logFilter).length, all.length);
}

function onStageClick(e) {
  if (state.busy) return;
  // Overview: jump to a specific case, or undo a logged decision.
  const jump = e.target.closest('[data-jump]');
  if (jump) {
    state.idx[state.kind] = Number(jump.dataset.jump);
    state.canonical = '';
    state.previewed = false;
    state.view = 'review';
    render();
    return;
  }
  // Remap: open the form on a row, save it, or back out.
  const remapOpen = e.target.closest('[data-remap]');
  if (remapOpen) {
    state.remapKey = state.remapKey === remapOpen.dataset.remap ? null : remapOpen.dataset.remap;
    renderLog();
    $('curRemapInput')?.focus();
    return;
  }
  if (e.target.closest('[data-remap-cancel]')) {
    state.remapKey = null;
    renderLog();
    return;
  }
  const remapSave = e.target.closest('[data-remap-save]');
  if (remapSave) {
    state.busy = true;
    remapDecision(remapSave.dataset.remapSave, $('curRemapInput')?.value).finally(() => {
      state.busy = false;
    });
    return;
  }
  const undo = e.target.closest('[data-undo-alias],[data-undo-distinct]');
  if (undo) {
    const type = undo.hasAttribute('data-undo-alias') ? 'alias' : 'distinct';
    const key = undo.dataset.undoAlias ?? undo.dataset.undoDistinct;
    state.busy = true;
    undoDecision(type, key).finally(() => {
      state.busy = false;
    });
    return;
  }
  const cand = e.target.closest('.cur-cand');
  if (cand) {
    state.canonical = cand.dataset.variant;
    state.previewed = false;
    render();
    return;
  }
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'observatory') {
    location.href = './archive.html';
    return;
  }
  const cluster = current();
  if (!act || !cluster) return;
  state.busy = true;
  const done = () => {
    state.busy = false;
  };
  if (act === 'merge') doMerge(cluster).finally(done);
  else if (act === 'distinct') doDistinct(cluster).finally(done);
  else {
    advance();
    done();
  }
}

async function loadCoverage(force = false) {
  if (state.coverage && !force) return;
  try {
    const res = await fetch('/api/curation/coverage');
    state.coverage = res.ok ? await res.json() : null;
  } catch {
    state.coverage = null;
  }
  buildCoverageDeck();
  render();
}

/**
 * The deck: events with something open, worst first — the order buildCoverage
 * already sorted them into.
 *
 * Rebuilt rather than mutated when a decision lands, because answering the last
 * gap on an event should take that event OUT of the queue, and the position has
 * to survive that: clamped to the end rather than reset, so deciding does not
 * bounce you back to the top of a 60-event deck.
 */
function buildCoverageDeck() {
  const cov = state.coverage;
  const onlyFixable = state.coverageFilter === 'fixable';
  state.clusters.coverage = cov
    ? cov.events.filter((e) => (onlyFixable ? e.fixable > 0 : e.openCount > 0))
    : [];
  const max = Math.max(0, state.clusters.coverage.length);
  if (state.idx.coverage > max) state.idx.coverage = max;
}

/** Ignore for ever, or snooze for a month. Recorded in the ledger, not the browser. */
async function decideCoverage(file, check, decision, { silent = false } = {}) {
  const body = { file, check, state: decision };
  if (decision === 'later') {
    const d = new Date();
    d.setDate(d.getDate() + 30);
    body.until = d.toISOString().slice(0, 10);
  }
  try {
    await fetch('/api/curation/coverage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    /* offline → the row stays; nothing was promised */
  }
  if (!silent) await loadCoverage(true);
}

/** Every open gap on this event, one decision. */
async function decideCoverageAll(ev, decision) {
  for (const c of ev.checks.filter((x) => x.open))
    // Sequential on purpose: each write is a read-modify-write of one ledger, and
    // firing them together would have them overwrite each other.
    await decideCoverage(ev.file, c.key, decision, { silent: true });
  await loadCoverage(true);
}

let opened = false;
export function openCurationStudio() {
  const studio = $('curationStudio');
  if (!studio) return;
  if (opened) {
    render();
    return;
  }
  opened = true;
  $('curStage')?.addEventListener('click', (e) => {
    const filter = e.target.closest('[data-covfilter]');
    if (filter) {
      state.coverageFilter = filter.dataset.covfilter;
      // A different filter is a different deck, so it starts at the top.
      state.idx.coverage = 0;
      buildCoverageDeck();
      return render();
    }
    const cov = e.target.closest('[data-cov]');
    if (cov) return decideCoverage(cov.dataset.file, cov.dataset.check, cov.dataset.cov);
    const covAll = e.target.closest('[data-act^="cov-"]');
    if (covAll) {
      const ev = current();
      if (!ev || state.busy) return;
      state.busy = true;
      const decision = covAll.dataset.act === 'cov-ignore-all' ? 'ignored' : 'later';
      return decideCoverageAll(ev, decision).finally(() => {
        state.busy = false;
      });
    }
    onStageClick(e);
  });
  $('curStage')?.addEventListener('input', (e) => {
    if (e.target.id === 'curCanonical') state.previewed = false;
    if (e.target.id === 'curLogFilter') {
      state.logFilter = e.target.value;
      renderLog();
    }
  });
  // Enter commits a remap, Escape abandons it — a one-field form should not need
  // the mouse to finish.
  $('curStage')?.addEventListener('keydown', (e) => {
    if (e.target.id !== 'curRemapInput') return;
    if (e.key === 'Enter')
      e.target.closest('.cur-log-remap')?.querySelector('[data-remap-save]')?.click();
    else if (e.key === 'Escape') {
      state.remapKey = null;
      renderLog();
    }
  });
  studio.querySelectorAll('.cur-seg-btn[data-kind]').forEach((b) =>
    b.addEventListener('click', () => {
      state.kind = b.dataset.kind;
      state.canonical = '';
      state.previewed = false;
      render();
      if (state.kind === 'coverage') loadCoverage();
    }),
  );
  $('curViewBtn')?.addEventListener('click', () => {
    state.view = state.view === 'overview' ? 'review' : 'overview';
    render();
  });
  // Keyboard is the point of this desk: you work a deck of cases one-handed.
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    // Coverage has its own verbs on the same fingers: i ignores, l waits, → skips.
    if (state.kind === 'coverage') {
      if (e.key === 'i' || e.key === 'I')
        document.querySelector('[data-act="cov-ignore-all"]')?.click();
      else if (e.key === 'l' || e.key === 'L')
        document.querySelector('[data-act="cov-later-all"]')?.click();
      else if (e.key === 'ArrowRight') document.querySelector('[data-act="skip"]')?.click();
      return;
    }
    if (e.key === 'm' || e.key === 'M') document.querySelector('[data-act="merge"]')?.click();
    else if (e.key === 'n' || e.key === 'N')
      document.querySelector('[data-act="distinct"]')?.click();
    else if (e.key === 'ArrowRight') document.querySelector('[data-act="skip"]')?.click();
  });

  $('curStage').innerHTML =
    '<div class="cur-done"><div class="cur-done-badge"></div><p>Scanning the archive…</p></div>';
  loadClusters()
    .then(render)
    .catch((err) => {
      $('curStage').innerHTML =
        `<div class="cur-done"><p>Couldn't load the archive: ${esc(err.message)}</p></div>`;
    });
}
