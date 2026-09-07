// @ts-check
/**
 * Stacked-bar trends: one bar per year, split by country or by series.
 *
 * The archive's other year chart answers "how big was the archive that year".
 * This one answers "who made it that big" — which is a different question, and
 * the only one that shows a community arriving, peaking and going quiet against
 * everybody else's.
 *
 * ⚠ THE TAIL IS THE POINT, so no key is ever folded into an "Other" bucket.
 * Thirty-nine countries is a crowded legend and eight of them have a single
 * event each; those eight are exactly the rows a reader is looking for when
 * they ask which communities only ever managed one camp. Grouping them away
 * would answer the easy question and delete the interesting one.
 *
 * Kept apart from archiveDashboard.js on purpose: the topic chart deliberately
 * stopped being stacked bars (a stacked bar sits on top of the reader's own
 * annotation marks on that axis), and this module must not drag that idiom back
 * into that file.
 */

/** @typedef {{year:number, key:string}} StackRow */
/** @typedef {{key:string, n:number, i:number}} Seg */
/** @typedef {{year:number, total:number, segs:Seg[]}} StackYear */
/** @typedef {{key:string, total:number, i:number}} StackKey */
/** @typedef {{years:StackYear[], keys:StackKey[], max:number, total:number}} StackModel */

/**
 * Aggregate rows into per-year stacks.
 *
 * Segment order is the GLOBAL key order, not each year's own — a country has to
 * sit at the same height in every bar or the eye cannot follow it across the
 * chart.
 *
 * @param {StackRow[]} rows
 * @param {{y0:number, y1:number}} bounds
 * @returns {StackModel}
 */
export function stackByYear(rows, { y0, y1 }) {
  /** @type {Map<string, number>} */
  const keyTotals = new Map();
  /** @type {Map<number, Map<string, number>>} */
  const byYear = new Map();

  for (const r of rows) {
    const year = Number(r.year);
    // Undated events cannot sit on a year axis. They are dropped here rather
    // than bucketed into a fake year, and the caller reports the shortfall.
    if (!Number.isFinite(year) || year < y0 || year > y1) continue;
    const key = r.key || 'Unknown';
    keyTotals.set(key, (keyTotals.get(key) || 0) + 1);
    let m = byYear.get(year);
    if (!m) byYear.set(year, (m = new Map()));
    m.set(key, (m.get(key) || 0) + 1);
  }

  // Biggest first, ties by name so the order — and therefore every colour — is
  // stable between renders of the same scope.
  const keys = [...keyTotals.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, total], i) => ({ key, total, i }));

  /** @type {StackYear[]} */
  const years = [];
  let max = 0;
  let total = 0;
  for (let y = y0; y <= y1; y++) {
    const m = byYear.get(y);
    /** @type {Seg[]} */
    const segs = [];
    let t = 0;
    if (m) {
      for (const { key, i } of keys) {
        const n = m.get(key) || 0;
        if (!n) continue;
        segs.push({ key, n, i });
        t += n;
      }
    }
    if (t > max) max = t;
    total += t;
    years.push({ year: y, total: t, segs });
  }
  return { years, keys, max, total };
}

/**
 * A stable, well-separated colour per key index.
 *
 * Golden-angle hue rotation, so neighbouring stack segments never land on
 * neighbouring hues however many keys there are. Saturation and lightness are
 * fixed so the ramp reads as one family rather than a rainbow, and the mid
 * lightness keeps every segment legible on both the light and dark panel.
 *
 * @param {number} i
 * @returns {string}
 */
export function stackColor(i) {
  const hue = Math.round((i * 137.508) % 360);
  // Alternating lightness gives adjacent indices a second axis of difference,
  // which matters where a long tail of 1-event keys stacks into a thin band.
  const light = i % 2 ? 46 : 58;
  return `hsl(${hue} 52% ${light}%)`;
}

/**
 * A sensible y-axis step, so the gridlines land on round numbers.
 *
 * @param {number} max
 * @returns {number}
 */
export function axisStep(max) {
  for (const s of [1, 2, 5, 10, 20, 25, 50, 100]) if (max / s <= 6) return s;
  return Math.ceil(max / 6 / 100) * 100;
}

/** @type {Record<string, string>} */
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/**
 * @param {string|number} s
 * @returns {string}
 */
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ESC[c]);
}

/**
 * The first year whose events are still to come.
 *
 * ⚠ THE NEWEST YEAR IS ALWAYS UNDER-COUNTED, and nothing on the chart said so.
 * Four events in the archive have not happened yet, and a part-published
 * programme has a normal-looking session count with a depressed speaker count —
 * because breaks, summits and the exhibition are published first and speaker
 * assignments land last. Reading the last column as a decline is the mistake
 * this marking exists to prevent.
 *
 * @param {Date} [now]
 * @returns {number}
 */
export function provisionalFrom(now) {
  return (now || new Date()).getUTCFullYear();
}

/**
 * Render the model as an SVG stacked-bar chart.
 *
 * The SVG is sized by viewBox and scales to its container, so the same markup
 * serves the panel and the maximised view — a screenshot at full screen is the
 * same drawing, not a re-layout.
 *
 * @param {StackModel} model
 * @param {{facet?:string, unit?:string, now?:Date}} [opts]
 * @returns {string}
 */
export function stackedChartSvg(model, { facet = '', unit = 'event', now } = {}) {
  const { years, max } = model;
  const prov = provisionalFrom(now);
  if (!max) return '<p class="obs-topic-empty">No events in scope.</p>';

  const W = 1000;
  const H = 340;
  const padL = 46;
  const padR = 12;
  const padT = 14;
  const padB = 34;
  const pw = W - padL - padR;
  const ph = H - padT - padB;
  const step = axisStep(max);
  const top = Math.ceil(max / step) * step;
  const bw = Math.max(6, (pw / years.length) * 0.66);
  /** @param {number} i */
  const X = (i) => padL + (i + 0.5) * (pw / years.length);
  /** @param {number} v */
  const Y = (v) => padT + ph - (v / top) * ph;

  let g = '';
  for (let v = 0; v <= top; v += step) {
    g +=
      `<line class="obs-stk-grid" x1="${padL}" y1="${Y(v).toFixed(1)}" x2="${W - padR}" y2="${Y(v).toFixed(1)}"/>` +
      `<text class="obs-stk-ytick" x="${padL - 6}" y="${(Y(v) + 3.5).toFixed(1)}" text-anchor="end">${v}</text>`;
  }

  let bars = '';
  years.forEach((yr, i) => {
    const x = (X(i) - bw / 2).toFixed(1);
    // Every year gets a label; 20 of them at this width do not collide.
    bars += `<text class="obs-stk-xtick" x="${X(i).toFixed(1)}" y="${H - padB + 15}" text-anchor="middle">'${String(yr.year).slice(2)}</text>`;
    if (!yr.total) return;
    let acc = 0;
    for (const s of yr.segs) {
      const y1 = Y(acc);
      acc += s.n;
      const y0 = Y(acc);
      const h = Math.max(1, y1 - y0);
      const t =
        `${yr.year} · ${s.key} · ${s.n} ${unit}${s.n === 1 ? '' : 's'}` +
        (yr.year >= prov ? ' · year still in progress' : '');
      bars +=
        `<rect class="obs-stk-seg" x="${x}" y="${y0.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}"` +
        ` fill="${stackColor(s.i)}" data-key="${esc(s.key)}"` +
        (facet ? ` data-facet="${esc(facet)}" role="button" tabindex="0"` : '') +
        `><title>${esc(t)}</title></rect>`;
    }
    bars += `<text class="obs-stk-total" x="${X(i).toFixed(1)}" y="${(Y(yr.total) - 4).toFixed(1)}" text-anchor="middle">${yr.total}</text>`;
  });

  // A hatched wash over every year that is not finished, plus a word for it —
  // a shade with no label is just an unexplained colour.
  let prole = '';
  const pi = years.findIndex((y) => y.year >= prov);
  if (pi >= 0) {
    const x0 = padL + pi * (pw / years.length);
    prole =
      `<rect class="obs-stk-prov" x="${x0.toFixed(1)}" y="${padT}" width="${(W - padR - x0).toFixed(1)}" height="${ph}"/>` +
      `<text class="obs-stk-provl" x="${(x0 + 4).toFixed(1)}" y="${padT + 11}">in progress</text>`;
  }

  return (
    `<svg class="obs-stk" viewBox="0 0 ${W} ${H}" role="img" preserveAspectRatio="xMidYMid meet">` +
    `<defs><pattern id="obsStkHatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
    `<line x1="0" y1="0" x2="0" y2="6" stroke="currentColor" stroke-width="1" opacity="0.25"/></pattern></defs>` +
    `<g class="obs-stk-axis">${g}</g>${prole}${bars}</svg>`
  );
}

/**
 * Hovering or focusing a legend chip picks that key out of every bar.
 *
 * With a long tail of one-event keys the segments get thin, and a thin band in
 * a twenty-bar chart is impossible to follow by colour alone — this is what
 * makes the tail readable rather than merely present.
 *
 * Delegated from the panel, so it survives a re-render of the panel's contents.
 *
 * @param {Element|null} panel
 */
export function wireStacks(panel) {
  // ⚠ TAKES THE PANEL ITSELF, not a container to search. The stacked chart is a
  // view of the shared chart panel, which carries no marker class of its own —
  // an earlier version looked for `.obs-panel--stk` underneath and therefore
  // silently wired nothing at all.
  if (!panel || typeof panel.querySelectorAll !== 'function') return;
  if (!panel.querySelector('.obs-stk-seg')) return;
  if (/** @type {any} */ (panel)._stkWired) return;
  /** @type {any} */ (panel)._stkWired = true;
  // The listeners live on the panel, which outlives each re-render of its
  // contents, and they resolve their targets at event time.
  /** @param {Event} e */
  const on = (e) => {
    const chip = /** @type {Element} */ (e.target)?.closest?.('.obs-stk-key');
    const key = chip?.getAttribute('data-key') || null;
    for (const seg of Array.from(panel.querySelectorAll('.obs-stk-seg')))
      seg.classList.toggle('is-dim', !!key && seg.getAttribute('data-key') !== key);
  };
  const off = () => {
    for (const seg of Array.from(panel.querySelectorAll('.obs-stk-seg')))
      seg.classList.remove('is-dim');
  };
  panel.addEventListener('pointerover', on);
  panel.addEventListener('focusin', on);
  panel.addEventListener('pointerleave', off);
  panel.addEventListener('focusout', off);
}

/**
 * The legend: every key, biggest first, with its total.
 *
 * @param {StackModel} model
 * @param {{facet?:string, unit?:string}} [opts]
 * @returns {string}
 */
export function stackedLegend(model, { facet = '', unit = 'event' } = {}) {
  return `<div class="obs-stk-legend">${model.keys
    .map(
      (k) =>
        `<button type="button" class="obs-stk-key" data-key="${esc(k.key)}"${facet ? ` data-facet="${esc(facet)}"` : ''}` +
        ` title="${esc(`${k.key} — ${k.total} ${unit}${k.total === 1 ? '' : 's'}`)}">` +
        `<i style="background:${stackColor(k.i)}"></i>` +
        `<span class="obs-stk-key-l">${esc(k.key)}</span>` +
        `<span class="obs-stk-key-n">${k.total}</span></button>`,
    )
    .join('')}</div>`;
}
