import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { toIsoUtc } from '../src/domain/time.ts';
import { ingestBatch } from '../src/ingest/http.ts';
import { openReadingStore } from '../src/store/readings.ts';
import type { ReadingStore } from '../src/store/readings.ts';
import { assertDeepEqual } from './support/deep-equal.ts';

const NOW = Temporal.Instant.from('2026-08-11T12:00:00Z');
const BEGINNING = Temporal.Instant.fromEpochMilliseconds(0);
const ISO_REQUIRED = 'measuredAt must be an ISO 8601 timestamp with a zone, e.g. 2026-08-12T09:36:00Z';

// Tests keep the arithmetic (`NOW.subtract(...)`) and the helpers write the
// wire format, so a case reads as the instant it is about rather than a string.
function co2(value: number, measuredAt: Temporal.Instant): Record<string, unknown> {
  return { sourceId: 'bedroom_netatmo', kind: 'co2', value, measuredAt: toIsoUtc(measuredAt) };
}

// Nine readings, the size of one SEN66 cycle — here three kinds over three
// timestamps, since no SEN66 is in config yet.
function nineReadings(): Record<string, unknown>[] {
  const batch: Record<string, unknown>[] = [];

  for (const minute of [3, 2, 1]) {
    const measuredAt = toIsoUtc(NOW.subtract({ minutes: minute }));
    batch.push({ sourceId: 'bedroom_netatmo', kind: 'co2', value: 840, measuredAt });
    batch.push({ sourceId: 'bedroom_netatmo', kind: 'temperature', value: 21.5, measuredAt });
    batch.push({ sourceId: 'bedroom_netatmo', kind: 'humidity', value: 47, measuredAt });
  }

  return batch;
}

interface Recorder {
  readonly lines: string[];
  log(line: string): void;
}

function recorder(): Recorder {
  const lines: string[] = [];
  return { lines, log: (line) => void lines.push(line) };
}

function ingest(
  store: ReadingStore,
  body: unknown,
  now: Temporal.Instant = NOW,
  log: (line: string) => void = () => undefined,
): ReturnType<typeof ingestBatch> {
  return ingestBatch(body, store, now, log);
}

describe('ingest', () => {
  it('accepts a batch of nine readings and stores all nine', () => {
    const store = openReadingStore(':memory:');

    const outcome = ingest(store, nineReadings());

    assertDeepEqual(outcome, { stored: 9, duplicates: 0, rejected: [] });
    assert.equal(store.readingsInRange('bedroom_netatmo', 'co2', BEGINNING, NOW).length, 3);

    store.close();
  });

  it('stores nothing when the identical batch is replayed', () => {
    const store = openReadingStore(':memory:');

    ingest(store, nineReadings());
    const replay = ingest(store, nineReadings());

    assertDeepEqual(replay, { stored: 0, duplicates: 9, rejected: [] });
    assert.equal(store.readingsInRange('bedroom_netatmo', 'co2', BEGINNING, NOW).length, 3);

    store.close();
  });

  it('stores only the new readings from a partial replay', () => {
    const store = openReadingStore(':memory:');
    ingest(store, nineReadings());

    const someOldSomeNew = [
      ...nineReadings().slice(0, 4),
      co2(850, NOW),
      co2(860, NOW.subtract({ seconds: 30 })),
    ];
    const outcome = ingest(store, someOldSomeNew);

    assertDeepEqual(outcome, { stored: 2, duplicates: 4, rejected: [] });

    store.close();
  });

  it('keeps the original receivedAt when a reading is retried later', () => {
    const store = openReadingStore(':memory:');
    const anHourOn = NOW.add({ hours: 1 });

    ingest(store, [co2(840, NOW.subtract({ minutes: 1 }))], NOW);
    ingest(store, [co2(840, NOW.subtract({ minutes: 1 }))], anHourOn);

    const rows = store.readingsInRange('bedroom_netatmo', 'co2', BEGINNING, anHourOn);
    assert.equal(rows.length, 1);
    // When the reading genuinely first arrived — not when the retry did.
    assertDeepEqual(rows[0]?.receivedAt, NOW);

    store.close();
  });

  it('rejects the future beyond clock skew, pinned at the boundary', () => {
    const store = openReadingStore(':memory:');

    const atTheEdge = ingest(store, [co2(840, NOW.add({ minutes: 5 }))]);
    assertDeepEqual(atTheEdge, { stored: 1, duplicates: 0, rejected: [] });

    const beyondIt = ingest(store, [co2(840, NOW.add({ minutes: 5, milliseconds: 1 }))]);
    assert.equal('rejected' in beyondIt && beyondIt.rejected[0]?.index, 0);
    assert.match(String('rejected' in beyondIt && beyondIt.rejected[0]?.reason), /ahead of this server/);

    store.close();
  });

  it('accepts the past at any distance, stamping receivedAt as now (F6)', () => {
    const store = openReadingStore(':memory:');
    const twelveHoursAgo = NOW.subtract({ hours: 12 });
    const yearsAgo = NOW.subtract({ hours: 3 * 365 * 24 });

    const outcome = ingest(store, [co2(840, twelveHoursAgo), co2(700, yearsAgo)], NOW);

    assertDeepEqual(outcome, { stored: 2, duplicates: 0, rejected: [] });
    const backlog = store.readingsInRange('bedroom_netatmo', 'co2', yearsAgo, NOW);
    // Original measurement time, today's arrival time — never conflated.
    assertDeepEqual(backlog[0]?.measuredAt, yearsAgo);
    assertDeepEqual(backlog[0]?.receivedAt, NOW);

    store.close();
  });

  it('treats an offset timestamp as the instant it names, not a new reading', () => {
    const store = openReadingStore(':memory:');

    const asUtc = ingest(store, [
      { sourceId: 'bedroom_netatmo', kind: 'co2', value: 840, measuredAt: '2026-08-11T10:00:00Z' },
    ]);
    const asPrague = ingest(store, [
      { sourceId: 'bedroom_netatmo', kind: 'co2', value: 840, measuredAt: '2026-08-11T12:00:00+02:00' },
    ]);

    // One moment, two spellings. The offset is resolved at the edge, so the
    // store only ever sees the number and the uniqueness constraint catches the
    // second as the duplicate it is — which is why accepting both costs nothing.
    assertDeepEqual(asUtc, { stored: 1, duplicates: 0, rejected: [] });
    assertDeepEqual(asPrague, { stored: 0, duplicates: 1, rejected: [] });

    const rows = store.readingsInRange('bedroom_netatmo', 'co2', BEGINNING, NOW);
    assert.equal(rows.length, 1);
    assertDeepEqual(rows[0]?.measuredAt, '2026-08-11T10:00:00Z');

    store.close();
  });

  it('stores every zone spelling of one instant as the same UTC epoch', () => {
    const store = openReadingStore(':memory:');

    const outcome = ingest(
      store,
      [
        '2026-08-06T07:30:00Z',
        '2026-08-06T07:30:00+00:00',
        '2026-08-06T07:30:00-00:00',
        '2026-08-06T09:30:00+02:00', // Prague in summer
        '2026-08-06T08:30:00+01:00', // Prague in winter
        '2026-08-06T02:30:00-05:00',
        '2026-08-06T13:00:00+05:30', // half an hour, which an hours-only parse would lose
        '2026-08-06T20:30:00+13:00',
        '2026-08-05T19:30:00-12:00', // a day earlier on its own calendar
      ].map((measuredAt) => ({ sourceId: 'bedroom_netatmo', kind: 'co2', value: 640, measuredAt })),
    );

    // Nine spellings of one moment, in one batch. The zone is resolved at the
    // edge, so what reaches the column is a single number and the uniqueness
    // constraint sees a single reading — which is why accepting offsets at all
    // costs nothing.
    assertDeepEqual(outcome, { stored: 1, duplicates: 8, rejected: [] });

    const rows = store.readingsInRange('bedroom_netatmo', 'co2', BEGINNING, NOW);
    assert.equal(rows.length, 1);
    assertDeepEqual(rows[0]?.measuredAt, '2026-08-06T07:30:00Z');

    store.close();
  });

  it('stores instants that differ as different readings, however alike they read', () => {
    const store = openReadingStore(':memory:');

    // The same wall clock at opposite ends of the offset range: 25 hours apart,
    // on two different days. Treating the zone as decoration would file these
    // as one reading and lose one of them permanently.
    const outcome = ingest(store, [
      { sourceId: 'bedroom_netatmo', kind: 'co2', value: 640, measuredAt: '2026-08-06T12:00:00+13:00' },
      { sourceId: 'bedroom_netatmo', kind: 'co2', value: 705, measuredAt: '2026-08-06T12:00:00-12:00' },
    ]);

    assertDeepEqual(outcome, { stored: 2, duplicates: 0, rejected: [] });

    const rows = store.readingsInRange('bedroom_netatmo', 'co2', BEGINNING, NOW);
    assertDeepEqual(
      rows.map((row) => row.measuredAt),
      ['2026-08-05T23:00:00Z', '2026-08-07T00:00:00Z'],
    );

    store.close();
  });

  it('lands the rest of the batch around one bad reading (Q6)', () => {
    const store = openReadingStore(':memory:');
    const batch = [...nineReadings(), { sourceId: 'bedroom_netatmo', kind: 'co2', value: 'high', measuredAt: toIsoUtc(NOW) }];

    const outcome = ingest(store, batch);

    assertDeepEqual(outcome, {
      stored: 9,
      duplicates: 0,
      rejected: [{ index: 9, reason: 'value must be a finite number' }],
    });

    store.close();
  });

  it('rejects what config has never heard of, naming the reason', () => {
    const store = openReadingStore(':memory:');

    const outcome = ingest(store, [
      { sourceId: 'attic_sen66', kind: 'co2', value: 840, measuredAt: toIsoUtc(NOW) },
      { sourceId: 'bedroom_netatmo', kind: 'noise', value: 38, measuredAt: toIsoUtc(NOW) },
      // A real kind this instrument does not report — most likely a wrong
      // sourceId in node firmware, and filed forever under the wrong name.
      { sourceId: 'bedroom_netatmo', kind: 'pm2_5', value: 4, measuredAt: toIsoUtc(NOW) },
    ]);

    assertDeepEqual(outcome, {
      stored: 0,
      duplicates: 0,
      rejected: [
        { index: 0, reason: 'unknown source attic_sen66' },
        { index: 1, reason: 'noise is not a measurement kind' },
        { index: 2, reason: 'bedroom_netatmo does not report pm2_5' },
      ],
    });

    store.close();
  });

  it('rejects junk values before SQLite can see them', () => {
    const store = openReadingStore(':memory:');

    const outcome = ingest(store, [
      co2(Number.NaN, NOW),
      co2(Number.POSITIVE_INFINITY, NOW),
      { sourceId: 'bedroom_netatmo', kind: 'co2', measuredAt: toIsoUtc(NOW) },
      { sourceId: 'bedroom_netatmo', kind: 'co2', value: 840 },
      { sourceId: 'bedroom_netatmo', kind: 'co2', value: 840, measuredAt: 'today' },
      // The shape this endpoint used to take. Guessing at it would let a node
      // left on the old firmware look healthy while storing nothing.
      { sourceId: 'bedroom_netatmo', kind: 'co2', value: 840, measuredAt: NOW.epochMilliseconds },
      // No zone, so `Date.parse` would read it as whatever the server's local
      // time happens to be — a different instant per machine and per season.
      { sourceId: 'bedroom_netatmo', kind: 'co2', value: 840, measuredAt: '2026-08-11T12:00:00' },
      42,
    ]);

    // The STRICT table would have thrown on several of these — but its error
    // names a column and fails the whole transaction; these name a reading.
    assertDeepEqual(outcome, {
      stored: 0,
      duplicates: 0,
      rejected: [
        { index: 0, reason: 'value must be a finite number' },
        { index: 1, reason: 'value must be a finite number' },
        { index: 2, reason: 'value must be a finite number' },
        { index: 3, reason: 'measuredAt is missing' },
        { index: 4, reason: ISO_REQUIRED },
        { index: 5, reason: ISO_REQUIRED },
        { index: 6, reason: ISO_REQUIRED },
        { index: 7, reason: 'not an object' },
      ],
    });

    store.close();
  });

  it('is an error, not a batch, when the body is not an array', () => {
    const store = openReadingStore(':memory:');

    assertDeepEqual(ingest(store, { readings: [] }), { error: 'expected a JSON array of readings' });
    assertDeepEqual(ingest(store, 'co2'), { error: 'expected a JSON array of readings' });

    store.close();
  });

  it('accepts an empty batch as a no-op', () => {
    const store = openReadingStore(':memory:');

    assertDeepEqual(ingest(store, []), { stored: 0, duplicates: 0, rejected: [] });

    store.close();
  });

  it('stores CO2 below outdoor air, and flags it as probable calibration drift', () => {
    const store = openReadingStore(':memory:');
    const log = recorder();

    const outcome = ingest(store, [co2(250, NOW)], NOW, log.log);

    // Stored, not rejected: a drifted instrument is still reporting real air
    // with a shifted zero, and the low reading is the evidence of the fault.
    assertDeepEqual(outcome, { stored: 1, duplicates: 0, rejected: [] });
    assert.match(log.lines.join('\n'), /250 ppm CO2, below outdoor air/);

    store.close();
  });
});
