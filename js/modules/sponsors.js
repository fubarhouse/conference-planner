import state from './state.js';
import { loadEventCatalog } from './eventCatalog.js';
import { escapeHtml, parseSponsorIds, getFocusableElements, deriveOfficialWebsite, once } from './utils.js';

const SPONSOR_MODAL_ID = 'sponsorHistoryModal';
let lastFocusedElementBeforeSponsorModal = null;

function normalizeSponsors(eventMeta = null) {
  if (!Array.isArray(eventMeta?.sponsors)) return [];
  return eventMeta.sponsors
    .filter((sponsor) => sponsor && typeof sponsor === 'object')
    .map((sponsor, index) => {
      const row = Number.parseInt(String(sponsor.row ?? '').trim(), 10);
      const priority = Number.parseInt(String(sponsor.priority ?? '').trim(), 10);
      const enabled = sponsor.enabled !== false && String(sponsor.enabled || '').toLowerCase() !== 'false';
      return {
        id: String(sponsor.id || '').trim() || `sponsor-${index + 1}`,
        title: String(sponsor.title || '').trim() || 'Sponsor',
        subtitle: String(sponsor.subtitle || '').trim(),
        tier: String(sponsor.tier || '').trim() || 'Sponsors',
        row: Number.isFinite(row) ? row : 1,
        priority: Number.isFinite(priority) ? priority : 100,
        image: String(sponsor.image || '').trim(),
        imageAlt: String(sponsor.imageAlt || '').trim(),
        link: String(sponsor.link || '').trim(),
        bgStyle: String(sponsor.bgStyle || 'auto').trim() || 'auto',
        aspect: String(sponsor.aspect || 'auto').trim() || 'auto',
        enabled
      };
    })
    .filter((sponsor) => sponsor.enabled && sponsor.image);
}

function normalizeSponsorTitle(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
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
      const aliases = Array.isArray(entry.aliases) ? entry.aliases.map(normalizeSponsorTitle).filter(Boolean) : [];
      if (!canonical) continue;
      const group = new Set([canonical, ...aliases]);
      for (const key of group) map.set(key, group);
    }
    return map;
  } catch {
    return new Map();
  }
});

function ensureSponsorModal() {
  let modal = document.getElementById(SPONSOR_MODAL_ID);
  if (modal) return modal;

  modal = document.createElement('div');
  modal.id = SPONSOR_MODAL_ID;
  modal.className = 'session-modal-overlay hidden';
  modal.setAttribute('aria-hidden', 'true');
  modal.innerHTML = `
    <div class="session-modal-card" role="dialog" aria-modal="true" aria-labelledby="sponsorModalTitle">
      <div class="session-modal-header">
        <button id="sponsorModalBack" type="button" class="session-modal-back">
          <i class="fas fa-arrow-left"></i><span>Back to sponsors</span>
        </button>
        <button id="sponsorModalClose" type="button" class="session-modal-close" aria-label="Close sponsor history">
          <i class="fas fa-times"></i>
        </button>
      </div>
      <div class="session-modal-body" id="sponsorModalBody"></div>
    </div>
  `;
  document.body.appendChild(modal);

  const closeSponsorModal = () => {
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('session-modal-open');
    if (lastFocusedElementBeforeSponsorModal && document.contains(lastFocusedElementBeforeSponsorModal)) {
      lastFocusedElementBeforeSponsorModal.focus();
    }
    lastFocusedElementBeforeSponsorModal = null;
  };

  modal.addEventListener('click', (event) => {
    if (event.target === modal) closeSponsorModal();
  });
  modal.querySelector('#sponsorModalClose').addEventListener('click', closeSponsorModal);
  modal.querySelector('#sponsorModalBack').addEventListener('click', closeSponsorModal);
  modal.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeSponsorModal();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = getFocusableElements(modal);
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  });

  return modal;
}

function renderSponsorModalLoading(title) {
  const body = ensureSponsorModal().querySelector('#sponsorModalBody');
  body.innerHTML = `
    <div class="speaker-modal-head">
      <h2 id="sponsorModalTitle" class="session-modal-title">${escapeHtml(title)}</h2>
      <span class="speaker-modal-count-badge">...</span>
    </div>
    <p class="session-modal-meta">Loading sponsor history...</p>
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
        const eventLabel = [meta.designation, meta.year, meta.location].filter(Boolean).join(' ').trim() || file;
        const eventWebsite = deriveOfficialWebsite(meta);
        const eventYear = Number.parseInt(String(meta.year || '').trim(), 10);
        const eventEndTime = Date.parse(String(meta.endDate || '').trim());
        const eventStartTime = Date.parse(String(meta.startDate || '').trim());
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
              title: String(item?.title || '').trim() || 'Untitled session',
              link: String(item?.link || '').trim()
            }));
          entries.push({
            file,
            eventLabel,
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
            sponsorPriority: sponsor.priority
          });
        });
      } catch {
        // Ignore one-off dataset failures.
      }
    })
  );

  return entries;
});

function renderSponsorHistoryModalContent(currentSponsor, entries) {
  const body = ensureSponsorModal().querySelector('#sponsorModalBody');
  const sorted = [...entries].sort((a, b) => {
    const aTime = a.eventSortTime;
    const bTime = b.eventSortTime;
    if (aTime != null && bTime != null && aTime !== bTime) return bTime - aTime;
    if (aTime != null && bTime == null) return -1;
    if (aTime == null && bTime != null) return 1;
    if (a.eventYear != null && b.eventYear != null && a.eventYear !== b.eventYear) return b.eventYear - a.eventYear;
    return b.eventLabel.localeCompare(a.eventLabel);
  });
  const countLabel = sorted.length === 1 ? '1 event' : `${sorted.length} events`;
  const primaryActions = [];

  if (currentSponsor.link) {
    primaryActions.push(
      `<a class="session-modal-link" href="${escapeHtml(currentSponsor.link)}" target="_blank" rel="noopener noreferrer"><i class="fas fa-circle-info"></i><span>Sponsor information</span></a>`
    );
  }

  const cards = sorted
    .map((entry) => {
      const isCurrentEvent = entry.file === state.currentEventFile;
      const actions = [];
      if (entry.sponsorLink) {
        actions.push(
          `<a class="session-modal-link" href="${escapeHtml(entry.sponsorLink)}" target="_blank" rel="noopener noreferrer"><i class="fas fa-circle-info"></i><span>Sponsor information</span></a>`
        );
      }
      if (entry.eventWebsite) {
        actions.push(
          `<a class="session-modal-link" href="${escapeHtml(entry.eventWebsite)}" target="_blank" rel="noopener noreferrer"><i class="fas fa-calendar-alt"></i><span>Event website</span></a>`
        );
      }
      const logoSurface = entry.sponsorImage
        ? `
          <div class="sponsor-history-logo sponsor-bg-${escapeHtml(['transparent', 'light-plate', 'dark-plate', 'brand-fill'].includes(entry.sponsorBgStyle) ? entry.sponsorBgStyle : 'auto')} sponsor-aspect-${escapeHtml(['square', 'landscape', 'banner'].includes(entry.sponsorAspect) ? entry.sponsorAspect : 'auto')}">
            <img class="sponsor-logo-image" src="${escapeHtml(entry.sponsorImage)}" alt="${escapeHtml(entry.sponsorImageAlt || entry.sponsorTitle)}" loading="lazy" decoding="async">
          </div>
        `
        : '';
      return `
        <article class="speaker-session-card${isCurrentEvent ? ' speaker-session-card-current' : ''}">
          ${isCurrentEvent ? '<div class="speaker-session-current-badge">Current event</div>' : ''}
          <div class="sponsor-history-head">
            ${logoSurface}
            <div class="sponsor-history-copy">
              <h3 class="speaker-session-title">${escapeHtml(entry.eventLabel)}</h3>
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
                      .map((session) =>
                        `<li>${
                          session.link
                            ? `<a class="sponsor-history-session-link" href="${escapeHtml(session.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(session.title)}</a>`
                            : escapeHtml(session.title)
                        }</li>`
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

  body.innerHTML = `
    <div class="speaker-modal-head">
      <h2 id="sponsorModalTitle" class="session-modal-title">${escapeHtml(currentSponsor.title)}</h2>
      ${currentSponsor.subtitle ? `<p class="session-modal-subtitle">${escapeHtml(currentSponsor.subtitle)}</p>` : ''}
      <span class="speaker-modal-count-badge">${escapeHtml(countLabel)}</span>
    </div>
    <p class="session-modal-meta"><span class="session-modal-meta-label">History</span><span class="session-modal-meta-value">Sponsor records matched by title across all event datasets.</span></p>
    <div class="speaker-session-grid">${cards}</div>
  `;
}

async function openSponsorHistoryModal(sponsor) {
  const modal = ensureSponsorModal();
  lastFocusedElementBeforeSponsorModal = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('session-modal-open');
  renderSponsorModalLoading(sponsor.title);

  const [entries, aliasMap] = await Promise.all([loadAllSponsorHistory(), loadSponsorAliases()]);
  const titleKey = normalizeSponsorTitle(sponsor.title);
  const sponsorKeys = aliasMap.get(titleKey) ?? new Set([titleKey]);
  const matchingEntries = entries.filter((entry) => sponsorKeys.has(entry.sponsorTitleKey));
  renderSponsorHistoryModalContent(sponsor, matchingEntries);
  const closeButton = modal.querySelector('#sponsorModalClose');
  if (closeButton) closeButton.focus();
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
  surface.classList.add(`sponsor-bg-${['transparent', 'light-plate', 'dark-plate', 'brand-fill'].includes(sponsor.bgStyle) ? sponsor.bgStyle : 'auto'}`);
  surface.classList.add(`sponsor-aspect-${['square', 'landscape', 'banner'].includes(sponsor.aspect) ? sponsor.aspect : 'auto'}`);
  surface.setAttribute('aria-label', `View sponsor history for ${sponsor.title}`);

  const image = document.createElement('img');
  image.className = 'sponsor-logo-image';
  image.src = sponsor.image;
  image.alt = sponsor.imageAlt || sponsor.title;
  image.loading = 'lazy';
  image.decoding = 'async';
  surface.appendChild(image);

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

          const title = document.createElement('button');
          title.type = 'button';
          title.className = 'sponsor-card-title sponsor-modal-trigger';
          title.textContent = sponsor.subtitle || sponsor.title;
          title.setAttribute('aria-label', `View sponsor history for ${sponsor.title}`);
          title.addEventListener('click', () => {
            openSponsorHistoryModal(sponsor);
          });
          card.appendChild(title);

          row.appendChild(card);
        });

        section.appendChild(row);
      });

    content.appendChild(section);
  });

  container.classList.remove('hidden');
}
