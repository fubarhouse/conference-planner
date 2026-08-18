import { describe, it, expect, vi } from 'vitest';
import {
  escapeHtml,
  normalizeTracks,
  formatDateForICS,
  buildSummaryFromText,
  deriveSummaryFromEvent,
  formatHoursDuration,
  normalizeSummaryText,
  deriveOfficialWebsite,
  highlightKeywords,
  formatDuration,
  debounce,
  once,
  slugify,
  parseSponsorIds,
  getLocalDate,
  normalizeString,
} from '../utils.js';

describe('normalizeString', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeString('  hello  ')).toBe('hello');
  });

  it('coerces null/undefined to an empty string', () => {
    expect(normalizeString(null)).toBe('');
    expect(normalizeString(undefined)).toBe('');
  });

  it('returns the fallback when the value is empty or blank', () => {
    expect(normalizeString('', 'auto')).toBe('auto');
    expect(normalizeString('   ', 'auto')).toBe('auto');
    expect(normalizeString(null, 'auto')).toBe('auto');
  });

  it('matches the String(x || "").trim() idiom it replaces', () => {
    expect(normalizeString(0)).toBe('');
    expect(normalizeString(false)).toBe('');
    expect(normalizeString(42)).toBe('42');
  });
});

describe('escapeHtml', () => {
  it('escapes all five special characters', () => {
    expect(escapeHtml('<script>&"\'test</script>')).toBe(
      '&lt;script&gt;&amp;&quot;&#39;test&lt;/script&gt;',
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
  it('returns a YYYY-MM-DD string in the given timezone', () => {
    // 2025-01-01T00:00:00Z is Jan 1 in UTC, Jan 1 11:00 AEDT (+11)
    expect(getLocalDate('2025-01-01T00:00:00Z', 'Australia/Sydney')).toBe('2025-01-01');
  });

  it('handles timezone boundary correctly', () => {
    // 2025-07-10T03:00:00Z is July 9 in New York (EDT = UTC-4)
    expect(getLocalDate('2025-07-10T03:00:00Z', 'America/New_York')).toBe('2025-07-09');
  });
});

// ── formatDuration ────────────────────────────────────────────────────────────

describe('formatDuration', () => {
  it('returns minutes-only for PT30M', () => {
    expect(formatDuration(null, 'PT30M')).toBe('30m');
  });

  it('returns hours-only for PT2H', () => {
    expect(formatDuration(null, 'PT2H')).toBe('2h');
  });

  it('returns decimal notation for a 30-minute fraction', () => {
    expect(formatDuration(null, 'PT1H30M')).toBe('1.5h');
  });

  it('returns combined h+m notation for non-half-hour fractions', () => {
    expect(formatDuration(null, 'PT1H45M')).toBe('1h45m');
  });

  it('returns 0m for PT0M', () => {
    expect(formatDuration(null, 'PT0M')).toBe('0m');
  });

  it('ignores the event argument entirely', () => {
    expect(formatDuration({ anything: true }, 'PT1H')).toBe('1h');
  });
});

// ── highlightKeywords ─────────────────────────────────────────────────────────

describe('highlightKeywords', () => {
  it('wraps the matching term in a keyword-highlight span', () => {
    const result = highlightKeywords('Hello World', 'World');
    expect(result).toBe('Hello <span class="keyword-highlight">World</span>');
  });

  it('is case-insensitive', () => {
    expect(highlightKeywords('Hello World', 'world')).toContain('keyword-highlight');
  });

  it('returns text unchanged when keyword is empty', () => {
    expect(highlightKeywords('Hello', '')).toBe('Hello');
  });

  it('returns text unchanged when keyword is whitespace-only', () => {
    expect(highlightKeywords('Hello', '   ')).toBe('Hello');
  });

  it('escapes regex special characters in the keyword', () => {
    expect(() => highlightKeywords('1+1=2', '1+1')).not.toThrow();
    expect(highlightKeywords('1+1=2', '1+1')).toContain('keyword-highlight');
  });

  it('highlights all occurrences', () => {
    const result = highlightKeywords('foo and foo', 'foo');
    expect((result.match(/keyword-highlight/g) || []).length).toBe(2);
  });
});

// ── debounce ──────────────────────────────────────────────────────────────────

describe('debounce', () => {
  it('does not invoke the function before the wait period', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 100);
    debounced();
    expect(fn).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('invokes the function after the wait period', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 100);
    debounced();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('fires only once for rapid successive calls', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 100);
    debounced();
    debounced();
    debounced();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('passes the most recent arguments to the function', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 50);
    debounced('first');
    debounced('second');
    vi.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalledWith('second');
    vi.useRealTimers();
  });
});

// ── normalizeSummaryText ──────────────────────────────────────────────────────

describe('normalizeSummaryText', () => {
  it('returns empty string for empty input', () => {
    expect(normalizeSummaryText('')).toBe('');
    expect(normalizeSummaryText(null)).toBe('');
  });

  it('strips markdown headings', () => {
    expect(normalizeSummaryText('## Title\nContent here.')).toBe('Content here.');
  });

  it('strips blockquote lines', () => {
    expect(normalizeSummaryText('> A quote\nNormal text.')).toBe('Normal text.');
  });

  it('strips table header and delimiter rows', () => {
    const table = '| Col A | Col B |\n| --- | --- |\n| a | b |';
    expect(normalizeSummaryText(table)).toBe('');
  });

  it('joins remaining lines into a single space-separated string', () => {
    expect(normalizeSummaryText('Line one.\nLine two.')).toBe('Line one. Line two.');
  });

  it('collapses multiple spaces', () => {
    expect(normalizeSummaryText('too   many   spaces')).toBe('too many spaces');
  });

  it('removes empty lines', () => {
    expect(normalizeSummaryText('first\n\nsecond')).toBe('first second');
  });
});

// ── deriveOfficialWebsite ─────────────────────────────────────────────────────

describe('deriveOfficialWebsite', () => {
  it('returns empty string for null or empty metadata', () => {
    expect(deriveOfficialWebsite(null)).toBe('');
    expect(deriveOfficialWebsite({})).toBe('');
  });

  it('returns the website URL stripped of hash and query', () => {
    expect(deriveOfficialWebsite({ website: 'https://example.com/about?utm=1#footer' })).toBe(
      'https://example.com/about',
    );
  });

  it('strips a trailing /schedule path segment', () => {
    expect(deriveOfficialWebsite({ website: 'https://example.com/schedule' })).toBe(
      'https://example.com',
    );
  });

  it('strips a trailing /programme path segment', () => {
    expect(deriveOfficialWebsite({ website: 'https://example.com/programme' })).toBe(
      'https://example.com',
    );
  });

  it('falls back to the first scheduleURL when website is absent', () => {
    const meta = { website: '', scheduleURLs: ['https://example.com/schedule'] };
    expect(deriveOfficialWebsite(meta)).toBe('https://example.com');
  });

  it('prefers website over scheduleURL when both are present', () => {
    const meta = { website: 'https://primary.com', scheduleURLs: ['https://fallback.com'] };
    expect(deriveOfficialWebsite(meta)).toBe('https://primary.com');
  });
});

// ── once ──────────────────────────────────────────────────────────────────────

describe('once', () => {
  it('calls the wrapped function only once across multiple invocations', () => {
    const fn = vi.fn().mockResolvedValue('result');
    const wrapped = once(fn);
    wrapped();
    wrapped();
    wrapped();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('returns the same promise on every call', () => {
    const fn = vi.fn().mockResolvedValue('x');
    const wrapped = once(fn);
    expect(wrapped()).toBe(wrapped());
  });

  it('resolves to the value returned by the first call', async () => {
    const wrapped = once(() => Promise.resolve(42));
    expect(await wrapped()).toBe(42);
    expect(await wrapped()).toBe(42);
  });
});
