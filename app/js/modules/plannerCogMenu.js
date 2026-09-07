// Trip card cog dropdown (dashboard) — the per-trip ⚙ menu: settings link, edit
// (opens the dashboard edit modal), and delete. Extracted from planner.js:
// deletePlannerBySlug and the dashboard re-render are injected via initCogMenu();
// the edit-modal opener is imported directly.

import { openDashboardPlannerEdit } from './plannerDashEdit.js';
import { plannerHref } from './plannerRoute.js';

// ── Injected planner collaborators ────────────────────────────────────────────
let deletePlannerBySlug;
let renderTripDashboard;

export function initCogMenu(deps) {
  ({ deletePlannerBySlug, renderTripDashboard } = deps);
}

let _cogTargetSlug = null;
let _cogTargetName = null;
let _cogTargetEventFile = null;
let _cogTargetEventLabel = null;
let _cogMenuWired = false;

export function wireTripCogMenu() {
  if (_cogMenuWired) return;
  _cogMenuWired = true;
  const menu = document.getElementById('tripCogMenu');
  const settingsA = document.getElementById('tripCogSettings');
  const editBtn = document.getElementById('tripCogEdit');
  const deleteBtn = document.getElementById('tripCogDelete');
  if (!menu) return;

  function closeMenu() {
    menu.classList.add('hidden');
    _cogTargetSlug = null;
  }

  // Delegated click on any .trip-card-cog button
  document.addEventListener('click', (e) => {
    const cog = e.target.closest('.trip-card-cog');
    if (cog) {
      e.preventDefault();
      e.stopPropagation();
      _cogTargetSlug = cog.dataset.slug;
      _cogTargetName = cog.dataset.name;
      _cogTargetEventFile = cog.dataset.eventFile || '';
      _cogTargetEventLabel = cog.dataset.eventLabel || '';

      if (settingsA) settingsA.href = plannerHref(_cogTargetSlug, 'settings');

      // Position menu near the button
      const rect = cog.getBoundingClientRect();
      menu.classList.remove('hidden');
      const menuW = menu.offsetWidth || 180;
      let left = rect.right - menuW;
      if (left < 8) left = 8;
      menu.style.top = `${rect.bottom + 6}px`;
      menu.style.left = `${left}px`;
      return;
    }
    // Click outside → close
    if (!menu.contains(e.target)) closeMenu();
  });

  editBtn?.addEventListener('click', () => {
    const slug = _cogTargetSlug;
    const name = _cogTargetName;
    const eventFile = _cogTargetEventFile;
    const eventLabel = _cogTargetEventLabel;
    closeMenu();
    openDashboardPlannerEdit(slug, name, eventFile, eventLabel);
  });

  deleteBtn?.addEventListener('click', async () => {
    const slug = _cogTargetSlug;
    const name = _cogTargetName || slug;
    closeMenu();
    if (!slug) return;
    if (!window.confirm(`Delete "${name}"? This cannot be undone.`)) return;
    const { ok, error } = await deletePlannerBySlug(slug);
    await renderTripDashboard();
    if (!ok) alert(`Could not remove "${name}" from the server: ${error}`);
  });
}
