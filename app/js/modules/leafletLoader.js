// Vendored rather than fetched from unpkg: this is executable code on pages that
// are auth-gated and write to disk, and a CDN can serve something other than what
// was reviewed. The files are pinned copies of leaflet 1.9.4's dist — update by
// replacing app/vendor/leaflet-1.9.4/.
//
// Lazy-loads Leaflet (CSS + JS) exactly once, then invokes each
// queued callback. Used by any editor/planner map UI that only needs Leaflet on
// demand, so the library isn't paid for until a map is actually opened.

let _ready = false;
const _cbs = [];

/** @param {() => void} cb */
export function loadLeaflet(cb) {
  if (window.L) _ready = true;
  if (_ready) {
    cb();
    return;
  }
  _cbs.push(cb);
  if (_cbs.length > 1) return; // load already in flight

  const link = Object.assign(document.createElement('link'), {
    rel: 'stylesheet',
    href: new URL('../../vendor/leaflet-1.9.4/leaflet.css', import.meta.url).href,
  });
  document.head.appendChild(link);

  const script = Object.assign(document.createElement('script'), {
    src: new URL('../../vendor/leaflet-1.9.4/leaflet.js', import.meta.url).href,
  });
  script.onload = () => {
    _ready = true;
    _cbs.splice(0).forEach((fn) => fn());
  };
  document.head.appendChild(script);
}
