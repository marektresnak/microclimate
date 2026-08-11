import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ingestBatch } from '../src/ingest/http.ts';
import { openReadingStore } from '../src/store/readings.ts';
import type { ReadingStore } from '../src/store/readings.ts';

const NOW = Date.UTC(2026, 7, 11, 12, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function co2(value: number, measuredAt: number): Record<string, unknown> {
  return { sourceId: 'bedroom_netatmo', kind: 'co2', value, measuredAt };
}

// Nine readings, the size of one SEN66 cycle — here three kinds over three
// timestamps, since no SEN66 is in config yet.
function nineReadings(): Record<string, unknown>[] {
  const batch: Record<string, unknown>[] = [];

  for (const minute of [3, 2, 1]) {
    const measuredAt = NOW - minute * MINUTE;
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
  now: number = NOW,
  log: (line: string) => void = () => undefined,
): ReturnType<typeof ingestBatch> {
  return ingestBatch(body, store, now, log);
}

describe('ingest', () => {
  it('accepts a batch of nine readings and stores all nine', () => {
    const store = openReadingStore(':memory:');

    const outcome = ingest(store, nineReadings());

    assert.deepEqual(outcome, { stored: 9, duplicates: 0, rejected: [] });
    assert.equal(store.readingsInRange('bedroom_netatmo', 'co2', 0, NOW).length, 3);

    store.close();
  });

  it('stores nothing when the identical batch is replayed', () => {
    const store = openReadingStore(':memory:');

    ingest(store, nineReadings());
    const replay = ingest(store, nineReadings());

    assert.deepEqual(replay, { stored: 0, duplicates: 9, rejected: [] });
    assert.equal(store.readingsInRange('bedroom_netatmo', 'co2', 0, NOW).length, 3);

    store.close();
  });

  it('stores only the new readings from a partial replay', () => {
    const store = openReadingStore(':memory:');
    ingest(store, nineReadings());

    const someOldSomeNew = [...nineReadings().slice(0, 4), co2(850, NOW), co2(860, NOW - 30_000)];
    const outcome = ingest(store, someOldSomeNew);

    assert.deepEqual(outcome, { stored: 2, duplicates: 4, rejected: [] });

    store.close();
  });

  it('keeps the original receivedAt when a reading is retried later', () => {
    const store = openReadingStore(':memory:');

    ingest(store, [co2(840, NOW - MINUTE)], NOW);
    ingest(store, [co2(840, NOW - MINUTE)], NOW + HOUR);

    const rows = store.readingsInRange('bedroom_netatmo', 'co2', 0, NOW + HOUR);
    assert.equal(rows.length, 1);
    // When the reading genuinely first arrived — not when the retry did.
    assert.equal(rows[0]?.receivedAt, NOW);

    store.close();
  });

  it('rejects the future beyond clock skew, pinned at the boundary', () => {
    const store = openReadingStore(':memory:');

    const atTheEdge = ingest(store, [co2(840, NOW + 5 * MINUTE)]);
    assert.deepEqual(atTheEdge, { stored: 1, duplicates: 0, rejected: [] });

    const beyondIt = ingest(store, [co2(840, NOW + 5 * MINUTE + 1)]);
    assert.equal('rejected' in beyondIt && beyondIt.rejected[0]?.index, 0);
    assert.match(String('rejected' in beyondIt && beyondIt.rejected[0]?.reason), /in the future/);

    store.close();
  });

  it('accepts the past at any distance, stamping receivedAt as now (F6)', () => {
    const store = openReadingStore(':memory:');
    const twelveHoursAgo = NOW - 12 * HOUR;
    const yearsAgo = NOW - 3 * 365 * 24 * HOUR;

    const outcome = ingest(store, [co2(840, twelveHoursAgo), co2(700, yearsAgo)], NOW);

    assert.deepEqual(outcome, { stored: 2, duplicates: 0, rejected: [] });
    const backlog = store.readingsInRange('bedroom_netatmo', 'co2', yearsAgo, NOW);
    // Original measurement time, today's arrival time — never conflated.
    assert.equal(backlog[0]?.measuredAt, yearsAgo);
    assert.equal(backlog[0]?.receivedAt, NOW);

    store.close();
  });

  it('lands the rest of the batch around one bad reading (Q6)', () => {
    const store = openReadingStore(':memory:');
    const batch = [...nineReadings(), { sourceId: 'bedroom_netatmo', kind: 'co2', value: 'high', measuredAt: NOW }];

    const outcome = ingest(store, batch);

    assert.deepEqual(outcome, {
      stored: 9,
      duplicates: 0,
      rejected: [{ index: 9, reason: 'value must be a finite number' }],
    });

    store.close();
  });

  it('rejects what config has never heard of, naming the reason', () => {
    const store = openReadingStore(':memory:');

    const outcome = ingest(store, [
      { sourceId: 'attic_sen66', kind: 'co2', value: 840, measuredAt: NOW },
      { sourceId: 'bedroom_netatmo', kind: 'noise', value: 38, measuredAt: NOW },
      // A real kind this instrument does not report — most likely a wrong
      // sourceId in node firmware, and filed forever under the wrong name.
      { sourceId: 'bedroom_netatmo', kind: 'pm2_5', value: 4, measuredAt: NOW },
    ]);

    assert.deepEqual(outcome, {
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
      { sourceId: 'bedroom_netatmo', kind: 'co2', measuredAt: NOW },
      co2(840, NOW + 0.5),
      { sourceId: 'bedroom_netatmo', kind: 'co2', value: 840, measuredAt: 'today' },
      42,
    ]);

    // The STRICT table would have thrown on several of these — but its error
    // names a column and fails the whole transaction; these name a reading.
    assert.deepEqual(outcome, {
      stored: 0,
      duplicates: 0,
      rejected: [
        { index: 0, reason: 'value must be a finite number' },
        { index: 1, reason: 'value must be a finite number' },
        { index: 2, reason: 'value must be a finite number' },
        { index: 3, reason: 'measuredAt must be integer epoch milliseconds' },
        { index: 4, reason: 'measuredAt must be integer epoch milliseconds' },
        { index: 5, reason: 'not an object' },
      ],
    });

    store.close();
  });

  it('is an error, not a batch, when the body is not an array', () => {
    const store = openReadingStore(':memory:');

    assert.deepEqual(ingest(store, { readings: [] }), { error: 'expected a JSON array of readings' });
    assert.deepEqual(ingest(store, 'co2'), { error: 'expected a JSON array of readings' });

    store.close();
  });

  it('accepts an empty batch as a no-op', () => {
    const store = openReadingStore(':memory:');

    assert.deepEqual(ingest(store, []), { stored: 0, duplicates: 0, rejected: [] });

    store.close();
  });

  it('stores CO2 below outdoor air, and flags it as probable calibration drift', () => {
    const store = openReadingStore(':memory:');
    const log = recorder();

    const outcome = ingest(store, [co2(250, NOW)], NOW, log.log);

    // Stored, not rejected: a drifted instrument is still reporting real air
    // with a shifted zero, and the low reading is the evidence of the fault.
    assert.deepEqual(outcome, { stored: 1, duplicates: 0, rejected: [] });
    assert.match(log.lines.join('\n'), /250 ppm CO2, below outdoor air/);

    store.close();
  });
});
