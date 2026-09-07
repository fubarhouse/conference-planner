// A barcamp offers sessions it never places. The archive records those with
// `unscheduled: true` and NO startTime/endTime, rather than handing them the
// session block's bounds — which would assert a placement the organisers
// deliberately left to the room, and (for DrupalCamp Ruhr 2023) would also be
// contradicted by the recaps, which put ~30 talks on the day against 23 listed.
//
// Two properties matter and are tested here:
//   1. an unscheduled session never becomes a calendar entry — no DTSTART exists
//   2. the schema accepts the absence, and rejects a half-stated time
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { scheduleSessionsToCalEvents } from '../plannerCalendar.js';

const placed = {
  id: 'keynote',
  title: 'Drupal CMS now and beyond',
  startTime: '2025-09-12T09:00:00Z',
  endTime: '2025-09-12T09:50:00Z',
  location: 'Room 423',
};
const offered = {
  id: 'entity-api',
  title: 'Entity API beyond the basics',
  unscheduled: true,
  duration: 'P45M',
};

describe('calendar export', () => {
  it('drops an unscheduled session rather than inventing a time for it', () => {
    const out = scheduleSessionsToCalEvents([placed, offered], { timezone: 'Europe/Berlin' });
    expect(out).toHaveLength(1);
    expect(out[0].title ?? out[0].summary).toBe('Drupal CMS now and beyond');
  });

  it('still exports the timed spine when the pool is large', () => {
    const pool = Array.from({ length: 13 }, (_, i) => ({ ...offered, id: `s${i}` }));
    const out = scheduleSessionsToCalEvents([placed, ...pool], { timezone: 'Europe/Berlin' });
    expect(out).toHaveLength(1);
  });

  it('exports nothing at all when every session is unscheduled', () => {
    // Not an error state. A pure barcamp has no per-session calendar, and the
    // caller must not end up with one entry at the epoch.
    const out = scheduleSessionsToCalEvents([offered], { timezone: 'Europe/Berlin' });
    expect(out).toHaveLength(0);
  });
});

describe('the schema', () => {
  const schema = JSON.parse(readFileSync('app/schemas/event.schema.json', 'utf8'));
  const item = schema.properties.items.items;

  it('no longer demands a time from every item', () => {
    expect(item.required).not.toContain('startTime');
    expect(item.required).not.toContain('endTime');
  });

  it('keeps demanding one via a conditional, so a plain item cannot drop it', () => {
    // The requirement moved rather than disappeared. Without this, a typo that
    // omits startTime on an ordinary session would now validate silently.
    const rule = item.allOf.find((r) => r.then?.required);
    expect(rule.then.required).toEqual(expect.arrayContaining(['startTime', 'endTime']));
  });

  it('only lets `unscheduled` be true — never a stored false', () => {
    // `unscheduled: false` would be a third state meaning the same as absent,
    // and the renderer would have two things to check instead of one.
    expect(item.properties.unscheduled.const).toBe(true);
  });

  it('forbids an unscheduled item from also carrying a time', () => {
    // Half-stating it is worse than not stating it: a reader could not tell
    // whether the time was real or a leftover.
    const rule = item.allOf.find((r) => r.else);
    expect(rule.else.not.anyOf).toEqual([{ required: ['startTime'] }, { required: ['endTime'] }]);
  });
});

describe('selection', () => {
  it('keeps a session with no time out of the bulk select target', async () => {
    // The checkbox is not rendered for these, so the only way one could enter a
    // selection is a bulk action reaching past the UI. Both "Select all" and
    // "Deselect all" go through this list.
    globalThis.document ??= { getElementById: () => null, querySelector: () => null };
    const { getBulkTargetEvents } = await import('../filters.js');
    const events = [
      { id: 'a', title: 'Keynote', startTime: '2025-09-12T09:00:00Z' },
      { id: 'b', title: 'Offered only', unscheduled: true },
      { id: 'c', title: 'Closing', startTime: '2025-09-13T16:15:00Z' },
    ];
    expect(getBulkTargetEvents(events).map((e) => e.id)).toEqual(['a', 'c']);
  });

  it('survives a non-array', async () => {
    globalThis.document ??= { getElementById: () => null, querySelector: () => null };
    const { getBulkTargetEvents } = await import('../filters.js');
    expect(getBulkTargetEvents(null)).toEqual([]);
  });
});
