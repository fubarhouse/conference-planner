import { describe, it, expect, vi } from 'vitest';

// plannerStorage functions touch localStorage lazily; stub it so importing the
// factory is safe in the node test environment.
vi.stubGlobal('localStorage', {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  length: 0,
  key: () => null,
});

const { validatePlanner } = await import('../validatePlanner.js');
const { makeEmptyPlanner } = await import('../../app/js/modules/plannerStorage.js');

describe('validatePlanner', () => {
  it('accepts a fresh empty planner (the real factory shape)', () => {
    const { valid, errors } = validatePlanner(
      makeEmptyPlanner('drupalcon-us-2025', 'drupalcon/us/2025.json'),
    );
    expect(errors).toEqual([]);
    expect(valid).toBe(true);
  });

  it('accepts a populated planner with realistic id-bearing elements', () => {
    const p = makeEmptyPlanner('k', 'e.json');
    p.mode = 'sponsor';
    p.tasks.push({ id: 't_1', text: 'Book flights', done: false });
    p.contacts.push({ id: 'c_1', name: 'Jane' });
    p.receipts.push({ id: 'rc_1', amount: '50', currency: 'AUD' });
    p.sessionNotes['sess-1'] = { text: 'note', pinned: true };
    p.personal.outboundLegs.push({ id: 'leg_1', mode: 'flight', from: 'SYD', to: 'SIN' });
    p.personal.returnLegs.push({ id: 'leg_2', mode: 'flight' });
    p.personal.accommodations.push({ id: 'ia_1', name: 'Hotel', checkIn: '2025-03-10' });
    p.personal.itinerary.push({ id: 'it_1', title: 'Dinner', date: '2025-03-11' });
    p.personal.tickets.push({ id: 'tk_1', name: 'Pass', unitPrice: '200' });
    p.personal.budgetItems.push({ id: 'bi_1', name: 'Travel', budget: '500' });
    p.personal.localCompanions.push({ id: 'lc_1', name: 'Sam' });
    p.personal.tripAssignments.push({ id: 'ta_1', memberId: 'pc_1' });
    p.personal.disabledTabs.push('map');
    p.personal.gpxTrack = { name: 'My route', points: [[-33.87, 151.21]] }; // parsed track, not a string
    p.personal.meContactId = 'pc_1';
    p.org.teamAssignments.push({ memberId: 'tm_1', outboundLegs: [], returnLegs: [] }); // natural key, no id
    p.org.swag.push({ id: 'sw_1', name: 'Stickers' });
    p.org.autoAddedSponsoredSessions.push('sess-1', 'sess-2'); // plain id strings
    p.org.memberItinerary.push({ id: 'it_9', title: 'Booth setup' });
    const { valid, errors } = validatePlanner(p);
    expect(errors).toEqual([]);
    expect(valid).toBe(true);
  });

  it('rejects a non-object body', () => {
    expect(validatePlanner('nope').valid).toBe(false);
    expect(validatePlanner(42).valid).toBe(false);
  });

  it('rejects a collection with the wrong container type', () => {
    const { valid, errors } = validatePlanner({ personal: { accommodations: {} } });
    expect(valid).toBe(false);
    expect(errors[0]).toMatchObject({ path: '.personal.accommodations', keyword: 'type' });
  });

  it('rejects a non-string id on a collection element', () => {
    const { valid, errors } = validatePlanner({ tasks: [{ id: 5 }] });
    expect(valid).toBe(false);
    expect(errors.some((e) => e.path === '.tasks[0].id')).toBe(true);
  });

  it('rejects an invalid mode', () => {
    expect(validatePlanner({ mode: 'bogus' }).valid).toBe(false);
  });

  it('accepts an uploaded GPX track (object) and a null track', () => {
    // Regression: gpxTrack is stored as a parsed { name, points } object, not a
    // string — an uploaded track must not fail validation.
    expect(
      validatePlanner({ personal: { gpxTrack: { name: 'Ride', points: [[1, 2]] } } }).valid,
    ).toBe(true);
    expect(validatePlanner({ personal: { gpxTrack: null } }).valid).toBe(true);
  });
});
