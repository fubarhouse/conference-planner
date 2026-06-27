import state from './state.js';
import { getLocalDate, normalizeTracks, formatHoursDuration } from './utils.js';

function parseDurationHours(duration = '') {
  const hoursMatch = String(duration).match(/(\d+)H/);
  const minutesMatch = String(duration).match(/(\d+)M/);
  const hours = hoursMatch ? parseInt(hoursMatch[1], 10) : 0;
  const minutes = minutesMatch ? parseInt(minutesMatch[1], 10) : 0;
  return hours + minutes / 60;
}

export function updateSelectionOverview(events, updateStageStats) {
  const overviewPanel = document.getElementById('selectionOverview');
  const selectedEvents = events.filter((event) => state.selectedEvents.has(event.id));

  if (selectedEvents.length === 0) {
    overviewPanel.classList.add('translate-y-full');
    return;
  }

  overviewPanel.classList.remove('translate-y-full');

  const trackStats = {};
  selectedEvents.forEach((event) => {
    const trackValues = normalizeTracks(event.track);
    const durationHours = parseDurationHours(event.duration);

    trackValues.forEach((track) => {
      if (!trackStats[track]) {
        trackStats[track] = { count: 0, duration: 0 };
      }
      trackStats[track].count++;
      trackStats[track].duration += durationHours;
    });
  });

  updateStageStats(trackStats);

  const totalEvents = selectedEvents.length;
  const totalDuration = selectedEvents.reduce((sum, event) => sum + parseDurationHours(event.duration), 0);

  document.getElementById('totalEvents').textContent = totalEvents;
  document.getElementById('totalDuration').textContent = `${totalDuration.toFixed(1)} hours`;
}

function computeDailyStats(selectedEvents) {
  const dailyStats = {};
  selectedEvents.forEach((event) => {
    const date = getLocalDate(event.startTime);
    const trackValues = normalizeTracks(event.track);
    const durationHours = parseDurationHours(event.duration);
    if (!dailyStats[date]) {
      dailyStats[date] = { count: 0, duration: 0, tracks: {} };
    }
    dailyStats[date].count++;
    dailyStats[date].duration += durationHours;
    trackValues.forEach((track) => {
      if (!dailyStats[date].tracks[track]) {
        dailyStats[date].tracks[track] = { count: 0, duration: 0 };
      }
      dailyStats[date].tracks[track].count++;
      dailyStats[date].tracks[track].duration += durationHours;
    });
  });
  return dailyStats;
}

function computeTrackStats(selectedEvents) {
  const trackStats = {};
  selectedEvents.forEach((event) => {
    const trackValues = normalizeTracks(event.track);
    const date = getLocalDate(event.startTime);
    const durationHours = parseDurationHours(event.duration);
    trackValues.forEach((track) => {
      if (!trackStats[track]) {
        trackStats[track] = { count: 0, duration: 0, days: {} };
      }
      trackStats[track].count++;
      trackStats[track].duration += durationHours;
      if (!trackStats[track].days[date]) {
        trackStats[track].days[date] = { count: 0, duration: 0 };
      }
      trackStats[track].days[date].count++;
      trackStats[track].days[date].duration += durationHours;
    });
  });
  return trackStats;
}

function renderTrackSectionHtml(trackStats) {
  const rows = Object.entries(trackStats)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([track, stats], index) => {
      const durationText = formatHoursDuration(stats.duration);
      const dayBreakdown = Object.entries(stats.days)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, dayStats]) => {
          const formattedDate = new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long' });
          return `
            <tr class="selection-stats-subrow">
              <td class="selection-stats-cell selection-stats-subcell pr-3 pl-6">${formattedDate}</td>
              <td class="selection-stats-cell selection-stats-value pr-3 font-mono text-right">${formatHoursDuration(dayStats.duration)}</td>
              <td class="selection-stats-cell">${dayStats.count} ${dayStats.count === 1 ? 'event' : 'events'}</td>
            </tr>`;
        })
        .join('');
      return `
        <tr class="selection-stats-row cursor-pointer hover:bg-gray-700 hover:bg-opacity-30 transition-colors" data-track-id="track-${index}">
          <td class="selection-stats-cell pr-3">
            <i id="track-${index}-icon" class="fas fa-chevron-right mr-2 text-xs transition-transform"></i>
            ${track}
          </td>
          <td class="selection-stats-cell selection-stats-value pr-3 font-mono text-right">${durationText}</td>
          <td class="selection-stats-cell">${stats.count} ${stats.count === 1 ? 'event' : 'events'}</td>
        </tr>
        <tr id="track-${index}-details" class="selection-stats-detail hidden">
          <td class="selection-stats-detail-cell" colspan="3">
            <table class="selection-stats-table selection-stats-subtable w-full"><tbody>${dayBreakdown}</tbody></table>
          </td>
        </tr>`;
    })
    .join('');
  return `
    <section class="selection-stats-section">
      <h4 class="selection-stats-heading text-white font-medium mb-2">By Track</h4>
      <table class="selection-stats-table text-sm text-white"><tbody>${rows}</tbody></table>
    </section>`;
}

function renderDaySectionHtml(sortedDates, dailyStats) {
  const rows = sortedDates
    .map((date, index) => {
      const stats = dailyStats[date];
      const formattedDate = new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long' });
      const trackBreakdown = Object.entries(stats.tracks)
        .sort((a, b) => b[1].count - a[1].count)
        .map(([track, dayTrackStats]) => `
          <tr class="selection-stats-subrow">
            <td class="selection-stats-cell selection-stats-subcell pr-3 pl-6">${track}</td>
            <td class="selection-stats-cell selection-stats-value pr-3 font-mono text-right">${formatHoursDuration(dayTrackStats.duration)}</td>
            <td class="selection-stats-cell">${dayTrackStats.count} ${dayTrackStats.count === 1 ? 'event' : 'events'}</td>
          </tr>`)
        .join('');
      return `
        <tr class="selection-stats-row cursor-pointer hover:bg-gray-700 hover:bg-opacity-30 transition-colors" data-day-id="day-${index}">
          <td class="selection-stats-cell pr-3">
            <i id="day-${index}-icon" class="fas fa-chevron-right mr-2 text-xs transition-transform"></i>
            ${formattedDate}
          </td>
          <td class="selection-stats-cell selection-stats-value pr-3 font-mono text-right">${formatHoursDuration(stats.duration)}</td>
          <td class="selection-stats-cell">${stats.count} ${stats.count === 1 ? 'event' : 'events'}</td>
        </tr>
        <tr id="day-${index}-details" class="selection-stats-detail hidden">
          <td class="selection-stats-detail-cell" colspan="3">
            <table class="selection-stats-table selection-stats-subtable w-full"><tbody>${trackBreakdown}</tbody></table>
          </td>
        </tr>`;
    })
    .join('');
  return `
    <section class="selection-stats-section border-t border-gray-700 pt-4">
      <h4 class="selection-stats-heading text-white font-medium mb-2">By Day</h4>
      <table class="selection-stats-table text-sm text-white"><tbody>${rows}</tbody></table>
    </section>`;
}

export function updateStageStats() {
  const stageStatsContainer = document.getElementById('stageStats');
  const selectedEvents = state.allEvents.filter((event) => state.selectedEvents.has(event.id));
  const dailyStats = computeDailyStats(selectedEvents);
  const trackStats = computeTrackStats(selectedEvents);
  const sortedDates = Object.keys(dailyStats).sort();
  stageStatsContainer.innerHTML = `
    <div class="selection-stats space-y-4">
      ${renderTrackSectionHtml(trackStats)}
      ${renderDaySectionHtml(sortedDates, dailyStats)}
    </div>`;
}

export function setupStatsDelegation() {
  const container = document.getElementById('stageStats');
  if (!container) return;

  container.addEventListener('click', (e) => {
    const trackRow = e.target.closest('[data-track-id]');
    if (trackRow) { toggleTrackExpansion(trackRow.dataset.trackId); return; }
    const dayRow = e.target.closest('[data-day-id]');
    if (dayRow) toggleDayExpansion(dayRow.dataset.dayId);
  });
}

export function toggleDayExpansion(dayId) {
  const detailsDiv = document.getElementById(`${dayId}-details`);
  const icon = document.getElementById(`${dayId}-icon`);

  if (detailsDiv.classList.contains('hidden')) {
    detailsDiv.classList.remove('hidden');
    icon.classList.add('rotate-90');
  } else {
    detailsDiv.classList.add('hidden');
    icon.classList.remove('rotate-90');
  }
}

export function toggleTrackExpansion(trackId) {
  const detailsDiv = document.getElementById(`${trackId}-details`);
  const icon = document.getElementById(`${trackId}-icon`);

  if (detailsDiv.classList.contains('hidden')) {
    detailsDiv.classList.remove('hidden');
    icon.classList.add('rotate-90');
  } else {
    detailsDiv.classList.add('hidden');
    icon.classList.remove('rotate-90');
  }
}
