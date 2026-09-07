import { describe, it, expect } from 'vitest';
import { titleTokens, buildTopics, isAgendaTitle, countsAsSession } from '../archiveInsights.js';

describe('isAgendaTitle', () => {
  it('flags pure logistics titles', () => {
    for (const t of [
      'Lunch',
      'Morning Tea',
      'Afternoon Tea Break',
      'Registration',
      'Registration & Coffee',
      'Coffee Break (30 mins)',
      'Networking Drinks',
      'Closing Remarks',
      'Check-in',
    ])
      expect(isAgendaTitle(t), t).toBe(true);
  });

  it('keeps sessions that merely mention a logistics word', () => {
    for (const t of [
      'Rethinking Event Registration',
      'Improving the Registration Flow',
      'Opening Keynote',
      'Lunch-and-Learn: Decoupled Drupal', // has content words
      'How We Automated Coffee Orders with Drupal',
    ])
      expect(isAgendaTitle(t), t).toBe(false);
  });

  it('ignores empty/whitespace titles', () => {
    expect(isAgendaTitle('')).toBe(false);
    expect(isAgendaTitle('   ')).toBe(false);
  });
});

describe('titleTokens', () => {
  it('lowercases, splits, and drops stopwords + short + numeric tokens', () => {
    const t = titleTokens('Building a Decoupled Drupal Site in 2024');
    expect(t).toContain('decoupled');
    expect(t).toContain('site');
    expect(t).not.toContain('a'); // short
    expect(t).not.toContain('drupal'); // domain stopword
    expect(t).not.toContain('2024'); // numeric
    expect(t).not.toContain('in'); // stopword
  });

  it('keeps allowlisted short topic tokens like "ai"', () => {
    expect(titleTokens('AI and Machine Learning')).toContain('ai');
  });

  it('dedupes repeated terms within one title', () => {
    const t = titleTokens('Content, content, and more content');
    expect(t.filter((x) => x === 'content')).toHaveLength(1);
  });
});

describe('buildTopics', () => {
  const sessions = [
    { title: 'Getting started with AI', year: 2024 },
    { title: 'AI in Drupal', year: 2024 },
    { title: 'AI everywhere', year: 2025 },
    { title: 'A history of theming', year: 2020 },
  ];

  it('counts term frequency per year and overall, sorted by total', () => {
    const topics = buildTopics(sessions);
    const ai = topics.find((t) => t.term === 'ai');
    expect(ai.total).toBe(3);
    expect(ai.byYear).toEqual({ 2024: 2, 2025: 1 });
    expect(topics[0].term).toBe('ai'); // most frequent first
  });

  it('ignores sessions without a year', () => {
    const topics = buildTopics([{ title: 'AI', year: null }, ...sessions]);
    expect(topics.find((t) => t.term === 'ai').total).toBe(3);
  });

  it('respects the topN cap', () => {
    expect(buildTopics(sessions, 1)).toHaveLength(1);
  });
});

describe('countsAsSession', () => {
  it('falls back to the title when the flag is absent', () => {
    // Every dataset written before the field exists relies on this.
    expect(countsAsSession({ title: 'Lunch' })).toBe(false);
    expect(countsAsSession({ title: 'Morning Tea' })).toBe(false);
    expect(countsAsSession({ title: 'Driesnote' })).toBe(true);
  });

  it('lets the flag overrule a title that looks like a session', () => {
    // The case this field exists for: a sponsored break with a real name.
    expect(
      countsAsSession({ title: 'Morning Tea, proudly sponsored by Acme', isAgendaItem: true }),
    ).toBe(false);
    expect(
      countsAsSession({ title: 'Coffee & Conversation with the Board', isAgendaItem: true }),
    ).toBe(false);
  });

  it('lets the flag rescue a session that looks like logistics', () => {
    expect(countsAsSession({ title: 'Registration', isAgendaItem: false })).toBe(true);
    expect(countsAsSession({ title: 'Lunch', isAgendaItem: false })).toBe(true);
  });

  it('ignores a non-boolean flag and judges the title instead', () => {
    // A hand-edited dataset should degrade to the old behaviour, not to "true".
    expect(countsAsSession({ title: 'Lunch', isAgendaItem: 'yes' })).toBe(false);
    expect(countsAsSession({ title: 'Driesnote', isAgendaItem: null })).toBe(true);
  });

  it('survives a missing or empty item', () => {
    expect(countsAsSession({})).toBe(true);
    expect(countsAsSession(undefined)).toBe(true);
  });
});
