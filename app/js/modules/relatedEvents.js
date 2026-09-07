// Related-events block — "partners", "linked conferences", "co-located" events shown
// on the schedule page, grouped by their relationship. A malleable sibling of the
// sponsor grid (sponsors.js): the data lives on event.relatedEvents, each entry links
// to another dataset's schedule (internal, ?id=<slug>) or an external website, with a
// logo that degrades to a name tile. Descriptions are stored but intentionally NOT
// rendered on the frontend yet.

import { escapeHtml, normalizeString, slugify } from './utils.js';
import { sponsorBgClass, sponsorAspectClass } from './sponsorStyles.js';

// Normalize one raw related-event entry to the canonical shape.
function normalizeRelatedEvent(entry, index = 0) {
  const priority = Number.parseInt(String(entry.priority ?? '').trim(), 10);
  const name = normalizeString(entry.name, 'Related event');
  return {
    id: normalizeString(entry.id, slugify(name) || `related-${index + 1}`),
    name,
    relationship: normalizeString(entry.relationship, 'Related'),
    scheduleId: normalizeString(entry.scheduleId),
    website: normalizeString(entry.website),
    image: normalizeString(entry.image),
    imageAlt: normalizeString(entry.imageAlt),
    // Stored + editable, but never emitted by the renderer (hidden on the frontend).
    description: normalizeString(entry.description),
    priority: Number.isFinite(priority) ? priority : 100,
    featured: entry.featured === true || String(entry.featured || '').toLowerCase() === 'true',
    enabled: entry.enabled !== false && String(entry.enabled || '').toLowerCase() !== 'false',
  };
}

export function normalizeRelatedEvents(eventMeta = null) {
  if (!Array.isArray(eventMeta?.relatedEvents)) return [];
  return eventMeta.relatedEvents
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry, index) => normalizeRelatedEvent(entry, index))
    .filter((entry) => entry.enabled);
}

// An internal schedule link (?id=<slug>) takes precedence over an external website.
// Returns null when the entry links nowhere.
export function resolveRelatedLink(entry) {
  if (entry.scheduleId)
    return { href: `./index.html?id=${encodeURIComponent(entry.scheduleId)}`, external: false };
  if (entry.website) return { href: entry.website, external: true };
  return null;
}

// Group by relationship. Groups order by their smallest priority then first-seen;
// entries within a group by priority then name. Mirrors sponsors' groupSponsorsByTier.
export function groupByRelationship(entries = []) {
  const groups = [];
  const byKey = new Map();
  entries.forEach((entry) => {
    if (!byKey.has(entry.relationship)) {
      const group = { relationship: entry.relationship, entries: [], order: entry.priority };
      byKey.set(entry.relationship, group);
      groups.push(group);
    }
    const group = byKey.get(entry.relationship);
    group.entries.push(entry);
    group.order = Math.min(group.order, entry.priority);
  });
  groups.forEach((group) =>
    group.entries.sort(
      (a, b) =>
        Number(b.featured) - Number(a.featured) || // featured promotions lead their group
        a.priority - b.priority ||
        a.name.localeCompare(b.name),
    ),
  );
  return groups.sort((a, b) => a.order - b.order || a.relationship.localeCompare(b.relationship));
}

// The icon font is gone; the arrow is a text glyph so no sprite is needed for
// a decoration this small. `icon` is retained in the signature only to keep the
// call sites meaningful until the shared icon() helper lands.
function ctaHtml(href, label, _icon, { external = false, ghost = false } = {}) {
  const attrs = external ? ' target="_blank" rel="noopener noreferrer"' : '';
  const glyph = external ? '↗' : '→';
  return `<a class="related-cta${ghost ? ' related-cta-ghost' : ''}" href="${escapeHtml(
    href,
  )}"${attrs}>${label} <span aria-hidden="true">${glyph}</span></a>`;
}

function relatedCardHtml(entry) {
  const logo = entry.image
    ? `<span class="related-logo ${sponsorBgClass('auto')} ${sponsorAspectClass('auto')}"><img class="related-logo-img" src="${escapeHtml(
        entry.image,
      )}" alt="${escapeHtml(entry.imageAlt || entry.name)}" loading="lazy" decoding="async"></span>`
    : `<span class="related-logo related-logo-text"><span class="related-logo-name">${escapeHtml(
        entry.name,
      )}</span></span>`;
  // Both targets can coexist: the internal schedule is the primary action, the
  // website a secondary "Visit site" — so a partner's own site is always reachable.
  const actions = [];
  if (entry.scheduleId)
    actions.push(
      ctaHtml(
        `./index.html?id=${encodeURIComponent(entry.scheduleId)}`,
        'View schedule',
        'fa-arrow-right-long',
      ),
    );
  if (entry.website)
    actions.push(
      ctaHtml(entry.website, 'Visit site', 'fa-arrow-up-right-from-square', {
        external: true,
        ghost: entry.scheduleId ? true : false,
      }),
    );
  const cardActions = actions.length
    ? `<span class="related-card-actions">${actions.join('')}</span>`
    : '';
  const inner = `${logo}<span class="related-card-body"><span class="related-card-name">${escapeHtml(
    entry.name,
  )}</span>${cardActions}</span>`;
  const cls = `related-card${entry.featured ? ' related-card--featured' : ''}`;
  return `<div class="${cls}">${inner}</div>`;
}

export function renderRelatedEvents(eventMeta = null) {
  const container = document.getElementById('relatedEventsContainer');
  const content = document.getElementById('relatedEventsContent');
  const headingWrap = document.getElementById('relatedEventsHeadingWrap');
  const headingEl = document.getElementById('relatedEventsHeading');
  if (!container || !content) return;

  const entries = normalizeRelatedEvents(eventMeta);
  if (!entries.length) {
    content.innerHTML = '';
    container.classList.add('hidden');
    return;
  }

  // Optional umbrella heading — shown only when the dataset sets one.
  const heading = normalizeString(eventMeta?.relatedEventsHeading);
  if (headingWrap && headingEl) {
    headingEl.textContent = heading;
    headingWrap.classList.toggle('hidden', !heading);
  }

  content.innerHTML = groupByRelationship(entries)
    .map(
      (group) => `
      <section class="related-group">
        <h3 class="related-group-heading u-label">${escapeHtml(group.relationship)}</h3>
        <div class="related-card-row">${group.entries.map(relatedCardHtml).join('')}</div>
      </section>`,
    )
    .join('');
  container.classList.remove('hidden');
}
