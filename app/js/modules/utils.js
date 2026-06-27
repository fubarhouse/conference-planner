import state from './state.js';

export function formatDate(dateString) {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

export function getLocalDate(utcDateString) {
  const date = new Date(utcDateString);
  const tz = state.eventMeta.timezone;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
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

export function normalizeTracks(trackValue) {
  const splitTrackValue = (value) =>
    String(value || '')
      .split(/\s*,\s*/)
      .map((track) => track.trim())
      .filter(Boolean);

  if (Array.isArray(trackValue)) {
    return [...new Set(trackValue.flatMap((track) => splitTrackValue(track)))];
  }
  return splitTrackValue(trackValue);
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

  const isTableDelimiter = (line) =>
    /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);

  const isTableRow = (line) => {
    const trimmed = String(line || '').trim();
    if (!trimmed || !trimmed.includes('|') || isTableDelimiter(trimmed)) return false;
    let cells = trimmed.split('|').map((cell) => cell.trim());
    if (cells.length > 0 && cells[0] === '') cells = cells.slice(1);
    if (cells.length > 0 && cells[cells.length - 1] === '') cells = cells.slice(0, -1);
    return cells.length >= 2;
  };

  const filtered = lines.filter((rawLine) => {
    const line = String(rawLine || '').trim();
    if (!line) return false;
    if (/^\s*#{1,6}\s+/.test(line)) return false;
    if (/^\s*>\s?/.test(line)) return false;
    if (isTableDelimiter(line) || isTableRow(line)) return false;
    return true;
  });

  return filtered
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
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
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host.endsWith('.localhost');
}

export function parseSponsorIds(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
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
    '[tabindex]:not([tabindex="-1"])'
  ];
  return [...container.querySelectorAll(selectors.join(','))].filter((element) => !element.hasAttribute('disabled'));
}

export function formatHoursDuration(floatHours) {
  const hours = Math.floor(floatHours);
  const minutes = Math.round((floatHours - hours) * 60);
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h${minutes}m`;
}

export function deriveOfficialWebsite(eventMeta = null) {
  const website = String(eventMeta?.website || '').trim();
  const scheduleURL = String(eventMeta?.scheduleURLs?.[0] || '').trim();
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
      .replace(
        /\/(?:schedule|programme|program|sessions(?:\/accepted\.html)?)\/?$/i,
        '/'
      )
      .replace(/\/+$/g, '/');
    return url.toString().replace(/\/$/, '');
  } catch {
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
