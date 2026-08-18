// Session lengths, bucketed where the programme actually clusters.
//
// The archive holds 51 distinct durations that pile up at six shapes. The
// boundaries sit BETWEEN the clusters, so a 50-minute slot counts with the 45s
// rather than reading as an hour of content that never happened.
import { describe, it, expect } from 'vitest';
import { lengthBucket, LENGTH_BUCKETS } from '../archiveInsights.js';

describe('lengthBucket', () => {
  it('puts the archive’s six common lengths where a programmer would', () => {
    expect(lengthBucket(15)).toBe('lightning');
    expect(lengthBucket(20)).toBe('lightning');
    expect(lengthBucket(30)).toBe('half');
    expect(lengthBucket(45)).toBe('short');
    expect(lengthBucket(50)).toBe('short'); // with the 45s, not the hours
    expect(lengthBucket(60)).toBe('hour');
    expect(lengthBucket(90)).toBe('workshop');
    expect(lengthBucket(540)).toBe('day');
  });

  it('treats a missing or nonsense duration as unbucketed, not as zero-length', () => {
    for (const v of [0, -5, null, undefined, NaN, 'abc']) expect(lengthBucket(v)).toBe('');
  });

  it('has boundaries that leave no gaps and no overlaps', () => {
    let prev = 0;
    for (const b of LENGTH_BUCKETS) {
      expect(b.max).toBeGreaterThan(prev);
      if (Number.isFinite(b.max)) {
        expect(lengthBucket(b.max)).toBe(b.key);
        expect(lengthBucket(b.max + 1)).not.toBe(b.key);
      }
      prev = b.max;
    }
    expect(LENGTH_BUCKETS[LENGTH_BUCKETS.length - 1].max).toBe(Infinity);
  });

  it('assigns every minute from 1 to 600 to exactly one bucket', () => {
    for (let m = 1; m <= 600; m++) {
      const key = lengthBucket(m);
      expect(LENGTH_BUCKETS.filter((b) => b.key === key)).toHaveLength(1);
    }
  });
});
