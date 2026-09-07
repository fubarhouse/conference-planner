// Generic "pick a point on a map" modal, shared by the editor (event venue) and
// the planner (accommodation, waypoint stops). Self-contained: it injects its own
// modal DOM on first use, so no page needs bespoke HTML, and it carries no
// domain-specific wording — the caller supplies the title / placeholder. Leaflet
// and geocoding load on demand.
//
// openMapPicker({ lat, lon, query, title, searchPlaceholder, onConfirm })

import { geocodeLocation, geocodeSearchNamed } from './geocode.js';
import { loadLeaflet } from './leafletLoader.js';

let _built = false;
/** @type {Record<string, any>} */
let _r = {}; // cached element refs
let _map = null;
let _marker = null;
let _lat = null;
let _lon = null;
let _onConfirm = null;
// Optional reference marker (e.g. the conference venue) — shown for orientation,
// never editable. When it's outside the current view, an edge indicator points
// toward it so it's discoverable even off-screen.
let _refMarker = null;
/** @type {[number, number] | null} */
let _refPoint = null;
let _refLabel = '';
/** Confine the search to this many km of the reference point (null = bias only). */
let _radiusKm = null;
/** The name the geocoder matched, handed to onConfirm so a caller can prefill it. */
let _lastLabel = '';

const _round = (n) => Math.round(n * 1e6) / 1e6;

function _build() {
  if (_built) return;
  _built = true;
  const overlay = document.createElement('div');
  overlay.className = 'vmap-overlay hidden';
  overlay.setAttribute('aria-hidden', 'true');
  overlay.innerHTML = `
    <div class="vmap-card" role="dialog" aria-modal="true" aria-labelledby="vmapTitle">
      <div class="vmap-header">
        <div class="vmap-badge"><i class="fas fa-map-location-dot" aria-hidden="true"></i></div>
        <div class="vmap-heading">
          <h2 id="vmapTitle" class="vmap-title"></h2>
          <p class="vmap-sub">Search a place, then click or drag the pin to set it exactly.</p>
        </div>
        <button class="vmap-close" data-vmap="close" type="button" aria-label="Close"><i class="fas fa-times" aria-hidden="true"></i></button>
      </div>
      <div class="vmap-body">
        <div class="vmap-search">
          <i class="fas fa-magnifying-glass vmap-search-icon" aria-hidden="true"></i>
          <input class="vmap-search-input" data-vmap="search" type="text" autocomplete="off">
          <button class="vmap-search-btn" data-vmap="searchBtn" type="button"><i class="fas fa-arrow-right" aria-hidden="true"></i><span>Search</span></button>
        </div>
        <div class="vmap-status" data-vmap="status" role="status" hidden></div>
        <div class="vmap-canvas-wrap">
          <div class="vmap-canvas" data-vmap="canvas"></div>
          <div class="vmap-readout" aria-live="polite"><i class="fas fa-location-crosshairs" aria-hidden="true"></i><span data-vmap="coords"></span></div>
          <button class="vmap-offscreen" data-vmap="offscreen" type="button" hidden aria-hidden="true">
            <i class="fas fa-location-arrow vmap-offscreen-arrow" aria-hidden="true"></i>
            <span class="vmap-offscreen-label" data-vmap="offscreenLabel"></span>
          </button>
        </div>
      </div>
      <div class="vmap-footer">
        <span class="vmap-hint"><i class="fas fa-hand-pointer" aria-hidden="true"></i> Click or drag the pin</span>
        <div class="vmap-actions">
          <button class="vmap-btn vmap-btn-ghost" data-vmap="cancel" type="button">Cancel</button>
          <button class="vmap-btn vmap-btn-primary" data-vmap="use" type="button" disabled><i class="fas fa-check" aria-hidden="true"></i><span>Use this location</span></button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const q = (sel) => overlay.querySelector(`[data-vmap="${sel}"]`);
  _r = {
    overlay,
    title: overlay.querySelector('#vmapTitle'),
    search: /** @type {HTMLInputElement} */ (q('search')),
    searchBtn: /** @type {HTMLButtonElement} */ (q('searchBtn')),
    status: q('status'),
    canvas: q('canvas'),
    coords: q('coords'),
    close: q('close'),
    cancel: q('cancel'),
    use: /** @type {HTMLButtonElement} */ (q('use')),
    offscreen: /** @type {HTMLButtonElement} */ (q('offscreen')),
    offscreenLabel: q('offscreenLabel'),
  };
  // Clicking the edge indicator frames both the picked point and the reference.
  _r.offscreen.addEventListener('click', _frameReference);

  _r.searchBtn.addEventListener('click', _runSearch);
  _r.search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      _runSearch();
    }
  });
  _r.search.addEventListener('input', _hideStatus);
  _r.close.addEventListener('click', _close);
  _r.cancel.addEventListener('click', _close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) _close();
  });
  _r.use.addEventListener('click', () => {
    if (_lat != null && _lon != null && _onConfirm) _onConfirm(_lat, _lon, { label: _lastLabel });
    _close();
  });
}

// A themed teardrop pin (matches the app's accent), so the picker looks cohesive.
function _pinIcon() {
  return window.L.divIcon({
    className: 'vmap-pin-wrap',
    html: '<div class="vmap-pin"><span class="vmap-pin-dot"></span></div>',
    iconSize: [26, 26],
    iconAnchor: [13, 26],
  });
}

// A distinct gold "landmark" pin for the reference point, visually separate from
// the draggable accent pin the user is placing.
function _confPinIcon() {
  return window.L.divIcon({
    className: 'vmap-pin-wrap',
    html: '<div class="vmap-pin vmap-pin--conf"><i class="fas fa-star vmap-pin-glyph" aria-hidden="true"></i></div>',
    iconSize: [26, 26],
    iconAnchor: [13, 26],
  });
}

const _refLatLonRe = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

// Resolve a reference descriptor to [lat, lon]: explicit coords win, else geocode
// the query. Best-effort — a failure just means no reference marker.
async function _resolveRef(reference) {
  if (!reference) return null;
  const m = String(reference.coords || '').match(_refLatLonRe);
  if (m) return [parseFloat(m[1]), parseFloat(m[2])];
  if (reference.query) return geocodeLocation(reference.query).catch(() => null);
  return null;
}

// Place (or clear) the reference marker and refresh the off-screen indicator.
function _setReference(point, label) {
  _refPoint = point;
  _refLabel = label || 'Conference';
  if (_refMarker) {
    _map.removeLayer(_refMarker);
    _refMarker = null;
  }
  if (point) {
    _refMarker = window.L.marker(point, {
      icon: _confPinIcon(),
      interactive: true,
      keyboard: false,
      zIndexOffset: -100, // sits behind the pin the user is placing
    })
      .addTo(_map)
      .bindTooltip(_refLabel, { direction: 'top', offset: [0, -24] });
  }
  _updateOffscreen();
}

// Format a rough distance from map centre to the reference for the edge chip.
function _refDistanceText() {
  if (!_refPoint) return '';
  const km = _map.distance(_map.getCenter(), window.L.latLng(_refPoint)) / 1000;
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

// Show an arrow chip clamped to the canvas edge, pointing at the reference, when
// it's outside the viewport; hide it when the reference is on-screen.
function _updateOffscreen() {
  const el = _r.offscreen;
  if (!el) return;
  if (!_refPoint || !_map) {
    el.hidden = true;
    return;
  }
  const size = _map.getSize();
  const p = _map.latLngToContainerPoint(window.L.latLng(_refPoint));
  const inView = p.x >= 0 && p.x <= size.x && p.y >= 0 && p.y <= size.y;
  if (inView) {
    el.hidden = true;
    el.setAttribute('aria-hidden', 'true');
    return;
  }
  const pad = 16;
  const cx = size.x / 2;
  const cy = size.y / 2;
  const dx = p.x - cx;
  const dy = p.y - cy;
  // Scale the centre→point vector so it lands on the padded canvas boundary.
  const scale = Math.min((cx - pad) / Math.abs(dx || 1e-6), (cy - pad) / Math.abs(dy || 1e-6));
  const ex = cx + dx * scale;
  const ey = cy + dy * scale;
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  el.style.left = `${ex}px`;
  el.style.top = `${ey}px`;
  el.style.setProperty('--vmap-arrow-rot', `${angle}deg`);
  const dist = _refDistanceText();
  _r.offscreenLabel.textContent = dist ? `${_refLabel} · ${dist}` : _refLabel;
  el.hidden = false;
  el.setAttribute('aria-hidden', 'false');
}

// Frame both the reference and the placed pin (or the centre) into view.
function _frameReference() {
  if (!_refPoint || !_map) return;
  const L = window.L;
  const other = _lat != null && _lon != null ? L.latLng(_lat, _lon) : _map.getCenter();
  _map.fitBounds(L.latLngBounds([L.latLng(_refPoint), other]).pad(0.35), {
    maxZoom: 15,
  });
}

function _setPoint(lat, lon) {
  _lat = _round(lat);
  _lon = _round(lon);
  _r.coords.textContent = `${_lat}, ${_lon}`;
  _r.use.disabled = false;
  const L = window.L;
  if (!_marker) {
    _marker = L.marker([_lat, _lon], { draggable: true, icon: _pinIcon() }).addTo(_map);
    _marker.on('dragend', () => {
      const p = _marker.getLatLng();
      _setPoint(p.lat, p.lng);
    });
  } else {
    _marker.setLatLng([_lat, _lon]);
  }
}

function _setSearching(on) {
  _r.searchBtn.disabled = on;
  _r.searchBtn.innerHTML = on
    ? '<i class="fas fa-spinner" aria-hidden="true"></i><span>Searching…</span>'
    : '<i class="fas fa-arrow-right" aria-hidden="true"></i><span>Search</span>';
}

function _showStatus(msg) {
  _r.status.innerHTML = '<i class="fas fa-triangle-exclamation" aria-hidden="true"></i>';
  const span = document.createElement('span');
  span.textContent = msg; // textContent → no injection from the query
  _r.status.appendChild(span);
  _r.status.hidden = false;
}

function _hideStatus() {
  if (_r.status) _r.status.hidden = true;
}

function _close() {
  _r.overlay.classList.add('hidden');
  _r.overlay.setAttribute('aria-hidden', 'true');
}

/** A degrees box `km` around a point — the crude conversion is right at this scale. */
function _radiusBox([lat, lon], km) {
  const dLat = km / 111.32;
  const dLon = km / (111.32 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  return { west: lon - dLon, east: lon + dLon, south: lat - dLat, north: lat + dLat };
}

async function _runSearch() {
  const query = (_r.search.value || '').trim();
  if (!query || !_map) return;
  _hideStatus();
  _setSearching(true);
  // Bias the search to the current view so a nearby match wins over a far namesake.
  const b = _map.getBounds();
  const view = {
    west: b.getWest(),
    south: b.getSouth(),
    east: b.getEast(),
    north: b.getNorth(),
  };
  // With a radius, the search is CONFINED to it rather than merely biased: a
  // session's offsite venue is somewhere near the conference, so a same-named
  // building in another country is a wrong answer, not a wider one. Saying "not
  // within Nkm" is more useful than silently pinning Paris, Texas.
  const bounded = _radiusKm && _refPoint ? _radiusBox(_refPoint, _radiusKm) : null;
  const hit = await geocodeSearchNamed(query, bounded || view, { strict: !!bounded });
  _setSearching(false);
  if (hit) {
    const pt = hit.point;
    _lastLabel = hit.label || query;
    // Already on screen → just drop the pin (don't yank the map elsewhere); only
    // recentre when the match is outside the current view.
    if (!_map.getBounds().contains(pt)) _map.setView(pt, 15);
    _setPoint(pt[0], pt[1]);
  } else {
    _showStatus(
      bounded
        ? `No “${query}” within ${_radiusKm}km of ${_refLabel || 'the venue'}. Click the map to drop the pin instead.`
        : `Couldn't find “${query}”. Click the map to drop the pin instead.`,
    );
  }
}

/**
 * Open the map picker.
 * @param {object} opts
 * @param {number|null} [opts.lat] - current latitude (centres + drops the pin)
 * @param {number|null} [opts.lon] - current longitude
 * @param {string} [opts.query] - seed for the search box / initial geocode
 * @param {string} [opts.title] - modal heading (caller-supplied, domain-specific)
 * @param {string} [opts.searchPlaceholder]
 * @param {{coords?: string, query?: string, label?: string}|null} [opts.reference]
 *   - a non-editable orientation marker (e.g. the conference venue); shown even
 *     when off-screen via an edge indicator.
 * @param {number|null} [opts.radiusKm] - confine search to this many km of the
 *   reference point. For a session's offsite venue: it is always near the
 *   conference, so a global namesake is wrong rather than merely distant.
 * @param {(lat: number, lon: number, extra: {label: string}) => void} opts.onConfirm
 *   - `label` is the name the geocoder matched, for prefilling a venue name.
 */
export function openMapPicker({
  lat,
  lon,
  query,
  title,
  searchPlaceholder,
  reference,
  radiusKm = null,
  onConfirm,
}) {
  if (typeof document === 'undefined') return;
  _build();
  _onConfirm = onConfirm;
  _radiusKm = Number.isFinite(radiusKm) && radiusKm > 0 ? radiusKm : null;
  _lastLabel = ''; // a stale name from the previous open must not leak into this one
  _r.title.textContent = title || 'Pick a location';
  _r.search.placeholder = searchPlaceholder || 'Search a place or address…';
  _r.search.value = query || '';
  _r.coords.textContent = 'Drop a pin to set coordinates';
  _hideStatus();
  _setSearching(false);
  _r.overlay.classList.remove('hidden');
  _r.overlay.setAttribute('aria-hidden', 'false');

  loadLeaflet(async () => {
    const L = window.L;
    if (!_map) {
      _map = L.map(_r.canvas).setView([20, 0], 2);
      L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution:
          '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 19,
      }).addTo(_map);
      _map.on('click', (e) => _setPoint(e.latlng.lat, e.latlng.lng));
      _map.on('move zoom', _updateOffscreen);
    }
    setTimeout(() => _map.invalidateSize(), 60); // was hidden while sizing

    if (_marker) {
      _map.removeLayer(_marker);
      _marker = null;
    }
    _setReference(null, ''); // clear any reference from a previous open
    _lat = null;
    _lon = null;
    _r.use.disabled = true;

    const hasCoords = Number.isFinite(lat) && Number.isFinite(lon);
    if (hasCoords) {
      _map.setView([lat, lon], 15);
      _setPoint(lat, lon);
    } else if (query) {
      const pt = await geocodeLocation(query);
      if (pt) {
        _map.setView(pt, 14);
        _setPoint(pt[0], pt[1]);
      } else {
        _map.setView([20, 0], 2);
      }
    }

    // Resolve and drop the reference marker without disturbing the chosen view —
    // if it's off-screen, the edge indicator makes it discoverable.
    const refPt = await _resolveRef(reference);
    if (refPt) _setReference(refPt, reference?.label);
  });
}
