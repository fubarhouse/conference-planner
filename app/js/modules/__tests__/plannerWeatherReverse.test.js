import { describe, it, expect, vi } from 'vitest';
import { reverseGeocode } from '../weather.js';

const okJson = (body) => ({ ok: true, json: async () => body });

describe('reverseGeocode', () => {
  it('returns the city from BigDataCloud', async () => {
    const fetchFn = vi.fn(async () => okJson({ city: 'Rotterdam', locality: 'Centrum' }));
    expect(await reverseGeocode(51.9225, 4.4792, fetchFn)).toBe('Rotterdam');
    expect(fetchFn.mock.calls[0][0]).toContain('latitude=51.9225');
  });

  it('falls back to locality, then subdivision, then country', async () => {
    expect(await reverseGeocode(1, 2, async () => okJson({ locality: 'Oldenzaal' }))).toBe(
      'Oldenzaal',
    );
    expect(await reverseGeocode(1, 2, async () => okJson({ principalSubdivision: 'Zurich' }))).toBe(
      'Zurich',
    );
    expect(await reverseGeocode(1, 2, async () => okJson({ countryName: 'Qatar' }))).toBe('Qatar');
  });

  it('is best-effort — null on bad coords, non-ok, or throw', async () => {
    expect(await reverseGeocode(NaN, 2, async () => okJson({ city: 'X' }))).toBe(null);
    expect(await reverseGeocode(1, 2, async () => ({ ok: false }))).toBe(null);
    expect(
      await reverseGeocode(1, 2, async () => {
        throw new Error('offline');
      }),
    ).toBe(null);
  });
});
