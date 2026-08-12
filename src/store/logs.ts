import { DatabaseSync } from 'node:sqlite';

/**
 * The service log: the same lines the process writes to stdout, kept in the
 * database so the API can answer "what happened last night" without a shell
 * on the machine.
 *
 * The second table in the file, and append-only like the first — a log line is
 * a fact about a point in time, so the no-mutable-row property the store was
 * cut down to when `control_state` went is untouched. There is no severity
 * column: the lines carry no level today, and a taxonomy invented for a few
 * hundred lines a day serves no consumer — a time range and an eye find
 * everything. Nothing prunes, same as the readings; tens of megabytes a year
 * at current volume, and the easiest retention target there is when that day
 * comes — a DELETE below a cutoff, no rollup needed.
 *
 * Exported so the tests assert against the real schema rather than a copy of it.
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS logs (
  at      INTEGER NOT NULL,   -- epoch ms, UTC. when the line was written
  message TEXT    NOT NULL,
  at_iso  TEXT GENERATED ALWAYS AS
    (strftime('%Y-%m-%dT%H:%M:%fZ', at / 1000.0, 'unixepoch')) VIRTUAL
) STRICT;
CREATE INDEX IF NOT EXISTS logs_at ON logs (at);
`;
// The index is explicit because there is no constraint to borrow it from —
// the readings table gets its range index free from the dedup constraint, and
// a log has nothing to deduplicate: two identical lines are two events.

// rowid breaks the tie inside one millisecond, so lines come back in the
// order they were written — the collector can log two sources back to back.
// Half-open [from, to), the same rule as the readings range and for the same
// reason: adjacent windows tile.
export const RANGE_QUERY_SQL = `
SELECT at, message FROM logs
WHERE at >= ? AND at < ?
ORDER BY at, rowid
`;

// Plain INSERT, no OR IGNORE: nothing retries a log line.
const INSERT_SQL = `
INSERT INTO logs (at, message) VALUES (?, ?)
`;

export interface LogLine {
  readonly at: Temporal.Instant;
  readonly message: string;
}

export interface LogStore {
  append(at: Temporal.Instant, message: string): void;
  /** Half-open [from, to), the same rule as the readings range. */
  linesInRange(fromAt: Temporal.Instant, toAt: Temporal.Instant): LogLine[];
  close(): void;
}

export function openLogStore(path: string): LogStore {
  // Its own connection to the shared file, so neither store hands its handle
  // around. WAL again: the collector logs while the API reads.
  const database = new DatabaseSync(path);
  database.exec('PRAGMA journal_mode = WAL');
  database.exec(SCHEMA);

  const insertStatement = database.prepare(INSERT_SQL);
  const rangeStatement = database.prepare(RANGE_QUERY_SQL);

  return {
    append(at, message) {
      insertStatement.run(at.epochMilliseconds, message);
    },

    linesInRange(fromAt, toAt) {
      const rows = rangeStatement.all(fromAt.epochMilliseconds, toAt.epochMilliseconds);
      return rows.map(toLogLine);
    },

    close() {
      database.close();
    },
  };
}

function toLogLine(row: unknown): LogLine {
  if (row === null || typeof row !== 'object') {
    throw new Error('sqlite returned a row that is not an object');
  }
  if (!('at' in row) || typeof row.at !== 'number') {
    throw new Error('log line has no numeric at');
  }
  if (!('message' in row) || typeof row.message !== 'string') {
    throw new Error('log line has no message');
  }

  return { at: Temporal.Instant.fromEpochMilliseconds(row.at), message: row.message };
}
