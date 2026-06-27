import state, { getStorageKey } from './state.js';
import { formatDateForICS, escapeHtml, announceStatus, normalizeTracks } from './utils.js';

function getCalendarDescriptionText(event) {
  return event.full_description || '';
}

function escapeIcsText(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

export function updateDownloadButton() {
  const downloadButton = document.getElementById('downloadIcs');
  const googleButton = document.getElementById('addGoogleCalendar');
  const hasSelections = state.selectedEvents.size > 0;

  downloadButton.disabled = !hasSelections;
  googleButton.disabled = !hasSelections;
}

export function generateIcsContent(events) {
  const selectedEvents = events.filter((event) => state.selectedEvents.has(event.id));
  const icsEvents = selectedEvents
    .map((event) => {
      const start = formatDateForICS(event.startTime);
      const end = formatDateForICS(event.endTime);
      const uid = `${event.id}@${state.currentEventFile.replace('.json', '')}`;
      const urlPart = event.link ? `${event.link}\n\n` : '';
      const description = escapeIcsText(urlPart + getCalendarDescriptionText(event));

      return `BEGIN:VEVENT
UID:${uid}
DTSTART:${start}
DTEND:${end}
SUMMARY:${event.title}
LOCATION:${event.location}
DESCRIPTION:${description}
END:VEVENT`;
    })
    .join('\n');

  const eventDisplayName = `${state.eventMeta.designation} ${state.eventMeta.location} ${state.eventMeta.year}`;
  return `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//${eventDisplayName}//EN
X-WR-CALNAME:${eventDisplayName}
X-WR-TIMEZONE:${state.eventMeta.timezone}
${icsEvents}
END:VCALENDAR`;
}

export function triggerIcsDownload(events, filename, eventName) {
  const metadata = {
    total_events: events.length,
    total_duration: events.reduce(
      (sum, event) => sum + parseInt(event.duration.replace('PT', '').replace('H', ''), 10),
      0
    )
  };
  window.sa_event?.(eventName, metadata);

  const icsContent = generateIcsContent(events);
  const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function downloadSelectedEvents(events) {
  const filename = state.currentEventFile.replace('.json', '') + '-selected-events.ics';
  triggerIcsDownload(events, filename, 'download_ics');
}

export function buildGoogleCalendarEventUrl(event) {
  const start = formatDateForICS(event.startTime);
  const end = formatDateForICS(event.endTime);
  const details = [getCalendarDescriptionText(event), event.link || ''].filter(Boolean).join('\n\n');
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: event.title || 'Session',
    dates: `${start}/${end}`,
    details,
    location: event.location || ''
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

export function addSelectedEventsToGoogleCalendar(events) {
  const selectedEvents = events
    .filter((event) => state.selectedEvents.has(event.id))
    .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));

  if (selectedEvents.length === 0) {
    return;
  }

  if (selectedEvents.length === 1) {
    window.sa_event?.('google_calendar_single_event');
    window.open(buildGoogleCalendarEventUrl(selectedEvents[0]), '_blank', 'noopener,noreferrer');
    return;
  }

  window.sa_event?.('google_calendar_multi_event', { count: selectedEvents.length });

  const eventDisplayName = [state.eventMeta?.designation, state.eventMeta?.location, state.eventMeta?.year]
    .filter(Boolean)
    .join(' ')
    .trim() || 'Selected Sessions';
  const rawLogoUrl = String(state.eventMeta?.logo?.image || '').trim();
  const logoUrl = rawLogoUrl ? new URL(rawLogoUrl, window.location.href).toString() : '';
  const logoAlt = escapeHtml(String(state.eventMeta?.logo?.imageAlt || `${eventDisplayName} logo`).trim());

  const linkRows = selectedEvents
    .map(
      (event, idx) => `
                <li class="session-item">
                    <a class="session-link" href="${buildGoogleCalendarEventUrl(event)}" target="_blank" rel="noopener noreferrer">
                        <span class="session-index">${idx + 1}</span>
                        <span class="session-copy">
                          <span class="session-title">${escapeHtml(event.title)}</span>
                          <span class="session-meta">${escapeHtml(event.location || 'Location TBA')}</span>
                        </span>
                        <span class="session-action">Add to calendar</span>
                    </a>
                </li>
            `
    )
    .join('');

  const helperHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(eventDisplayName)} - Google Calendar</title>
  <style>
    :root {
      color-scheme: dark;
      --bg-0: #08131f;
      --bg-1: #0d2033;
      --surface-0: rgba(14, 29, 46, 0.92);
      --surface-1: rgba(19, 39, 61, 0.96);
      --line-0: rgba(142, 186, 227, 0.22);
      --text-0: #eef6ff;
      --text-1: #c7d9ec;
      --text-2: #9eb7cf;
      --accent-0: #1693ea;
      --accent-1: #0f7ccc;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.5;
      color: var(--text-0);
      background:
        radial-gradient(circle at 18% -10%, rgba(49, 116, 180, 0.28), transparent 34%),
        radial-gradient(circle at 90% 0%, rgba(42, 95, 148, 0.24), transparent 28%),
        linear-gradient(180deg, var(--bg-1), var(--bg-0));
    }
    .shell {
      width: min(980px, 94vw);
      margin: 0 auto;
      padding: 24px 0 40px;
    }
    .hero {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 18px 20px;
      border-bottom: 1px solid rgba(169, 215, 255, 0.22);
      background:
        radial-gradient(circle at 12% 30%, rgba(152, 209, 255, 0.2), transparent 34%),
        radial-gradient(circle at 78% 10%, rgba(122, 193, 255, 0.22), transparent 40%),
        linear-gradient(120deg, #0d4d81, #0a3e69 60%, #0a3559);
      border-radius: 20px 20px 0 0;
    }
    .logo {
      width: 84px;
      height: 84px;
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 18px;
      border: 1px solid rgba(210, 235, 255, 0.22);
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.16), rgba(255, 255, 255, 0.08));
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08), 0 10px 24px rgba(0, 0, 0, 0.18);
      overflow: hidden;
    }
    .logo img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      object-position: center;
      padding: 0.65rem;
    }
    .hero-copy { min-width: 0; }
    .eyebrow {
      font-size: 0.72rem;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: rgba(224, 242, 255, 0.92);
      margin-bottom: 4px;
    }
    h1 {
      margin: 0;
      font-size: clamp(1.5rem, 2.8vw, 2.3rem);
      line-height: 1.1;
      color: #f6fbff;
    }
    .panel {
      padding: 20px;
      border: 1px solid var(--line-0);
      border-top: 0;
      border-radius: 0 0 20px 20px;
      background:
        radial-gradient(circle at 100% 0%, rgba(96, 176, 241, 0.08), transparent 30%),
        linear-gradient(165deg, rgba(16, 36, 58, 0.96), rgba(10, 23, 39, 0.98));
      box-shadow: 0 16px 34px rgba(0, 0, 0, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.04);
    }
    .intro {
      margin: 0 0 18px;
      color: var(--text-1);
      font-size: 0.98rem;
    }
    .hint {
      margin: 0 0 18px;
      color: var(--text-2);
      font-size: 0.9rem;
    }
    .session-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 10px;
    }
    .session-item {
      margin: 0;
    }
    .session-link {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
      gap: 14px;
      padding: 14px 16px;
      text-decoration: none;
      color: var(--text-0);
      border: 1px solid rgba(149, 191, 233, 0.22);
      border-radius: 14px;
      background: linear-gradient(180deg, rgba(18, 37, 58, 0.88), rgba(12, 27, 43, 0.88));
      transition: background-color 140ms ease, border-color 140ms ease, transform 140ms ease, box-shadow 140ms ease;
    }
    .session-link:hover,
    .session-link:focus-visible {
      outline: none;
      transform: translateY(-1px);
      border-color: rgba(166, 209, 244, 0.42);
      background: linear-gradient(180deg, rgba(24, 48, 73, 0.94), rgba(16, 34, 54, 0.94));
      box-shadow: 0 10px 24px rgba(0, 0, 0, 0.16);
    }
    .session-index {
      width: 2rem;
      height: 2rem;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 999px;
      background: rgba(22, 147, 234, 0.16);
      border: 1px solid rgba(107, 186, 247, 0.3);
      color: #cfe9ff;
      font-weight: 700;
      font-size: 0.85rem;
    }
    .session-copy {
      min-width: 0;
      display: grid;
      gap: 2px;
    }
    .session-title {
      font-size: 0.97rem;
      font-weight: 600;
      color: #f5fbff;
    }
    .session-meta {
      font-size: 0.84rem;
      color: var(--text-2);
    }
    .session-action {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 72px;
      min-height: 2.2rem;
      padding: 0 12px;
      border-radius: 999px;
      background: linear-gradient(180deg, var(--accent-0), var(--accent-1));
      color: #ffffff;
      font-size: 0.83rem;
      font-weight: 700;
    }
    @media (max-width: 640px) {
      .shell { width: min(100%, 94vw); padding-top: 16px; }
      .hero { padding: 16px; }
      .logo { width: 68px; height: 68px; border-radius: 14px; }
      .logo img { padding: 0.5rem; }
      .panel { padding: 16px; }
      .session-link { grid-template-columns: auto minmax(0, 1fr); }
      .session-action { grid-column: 2; justify-self: start; margin-top: 4px; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="hero">
      <div class="logo">${logoUrl ? `<img src="${logoUrl}" alt="${logoAlt}">` : ''}</div>
      <div class="hero-copy">
        <div class="eyebrow">Google Calendar</div>
        <h1>${escapeHtml(eventDisplayName)}</h1>
      </div>
    </section>
    <section class="panel">
      <p class="intro">Open each session in Google Calendar and save it from the event draft page.</p>
      <p class="hint">${selectedEvents.length} selected session${selectedEvents.length === 1 ? '' : 's'}.</p>
      <ol class="session-list">${linkRows}</ol>
    </section>
  </main>
</body>
</html>`;

  const blob = new Blob([helperHtml], { type: 'text/html;charset=utf-8' });
  const helperUrl = URL.createObjectURL(blob);
  window.open(helperUrl, '_blank', 'noopener,noreferrer');
  setTimeout(() => URL.revokeObjectURL(helperUrl), 60000);
}

export function toggleEventSelection(eventId, applyFilterFn, updateSelectionOverviewFn) {
  const event = state.allEvents.find((item) => item.id === eventId);
  if (!event) return;
  const sessionMetadata = { session: event.title };
  const trackMetadata = { track: normalizeTracks(event.track).join(', ') };

  if (state.selectedEvents.has(eventId)) {
    state.selectedEvents.delete(eventId);
    window.sa_event?.('removeSession', sessionMetadata);
    window.sa_event?.('removeFromTrack', trackMetadata);
    announceStatus(`Removed: ${event.title}. ${state.selectedEvents.size} selected.`);
  } else {
    state.selectedEvents.add(eventId);
    window.sa_event?.('addSession', sessionMetadata);
    window.sa_event?.('addToTrack', trackMetadata);
    announceStatus(`Selected: ${event.title}. ${state.selectedEvents.size} selected.`);
  }

  localStorage.setItem(getStorageKey(), JSON.stringify([...state.selectedEvents]));
  updateDownloadButton();
  updateSelectionOverviewFn(state.allEvents);
  applyFilterFn(state.allEvents, null, true, false);
}
