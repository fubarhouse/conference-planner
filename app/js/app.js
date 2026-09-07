import './modules/pwa.js'; // registers the service worker (PWA/offline)
import { init, toggleEventSelectionPublic, wireStatsHandlers } from './modules/events.js';
import { initThemePicker } from './modules/themePicker.js';
import { initScheduleSubscribe } from './modules/scheduleSubscribe.js';
import { initAppMenu } from './modules/appMenu.js';
import { refreshFilterCount } from './modules/filters.js';
import {
  updateSelectionOverview,
  updateStageStats,
  setupStatsDelegation,
} from './modules/stats.js';
import { setupEventsDelegation, setToggleSelectionFn } from './modules/render.js';
import { initNowIndicator } from './modules/nowIndicator.js';
import { initNowNext } from './modules/nowNext.js';
import { initRail, closeRail } from './modules/rail.js';
import { initSheetDismiss } from './modules/sheetDismiss.js';
import { initSheetHistory } from './modules/sheetHistory.js';
import { setupMobileAccordion } from './modules/accordion.js';

wireStatsHandlers(updateSelectionOverview, updateStageStats);
setToggleSelectionFn(toggleEventSelectionPublic);

function hideLoadingOverlay() {
  const overlay = document.getElementById('pageLoadingOverlay');
  if (!overlay || overlay.classList.contains('is-hidden')) return;
  overlay.classList.add('is-hidden');
}

document.addEventListener('DOMContentLoaded', async () => {
  try {
    setupEventsDelegation();
    setupStatsDelegation();
    await init();
    refreshFilterCount();
    setupMobileAccordion('usageInstructionsToggle', 'usageInstructionsContent');
    setupMobileAccordion('sessionFiltersToggle', 'sessionFiltersContent');
    initNowIndicator();
    initNowNext();
    initRail();
    initSheetDismiss({ closeRail });
    initSheetHistory({ closeRail });
    initThemePicker();
    initScheduleSubscribe();
    // Runs last: it adopts the elements the calls above have finished wiring.
    initAppMenu({ adopt: ['.app-nav', '.header-actions', '#filtersPanel .l-cluster'] });
  } finally {
    hideLoadingOverlay();
  }
});
