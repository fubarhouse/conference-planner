import { describe, it, expect, afterEach } from 'vitest';
import {
  normalizeRelatedEvents,
  groupByRelationship,
  resolveRelatedLink,
  renderRelatedEvents,
} from '../relatedEvents.js';

describe('normalizeRelatedEvents', () => {
  it('drops disabled entries and coerces fields', () => {
    const meta = {
      relatedEvents: [
        { name: 'DrupalJam', relationship: 'Partner' },
        { name: 'Hidden', relationship: 'Partner', enabled: false },
        'not an object',
      ],
    };
    const out = normalizeRelatedEvents(meta);
    expect(out.map((e) => e.name)).toEqual(['DrupalJam']);
    expect(out[0].id).toBe('drupaljam');
  });

  it('returns [] when relatedEvents is missing', () => {
    expect(normalizeRelatedEvents({})).toEqual([]);
    expect(normalizeRelatedEvents(null)).toEqual([]);
  });
});

describe('resolveRelatedLink', () => {
  it('prefers the internal schedule link over an external website', () => {
    const link = resolveRelatedLink({
      scheduleId: 'drupaljam-2026-rotterdam',
      website: 'https://x.nl',
    });
    expect(link).toEqual({ href: './index.html?id=drupaljam-2026-rotterdam', external: false });
  });
  it('falls back to the website when no scheduleId', () => {
    expect(resolveRelatedLink({ website: 'https://drupaljam.nl/' })).toEqual({
      href: 'https://drupaljam.nl/',
      external: true,
    });
  });
  it('returns null when it links nowhere', () => {
    expect(resolveRelatedLink({ name: 'x' })).toBeNull();
  });
});

describe('groupByRelationship', () => {
  it('buckets by relationship, orders groups by min priority, entries by priority', () => {
    const entries = normalizeRelatedEvents({
      relatedEvents: [
        { name: 'B conf', relationship: 'Linked Conference', priority: 20 },
        { name: 'A conf', relationship: 'Linked Conference', priority: 10 },
        { name: 'Partner one', relationship: 'Partner', priority: 5 },
      ],
    });
    const groups = groupByRelationship(entries);
    // Partner (min priority 5) before Linked Conference (min 10).
    expect(groups.map((g) => g.relationship)).toEqual(['Partner', 'Linked Conference']);
    expect(groups[1].entries.map((e) => e.name)).toEqual(['A conf', 'B conf']);
  });

  it('floats featured promotions ahead of the rest of their group', () => {
    const entries = normalizeRelatedEvents({
      relatedEvents: [
        { name: 'Regular', relationship: 'Partner', priority: 5 },
        { name: 'Promoted', relationship: 'Partner', priority: 50, featured: true },
      ],
    });
    const [group] = groupByRelationship(entries);
    expect(group.entries.map((e) => e.name)).toEqual(['Promoted', 'Regular']);
  });
});

describe('renderRelatedEvents', () => {
  const els = {};
  const fakeEl = () => ({
    _html: '',
    textContent: '',
    classList: { add() {}, remove() {}, toggle() {} },
    set innerHTML(v) {
      this._html = v;
    },
    get innerHTML() {
      return this._html;
    },
  });

  afterEach(() => {
    delete globalThis.document;
  });

  it('renders grouped cards but never emits the description', () => {
    globalThis.document = {
      getElementById: (id) => (els[id] ??= fakeEl()),
    };
    renderRelatedEvents({
      relatedEventsHeading: 'Related events',
      relatedEvents: [
        {
          name: 'DrupalJam',
          relationship: 'Partner',
          scheduleId: 'drupaljam-2026-rotterdam',
          description: 'SECRET-DESCRIPTION-TEXT',
        },
      ],
    });
    const html = els.relatedEventsContent.innerHTML;
    expect(html).toContain('DrupalJam');
    expect(html).toContain('Partner');
    expect(html).toContain('?id=drupaljam-2026-rotterdam');
    expect(html).not.toContain('SECRET-DESCRIPTION-TEXT'); // description hidden on frontend
  });

  it('renders both a schedule and a website action when both are set', () => {
    globalThis.document = { getElementById: (id) => (els[id] ??= fakeEl()) };
    renderRelatedEvents({
      relatedEvents: [
        {
          name: 'DrupalJam',
          relationship: 'Partner',
          scheduleId: 'drupaljam-2026-rotterdam',
          website: 'https://drupaljam.nl/',
        },
      ],
    });
    const html = els.relatedEventsContent.innerHTML;
    expect(html).toContain('View schedule');
    expect(html).toContain('Visit site');
    expect(html).toContain('https://drupaljam.nl/');
  });

  it('marks a featured entry with the full-width promotion class', () => {
    globalThis.document = { getElementById: (id) => (els[id] ??= fakeEl()) };
    renderRelatedEvents({
      relatedEvents: [
        { name: 'Promoted', relationship: 'Partner', website: 'https://x', featured: true },
      ],
    });
    expect(els.relatedEventsContent.innerHTML).toContain('related-card--featured');
  });
});
