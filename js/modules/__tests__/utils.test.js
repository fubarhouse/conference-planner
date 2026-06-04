

import { describe, it, expect, beforeEach } from 'vitest';
import state from '../state.js';
import {
  escapeHtml,
  normalizeTracks,
  formatDateForICS,
  buildSummaryFromText,
  deriveSummaryFromEvent,
  formatHoursDuration,
  slugify,
  parseSponsorIds,
  getLocalDate,
} from '../utils.js';

beforeEach(() => {
  state.eventMeta = { timezone: 'UTC' };
});

describe('escapeHtml', () => {
  it('escapes all five special characters', () => {
    expect(escapeHtml('<script>&"\'test</script>')).toBe(
      '&lt;script&gt;&amp;&quot;&#39;test&lt;/script&gt;'
    );
  });

  it('handles null and undefined without throwing', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('passes through plain strings unchanged', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });
});

describe('normalizeTracks', () => {
  it('splits a comma-separated string into an array', () => {
    expect(normalizeTracks('DevOps, Frontend, Backend')).toEqual(['DevOps', 'Frontend', 'Backend']);
  });

  it('flattens and deduplicates an array of values', () => {
    expect(normalizeTracks(['DevOps', 'Frontend, DevOps'])).toEqual(['DevOps', 'Frontend']);
  });

  it('returns empty array for empty input', () => {
    expect(normalizeTracks('')).toEqual([]);
    expect(normalizeTracks(null)).toEqual([]);
    expect(normalizeTracks([])).toEqual([]);
  });

  it('trims whitespace from each track', () => {
    expect(normalizeTracks('  DevOps ,  Frontend  ')).toEqual(['DevOps', 'Frontend']);
  });
});

describe('formatDateForICS', () => {
  it('strips dashes and colons from an ISO date-time string', () => {
    expect(formatDateForICS('2025-07-10T09:00:00Z')).toBe('20250710T090000Z');
  });

  it('removes sub-second precision', () => {
    expect(formatDateForICS('2025-07-10T09:00:00.000Z')).toBe('20250710T090000Z');
  });
});

describe('buildSummaryFromText', () => {
  it('returns empty string for empty input', () => {
    expect(buildSummaryFromText('')).toBe('');
    expect(buildSummaryFromText(null)).toBe('');
  });

  it('appends ellipsis to truncated text', () => {
    const long = 'a'.repeat(200);
    const result = buildSummaryFromText(long, 128);
    expect(result).toHaveLength(131); // 128 chars + '...'
    expect(result.endsWith('...')).toBe(true);
  });

  it('does not double-append ellipsis', () => {
    const result = buildSummaryFromText('short text...', 128);
    expect(result).toBe('short text...');
  });

  it('strips markdown headings and blockquotes before summarising', () => {
    const md = '## Title\n> Quote\nActual content here.';
    expect(buildSummaryFromText(md, 128)).toBe('Actual content here....');
  });
});

describe('deriveSummaryFromEvent', () => {
  it('returns empty string when full_description is absent', () => {
    expect(deriveSummaryFromEvent({})).toBe('');
    expect(deriveSummaryFromEvent(null)).toBe('');
  });

  it('truncates full_description to the given maxLen', () => {
    const event = { full_description: 'word '.repeat(40) };
    const result = deriveSummaryFromEvent(event, 20);
    expect(result.length).toBeLessThanOrEqual(23); // 20 + '...'
  });
});

describe('formatHoursDuration', () => {
  it('returns minutes-only string when hours is zero', () => {
    expect(formatHoursDuration(0.5)).toBe('30m');
  });

  it('returns hours-only string when minutes is zero', () => {
    expect(formatHoursDuration(2)).toBe('2h');
  });

  it('returns combined string for fractional hours', () => {
    expect(formatHoursDuration(1.5)).toBe('1h30m');
  });
});

describe('slugify', () => {
  it('lowercases and replaces spaces with hyphens', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  it('strips accents', () => {
    expect(slugify('Café')).toBe('cafe');
  });

  it('collapses multiple non-alphanumeric chars into a single hyphen', () => {
    expect(slugify('a  --  b')).toBe('a-b');
  });

  it('returns empty string for empty input', () => {
    expect(slugify('')).toBe('');
    expect(slugify(null)).toBe('');
  });
});

describe('parseSponsorIds', () => {
  it('splits a space-or-comma-separated string', () => {
    expect(parseSponsorIds('s-1,s-2')).toEqual(['s-1', 's-2']);
  });

  it('returns array items trimmed when given an array', () => {
    expect(parseSponsorIds([' s-1 ', 's-2'])).toEqual(['s-1', 's-2']);
  });

  it('filters out empty entries', () => {
    expect(parseSponsorIds('s-1,,s-2')).toEqual(['s-1', 's-2']);
  });
});

describe('getLocalDate', () => {
  it('returns a YYYY-MM-DD string in the configured timezone', () => {
    state.eventMeta = { timezone: 'Australia/Sydney' };
    // 2025-01-01T00:00:00Z is Jan 1 in UTC, Jan 1 11:00 AEDT (+11)
    expect(getLocalDate('2025-01-01T00:00:00Z')).toBe('2025-01-01');
  });

  it('handles timezone boundary correctly', () => {
    state.eventMeta = { timezone: 'America/New_York' };
    // 2025-07-10T03:00:00Z is July 9 in New York (EDT = UTC-4)
    expect(getLocalDate('2025-07-10T03:00:00Z')).toBe('2025-07-09');
  });
});