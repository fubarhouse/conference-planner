import state from './state.js';
import { loadEventCatalog } from './eventCatalog.js';
import {
  escapeHtml,
  parseSponsorIds,
  deriveOfficialWebsite,
  once,
  slugify,
  normalizeString,
} from './utils.js';
import { sponsorBgClass, sponsorAspectClass } from './sponsorStyles.js';
import { openRail } from './rail.js';

// Normalize one raw sponsor entry to the canonical shape used by both the
// sponsor grid (sponsors.js) and the per-session sponsor lookup (render.js).
function normalizeSponsor(sponsor, index = 0) {
  const row = Number.parseInt(String(sponsor.row ?? '').trim(), 10);
  const priority = Number.parseInt(String(sponsor.priority ?? '').trim(), 10);
  return {
    id: normalizeString(sponsor.id, `sponsor-${index + 1}`),
    title: normalizeString(sponsor.title, 'Sponsor'),
    subtitle: normalizeString(sponsor.subtitle),
    tier: normalizeString(sponsor.tier, 'Sponsors'),
    row: Number.isFinite(row) ? row : 1,
    priority: Number.isFinite(priority) ? priority : 100,
    image: normalizeString(sponsor.image),
    imageAlt: normalizeString(sponsor.imageAlt),
    link: normalizeString(sponsor.link),
    bgStyle: normalizeString(sponsor.bgStyle, 'auto'),
    aspect: normalizeString(sponsor.aspect, 'auto'),
    enabled: sponsor.enabled !== false && String(sponsor.enabled || '').toLowerCase() !== 'false',
  };
}

export function normalizeSponsors(eventMeta = null) {
  if (!Array.isArray(eventMeta?.sponsors)) return [];
  // Break-glass toggle: when an event disables sponsor logo display, blank every
  // logo so the existing name-tile fallback (createSponsorLogoSurface) renders the
  // sponsor's name instead. Off by default.
  const hideLogos =
    eventMeta?.sponsorLogosDisabled === true ||
    String(eventMeta?.sponsorLogosDisabled || '').toLowerCase() === 'true';
  return (
    eventMeta.sponsors
      .filter((sponsor) => sponsor && typeof sponsor === 'object')
      .map((sponsor, index) => {
        const normalized = normalizeSponsor(sponsor, index);
        if (hideLogos) normalized.image = '';
        return normalized;
      })
      // Sponsors without a logo file are kept and rendered as a name tile (see
      // createSponsorLogoSurface) rather than dropped.
      .filter((sponsor) => sponsor.enabled)
  );
}

function normalizeSponsorTitle(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

const loadSponsorAliases = once(async () => {
  try {
    const response = await fetch('./data/sponsors.json');
    if (!response.ok) return new Map();
    const entries = await response.json();
    if (!Array.isArray(entries)) return new Map();
    const map = new Map();
    for (const entry of entries) {
      const canonical = normalizeSponsorTitle(entry.title);
      const aliases = Array.isArray(entry.aliases)
        ? entry.aliases.map(normalizeSponsorTitle).filter(Boolean)
        : [];
      if (!canonical) continue;
      const group = new Set([canonical, ...aliases]);
      for (const key of group) map.set(key, group);
    }
    return map;
  } catch {
    // Missing or malformed sponsors.json → no aliases (grid still renders).
    return new Map();
  }
});

function renderSponsorModalLoading(title) {
  const body = openRail(`Sponsor history: ${title}`);
  if (!body) return;
  body.innerHTML = `
    <div class="app-panel__head">
      <span class="app-panel__eyebrow">Sponsor history</span>
      <button type="button" class="app-panel__close" data-rail-close>Close</button>
    </div>`;
  body.innerHTML += `
    <div class="sponsor-modal-identity">
      <h2 id="sponsorModalTitle" class="session-modal-title">${escapeHtml(title)}</h2>
    </div>
    <p class="sponsor-modal-loading">Loading sponsor history…</p>
  `;
}

const loadAllSponsorHistory = once(async () => {
  const catalog = await loadEventCatalog();
  const files = [...new Set(catalog.map((item) => item.file).filter(Boolean))];
  const entries = [];

  await Promise.all(
    files.map(async (file) => {
      try {
        const response = await fetch(`./data/${file}`);
        if (!response.ok) return;
        const payload = await response.json();
        const meta = payload?.event || {};
        const sponsors = normalizeSponsors(meta);
        const items = Array.isArray(payload?.items) ? payload.items : [];
        const eventLabel =
          [meta.designation, meta.year, meta.location].filter(Boolean).join(' ').trim() || file;
        const eventWebsite = deriveOfficialWebsite(meta);
        const eventId = slugify(eventLabel) || slugify(file.replace(/\.json$/i, ''));
        const eventYear = Number.parseInt(normalizeString(meta.year), 10);
        const eventEndTime = Date.parse(normalizeString(meta.endDate));
        const eventStartTime = Date.parse(normalizeString(meta.startDate));
        const eventSortTime = Number.isFinite(eventEndTime)
          ? eventEndTime
          : Number.isFinite(eventStartTime)
            ? eventStartTime
            : Number.isFinite(eventYear)
              ? Date.UTC(eventYear, 11, 31, 23, 59, 59, 999)
              : null;
        sponsors.forEach((sponsor) => {
          const sponsoredSessions = items
            .filter((item) => parseSponsorIds(item?.sponsorIds).includes(sponsor.id))
            .map((item) => ({
              title: normalizeString(item?.title) || 'Untitled session',
              link: normalizeString(item?.link),
            }));
          entries.push({
            file,
            eventLabel,
            eventId,
            eventEnabled: meta.enabled !== false,
            eventWebsite,
            eventYear: Number.isFinite(eventYear) ? eventYear : null,
            eventEndTime: Number.isFinite(eventEndTime) ? eventEndTime : null,
            eventStartTime: Number.isFinite(eventStartTime) ? eventStartTime : null,
            eventSortTime,
            eventTier: sponsor.tier || 'Sponsors',
            sponsorTitle: sponsor.title,
            sponsorSubtitle: sponsor.subtitle,
            sponsorTitleKey: normalizeSponsorTitle(sponsor.title),
            sponsorLink: sponsor.link,
            sponsorImage: sponsor.image,
            sponsorImageAlt: sponsor.imageAlt,
            sponsorBgStyle: sponsor.bgStyle,
            sponsorAspect: sponsor.aspect,
            sponsoredSessions,
            sponsorRow: sponsor.row,
            sponsorPriority: sponsor.priority,
          });
        });
      } catch {
        // Ignore one-off dataset failures.
      }
    }),
  );

  // Deduplicate: when a sponsor appears in multiple tiers/rows within the same
  // event, merge those into one history entry so the modal shows one card per
  // event and the count badge reflects distinct events, not distinct entries.
  const deduped = new Map();
  for (const entry of entries) {
    const key = `${entry.file}\0${entry.sponsorTitleKey}`;
    if (!deduped.has(key)) {
      deduped.set(key, {
        ...entry,
        _tiers: [entry.eventTier],
        _subtitles: entry.sponsorSubtitle ? [entry.sponsorSubtitle] : [],
      });
    } else {
      const ex = deduped.get(key);
      // Promote display properties to the highest-tier (lowest row) appearance.
      if (
        entry.sponsorRow < ex.sponsorRow ||
        (entry.sponsorRow === ex.sponsorRow && entry.sponsorPriority < ex.sponsorPriority)
      ) {
        Object.assign(ex, {
          eventTier: entry.eventTier,
          sponsorImage: entry.sponsorImage,
          sponsorImageAlt: entry.sponsorImageAlt,
          sponsorBgStyle: entry.sponsorBgStyle,
          sponsorAspect: entry.sponsorAspect,
          sponsorLink: entry.sponsorLink,
          sponsorRow: entry.sponsorRow,
          sponsorPriority: entry.sponsorPriority,
        });
      }
      if (!ex._tiers.includes(entry.eventTier)) ex._tiers.push(entry.eventTier);
      if (entry.sponsorSubtitle && !ex._subtitles.includes(entry.sponsorSubtitle))
        ex._subtitles.push(entry.sponsorSubtitle);
      // Merge sponsored sessions without duplicates.
      const seen = new Set(ex.sponsoredSessions.map((s) => s.title));
      for (const session of entry.sponsoredSessions) {
        if (!seen.has(session.title)) {
          ex.sponsoredSessions.push(session);
          seen.add(session.title);
        }
      }
    }
  }

  return [...deduped.values()].map(({ _tiers, _subtitles, ...entry }) => ({
    ...entry,
    eventTier: _tiers.join(', '),
    sponsorSubtitle: _subtitles.length ? _subtitles.join('; ') : undefined,
  }));
});

function renderSponsorHistoryModalContent(currentSponsor, entries) {
  const body = document.querySelector('#railPanel .app-panel__body');
  if (!body) return;
  const sorted = [...entries].sort((a, b) => {
    const aTime = a.eventSortTime;
    const bTime = b.eventSortTime;
    if (aTime != null && bTime != null && aTime !== bTime) return bTime - aTime;
    if (aTime != null && bTime == null) return -1;
    if (aTime == null && bTime != null) return 1;
    if (a.eventYear != null && b.eventYear != null && a.eventYear !== b.eventYear)
      return b.eventYear - a.eventYear;
    return b.eventLabel.localeCompare(a.eventLabel);
  });
  const countLabel = sorted.length === 1 ? '1 event' : `${sorted.length} events`;
  const primaryActions = [];

  if (currentSponsor.link) {
    primaryActions.push(
      `<a class="session-modal-link" href="${escapeHtml(currentSponsor.link)}" target="_blank" rel="noopener noreferrer"><span>Sponsor information</span></a>`,
    );
  }

  const cards = sorted
    .map((entry) => {
      const isCurrentEvent = entry.file === state.currentEventFile;
      const actions = [];
      if (entry.sponsorLink) {
        actions.push(
          `<a class="session-modal-link" href="${escapeHtml(entry.sponsorLink)}" target="_blank" rel="noopener noreferrer"><span>Sponsor information</span></a>`,
        );
      }
      if (entry.eventWebsite) {
        actions.push(
          `<a class="session-modal-link" href="${escapeHtml(entry.eventWebsite)}" target="_blank" rel="noopener noreferrer"><span>Event website</span></a>`,
        );
      }
      const logoSurface = entry.sponsorImage
        ? `
          <div class="sponsor-history-logo ${sponsorBgClass(entry.sponsorBgStyle)} ${sponsorAspectClass(entry.sponsorAspect)}">
            <img class="sponsor-logo-image" src="${escapeHtml(entry.sponsorImage)}" alt="${escapeHtml(entry.sponsorImageAlt || entry.sponsorTitle)}" loading="lazy" decoding="async">
          </div>
        `
        : `
          <div class="sponsor-history-logo ${sponsorBgClass(entry.sponsorBgStyle)} sponsor-logo-surface-text">
            <span class="sponsor-logo-name">${escapeHtml(entry.sponsorTitle)}</span>
          </div>
        `;
      if (!isCurrentEvent && entry.eventId && entry.eventEnabled) {
        actions.push(
          `<a class="session-modal-link" href="${escapeHtml(`./index.html?id=${entry.eventId}`)}" target="_blank" rel="noopener noreferrer"><span>View schedule</span></a>`,
        );
      }
      return `
        <article class="speaker-session-card${isCurrentEvent ? ' speaker-session-card-current' : ''}">
          <div class="sponsor-history-head">
            ${logoSurface}
            <div class="sponsor-history-copy">
              <div class="sponsor-history-title-row">
                <h3 class="speaker-session-title">${escapeHtml(entry.eventLabel)}</h3>
                ${isCurrentEvent ? '<span class="speaker-session-current-badge"> Viewing now</span>' : ''}
              </div>
              ${entry.sponsorSubtitle ? `<p class="speaker-session-meta">${escapeHtml(entry.sponsorSubtitle)}</p>` : ''}
              <p class="speaker-session-meta"><strong>Tier:</strong> ${escapeHtml(entry.eventTier)}</p>
            </div>
          </div>
          ${
            entry.sponsoredSessions?.length
              ? `<div class="sponsor-history-session-list">
                  <p class="speaker-session-meta"><strong>Sponsored sessions:</strong></p>
                  <ul class="sponsor-history-session-items">
                    ${entry.sponsoredSessions
                      .map(
                        (session) =>
                          `<li>${
                            session.link
                              ? `<a class="sponsor-history-session-link" href="${escapeHtml(session.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(session.title)}</a>`
                              : escapeHtml(session.title)
                          }</li>`,
                      )
                      .join('')}
                  </ul>
                </div>`
              : ''
          }
          ${actions.length ? `<div class="sponsor-history-actions">${actions.join('')}</div>` : '<p class="speaker-session-summary">No sponsor URL stored for this event.</p>'}
        </article>
      `;
    })
    .join('');

  const panelHead = `
    <div class="app-panel__head">
      <span class="app-panel__eyebrow">Sponsor history</span>
      <button type="button" class="app-panel__close" data-rail-close>Close</button>
    </div>`;
  body.innerHTML =
    panelHead +
    `
    <div class="sponsor-modal-identity">
      <h2 id="sponsorModalTitle" class="session-modal-title">${escapeHtml(currentSponsor.title)}</h2>
      ${currentSponsor.subtitle ? `<p class="session-modal-subtitle">${escapeHtml(currentSponsor.subtitle)}</p>` : ''}
      <div class="sponsor-modal-meta-row">
        <span class="speaker-modal-count-badge">${escapeHtml(countLabel)}</span>
        ${primaryActions.join('')}
      </div>
    </div>
    <div class="speaker-session-grid">${cards}</div>
  `;
}

// Sponsor history renders into the shared rail (desktop) / sheet (mobile) —
// the same surface a session detail uses. It cannot be a pure-CSS <details>
// because the history is assembled asynchronously across every event.
async function openSponsorHistoryModal(sponsor) {
  renderSponsorModalLoading(sponsor.title);

  const [entries, aliasMap] = await Promise.all([loadAllSponsorHistory(), loadSponsorAliases()]);
  const titleKey = normalizeSponsorTitle(sponsor.title);
  const sponsorKeys = aliasMap.get(titleKey) ?? new Set([titleKey]);
  const matchingEntries = entries.filter((entry) => sponsorKeys.has(entry.sponsorTitleKey));
  renderSponsorHistoryModalContent(sponsor, matchingEntries);
}

function sortSponsors(sponsors = []) {
  return [...sponsors].sort((a, b) => {
    if (a.row !== b.row) return a.row - b.row;
    if (a.priority !== b.priority) return a.priority - b.priority;
    const tierCmp = a.tier.localeCompare(b.tier);
    if (tierCmp !== 0) return tierCmp;
    return a.title.localeCompare(b.title);
  });
}

function groupSponsorsByTier(sponsors = []) {
  const orderedSponsors = sortSponsors(sponsors);
  const groups = [];
  const groupMap = new Map();

  orderedSponsors.forEach((sponsor) => {
    const tierKey = sponsor.tier;
    if (!groupMap.has(tierKey)) {
      const group = { tier: sponsor.tier, sponsors: [] };
      groupMap.set(tierKey, group);
      groups.push(group);
    }
    groupMap.get(tierKey).sponsors.push(sponsor);
  });

  return groups;
}

function createSponsorLogoSurface(sponsor) {
  const surface = document.createElement('button');
  surface.type = 'button';
  surface.className = 'sponsor-logo-surface sponsor-modal-trigger';
  surface.classList.add(sponsorBgClass(sponsor.bgStyle));
  surface.classList.add(sponsorAspectClass(sponsor.aspect));
  surface.setAttribute('aria-label', `View sponsor history for ${sponsor.title}`);

  if (sponsor.image) {
    const image = document.createElement('img');
    image.className = 'sponsor-logo-image';
    image.src = sponsor.image;
    image.alt = sponsor.imageAlt || sponsor.title;
    image.loading = 'lazy';
    image.decoding = 'async';
    surface.appendChild(image);
  } else {
    // No logo file: fall back to a text tile — the sponsor name, with the
    // subtitle on a second line when one is present.
    surface.classList.add('sponsor-logo-surface-text');
    const name = document.createElement('span');
    name.className = 'sponsor-logo-name';
    name.textContent = sponsor.title;
    surface.appendChild(name);
    if (sponsor.subtitle) {
      const subtitle = document.createElement('span');
      subtitle.className = 'sponsor-logo-subtitle';
      subtitle.textContent = sponsor.subtitle;
      surface.appendChild(subtitle);
    }
  }

  return surface;
}

export function renderSponsors(eventMeta = null) {
  const container = document.getElementById('sponsorsContainer');
  const content = document.getElementById('sponsorsContent');
  if (!container || !content) return;

  const sponsors = normalizeSponsors(eventMeta);
  if (!sponsors.length) {
    content.innerHTML = '';
    container.classList.add('hidden');
    return;
  }

  const tierGroups = groupSponsorsByTier(sponsors);
  content.innerHTML = '';

  tierGroups.forEach((group) => {
    const section = document.createElement('section');
    section.className = 'sponsor-tier-section';

    const heading = document.createElement('h3');
    heading.className = 'sponsor-tier-heading';
    heading.textContent = group.tier;
    section.appendChild(heading);

    const rows = new Map();
    group.sponsors.forEach((sponsor) => {
      if (!rows.has(sponsor.row)) rows.set(sponsor.row, []);
      rows.get(sponsor.row).push(sponsor);
    });

    [...rows.entries()]
      .sort((a, b) => a[0] - b[0])
      .forEach(([rowNumber, rowSponsors]) => {
        const row = document.createElement('div');
        row.className = 'sponsor-logo-row';
        row.dataset.row = String(rowNumber);

        rowSponsors.forEach((sponsor) => {
          const card = document.createElement('article');
          card.className = 'sponsor-card';

          const surface = createSponsorLogoSurface(sponsor);
          surface.addEventListener('click', () => {
            openSponsorHistoryModal(sponsor);
          });
          card.appendChild(surface);

          // Logo sponsors get a name/subtitle caption under the mark; text-tile
          // sponsors already carry their name (and subtitle) inside the surface.
          if (sponsor.image) {
            const title = document.createElement('button');
            title.type = 'button';
            title.className = 'sponsor-card-title sponsor-modal-trigger';
            title.textContent = sponsor.subtitle || sponsor.title;
            title.setAttribute('aria-label', `View sponsor history for ${sponsor.title}`);
            title.addEventListener('click', () => {
              openSponsorHistoryModal(sponsor);
            });
            card.appendChild(title);
          }

          row.appendChild(card);
        });

        section.appendChild(row);
      });

    content.appendChild(section);
  });

  container.classList.remove('hidden');
}
