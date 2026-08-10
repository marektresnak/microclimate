import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import type { SensorId } from '../src/config.ts';
import type { MeasurementKind, Reading } from '../src/domain/measurement.ts';
import { RANGE_QUERY_SQL, SCHEMA, openReadingStore } from '../src/store/readings.ts';

const NOW = Date.UTC(2026, 7, 10, 12, 0, 0);
const MINUTE = 60_000;

function reading(
  sourceId: SensorId,
  kind: MeasurementKind,
  value: number,
  measuredAt: number,
  receivedAt = measuredAt,
): Reading {
  return { sourceId, kind, value, measuredAt, receivedAt };
}

describe('the readings store', () => {
  it('stores a batch and reads it back', () => {
    const store = openReadingStore(':memory:');

    const inserted = store.insert([
      reading('bedroom_netatmo', 'co2', 812, NOW - 2 * MINUTE),
      reading('bedroom_netatmo', 'co2', 845, NOW - MINUTE),
      reading('bedroom_netatmo', 'temperature', 18.9, NOW - MINUTE),
    ]);

    assert.equal(inserted, 3);
    assert.deepEqual(store.readingsInRange('bedroom_netatmo', 'co2', 0, NOW), [
      reading('bedroom_netatmo', 'co2', 812, NOW - 2 * MINUTE),
      reading('bedroom_netatmo', 'co2', 845, NOW - MINUTE),
    ]);

    store.close();
  });

  it('absorbs a replayed batch without storing it twice', () => {
    // Push nodes retry, and a retried batch must be a no-op. Duplicates in a
    // metrics store do not announce themselves; they surface months later as
    // spikes in a graph.
    const store = openReadingStore(':memory:');
    const batch = [
      reading('bedroom_netatmo', 'co2', 812, NOW - 2 * MINUTE),
      reading('bedroom_netatmo', 'co2', 845, NOW - MINUTE),
    ];

    assert.equal(store.insert(batch), 2);
    assert.equal(store.insert(batch), 0);
    assert.equal(store.readingsInRange('bedroom_netatmo', 'co2', 0, NOW).length, 2);

    store.close();
  });

  it('stores only the new readings of a partial replay', () => {
    const store = openReadingStore(':memory:');
    store.insert([reading('bedroom_netatmo', 'co2', 812, NOW - 2 * MINUTE)]);

    const inserted = store.insert([
      reading('bedroom_netatmo', 'co2', 812, NOW - 2 * MINUTE),
      reading('bedroom_netatmo', 'co2', 845, NOW - MINUTE),
    ]);

    assert.equal(inserted, 1);
    store.close();
  });

  it('keeps the original received_at when a reading is retried', () => {
    // That is when the reading genuinely first arrived, and the retry is not
    // news. Overwriting it would quietly rewrite the arrival history.
    const store = openReadingStore(':memory:');
    const measuredAt = NOW - 10 * MINUTE;

    store.insert([reading('bedroom_netatmo', 'co2', 812, measuredAt, NOW - 9 * MINUTE)]);
    store.insert([reading('bedroom_netatmo', 'co2', 812, measuredAt, NOW)]);

    const stored = store.readingsInRange('bedroom_netatmo', 'co2', 0, NOW)[0];
    assert.equal(stored?.receivedAt, NOW - 9 * MINUTE);

    store.close();
  });

  it('picks the latest reading by when it was measured, not when it arrived', () => {
    // A push node replaying a backlog delivers old readings now. Ordering by
    // arrival would make an hour-old reading the current one.
    const store = openReadingStore(':memory:');

    store.insert([
      reading('bedroom_netatmo', 'co2', 845, NOW - MINUTE, NOW - MINUTE),
      reading('bedroom_netatmo', 'co2', 400, NOW - 60 * MINUTE, NOW),
    ]);

    assert.equal(store.latestReading('bedroom_netatmo', 'co2')?.value, 845);
    store.close();
  });

  it('keeps kinds and sources apart', () => {
    const store = openReadingStore(':memory:');

    store.insert([
      reading('bedroom_netatmo', 'co2', 812, NOW),
      reading('bedroom_netatmo', 'temperature', 18.9, NOW),
      reading('bedroom_tado', 'temperature', 19.2, NOW),
    ]);

    assert.equal(store.latestReading('bedroom_netatmo', 'temperature')?.value, 18.9);
    assert.equal(store.latestReading('bedroom_tado', 'temperature')?.value, 19.2);
    store.close();
  });

  it('reports nothing for a source that has never spoken', () => {
    const store = openReadingStore(':memory:');

    assert.equal(store.latestReading('living_room_tado', 'temperature'), undefined);
    assert.deepEqual(store.readingsInRange('living_room_tado', 'temperature', 0, NOW), []);
    store.close();
  });
});

describe('the schema', () => {
  it('renders measured_at as readable ISO without storing it', () => {
    // The generated column costs zero storage — it is computed on read — and it
    // is what makes SELECT * legible without a join or a converter.
    const database = new DatabaseSync(':memory:');
    database.exec(SCHEMA);
    database
      .prepare('INSERT INTO readings (source_id, kind, value, measured_at, received_at) VALUES (?,?,?,?,?)')
      .run('bedroom_netatmo', 'co2', 812, Date.UTC(2026, 7, 10, 13, 45, 30, 250), NOW);

    const row = database.prepare('SELECT measured_at_iso FROM readings').get();
    const iso = row !== null && typeof row === 'object' && 'measured_at_iso' in row ? row.measured_at_iso : undefined;

    assert.equal(iso, '2026-08-10T13:45:30.250Z');
    database.close();
  });

  it('lets the dedup constraint double as the query index', () => {
    // If someone later reorders the UNIQUE constraint or adds a column, the room
    // history query quietly becomes a full scan. This is what says so.
    const database = new DatabaseSync(':memory:');
    database.exec(SCHEMA);

    const plan = database
      .prepare(`EXPLAIN QUERY PLAN ${RANGE_QUERY_SQL}`)
      .all('bedroom_netatmo', 'co2', 0, NOW)
      .map((row) => (row !== null && typeof row === 'object' && 'detail' in row ? row.detail : ''))
      .join('\n');

    assert.match(plan, /SEARCH readings USING INDEX sqlite_autoindex_readings_1/);
    assert.doesNotMatch(plan, /SCAN readings/);
    database.close();
  });
});
