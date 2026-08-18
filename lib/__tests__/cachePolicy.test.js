import { describe, it, expect } from 'vitest';
import { cacheControlFor, POLICIES } from '../cachePolicy.js';

const { LONG, DATA, COMPUTED, VERSIONED, REVALIDATE, PRIVATE } = POLICIES;

describe('cacheControlFor', () => {
  it('never stores anything it does not recognise', () => {
    // The property that matters: a new route is private until someone says
    // otherwise in the policy file.
    expect(cacheControlFor('/api/something-new')).toBe(PRIVATE);
    expect(cacheControlFor('/a/path/nobody/added')).toBe(PRIVATE);
    expect(cacheControlFor('')).toBe(PRIVATE);
    expect(cacheControlFor(undefined)).toBe(PRIVATE);
  });

  it('caches code briefly and refuses to serve it stale', () => {
    // Bounded, not eliminated: assets cannot be fingerprinted, so the window
    // after a deploy where a visitor holds mixed modules is capped at 60s.
    expect(REVALIDATE).toContain('max-age=60');
    expect(REVALIDATE).toContain('must-revalidate');
    expect(REVALIDATE).not.toContain('stale-while-revalidate');
  });

  it('applies that policy to code and HTML', () => {
    expect(cacheControlFor('/js/app.js')).toBe(REVALIDATE);
    expect(cacheControlFor('/js/modules/render.js')).toBe(REVALIDATE);
    expect(cacheControlFor('/css/foundation.css')).toBe(REVALIDATE);
  });

  it('caches fonts and images for a day, then serves stale while revalidating', () => {
    expect(cacheControlFor('/fonts/publicsans.woff2')).toBe(LONG);
    expect(cacheControlFor('/img/related/x.webp')).toBe(LONG);
    expect(cacheControlFor('/favicon.svg')).toBe(LONG);
  });

  it('keeps the public data fresh within a minute', () => {
    expect(cacheControlFor('/data/catalog.json')).toBe(DATA);
    expect(cacheControlFor('/data/events/drupalcon/eu/2026-rotterdam.json')).toBe(DATA);
    expect(cacheControlFor('/api/meta')).toBe(DATA);
  });

  it('treats the public event feed as data and the PLANNER feed as private', () => {
    // These two look alike and only one carries a secret.
    expect(cacheControlFor('/schedules/drupalcon-2026-rotterdam/calendar.ics')).toBe(DATA);
    expect(cacheControlFor('/schedule.ics')).toBe(DATA);
    expect(cacheControlFor('/planner/my-trip/calendar.ics')).toBe(PRIVATE);
  });

  it('marks the archive aggregates cacheable-when-public, but revalidated', () => {
    // Shared caches may store these; they may not serve them without asking.
    // A curation merge changes the answer at the SAME url, and no `cache:
    // 'reload'` in a browser can make a CDN forget what it is holding.
    expect(cacheControlFor('/api/archive/insights')).toBe(COMPUTED);
    expect(cacheControlFor('/api/archive/sessions')).toBe(COMPUTED);
    expect(cacheControlFor('/api/archive/topic')).toBe(COMPUTED);
    expect(COMPUTED).toContain('no-cache');
    expect(COMPUTED).not.toContain('max-age=300');
  });

  it('caches the aggregates hard once the url names the content', () => {
    // `?v=<token>` is an address, not a cache-buster: a decision moves the
    // archive to a new url instead of asking anyone to forget the old one.
    expect(cacheControlFor('/api/archive/insights', { versioned: true })).toBe(VERSIONED);
    expect(VERSIONED).toContain('immutable');
  });

  it('does not let a stray token buy caching for anything else', () => {
    // Only the paths that publish a token may be upgraded by one.
    expect(cacheControlFor('/api/planner/trip.json', { versioned: true })).toBe(PRIVATE);
    expect(cacheControlFor('/api/auth/status', { versioned: true })).toBe(PRIVATE);
    expect(cacheControlFor('/js/app.js', { versioned: true })).toBe(REVALIDATE);
    expect(cacheControlFor('/data/catalog.json', { versioned: true })).toBe(DATA);
  });

  it('never caches personal surfaces, whatever they look like', () => {
    for (const p of [
      '/planner',
      '/planner/trip',
      '/planner/trip/itinerary',
      '/receipts/trip/file.pdf',
      '/documents/trip/file.pdf',
      '/api/planner',
      '/api/planner/trip.json',
      '/api/receipts/trip/file.pdf',
      '/api/users',
      '/api/v1/planners',
      '/api/s3/config',
    ]) {
      expect(cacheControlFor(p), p).toBe(PRIVATE);
    }
  });

  it('never caches the things that describe the caller or the moment', () => {
    expect(cacheControlFor('/api/auth/status')).toBe(PRIVATE);
    expect(cacheControlFor('/api/health')).toBe(PRIVATE);
    expect(cacheControlFor('/login')).toBe(PRIVATE);
  });

  it('caches the public pages but only with revalidation', () => {
    expect(cacheControlFor('/')).toBe(REVALIDATE);
    expect(cacheControlFor('/schedules')).toBe(REVALIDATE);
    expect(cacheControlFor('/schedules/drupalcon-2026-rotterdam')).toBe(REVALIDATE);
  });

  it('puts the never-cache list ahead of everything else', () => {
    // /planner/<slug>/calendar.ics could otherwise read as a public feed.
    expect(cacheControlFor('/planner/x/calendar.ics')).toBe(PRIVATE);
  });
});
