// Location → [lat, lon] resolution for the planner's map tab.
//
// Resolution order: direct "lat,lon" text → IATA airport code → UN/LOCODE →
// on-disk cache → Nominatim (OpenStreetMap) API. Network lookups are queued and
// throttled to one request per THROTTLE_MS to respect Nominatim's usage policy.
// Results are cached in localStorage (via the storage registry) so a location is
// only ever fetched once. This module owns the cache + queue; callers just await
// geocodeLocation(query).

import { STORAGE_KEYS, readJson, writeJson } from './plannerStorage.js';

const NOMINATIM_SEARCH = 'https://nominatim.openstreetmap.org/search';
const OPEN_METEO_GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search';
const THROTTLE_MS = 1100; // Nominatim asks for ≤ 1 request/second; 1.1s is safe.

// Top ~200 IATA airport codes → [lat, lon]
const IATA_COORDS = {
  // Australia / NZ
  SYD: [-33.9461, 151.1772],
  MEL: [-37.669, 144.841],
  BNE: [-27.3842, 153.1175],
  PER: [-31.9403, 115.9669],
  ADL: [-34.945, 138.5301],
  CBR: [-35.3069, 149.1951],
  HBA: [-42.8361, 147.5078],
  OOL: [-28.1644, 153.5044],
  CNS: [-16.8858, 145.7452],
  DRW: [-12.4147, 130.8765],
  AKL: [-37.0082, 174.785],
  CHC: [-43.4894, 172.5322],
  WLG: [-41.3272, 174.8052],
  // USA
  JFK: [40.6413, -73.7781],
  LAX: [33.9425, -118.4081],
  ORD: [41.9742, -87.9073],
  ATL: [33.6407, -84.4277],
  DFW: [32.8998, -97.0403],
  DEN: [39.8561, -104.6737],
  SFO: [37.6213, -122.379],
  LAS: [36.084, -115.1537],
  MIA: [25.7959, -80.287],
  PHX: [33.4373, -112.0078],
  SEA: [47.4502, -122.3088],
  IAH: [29.9902, -95.3368],
  MSP: [44.8848, -93.2223],
  DTW: [42.2124, -83.3534],
  BOS: [42.3656, -71.0096],
  FLL: [26.0726, -80.1527],
  MCO: [28.4312, -81.3081],
  EWR: [40.6895, -74.1745],
  PDX: [45.5898, -122.5951],
  SLC: [40.7899, -111.9791],
  DCA: [38.8521, -77.0377],
  IAD: [38.9531, -77.4565],
  CLT: [35.214, -80.9431],
  PHL: [39.8744, -75.2424],
  TPA: [27.9755, -82.5332],
  MDW: [41.7868, -87.7522],
  LGA: [40.7772, -73.8726],
  SNA: [33.6757, -117.8676],
  OAK: [37.7213, -122.2208],
  BWI: [39.1754, -76.6683],
  MKE: [42.9472, -87.8966],
  STL: [38.7487, -90.37],
  BNA: [36.1245, -86.6782],
  AUS: [30.1945, -97.6699],
  RDU: [35.8776, -78.7875],
  SMF: [38.6954, -121.5908],
  SAN: [32.7338, -117.1933],
  MSY: [29.9934, -90.258],
  // Canada
  YVR: [49.1947, -123.1792],
  YYZ: [43.6777, -79.6248],
  YUL: [45.4706, -73.7408],
  YYC: [51.1215, -114.0132],
  YEG: [53.3097, -113.5797],
  YOW: [45.3225, -75.6692],
  YHZ: [44.8808, -63.5086],
  YWG: [49.91, -97.2398],
  // UK / Ireland
  LHR: [51.4775, -0.4614],
  LGW: [51.1537, -0.1821],
  MAN: [53.3537, -2.275],
  EDI: [55.95, -3.3725],
  DUB: [53.4213, -6.27],
  BHX: [52.4539, -1.748],
  GLA: [55.8642, -4.433],
  STN: [51.885, 0.235],
  // Europe
  CDG: [49.0097, 2.5479],
  ORY: [48.7233, 2.3794],
  AMS: [52.3086, 4.7639],
  FRA: [50.0379, 8.5622],
  MUC: [48.3537, 11.775],
  TXL: [52.5597, 13.2877],
  BER: [52.3667, 13.5033],
  ZRH: [47.4647, 8.5492],
  VIE: [48.1103, 16.5697],
  BCN: [41.2971, 2.0785],
  MAD: [40.4936, -3.5668],
  LIS: [38.7756, -9.1354],
  FCO: [41.8003, 12.2389],
  MXP: [45.6306, 8.7281],
  ATH: [37.9364, 23.9445],
  CPH: [55.618, 12.656],
  OSL: [60.1939, 11.1004],
  ARN: [59.6519, 17.9186],
  HEL: [60.3172, 24.9633],
  BRU: [50.901, 4.4844],
  DUS: [51.2895, 6.7668],
  HAM: [53.6303, 10.0065],
  WAW: [52.1657, 20.9671],
  PRG: [50.1008, 14.26],
  BUD: [47.4298, 19.2612],
  OTP: [44.5711, 26.0858],
  SOF: [42.6967, 23.4114],
  RIG: [56.9236, 23.9711],
  TLL: [59.4133, 24.8328],
  VNO: [54.6341, 25.2858],
  KBP: [50.345, 30.8947],
  SVO: [55.9726, 37.4146],
  DME: [55.4088, 37.9063],
  LED: [59.8003, 30.2625],
  // Middle East
  DXB: [25.2528, 55.3644],
  DOH: [25.2609, 51.6138],
  AUH: [24.433, 54.6511],
  AMM: [31.7226, 35.9932],
  BEY: [33.8209, 35.4883],
  KWI: [29.2267, 47.9689],
  BAH: [26.2708, 50.6336],
  MCT: [23.5931, 58.2844],
  // Asia
  NRT: [35.7647, 140.3864],
  HND: [35.5494, 139.7798],
  KIX: [34.4347, 135.244],
  NGO: [34.8583, 136.805],
  FUK: [33.5853, 130.4511],
  CTS: [42.7752, 141.6922],
  ICN: [37.4692, 126.4505],
  GMP: [37.5663, 126.7914],
  PUS: [35.1795, 128.9386],
  PVG: [31.1434, 121.8052],
  PEK: [40.0799, 116.6031],
  PKX: [39.5098, 116.4106],
  CAN: [23.3924, 113.2988],
  SZX: [22.6393, 113.8107],
  SHA: [31.1979, 121.3362],
  CTU: [30.5785, 103.9469],
  HKG: [22.308, 113.9185],
  MFM: [22.1496, 113.5916],
  TPE: [25.0777, 121.2325],
  BKK: [13.6811, 100.7475],
  DMK: [13.9126, 100.6067],
  SIN: [1.3644, 103.9915],
  KUL: [2.7456, 101.7099],
  CGK: [-6.1256, 106.6559],
  DPS: [-8.7482, 115.1672],
  MNL: [14.5086, 121.0195],
  HAN: [21.2187, 105.8047],
  SGN: [10.8188, 106.652],
  RGN: [16.9073, 96.1332],
  BOM: [19.0887, 72.8679],
  DEL: [28.5562, 77.1],
  BLR: [13.1986, 77.7066],
  MAA: [12.99, 80.1693],
  HYD: [17.2403, 78.4294],
  CCU: [22.6547, 88.4467],
  CMB: [7.18, 79.8841],
  KTM: [27.6966, 85.3591],
  DAC: [23.8433, 90.3979],
  // Latin America
  GRU: [-23.4356, -46.4731],
  GIG: [-22.81, -43.2506],
  BSB: [-15.8711, -47.9186],
  EZE: [-34.8222, -58.5358],
  AEP: [-34.5592, -58.4156],
  SCL: [-33.393, -70.7858],
  LIM: [-12.0219, -77.1143],
  BOG: [4.7016, -74.1469],
  MDE: [6.1645, -75.4231],
  MEX: [19.4363, -99.0721],
  CUN: [21.0365, -86.8771],
  GDL: [20.5218, -103.3106],
  PTY: [9.0714, -79.3835],
  SJO: [9.9939, -84.2088],
  // Africa
  JNB: [-26.1392, 28.246],
  CPT: [-33.9648, 18.6017],
  NBO: [-1.3192, 36.9275],
  ADD: [8.9779, 38.7993],
  LOS: [6.5774, 3.3214],
  CAI: [30.1219, 31.4056],
  CMN: [33.3675, -7.59],
  ACC: [5.6052, -0.1668],
  DAR: [-6.878, 39.2026],
  // Pacific
  HNL: [21.3187, -157.9224],
  GUM: [13.4834, 144.796],
  NAN: [-17.7554, 177.4434],
  PPT: [-17.5534, -149.6066],
};

function loadCache() {
  return readJson(STORAGE_KEYS.geocodeCache, {});
}

function saveCache(cache) {
  writeJson(STORAGE_KEYS.geocodeCache, cache);
}

// Queued Nominatim lookups, drained one per THROTTLE_MS.
const _queue = [];
let _timer = null;

function drainQueue() {
  if (!_queue.length) {
    _timer = null;
    return;
  }
  const { query, cacheKey, countrycodes, polygon, resolve } = _queue.shift();
  const key = cacheKey || query;
  const cache = loadCache();
  if (cache[key]) {
    resolve(cache[key]);
    _timer = setTimeout(drainQueue, 0);
    return;
  }
  let url = `${NOMINATIM_SEARCH}?q=${encodeURIComponent(query)}&format=json&limit=1`;
  if (countrycodes) url += `&countrycodes=${encodeURIComponent(countrycodes)}`;
  // Area lookups ask Nominatim for a simplified boundary polygon so the map can
  // outline the city as a region rather than drop a single point.
  if (polygon) url += '&polygon_geojson=1&polygon_threshold=0.005';
  fetch(url)
    .then((r) => r.json())
    .then(async (data) => {
      if (data?.[0]) {
        const pt = [parseFloat(data[0].lat), parseFloat(data[0].lon)];
        const result = polygon ? { point: pt, geojson: data[0].geojson || null } : pt;
        const c = loadCache();
        c[key] = result;
        saveCache(c);
        resolve(result);
      } else {
        resolve(await _fallbackGeocode(query, key, polygon, countrycodes));
      }
    })
    .catch(async () => resolve(await _fallbackGeocode(query, key, polygon, countrycodes)))
    .finally(() => {
      _timer = setTimeout(drainQueue, THROTTLE_MS);
    });
}

// Fallback provider for when Nominatim is blocked, rate-limited, or finds nothing.
// Open-Meteo geocoding is on a different domain with permissive CORS (already used
// by the weather feature). It matches place NAMES rather than addresses/POIs, so
// we try the whole query then its comma-segments — a venue string usually contains
// a city that resolves. Point lookups only; area/polygon requests don't fall back.
async function _fallbackGeocode(query, key, polygon, countrycodes) {
  if (polygon) return null;
  // Open-Meteo matches place names (cities/towns), so prefer the city/region
  // segments — which usually follow the venue — before the venue name and the
  // full string.
  const parts = String(query)
    .split(',')
    .map((s) => s.trim());
  const names = [...parts.slice(1), parts[0], query].filter(
    (v, i, arr) => v && arr.indexOf(v) === i,
  );
  for (const name of names) {
    try {
      let url = `${OPEN_METEO_GEOCODE}?name=${encodeURIComponent(name)}&count=1`;
      if (countrycodes)
        url += `&countryCode=${encodeURIComponent(String(countrycodes).toUpperCase())}`;
      const data = await fetch(url).then((r) => r.json());
      const hit = data?.results?.[0];
      if (hit && Number.isFinite(hit.latitude) && Number.isFinite(hit.longitude)) {
        const pt = [hit.latitude, hit.longitude];
        const c = loadCache();
        c[key] = pt;
        saveCache(c);
        return pt;
      }
    } catch {
      /* try the next candidate, else give up */
    }
  }
  return null;
}

function enqueue(item) {
  _queue.push(item);
  if (!_timer) _timer = setTimeout(drainQueue, 0);
}

// Resolve a location string to [lat, lon] or null.
export function geocodeLocation(query) {
  if (!query) return Promise.resolve(null);
  const q = query.trim();
  // Direct lat,lon (e.g. "-17.73,168.32" pasted from Google Maps) — instant, no network
  const coordMatch = q.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (coordMatch) return Promise.resolve([parseFloat(coordMatch[1]), parseFloat(coordMatch[2])]);
  // 3-letter IATA airport code — instant, no network
  const iata = q.match(/\b([A-Z]{3})\b/)?.[1];
  if (iata && IATA_COORDS[iata]) return Promise.resolve(IATA_COORDS[iata]);
  if (IATA_COORDS[q.toUpperCase()]) return Promise.resolve(IATA_COORDS[q.toUpperCase()]);
  // Check cache before queuing any network request
  const cache = loadCache();
  if (cache[q]) return Promise.resolve(cache[q]);
  // UN/LOCODE (exactly 5 uppercase alphanums, e.g. VUVLI): use embedded country code to
  // scope the Nominatim query so "VLI" resolves correctly even for obscure locations.
  // The result is cached under the original LOCODE key, not the derived query string.
  const locodeMatch = q.match(/^([A-Z]{2})([A-Z0-9]{3})$/);
  if (locodeMatch) {
    const [, cc, loc] = locodeMatch;
    return new Promise((resolve) => {
      enqueue({ query: loc, cacheKey: q, countrycodes: cc.toLowerCase(), resolve });
    });
  }
  // General free-text — queue Nominatim request
  return new Promise((resolve) => {
    enqueue({ query: q, resolve });
  });
}

const _inBox = ([lat, lon], vb) =>
  !!vb && lat >= vb.south && lat <= vb.north && lon >= vb.west && lon <= vb.east;

// Nominatim, biased to (then, if nothing, unbounded beyond) the current view.
async function _nominatimSearch(q, viewbox, { strict = false } = {}) {
  const base = `${NOMINATIM_SEARCH}?q=${encodeURIComponent(q)}&format=json&limit=1`;
  const first = (data) =>
    data?.[0]
      ? { point: [parseFloat(data[0].lat), parseFloat(data[0].lon)], label: data[0].display_name }
      : null;
  try {
    if (viewbox) {
      // `bounded=1` restricts strictly to the box, so an in-view match wins.
      const vb = `${viewbox.west},${viewbox.north},${viewbox.east},${viewbox.south}`;
      const inView = first(await fetch(`${base}&viewbox=${vb}&bounded=1`).then((r) => r.json()));
      if (inView) return inView;
    }
    // `strict` is for a search that is only meaningful near a known point — a
    // session's offsite venue is somewhere in the conference's city, so a global
    // namesake is a wrong answer rather than a wider one.
    if (strict) return null;
    return first(await fetch(base).then((r) => r.json())); // global — so search still works
  } catch {
    return null;
  }
}

// Open-Meteo has no viewbox, so pull several results and prefer one inside the view.
async function _openMeteoSearch(q, viewbox, { strict = false } = {}) {
  const parts = q.split(',').map((s) => s.trim());
  const names = [...parts.slice(1), parts[0], q].filter((v, i, a) => v && a.indexOf(v) === i);
  for (const name of names) {
    try {
      const data = await fetch(
        `${OPEN_METEO_GEOCODE}?name=${encodeURIComponent(name)}&count=10`,
      ).then((r) => r.json());
      const pts = (data?.results || [])
        .filter((r) => Number.isFinite(r.latitude) && Number.isFinite(r.longitude))
        .map((r) => [r.latitude, r.longitude]);
      if (!pts.length) continue;
      const inBox = pts.find((p) => _inBox(p, viewbox));
      if (inBox) return { point: inBox, label: name };
      if (!strict) return { point: pts[0], label: name };
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/**
 * Interactive place search for the map picker — biased to (and, when possible,
 * bounded by) the current map view so a nearby match wins over a far namesake.
 * Not cached (results depend on the live viewport). Nominatim first, Open-Meteo
 * fallback; both scoped to the viewbox when given.
 * @param {string} query
 * @param {{west:number,south:number,east:number,north:number}} [viewbox]
 * @returns {Promise<[number, number] | null>}
 */
export async function geocodeSearch(query, viewbox, opts = {}) {
  const hit = await geocodeSearchNamed(query, viewbox, opts);
  return hit ? hit.point : null;
}

/**
 * The same search, plus the NAME the geocoder matched — for a picker that fills in
 * a venue's name as well as its pin.
 *
 * A separate function rather than an extra property on the returned point: hanging
 * a label off the array broke `toEqual([lat, lon])` for every existing caller,
 * which is exactly the kind of "back-compatible" change that is not.
 *
 * @param {string} query
 * @param {{west:number,south:number,east:number,north:number}} [viewbox]
 * @param {{strict?: boolean}} [opts] `strict` refuses a match outside the viewbox
 * @returns {Promise<{point: [number, number], label: string} | null>}
 */
export async function geocodeSearchNamed(query, viewbox, opts = {}) {
  const q = String(query || '').trim();
  if (!q) return null;
  const hit =
    (await _nominatimSearch(q, viewbox, opts)) || (await _openMeteoSearch(q, viewbox, opts));
  return hit ? { point: hit.point, label: hit.label || '' } : null;
}

// Resolve a place to a region: { point: [lat, lon], geojson } where geojson is a
// (simplified) boundary Polygon/MultiPolygon when Nominatim has one, else null.
// Cached separately from point lookups under an `area:` key.
export function geocodeArea(query) {
  if (!query) return Promise.resolve(null);
  const q = query.trim();
  const key = `area:${q}`;
  const cache = loadCache();
  if (cache[key]) return Promise.resolve(cache[key]);
  return new Promise((resolve) => {
    enqueue({ query: q, cacheKey: key, polygon: true, resolve });
  });
}
