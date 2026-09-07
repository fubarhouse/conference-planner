// Taking a session abstract from its recording's YouTube description is only
// safe because of what these three functions reject. Every case below is one
// that actually occurred while backfilling DrupalJam 2024 and 2025.
import { describe, it, expect } from 'vitest';
import { cleanDescription, describesSession, splitAtSiblingTitle } from '../videoDescriptions.mjs';

describe('cleanDescription', () => {
  it('drops the speaker and role header the channel prepends', () => {
    const raw =
      'Brent Gees and Wouter de Bruycker\nDrupal developer @ Dropsolid\n\nDrupal can be your perfect technical SEO platform.';
    expect(cleanDescription(raw, ['Brent Gees', 'Wouter de Bruycker'])).toBe(
      'Drupal can be your perfect technical SEO platform.',
    );
  });

  it('drops trailing social and link lines', () => {
    const raw =
      'Keynote about post-growth entrepreneurship.\n\nMelanie Riebank on LinkedIn : https://nl.linkedin.com/in/mrieback';
    expect(cleanDescription(raw, ['Melanie Rieback'])).toBe(
      'Keynote about post-growth entrepreneurship.',
    );
  });

  it('keeps an abstract that happens to open with a name-like phrase', () => {
    // Only a line matching a CREDITED speaker is packaging; prose is not.
    const raw =
      'Len is a long time contributor to Drupal core.\nHe will talk about how he started.';
    expect(cleanDescription(raw, ['Lennard Swaneveld'])).toBe(raw);
  });

  it('survives an empty or missing description', () => {
    expect(cleanDescription('', [])).toBe('');
    expect(cleanDescription(null, [])).toBe('');
  });
});

describe('describesSession', () => {
  const siblings = [{ title: 'Cloud agnostic Drupal' }, { title: 'Getting ready for Drupal 11' }];

  it('convicts a description that belongs to another session', () => {
    // The real defect: the "Hosting large scale conferences" video carries the
    // abstract for "Cloud agnostic Drupal". Its own title still scores, because
    // both talks are about hosting — the rival scoring higher is what gives it
    // away, so the GAP is the signal, not the absolute score.
    const text =
      'Cloud agnostic Drupal. In current times everybody is hopping into the cloud, jumping between clouds is difficult.';
    const fit = describesSession(
      text,
      { title: 'Hosting large scale conferences with open source tools' },
      siblings,
    );
    expect(fit.gap).toBeGreaterThan(0.3);
  });

  it('clears a description that matches its own session', () => {
    const text =
      'Last year you learned about the road to Drupal 11 and the challenges we faced getting ready.';
    const fit = describesSession(text, { title: 'Getting ready for Drupal 11' }, [
      { title: 'Cloud agnostic Drupal' },
    ]);
    expect(fit.own).toBeGreaterThanOrEqual(0.25);
    expect(fit.gap).toBeLessThanOrEqual(0.3);
  });

  it('scores nothing when the session has no usable title words', () => {
    expect(describesSession('anything at all', { title: 'AI' }, []).own).toBe(0);
  });
});

describe('splitAtSiblingTitle', () => {
  const siblings = [{ title: 'Competition, Collaboration, and Allies [discussion]' }];
  const text = [
    'We build on the opening keynote, exploring the open source world.',
    'Competition, Collaboration, and Allies',
    'In the Open Source world, we have friends, competitors, and dependencies.',
  ].join('\n');

  it('cuts a two-session description at the second session title', () => {
    const { own, rest } = splitAtSiblingTitle(text, siblings);
    expect(own).toBe('We build on the opening keynote, exploring the open source world.');
    expect(rest).toHaveLength(1);
    expect(rest[0].title).toBe('Competition, Collaboration, and Allies [discussion]');
    expect(rest[0].text).toContain('friends, competitors');
  });

  it('matches a heading that omits the schedule title’s format tag', () => {
    // The schedule says "… [discussion]"; the video heading does not.
    expect(splitAtSiblingTitle(text, siblings).rest[0].text).not.toContain(
      'Competition, Collaboration',
    );
  });

  it('leaves a single-session description whole', () => {
    const one = 'Just one abstract, no headings that name another talk.';
    expect(splitAtSiblingTitle(one, siblings)).toEqual({ own: one, rest: [] });
  });

  it('never treats the opening line as a split point', () => {
    // Otherwise a video titled after the sibling would yield an empty abstract.
    const lead = 'Competition, Collaboration, and Allies\nThe abstract follows here.';
    expect(splitAtSiblingTitle(lead, siblings).own).toBe(lead);
  });
});
