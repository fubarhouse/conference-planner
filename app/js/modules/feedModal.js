// The calendar-feed diff modal: what upstream publishes, against what we hold.
//
// The whole reason this exists rather than a "sync" button is that an import
// rewrites a dataset nobody reviewed field by field. Showing the diff first, in
// full, is what turns that from something you hope went well into something you
// agreed to. It is deliberately all-or-nothing: per-row cherry-picking would
// mean the archive ends up in a state neither the feed nor the editor chose,
// and no later run could tell the difference between "we rejected that" and
// "that has not been imported yet".
//
// Presentation only. The rules about what an import does live in feedDiff.js,
// and the reconciliation itself is Go — the same code the weekly cron runs.

import { canImport, checkMessage, diffSummary, importedMessage } from './feedDiff.js';

/** @type {{ escapeHtml: (s: string) => string, escapeAttr: (s: string) => string, onImported?: (result: any) => void, isDirty?: () => boolean }} */
let deps;

/** @param {typeof deps} injected */
export function initFeedModal(injected) {
  deps = injected;
}

const ROOT_ID = 'feedDiffModal';

/** The overlay, created once and reused. */
function root() {
  let el = document.getElementById(ROOT_ID);
  if (el) return el;
  el = document.createElement('div');
  el.id = ROOT_ID;
  el.className = 'session-modal-overlay hidden';
  el.setAttribute('aria-hidden', 'true');
  document.body.appendChild(el);
  return el;
}

export function closeFeedModal() {
  const el = document.getElementById(ROOT_ID);
  if (!el) return;
  el.classList.add('hidden');
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '';
}

function open(html) {
  const el = root();
  el.innerHTML = html;
  el.classList.remove('hidden');
  el.setAttribute('aria-hidden', 'false');
  el.querySelectorAll('[data-feed-close]').forEach((btn) => {
    btn.addEventListener('click', closeFeedModal);
  });
  // Clicking the backdrop closes; clicking the card must not.
  el.addEventListener('click', (event) => {
    if (event.target === el) closeFeedModal();
  });
  return el;
}

/** A row's from → to, when it has one. */
function change(row, escapeHtml) {
  if (row.from === undefined && row.to === undefined) return '';
  return `<span class="fd-move">
    <span class="fd-was">${escapeHtml(row.from ?? '—')}</span>
    <span class="fd-arrow" aria-hidden="true">→</span>
    <span class="fd-now">${escapeHtml(row.to ?? '—')}</span>
  </span>`;
}

function renderSection(section) {
  const { escapeHtml } = deps;
  // Long lists are capped in the DOM, not truncated in meaning: the count in
  // the heading is always the real one.
  const CAP = 60;
  const shown = section.rows.slice(0, CAP);
  const rest = section.rows.length - shown.length;
  return `
    <section class="fd-section fd-section--${section.kind}">
      <header class="fd-section__head">
        <h4 class="fd-section__title">${escapeHtml(section.title)}</h4>
        <span class="src-tag${section.applied ? ' src-tag--warn' : ' src-tag--dash'}">
          ${section.rows.length}${section.applied ? '' : ' held'}
        </span>
      </header>
      <p class="fd-section__note">${escapeHtml(section.note)}</p>
      <ul class="fd-rows">
        ${shown
          .map(
            (row) => `
          <li class="fd-row">
            <span class="fd-row__title">${escapeHtml(row.title || '(untitled)')}</span>
            ${change(row, escapeHtml)}
            ${row.detail ? `<span class="fd-row__detail">${escapeHtml(row.detail)}</span>` : ''}
          </li>`,
          )
          .join('')}
      </ul>
      ${rest > 0 ? `<p class="fd-section__more">and ${rest} more</p>` : ''}
    </section>
  `;
}

/**
 * Show the result of a check.
 *
 * @param {any} result the server's response
 * @param {{ file: string, mirror: boolean, onImport: () => Promise<void> }} context
 */
export function showFeedDiff(result, context) {
  const { escapeHtml } = deps;
  const message = checkMessage(result, { mirror: context.mirror });
  const { sections, changing, held } = diffSummary(result.report, { mirror: context.mirror });
  const importable = canImport(result, { mirror: context.mirror });
  const dirty = deps.isDirty?.() ?? false;

  const el = open(`
    <div class="fd-card" role="dialog" aria-modal="true" aria-labelledby="fdTitle">
      <header class="fd-head">
        <div>
          <p class="edt-eyebrow">Calendar feed</p>
          <h3 class="fd-title" id="fdTitle">${escapeHtml(message.headline)}</h3>
          <p class="fd-detail">${escapeHtml(message.detail)}</p>
        </div>
        <button type="button" class="src-btn src-btn--drop" data-feed-close
          aria-label="Close"><span aria-hidden="true">&times;</span></button>
      </header>

      ${
        result.feedUrl
          ? `<p class="fd-source"><span class="src-sub">read from</span>
               <a class="src-url" href="${deps.escapeAttr(result.feedUrl)}" target="_blank"
                  rel="noopener noreferrer">${escapeHtml(result.feedUrl)}</a></p>`
          : ''
      }

      <div class="fd-body">
        ${
          sections.length
            ? sections.map(renderSection).join('')
            : `<p class="src-empty">Nothing differs. The archive already matches the feed.</p>`
        }
      </div>

      <footer class="fd-foot">
        <div class="fd-foot__say">
          ${
            importable
              ? `<strong>${changing}</strong> change${changing === 1 ? '' : 's'} will be written to this dataset${
                  held ? `, and <strong>${held}</strong> left for you` : ''
                }. It is all or nothing.`
              : 'There is nothing here to import.'
          }
          ${
            dirty && importable
              ? `<span class="fd-warn">You have unsaved edits open. Importing writes the file underneath them — save or discard first.</span>`
              : ''
          }
        </div>
        <div class="fd-foot__act">
          <button type="button" class="src-btn" data-feed-close>Cancel</button>
          <button type="button" class="src-btn src-btn--go" id="feedImport"
            ${importable ? '' : 'disabled'}>Import all</button>
        </div>
      </footer>
    </div>
  `);

  el.querySelector('#feedImport')?.addEventListener('click', async () => {
    const button = /** @type {HTMLButtonElement} */ (el.querySelector('#feedImport'));
    button.disabled = true;
    button.textContent = 'Importing…';
    try {
      await context.onImport();
    } finally {
      button.disabled = false;
      button.textContent = 'Import all';
    }
  });
}

/**
 * The receipt, shown where the diff was.
 *
 * Same frame on purpose: the numbers land in the place the person was just
 * reading them as predictions, so the claim and the outcome are visibly the
 * same shape. It borrows the register's stat tiles rather than inventing a
 * success style, because a count is a count wherever it appears.
 *
 * @param {any} result the import response
 * @param {{ mirror?: boolean }} [options]
 */
export function showFeedImported(result, options = {}) {
  const { escapeHtml, escapeAttr } = deps;
  const { headline, counts, detail, held } = importedMessage(result, options);

  open(`
    <div class="fd-card fd-card--slim fd-card--done" role="dialog" aria-modal="true"
      aria-labelledby="fdTitle">
      <header class="fd-head">
        <div>
          <p class="edt-eyebrow">Calendar feed</p>
          <h3 class="fd-title" id="fdTitle">${escapeHtml(headline)}</h3>
          <p class="fd-detail">${escapeHtml(detail)}</p>
        </div>
        <button type="button" class="src-btn src-btn--drop" data-feed-close
          aria-label="Close"><span aria-hidden="true">&times;</span></button>
      </header>

      <div class="src-overview fd-receipt">
        ${counts
          .map(
            (count) => `
          <div class="src-stat${count.tone ? ` src-stat--${count.tone}` : ''}">
            <span class="src-stat__value">${count.value}</span>
            <span class="src-stat__label">${escapeHtml(count.label)}</span>
          </div>`,
          )
          .join('')}
        ${
          held
            ? `<div class="src-stat">
                 <span class="src-stat__value">${held}</span>
                 <span class="src-stat__label">left for you</span>
               </div>`
            : ''
        }
      </div>

      ${
        result.feedUrl
          ? `<p class="fd-source"><span class="src-sub">read from</span>
               <a class="src-url" href="${escapeAttr(result.feedUrl)}" target="_blank"
                  rel="noopener noreferrer">${escapeHtml(result.feedUrl)}</a></p>`
          : ''
      }

      <footer class="fd-foot fd-foot--end">
        <span class="src-sub fd-saved">saved to the archive</span>
        <button type="button" class="src-btn src-btn--go" data-feed-close>Done</button>
      </footer>
    </div>
  `);
}

/** A plain message in the same frame — used while checking, and for failures. */
export function showFeedMessage(headline, detail, tone = 'hold') {
  const { escapeHtml } = deps;
  open(`
    <div class="fd-card fd-card--slim" role="dialog" aria-modal="true" aria-labelledby="fdTitle">
      <header class="fd-head">
        <div>
          <p class="edt-eyebrow">Calendar feed</p>
          <h3 class="fd-title fd-title--${tone}" id="fdTitle">${escapeHtml(headline)}</h3>
          <p class="fd-detail">${escapeHtml(detail)}</p>
        </div>
        <button type="button" class="src-btn src-btn--drop" data-feed-close
          aria-label="Close"><span aria-hidden="true">&times;</span></button>
      </header>
      <footer class="fd-foot fd-foot--end">
        <button type="button" class="src-btn" data-feed-close>Close</button>
      </footer>
    </div>
  `);
}
