// Archive Observatory data — aggregates the whole 19-year archive into viz-ready
// stats: events/sessions per year, per series, top speakers + sponsors (each with
// their appearance years for a timeline), tier mix, coverage. Applies the curation
// decisions (aliases) so speaker/sponsor tallies get CLEANER as you reconcile —
// the payoff loop for the Curation Studio. Read-only.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fingerprint, str, has, loadDecisions } from './archiveAudit.js';

const YEAR_MIN = 2007;
const YEAR_MAX = 2026;

// Words that carry no topic signal — generic English + Drupal-conference noise
// ("drupal"/"session" are in every title, so they'd swamp the real trends).
const STOPWORDS = new Set(
  (
    'the a an and or of to for with your you our we it is are be in on at by from as ' +
    'how what why when who your yours this that these those into out up down over under ' +
    'via using use used get getting make making build building do does doing let lets ' +
    'new all more most best good great better than then them they i my me us not no yes ' +
    'can will just like about across through within between one two three first ' +
    'drupal drupalcon drupalcamp drupals session sessions talk talks keynote workshop bof ' +
    'intro introduction guide overview part vol case study panel qa live demo lightning ' +
    // agenda/schedule filler — not topics
    'break lunch coffee tea breakfast dinner drinks registration opening closing welcome ' +
    'networking social party sprint sprints reception keynotes closing prenote prenotes ' +
    'sponsored room hall stage track day days morning afternoon evening lunchbreak wrap ' +
    // common English prose words (descriptions are full sentences, so we need a
    // heavier stoplist than titles alone would)
    'have has had having but their some also been being were their them our he she his ' +
    'her hers now well back even still way ways thing things lot lots really want wants ' +
    'wanted need needs needed know knows see look looking comes come coming goes going ' +
    'take takes taking made give gives given show shows showing find finds finding help ' +
    'helps helping around during before after while because since again once other others ' +
    'each any many much every own such would could should might must may shall lets ' +
    'people work works working world worlds without within upon among per instead due ' +
    'able youll youre well many time times learn learning learned really lot lots things ' +
    'thing today tomorrow yesterday something anything everything nothing someone everyone ' +
    'there here where theres heres wheres youve weve theyre youre isnt dont doesnt wont cant'
  ).split(' '),
);
// Short tokens are usually noise — but these are real topics worth tracking.
const SHORT_ALLOW = new Set(['ai', 'ux', 'ci', 'cd', 'js', 'go', 'ml', 'ar', 'vr', 'db', 'cms']);

// Placeholder "speakers" — not real people, so keep them out of the tallies.
const PLACEHOLDER_SPEAKER = /^(tba|tbd|to be (announced|confirmed|determined)|n\/?a|unknown)$/i;

// Agenda/logistics items ("Lunch", "Morning Tea", "Registration & Coffee") — not
// real sessions. We only drop a title when EVERY word is a logistics/modifier word
// (and at least one is a real logistics word), so a single content word rescues it:
// "Registration" → dropped, but "Rethinking Event Registration" → kept.
const AGENDA_WORDS = new Set([
  'lunch',
  'breakfast',
  'dinner',
  'brunch',
  'supper',
  'tea',
  'coffee',
  'drinks',
  'refreshments',
  'snacks',
  'registration',
  'checkin',
  'signin',
  'welcome',
  'opening',
  'closing',
  'remarks',
  'networking',
  'social',
  'party',
  'afterparty',
  'reception',
  'photo',
  'photos',
  'announcements',
  'housekeeping',
  'arrivals',
  'arrival',
  'doors',
  'break',
  'breaks',
  'pause',
  'wrapup',
  'mingling',
  'icebreaker',
]);
const AGENDA_MOD = new Set([
  'morning',
  'afternoon',
  'evening',
  'short',
  'quick',
  'group',
  'mid',
  'light',
  'optional',
]);
const AGENDA_FILLER = new Set([
  'time',
  'session',
  'sessions',
  'and',
  'with',
  'the',
  'a',
  'an',
  'to',
  'amp',
  'your',
  'our',
  'min',
  'mins',
  'minute',
  'minutes',
  'hr',
  'hrs',
  'hour',
  'hours',
  'am',
  'pm',
  'room',
  'hall',
]);

/** True when a session title is pure agenda/logistics (see AGENDA_WORDS note). */
export function isAgendaTitle(title) {
  const toks = String(title || '')
    .toLowerCase()
    .replace(/['’.]/g, '')
    .replace(/-/g, '')
    .replace(/[()[\]{}:;!?"“”]/g, ' ')
    .split(/[\s&/+,–—]+/)
    .filter((w) => w && !/^\d+$/.test(w) && !AGENDA_FILLER.has(w));
  if (!toks.length) return false;
  return (
    toks.every((w) => AGENDA_WORDS.has(w) || AGENDA_MOD.has(w)) &&
    toks.some((w) => AGENDA_WORDS.has(w))
  );
}

/**
 * Should this item count as a session in the archive?
 *
 * The archive measures the community's PROGRAMME — talks, keynotes, BOFs — so
 * lunch, morning tea and registration must not inflate session counts, topic
 * charts or search results. Until now that judgement came only from the title,
 * which is a guess and wrong in both directions:
 *
 *   - A sponsored break is a real, named thing. "Morning Tea, proudly sponsored
 *     by Acme" has a sponsor, a room and a time, and reads like a session to any
 *     heuristic — but it is not one.
 *   - A genuine talk can be named after logistics. "Rethinking Event
 *     Registration" is a session; "Registration" is not.
 *
 * So `isAgendaItem` on the item is the authority when it is present, in BOTH
 * directions, and the title heuristic is only the fallback for the datasets
 * (all 84 of them today) written before the field existed.
 *
 * @param {{title?: string, isAgendaItem?: boolean}} item
 * @returns {boolean} true when the item is a real session
 */
export function countsAsSession(item) {
  if (typeof item?.isAgendaItem === 'boolean') return !item.isAgendaItem;
  return !isAgendaTitle(item?.title);
}

/** Split a session title into distinct, meaningful topic tokens (deduped per title). */
export function titleTokens(title) {
  const seen = new Set();
  for (const raw of String(title || '')
    .toLowerCase()
    .split(/[^a-z0-9+#]+/)) {
    if (!raw || /^\d+$/.test(raw)) continue;
    if (raw.length < 3 && !SHORT_ALLOW.has(raw)) continue;
    if (STOPWORDS.has(raw)) continue;
    seen.add(raw);
  }
  return [...seen];
}

/**
 * Adjacent word pairs, so the vocabulary can carry phrases as well as words.
 * Community interest is often two words — "display suite", "layout builder",
 * "site building" — and a unigram vocabulary can only ever show the halves.
 *
 * Pairs are built from the RAW word sequence, then rejected if either half is a
 * stopword, so "the display" never becomes a term while "display suite" does.
 */
// Fragments that only ever appear because descriptions carry URLs and a session
// template ("Key topics include…", "Target audience…"). They form high-frequency
// pairs that are about the CMS's form fields, not the community's interests, and
// they crowd genuine phrases out of the ranking.
const PHRASE_NOISE = new Set([
  'https',
  'http',
  'www',
  'com',
  'org',
  'net',
  'html',
  'topics',
  'topic',
  'include',
  'includes',
  'included',
  'target',
  'audience',
  'key',
  'level',
  'levelbeginner',
  'levelintermediate',
  'levaladvanced',
  'covered',
  'takeaways',
]);

export function titleBigrams(title) {
  const words = String(title || '')
    .toLowerCase()
    .split(/[^a-z0-9+#]+/)
    .filter(Boolean);
  const seen = new Set();
  for (let i = 0; i < words.length - 1; i += 1) {
    const a = words[i];
    const b = words[i + 1];
    if (STOPWORDS.has(a) || STOPWORDS.has(b)) continue;
    if (PHRASE_NOISE.has(a) || PHRASE_NOISE.has(b)) continue;
    if (/^\d+$/.test(a) || /^\d+$/.test(b)) continue;
    if ((a.length < 3 && !SHORT_ALLOW.has(a)) || (b.length < 3 && !SHORT_ALLOW.has(b))) continue;
    seen.add(`${a} ${b}`);
  }
  return [...seen];
}

/**
 * Keyword-frequency-over-time from session titles. Returns the top `topN` terms,
 * each with its total mentions and a per-year count map — the shape the Observatory
 * line chart plots (as a share of that year's sessions).
 * Accepts `text` (title + description) or falls back to `title`.
 * @param {{text?:string, title?:string, year:number}[]} sessions
 */
export function buildTopics(sessions, topN = 24) {
  const terms = new Map(); // term → { term, total, byYear }
  for (const { text, title, year } of sessions) {
    if (!year) continue;
    for (const t of titleTokens(text ?? title)) {
      let rec = terms.get(t);
      if (!rec) terms.set(t, (rec = { term: t, total: 0, byYear: {} }));
      rec.total++;
      rec.byYear[year] = (rec.byYear[year] || 0) + 1;
    }
  }
  return [...terms.values()].sort((a, b) => b.total - a.total).slice(0, topN);
}

// Canonical macro-regions. These FIVE partition the whole inhabited globe with no gaps:
// EUR (Europe), MEA (Middle East & Africa), APAC (Asia + Oceania), AMER (North America),
// LATAM (Mexico, Central/South America + Caribbean). An event's authored `regionCode` wins;
// else we DERIVE from the free-text `region` field (more reliable than the geocoded coords,
// which occasionally false-match — Athens→Georgia, Nara→DC); else, for placeless online
// events, we fall back to the organising community's home region.
export const REGION_CODES = ['EUR', 'MEA', 'APAC', 'AMER', 'LATAM'];
// Friendly labels for facet dropdowns / editor selects.
export const REGION_LABELS = {
  EUR: 'Europe',
  MEA: 'Middle East & Africa',
  APAC: 'Asia-Pacific',
  AMER: 'North America',
  LATAM: 'Latin America',
};
// Tested in this order (first match wins): LATAM before AMER ("Latin America" ⊃ "America");
// MEA before EUR so African/Middle-Eastern names never fall through to Europe.
const REGION_RE = {
  LATAM:
    /\b(latin america|south america|central america|caribbean|latam|mexico|méxico|colombia|brazil|brasil|argentina|chile|peru|perú|uruguay|ecuador|bolivia|venezuela|paraguay|costa rica|guatemala|panama|cuba|dominican|honduras|nicaragua|el salvador|puerto rico|belize|jamaica|trinidad)\b/i,
  MEA: /\b(middle east|africa|uae|united arab emirates|dubai|abu dhabi|saudi|qatar|kuwait|bahrain|oman|yemen|israel|palestine|jordan|lebanon|syria|iraq|iran|egypt|morocco|tunisia|algeria|libya|sudan|nigeria|kenya|ghana|south africa|ethiopia|tanzania|uganda|senegal|cameroon|ivory coast|côte d'ivoire|rwanda|zambia|zimbabwe|angola|mozambique|botswana|namibia|mali|mauritius)\b/i,
  APAC: /\b(asia|pacific|oceania|australia|new zealand|aotearoa|japan|nippon|china|india|singapore|korea|indonesia|thailand|malaysia|philippines|taiwan|vietnam|hong kong|pakistan|bangladesh|sri lanka|nepal|myanmar|cambodia|laos|mongolia|fiji|papua new guinea|brunei|kazakhstan|uzbekistan)\b/i,
  AMER: /\b(north america|usa|u\.s\.a|united states|america|canada)\b/i,
  EUR: /\b(europe|european|netherlands|nederland|holland|belgium|belgi|germany|deutschland|austria|österreich|czech|cesko|czechia|denmark|danmark|united kingdom|great britain|britain|england|scotland|wales|northern ireland|ireland|eire|france|hungary|magyar|spain|espana|españa|italy|italia|poland|polska|switzerland|schweiz|suisse|greece|hellas|norway|norge|sweden|sverige|finland|suomi|portugal|iceland|luxembourg|slovakia|slovenia|croatia|serbia|bosnia|montenegro|macedonia|albania|kosovo|bulgaria|romania|lithuania|latvia|estonia|ukraine|belarus|moldova|malta|cyprus|monaco|liechtenstein|andorra|san marino|russia|turkey|türkiye|georgia|armenia|azerbaijan)\b/i,
};
// Placeless (online) events → the organising community's home region.
const SERIES_REGION = {
  DrupalCon: 'AMER',
  'DrupalCon Europe': 'EUR',
  DrupalSouth: 'APAC',
  'DrupalSouth Community Day': 'APAC',
  DrupalJam: 'EUR',
  DrupalGov: 'AMER',
  'Drupal Dev Days': 'EUR',
};
// Pure derivation (ignores any authored regionCode) — used by the backfill script too.
export function deriveRegion(ev) {
  const r = String(ev?.region || '');
  if (REGION_RE.LATAM.test(r)) return 'LATAM'; // before AMER: "Latin America" ⊃ "America"
  if (REGION_RE.MEA.test(r)) return 'MEA'; // before EUR: Africa/Middle East ≠ Europe
  if (REGION_RE.APAC.test(r)) return 'APAC';
  if (REGION_RE.AMER.test(r)) return 'AMER';
  if (REGION_RE.EUR.test(r)) return 'EUR';
  return SERIES_REGION[String(ev?.designation || '').trim()] || '';
}
// Authored regionCode wins (if still a valid code — legacy "EMEA" re-derives to EUR/MEA),
// else derive.
function regionOf(ev) {
  const code = String(ev?.regionCode || '').toUpperCase();
  return REGION_CODES.includes(code) ? code : deriveRegion(ev);
}
const COUNTRY_CANON = {
  netherlands: 'Netherlands',
  belgium: 'Belgium',
  japan: 'Japan',
  india: 'India',
  singapore: 'Singapore',
  'new zealand': 'New Zealand',
  australia: 'Australia',
  greece: 'Greece',
  germany: 'Germany',
  austria: 'Austria',
  france: 'France',
  spain: 'Spain',
  ireland: 'Ireland',
  'united kingdom': 'United Kingdom',
  denmark: 'Denmark',
  hungary: 'Hungary',
  colombia: 'Colombia',
  czechia: 'Czechia',
};
const COUNTRY_EN = {
  nederland: 'Netherlands',
  españa: 'Spain',
  日本: 'Japan',
  česko: 'Czechia',
  österreich: 'Austria',
  magyarország: 'Hungary',
  danmark: 'Denmark',
  deutschland: 'Germany',
  'éire / ireland': 'Ireland',
  'belgië / belgique / belgien': 'Belgium',
  'new zealand / aotearoa': 'New Zealand',
};
export function deriveCountry(regionStr, geoDisplay) {
  for (const p of String(regionStr || '').split(/[–\-/]/)) {
    const c = COUNTRY_CANON[p.trim().toLowerCase()];
    if (c) return c;
  }
  if (geoDisplay) {
    const last = geoDisplay.split(',').pop().trim();
    const en = COUNTRY_EN[last.toLowerCase()] || last;
    // Continents aren't countries — keep them out of the country facet.
    if (/^((north |south |latin )?america|europe|asia|africa|oceania|global)$/i.test(en)) return '';
    return en;
  }
  return '';
}

/**
 * Session lengths, bucketed the way a programme is actually built.
 *
 * The archive holds 51 distinct durations, but they pile up at six shapes: the
 * lightning slot, the half hour, the 45-minute talk, the hour, the workshop, and
 * the day-long contribution room. Bucketing on those boundaries is what lets
 * "how many hour-long sessions this year vs half-hour ones last year" be a
 * question with an answer, instead of 51 lines nobody can read.
 *
 * Boundaries sit BETWEEN the clusters (a 50-minute talk belongs with the 45s, not
 * with the hours), so a programme that runs 50-minute slots does not read as an
 * hour of content it never had.
 */
export const LENGTH_BUCKETS = [
  { key: 'lightning', label: 'Lightning · ≤20 min', max: 20 },
  { key: 'half', label: 'Half hour · 21–35', max: 35 },
  { key: 'short', label: '45 min · 36–50', max: 50 },
  { key: 'hour', label: 'An hour · 51–70', max: 70 },
  { key: 'workshop', label: 'Workshop · 71–120', max: 120 },
  { key: 'day', label: 'Half day or more', max: Infinity },
];

/** Which bucket a length falls in, or '' for a session with no duration recorded. */
export function lengthBucket(minutes) {
  const n = Number(minutes) || 0;
  if (n <= 0) return '';
  return (LENGTH_BUCKETS.find((b) => n <= b.max) || LENGTH_BUCKETS[LENGTH_BUCKETS.length - 1]).key;
}

/**
 * A session's length in minutes.
 *
 * Every one of the 6,930 items in the archive stores `P<n>M` — ISO-8601 with a
 * minutes component and nothing else — so this parses that and refuses to guess
 * at anything it has not seen. A wrong number here would quietly inflate a
 * headline figure, which is worse than reporting nothing.
 */
export function sessionMinutes(item) {
  const m = /^P(\d+)M$/i.exec(String(item?.duration || '').trim());
  return m ? Number(m[1]) : 0;
}

// "Online"/"Global"/etc. are placeless — Nominatim happily matches them to a
// random building, so never map them (guards both live data + stale geocache).
const PLACELESS = /^(online|global|virtual|remote|worldwide|anywhere|tbd|tba|n\/?a)$/i;

/**
 * Event coordinates: the dataset's own lat/lon, else the geocode cache (see
 * scripts/geocode-events.mjs). Shared, because every drill that draws a map has
 * to agree about which events HAVE a place — a topic drill that mapped "Online"
 * would put a keyword on a random building.
 *
 * @param {Record<string, {lat?: number, lon?: number}>} geo geocache.json
 */
function makeCoordsFor(geo) {
  return (ev) => {
    if (PLACELESS.test(str(ev.location))) return null;
    if (Number.isFinite(ev.latitude) && Number.isFinite(ev.longitude))
      return { lat: ev.latitude, lon: ev.longitude };
    const g = geo?.[str(ev.location)];
    return g && Number.isFinite(g.lat) ? { lat: g.lat, lon: g.lon } : null;
  };
}

export async function buildInsights(dataDir, store) {
  const catalog = JSON.parse(await readFile(join(dataDir, 'catalog.json'), 'utf8'));
  const files = (catalog.events || []).map((e) => e.file).filter(Boolean);
  const { aliases } = await loadDecisions(store);
  const canon = (name) => aliases[fingerprint(name)] || name;
  // Event coordinates: the dataset's own lat/lon, else the geocode cache (see
  // scripts/geocode-events.mjs). Powers the Observatory drill-down maps.
  let geo = {};
  try {
    geo = JSON.parse(await readFile(join(dataDir, 'geocache.json'), 'utf8'));
  } catch {
    /* no geocache yet → maps stay empty until `npm run geocode:events` */
  }
  const coordsFor = makeCoordsFor(geo);

  const perYear = new Map(); // year → { events, sessions }
  const perSeries = new Map(); // designation → { events, sessions }
  const speakers = new Map(); // canonical → { name, appearances, years:Set }
  const sponsors = new Map(); // canonical → { title, years:Set, tiers:Set }
  const tiers = new Map(); // tier → count (sponsor-slots)
  const regions = new Map();
  const regionSet = new Set(); // which of EUR/MEA/APAC/AMER/LATAM are present — facet options
  const countrySet = new Set(); // distinct countries present — facet options
  const yearEvents = {}; // year → [{label, series, sessions, file}]
  const seriesEvents = {}; // series → [{label, year, location, sessions}]
  const titleYears = []; // {title, year} per session — feeds the topic trends
  let sessions = 0;
  let minutes = 0;
  let sponsorSlots = 0;
  let coverageSum = 0;
  let coverageN = 0;

  const bumpYear = (y, key, n = 1) => {
    if (!y) return;
    if (!perYear.has(y)) perYear.set(y, { events: 0, sessions: 0, minutes: 0 });
    perYear.get(y)[key] += n;
  };

  // Community credits: who ran the events, keyed by drupal.org profile slug.
  // The slug is the identity — display text varies per page and is only kept
  // for rendering. See app/schemas/event.schema.json.
  /** Keyed `role:username` — one row per person per role, like the source pages. */
  const credits = new Map();
  let creditedEvents = 0;

  for (const file of files) {
    let data;
    try {
      data = JSON.parse(await readFile(join(dataDir, file), 'utf8'));
    } catch {
      continue;
    }
    const ev = data.event || {};
    const year = Number(ev.year) || null;
    const series = str(ev.designation) || 'Other';
    const label = [ev.designation, ev.location, ev.year].filter(Boolean).join(' ') || file;
    const community = Array.isArray(ev.community?.people) ? ev.community.people : [];
    if (community.length) creditedEvents += 1;
    const coords = coordsFor(ev);
    const region = regionOf(ev);

    const country = str(ev.country) || deriveCountry(ev.region, geo[str(ev.location)]?.display);
    for (const person of community) {
      const username = str(person?.username);
      if (!username) continue;
      const role = person?.role === 'volunteer' ? 'volunteer' : 'organiser';
      const key = `${role}:${username}`;
      if (!credits.has(key)) {
        credits.set(key, {
          username,
          name: str(person?.name) || username,
          role,
          events: new Map(),
          years: new Set(),
        });
      }
      const rec = credits.get(key);
      if (person?.name && rec.name === username) rec.name = str(person.name);
      // Curation aliases apply to the DISPLAY name, exactly as they do to
      // speakers and sponsors — so mapping "kim.pepper" onto "Kim Pepper"
      // makes the credit and the speaker share one canonical string. The
      // username is untouched: it is the identity and the URL, and the
      // datasets are never rewritten.
      rec.name = canon(rec.name);
      if (year) rec.years.add(year);
      // Same detail shape as speakers/sponsors, so the dashboard's inScope()
      // filter works on these rows without a second code path.
      // lat/lon included so a person page can draw the same map a speaker
      // journey does — geocoded() reads them off the detail rows.
      rec.events.set(file, {
        label,
        year,
        series,
        region,
        country,
        file,
        // The photo-album view is event-level — there are no per-session photos —
        // so the album travels with the event row rather than needing its own
        // endpoint. Absent stays absent: an event with no album recorded is not
        // an event with an empty one.
        album: str(ev.flickr?.groupUrl) || null,
        albumProvider: str(ev.flickr?.provider) || null,
        lat: coords?.lat,
        lon: coords?.lon,
      });
    }
    if (region) regionSet.add(region);
    if (country) countrySet.add(country);
    // Drop agenda/logistics items so they don't inflate session counts or topics.
    const items = (Array.isArray(data.items) ? data.items : []).filter(countsAsSession);
    sessions += items.length;
    // Programme time. Carried per EVENT as well as per year, because the client
    // scopes by facets over the event list and would otherwise have to ask the
    // server again to answer "how many hours of DrupalSouth".
    const eventMinutes = items.reduce((n, i) => n + sessionMinutes(i), 0);
    minutes += eventMinutes;
    // The length mix, per event for the same reason as the minutes: the client
    // scopes by facets over this list.
    const eventLengths = {};
    for (const i of items) {
      const b = lengthBucket(sessionMinutes(i));
      if (b) eventLengths[b] = (eventLengths[b] || 0) + 1;
    }

    bumpYear(year, 'events', 1);
    bumpYear(year, 'sessions', items.length);
    bumpYear(year, 'minutes', eventMinutes);
    if (!perSeries.has(series)) perSeries.set(series, { events: 0, sessions: 0 });
    perSeries.get(series).events += 1;
    perSeries.get(series).sessions += items.length;
    if (has(ev.region)) regions.set(str(ev.region), (regions.get(str(ev.region)) || 0) + 1);
    // Per-year / per-series event lists (for drill-down).
    if (year)
      (yearEvents[year] ??= []).push({
        label,
        series,
        region,
        country,
        sessions: items.length,
        minutes: eventMinutes,
        lengths: eventLengths,
        // Only when the organisers reported one. An absent figure has to stay
        // absent all the way to the chart, so coverage can be stated instead of a
        // missing event quietly reading as a zero-attendance one.
        attendance: Number.isFinite(ev.attendance?.count) ? ev.attendance.count : null,
        file,
        // The photo-album view is event-level — there are no per-session photos —
        // so the album travels with the event row rather than needing its own
        // endpoint. Absent stays absent: an event with no album recorded is not
        // an event with an empty one.
        album: str(ev.flickr?.groupUrl) || null,
        albumProvider: str(ev.flickr?.provider) || null,
        lat: coords?.lat,
        lon: coords?.lon,
      });
    (seriesEvents[series] ??= []).push({
      label,
      year,
      region,
      country,
      location: str(ev.location),
      sessions: items.length,
      lat: coords?.lat,
      lon: coords?.lon,
    });

    // rough coverage (mirrors the audit's spirit): meta + session detail
    const metaFields = ['logo', 'venue', 'location', 'region', 'website', 'timezone'];
    const metaHit = metaFields.filter((f) =>
      f === 'logo' ? !!(ev.logo?.image || ev.logo?.faIcon) : has(ev[f]),
    ).length;
    coverageSum += Math.round((100 * metaHit) / metaFields.length);
    coverageN++;

    for (const s of items) {
      if (year && has(s.title))
        titleYears.push({
          text: `${str(s.title)} ${str(s.full_description)}`,
          year,
          series,
          region,
          country,
          // Whether this session brought a description with it. A title-only
          // session can still match a keyword, but it offers far less surface —
          // so a year where half the programme has no description under-reports
          // every topic. Carried through to the client so "share of the
          // programme" can be a share of what is actually READABLE.
          described: has(s.full_description),
        });
      for (const sp of s.speakers || []) {
        const raw = str(typeof sp === 'string' ? sp : sp?.name);
        if (!raw || PLACEHOLDER_SPEAKER.test(raw)) continue;
        const name = canon(raw);
        if (!speakers.has(name))
          speakers.set(name, { name, appearances: 0, years: new Set(), events: new Map() });
        const rec = speakers.get(name);
        rec.appearances++;
        if (year) rec.years.add(year);
        if (!rec.events.has(file))
          rec.events.set(file, {
            label,
            year,
            series,
            region,
            country,
            file, // lets the Observatory fetch this dataset to expand full talk detail
            n: 0,
            minutes: 0,
            lengths: {},
            talks: [],
            lat: coords?.lat,
            lon: coords?.lon,
          });
        const de = rec.events.get(file);
        de.n++; // sessions this speaker had at this event (some have no title)
        // Minutes THIS speaker stood up for, so the client can ask how long a slot
        // a first-time speaker gets compared with someone who has spoken before.
        de.minutes += sessionMinutes(s);
        // ...and which bracket each of those slots was, so "are newcomers getting
        // the hour-long slots?" can be asked per length rather than as an average
        // that hides the distribution.
        const bucket = lengthBucket(sessionMinutes(s));
        if (bucket) de.lengths[bucket] = (de.lengths[bucket] || 0) + 1;
        if (has(s.title)) de.talks.push(str(s.title));
      }
    }
    for (const sp of Array.isArray(ev.sponsors) ? ev.sponsors : []) {
      const title = canon(str(sp.title) || str(sp.id) || 'sponsor');
      sponsorSlots++;
      if (!sponsors.has(title))
        sponsors.set(title, { title, years: new Set(), tiers: new Set(), events: new Map() });
      const rec = sponsors.get(title);
      if (year) rec.years.add(year);
      if (!rec.events.has(file))
        rec.events.set(file, {
          label,
          year,
          series,
          region,
          country,
          tier: str(sp.tier),
          lat: coords?.lat,
          lon: coords?.lon,
        });
      if (has(sp.tier)) {
        rec.tiers.add(str(sp.tier));
        tiers.set(str(sp.tier), (tiers.get(str(sp.tier)) || 0) + 1);
      }
    }
  }

  const yearRow = (y) => {
    const r = perYear.get(y) || { events: 0, sessions: 0, minutes: 0 };
    return { year: y, events: r.events, sessions: r.sessions, minutes: r.minutes || 0 };
  };
  const years = [];
  for (let y = YEAR_MIN; y <= YEAR_MAX; y++) years.push(yearRow(y));

  const byYear = (a, b) => (a.year || 0) - (b.year || 0);
  // Full sorted lists (with per-event detail) — the dashboard shows the top slice,
  // search + drill-down use the whole tail.
  const speakerList = [...speakers.values()]
    .map((s) => ({
      name: s.name,
      appearances: s.appearances,
      events: s.events.size,
      years: [...s.years].sort(),
      detail: [...s.events.values()].sort(byYear),
    }))
    .sort((a, b) => b.appearances - a.appearances || b.events - a.events);
  const sponsorList = [...sponsors.values()]
    .map((s) => ({
      title: s.title,
      events: s.events.size,
      years: [...s.years].sort(),
      tiers: [...s.tiers],
      detail: [...s.events.values()].sort(byYear),
    }))
    .sort((a, b) => b.events - a.events);

  const TIER_ORDER = ['Platinum', 'Diamond', 'Gold', 'Silver', 'Bronze'];
  const tierRows = [...tiers.entries()]
    .map(([tier, count]) => ({ tier, count }))
    .sort((a, b) => {
      const ai = TIER_ORDER.indexOf(a.tier);
      const bi = TIER_ORDER.indexOf(b.tier);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi) || b.count - a.count;
    });

  return {
    stats: {
      events: files.length,
      series: perSeries.size,
      yearMin: YEAR_MIN,
      yearMax: YEAR_MAX,
      sessions,
      minutes,
      speakers: speakers.size,
      sponsors: sponsors.size,
      sponsorSlots,
      coverage: coverageN ? Math.round(coverageSum / coverageN) : 0,
    },
    years,
    // Shipped with the data so the chart's labels and the tallies behind them
    // cannot drift: one definition, in the file that does the bucketing.
    lengthBuckets: LENGTH_BUCKETS,
    series: [...perSeries.entries()]
      .map(([name, r]) => ({ name, ...r }))
      .sort((a, b) => b.events - a.events),
    tiers: tierRows,
    // Organiser/volunteer leaderboard. `coverage` is deliberately reported:
    // credits exist for a handful of events so far, and a bare ranking would
    // imply the rest had nobody running them.
    credits: {
      coverage: { withCredits: creditedEvents, events: files.length },
      people: [...credits.values()]
        .map((r) => ({
          username: r.username,
          name: r.name,
          role: r.role,
          events: r.events.size,
          years: [...r.years].sort(),
          detail: [...r.events.values()].sort(byYear),
        }))
        .sort((a, b) => b.events - a.events || a.name.localeCompare(b.name)),
    },
    regions: [...regions.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
    // Facet option lists for the Observatory topbar filters.
    facetRegions: REGION_CODES.filter((r) => regionSet.has(r)),
    facetCountries: [...countrySet].sort((a, b) => a.localeCompare(b)),
    speakers: speakerList,
    sponsors: sponsorList,
    ...topicsPayload(titleYears, perSeries),
    yearEvents,
    seriesEvents,
  };
}

/**
 * Topic trends overall + per series, plus the ordered series list for the filter.
 * EVERY series is included (no session-count threshold) so no conference is ever
 * excluded from the chart or its scope dropdown.
 */
function topicsPayload(titleYears, perSeries) {
  // Track a deep vocabulary (not just the ~top handful) so the chart's "add a
  // keyword" typeahead can plot any reasonably-common term, per scope.
  const VOCAB = 150;
  const all = buildTopics(titleYears, VOCAB);
  const topicsBySeries = { All: all };
  const seriesList = [...perSeries.entries()]
    .sort((a, b) => b[1].sessions - a[1].sessions)
    .map(([name]) => name);
  for (const name of seriesList)
    topicsBySeries[name] = buildTopics(
      titleYears.filter((t) => t.series === name),
      VOCAB,
    );
  // Titled-sessions-per-year per scope — the denominator for the chart's "share %"
  // so a series' trend is measured against ITS OWN sessions, not the whole archive.
  const sessBy = { All: {} };
  for (const name of seriesList) sessBy[name] = {};
  for (const t of titleYears) {
    sessBy.All[t.year] = (sessBy.All[t.year] || 0) + 1;
    if (sessBy[t.series]) sessBy[t.series][t.year] = (sessBy[t.series][t.year] || 0) + 1;
  }
  // Compact per-session term membership so the client can recompute topic trends for ANY
  // facet scope (series + region + country) instantly — the mined lines can then be
  // filtered geographically, not just by series. `topicVocab` is a generous vocabulary;
  // each session lists the indices of the vocab terms it contains, plus its facets.
  // Words and phrases. Bigrams are counted separately because they are an order
  // of magnitude rarer than unigrams — ranked together they would never survive
  // a shared top-N cut, and the phrases are exactly what makes the vocabulary
  // interesting.
  const words = buildTopics(titleYears, 400).map((t) => t.term);
  const pairCount = new Map();
  for (const t of titleYears) {
    if (!t.year) continue;
    for (const bg of titleBigrams(t.text)) pairCount.set(bg, (pairCount.get(bg) || 0) + 1);
  }
  const phrases = [...pairCount.entries()]
    .filter(([, n]) => n >= 5) // a pair seen four times is a coincidence, not a topic
    .sort((a, b) => b[1] - a[1])
    // 400 keeps genuinely specific phrases in reach — "display suite" ranks 291
    // with 19 sessions, and it is exactly the kind of thing the archive exists
    // to surface. The vocabulary is only an index of ints per session, so the
    // payload cost of a longer tail is small.
    .slice(0, 400)
    .map(([term]) => term);

  const vocab = [...words, ...phrases];
  const vIdx = new Map(vocab.map((t, i) => [t, i]));
  const topicSessions = [];
  for (const t of titleYears) {
    if (!t.year) continue;
    const k = [];
    for (const tok of [...titleTokens(t.text), ...titleBigrams(t.text)]) {
      const i = vIdx.get(tok);
      if (i !== undefined) k.push(i);
    }
    // [year, series, region, country, termIndices, described] — positional to keep
    // the payload small.
    topicSessions.push([t.year, t.series, t.region || '', t.country || '', k, t.described ? 1 : 0]);
  }
  return {
    topics: all,
    topicsBySeries,
    topicSeries: ['All', ...seriesList],
    topicSessionsByYear: sessBy,
    topicVocab: vocab,
    topicSessions,
  };
}

/**
 * Who has shared a session with this person.
 *
 * 27% of the archive's sessions have more than one speaker — 4,354 distinct pairs
 * — and nothing read them. A conference programme is a record of collaboration as
 * much as of subjects, and this is the only place that fact is written down.
 *
 * Computed on demand rather than shipped in the insights payload: the full pair
 * list is a five-figure structure the dashboard would download to answer a
 * question about one person.
 *
 * Names are canonicalised through the curation ledger on BOTH sides, so a partner
 * who appears as `nick_schuch` in one programme and `Nick Schuch` in another is
 * one collaborator with two sessions, not two collaborators with one each.
 *
 * @param {string} dataDir
 * @param {string} name canonical display name
 * @param {{series?: string, region?: string, country?: string}} [facets]
 * @param {*} [store] decisions store (the server passes its S3-backed one)
 */
export async function coSpeakers(dataDir, name, facets = {}, store) {
  const { series = 'All', region = 'All', country = 'All' } = facets;
  const target = str(name);
  if (!target) return { name: '', sessions: 0, partners: [] };
  const { aliases } = await loadDecisions(store);
  const canon = (n) => aliases[fingerprint(n)] || n;
  const catalog = JSON.parse(await readFile(join(dataDir, 'catalog.json'), 'utf8'));
  const files = (catalog.events || []).map((e) => e.file).filter(Boolean);
  /** @type {Map<string, {name: string, count: number, sessions: Array<{title: string, event: string, year: number|null}>}>} */
  const partners = new Map();
  let shared = 0;
  for (const file of files) {
    let data;
    try {
      data = JSON.parse(await readFile(join(dataDir, file), 'utf8'));
    } catch {
      continue;
    }
    const ev = data.event || {};
    if (series !== 'All' && (str(ev.designation) || 'Other') !== series) continue;
    if (region !== 'All' && regionOf(ev) !== region) continue;
    if (country !== 'All' && str(ev.country) !== country) continue;
    const label = [ev.designation, ev.location, ev.year].filter(Boolean).join(' ');
    const year = Number(ev.year) || null;
    for (const item of data.items || []) {
      if (!countsAsSession(item)) continue;
      const names = [...new Set((item.speakers || []).map((n) => canon(str(n))).filter(Boolean))];
      if (names.length < 2 || !names.includes(target)) continue;
      shared += 1;
      for (const other of names) {
        if (other === target) continue;
        if (!partners.has(other)) partners.set(other, { name: other, count: 0, sessions: [] });
        const rec = partners.get(other);
        rec.count += 1;
        if (rec.sessions.length < 12)
          rec.sessions.push({ title: str(item.title), event: label, year });
      }
    }
  }
  return {
    name: target,
    sessions: shared,
    partners: [...partners.values()].sort(
      (a, b) => b.count - a.count || a.name.localeCompare(b.name),
    ),
  };
}

/**
 * A keyword as a WHOLE-WORD pattern — the only way the chart matches.
 *
 * The chart plots a term over twenty years, so a substring reading would not be a
 * softer answer, it would be a different and wrong one: "ai" inside "maintain"
 * and "email" would draw a line about nothing. There is deliberately no
 * "contains" option here, unlike the session search where a reader can see the
 * rows and judge them.
 *
 * A multi-word term is still a phrase, joined by "any run of non-word
 * characters", so "layout builder" matches "Layout-Builder" and "layout  builder".
 *
 * Letters and digits are Unicode, not [a-z0-9]. Under the ASCII classes an accent
 * counted as a word boundary: "gábor" compiled to "g" + separator + "bor", which
 * matched the name but would equally have matched "g bor", and "café" also matched
 * the bare word "caf". `+` and `#` stay word characters, so "c++" and "c#" survive
 * as terms. This is the boundary rule the session search uses in its exact mode
 * (lib/archiveSessions.js), so the two agree on what a word is.
 *
 * @param {string} term
 * @returns {RegExp|null} null when the term has no word characters at all
 */
export function termPattern(term) {
  const words = String(term || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}+#]+/u)
    .filter(Boolean);
  if (!words.length) return null;
  const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `(?<![\\p{L}\\p{N}])${words.map(esc).join('[^\\p{L}\\p{N}]+')}(?![\\p{L}\\p{N}])`,
    'iu',
  );
}

/**
 * Search title + full_description across the archive for ANY keyword/phrase, scoped
 * to a series. Whole-word / phrase match (see termPattern). Returns per-year counts +
 * the matching session titles (for the chart's click-drill). Agenda items excluded;
 * same session universe as the chart.
 */
export async function searchTopic(
  dataDir,
  term,
  series = 'All',
  region = 'All',
  country = 'All',
  { year: onlyYear = null } = {},
) {
  const re = termPattern(term);
  if (!re) return { term, byYear: {}, sessions: [] };
  const catalog = JSON.parse(await readFile(join(dataDir, 'catalog.json'), 'utf8'));
  const files = (catalog.events || []).map((e) => e.file).filter(Boolean);
  // The chart asks for every year and needs only counts; the drill asks for ONE
  // year and needs the sessions themselves — who spoke, at which event, what it
  // was about. Same matcher either way, so a drill can never disagree with the
  // point that opened it.
  const detail = Number.isFinite(Number(onlyYear)) && onlyYear !== null;
  const want = detail ? Number(onlyYear) : null;
  let geo = {};
  try {
    geo = JSON.parse(await readFile(join(dataDir, 'geocache.json'), 'utf8'));
  } catch {
    /* no geocache → country derives from the region field only, maps stay empty */
  }
  const coordsFor = makeCoordsFor(geo);
  const byYear = {};
  const byYearDescribed = {};
  const sessions = [];
  for (const file of files) {
    let data;
    try {
      data = JSON.parse(await readFile(join(dataDir, file), 'utf8'));
    } catch {
      continue;
    }
    const ev = data.event || {};
    const year = Number(ev.year) || null;
    if (!year) continue;
    if (series !== 'All' && (str(ev.designation) || 'Other') !== series) continue;
    // Same geographic facets as the mined lines, so custom keywords filter identically.
    if (region !== 'All' && regionOf(ev) !== region) continue;
    if (
      country !== 'All' &&
      (str(ev.country) || deriveCountry(ev.region, geo[str(ev.location)]?.display)) !== country
    )
      continue;
    const label = [ev.designation, ev.location, ev.year].filter(Boolean).join(' ');
    const coords = detail ? coordsFor(ev) : null;
    for (const s of data.items || []) {
      if (!countsAsSession(s)) continue;
      if (!re.test(`${str(s.title)} ${str(s.full_description)}`.toLowerCase())) continue;
      byYear[year] = (byYear[year] || 0) + 1;
      // The same split the mined index carries: matches among sessions that HAVE a
      // description, so a custom keyword's share is measured against the same
      // readable population as a mined one.
      if (has(s.full_description)) byYearDescribed[year] = (byYearDescribed[year] || 0) + 1;
      if (detail && year !== want) continue;
      if (sessions.length >= 800) continue;
      sessions.push(
        detail
          ? {
              year,
              title: str(s.title),
              description: str(s.full_description),
              speakers: (s.speakers || []).join(', '),
              location: str(s.location),
              startTime: str(s.startTime),
              link: str(s.link),
              video: str(s.video_url),
              event: label,
              series: str(ev.designation),
              region: str(ev.regionCode),
              country: str(ev.country),
              city: str(ev.location),
              file,
              lat: coords?.lat,
              lon: coords?.lon,
            }
          : { year, title: str(s.title) },
      );
    }
  }
  return { term, byYear, byYearDescribed, sessions, year: want };
}
