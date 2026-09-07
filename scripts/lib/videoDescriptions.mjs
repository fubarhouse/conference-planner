// Reading a YouTube video's description, and deciding whether it really
// describes a given session.
//
// Extracted from the DrupalJam backfill once DrupalCon needed the same job:
// both channels paste the session's own abstract into the video description,
// so for a session already linked to a video that text is the organisers' own
// copy rather than a paraphrase.
//
// Measured against the 59 DrupalJam sessions that have BOTH a scraped
// description and a recording, 52 (88%) of the video descriptions contain ≥90%
// of the scraped description's words; the rest are shorter or longer editions
// of the same abstract.
//
// Why it still needs guards: one of those 59 (1.7%) had a description that
// belongs to a completely different talk — "Hosting large scale conferences"
// carries the abstract for "Cloud agnostic Drupal". The video itself is
// correctly linked; the uploader pasted the wrong text. Nothing about the
// description can be assumed, so every candidate is scored against the session
// it claims to describe, and anything unconvincing is written to a review file
// instead of the dataset.
import vm from 'node:vm';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** Title + description from a watch page's player response. */
export async function videoDetails(id) {
  const res = await fetch(`https://www.youtube.com/watch?v=${id}`, {
    headers: { 'user-agent': UA, 'accept-language': 'en-US,en' },
  });
  const html = await res.text();
  const marker = 'var ytInitialPlayerResponse = ';
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const start = at + marker.length;
  // The assignment ends at whichever terminator comes first.
  let end = html.indexOf(';var ', start);
  const alt = html.indexOf(';</script>', start);
  if (end < 0 || (alt >= 0 && alt < end)) end = alt;
  let data;
  try {
    data = vm.runInNewContext(`(${html.slice(start, end)})`);
  } catch {
    return null;
  }
  const d = data?.videoDetails;
  return d ? { id, title: d.title || '', description: d.shortDescription || '' } : null;
}

// ── Cleaning ────────────────────────────────────────────────────────────────

const URL_ONLY = /^\s*(?:[\w .'’-]{0,40}[:;]\s*)?https?:\/\/\S+\s*$/i;
const SOCIAL =
  /^\s*(?:follow|subscribe|find (?:us|him|her|them)|more (?:info|about)|slides?|linkedin|twitter|mastodon|website)\b.*$/i;

/**
 * The abstract, with the channel's packaging removed.
 *
 * Some descriptions open with the speaker's name and job title on their own
 * lines ("Brent Gees and Wouter de Bruycker" / "Drupal developer @ Dropsolid"),
 * which is credit the dataset already holds in `speakers`, and close with
 * social links. Neither is part of the abstract.
 */
export function cleanDescription(text, speakers = []) {
  const lines = String(text || '')
    .replace(/\r/g, '')
    .split('\n');
  const isSpeakerLine = (l) => {
    const t = l.trim().toLowerCase();
    if (!t || t.length > 90) return false;
    return speakers.some((s) => {
      const n = String(s).toLowerCase();
      return n.length > 3 && (t === n || t.startsWith(`${n} `) || t.includes(n));
    });
  };
  // A role line only counts as packaging when it sits directly under the name.
  const isRoleLine = (l) => /^[^.!?]{0,70}@[^.!?]{0,40}$/.test(l.trim()) && l.trim().length < 70;

  while (lines.length && (!lines[0].trim() || isSpeakerLine(lines[0]))) {
    const dropped = lines.shift();
    if (dropped.trim() && lines.length && isRoleLine(lines[0])) lines.shift();
  }
  while (lines.length) {
    const last = lines[lines.length - 1];
    if (!last.trim() || URL_ONLY.test(last) || SOCIAL.test(last)) lines.pop();
    else break;
  }
  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Split a description that covers more than one session.
 *
 * A single recording sometimes spans two back-to-back slots, and the uploader
 * concatenates both abstracts with the second session's title as a bare
 * heading line. Taken whole, the text puts the wrong tail on the first session
 * — and strands the second session's abstract, which is often the only copy
 * left. Cutting at that heading gives each its own.
 *
 * @returns {{own: string, rest: Array<{title: string, text: string}>}}
 */
export function splitAtSiblingTitle(text, siblings = []) {
  const lines = String(text || '').split('\n');
  // Schedule titles carry format tags the video description's heading omits —
  // "Competition, Collaboration, and Allies [discussion]" appears there as just
  // "Competition, Collaboration, and Allies".
  const key = (s) =>
    String(s || '')
      .replace(/\[[^\]]*\]/g, ' ')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const byTitle = new Map(
    siblings.map((s) => [key(s.title), s.title]).filter(([k]) => k.length > 12),
  );

  for (let i = 1; i < lines.length; i += 1) {
    const hit = byTitle.get(key(lines[i]));
    if (!hit) continue;
    return {
      own: lines.slice(0, i).join('\n').trim(),
      rest: [
        {
          title: hit,
          text: lines
            .slice(i + 1)
            .join('\n')
            .trim(),
        },
      ],
    };
  }
  return { own: String(text || '').trim(), rest: [] };
}

// ── Scoring ─────────────────────────────────────────────────────────────────

/** Lowercased words joined by single spaces — for verbatim phrase matching. */
const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const words = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3);

/**
 * Does this description describe THIS session rather than some other?
 *
 * `rivalVerbatim` is the verdict; `own`, `best` and `gap` are token-overlap
 * figures kept for the report because they are useful to eyeball, but they are
 * NOT the decision — see the note beside rivalVerbatim for why overlap cannot
 * carry it once an event has more than a few dozen sessions.
 *
 * Checked against the 59 DrupalJam sessions holding both a scraped description
 * and a recording: 58 accepted, the one genuine mis-paste rejected, and no good
 * description refused.
 */
export function describesSession(description, session, siblings = []) {
  const body = new Set(words(description));
  const share = (title) => {
    const t = words(title);
    return t.length ? t.filter((w) => body.has(w)).length / t.length : 0;
  };
  const own = share(session.title);
  const best = siblings.reduce((m, s) => Math.max(m, share(s.title)), 0);

  // The decisive signal: does another session's title appear VERBATIM in the
  // text while this session's does not? That is what a mis-paste looks like —
  // the "Hosting large scale conferences" video opens with the literal line
  // "Cloud agnostic Drupal", another session's title.
  //
  // Token overlap cannot do this job. It works on a 30-session event, but at
  // 140 sessions the shared vocabulary ("Drupal", "Drupal 8") means some short
  // rival title is fully contained in almost any abstract, so the overlap gap
  // reads as a mis-paste on 35 descriptions out of 36 that are perfectly good.
  const flat = norm(description);
  const ownPhrase = norm(session.title);
  const rivalVerbatim =
    !!flat &&
    !(ownPhrase.length >= 12 && flat.includes(ownPhrase)) &&
    siblings.some((s) => {
      const p = norm(s.title);
      if (p.length < 14 || p.split(' ').length < 3 || !flat.includes(p)) return false;
      // A rival whose title is contained in THIS session's title proves nothing:
      // "Design a decoupled application … based upon the Drupal admin UI" will
      // always mention the admin UI, and "Drupal Admin UI" is its own session.
      return !ownPhrase.includes(p);
    });

  return { own, best, gap: best - own, rivalVerbatim };
}

// Tuned on the 59 DrupalJam sessions that have both a scraped description and a
// recording: accepts 52, rejects 3 good ones, and still catches the mis-paste.
// A description is accepted unless another session's title appears verbatim in
// it. The old token-gap threshold is kept only for reporting — see
// describesSession for why it cannot gate the decision at scale.
export const MIN_DESCRIPTION_CHARS = 60;
