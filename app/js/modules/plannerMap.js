// Map tab for the planner — a Leaflet map of trip locations plus per-person GPX
// track upload/rendering. Leaflet is loaded on demand from a CDN and used via
// window.L. Extracted from planner.js: planner-internal collaborators are
// supplied via initMap(); escapeHtml is imported directly.

import { escapeHtml as esc } from './utils.js';
import { geocodeLocation, geocodeArea, geocodeSearch } from './geocode.js';
import { TIMELINE_COLORS } from './plannerTravel.js';

// ── Injected planner collaborators ────────────────────────────────────────────
let state;
let scheduleAutoSave;
let reportError;
let getMeLabel;

export function initMap(deps) {
  ({ state, scheduleAutoSave, reportError, getMeLabel } = deps);
}

// ── Geocoding bias helpers (used for ambiguous local-leg place names) ─────────
const _parseLatLon = (str) => {
  const m = String(str || '').match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  return m ? [parseFloat(m[1]), parseFloat(m[2])] : null;
};

// Bounding box of the given points, padded by `pad` degrees, or null if empty.
function _boxAround(pts, pad = 4) {
  if (!pts.length) return null;
  let north = -90,
    south = 90,
    east = -180,
    west = 180;
  for (const [lat, lon] of pts) {
    north = Math.max(north, lat);
    south = Math.min(south, lat);
    east = Math.max(east, lon);
    west = Math.min(west, lon);
  }
  return { north: north + pad, south: south - pad, east: east + pad, west: west - pad };
}

// The event's location as an anchor point (cached via geocodeLocation).
async function _eventAnchorPoint() {
  const meta = state?.eventMeta || {};
  const q = meta.coords || meta.location || '';
  return q ? geocodeLocation(q).catch(() => null) : null;
}

// Viewbox-biased point lookup with a tiny in-session cache. Prefers a match
// inside the trip box, falling back to a plain (global) lookup so a leg to a
// genuinely far-off place still resolves.
const _biasCache = new Map();
async function _geocodeNear(query, box) {
  if (!query) return null;
  if (!box) return geocodeLocation(query);
  const key = `${String(query).toLowerCase()}|${box.west.toFixed(1)},${box.south.toFixed(1)}`;
  if (_biasCache.has(key)) return _biasCache.get(key);
  const pt = (await geocodeSearch(query, box).catch(() => null)) || (await geocodeLocation(query));
  _biasCache.set(key, pt);
  return pt;
}

function parseGpx(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const xml = new DOMParser().parseFromString(e.target.result, 'application/xml');
        const name =
          xml.querySelector('name')?.textContent?.trim() || file.name.replace(/\.gpx$/i, '');
        // Prefer track points, fall back to route points, then waypoints
        const tags = xml.querySelectorAll('trkpt').length
          ? xml.querySelectorAll('trkpt')
          : xml.querySelectorAll('rtept').length
            ? xml.querySelectorAll('rtept')
            : xml.querySelectorAll('wpt');
        let pts = Array.from(tags)
          .map((p) => [parseFloat(p.getAttribute('lat')), parseFloat(p.getAttribute('lon'))])
          .filter(([la, lo]) => !isNaN(la) && !isNaN(lo));
        // Downsample to ≤ 800 points to keep localStorage lean. Keep every Nth
        // point (N chosen so the result is ≤ 800) — a plain modulo so it works
        // for any point count. The previous float-equality test only kept points
        // when the count was ~a multiple of 800, and otherwise collapsed the whole
        // track to a single point.
        if (pts.length > 800) {
          const step = Math.ceil(pts.length / 800);
          pts = pts.filter((_, i) => i % step === 0);
        }
        resolve(pts.length ? { name, points: pts } : null);
      } catch (err) {
        reportError('parseGpxFile', err);
        resolve(null);
      }
    };
    reader.readAsText(file);
  });
}

// Leaflet lazy loader. Exported so other surfaces (e.g. the itinerary detail
// modal's mini-map) can reuse the same single-load path.
let _leafletReady = false;
const _leafletCbs = [];
export function loadLeaflet(cb) {
  _loadLeaflet(cb);
}
function _loadLeaflet(cb) {
  if (_leafletReady) {
    cb();
    return;
  }
  _leafletCbs.push(cb);
  if (_leafletCbs.length > 1) return;
  const link = Object.assign(document.createElement('link'), {
    rel: 'stylesheet',
    href: new URL('../../vendor/leaflet-1.9.4/leaflet.css', import.meta.url).href,
  });
  document.head.appendChild(link);
  const s = Object.assign(document.createElement('script'), {
    src: new URL('../../vendor/leaflet-1.9.4/leaflet.js', import.meta.url).href,
  });
  s.onload = () => {
    _leafletReady = true;
    _leafletCbs.splice(0).forEach((f) => f());
  };
  document.head.appendChild(s);
}

let _map = null;
let _mapLayers = null; // LayerGroup for route/marker layers
let _mapTileLayer = null; // Current base tile layer (swapped on theme change)
const _gpxOnlyPersons = new Set(); // person IDs where auto-lines are hidden in favour of GPX track

function _mapTileSlug() {
  return document.body.classList.contains('theme-dark') ? 'dark_all' : 'light_all';
}

function _updateMapTheme() {
  if (!_map || !_mapTileLayer) return;
  _mapTileLayer.setUrl(`https://{s}.basemaps.cartocdn.com/${_mapTileSlug()}/{z}/{x}/{y}{r}.png`);
  // The panel background is a token now, so the stylesheet owns it.
  document.getElementById('plannerMap')?.style.removeProperty('background-color');
  // Marks and lines resolved their colours from tokens at DRAW time, so a mode
  // switch has to redraw them — otherwise light-mode marks keep a pale ring on
  // dark tiles. The layers are rebuilt from state, so this is safe to repeat.
  _renderGpxList();
  _renderMapLayers();
}

function _initMap() {
  const el = document.getElementById('plannerMap');
  if (!el) return;
  if (_map) {
    _updateMapTheme();
    setTimeout(() => _map.invalidateSize(), 50);
    return;
  }
  _map = window.L.map('plannerMap', { zoomControl: true }).setView([20, 10], 2);
  _mapTileLayer = window.L.tileLayer(
    `https://{s}.basemaps.cartocdn.com/${_mapTileSlug()}/{z}/{x}/{y}{r}.png`,
    {
      attribution:
        '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 19,
    },
  ).addTo(_map);
  _mapLayers = window.L.layerGroup().addTo(_map);
  // Swap tiles automatically when the app theme changes
  new MutationObserver(_updateMapTheme).observe(document.body, {
    attributes: true,
    attributeFilter: ['class'],
  });
}

function _clearMapLayers() {
  _mapLayers?.clearLayers();
}

// ── Map colours and marks ────────────────────────────────────────────────────
// Leaflet writes colours into SVG attributes and inline styles it builds itself,
// so it needs concrete values — a `var(--viz-3)` handed to `L.polyline` is not
// guaranteed to resolve in every path it takes. Everything below therefore reads
// the token once, at draw time, against the live document.
//
// Reading the custom property directly is not enough: a property's value is
// whatever was WRITTEN, so `--brand-1-ink` comes back as the literal string
// `oklch(from #58b2f8 clamp(...) c h)`. Instead the token is applied to a probe
// element and the COMPUTED colour read back, which is always a plain `rgb()`.
// Results are cached per mode, since this runs once per mark.
let _colorCache = new Map();
let _colorCacheMode = '';

function cssColor(token, fallback = '#000000') {
  if (typeof document === 'undefined' || !token) return fallback;
  const raw = String(token).trim();
  if (!raw.includes('var(') && !raw.includes('(')) return raw;

  const mode = document.documentElement.dataset.mode || '';
  if (mode !== _colorCacheMode) {
    _colorCache = new Map();
    _colorCacheMode = mode;
  }
  const hit = _colorCache.get(raw);
  if (hit) return hit;

  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none';
  probe.style.color = raw;
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).color || fallback;
  probe.remove();
  _colorCache.set(raw, resolved);
  return resolved;
}

const mapInk = () => cssColor('var(--ink-0)', '#1a1e1b');
const mapPaper = () => cssColor('var(--paper-1)', '#ffffff');

// Marker shapes, not marker icons.
//
// The three pins used to be identical teardrops distinguished only by a Font
// Awesome glyph inside them. With the icon font gone the SHAPE has to do that
// work — which is how paper maps have always done it. A stay is a square, a
// plan is a diamond, the conference is a square with its centre knocked out,
// and a waypoint is a numbered square because its order is the information.
function mapMark(kind, color, text = '') {
  // `color` must be a concrete value, never `currentColor`: the waypoint mark
  // sets its own `color` for the number, and a self-referential `currentColor`
  // background resolves to THAT — a white box on white paper.
  const fill = cssColor(color, mapInk());
  const paper = mapPaper();
  const size = 16;
  const base = `width:${size}px;height:${size}px;box-sizing:border-box;border:2px solid ${paper}`;
  if (kind === 'plan')
    return `<div style="${base};background:${fill};transform:rotate(45deg)"></div>`;
  // A site, not a thing you own: hollow, with a heavy edge so it holds at 16px.
  if (kind === 'conference')
    return `<div style="${base};background:${paper};box-shadow:inset 0 0 0 3px ${fill}"></div>`;
  if (kind === 'waypoint')
    return `<div style="${base};background:${fill};display:flex;align-items:center;justify-content:center;color:${paper};font:700 0.6rem/1 ui-monospace,SFMono-Regular,Menlo,monospace">${text}</div>`;
  return `<div style="${base};background:${fill}"></div>`;
}

// Render polylines and markers for one traveller's data
async function _drawTraveller({
  outboundLegs = [],
  returnLegs = [],
  localLegs = [],
  accommodations = [],
  itinerary = [],
  gpxTrack = null,
  color = 'var(--brand-1-ink)',
  label = 'Me',
  hideAutoLines = false,
}) {
  const L = window.L;
  const allPts = [];
  const skipLines = hideAutoLines && gpxTrack?.points?.length;
  // One resolution per traveller, reused by every line and mark they own.
  color = cssColor(color, '#1a1e1b');

  // Helper: resolve an ordered list of location strings to [lat,lon] pairs
  async function resolveSeq(locs) {
    const pts = await Promise.all(locs.map(geocodeLocation));
    return pts.filter(Boolean);
  }

  // Build ordered waypoint sequences for outbound and return legs
  const outboundLocs = [];
  for (const leg of outboundLegs) {
    if (!outboundLocs.length && leg.from) outboundLocs.push(leg.from);
    if (leg.to) outboundLocs.push(leg.to);
  }
  const returnLocs = [];
  for (const leg of returnLegs) {
    if (!returnLocs.length && leg.from) returnLocs.push(leg.from);
    if (leg.to) returnLocs.push(leg.to);
  }
  const [outboundPts, returnPts] = await Promise.all([
    resolveSeq(outboundLocs),
    resolveSeq(returnLocs),
  ]);

  // Shared popup card wrapper
  function popupCard(title, subtitle, meta) {
    // Leaflet builds the popup outside our stylesheet's reach, so the type is
    // set inline — from the same tokens, not from a second palette.
    const ink = mapInk();
    const quiet = cssColor('var(--ink-2)', '#6e7568');
    return `<div class="map-popup" style="min-width:140px;line-height:1.4">
      <div style="font-family:var(--font-display);font-size:0.95rem;font-weight:600;color:${ink}">${title}</div>
      ${subtitle ? `<div style="font-size:0.78rem;color:${quiet};margin-top:2px">${subtitle}</div>` : ''}
      ${meta ? `<div style="font-family:var(--font-data);font-size:0.72rem;color:${quiet};margin-top:2px">${meta}</div>` : ''}
    </div>`;
  }

  // Departure circle marker (white-stroked so it sits above the tile cleanly)
  function departureMarker(pt, loc, role) {
    return L.circleMarker(pt, {
      radius: 5,
      color: mapPaper(),
      fillColor: color,
      fillOpacity: 1,
      weight: 2,
    }).bindPopup(popupCard(esc(label), esc(loc || ''), role));
  }

  if (!skipLines) {
    // Outbound: solid, heaviest weight
    if (outboundPts.length >= 2) {
      L.polyline(outboundPts, { color, weight: 3, opacity: 0.85 })
        .bindTooltip(`${esc(label)}: outbound`, { sticky: true })
        .addTo(_mapLayers);
      departureMarker(outboundPts[0], outboundLocs[0], 'Outbound departure').addTo(_mapLayers);
    }
    // Return: dashed, medium weight
    if (returnPts.length >= 2) {
      L.polyline(returnPts, { color, weight: 2.5, opacity: 0.7, dashArray: '8 5' })
        .bindTooltip(`${esc(label)}: return`, { sticky: true })
        .addTo(_mapLayers);
      departureMarker(returnPts[0], returnLocs[0], 'Return departure').addTo(_mapLayers);
    }
  }
  allPts.push(...outboundPts, ...returnPts);

  // Local "getting around" trips: each leg is its own thin dotted amber hop
  // (trains, taxis, cable cars while in the area) — not part of the main route.
  // Local legs are usually short city/station names that are highly ambiguous
  // globally ("Nara" is in Japan *and* the US). Bias them to where the trip
  // actually is — a box around the already-resolved flight/accommodation points
  // (plus the event location) — so they land in the right country.
  if (!skipLines && localLegs.length) {
    const anchors = [...outboundPts, ...returnPts];
    for (const acc of accommodations) {
      const pt = _parseLatLon(acc.coords);
      if (pt) anchors.push(pt);
    }
    const eventPt = await _eventAnchorPoint();
    if (eventPt) anchors.push(eventPt);
    const tripBox = _boxAround(anchors, 4);
    for (const leg of localLegs) {
      if (!leg.from || !leg.to) continue;
      const [a, z] = await Promise.all([
        _geocodeNear(leg.from, tripBox),
        _geocodeNear(leg.to, tripBox),
      ]);
      if (a && z) {
        L.polyline([a, z], { color, weight: 2, opacity: 0.6, dashArray: '1 6' })
          .bindTooltip(`${esc(label)}: ${esc(leg.from)} → ${esc(leg.to)}`, { sticky: true })
          .addTo(_mapLayers);
        allPts.push(a, z);
      }
    }
  }

  // Draw accommodation markers; collect resolved points per accommodation for connectors
  const accomSeqs = [];
  for (const acc of accommodations) {
    const entries =
      acc.type === 'waypoints'
        ? (acc.stops || [])
            .map((cl) => ({
              name: cl.location || '',
              query: cl.coords || cl.location,
              date: cl.date || '',
            }))
            .filter((e) => e.query)
        : [{ name: acc.name || '', query: acc.coords || acc.address || acc.name }].filter(
            (e) => e.query,
          );
    const resolved = await Promise.all(entries.map((e) => geocodeLocation(e.query)));
    const validEntries = entries.map((e, i) => ({ ...e, pt: resolved[i] })).filter((e) => e.pt);
    for (let i = 0; i < validEntries.length; i++) {
      const { name, pt, date } = validEntries[i];
      let icon;
      if (acc.type === 'waypoints') {
        // A numbered square — the stop's order is the information.
        icon = L.divIcon({
          html: mapMark('waypoint', color, String(i + 1)),
          className: '',
          iconAnchor: [8, 8],
        });
      } else {
        // A square: somewhere you stay.
        icon = L.divIcon({ html: mapMark('stay', color), className: '', iconAnchor: [8, 8] });
      }
      const popup =
        acc.type === 'waypoints'
          ? popupCard(esc(name || `Stop ${i + 1}`), date || null, esc(acc.name || 'Waypoint'))
          : popupCard(esc(acc.name || 'Accommodation'), esc(label), null);
      L.marker(pt, { icon }).bindPopup(popup).addTo(_mapLayers);
    }
    const pts = validEntries.map((e) => e.pt);
    if (!skipLines && acc.type === 'waypoints' && pts.length >= 2) {
      // Dotted line — clearly distinct rhythm from the dashed return flight
      L.polyline(pts, { color, weight: 3, opacity: 0.8, dashArray: '2 8' })
        .bindTooltip(`${esc(label)}: ${esc(acc.name || 'Waypoint')}`, { sticky: true })
        .addTo(_mapLayers);
    }
    if (pts.length) accomSeqs.push(pts);
    allPts.push(...pts);
  }

  // Itinerary items with a location — a teardrop pin per activity (coords win over
  // a geocoded location string). Matches the accommodation/waypoint marker style.
  const itinEntries = (itinerary || [])
    .map((it) => ({ it, query: it.coords || it.location }))
    .filter((e) => e.query);
  if (itinEntries.length) {
    const itinPts = await Promise.all(itinEntries.map((e) => geocodeLocation(e.query)));
    itinEntries.forEach((e, i) => {
      const pt = itinPts[i];
      if (!pt) return;
      // A diamond: something you plan to do.
      const icon = L.divIcon({ html: mapMark('plan', color), className: '', iconAnchor: [8, 8] });
      const when = [e.it.date, e.it.time].filter(Boolean).join(' ');
      L.marker(pt, { icon })
        .bindPopup(popupCard(esc(e.it.title || 'Itinerary item'), esc(when || ''), esc(label)))
        .addTo(_mapLayers);
      allPts.push(pt);
    });
  }

  if (!skipLines) {
    // Connector segments: thin ghost lines bridging flight endpoints to accommodation
    let bridgePrev = outboundPts.length ? outboundPts[outboundPts.length - 1] : null;
    for (const pts of accomSeqs) {
      if (!pts.length) continue;
      if (bridgePrev) {
        L.polyline([bridgePrev, pts[0]], {
          color,
          weight: 1.5,
          opacity: 0.35,
          dashArray: '3 5',
        }).addTo(_mapLayers);
      }
      bridgePrev = pts[pts.length - 1];
    }
    if (bridgePrev && returnPts.length) {
      L.polyline([bridgePrev, returnPts[0]], {
        color,
        weight: 1.5,
        opacity: 0.35,
        dashArray: '3 5',
      }).addTo(_mapLayers);
    }
  }

  // GPX track
  if (gpxTrack?.points?.length) {
    L.polyline(gpxTrack.points, { color, weight: 3.5, opacity: 0.6 })
      .bindTooltip(`${esc(label)} GPX: ${esc(gpxTrack.name)}`, { sticky: true })
      .addTo(_mapLayers);
    allPts.push(...gpxTrack.points);
  }

  return allPts;
}

async function _renderMapLayers() {
  if (!_map || !_mapLayers) return;
  _clearMapLayers();
  const mode = state.planner.mode || 'personal';
  const personal = state.planner.personal;
  const org = state.planner.org;
  const allPoints = [];

  if (mode === 'personal') {
    const meColor = cssColor('var(--brand-1-ink)', '#1a5ebb');
    const mePts = await _drawTraveller({
      outboundLegs: personal?.outboundLegs || [],
      returnLegs: personal?.returnLegs || [],
      localLegs: personal?.showLocalTravel ? personal?.localLegs || [] : [],
      accommodations: personal?.accommodations || [],
      itinerary: personal?.itinerary || [],
      gpxTrack: personal?.gpxTrack || null,
      color: meColor,
      label: getMeLabel(),
      hideAutoLines: _gpxOnlyPersons.has('__me__'),
    });
    allPoints.push(...mePts);

    const contacts = state.global?.personalContacts || [];
    const meContactId = personal?.meContactId || null;
    const assignments = personal?.tripAssignments || [];
    for (let i = 0; i < assignments.length; i++) {
      const a = assignments[i];
      if (a.memberId === meContactId) continue; // already drawn as "Me"
      const contact = contacts.find((c) => c.id === a.memberId);
      if (!contact) continue;
      const color = TIMELINE_COLORS[(i + 1) % TIMELINE_COLORS.length].border;
      const compAccoms = (personal?.accommodations || []).filter((acc) =>
        (acc.assignments || []).some((s) => s.memberId === a.memberId),
      );
      const pts = await _drawTraveller({
        outboundLegs: a.outboundLegs || [],
        returnLegs: a.returnLegs || [],
        accommodations: compAccoms,
        gpxTrack: a.gpxTrack || null,
        color,
        label: contact.name || 'Unnamed',
        hideAutoLines: _gpxOnlyPersons.has(a.memberId),
      });
      allPoints.push(...pts);
    }
    // Local companions with flights
    const locals = personal?.localCompanions || [];
    for (let i = 0; i < locals.length; i++) {
      const lc = locals[i];
      if (lc.id === meContactId) continue;
      if (!(lc.outboundLegs?.length || lc.returnLegs?.length)) continue;
      const color = TIMELINE_COLORS[(assignments.length + i + 1) % TIMELINE_COLORS.length].border;
      const lcAccoms = (personal?.accommodations || []).filter((acc) =>
        (acc.assignments || []).some((s) => s.memberId === lc.id),
      );
      const pts = await _drawTraveller({
        outboundLegs: lc.outboundLegs || [],
        returnLegs: lc.returnLegs || [],
        accommodations: lcAccoms,
        gpxTrack: lc.gpxTrack || null,
        color,
        label: `${lc.name || 'Unnamed'} (this trip)`,
        hideAutoLines: _gpxOnlyPersons.has(lc.id),
      });
      allPoints.push(...pts);
    }
  } else {
    // Sponsor mode: each team assignment
    const members = state.global?.teamMembers || [];
    const assignments = org?.teamAssignments || [];
    for (let i = 0; i < assignments.length; i++) {
      const a = assignments[i];
      const member = members.find((m) => m.id === a.memberId);
      if (!member) continue;
      const color = TIMELINE_COLORS[i % TIMELINE_COLORS.length].border;
      const memberAccoms = (org?.accommodations || []).filter((acc) =>
        (acc.assignments || []).some((s) => s.memberId === a.memberId),
      );
      const pts = await _drawTraveller({
        outboundLegs: a.outboundLegs || [],
        returnLegs: a.returnLegs || [],
        accommodations: memberAccoms,
        gpxTrack: a.gpxTrack || null,
        color,
        label: member.name || 'Unnamed',
        hideAutoLines: _gpxOnlyPersons.has(a.memberId),
      });
      allPoints.push(...pts);
    }
  }

  // Conference marker when a schedule is associated. Precise coordinates —
  // author-set on the event, or a resolved venue — get a teardrop pin consistent
  // with the accommodation markers. When only the city resolves, we outline it as
  // a translucent region instead, signalling that we know the city but not the
  // exact venue.
  const meta = state.eventMeta || {};
  const venueName = meta.venue || '';
  const venueCity = meta.location || '';
  // The conference is the one fixed point on the map; it wears the accent that
  // means "this event" everywhere else in the product.
  const CONF_COLOR = cssColor('var(--brand-1-ink)', '#1a5ebb');
  if (venueName || venueCity) {
    const L = window.L;
    const confLabel = venueName ? `${venueName}${venueCity ? `, ${venueCity}` : ''}` : venueCity;
    const confPopup = (title, sub) =>
      `<div style="font-family:system-ui,-apple-system,sans-serif;min-width:130px;line-height:1.45;padding:1px 0">
        <div style="font-size:0.8rem;font-weight:600;color:#1f2937">${title}</div>
        <div style="font-size:0.7rem;color:#4b5563;margin-top:2px">${sub}</div>
      </div>`;

    // 1) author-provided coordinates (optional), else 2) a resolved precise venue.
    let precisePt = null;
    const lat = Number(meta.latitude);
    const lon = Number(meta.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      precisePt = [lat, lon];
    } else if (venueName) {
      precisePt =
        (await geocodeLocation(venueCity ? `${venueName}, ${venueCity}` : venueName)) || null;
    }

    if (precisePt) {
      // A knocked-out square: the reason the trip exists.
      const icon = L.divIcon({
        html: mapMark('conference', CONF_COLOR),
        className: '',
        iconAnchor: [8, 8],
      });
      L.marker(precisePt, { icon })
        .bindPopup(confPopup(esc(confLabel), 'Conference venue'))
        .addTo(_mapLayers);
      allPoints.push(precisePt);
    } else if (venueCity) {
      // City-only fallback — outline the city as a region.
      const area = await geocodeArea(venueCity);
      const g = area?.geojson;
      const regionStyle = {
        color: CONF_COLOR,
        weight: 2,
        opacity: 0.85,
        fillColor: CONF_COLOR,
        fillOpacity: 0.12,
      };
      if (g && (g.type === 'Polygon' || g.type === 'MultiPolygon')) {
        const layer = L.geoJSON(g, { style: regionStyle })
          .bindPopup(confPopup(esc(venueCity), 'Conference city (approx.)'))
          .addTo(_mapLayers);
        const b = layer.getBounds();
        if (b?.isValid()) allPoints.push([b.getNorth(), b.getEast()], [b.getSouth(), b.getWest()]);
      } else if (area?.point) {
        // No boundary available — a soft circle stands in for the region.
        L.circle(area.point, { radius: 4000, ...regionStyle })
          .bindPopup(confPopup(esc(venueCity), 'Conference city (approx.)'))
          .addTo(_mapLayers);
        allPoints.push(area.point);
      }
    }
  }

  if (allPoints.length) {
    try {
      _map.fitBounds(window.L.latLngBounds(allPoints), { padding: [40, 40], maxZoom: 14 });
    } catch {
      /* invalid bounds (e.g. no points) → leave map as-is */
    }
  }

  // Show empty state when there's nothing to plot
  document.getElementById('mapEmptyState')?.classList.toggle('hidden', allPoints.length > 0);
}

function _renderGpxList() {
  const el = document.getElementById('mapGpxList');
  if (!el) return;
  const mode = state.planner.mode || 'personal';
  const personal = state.planner.personal;

  const rows = [];

  if (mode === 'personal') {
    const meTrack = personal?.gpxTrack;
    rows.push({ id: '__me__', label: getMeLabel(), color: 'var(--brand-1-ink)', track: meTrack });
    const contacts = state.global?.personalContacts || [];
    const meContactId = personal?.meContactId || null;
    const assignments = personal?.tripAssignments || [];
    assignments.forEach((a, i) => {
      if (a.memberId === meContactId) return; // already listed as "Me"
      const c = contacts.find((x) => x.id === a.memberId);
      if (!c) return;
      rows.push({
        id: a.memberId,
        label: c.name || 'Unnamed',
        color: TIMELINE_COLORS[(i + 1) % TIMELINE_COLORS.length].border,
        track: a.gpxTrack || null,
      });
    });
    (personal?.localCompanions || []).forEach((lc, i) => {
      if (lc.id === meContactId) return;
      rows.push({
        id: lc.id,
        label: `${lc.name || 'Unnamed'} (this trip)`,
        color: TIMELINE_COLORS[(assignments.length + i + 1) % TIMELINE_COLORS.length].border,
        track: lc.gpxTrack || null,
      });
    });
  } else {
    const members = state.global?.teamMembers || [];
    const assignments = state.planner.org?.teamAssignments || [];
    assignments.forEach((a, i) => {
      const m = members.find((x) => x.id === a.memberId);
      if (!m) return;
      rows.push({
        id: a.memberId,
        label: m.name || 'Unnamed',
        color: TIMELINE_COLORS[i % TIMELINE_COLORS.length].border,
        track: a.gpxTrack || null,
      });
    });
  }

  if (!rows.length) {
    el.innerHTML =
      '<p class="map-person__empty">No travellers yet. Add travel legs or team members first.</p>';
    return;
  }

  el.innerHTML = rows
    .map((row) => {
      const gpxOnly = _gpxOnlyPersons.has(row.id);
      // Identity on one line, actions on the next. Side by side, a long name
      // and three verbs fought for a 17rem panel and something always had to
      // scroll; stacked, neither can crowd the other.
      return `<div class="map-person" data-gpx-person-id="${esc(row.id)}">
      <div class="map-person__who">
        <span class="map-person__swatch" aria-hidden="true" style="background:${esc(cssColor(row.color))}"></span>
        <div class="min-w-0">
          <div class="map-person__name truncate">${esc(row.label)}</div>
          ${
            row.track
              ? `<div class="map-person__track truncate">${esc(row.track.name)} · ${row.track.points.length.toLocaleString()} pts</div>`
              : `<div class="map-person__track">No GPX track</div>`
          }
        </div>
      </div>
      <div class="map-person__acts">${
        row.track
          ? // No "Replace": it and Remove were two names for the same decision.
            // Remove clears the track and the row falls back to Upload, which is
            // the same two clicks and one less thing to reason about.
            `<button type="button" class="map-act map-gpx-only-btn${gpxOnly ? ' is-on' : ''}" data-gpx-person-id="${esc(row.id)}" aria-pressed="${gpxOnly}">${gpxOnly ? 'Track only' : 'Track'}</button>
         <button type="button" class="map-act map-gpx-download-btn" data-gpx-person-id="${esc(row.id)}" aria-label="Download GPX track for ${esc(row.label)}">Download</button>
         <button type="button" class="map-act map-act--del map-gpx-remove-btn" data-gpx-person-id="${esc(row.id)}" aria-label="Remove GPX track for ${esc(row.label)}">Remove</button>`
          : `<button type="button" class="map-act map-gpx-upload-btn" data-gpx-person-id="${esc(row.id)}" aria-label="Upload a GPX track for ${esc(row.label)}">Upload GPX</button>`
      }</div>
    </div>`;
    })
    .join('');
}

export function renderMapTab() {
  _loadLeaflet(() => {
    _initMap();
    _renderGpxList();
    _renderMapLayers();
  });
}

export function wireMapPanel() {
  const panel = document.getElementById('plannerMapPanel');
  if (!panel) return;
  const fileInput = document.getElementById('mapGpxFileInput');

  panel.addEventListener('click', (e) => {
    const legendToggle = e.target.closest('#mapLegendToggle');
    if (legendToggle) {
      const body = document.getElementById('mapLegendBody');
      const open = body?.classList.toggle('hidden') === false;
      // The caret is rotated from `aria-expanded` now, so the state the
      // stylesheet reads is the same one assistive tech reads.
      legendToggle.setAttribute('aria-expanded', String(open));
      return;
    }
    const uploadBtn = e.target.closest('.map-gpx-upload-btn');
    if (uploadBtn && fileInput) {
      fileInput.dataset.gpxPersonId = uploadBtn.dataset.gpxPersonId;
      fileInput.value = '';
      fileInput.click();
      return;
    }
    const gpxOnlyBtn = e.target.closest('.map-gpx-only-btn');
    if (gpxOnlyBtn) {
      const personId = gpxOnlyBtn.dataset.gpxPersonId;
      if (_gpxOnlyPersons.has(personId)) _gpxOnlyPersons.delete(personId);
      else _gpxOnlyPersons.add(personId);
      _renderGpxList();
      _renderMapLayers();
      return;
    }
    const downloadBtn = e.target.closest('.map-gpx-download-btn');
    if (downloadBtn) {
      _downloadGpx(downloadBtn.dataset.gpxPersonId);
      return;
    }
    const removeBtn = e.target.closest('.map-gpx-remove-btn');
    if (removeBtn) {
      const personId = removeBtn.dataset.gpxPersonId;
      _setGpxTrack(personId, null);
      _gpxOnlyPersons.delete(personId);
      _renderGpxList();
      _renderMapLayers();
    }
  });

  fileInput?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const personId = fileInput.dataset.gpxPersonId;
    const track = await parseGpx(file);
    if (!track) {
      window.alert('Could not parse GPX file — no track points found.');
      return;
    }
    _setGpxTrack(personId, track);
    scheduleAutoSave();
    _renderGpxList();
    _renderMapLayers();
  });
}

// Resolve a person's stored GPX track (mirrors _setGpxTrack).
function _gpxTrackFor(personId) {
  const mode = state.planner.mode || 'personal';
  if (mode === 'personal') {
    if (personId === '__me__') return state.planner.personal?.gpxTrack || null;
    const a = (state.planner.personal?.tripAssignments || []).find((x) => x.memberId === personId);
    if (a?.gpxTrack) return a.gpxTrack;
    const lc = (state.planner.personal?.localCompanions || []).find((x) => x.id === personId);
    return lc?.gpxTrack || null;
  }
  const a = (state.planner.org?.teamAssignments || []).find((x) => x.memberId === personId);
  return a?.gpxTrack || null;
}

// Regenerate a GPX file from the stored points (the original upload isn't kept —
// only the parsed, downsampled track) and download it.
function _downloadGpx(personId) {
  const track = _gpxTrackFor(personId);
  if (!track?.points?.length) return;
  const name = track.name || 'track';
  const pts = track.points
    .map(([lat, lon]) => `      <trkpt lat="${lat}" lon="${lon}"></trkpt>`)
    .join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Conference Planner" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${esc(name)}</name>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>
`;
  const url = URL.createObjectURL(new Blob([xml], { type: 'application/gpx+xml' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name.replace(/[^a-z0-9._-]+/gi, '-')}.gpx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function _setGpxTrack(personId, track) {
  const mode = state.planner.mode || 'personal';
  if (mode === 'personal') {
    if (personId === '__me__') {
      state.planner.personal.gpxTrack = track;
    } else {
      const a = (state.planner.personal?.tripAssignments || []).find(
        (x) => x.memberId === personId,
      );
      if (a) {
        a.gpxTrack = track;
        return;
      }
      const lc = (state.planner.personal?.localCompanions || []).find((x) => x.id === personId);
      if (lc) lc.gpxTrack = track;
    }
  } else {
    const a = (state.planner.org?.teamAssignments || []).find((x) => x.memberId === personId);
    if (a) a.gpxTrack = track;
  }
}

// Static shell for this tab panel — injected into #plannerMapPanel at boot (#7 co-location).
export function mapPanelHtml() {
  // The legend is a KEY, so each entry shows the mark it is naming — the same
  // shape the map draws, built by the same helper. It used to show a Font
  // Awesome glyph that only resembled the marker.
  const key = (mark, label) =>
    `<div class="map-key__row"><span class="map-key__mark">${mark}</span><span>${label}</span></div>`;
  const line = (attrs) =>
    `<svg width="26" height="8" aria-hidden="true"><line x1="0" y1="4" x2="26" y2="4" stroke="currentColor" ${attrs}/></svg>`;

  return `
          <div class="relative" id="mapWrapper">
            <div id="plannerMap" class="absolute inset-0"></div>

            <!-- Empty state: shown when no travel data is plotted -->
            <div id="mapEmptyState" class="hidden absolute inset-0 z-[1000] flex flex-col items-center justify-center pointer-events-none">
              <p class="map-empty__t">No travel data yet</p>
              <p class="map-empty__s">Add flights and accommodation in Planner<br>to see your route here.</p>
            </div>

            <!-- Legend -->
            <div id="mapLegendCard" class="absolute top-3 right-3 z-[1001]">
              <button id="mapLegendToggle" type="button" class="map-card__head" aria-expanded="false">
                <span class="map-eyebrow">Legend</span>
                <span id="mapLegendChevron" aria-hidden="true">&#9662;</span>
              </button>
              <div id="mapLegendBody" class="hidden map-card__body">
                ${key(line('stroke-width="2.5"'), 'Outbound')}
                ${key(line('stroke-width="2" stroke-dasharray="5 3"'), 'Return')}
                ${key(line('stroke-width="2.5" stroke-dasharray="1.5 5"'), 'Waypoint route')}
                ${key(mapMark('stay', 'var(--ink-1)'), 'Accommodation')}
                ${key(mapMark('plan', 'var(--ink-1)'), 'Itinerary item')}
                ${key(mapMark('conference', 'var(--brand-1-ink)'), 'Conference venue')}
                ${key(mapMark('waypoint', 'var(--ink-1)', '1'), 'Waypoint stop')}
              </div>
            </div>

            <!-- Traveller layer controls -->
            <div id="mapTravellersCard" class="absolute bottom-8 left-3 z-[1001]">
              <div class="map-card__head" id="mapTravellersHeader">
                <span class="map-eyebrow">Travellers</span>
              </div>
              <div id="mapGpxList" class="map-card__body"></div>
            </div>
          </div>
          <input type="file" id="mapGpxFileInput" accept=".gpx" class="hidden">
        `;
}
