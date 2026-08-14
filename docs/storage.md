# Storage

Why the database looks like it does. The rules that must survive an edit — append-only,
`measured_at` is never conflated with `received_at`, a relocated sensor gets a new id — are in
[`CLAUDE.md`](../CLAUDE.md).

## One table of readings

Every reading is a fact that was true at a point in time, from a named instrument. (The service log
is a second table, below.)

```sql
CREATE TABLE readings (
  source_id       TEXT    NOT NULL,   -- which instrument, not which room
  kind            TEXT    NOT NULL,   -- TEXT so a new measurement never needs a migration
  value           REAL    NOT NULL,   -- always the canonical unit for that kind
  measured_at     INTEGER NOT NULL,   -- epoch ms, UTC. when the instrument took it
  received_at     INTEGER NOT NULL,   -- epoch ms, UTC. when we learned about it
  measured_at_iso TEXT GENERATED ALWAYS AS
    (strftime('%Y-%m-%dT%H:%M:%fZ', measured_at / 1000.0, 'unixepoch')) VIRTUAL,
  UNIQUE (source_id, kind, measured_at)
) STRICT;
```

**No `room_id` column.** The room is a property of the instrument, and the app knows the
room → sources mapping from config. **The dedup index doubles as the query index** —
`(source_id, kind, measured_at)` is exactly the prefix a room-history query matches on, verified
against the query plan by a test. No second index, no denormalised column.

**`UNIQUE (source_id, kind, measured_at)` with `INSERT OR IGNORE`.** Push nodes retry, and a
retried batch must be a no-op. Duplicates in a metrics store do not announce themselves; they
surface months later as spikes in a graph.

**Stored timestamps are integer epoch milliseconds, UTC.** Not ISO text, and the reason is narrow:
`measured_at` is part of a uniqueness constraint, so it must have exactly one representation per
instant. `2026-08-09T13:45:30+02:00` and `2026-08-09T11:45:30Z` are the same moment and different
strings, and the constraint would not catch the duplicate. The `measured_at_iso` generated column
costs zero storage and makes `SELECT *` readable, so nothing is given up.

**That argument is about the column and does not reach the wire.** The API speaks ISO 8601 in both
directions and no epoch millisecond is visible anywhere in it. Between the two edges the code
carries `Temporal.Instant` and `Temporal.Duration`. `domain/time.ts` is the whole wire conversion;
the store modules hold the only `epochMilliseconds` conversions, at the SQL boundary.

**`measured_at` and `received_at` are never conflated.** Netatmo readings arrive minutes after they
were taken, and a push node replaying a buffered backlog can deliver hours-old readings in one
request. Collapsing the two makes historical graphs quietly wrong and makes staleness detection
impossible.

**IDs are TEXT, not integer foreign keys.** Roughly 20 MB across the raw table, buying a `SELECT *`
that is readable without a join. At this scale that is the right trade.

## The service log — the second table, deliberately

Every line the `log` seam carries — poll failures, store failures, ingest verdicts, fan commands —
goes to stdout **and**, best-effort, into a `logs` table in the same database file.
`GET /api/logs` serves it back, so "what happened last night" is a dashboard question rather than
one needing a login to the machine.

- **Append-only**, like everything else in the file.
- **stdout first, the table write best-effort.** When SQLite itself is what is broken, the database
  cannot carry the news of its own outage, and a logging failure must never take down the work it
  was narrating.
- **No severity column.** The lines carry no level, and a taxonomy invented for a few hundred lines
  a day serves no consumer. If a dashboard later needs to filter errors, the column arrives
  together with every call site classified, not before.
- **No dedup, no uniqueness constraint.** Nothing retries a log line; two identical lines a minute
  apart are two events. The range index is therefore explicit, where the readings table gets its
  own free from the dedup constraint.
- **Nothing prunes it.** Tens of megabytes a year at current volume.

The log is also the durable record of when the fan level changed over the API — `"70% set over the
API"` next to the CO₂ curve it explains, which is half the axis the measurement campaign needs.
Wall-panel changes stay invisible: the log records what the service did and was told, not what the
panel did.

## Topology lives in config, not the database

Rooms and sensors are declared in `config.ts` as an `as const` object. There is **no `rooms` or
`sensors` table.** Config wins because it gives literal union types for `RoomId` and `SensorId` (a
typo is a compile error, precedence lists are exhaustively checkable), because git records *why* a
sensor moved and a database row never could, and because a mirrored table would need a startup
reconciliation step that can drift.

Two conventions make that safe for historical data, and both are load-bearing enough to be repeated
in CLAUDE.md:

1. **Sensors are never deleted from config.** Decommissioning takes the sensor out of the
   precedence lists and sets `isActive: false`. The entry stays forever so old readings remain
   interpretable. Config describes the present; the readings table is a record of the past, and the
   past needs its vocabulary kept.

   **The precedence lists are the only thing that decides who is consulted.** `isActive` is
   descriptive — it is what `/api/sensors` reports so a client can tell a retired instrument from a
   live one, and `precedence.ts` does not look at it. Do not add a second switch: the ranked list
   also says in what *order*, so it has to be edited anyway. A test asserts an inactive sensor is
   never ranked anywhere, so a half-finished removal fails at the moment the mistake is made.
2. **Relocating a sensor means a new sensor id.** Move a SEN66 from the bedroom to the kids' room
   and you retire `bedroom_sen66` and add `kids_sen66` — same device, two identities. Editing the
   room of an existing id would retroactively relabel every historical reading. This is the one
   mistake that is tempting and irreversible.

The database is not self-describing on its own. That is accepted: `GET /api/sensors` serves the
config, and the config lives in git beside the database on the same server, so any backup that
captures one captures the other.

## Retention and rollups — designed, deliberately not built

Target tiers: **raw at 30 s kept for 7 days**, rolled up to **15-minute buckets** beyond that.

| Tier | Rows | Size |
|---|---|---|
| Raw, 7 days @ 30 s | ~709k | ~61 MB, steady state — never grows |
| Rollup, 15 min | ~1.33M/year | ~106 MB/year |

Ten years lands near 1.1 GB. Without rollups the raw table grows at ~3.2 GB/year, so this is
roughly a 30× reduction. **Revisit at around six months of runtime**, well before it matters.

When it is built:

- Store `count`, `avg`, `min`, `max` per bucket, not just an average. For air quality the peak is
  the interesting number — a CO₂ spike to 1400 for ten minutes vanishes into an hourly mean, and
  that spike is exactly what you would go looking for.
- Roll up **closed buckets only**, and make the upsert idempotent on
  `(source_id, kind, bucket_start)` so recomputation is harmless.
- **Prune strictly after the rollup succeeds, and only what the rollup actually contains.** Derive
  the prune from the rollup table, never from a clock. A prune that runs when the rollup failed
  silently destroys data permanently.

Until the rollup exists, **nothing prunes**. There is no code path that deletes a reading.
