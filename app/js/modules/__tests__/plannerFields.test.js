import { describe, it, expect } from 'vitest';
import {
  parseBudget,
  formatAmount,
  sessionOptionsHtml,
  plannerDisplayCurrency,
  initPlannerFields,
} from '../plannerFields.js';

const fmtTime = (iso) => iso.slice(11, 16); // deterministic HH:mm

describe('parseBudget', () => {
  it('parses numeric strings', () => {
    expect(parseBudget('12.5')).toBe(12.5);
    expect(parseBudget('  10 ')).toBe(10);
  });

  it('returns 0 for blank or non-numeric input', () => {
    expect(parseBudget('')).toBe(0);
    expect(parseBudget('abc')).toBe(0);
    expect(parseBudget(null)).toBe(0);
    expect(parseBudget(undefined)).toBe(0);
  });
});

describe('plannerDisplayCurrency', () => {
  it('prefers the explicit per-planner displayCurrency', () => {
    expect(plannerDisplayCurrency({ displayCurrency: 'USD', personal: { currency: 'EUR' } })).toBe(
      'USD',
    );
  });

  it('falls back to the trip currency when displayCurrency is unset (migration-safe)', () => {
    expect(plannerDisplayCurrency({ personal: { currency: 'EUR' } })).toBe('EUR');
    expect(plannerDisplayCurrency({ mode: 'sponsor', org: { sponsorCurrency: 'JPY' } })).toBe(
      'JPY',
    );
  });

  it('falls back to the global default when nothing is set', () => {
    initPlannerFields({ state: { global: { defaultCurrency: 'NZD' } } });
    expect(plannerDisplayCurrency({})).toBe('NZD');
  });
});

describe('formatAmount', () => {
  it('formats a number with exactly two decimals and thousands grouping', () => {
    expect(formatAmount(1234.5)).toBe('1,234.50');
    expect(formatAmount(1000000)).toBe('1,000,000.00');
  });

  it('formats zero and whole numbers to two decimals', () => {
    expect(formatAmount(0)).toBe('0.00');
    expect(formatAmount(5)).toBe('5.00');
  });

  it('rounds to two decimals', () => {
    expect(formatAmount(2.005)).toBe('2.01');
  });
});

describe('sessionOptionsHtml', () => {
  const sessions = [
    { id: 's1', startTime: '2026-03-10T09:00:00Z', title: 'Keynote' },
    { id: 's2', startTime: '2026-03-10T10:30:00Z', title: 'Workshop' },
  ];

  it('starts with the blank "no linked session" option', () => {
    expect(sessionOptionsHtml(sessions, '', fmtTime)).toMatch(
      /^<option value="">— No linked session —<\/option>/,
    );
  });

  it('renders one option per session labelled "<time> <title>"', () => {
    const html = sessionOptionsHtml(sessions, '', fmtTime);
    expect(html).toContain('<option value="s1" >09:00 Keynote</option>');
    expect(html).toContain('<option value="s2" >10:30 Workshop</option>');
  });

  it('marks the selected session', () => {
    const html = sessionOptionsHtml(sessions, 's2', fmtTime);
    expect(html).toContain('<option value="s2" selected>');
    expect(html).toContain('<option value="s1" >');
  });

  it('escapes ids and titles', () => {
    const html = sessionOptionsHtml([{ id: 'a&b', startTime: 'x', title: '<b>' }], '', () => '');
    expect(html).toContain('a&amp;b');
    expect(html).toContain('&lt;b&gt;');
  });

  it('handles empty or missing session lists', () => {
    expect(sessionOptionsHtml([], '', fmtTime)).toBe(
      '<option value="">— No linked session —</option>',
    );
    expect(sessionOptionsHtml(undefined, '', fmtTime)).toBe(
      '<option value="">— No linked session —</option>',
    );
  });
});
