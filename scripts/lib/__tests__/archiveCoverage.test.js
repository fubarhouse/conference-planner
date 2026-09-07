// The coverage worklist's one piece of judgement: is this gap still asking to be
// looked at?
//
// Some gaps never close — a 2007 conference has no session recordings and never
// will — and a worklist that keeps reporting the impossible is one you stop
// reading. So a check can be ignored for ever or snoozed until a date.
import { describe, it, expect } from 'vitest';
import { isOpen, snoozeKey } from '../archiveCoverage.js';

describe('isOpen', () => {
  it('is open when nothing has been decided', () => {
    expect(isOpen(null)).toBe(true);
    expect(isOpen(undefined)).toBe(true);
    expect(isOpen({})).toBe(true);
  });

  it('stays closed once ignored, whatever the date', () => {
    expect(isOpen({ state: 'ignored' }, '2030-01-01')).toBe(false);
  });

  it('reopens the day the snooze runs out', () => {
    const snooze = { state: 'later', until: '2026-09-01' };
    expect(isOpen(snooze, '2026-08-31')).toBe(false);
    expect(isOpen(snooze, '2026-09-01')).toBe(true); // due today counts as due
    expect(isOpen(snooze, '2026-09-02')).toBe(true);
  });

  it('treats a snooze with no date as due now rather than as forever', () => {
    // "Later" with nothing to come back to is an ignore in disguise; ignoring
    // should have to be said out loud.
    expect(isOpen({ state: 'later' }, '2026-08-17')).toBe(true);
  });

  it('ignores a state it does not recognise instead of hiding the row', () => {
    expect(isOpen({ state: 'maybe' }, '2026-08-17')).toBe(true);
  });
});

describe('snoozeKey', () => {
  it('is per event AND per check', () => {
    // Recordings can be hopeless for an event whose descriptions are not.
    expect(snoozeKey('events/a.json', 'videos')).toBe('events/a.json::videos');
    expect(snoozeKey('events/a.json', 'videos')).not.toBe(
      snoozeKey('events/a.json', 'descriptions'),
    );
    expect(snoozeKey('events/a.json', 'videos')).not.toBe(snoozeKey('events/b.json', 'videos'));
  });
});
