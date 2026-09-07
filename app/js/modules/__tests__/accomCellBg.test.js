import { describe, it, expect } from 'vitest';
import { accomCellBg } from '../plannerTravel.js';

const A = { bg: '#bfdbfe', border: '#60a5fa' }; // arrival / stay
const B = { bg: '#a7f3d0', border: '#34d399' }; // place being left

describe('accomCellBg', () => {
  it('returns empty string when there is no colour (no stay that day)', () => {
    expect(accomCellBg({})).toBe('');
    expect(accomCellBg()).toBe('');
  });

  it('a stay night is a solid fill with the accommodation border', () => {
    const s = accomCellBg({ color: A, kind: 'stay' });
    expect(s).toContain(`background:${A.bg}`);
    expect(s).not.toContain('gradient');
    expect(s).toContain(`border-bottom:2px solid ${A.border}`);
  });

  it('a checkout day fades the colour out to transparent (a gradient)', () => {
    const s = accomCellBg({ color: A, kind: 'checkout' });
    expect(s).toContain('linear-gradient');
    expect(s).toContain(A.bg);
    expect(s).toContain('transparent');
  });

  it('a move day blends from the place left (B) to the place arrived (A)', () => {
    const s = accomCellBg({ color: A, splitColor: B, kind: 'split' });
    expect(s).toContain('linear-gradient');
    // B (left) appears before A (right) in the gradient
    expect(s.indexOf(B.bg)).toBeLessThan(s.indexOf(A.bg));
    expect(s).not.toContain('50%'); // soft blend, not the old hard 50/50 edge
  });

  it('defaults to a solid stay when kind is omitted', () => {
    expect(accomCellBg({ color: A })).toContain(`background:${A.bg}`);
  });
});
