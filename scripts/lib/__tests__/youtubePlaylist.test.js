// The matcher decides, unsupervised, which recording belongs to which session
// across ~5,000 archive sessions. Every case here is one that actually went
// wrong — or nearly did — while backfilling DrupalSouth and DrupalCon.
import { describe, it, expect } from 'vitest';
import {
  bestVideoMatch,
  isCompanion,
  isConfidentMatch,
  normalizeTitle,
  slotCorroborates,
  titleSegments,
  tokenScore,
  tokenize,
  BASE_STOP_WORDS,
} from '../youtubePlaylist.mjs';

const STOP = new Set(BASE_STOP_WORDS);
const vid = (title, id = 'aaaaaaaaaaa') => ({ id, title, author: '' });

describe('normalizeTitle', () => {
  it('folds case, accents and punctuation so schedule and video text can meet', () => {
    expect(normalizeTitle('Pōwhiri: Ā mātou —  Welcome!')).toBe('powhiri a matou welcome');
  });

  it('spells out the ampersand rather than dropping it', () => {
    // "R&D" and "R and D" have to reach the same tokens, or a title that
    // spells it out stops matching one that does not.
    expect(normalizeTitle('Drupal & Symfony')).toBe('drupal and symfony');
  });

  it('treats nothing as nothing rather than throwing', () => {
    expect(normalizeTitle(null)).toBe('');
    expect(normalizeTitle(undefined)).toBe('');
  });
});

describe('titleSegments', () => {
  it('pulls the session title out of "Speaker - Title"', () => {
    // DrupalCon Canberra 2018's convention.
    expect(titleSegments('Jay Friendly - Drupal 8 Architectural Paradigms')).toContain(
      'Drupal 8 Architectural Paradigms',
    );
  });

  it('pulls it out of "Title / Track / Speaker"', () => {
    // DrupalSouth 2026's convention.
    const segs = titleSegments('Rethinking the JavaScript Reflex / Web Tools / Brynn Briedis');
    expect(segs).toContain('Rethinking the JavaScript Reflex');
  });

  it('pulls it out of a quoted "Session: … by Speaker"', () => {
    // DrupalSouth Gold Coast 2016's convention.
    const segs = titleSegments('Session: "Using SVGs in Drupal" by Rikki Bochow');
    expect(segs).toContain('Using SVGs in Drupal');
  });

  it('keeps a title that contains the separator joined as well as split', () => {
    // "Title: Subtitle / Track" must not lose its own colon to the split.
    const segs = titleSegments('Death to the Black Box: Winning in 2026 / Keynote / A Speaker');
    expect(segs).toContain('Death to the Black Box: Winning in 2026');
  });

  it('drops fragments too short to identify anything', () => {
    // The split pieces go; the whole string stays, but carries no tokens long
    // enough to score, so it cannot match anything either.
    const segs = titleSegments('A / B / C');
    expect(segs).not.toContain('A');
    expect(segs).not.toContain('B');
    expect(tokenize(segs.join(' '), STOP).size).toBe(0);
  });
});

describe('tokenScore', () => {
  it('scores full overlap of a truncated title against the full one', () => {
    const a = tokenize('Practical Performance Testing', STOP);
    const b = tokenize('Practical Performance Testing at scale', STOP);
    expect(tokenScore(a, b)).toBe(1);
  });

  it('refuses to score when either side has fewer than three distinctive tokens', () => {
    // The regression that mattered: the track name "UX & Content" reduces to
    // {content} and scored a perfect 1.0 against every content talk in the
    // 2026 playlist, because the ratio is over the SMALLER set.
    const track = tokenize('UX & Content', STOP);
    const session = tokenize('Creating scalable structure: Content design systems', STOP);
    expect(track.size).toBeLessThan(3);
    expect(tokenScore(track, session)).toBe(0);
  });
});

describe('isCompanion', () => {
  it('rejects an interview that shares a keynote speaker name', () => {
    // The 2014 playlist was four corridor interviews and one keynote;
    // "DrupalSouth Interview - Emma jane Westby" scored a perfect overlap
    // against the session "Keynote: Emma Jane Westby".
    expect(
      isCompanion(vid('DrupalSouth Interview - Emma jane Westby'), {
        title: 'Keynote: Emma Jane Westby',
      }),
    ).toBe(true);
  });

  it('rejects an initiative retrospective standing in for the session', () => {
    expect(
      isCompanion(vid('A Review of the Automated Updates Initiative at DrupalCon'), {
        title: 'Automated Updates Initiative Keynote Q&A',
      }),
    ).toBe(true);
  });

  it('allows the genre through when the session is itself that genre', () => {
    expect(
      isCompanion(vid('Interview with the core maintainers'), {
        title: 'Interview with the core maintainers',
      }),
    ).toBe(false);
  });

  it('does not treat an ordinary session as companion content', () => {
    expect(
      isCompanion(vid('Practical Performance Testing'), { title: 'Practical Performance Testing' }),
    ).toBe(false);
  });
});

describe('bestVideoMatch', () => {
  const session = { title: 'Rethinking the JavaScript Reflex', speakers: ['Brynn Briedis'] };

  it('prefers an exact segment match and scores it 1', () => {
    const m = bestVideoMatch(session, [
      vid('Something else entirely about caching layers', 'bbbbbbbbbbb'),
      vid('Rethinking the JavaScript Reflex / Web Tools / Brynn Briedis', 'ccccccccccc'),
    ]);
    expect(m.method).toBe('exact');
    expect(m.video.id).toBe('ccccccccccc');
  });

  it('matches a truncated video title on its prefix', () => {
    const m = bestVideoMatch(
      {
        title: "Including Disabled Peoples' Voice in Consultation and Service Design",
        speakers: [],
      },
      [vid("Including Disabled Peoples' Voice in Consultation, Service...")],
    );
    expect(isConfidentMatch(m)).toBe(true);
  });

  it('ignores a video already claimed by another session', () => {
    // The caller filters `used` out; this documents that contract — the pool
    // is the only thing standing between two similar sessions and a swap.
    const pool = [vid('Rethinking the JavaScript Reflex', 'ccccccccccc')];
    const m = bestVideoMatch(
      session,
      pool.filter((v) => v.id !== 'ccccccccccc'),
    );
    expect(m).toBeNull();
  });

  it('returns null for a session with no usable title', () => {
    expect(bestVideoMatch({ title: 'Hi', speakers: [] }, [vid('Anything at all here')])).toBeNull();
  });

  it('lets a credited speaker break a tie between two identical-scoring videos', () => {
    // DrupalJam 2024 ran "Past, Present and Future of Drupal" (keynote) and
    // "…of Open Source" (discussion), each with its own recording. With
    // `drupal` a stop word both titles reduce to {past, present, future}, so
    // both videos scored a flat 1.0 against the keynote and the margin guard
    // threw the match away. The speaker named in one title and not the other
    // is what distinguishes them, so the bonus has to survive the 1.0 cap.
    const keynote = {
      title: 'Past, Present and Future of Drupal [keynote]',
      speakers: ['Dries Buytaert'],
    };
    const m = bestVideoMatch(keynote, [
      vid('The Past, Present, and Future of Open Source [Open Up Session]', 'bxkSzU2AG1o'),
      vid(
        'Past, Present and Future of Drupal by Dries Buytaert [keynote and opening]',
        'ibDKONT13ck',
      ),
    ]);
    expect(m.video.id).toBe('ibDKONT13ck');
    expect(isConfidentMatch(m)).toBe(true);
    // The reported score stays an honest 0..1 even though the rank exceeded it.
    expect(m.score).toBeLessThanOrEqual(1);
  });

  it('still refuses when the tie has no corroboration to break it', () => {
    const session = { title: 'Past, Present and Future of Drupal [keynote]', speakers: [] };
    const m = bestVideoMatch(session, [
      vid('The Past, Present, and Future of Open Source [Open Up Session]', 'aaa'),
      vid('Past, Present and Future of Something Else entirely', 'bbb'),
    ]);
    expect(isConfidentMatch(m)).toBe(false);
  });
});

describe('slotCorroborates', () => {
  const V = 'DrupalJam:XL Kalvermelk1 11:00 JSON:API (By Björn Brala)';

  it('recognises the room and start time a session ran in', () => {
    // The room is spelled without a space on the video and with one on the
    // schedule, so the comparison has to ignore spacing.
    expect(slotCorroborates(V, 'Kalvermelk 1', '11:00')).toBe(true);
  });

  it('rejects the right room at the wrong time', () => {
    expect(slotCorroborates(V, 'Kalvermelk 1', '12:00')).toBe(false);
  });

  it('rejects the right time in the wrong room', () => {
    expect(slotCorroborates(V, 'Silo 0', '11:00')).toBe(false);
  });

  it('needs both halves of the key to be present at all', () => {
    expect(slotCorroborates(V, '', '11:00')).toBe(false);
    expect(slotCorroborates(V, 'Kalvermelk 1', '')).toBe(false);
  });

  it('ignores a room name too short to be distinctive', () => {
    // "A" or "1" would otherwise match almost any title by accident.
    expect(slotCorroborates('Track 1 11:00 Something', 'A', '11:00')).toBe(false);
  });
});

describe('isConfidentMatch', () => {
  it('accepts the deterministic methods outright', () => {
    for (const method of ['exact', 'substring', 'prefix'])
      expect(isConfidentMatch({ method, score: 0.9, runnerUp: 0.9 })).toBe(true);
  });

  it('rejects a strong fuzzy score that a rival ties', () => {
    // Two near-identical sessions — a talk and its hands-on workshop — are the
    // failure mode no threshold alone prevents, so the margin is what decides.
    expect(isConfidentMatch({ method: 'tokens', score: 1, runnerUp: 1 })).toBe(false);
    expect(isConfidentMatch({ method: 'tokens', score: 0.95, runnerUp: 0.9 })).toBe(false);
  });

  it('accepts a fuzzy score that clears both the threshold and the margin', () => {
    expect(isConfidentMatch({ method: 'tokens', score: 0.9, runnerUp: 0.5 })).toBe(true);
  });

  it('rejects nothing at all', () => {
    expect(isConfidentMatch(null)).toBe(false);
  });

  it('accepts a slot-identified match below the title-similarity floor', () => {
    // "Kalvermelk1 11:00 JSON:API" shares too few words with "Stop the noise!
    // Introduction to the JSON:API specification" to clear ACCEPT, but nothing
    // else was in that room at that minute.
    expect(isConfidentMatch({ method: 'tokens+slot', score: 0.4, rank: 0.9, runnerUp: 0.2 })).toBe(
      true,
    );
  });

  it('still refuses when a second video claims the same slot', () => {
    expect(isConfidentMatch({ method: 'tokens+slot', score: 0.4, rank: 0.9, runnerUp: 0.9 })).toBe(
      false,
    );
  });
});
