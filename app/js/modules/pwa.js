// Progressive Web App bootstrap. Registers the service worker (app/sw.js) so the
// app shell loads offline and the app is installable. Imported for its side effect
// by each page entry (app.js / planner.js / editor.js). Guarded so it's a no-op
// under file:// (the editor's offline-file mode) and in non-browser (test)
// environments — the app must keep working with no service worker at all.

if (
  typeof navigator !== 'undefined' &&
  'serviceWorker' in navigator &&
  typeof location !== 'undefined' &&
  location.protocol.startsWith('http')
) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('[pwa] service worker registration failed:', err.message);
    });
  });
}
