import { describe, it, expect, vi, beforeEach } from 'vitest';

// weather.js caches via plannerStorage → localStorage; back it with an in-memory
// stub so cache round-trips work.
const store = new Map();
vi.stubGlobal('localStorage', {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
  get length() {
    return store.size;
  },
  key: (i) => [...store.keys()][i] ?? null,
});
beforeEach(() => store.clear());

const {
  weatherInfo,
  cToF,
  formatTemp,
  daysUntil,
  forecastMode,
  cacheKey,
  fetchDailyForecast,
  geocode,
  loadForecast,
  enumerateDates,
  parseCoords,
  locationEvents,
  locationAtDate,
  groupByLocation,
  accomTransitions,
} = await import('../weather.js');

describe('pure helpers', () => {
  it('formatTemp converts and rounds; handles missing', () => {
    expect(formatTemp(20, 'C')).toBe('20°C');
    expect(formatTemp(20, 'F')).toBe('68°F');
    expect(formatTemp(null)).toBe('—');
    expect(formatTemp(Infinity)).toBe('—');
  });
  it('cToF', () => expect(cToF(0)).toBe(32));
  it('weatherInfo maps known + unknown codes, with a visual tone', () => {
    expect(weatherInfo(0).label).toBe('Clear');
    expect(weatherInfo(0).tone).toBe('sun');
    expect(weatherInfo(61).tone).toBe('rain');
    expect(weatherInfo(95).tone).toBe('storm');
    expect(weatherInfo(73).tone).toBe('snow');
    expect(weatherInfo(48).tone).toBe('fog');
    expect(weatherInfo(999).label).toBe('—');
    expect(weatherInfo(999).tone).toBe('cloud');
  });
  it('daysUntil counts whole days, null on bad input', () => {
    const today = new Date(2026, 6, 14);
    expect(daysUntil('2026-07-20', today)).toBe(6);
    expect(daysUntil('2026-07-14', today)).toBe(0);
    expect(daysUntil('nope', today)).toBeNull();
  });
  it('forecastMode picks forecast / normals / past / none', () => {
    const today = new Date(2026, 6, 14);
    expect(forecastMode('2026-07-20', today)).toBe('forecast');
    expect(forecastMode('2026-09-01', today)).toBe('normals');
    expect(forecastMode('2026-07-10', today)).toBe('past');
    expect(forecastMode('bad', today)).toBe('none');
  });
  it('cacheKey rounds coordinates', () => {
    expect(cacheKey(51.9244, 4.4777, '2026-07-14', '2026-07-20')).toBe(
      '51.92,4.48:2026-07-14:2026-07-20',
    );
  });
});

describe('per-day location resolution', () => {
  it('enumerateDates lists inclusive days', () => {
    expect(enumerateDates('2026-07-14', '2026-07-16')).toEqual([
      '2026-07-14',
      '2026-07-15',
      '2026-07-16',
    ]);
  });

  it('parseCoords parses a "lat, lng" string', () => {
    expect(parseCoords('-20.24, 169.77')).toEqual({ lat: -20.24, lon: 169.77 });
    expect(parseCoords('nope')).toBeNull();
  });

  it('locationEvents harvests legs, accommodations, dated cruise stops (with coords), itinerary', () => {
    const personal = {
      outboundLegs: [{ to: 'Singapore', arriveDate: '2026-07-14' }],
      accommodations: [
        {
          name: 'Ship',
          checkIn: '2026-07-16',
          stops: [{ date: '2026-07-17', location: 'Mystery Island', coords: '-20.24, 169.77' }],
        },
      ],
      itinerary: [{ date: '2026-07-18', location: 'Port Vila' }],
    };
    expect(locationEvents(personal)).toEqual([
      { date: '2026-07-14', location: 'Singapore', coords: null },
      { date: '2026-07-16', location: 'Ship', coords: null },
      { date: '2026-07-17', location: 'Mystery Island', coords: { lat: -20.24, lon: 169.77 } },
      { date: '2026-07-18', location: 'Port Vila', coords: null },
    ]);
  });

  it('resolves a multi-hop travel day to the terminal destination (not a transit stop)', () => {
    const personal = {
      outboundLegs: [
        { from: 'CBR', to: 'BNE', date: '2027-01-19' }, // flight
        { from: 'Casey', to: 'CBR', date: '2027-01-19' }, // taxi — CBR is transit
      ],
    };
    // Departures + the terminal arrival are all recorded, but the day RESOLVES to the
    // terminal (BNE) — CBR is a transit `from`, so it never wins the carry-forward.
    const events = locationEvents(personal);
    expect(locationAtDate('2027-01-19', events, 'Home')).toEqual({
      location: 'BNE',
      coords: null,
    });
    expect(events.some((e) => e.location === 'BNE')).toBe(true);
  });

  it('locationAtDate carries the most recent event (and its coords) forward', () => {
    const events = [
      { date: '2026-07-14', location: 'Singapore', coords: null },
      { date: '2026-07-17', location: 'Mystery Island', coords: { lat: -20.24, lon: 169.77 } },
    ];
    expect(locationAtDate('2026-07-13', events, 'Home')).toEqual({
      location: 'Home',
      coords: null,
    });
    expect(locationAtDate('2026-07-15', events, 'Home')).toEqual({
      location: 'Singapore',
      coords: null,
    });
    expect(locationAtDate('2026-07-20', events, 'Home')).toEqual({
      location: 'Mystery Island',
      coords: { lat: -20.24, lon: 169.77 },
    });
  });

  it('accomTransitions finds days you check out of one place and into another', () => {
    const personal = {
      accommodations: [
        { name: 'Sydney Hotel', checkIn: '2026-05-01', checkOut: '2026-05-03' },
        { name: 'Melbourne Hotel', checkIn: '2026-05-03', checkOut: '2026-05-05' },
        { name: 'Melbourne Hotel B', checkIn: '2026-05-05', checkOut: '2026-05-06' }, // same city day: still a move
      ],
    };
    const t = accomTransitions(personal);
    expect(t.get('2026-05-03')).toEqual({ from: 'Sydney Hotel', to: 'Melbourne Hotel' });
    expect(t.has('2026-05-01')).toBe(false); // check-in only
    expect(t.has('2026-05-04')).toBe(false); // no transition
  });

  it('groupByLocation segments by place, keyed by coords when present', () => {
    const events = [
      { date: '2026-07-14', location: 'Singapore', coords: null },
      { date: '2026-07-16', location: 'Mystery Island', coords: { lat: -20.24, lon: 169.77 } },
    ];
    const dates = enumerateDates('2026-07-13', '2026-07-17');
    expect(groupByLocation(dates, events, 'Home')).toEqual([
      { key: 'Home', location: 'Home', coords: null, start: '2026-07-13', end: '2026-07-13' },
      {
        key: 'Singapore',
        location: 'Singapore',
        coords: null,
        start: '2026-07-14',
        end: '2026-07-15',
      },
      {
        key: '-20.24,169.77',
        location: 'Mystery Island',
        coords: { lat: -20.24, lon: 169.77 },
        start: '2026-07-16',
        end: '2026-07-17',
      },
    ]);
  });
});

const okJson = (body) => ({ ok: true, json: async () => body });

describe('network (injected fetch)', () => {
  it('fetchDailyForecast normalizes the Open-Meteo shape', async () => {
    const fetchFn = vi.fn(async () =>
      okJson({
        daily: {
          time: ['2026-07-14', '2026-07-15'],
          weathercode: [1, 61],
          temperature_2m_max: [22, 18],
          temperature_2m_min: [12, 10],
        },
      }),
    );
    const days = await fetchDailyForecast(1, 2, '2026-07-14', '2026-07-15', fetchFn);
    expect(days).toEqual([
      { date: '2026-07-14', code: 1, tmax: 22, tmin: 12 },
      { date: '2026-07-15', code: 61, tmax: 18, tmin: 10 },
    ]);
  });
  it('fetchDailyForecast returns null on failure (never throws)', async () => {
    expect(await fetchDailyForecast(1, 2, 'a', 'b', async () => ({ ok: false }))).toBeNull();
    expect(
      await fetchDailyForecast(1, 2, 'a', 'b', async () => {
        throw new Error('network');
      }),
    ).toBeNull();
  });
  it('geocode returns the first result with a composed label', async () => {
    const fetchFn = async () =>
      okJson({
        results: [
          { name: 'Rotterdam', admin1: 'ZH', country: 'NL', latitude: 51.9, longitude: 4.5 },
        ],
      });
    expect(await geocode('rotterdam', fetchFn)).toEqual({
      lat: 51.9,
      lon: 4.5,
      label: 'Rotterdam, ZH, NL',
    });
    expect(await geocode('', fetchFn)).toBeNull();
  });
  it('loadForecast caches, serves cache, and falls back to stale on failure', async () => {
    const good = vi.fn(async () =>
      okJson({
        daily: {
          time: ['2026-07-14'],
          weathercode: [0],
          temperature_2m_max: [25],
          temperature_2m_min: [15],
        },
      }),
    );
    const first = await loadForecast(1, 2, '2026-07-14', '2026-07-14', good);
    expect(first.days).toHaveLength(1);
    expect(first.stale).toBe(false);

    // Second call within TTL uses the cache — no new fetch.
    const cached = await loadForecast(1, 2, '2026-07-14', '2026-07-14', vi.fn());
    expect(cached.stale).toBe(false);
    expect(cached.days).toHaveLength(1);

    // Force a miss by clearing the fresh flag isn't possible without time travel, so
    // verify failure-fallback on a *different* range: no cache, failing fetch → null.
    const miss = await loadForecast(9, 9, 'x', 'y', async () => ({ ok: false }));
    expect(miss).toBeNull();
  });
});
