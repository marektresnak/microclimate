import { DatabaseSync } from 'node:sqlite';

import type { SensorId } from '../config.ts';
import type { MeasurementKind, Reading } from '../domain/measurement.ts';

/**
 * One table. Every reading is a fact that was true at a point in time, from a
 * named instrument. Append-only: there is no code path here that deletes a
 * reading, and there will not be one until the rollup tier exists to prune
 * against.
 *
 * Exported so the tests assert against the real schema rather than a copy of it.
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS readings (
  source_id       TEXT    NOT NULL,   -- which instrument, not which room
  kind            TEXT    NOT NULL,   -- TEXT so a new measurement never needs a migration
  value           REAL    NOT NULL,   -- always the canonical unit for that kind
  measured_at     INTEGER NOT NULL,   -- epoch ms, UTC. when the instrument took it
  received_at     INTEGER NOT NULL,   -- epoch ms, UTC. when we learned about it
  measured_at_iso TEXT GENERATED ALWAYS AS
    (strftime('%Y-%m-%dT%H:%M:%fZ', measured_at / 1000.0, 'unixepoch')) VIRTUAL,
  UNIQUE (source_id, kind, measured_at)
) STRICT;
`;

// The dedup constraint doubles as the query index: (source_id, kind, measured_at)
// is exactly the prefix this matches on, so there is no second index and no
// denormalised room column. A test asserts the query plan, so reordering the
// constraint fails loudly.
//
// Half-open [from, to), so adjacent windows tile — see CLAUDE.md, "Rules the
// API keeps".
export const RANGE_QUERY_SQL = `
SELECT value, measured_at, received_at FROM readings
WHERE source_id = ? AND kind = ? AND measured_at >= ? AND measured_at < ?
ORDER BY measured_at
`;

const LATEST_QUERY_SQL = `
SELECT value, measured_at, received_at FROM readings
WHERE source_id = ? AND kind = ? ORDER BY measured_at DESC LIMIT 1
`;

// INSERT OR IGNORE, because push nodes retry and a retried batch must be a
// no-op. Duplicates in a metrics store do not announce themselves; they surface
// months later as spikes in a graph. The ignore keeps the *first* received_at,
// which is correct — that is when the reading genuinely first arrived.
const INSERT_SQL = `
INSERT OR IGNORE INTO readings (source_id, kind, value, measured_at, received_at)
VALUES (?, ?, ?, ?, ?)
`;

export interface ReadingStore {
  /** Returns how many rows were new, so a caller can see replay being absorbed. */
  insert(readings: readonly Reading[]): number;
  latestReading(sourceId: SensorId, kind: MeasurementKind): Reading | undefined;
  /** Half-open [from, to): adjacent windows tile. */
  readingsInRange(
    sourceId: SensorId,
    kind: MeasurementKind,
    fromMeasuredAt: Temporal.Instant,
    toMeasuredAt: Temporal.Instant,
  ): Reading[];
  close(): void;
}

export function openReadingStore(path: string): ReadingStore {
  const database = new DatabaseSync(path);

  // The collector writes every thirty seconds while the read API serves
  // queries from the same file. WAL is what stops one blocking the other.
  database.exec('PRAGMA journal_mode = WAL');
  database.exec(SCHEMA);

  const insertStatement = database.prepare(INSERT_SQL);
  const latestStatement = database.prepare(LATEST_QUERY_SQL);
  const rangeStatement = database.prepare(RANGE_QUERY_SQL);

  return {
    insert(readings) {
      let inserted = 0;

      database.exec('BEGIN');
      try {
        for (const reading of readings) {
          // The one place an instant becomes a column value. Millisecond epoch,
          // matching what parseInstant truncated to at the edge.
          const result = insertStatement.run(
            reading.sourceId,
            reading.kind,
            reading.value,
            reading.measuredAt.epochMilliseconds,
            reading.receivedAt.epochMilliseconds,
          );
          inserted += Number(result.changes);
        }
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }

      return inserted;
    },

    latestReading(sourceId, kind) {
      // Ordered by measured_at, never received_at: a backlog replayed an hour
      // late must not become the latest reading.
      const row = latestStatement.get(sourceId, kind);
      if (row === undefined) return undefined;

      return toReading(row, sourceId, kind);
    },

    readingsInRange(sourceId, kind, fromMeasuredAt, toMeasuredAt) {
      const rows = rangeStatement.all(
        sourceId,
        kind,
        fromMeasuredAt.epochMilliseconds,
        toMeasuredAt.epochMilliseconds,
      );
      return rows.map((row) => toReading(row, sourceId, kind));
    },

    close() {
      database.close();
    },
  };
}

/**
 * The row carries no ids of its own: both queries filter on `source_id` and
 * `kind`, so the caller's values are the row's values by construction. That
 * keeps a database file from being able to hand back a sensor id the config has
 * never heard of.
 */
function toReading(row: unknown, sourceId: SensorId, kind: MeasurementKind): Reading {
  if (row === null || typeof row !== 'object') {
    throw new Error('sqlite returned a row that is not an object');
  }
  if (!('value' in row) || typeof row.value !== 'number') {
    throw new Error(`reading from ${sourceId} has no numeric value`);
  }
  if (!('measured_at' in row) || typeof row.measured_at !== 'number') {
    throw new Error(`reading from ${sourceId} has no numeric measured_at`);
  }
  if (!('received_at' in row) || typeof row.received_at !== 'number') {
    throw new Error(`reading from ${sourceId} has no numeric received_at`);
  }

  return {
    sourceId,
    kind,
    value: row.value,
    measuredAt: Temporal.Instant.fromEpochMilliseconds(row.measured_at),
    receivedAt: Temporal.Instant.fromEpochMilliseconds(row.received_at),
  };
}
