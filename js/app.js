import { init, toggleEventSelectionPublic, wireStatsHandlers } from './modules/events.js';
import { updateSelectionOverview, updateStageStats, setupStatsDelegation } from './modules/stats.js';
import { setupEventsDelegation, setToggleSelectionFn } from './modules/render.js';
import { initNowIndicator } from './modules/nowIndicator.js';

wireStatsHandlers(updateSelectionOverview, updateStageStats);
setToggleSelectionFn(toggleEventSelectionPublic);

function hideLoadingOverlay() {
  const overlay = document.getElementById('pageLoadingOverlay');
  if (!overlay || overlay.classList.contains('is-hidden')) return;
  overlay.classList.add('is-hidden');
}

function setupMobileAccordion(toggleId, contentId) {
  const toggle = document.getElementById(toggleId);
  const content = document.getElementById(contentId);
  if (!toggle || !content) return;

  toggle.addEventListener('click', () => {
    const expanded = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
    content.classList.toggle('hidden', expanded);
  });
}

function setupHeaderMenu() {
  const btn = document.getElementById('headerMenuBtn');
  const menu = document.getElementById('headerMenu');
  if (!btn || !menu) return;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = menu.classList.toggle('hidden');
    btn.setAttribute('aria-expanded', String(!open));
  });

  document.addEventListener('click', () => {
    if (!menu.classList.contains('hidden')) {
      menu.classList.add('hidden');
      btn.setAttribute('aria-expanded', 'false');
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.classList.contains('hidden')) {
      menu.classList.add('hidden');
      btn.setAttribute('aria-expanded', 'false');
      btn.focus();
    }
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  try {
    setupEventsDelegation();
    setupStatsDelegation();
    await init();
    setupMobileAccordion('usageInstructionsToggle', 'usageInstructionsContent');
    setupMobileAccordion('sessionFiltersToggle', 'sessionFiltersContent');
    initNowIndicator();
    setupHeaderMenu();
  } finally {
    hideLoadingOverlay();
  }
});
