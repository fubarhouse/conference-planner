import { describe, expect, it } from 'vitest';

import {
  canImport,
  checkMessage,
  diffSections,
  diffSummary,
  importedMessage,
} from '../feedDiff.js';

const report = {
  status: 'ok',
  upstream: 118,
  local: 113,
  upstreamOnly: [
    { title: 'Coffee Break 1', start: '2026-09-28T08:30:00Z', url: 'https://a.test/c1' },
  ],
  timeDrift: [
    {
      title: '#IAmRemarkable Workshop',
      fromStart: '2026-09-30T05:00:00Z',
      toStart: '2026-09-30T08:45:00Z',
    },
  ],
  titleDrift: [{ title: 'Coffe Break 1', from: 'Coffe Break 1', to: 'Coffee Break 1' }],
  datasetOnly: [{ title: 'Withdrawn talk', fate: 'cancelled' }],
  ambiguous: [{ title: 'Two rows, one session', kept: 'the earlier one' }],
  fillable: [{ title: 'Keynote', field: 'full_description' }],
};

const ok = { status: 'ok', upstream: 118, local: 113, fetch: 'network', report };

describe('diffSections', () => {
  it('drops the sections with nothing in them', () => {
    const keys = diffSections({ status: 'ok', timeDrift: report.timeDrift }).map((s) => s.key);
    expect(keys).toEqual(['timeDrift']);
  });

  it('formats a time as a readable UTC stamp', () => {
    const times = diffSections(report).find((s) => s.key === 'timeDrift');
    expect(times.rows[0]).toMatchObject({
      title: '#IAmRemarkable Workshop',
      from: '2026-09-30 05:00Z',
      to: '2026-09-30 08:45Z',
    });
  });

  it('leaves a value it cannot parse alone rather than mangling it', () => {
    const odd = diffSections({ timeDrift: [{ title: 'x', fromStart: 'unknown', toStart: '' }] });
    expect(odd[0].rows[0].from).toBe('unknown');
  });

  it('puts the start time and the link on one detail line', () => {
    const added = diffSections(report).find((s) => s.key === 'upstreamOnly');
    expect(added.rows[0].detail).toBe('2026-09-28 08:30Z  ·  https://a.test/c1');
  });

  it('says what the publisher claims became of a dropped session', () => {
    const gone = diffSections(report).find((s) => s.key === 'datasetOnly');
    expect(gone.rows[0].detail).toBe('upstream says: cancelled');
  });

  it('returns nothing at all for a missing report', () => {
    expect(diffSections(null)).toEqual([]);
    expect(diffSections(undefined)).toEqual([]);
  });
});

describe('mirror changes what an import would actually do', () => {
  it('acts on added and removed sessions when mirroring', () => {
    const sections = diffSections(report, { mirror: true });
    expect(sections.find((s) => s.key === 'upstreamOnly').applied).toBe(true);
    expect(sections.find((s) => s.key === 'datasetOnly').applied).toBe(true);
  });

  // Telling somebody a session will be added when it will not is the failure
  // this guards against.
  it('holds them back when not mirroring, and says so', () => {
    const sections = diffSections(report, { mirror: false });
    const added = sections.find((s) => s.key === 'upstreamOnly');
    expect(added.applied).toBe(false);
    expect(added.note).toMatch(/will NOT add them/);
    expect(sections.find((s) => s.key === 'datasetOnly').note).toMatch(/Nothing will be removed/);
  });

  it('never acts on the rows that could not be matched', () => {
    for (const mirror of [true, false]) {
      const held = diffSections(report, { mirror }).find((s) => s.key === 'ambiguous');
      expect(held.applied).toBe(false);
    }
  });
});

describe('diffSummary', () => {
  it('separates what will change from what is only being shown', () => {
    const { changing, held, total } = diffSummary(report, { mirror: true });
    // added 1 + times 1 + fillable 1 + titles 1 + removed 1 = 5 changing;
    // ambiguous 1 held.
    expect({ changing, held, total }).toEqual({ changing: 5, held: 1, total: 6 });
  });

  it('moves the session sections into "held" when not mirroring', () => {
    const { changing, held } = diffSummary(report, { mirror: false });
    expect({ changing, held }).toEqual({ changing: 3, held: 3 });
  });

  it('calls an identical archive clean', () => {
    expect(diffSummary({ status: 'ok' }).clean).toBe(true);
  });
});

describe('checkMessage', () => {
  it('says how much would change, and how much would not', () => {
    const message = checkMessage(ok, { mirror: true });
    expect(message.tone).toBe('change');
    expect(message.headline).toBe('5 changes to make, 1 for you to look at');
    expect(message.detail).toContain('118 upstream, 113 here');
  });

  it('says plainly when there is nothing to do', () => {
    const message = checkMessage({ status: 'ok', upstream: 5, local: 5, report: {} });
    expect(message.tone).toBe('ok');
    expect(message.headline).toBe('Already matches the feed');
  });

  // The guards have to reach the person, not just the log.
  it('explains an empty feed as "not published yet", never as deletions', () => {
    const message = checkMessage({ status: 'no-export', note: 'export is empty' });
    expect(message.headline).toBe('Nothing to import');
    expect(message.detail).toMatch(/never means the sessions were cancelled/);
  });

  it('explains a dataset with no feed set', () => {
    expect(checkMessage({ status: 'not-hosted' }).detail).toMatch(/Set an ICS URL/);
  });

  it('reports a failed fetch as a failure that changed nothing', () => {
    const message = checkMessage({ status: 'error', note: '403 Forbidden' });
    expect(message.tone).toBe('bad');
    expect(message.detail).toContain('403 Forbidden');
    expect(message.detail).toMatch(/Nothing was changed/);
  });

  it('admits when the comparison used a stale copy', () => {
    const message = checkMessage({ ...ok, fetch: 'stale' }, { mirror: true });
    expect(message.detail).toMatch(/last good copy/);
  });

  it('does not throw on nothing at all', () => {
    expect(checkMessage(null).tone).toBe('bad');
  });
});

describe('canImport', () => {
  it('allows an import with changes to make', () => {
    expect(canImport(ok, { mirror: true })).toBe(true);
  });

  it('refuses when everything is held back', () => {
    const onlyAmbiguous = { status: 'ok', report: { ambiguous: report.ambiguous } };
    expect(canImport(onlyAmbiguous, { mirror: true })).toBe(false);
  });

  it('refuses on any status that is not ok', () => {
    for (const status of ['no-export', 'not-hosted', 'error']) {
      expect(canImport({ status, report })).toBe(false);
    }
  });

  // Writing "no changes" rewrites a file for no reason and makes the archive's
  // own history harder to read.
  it('refuses when nothing differs', () => {
    expect(canImport({ status: 'ok', report: {} })).toBe(false);
  });
});

describe('importedMessage — the receipt, in the past tense', () => {
  const done = (over) => ({ changed: 0, added: 0, removed: 0, report: {}, ...over });

  it('names the biggest thing that happened rather than a total', () => {
    // "5 sessions added" is what somebody remembers; "13 changes" is not
    // something they can go and check.
    expect(importedMessage(done({ added: 5, changed: 8 })).headline).toBe('5 sessions added');
  });

  it('says both when sessions came and went', () => {
    expect(importedMessage(done({ added: 5, removed: 2 })).headline).toBe('5 added, 2 removed');
  });

  it('falls back to fields when no session moved', () => {
    expect(importedMessage(done({ changed: 1 })).headline).toBe('1 field updated');
    expect(importedMessage(done({ changed: 9 })).headline).toBe('9 fields updated');
  });

  it('says something sensible when nothing is countable', () => {
    expect(importedMessage(done()).headline).toBe('Imported from the feed');
  });

  it('gets the singular right', () => {
    expect(importedMessage(done({ added: 1 })).headline).toBe('1 session added');
    expect(importedMessage(done({ removed: 1 })).headline).toBe('1 session removed');
  });

  it('tones a removal differently from an addition', () => {
    const counts = importedMessage(done({ added: 2, removed: 3 })).counts;
    expect(counts.find((c) => c.label === 'sessions added').tone).toBe('good');
    expect(counts.find((c) => c.label === 'sessions removed').tone).toBe('bad');
  });

  it('leaves a zero untoned rather than colouring nothing', () => {
    for (const count of importedMessage(done()).counts) expect(count.tone).toBe('');
  });

  // The last moment anybody is looking at what the import could not do.
  it('carries the rows that were held back', () => {
    const result = done({
      added: 2,
      report: { ambiguous: [{ title: 'a' }, { title: 'b' }] },
    });
    const message = importedMessage(result);
    expect(message.held).toBe(2);
    expect(message.detail).toMatch(/2 rows could not be matched/);
    expect(message.detail).toMatch(/they still need a person/);
  });

  it('uses the singular for one held row', () => {
    const message = importedMessage(done({ report: { ambiguous: [{ title: 'a' }] } }));
    expect(message.detail).toMatch(
      /1 row could not be matched and was left alone — it still needs a person/,
    );
  });

  it('says the dataset matches when nothing was held', () => {
    expect(importedMessage(done({ added: 3 })).detail).toBe('The dataset now matches the feed.');
  });

  it('does not throw on a response with nothing in it', () => {
    expect(() => importedMessage(null)).not.toThrow();
    expect(importedMessage(null).headline).toBe('Imported from the feed');
  });
});
