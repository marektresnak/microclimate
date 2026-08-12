import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import type { SensorId } from '../src/config.ts';
import type { MeasurementKind, Reading } from '../src/domain/measurement.ts';
import { RANGE_QUERY_SQL, SCHEMA, openReadingStore } from '../src/store/readings.ts';
import { assertDeepEqual } from './support/deep-equal.ts';

const NOW = Temporal.Instant.from('2026-08-10T12:00:00Z');
const BEGINNING = Temporal.Instant.fromEpochMilliseconds(0);

function reading(
  sourceId: SensorId,
  kind: MeasurementKind,
  value: number,
  measuredAt: Temporal.Instant,
  receivedAt = measuredAt,
): Reading {
  return { sourceId, kind, value, measuredAt, receivedAt };
}

describe('the readings store', () => {
  it('stores a batch and reads it back', () => {
    const store = openReadingStore(':memory:');

    const inserted = store.insert([
      reading('bedroom_netatmo', 'co2', 812, NOW.subtract({ minutes: 2 })),
      reading('bedroom_netatmo', 'co2', 845, NOW.subtract({ minutes: 1 })),
      reading('bedroom_netatmo', 'temperature', 18.9, NOW.subtract({ minutes: 1 })),
    ]);

    assert.equal(inserted, 3);
    assertDeepEqual(store.readingsInRange('bedroom_netatmo', 'co2', BEGINNING, NOW), [
      reading('bedroom_netatmo', 'co2', 812, NOW.subtract({ minutes: 2 })),
      reading('bedroom_netatmo', 'co2', 845, NOW.subtract({ minutes: 1 })),
    ]);

    store.close();
  });

  it('absorbs a replayed batch without storing it twice', () => {
    // Push nodes retry, and a retried batch must be a no-op. Duplicates in a
    // metrics store do not announce themselves; they surface months later as
    // spikes in a graph.
    const store = openReadingStore(':memory:');
    const batch = [
      reading('bedroom_netatmo', 'co2', 812, NOW.subtract({ minutes: 2 })),
      reading('bedroom_netatmo', 'co2', 845, NOW.subtract({ minutes: 1 })),
    ];

    assert.equal(store.insert(batch), 2);
    assert.equal(store.insert(batch), 0);
    assert.equal(store.readingsInRange('bedroom_netatmo', 'co2', BEGINNING, NOW).length, 2);

    store.close();
  });

  it('stores only the new readings of a partial replay', () => {
    const store = openReadingStore(':memory:');
    store.insert([reading('bedroom_netatmo', 'co2', 812, NOW.subtract({ minutes: 2 }))]);

    const inserted = store.insert([
      reading('bedroom_netatmo', 'co2', 812, NOW.subtract({ minutes: 2 })),
      reading('bedroom_netatmo', 'co2', 845, NOW.subtract({ minutes: 1 })),
    ]);

    assert.equal(inserted, 1);
    store.close();
  });

  it('keeps the original received_at when a reading is retried', () => {
    // That is when the reading genuinely first arrived, and the retry is not
    // news. Overwriting it would quietly rewrite the arrival history.
    const store = openReadingStore(':memory:');
    const measuredAt = NOW.subtract({ minutes: 10 });

    store.insert([reading('bedroom_netatmo', 'co2', 812, measuredAt, NOW.subtract({ minutes: 9 }))]);
    store.insert([reading('bedroom_netatmo', 'co2', 812, measuredAt, NOW)]);

    const stored = store.readingsInRange('bedroom_netatmo', 'co2', BEGINNING, NOW)[0];
    assertDeepEqual(stored?.receivedAt, NOW.subtract({ minutes: 9 }));

    store.close();
  });

  it('picks the latest reading by when it was measured, not when it arrived', () => {
    // A push node replaying a backlog delivers old readings now. Ordering by
    // arrival would make an hour-old reading the current one.
    const store = openReadingStore(':memory:');

    store.insert([
      reading('bedroom_netatmo', 'co2', 845, NOW.subtract({ minutes: 1 }), NOW.subtract({ minutes: 1 })),
      reading('bedroom_netatmo', 'co2', 400, NOW.subtract({ minutes: 60 }), NOW),
    ]);

    assert.equal(store.latestReading('bedroom_netatmo', 'co2')?.value, 845);
    store.close();
  });

  it('returns a replayed backlog in the order it was measured', () => {
    // Same rule as the latest-reading query, and it matters more here: a history
    // series ordered by arrival puts a replayed backlog after the readings that
    // overtook it, and a graph drawn from that is quietly wrong.
    const store = openReadingStore(':memory:');
    store.insert([
      reading('bedroom_netatmo', 'co2', 845, NOW.subtract({ minutes: 1 }), NOW.subtract({ minutes: 1 })),
      reading('bedroom_netatmo', 'co2', 400, NOW.subtract({ minutes: 60 }), NOW),
    ]);

    const history = store.readingsInRange('bedroom_netatmo', 'co2', BEGINNING, NOW);

    assertDeepEqual(
      history.map((stored) => stored.value),
      [400, 845],
    );
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

  it('includes the from bound and excludes the to bound', () => {
    // Half-open [from, to): a dashboard walking "00:00-06:00, 06:00-12:00"
    // sees a reading measured exactly at 06:00 once — neither dropped down a
    // crack between the windows nor counted in both.
    const store = openReadingStore(':memory:');
    store.insert([
      reading('bedroom_netatmo', 'co2', 812, NOW.subtract({ minutes: 2 })),
      reading('bedroom_netatmo', 'co2', 845, NOW.subtract({ minutes: 1 })),
    ]);

    const window = store.readingsInRange(
      'bedroom_netatmo',
      'co2',
      NOW.subtract({ minutes: 2 }),
      NOW.subtract({ minutes: 1 }),
    );

    assertDeepEqual(
      window.map((stored) => stored.value),
      [812],
    );
    store.close();
  });

  it('reports nothing for a source that has never spoken', () => {
    const store = openReadingStore(':memory:');

    assert.equal(store.latestReading('living_room_tado', 'temperature'), undefined);
    assertDeepEqual(store.readingsInRange('living_room_tado', 'temperature', BEGINNING, NOW), []);
    store.close();
  });
});

describe('the schema', () => {
  // These two speak raw SQL, below the store's Instant boundary, so epoch
  // milliseconds appear here as the numbers the column actually holds.
  it('renders measured_at as readable ISO without storing it', () => {
    // The generated column costs zero storage — it is computed on read — and it
    // is what makes SELECT * legible without a join or a converter.
    const database = new DatabaseSync(':memory:');
    database.exec(SCHEMA);
    database
      .prepare('INSERT INTO readings (source_id, kind, value, measured_at, received_at) VALUES (?,?,?,?,?)')
      .run('bedroom_netatmo', 'co2', 812, Date.UTC(2026, 7, 10, 13, 45, 30, 250), NOW.epochMilliseconds);

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
      .all('bedroom_netatmo', 'co2', 0, NOW.epochMilliseconds)
      .map((row) => (row !== null && typeof row === 'object' && 'detail' in row ? row.detail : ''))
      .join('\n');

    assert.match(plan, /SEARCH readings USING INDEX sqlite_autoindex_readings_1/);
    assert.doesNotMatch(plan, /SCAN readings/);
    database.close();
  });
});
