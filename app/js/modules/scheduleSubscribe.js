// "Subscribe to the schedule" — a header popover on the schedule page offering a
// live webcal feed of EVERY session in the current event. No token: it's the
// same public data the page already shows.
//
// Two addresses serve it, and which one this page hands out depends on how the
// app is being served:
//   /schedules/<slug>/calendar.ics   under path routing — the one to share
//   /schedule.ics?e=<file>           the query form, and the static-file fallback

import state from './state.js';
import { usePathRouting } from './scheduleRoute.js';
import { slugForFile } from './scheduleSlug.js';
import { getEventCatalog } from './events.js';

function feedPath() {
  const file = state.currentEventFile;
  if (!file) return null;
  if (usePathRouting(window.location.pathname)) {
    const slug = slugForFile(file, getEventCatalog());
    if (slug) return `/schedules/${encodeURIComponent(slug)}/calendar.ics`;
  }
  return `/schedule.ics?e=${encodeURIComponent(file)}`;
}

function feedUrls() {
  const path = feedPath();
  if (!path) return null;
  return {
    https: `${window.location.origin}${path}`,
    webcal: `webcal://${window.location.host}${path}`,
  };
}

// The live .ics feed only exists when the Express server is running; served as flat
// static files, /schedule.ics 404s (or returns HTML). Probe it so we can grey the
// Subscribe control out on a static copy instead of offering a link that can't work.
async function feedAvailable() {
  const urls = feedUrls();
  if (!urls) return false;
  try {
    const res = await fetch(urls.https, { method: 'HEAD' });
    return res.ok && (res.headers.get('content-type') || '').includes('calendar');
  } catch {
    return false;
  }
}

// Briefly swap the copy button to a "Copied" confirmation.
function flashCopied(btn) {
  if (!btn) return;
  if (!btn.dataset.label) btn.dataset.label = btn.innerHTML;
  btn.innerHTML = 'Copied';
  btn.classList.add('is-copied');
  clearTimeout(btn._t);
  btn._t = setTimeout(() => {
    btn.innerHTML = btn.dataset.label;
    btn.classList.remove('is-copied');
  }, 1600);
}

export function initScheduleSubscribe() {
  const btn = document.getElementById('scheduleSubscribeBtn');
  const pop = document.getElementById('scheduleSubscribePop');
  if (!btn || !pop) return;
  const urlInput = document.getElementById('subUrl');
  const openLink = document.getElementById('subOpen');
  const copyBtn = document.getElementById('subCopy');
  const previewLink = document.getElementById('subPreview');

  function refresh() {
    const urls = feedUrls();
    if (urlInput) urlInput.value = urls?.https || '';
    if (openLink) openLink.href = urls?.webcal || '#';
    // Preview opens the https feed so you can confirm it's the right event.
    if (previewLink) previewLink.href = urls?.https || '#';
  }

  function setOpen(open) {
    pop.classList.toggle('hidden', !open);
    btn.setAttribute('aria-expanded', String(open));
    if (open) refresh();
  }

  // Greyed-out state used when there's no live feed (static hosting).
  let disabled = false;
  function setDisabled(on) {
    disabled = on;
    btn.classList.toggle('is-unavailable', on);
    btn.setAttribute('aria-disabled', String(on));
    btn.title = on
      ? 'Calendar subscription needs the hosted version — not available on this static copy.'
      : '';
    if (on) setOpen(false);
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (disabled) return;
    setOpen(pop.classList.contains('hidden'));
  });
  pop.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setOpen(false);
  });

  copyBtn?.addEventListener('click', async () => {
    const urls = feedUrls();
    if (!urls) return;
    try {
      await navigator.clipboard.writeText(urls.https);
      flashCopied(copyBtn);
    } catch {
      urlInput?.select();
    }
  });
  urlInput?.addEventListener('focus', (e) => e.target.select());

  // The schedule link is public + deterministic (no token to mint), so pre-fill it
  // now — nothing to "generate", the URL just is what it is.
  refresh();
  // Then confirm the feed actually exists here; grey the button out if it doesn't.
  feedAvailable().then((ok) => setDisabled(!ok));
}
