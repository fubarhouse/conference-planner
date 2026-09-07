// @ts-check
// The venue, as a place rather than a line of text.
//
// The colophon lists "Postillion Hotel & Convention Centre WTC Rotterdam",
// which tells you the name and nothing about where it is. A square map above
// the particulars answers that in one glance, and costs nothing when it cannot
// be answered — no coordinates, no map, no empty box.
//
// Coordinates come from the dataset when it carries them and from the geocoder
// otherwise; `geocodeLocation` caches to localStorage and throttles, so a given
// event is looked up once ever, not once per visit.

import { loadLeaflet } from './leafletLoader.js';
import { geocodeLocation } from './geocode.js';

/** @type {any} */
let _map = null;

/**
 * The coordinates to centre on, or null when the event does not say.
 *
 * A dataset may carry them explicitly (as a pair, or as the "lat,lon" string
 * the geocoder already understands); otherwise the venue and its city are the
 * best query we have.
 *
 * @param {Record<string, any>|null} meta
 * @returns {Promise<[number, number]|null>}
 */
export async function venueCoords(meta) {
  if (!meta) return null;
  const explicit = meta.coordinates || meta.venueCoordinates || meta.geo;
  if (Array.isArray(explicit) && explicit.length === 2) {
    const pair = [Number(explicit[0]), Number(explicit[1])];
    if (pair.every(Number.isFinite)) return /** @type {[number, number]} */ (pair);
  }
  if (explicit && typeof explicit === 'object') {
    const lat = Number(explicit.lat ?? explicit.latitude);
    const lon = Number(explicit.lon ?? explicit.lng ?? explicit.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lon)) return [lat, lon];
  }
  const query = [meta.venue, meta.location, meta.country].filter(Boolean).join(', ');
  if (!query) return null;
  try {
    return await geocodeLocation(explicit && typeof explicit === 'string' ? explicit : query);
  } catch {
    return null;
  }
}

/**
 * Draw the venue map into `el`. Safe to call again — it tears the old map down.
 *
 * @param {HTMLElement} el
 * @param {[number, number]} coords
 * @param {string} label - the conference's name, shown on the pin
 * @param {string} place - what the pin marks, for the image's alt text
 */
function draw(el, coords, label, place) {
  loadLeaflet(() => {
    const L = /** @type {any} */ (window).L;
    if (!L) return;
    if (_map) {
      _map.remove();
      _map = null;
    }
    // `keyboard:false` drops the container's tabindex — this is an illustration,
    // not a control, and it should not collect a focus ring on the way past.
    _map = L.map(el, {
      zoomControl: false,
      attributionControl: false,
      scrollWheelZoom: false,
      dragging: false,
      keyboard: false,
    });
    const slug = document.body.classList.contains('theme-dark') ? 'dark_all' : 'light_all';
    L.tileLayer(`https://{s}.basemaps.cartocdn.com/${slug}/{z}/{x}/{y}{r}.png`, {
      subdomains: 'abcd',
      maxZoom: 19,
    }).addTo(_map);
    _map.setView(coords, 15);
    const pin = L.circleMarker(coords, {
      radius: 8,
      color: '#b06f12',
      weight: 3,
      fillColor: '#e2ac57',
      fillOpacity: 0.85,
      interactive: false,
    }).addTo(_map);

    // Permanent, not on hover: the map cannot be interacted with, and a phone
    // has no hover to give — a label you can only summon with a mouse would be
    // invisible exactly where this map earns its place.
    if (label) {
      pin.bindTooltip(label, {
        permanent: true,
        direction: 'top',
        offset: [0, -8],
        className: 'sch-venue-tip',
      });
    }
    el.setAttribute('aria-label', place ? `Map of ${place}` : 'Venue map');

    // On mobile this lives inside a collapsed accordion, so it is laid out at
    // zero size and Leaflet renders one grey tile. Watching the element covers
    // that and any later resize without the accordion having to know a map
    // exists.
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => _map?.invalidateSize()).observe(el);
    }
    setTimeout(() => _map?.invalidateSize(), 80);
  });
}

/**
 * @param {Record<string, any>|null} meta
 * @param {{id?: string, label?: string}} [opts] - `label` names the conference
 * @returns {Promise<boolean>} whether a map was shown
 */
export async function initVenueMap(meta, opts = {}) {
  if (typeof document === 'undefined') return false;
  const el = document.getElementById(opts.id || 'eventVenueMap');
  if (!el) return false;
  const coords = await venueCoords(meta);
  if (!coords) {
    el.hidden = true;
    return false;
  }
  el.hidden = false;
  draw(el, coords, opts.label || '', meta?.venue || meta?.location || '');
  return true;
}
