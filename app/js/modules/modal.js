// Shared modal show/hide helpers. Extracted from planner.js so feature modules
// (tasks, notes, …) can open/close their own modals without depending on the
// planner entry file. Modals are plain elements toggled via the `hidden` class;
// showModal also locks body scroll and compensates for the scrollbar width.

export const touchDevice = () => window.matchMedia('(pointer: coarse)').matches;

export function showModal(id, focusId) {
  const modal = document.getElementById(id);
  if (!modal) return;
  const sw = window.innerWidth - document.documentElement.clientWidth;
  document.body.style.overflow = 'hidden';
  if (sw) document.body.style.paddingRight = `${sw}px`;
  modal.classList.remove('hidden');
  if (focusId && !touchDevice()) document.getElementById(focusId)?.focus();
}

export function hideModal(id) {
  document.getElementById(id)?.classList.add('hidden');
  document.body.style.overflow = '';
  document.body.style.paddingRight = '';
}
