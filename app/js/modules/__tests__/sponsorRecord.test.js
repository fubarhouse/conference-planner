// The sponsor record — what could be recovered, said out loud.
//
// The point of this field is the DIFFERENCE between two absences. An event that
// had no sponsors and an event whose sponsor page did not survive render
// identically without it: an empty space. Only one of those is a claim the
// archive has actually made, so the wording has to distinguish them.
//
// Node env, no jsdom, so this tests the pure lead-text function rather than the
// DOM node it goes into.
import { describe, it, expect } from 'vitest';
import { sponsorRecordLead } from '../sponsors.js';

describe('sponsorRecordLead', () => {
  it('says nothing was recoverable — not that there were none', () => {
    const s = sponsorRecordLead({ state: 'none' }, 0);
    expect(s).toBe('No sponsors could be recovered for this event.');
    // The distinction the whole field exists for: never assert the event had none.
    expect(s).not.toMatch(/had no sponsors|were no sponsors/i);
  });

  it('names the count on a partial list, so it cannot read as the whole story', () => {
    expect(sponsorRecordLead({ state: 'partial' }, 1)).toBe(
      'Only one sponsor could be recovered — the full list did not survive.',
    );
    expect(sponsorRecordLead({ state: 'partial' }, 3)).toBe(
      'Only 3 sponsors could be recovered — the full list did not survive.',
    );
  });

  it('distinguishes lost LOGOS from lost sponsors', () => {
    const s = sponsorRecordLead({ state: 'logos-lost' }, 17);
    expect(s).toContain('their logos did not survive');
    expect(s).not.toMatch(/could be recovered/);
  });

  it('falls back rather than throwing on an unknown or missing state', () => {
    for (const r of [{ state: 'something-new' }, {}, null, undefined]) {
      expect(sponsorRecordLead(r, 0)).toBe('The sponsor record for this event is incomplete.');
    }
  });

  it('defaults the count to zero rather than printing undefined', () => {
    expect(sponsorRecordLead({ state: 'partial' })).toContain('0 sponsors');
  });
});
