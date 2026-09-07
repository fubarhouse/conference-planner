export function getLocalDate(utcDateString, timezone) {
  const date = new Date(utcDateString);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function formatDuration(event, duration) {
  void event;
  const hoursMatch = duration.match(/(\d+)H/);
  const minutesMatch = duration.match(/(\d+)M/);
  const hours = hoursMatch ? parseInt(hoursMatch[1], 10) : 0;
  const minutes = minutesMatch ? parseInt(minutesMatch[1], 10) : 0;

  if (hours === 0) {
    return `${minutes}m`;
  }
  if (minutes === 0) {
    return `${hours}h`;
  }
  if (minutes === 30) {
    return `${hours}.5h`;
  }
  return `${hours}h${minutes}m`;
}

export function highlightKeywords(text, keywords) {
  if (!keywords || keywords.trim() === '') {
    return text;
  }
  const escapedKeywords = keywords.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${escapedKeywords})`, 'gi');
  return text.replace(regex, '<span class="keyword-highlight">$1</span>');
}

export function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

export function formatDateForICS(dateString) {
  return dateString.replace(/[-:]/g, '').replace(/\.\d+/, '');
}

export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Trim a value to a clean string, falling back when it is empty/blank. Replaces
// the ~120 hand-copied `String(x || '').trim()` (and `... || 'default'`) sites.
export function normalizeString(value, fallback = '') {
  return String(value || '').trim() || fallback;
}

// The two input shapes mean different things, and conflating them corrupted
// track names across 35 datasets.
//
// A STRING is a list that has not been separated yet — "DevOps, Frontend,
// Backend" — so every comma in it is a separator.
//
// An ARRAY has ALREADY been separated: each element is one track. A track name
// may legitimately contain a comma, and many do — "Frontend (HTML, CSS, JS)",
// "Accessibility, Frontend & UX Design", "leadership, management & business",
// "Government, Nonprofit, and Education" are single tracks in their own events'
// taxonomies. Re-splitting them invented a phantom "Accessibility" track and
// truncated the real one.
//
// The one exception inside an array is the scrape artefact " , ": a multi-value
// field flattened with spaces AROUND the separator ("Back-end , Case study ,
// Data"). The space before the comma is the tell, and it is reliable — no genuine
// track name in the archive puts one there.
const TRACK_LIST = /\s*,\s*/;
const TRACK_ARTEFACT = /\s+,\s*/;

export function normalizeTracks(trackValue) {
  const split = (value, pattern) =>
    String(value || '')
      .split(pattern)
      .map((track) => track.trim())
      .filter(Boolean);

  if (Array.isArray(trackValue)) {
    return [...new Set(trackValue.flatMap((track) => split(track, TRACK_ARTEFACT)))];
  }
  return split(trackValue, TRACK_LIST);
}

export function announceStatus(message) {
  const region = document.getElementById('ariaStatus');
  if (!region) return;

  region.textContent = '';
  window.setTimeout(() => {
    region.textContent = String(message || '');
  }, 20);
}

export function normalizeSummaryText(value) {
  const lines = String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n');

  const isTableDelimiter = (line) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);

  const isTableRow = (line) => {
    const trimmed = normalizeString(line);
    if (!trimmed || !trimmed.includes('|') || isTableDelimiter(trimmed)) return false;
    let cells = trimmed.split('|').map((cell) => cell.trim());
    if (cells.length > 0 && cells[0] === '') cells = cells.slice(1);
    if (cells.length > 0 && cells[cells.length - 1] === '') cells = cells.slice(0, -1);
    return cells.length >= 2;
  };

  const filtered = lines.filter((rawLine) => {
    const line = normalizeString(rawLine);
    if (!line) return false;
    if (/^\s*#{1,6}\s+/.test(line)) return false;
    if (/^\s*>\s?/.test(line)) return false;
    if (isTableDelimiter(line) || isTableRow(line)) return false;
    return true;
  });

  return filtered.join(' ').replace(/\s+/g, ' ').trim();
}

export function buildSummaryFromText(value, maxLen = 128) {
  const source = normalizeSummaryText(value);
  if (!source) return '';
  const truncated = source.slice(0, maxLen).trim();
  if (!truncated) return '';
  return truncated.endsWith('...') ? truncated : `${truncated}...`;
}

export function deriveSummaryFromEvent(event, maxLen = 128) {
  return buildSummaryFromText(event?.full_description || '', maxLen);
}

export function isLocalhost() {
  const host = String(window.location.hostname || '').toLowerCase();
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]' ||
    host.endsWith('.localhost')
  );
}

export function parseSponsorIds(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeString(item)).filter(Boolean);
  }
  return String(value || '')
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function getFocusableElements(container) {
  const selectors = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ];
  return [...container.querySelectorAll(selectors.join(','))].filter(
    (element) => !element.hasAttribute('disabled'),
  );
}

export function formatHoursDuration(floatHours) {
  const hours = Math.floor(floatHours);
  const minutes = Math.round((floatHours - hours) * 60);
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h${minutes}m`;
}

export function deriveOfficialWebsite(eventMeta = null) {
  const website = normalizeString(eventMeta?.website);
  const scheduleURL = normalizeString(eventMeta?.scheduleURLs?.[0]);
  const candidate = website || scheduleURL;
  if (!candidate) return '';
  return normalizeEventWebsiteUrl(candidate);
}

function normalizeEventWebsiteUrl(urlString) {
  try {
    const url = new URL(urlString);
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname
      .replace(/\/(?:schedule|programme|program|sessions(?:\/accepted\.html)?)\/?$/i, '/')
      .replace(/\/+$/g, '/');
    return url.toString().replace(/\/$/, '');
  } catch {
    // Not a parseable URL → return the original string unchanged.
    return urlString;
  }
}

export function once(fn) {
  let promise;
  return () => {
    if (!promise) promise = fn();
    return promise;
  };
}

export function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}
