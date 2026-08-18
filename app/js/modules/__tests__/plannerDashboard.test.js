import { describe, it, expect } from 'vitest';
import { plannerFingerprint } from '../plannerDashboard.js';

describe('plannerFingerprint', () => {
  it('ignores the save-only _lastModified stamp', () => {
    const a = { mode: 'personal', personal: { budgetItems: [] }, _lastModified: 1 };
    const b = { mode: 'personal', personal: { budgetItems: [] }, _lastModified: 999999 };
    expect(plannerFingerprint(a)).toBe(plannerFingerprint(b));
  });

  it('is insensitive to key order', () => {
    const a = { mode: 'personal', isConference: true, personal: { a: 1, b: 2 } };
    const b = { personal: { b: 2, a: 1 }, isConference: true, mode: 'personal' };
    expect(plannerFingerprint(a)).toBe(plannerFingerprint(b));
  });

  it('changes when real content changes', () => {
    const a = { mode: 'personal', personal: { budgetItems: [] } };
    const b = { mode: 'personal', personal: { budgetItems: [{ id: 'x' }] } };
    expect(plannerFingerprint(a)).not.toBe(plannerFingerprint(b));
  });

  it('handles null/undefined without throwing', () => {
    expect(() => plannerFingerprint(null)).not.toThrow();
    expect(plannerFingerprint(null)).toBe(plannerFingerprint(undefined));
  });
});
