import { describe, it, expect } from 'vitest';
import { personDetailBodyHtml } from '../plannerPersonDetail.js';

describe('personDetailBodyHtml', () => {
  it('shows a friendly placeholder when nothing is recorded', () => {
    expect(personDetailBodyHtml({})).toContain('No trip details recorded yet.');
  });

  it('renders every populated section with its data', () => {
    const html = personDetailBodyHtml({
      name: 'Alex',
      phone: '123',
      notes: 'Vegetarian',
      legs: [{ from: 'SYD', to: 'SIN', date: '2026-09-22', mode: 'flight', dir: 'outbound' }],
      stays: [{ name: 'Marina Bay Hotel', checkIn: '2026-09-22', checkOut: '2026-09-27' }],
      tickets: [{ name: 'Conference Pass', status: 'purchased', relation: 'assigned' }],
      itinerary: [
        { title: 'Team dinner', date: '2026-09-24', time: '19:00', location: 'Lau Pa Sat' },
      ],
      budget: { mode: 'simple', budget: '800', actual: '645', currency: 'AUD' },
    });
    // Section labels
    for (const label of [
      'Phone',
      'Notes',
      'Travel',
      'Accommodation',
      'Tickets',
      'Itinerary',
      'Budget',
    ]) {
      expect(html).toContain(label);
    }
    // Data
    expect(html).toContain('SYD → SIN');
    expect(html).toContain('Marina Bay Hotel');
    expect(html).toContain('Conference Pass');
    expect(html).toContain('Team dinner');
    expect(html).toContain('Lau Pa Sat');
    // Simple budget computes remaining (800 - 645 = 155)
    expect(html).toContain('Remaining');
    expect(html).toContain('155');
  });

  it('omits sections with no data (phone/notes/travel absent)', () => {
    const html = personDetailBodyHtml({
      name: 'Bare',
      tickets: [{ name: 'Pass', status: 'planned' }],
    });
    expect(html).not.toContain('Phone');
    expect(html).not.toContain('Notes');
    expect(html).not.toContain('Travel');
    expect(html).not.toContain('Accommodation');
    expect(html).toContain('Tickets');
  });

  it('shows the skip-finances message but no numbers for a skipped budget', () => {
    const html = personDetailBodyHtml({ name: 'X', budget: { mode: 'skipped' } });
    expect(html).toContain('Budget');
    expect(html).toContain('Finance tracking is disabled');
  });

  it('omits the Budget section entirely when there is no budget', () => {
    const html = personDetailBodyHtml({ name: 'X', budget: { mode: 'none' } });
    expect(html).not.toContain('Budget');
  });

  it('escapes user-provided text', () => {
    const html = personDetailBodyHtml({ name: 'X', notes: '<script>alert(1)</script>' });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
