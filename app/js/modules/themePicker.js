// Colour-mode picker — the top-right control on the schedule header.
//
// It used to list every palette in themes.json (five entries, three of which
// were really event identities and all of which were dark). Mode and identity
// are now separate axes: mode is Light / Dark / System and nothing else, while
// an event's colours arrive as accents. See brand/DECISIONS.md.
//
// "System" removes the preference entirely so the prefers-color-scheme rule in
// foundation.css takes over; it is not a third palette.
import { getModePreference, setModePreference } from './theme.js';

const BTN_ID = 'themePickerBtn';
const MENU_ID = 'themePickerMenu';
const PICKER_ID = 'themePicker';

/**
 * Put the picker in the masthead of any page that has one.
 *
 * Mode is a property of the reader, not of a section, so the control belongs on
 * every page — it lived only on the schedule, which meant a reader who chose
 * Dark there met a light Home. Mounted rather than pasted into six documents so
 * there is one markup to change.
 *
 * @returns {boolean} true when a picker is present after the call
 */
export function mountThemePicker() {
  if (typeof document === 'undefined') return false;
  if (document.getElementById(PICKER_ID)) return true; // the schedule ships its own
  const bar = document.querySelector('.app-masthead__bar');
  if (!bar) return false;
  const el = document.createElement('div');
  el.id = PICKER_ID;
  el.className = 'theme-picker';
  el.innerHTML = `
    <button id="${BTN_ID}" type="button" class="theme-picker-btn" aria-haspopup="true"
      aria-expanded="false" title="Change theme">
      <span class="theme-picker-btn-label">Theme</span>
    </button>
    <div id="${MENU_ID}" class="theme-picker-menu hidden" role="menu"></div>`;
  bar.append(el);
  return true;
}

// Labels name the axis, not just the value: "Dark" alone reads as a noun with
// no clue that the control changes the page's colours.
const MODES = [
  { id: '', label: 'System theme' },
  { id: 'light', label: 'Light mode' },
  { id: 'dark', label: 'Dark mode' },
];

function renderMenu(menu, active) {
  menu.innerHTML = MODES.map(
    (m) => `
      <button type="button" class="theme-picker-item${m.id === active ? ' is-active' : ''}"
              role="menuitemradio" aria-checked="${m.id === active}" data-mode-id="${m.id}">
        <span class="theme-picker-item-label">${m.label}</span>
      </button>`,
  ).join('');
}

function currentLabel(active) {
  return (MODES.find((m) => m.id === active) || MODES[0]).label;
}

export function initThemePicker() {
  mountThemePicker();
  const btn = document.getElementById(BTN_ID);
  const menu = document.getElementById(MENU_ID);
  if (!btn || !menu) return;

  const label = btn.querySelector('.theme-picker-btn-label');
  const syncLabel = () => {
    if (label) label.textContent = currentLabel(getModePreference());
  };

  const close = () => {
    menu.classList.add('hidden');
    btn.setAttribute('aria-expanded', 'false');
  };
  const open = () => {
    renderMenu(menu, getModePreference());
    menu.classList.remove('hidden');
    btn.setAttribute('aria-expanded', 'true');
  };

  syncLabel();

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.classList.contains('hidden')) open();
    else close();
  });

  menu.addEventListener('click', (e) => {
    const item = e.target.closest('[data-mode-id]');
    if (!item) return;
    setModePreference(item.dataset.modeId);
    syncLabel();
    renderMenu(menu, getModePreference());
    close();
  });

  document.addEventListener('click', () => {
    if (!menu.classList.contains('hidden')) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.classList.contains('hidden')) {
      close();
      btn.focus();
    }
  });
}
