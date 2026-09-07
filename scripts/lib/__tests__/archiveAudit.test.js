import { describe, it, expect } from 'vitest';
import {
  normName,
  fingerprint,
  parseDecisions,
  serializeDecisions,
  applyDecision,
  dropDecision,
  saveDecision,
  removeDecision,
  loadDecisions,
  decisionImpact,
  buildCurationData,
} from '../archiveAudit.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';

/** An in-memory decisions store — the seam the server fills with S3. */
function memStore(initial = null) {
  let text = initial;
  return {
    read: async () => text,
    write: async (t) => {
      text = t;
    },
    get text() {
      return text;
    },
  };
}

describe('normName', () => {
  it('lowercases, strips accents + company suffixes + punctuation', () => {
    expect(normName('Gábor Hojtsy')).toBe('gabor hojtsy');
    expect(normName('Acquia, Inc.')).toBe('acquia');
    expect(normName('1xINTERNET')).toBe('1xinternet');
  });
});

describe('fingerprint', () => {
  it('sorts words so reversed name order collides', () => {
    expect(fingerprint('Gábor Hojtsy')).toBe(fingerprint('Hojtsy Gábor'));
    expect(fingerprint('Panagiotis Kaddas')).toBe(fingerprint('Kaddas Panagiotis'));
  });

  it('still separates genuinely different names', () => {
    expect(fingerprint('Dries Buytaert')).not.toBe(fingerprint('Gábor Hojtsy'));
    // a middle initial makes it distinct (conservative — no false merge)
    expect(fingerprint('John A Smith')).not.toBe(fingerprint('John Smith'));
  });

  it('is stable/idempotent and ignores case, accents, punctuation', () => {
    expect(fingerprint('hojtsy,  GÁBOR')).toBe('gabor hojtsy');
    expect(fingerprint(fingerprint('Hojtsy Gábor'))).toBe(fingerprint('Hojtsy Gábor'));
  });
});

describe('the decisions ledger', () => {
  it('treats a missing or broken file as an empty ledger, never a throw', () => {
    // The ledger is read on every archive request; a bad parse must degrade to
    // "no decisions recorded" rather than take the page down.
    const empty = { aliases: {}, distinct: [], snoozes: {}, series: {} };
    expect(parseDecisions(null)).toEqual(empty);
    expect(parseDecisions('{ not json')).toEqual(empty);
    expect(parseDecisions('{"aliases":null,"distinct":"nope","snoozes":7,"series":[]}')).toEqual(
      empty,
    );
  });

  it('serialises to a stable shape, whatever went in', () => {
    // The version token hashes this string, so two servers holding the same
    // decisions must produce the same bytes.
    expect(serializeDecisions(parseDecisions(null))).toBe(
      serializeDecisions(parseDecisions('{"aliases":{},"distinct":[]}')),
    );
  });

  it('records an alias and takes it back', () => {
    const one = applyDecision(
      { aliases: {}, distinct: [] },
      {
        type: 'alias',
        key: 'kim pepper',
        canonical: 'Kim Pepper',
      },
    );
    expect(one.aliases['kim pepper']).toBe('Kim Pepper');
    expect(dropDecision(one, { type: 'alias', key: 'kim pepper' }).aliases).toEqual({});
  });

  it('overwrites an alias in place, which is what remapping needs', () => {
    const one = applyDecision({}, { type: 'alias', key: 'k', canonical: 'First' });
    const two = applyDecision(one, { type: 'alias', key: 'k', canonical: 'Second' });
    expect(two.aliases).toEqual({ k: 'Second' });
  });

  it('does not mutate the ledger it was given', () => {
    const before = { aliases: { a: 'A' }, distinct: ['d'] };
    applyDecision(before, { type: 'distinct', key: 'x' });
    dropDecision(before, { type: 'alias', key: 'a' });
    expect(before).toEqual({ aliases: { a: 'A' }, distinct: ['d'] });
  });

  it('keeps `distinct` a set, not a tally', () => {
    let d = applyDecision({}, { type: 'distinct', key: 'dup' });
    d = applyDecision(d, { type: 'distinct', key: 'dup' });
    expect(d.distinct).toEqual(['dup']);
    expect(dropDecision(d, { type: 'distinct', key: 'dup' }).distinct).toEqual([]);
  });

  it('reads and writes through an injected store, never the disk', async () => {
    // This is the seam that makes decisions survive a deploy: the server passes
    // an S3-first store, the CLI passes none and gets local disk.
    const store = memStore();
    await saveDecision({ type: 'alias', key: 'k', canonical: 'Canon' }, store);
    expect(JSON.parse(store.text).aliases).toEqual({ k: 'Canon' });

    const loaded = await loadDecisions(store);
    expect(loaded.aliases).toEqual({ k: 'Canon' });
    expect(loaded.distinct).toBeInstanceOf(Set);

    await removeDecision({ type: 'alias', key: 'k' }, store);
    expect(JSON.parse(store.text).aliases).toEqual({});
  });

  it('threads the injected store all the way into buildCurationData', async () => {
    // Regression: loadDecisions used to take (dataDir, store). When dataDir was
    // dropped, this call site still passed it — so the DIRECTORY STRING arrived
    // where the store belonged and the curation desk 500'd with "read is not a
    // function". Nothing caught it: extra arguments are legal JS, so lint and the
    // whole suite stayed green. The desk is the only caller that proves the chain.
    const dataDir = await mkdtemp(join(tmpdir(), 'archive-'));
    await mkdir(join(dataDir, 'events'), { recursive: true });
    await writeFile(join(dataDir, 'catalog.json'), JSON.stringify({ events: [] }), 'utf8');

    const store = memStore(JSON.stringify({ aliases: { fubar: 'Real Name' } }));
    const data = await buildCurationData(dataDir, tmpdir(), store);
    expect(data.decisions.aliases).toEqual({ fubar: 'Real Name' });

    await rm(dataDir, { recursive: true, force: true });
  });

  it('undoing nothing writes nothing', async () => {
    const store = memStore();
    expect(await removeDecision({ type: 'alias', key: 'k' }, store)).toEqual({
      aliases: {},
      distinct: [],
    });
    expect(store.text).toBe(null);
  });
});

describe('decisionImpact', () => {
  // The shape scanArchive produces: bucket → fingerprint → variants by spelling.
  const bucket = (rows) =>
    new Map(
      rows.map(([key, variants]) => [
        key,
        {
          key,
          variants: new Map(
            variants.map((v) => [
              v.name,
              {
                ...v,
                events: new Map(v.events.map((f) => [f, {}])),
                roles: new Set(v.roles || []),
              },
            ]),
          ),
        },
      ]),
    );

  const speakers = bucket([
    [
      'kim pepper',
      [
        { name: 'Kim Pepper', count: 12, events: ['a.json', 'b.json'] },
        { name: 'kim.pepper', count: 3, events: ['b.json'] },
      ],
    ],
  ]);
  const sponsors = bucket([['acquia', [{ name: 'Acquia', count: 4, events: ['a.json'] }]]]);
  const people = bucket([
    ['kim pepper', [{ name: 'kim.pepper', count: 1, events: ['c.json'], roles: ['volunteer'] }]],
  ]);

  it('adds up every spelling behind one decision', () => {
    const { 'kim pepper': imp } = decisionImpact({ speakers, sponsors, people }, ['kim pepper']);
    expect(imp.talks).toBe(15);
    expect(imp.variants).toEqual(['Kim Pepper', 'kim.pepper']); // deduped across buckets
  });

  it('counts events once, however many spellings appear in them', () => {
    const { 'kim pepper': imp } = decisionImpact({ speakers, sponsors, people }, ['kim pepper']);
    expect(imp.events).toBe(3); // a, b (twice) and c
  });

  it('says when a mapping crosses a speaker and a community credit', () => {
    // The whole reason for the line: undoing this un-merges a speaker from a
    // volunteer, which you cannot tell from `kim pepper → Kim Pepper`.
    const { 'kim pepper': imp } = decisionImpact({ speakers, sponsors, people }, ['kim pepper']);
    expect(imp.credits).toBe(1);
    expect(imp.roles).toEqual(['volunteer']);
  });

  it('reports an empty record for a key nothing in the archive carries', () => {
    const { gone: imp } = decisionImpact({ speakers, sponsors, people }, ['gone']);
    expect(imp).toEqual({
      variants: [],
      talks: 0,
      sponsorships: 0,
      credits: 0,
      events: 0,
      roles: [],
    });
  });
});
