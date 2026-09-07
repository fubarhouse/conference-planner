// Reading YouTube playlists, and matching what is in them to archive sessions.
//
// Extracted from the DrupalSouth backfill once DrupalCon needed the same job
// done against a different channel. The two differ only in configuration —
// which playlist covers which dataset, and which words are too common in that
// series to carry meaning — so everything else lives here.
//
// There is no API key anywhere in this repo and none is needed: the playlist
// page ships its contents in `ytInitialData`, and paging continues through the
// same innertube endpoint the page itself calls.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import vm from 'node:vm';
import { countsAsSession } from './archiveInsights.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const runs = (t) => t?.simpleText || t?.runs?.map((r) => r.text).join('') || t?.content || '';

// ── Reading a playlist ──────────────────────────────────────────────────────

/**
 * Walk an arbitrary ytInitialData / innertube response and pull out videos.
 *
 * Two renderer shapes are collected because YouTube is mid-migration: the
 * classic `playlistVideoRenderer` and the newer `lockupViewModel`. A page can
 * serve either, so both are handled rather than pinned to whichever shipped
 * the day this was written.
 */
export function collectVideos(node, videos = [], seen = new Set()) {
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return void n.forEach(walk);
    const pv = n.playlistVideoRenderer;
    if (pv?.videoId && !seen.has(pv.videoId)) {
      seen.add(pv.videoId);
      videos.push({ id: pv.videoId, title: runs(pv.title), author: runs(pv.shortBylineText) });
    }
    const lv = n.lockupViewModel;
    if (lv && String(lv.contentType).includes('VIDEO') && lv.contentId && !seen.has(lv.contentId)) {
      seen.add(lv.contentId);
      videos.push({
        id: lv.contentId,
        title: runs(lv.metadata?.lockupMetadataViewModel?.title),
        author: '',
      });
    }
    for (const v of Object.values(n)) walk(v);
  })(node);
  return videos;
}

/** The next-page token, wherever the response happens to have put it. */
export function findContinuation(node) {
  let token = '';
  (function walk(n) {
    if (token || !n || typeof n !== 'object') return;
    if (Array.isArray(n)) return void n.forEach(walk);
    if (n.continuationCommand?.token) {
      token = n.continuationCommand.token;
      return;
    }
    for (const v of Object.values(n)) walk(v);
  })(node);
  return token;
}

export function parseInitialData(html) {
  const marker = 'var ytInitialData = ';
  const at = html.indexOf(marker);
  if (at < 0)
    throw new Error('ytInitialData not found — page shape changed or the fetch was blocked');
  const start = at + marker.length;
  return vm.runInNewContext(`(${html.slice(start, html.indexOf(';</script>', start))})`);
}

async function innertubePages(html, seed, videos, seen) {
  const apiKey = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
  const clientVersion =
    html.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/)?.[1] || '2.20240101.00.00';
  let token = findContinuation(seed);
  for (let page = 0; token && apiKey && page < 60; page += 1) {
    const res = await fetch(
      `https://www.youtube.com/youtubei/v1/browse?key=${apiKey}&prettyPrint=false`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': UA },
        body: JSON.stringify({
          context: { client: { clientName: 'WEB', clientVersion, hl: 'en', gl: 'US' } },
          continuation: token,
        }),
      },
    );
    const json = await res.json();
    const before = videos.length;
    collectVideos(json, videos, seen);
    if (videos.length === before) break;
    token = findContinuation(json);
  }
}

/**
 * Every video in a playlist, paging through continuations.
 *
 * The raw HTML is cached before it is parsed, so a run that dies on a shape
 * change still leaves the evidence needed to fix the parser, and `offline` can
 * replay it without hitting the network again.
 */
export async function fetchPlaylistVideos(listId, { cacheDir, offline = false } = {}) {
  const cached = cacheDir ? join(cacheDir, `${listId}.html`) : '';
  const cachedVideos = cacheDir ? join(cacheDir, `${listId}.videos.json`) : '';
  let html;
  if (offline) {
    // The parsed list, not the HTML. Continuation pages arrive as POST
    // responses that the HTML cache never held, so replaying the page alone
    // silently truncates a long playlist to its first ~100 videos — which
    // looks like a smaller playlist rather than like a partial read.
    if (cachedVideos && existsSync(cachedVideos))
      return JSON.parse(await readFile(cachedVideos, 'utf8'));
    throw new Error(`offline but no parsed cache for ${listId} — run once online first`);
  } else {
    const res = await fetch(`https://www.youtube.com/playlist?list=${listId}`, {
      headers: { 'user-agent': UA, 'accept-language': 'en-US,en' },
    });
    html = await res.text();
    if (cacheDir) {
      await mkdir(cacheDir, { recursive: true });
      await writeFile(cached, html);
    }
    if (!res.ok) throw new Error(`playlist ${listId}: HTTP ${res.status}`);
  }

  const seed = parseInitialData(html);
  const videos = [];
  const seen = new Set();
  collectVideos(seed, videos, seen);
  await innertubePages(html, seed, videos, seen);
  if (cachedVideos) await writeFile(cachedVideos, `${JSON.stringify(videos, null, 1)}\n`);
  return videos;
}

// ── Matching a video to a session ───────────────────────────────────────────

/** Words too common across conference talks to distinguish one from another. */
export const BASE_STOP_WORDS = [
  'the',
  'and',
  'for',
  'with',
  'your',
  'you',
  'a',
  'an',
  'of',
  'to',
  'in',
  'on',
  'at',
  'is',
  'it',
  'how',
  'why',
  'what',
  'from',
  'that',
  'this',
  'drupal',
  'session',
  'talk',
  'keynote',
  'presentation',
  'part',
  'by',
];

/** Lowercased, de-accented, punctuation collapsed to single spaces. */
export function normalizeTitle(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export const tokenize = (text, stop) =>
  new Set(
    normalizeTitle(text)
      .split(' ')
      .filter((w) => w.length > 2 && !stop.has(w)),
  );

/**
 * The candidate title strings hidden inside one video title.
 *
 * Conference channels rename their format every few years — "Speaker - Title",
 * 'Session: "Title" by Speaker', "Title / Track / Speaker", "Title | Event" —
 * and in every one of them the session title is a *segment* rather than the
 * whole string. Splitting on those separators lets a segment match a session
 * title exactly, instead of a whole-string comparison permanently diluted by
 * the speaker's name and the event branding.
 */
export function titleSegments(videoTitle) {
  const out = new Set([videoTitle]);
  const quoted = videoTitle.match(/["“”']([^"“”']{12,})["“”']/)?.[1];
  if (quoted) out.add(quoted);
  const stripped = videoTitle
    .replace(/^\s*session\s*:\s*/i, '')
    .replace(/^\s*drupal(con|south)[^-–—:|/]*[-–—:|]\s*/i, '')
    .replace(/\s+by\s+[^-–—/|]+$/i, '');
  out.add(stripped);
  for (const sep of [' / ', ' - ', ' – ', ' — ', ' | ', ': ']) {
    if (!stripped.includes(sep)) continue;
    const parts = stripped.split(sep);
    for (const piece of parts) out.add(piece);
    // A title can contain the separator itself, so the leading pieces have to
    // stay joined as well as split: "Title: Subtitle / Track / Speaker" needs
    // "Title: Subtitle" to survive as one candidate.
    for (let cut = 1; cut < parts.length; cut += 1) {
      out.add(parts.slice(0, cut).join(sep));
      out.add(parts.slice(cut).join(sep));
    }
  }
  // A trailing parenthetical is almost always the event or the speaker, not the
  // talk: "The Avocado Show (Drupaljam:XL 2019 Business Day)". Left in, it turns
  // what should be an exact title match into a fuzzy one, so every segment also
  // gets a bracket-free variant.
  for (const s of [...out]) {
    const bare = s.replace(/\s*[([][^)\]]*[)\]]\s*$/, '').trim();
    if (bare && bare !== s) out.add(bare);
  }
  return [...out].map((s) => s.trim()).filter((s) => s.length >= 8);
}

/**
 * Overlap / smaller-set — asymmetric on purpose, so a truncated video title
 * that covers only the first half of a session title can still score well.
 *
 * That asymmetry has a sharp edge: a segment carrying one surviving token
 * scores a perfect 1.0 against any session containing that word. The track
 * name "UX & Content" reduces to {content} and so matched every content talk
 * in one playlist at 1.0. Both sides therefore need at least three
 * distinctive tokens before an overlap ratio means anything.
 */
export const MIN_TOKENS = 3;

export function tokenScore(a, b) {
  if (a.size < MIN_TOKENS || b.size < MIN_TOKENS) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

/**
 * Companion content that shares a session's words without being its recording.
 *
 * One playlist was four corridor interviews and a keynote, and "DrupalSouth
 * Interview - Emma jane Westby" scored a perfect token overlap against the
 * session "Keynote: Emma Jane Westby" — right speaker, wrong video. Title
 * similarity cannot separate these, so the genre is excluded outright unless
 * the session is itself billed as one.
 */
export const COMPANION =
  /\b(interview|promo|teaser|trailer|wrap[- ]?up|highlights|sponsor message|livestream|live stream|preview)\b/i;

/**
 * Retrospectives about an initiative, which share almost every word with the
 * sessions about that same initiative. "A Review of the Automated Updates
 * Initiative" scored a perfect overlap against the session "Automated Updates
 * Initiative Keynote Q&A" — same subject, different video.
 *
 * Anchored to the opening phrase rather than the bare word "review", because
 * "Patch Reviews" and "a comparison of top tools" are real session titles and
 * must keep matching their own recordings.
 */
const RETROSPECTIVE = /^\s*a review of\b/i;

/**
 * A combined opening or closing plenary, which credits several speakers who
 * also gave their own talks.
 *
 * "DrupalCon Seattle 2019: Closing Session - Marcy Sutton and Nithya Ruff" is
 * the plenary — its description is just "Marcy Sutton - 3:04 / Nithya Ruff -
 * 31:03" — but Marcy gave exactly one other session, so the solo-speaker key
 * happily handed her separate talk this recording. A named ceremony belongs to
 * the ceremony.
 */
const CEREMONY = /\b(closing|opening)\s+(session|plenary|ceremony|remarks)\b/i;

export const isCompanion = (video, session) => {
  const title = session.title || '';
  if (COMPANION.test(video.title) && !COMPANION.test(title)) return true;
  if (CEREMONY.test(video.title) && !CEREMONY.test(title)) return true;
  return RETROSPECTIVE.test(video.title) && !RETROSPECTIVE.test(title);
};

export const ACCEPT = 0.78;
export const MARGIN = 0.08;

/**
 * Does this video title name the room AND the start time this session ran in?
 *
 * Some channels label recordings by slot rather than by full title —
 * "DrupalJam:XL Kalvermelk1 11:00 JSON:API (By Björn Brala)" against the
 * session "Stop the noise! Introduction to the JSON:API specification". The
 * words overlap too little to score, but room-plus-time is a UNIQUE key: no
 * two sessions share both, so agreement on it is conclusive in a way that
 * title similarity never is.
 *
 * Rooms are compared with spaces removed ("Kalvermelk 2A" vs "Kalvermelk2a")
 * and the time as written, since both sides come from the same organiser.
 *
 * @param {string} videoTitle
 * @param {string} room  the session's room, as the schedule records it
 * @param {string} time  local start time, "HH:MM"
 */
/**
 * Does this video title name a speaker who presented exactly once?
 *
 * Some channels label a recording with nothing but the speaker —
 * "DrupalJam 2022 re:United - Gábor Hojtsy" for "The state of Drupal 10".
 * There is no title overlap to score at all, but a speaker with a single
 * session is as unique a key as a room and a time: only one talk can be theirs.
 * A speaker with two sessions tells you nothing about which, so the caller
 * passes only the names that appear once in the event.
 */
export function soloSpeakerCorroborates(videoTitle, soloNames = []) {
  const flat = normalizeTitle(videoTitle);
  return soloNames.some((n) => {
    const name = normalizeTitle(n);
    return name.length > 6 && flat.includes(name);
  });
}

export function slotCorroborates(videoTitle, room, time) {
  if (!room || !/^\d{1,2}:\d{2}$/.test(time || '')) return false;
  const flat = normalizeTitle(videoTitle).replace(/\s+/g, '');
  const roomKey = normalizeTitle(room).replace(/\s+/g, '');
  if (roomKey.length < 4 || !flat.includes(roomKey)) return false;
  const [h, m] = time.split(':');
  return new RegExp(`\\b${Number(h)}\\s*[:.]?\\s*${m}\\b`).test(videoTitle);
}

/**
 * The best video for one session, plus the runner-up score.
 *
 * Three passes in confidence order — exact, containment, then token overlap.
 * The token pass is the only fuzzy one, and it carries a margin guard: a win
 * has to beat the runner-up by a clear gap, because the failure mode that
 * actually matters here is two near-identical sessions (a talk and its
 * hands-on workshop) swapping recordings, which no threshold alone prevents.
 */
export function bestVideoMatch(session, videos, stopWords = new Set(BASE_STOP_WORDS), slot = null) {
  const target = normalizeTitle(session.title);
  if (target.length < 6) return null;
  const targetTokens = tokenize(session.title, stopWords);
  const speakerNames = (session.speakers || []).map(normalizeTitle).filter((s) => s.length > 3);

  let best = null;
  let runnerUp = 0;
  for (const video of videos) {
    if (isCompanion(video, session)) continue;
    let score = 0;
    let method = '';
    for (const segment of titleSegments(video.title)) {
      const candidate = normalizeTitle(segment);
      if (!candidate) continue;
      if (candidate === target) {
        score = 1;
        method = 'exact';
        break;
      }
      // 16 characters, not 18: "State of Drupal 9" normalises to 17 and
      // "Drupal in Europe" to 16, and both were being refused a containment
      // match against their own recording purely on length.
      const shorter = Math.min(candidate.length, target.length);
      if (shorter >= 16 && (candidate.includes(target) || target.includes(candidate))) {
        if (score < 0.95) {
          score = 0.95;
          method = 'substring';
        }
        continue;
      }
      // Truncated titles ("Including Disabled Peoples' Voice in Consult…")
      // only ever share a prefix, so compare the overlapping head.
      if (/\.\.\.|…/.test(segment) && shorter >= 20) {
        const head = candidate.replace(/\s*(\.\.\.|…).*$/, '');
        if (head.length >= 20 && target.startsWith(head) && score < 0.93) {
          score = 0.93;
          method = 'prefix';
          continue;
        }
      }
      const overlap = tokenScore(tokenize(segment, stopWords), targetTokens);
      if (overlap > score) {
        score = overlap;
        method = 'tokens';
      }
    }

    // A speaker credited on both sides is corroboration, not identification —
    // it can promote a plausible match but must never create one on its own.
    //
    // The bonus is applied to `rank`, which is deliberately NOT capped at 1,
    // while the reported score is. Capping both made corroboration useless
    // exactly where it is worth most: DrupalJam 2024 ran a "Past, Present and
    // Future of Drupal" keynote and a "…of Open Source" discussion, and each
    // had its own video. With `drupal` a stop word both titles reduce to
    // {past, present, future}, so both videos scored a flat 1.0 against the
    // keynote, the margin guard saw a tie and refused — discarding a match the
    // credited speaker (Dries Buytaert, named in one video title and not the
    // other) identified beyond doubt.
    const videoText = normalizeTitle(video.title);
    const corroborated = score >= 0.5 && speakerNames.some((n) => videoText.includes(n));
    // Room + start time identifies rather than merely supports, so it carries
    // no title-similarity floor at all: "Loods5 11:00 Machine Learning" and the
    // schedule's "Make your search results relevant again" share not one word,
    // and are the same talk. The caller only supplies `slot` for a room/time
    // pair that occurs ONCE in the event, so a repeat across days cannot claim
    // the wrong session.
    const slotHit = !!slot && slotCorroborates(video.title, slot.room, slot.time);
    const soloHit = soloSpeakerCorroborates(video.title, slot?.soloSpeakers || []);
    const unique = slotHit || soloHit;
    let rank = score;
    if (corroborated) rank += 0.12;
    if (unique) rank += 0.5;
    if (method === 'tokens') {
      if (unique)
        method = corroborated ? 'tokens+slot+speaker' : `tokens+${slotHit ? 'slot' : 'solo'}`;
      else if (corroborated) method = 'tokens+speaker';
    } else if (unique && !method) {
      // The titles share nothing at all — "Loods5 11:00 Machine Learning" vs
      // "Make your search results relevant again", or a video named only for
      // its speaker — so no pass named a method. The unique key is the entire
      // basis for this match, and has to say so.
      method = slotHit ? 'slot' : 'solo';
    }

    if (!best || rank > best.rank) {
      if (best) runnerUp = Math.max(runnerUp, best.rank);
      best = { video, score: Math.min(1, score), rank, method };
    } else {
      runnerUp = Math.max(runnerUp, rank);
    }
  }
  return best ? { ...best, runnerUp } : null;
}

/** Confident enough to write without a human looking at it? */
export function isConfidentMatch(match) {
  if (!match) return false;
  if (match.method === 'exact' || match.method === 'substring' || match.method === 'prefix')
    return true;
  const rank = match.rank ?? match.score;
  // A room-and-time agreement is a unique key, so it stands on its own: the
  // title similarity floor would reject "Kalvermelk1 11:00 JSON:API" against
  // "Stop the noise! Introduction to the JSON:API specification" even though
  // nothing else could have been in that room at that minute. The margin still
  // applies, so a second video claiming the same slot blocks both.
  if (/slot|solo/.test(String(match.method))) return rank - match.runnerUp >= MARGIN;
  // Otherwise the threshold is on the honest score and the margin on the rank,
  // so speaker corroboration separates two otherwise identical titles.
  return match.score >= ACCEPT && rank - match.runnerUp >= MARGIN;
}

// ── The backfill itself ─────────────────────────────────────────────────────

const videoId = (url) => String(url || '').match(/[A-Za-z0-9_-]{11}(?=$|[?&])/)?.[0] || '';

/**
 * A session's start as the organisers wrote it on the day — "11:00", not the
 * stored UTC. Video titles that name a time always name the local one.
 */
function localTime(startTime, timezone) {
  if (!startTime || !timezone) return '';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(startTime));
  } catch {
    return '';
  }
}

/**
 * Fill empty `video_url` fields in one dataset from one playlist.
 *
 * Never overwrites an existing value unless `relink` is set: the older scripts
 * in this repo assign `video_url = match || ''`, which silently wipes a
 * hand-curated URL every time the matcher misses.
 */
export async function backfillDataset({
  path,
  listId,
  videos,
  write = false,
  relink = false,
  stopWords = new Set(BASE_STOP_WORDS),
}) {
  const payload = JSON.parse(await readFile(path, 'utf8'));
  const items = payload.items || [];

  // A video already claimed by another session cannot be the answer here;
  // dropping it also lets the runner-up margin be computed against genuine
  // alternatives rather than one that is already spoken for.
  const used = new Set(items.map((i) => videoId(i.video_url)).filter(Boolean));
  const filled = [];
  const review = [];

  // Room + local start time is only a unique key if it occurs once. A two-day
  // event can reuse a room at the same hour on both days, and a video naming
  // just "Loods 8 11:00" could then belong to either — so the pairs that repeat
  // are withheld from the matcher rather than allowed to guess.
  const tz = payload.event?.timezone;
  const slotOf = (i) => `${String(i.location || '').toLowerCase()}|${localTime(i.startTime, tz)}`;
  const slotCount = {};
  for (const i of items) {
    if (!countsAsSession(i) || !i.location) continue;
    slotCount[slotOf(i)] = (slotCount[slotOf(i)] || 0) + 1;
  }

  // A speaker only identifies a session if they gave exactly one.
  const speakerCount = {};
  for (const i of items) {
    if (!countsAsSession(i)) continue;
    for (const s of i.speakers || [])
      speakerCount[normalizeTitle(s)] = (speakerCount[normalizeTitle(s)] || 0) + 1;
  }

  for (const item of items) {
    if (!countsAsSession(item)) continue;
    if (String(item.video_url || '').trim() && !relink) continue;
    const match = bestVideoMatch(
      item,
      videos.filter((v) => !used.has(v.id)),
      stopWords,
      {
        ...(slotCount[slotOf(item)] === 1
          ? { room: item.location, time: localTime(item.startTime, tz) }
          : {}),
        soloSpeakers: (item.speakers || []).filter((s) => speakerCount[normalizeTitle(s)] === 1),
      },
    );
    if (!match) continue;
    const row = {
      title: item.title,
      video: match.video.title,
      url: `https://youtu.be/${match.video.id}`,
      score: Number(match.score.toFixed(3)),
      runnerUp: Number(match.runnerUp.toFixed(3)),
      method: match.method,
    };
    if (isConfidentMatch(match)) {
      used.add(match.video.id);
      filled.push(row);
      if (write) item.video_url = row.url;
    } else if (match.score > 0.3) {
      review.push(row);
    }
  }

  // Record where the recordings came from. The schema has carried
  // `event.videoPlaylist` all along but few events ever had it set, so an
  // auditor could not tell "no playlist exists" from "nobody has looked yet".
  const playlistUrl = `https://www.youtube.com/playlist?list=${listId}`;
  const addedPlaylist = payload.event?.videoPlaylist !== playlistUrl;
  if (write && payload.event) payload.event.videoPlaylist = playlistUrl;

  if (write && (filled.length || addedPlaylist)) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`);
  }

  const real = items.filter(countsAsSession);
  return {
    filled,
    review,
    realSessions: real.length,
    withVideo: real.filter((i) => String(i.video_url || '').trim()).length,
  };
}
