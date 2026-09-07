import { describe, it, expect } from 'vitest';
import { normalizeSponsors } from '../sponsors.js';

const meta = (extra = {}) => ({
  sponsors: [{ id: 'acme', title: 'Acme', tier: 'Gold', image: './img/acme.png', enabled: true }],
  ...extra,
});

describe('normalizeSponsors — sponsorLogosDisabled break-glass', () => {
  it('keeps sponsor logos by default', () => {
    expect(normalizeSponsors(meta())[0].image).toBe('./img/acme.png');
  });

  it('blanks logos when sponsorLogosDisabled is true (falls back to the name tile)', () => {
    const [s] = normalizeSponsors(meta({ sponsorLogosDisabled: true }));
    expect(s.image).toBe('');
    expect(s.title).toBe('Acme'); // name preserved for the fallback render
  });

  it('accepts the string "true" (JSON-authored datasets)', () => {
    expect(normalizeSponsors(meta({ sponsorLogosDisabled: 'true' }))[0].image).toBe('');
  });
});
