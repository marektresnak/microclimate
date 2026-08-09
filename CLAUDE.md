# microclimate

A service that collects readings from the sensors in my flat, stores them, exposes them over a
small JSON API, and drives the HRV (heat-recovery ventilation) unit based on air quality —
primarily CO₂.

**It is a collection platform that currently ships one automation.** Long term this is where
home metrics live: more automations will read from the same store, and a dashboard will be built
on top of it. That shapes the data model — provenance, timestamps and units are designed for a
reader that does not exist yet — but it does **not** license building a rule engine, a plugin
system, or an automation registry. See "Growth without a framework" below.

**This is also a job-application work sample.** A reviewer should be able to read it and form an
opinion in 15–30 minutes. That sets the bar for everything below: small, obvious, well-tested,
and defensible line by line. If a change makes the codebase harder to explain to someone reading
it cold, it is the wrong change.

---

## The review contract

I am reviewing every line of this and must be able to explain it without notes. Code that is
clever, generic, or written for a requirement we do not have fails review even if it works.

**Hard rules:**

- **No `any`.** Not in source, not in tests. `unknown` plus a narrowing function instead.
- **No new dependencies** without asking me first, with a reason. See "Dependencies" below.
- **No classes** unless the thing genuinely owns mutable state. Prefer plain functions and
  modules. Dependencies are passed as ordinary function parameters — no DI container, no
  decorators, no service locator.
- **No `enum`, no `namespace`, no parameter properties.** Node strips types at runtime rather
  than compiling, so these do not exist for us. `as const` unions instead of enums. This is
  enforced by `erasableSyntaxOnly` in `tsconfig.json`, not left to discipline.
- **Type-only imports must say `import type`.** Same reason.
- **Explicit return types on every exported function.**
- **No type-level cleverness.** Conditional types, mapped types, generic gymnastics and branded
  types are all rejected here. Plain interfaces and discriminated unions cover everything this
  project needs.
- **Comments explain *why*, never *what*.** A comment restating the code is noise. A comment
  recording a decision, a constraint, or a failure we are defending against is the point.

**Working style:** build one module at a time, with its tests, and stop. Do not scaffold five
files ahead. I review each before the next starts.

---

## Runtime and dependencies

**Node 24 or later** (developed on 26, installed via Homebrew). Chosen so that three things need
no flags and no build step:

- `node:sqlite` is built in — no `better-sqlite3`, therefore no native compilation.
- TypeScript type-stripping is native — no `tsc` build, no bundler. `tsc` is used only for
  `--noEmit` typechecking.
- `node:test` + `node:assert/strict` — no vitest, no jest.

Runtime dependencies so far: **none.** `fetch` and `node:http` are built in.

This is deliberate. Every dependency is something I would have to defend in an interview and
cannot fully evaluate. It also keeps the whole project readable in one sitting.

**Modbus is hand-rolled**, not a library. We need exactly two function codes (read holding
registers, write single register) against a documented register map. A general Modbus library is
several thousand lines of protocol we do not use. The minimal client is ~100 lines, fully
testable against a fake socket, and is a better thing for a reviewer to read.

---

## The physical setup

Three rooms. Sensors are pulled from vendor APIs today; custom nodes will push later.

| Room | Sensors today | Planned |
|---|---|---|
| `living_room` | 1× Tado valve (temperature, humidity) | SEN66 |
| `kids_room` | 2× Tado valve (temperature, humidity) — two radiators | SEN66 |
| `bedroom` | 1× Tado valve + Netatmo Home Coach (temperature, humidity, **CO₂**) | SEN66 |

- **Tado** — pull, OAuth device flow. Per-zone temperature and humidity. Port the client from
  `~/dev/tado-monitor/src/tado-client.ts` (mine, working).
- **Netatmo Home Coach** — pull, OAuth refresh flow, `gethomecoachsdata`. Temperature, humidity,
  CO₂. Reference: `~/dev/netatmo-sync/src/worker.js` (mine, working). **Netatmo only refreshes
  every 7–8 minutes on their side.** Polling it faster gains nothing.
- **SEN66** — Sensirion nine-in-one node (PM1, PM2.5, PM4, PM10, temperature, humidity, VOC
  index, NOx index, CO₂) over I²C behind an ESP32, pushing JSON to us. Not built yet; the
  ingest endpoint and a simulator script stand in.
- **Tado thermostats** are read-only to us. We collect their values. We never control heating.
  That stays entirely with Tado.

**Because sources refresh at wildly different rates, freshness is per-source, not global.** A
30-second-old Tado reading and a 6-minute-old Netatmo reading are both fine; one global staleness
window cannot judge both. This is a load-bearing design constraint, not a detail.

---

## The actuator

A **2VV Daphne** HRV unit with heat recovery, controlled over **Modbus TCP**.

- Power is a discrete level: **20, 30, 40, … 100 percent**. Nine valid levels. 20 is the minimum;
  the unit is never turned off.
- There is a wall panel. Someone may change the level by hand. **We reassert our decision on the
  next cycle** — we do not yield to manual changes.

**Known protocol details**, recovered from my earlier C# spikes in `~/RiderProjects/RecuControl`
and `~/RiderProjects/DaphneControl` (both proven against the real unit):

| | |
|---|---|
| Address | `192.168.0.65:502` |
| Unit / slave id | `1` |
| Fan-speed register | **21001** on the wire |
| Value encoding | percent × 10 — `400` means 40% |
| Set | FC6, write single register |
| Read back | FC3, read holding registers — **confirmed working** |
| Timeouts used | 5 s, 3 retries |

**The register is 21001, not the 21002 the documentation gives.** This is the usual Modbus
convention clash — documentation numbers registers from 1, the wire numbers them from 0. It is
not a bug and must not be "corrected". Put this in a comment at the call site.

Because FC3 reads back successfully, **the current level is observable**. `/api/state` reports
desired and actual separately, and a mismatch means someone used the wall panel.

Modelled as:

```ts
export type Level = 20 | 30 | 40 | 50 | 60 | 70 | 80 | 90 | 100;
```

A literal union, so an invalid level cannot be constructed. Anything arriving from outside
(config, Modbus read) goes through a narrowing function.

---

## Data model and storage

**One table.** Every reading is a fact that was true at a point in time, from a named instrument.

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
room → sources mapping from config. "Bedroom CO₂" is
`WHERE source_id IN (...) AND kind = ? AND measured_at BETWEEN ? AND ?` — a prefix match on the
UNIQUE constraint's implicit index. Verified:

```
SEARCH readings USING INDEX sqlite_autoindex_readings_1 (source_id=? AND kind=? AND measured_at>?)
```

So **the dedup index doubles as the query index.** No second index, no denormalised column.

**`UNIQUE (source_id, kind, measured_at)` with `INSERT OR IGNORE`.** Push nodes retry, and a
retried batch must be a no-op. Duplicates in a metrics store do not announce themselves; they
surface months later as spikes in a graph. Note the ignore keeps the *first* `received_at`, which
is correct — that is when the reading genuinely first arrived.

**Timestamps are integer epoch milliseconds, UTC.** Not ISO text. The reason is narrow and
decisive: `measured_at` is part of a uniqueness constraint, so it must have exactly one
representation per instant. `2026-08-09T13:45:30+02:00` and `2026-08-09T11:45:30Z` are the same
moment and different strings, and the constraint would not catch the duplicate. Integers have one
representation. The `measured_at_iso` generated column costs zero storage — it is computed on
read — and makes `SELECT *` human-readable, so nothing is given up for this.

**`measured_at` and `received_at` are never conflated.** Netatmo readings arrive minutes after
they were taken, and a push node replaying a buffered backlog can deliver hours-old readings in
one request. Collapsing the two makes historical graphs quietly wrong and makes staleness
detection impossible — **freshness is always judged on `measured_at`**.

**IDs are TEXT, not integer foreign keys.** It costs roughly 20 MB across the raw table and buys
a `SELECT *` that is readable without a join. At this scale that is the right trade, and it
matches the project's bias toward legibility over micro-optimisation.

**Canonical units, fixed:**

| Kind | Unit |
|---|---|
| `temperature` | °C |
| `humidity` | % RH |
| `co2` | ppm |
| `pm1`, `pm2_5`, `pm4`, `pm10` | µg/m³ |
| `voc_index`, `nox_index` | Sensirion index, 1–500 |

Never store a value in anything else. Conversion happens in the adapter, at the edge.

**Store everything, control on a subset.** All nine SEN66 measurements are persisted even though
only CO₂ drives the unit. Collection is the point of the system — do not "optimise" the unused
kinds away.

## Topology lives in config, not the database

Rooms and sensors are declared in `config.ts` as an `as const` object. There is **no `rooms` or
`sensors` table.**

Config wins because it gives literal union types for `RoomId` and `SensorId` (a typo is a compile
error, precedence lists are exhaustively checkable), because git records *why* a sensor moved and
a database row never could, and because a mirrored table would need a startup reconciliation step
that can drift.

Two conventions make that safe for historical data:

1. **Sensors are never deleted from config.** Decommissioning sets `isActive: false`. The entry
   stays forever so that old readings remain interpretable. Config describes the present; the
   readings table is a record of the past, and the past needs its vocabulary kept.
2. **Relocating a sensor means a new sensor id.** Move a SEN66 from the bedroom to the kids' room
   and you retire `bedroom_sen66` and add `kids_sen66` — same device, two identities. Editing the
   room of an existing id would retroactively relabel every historical reading. This is the one
   mistake that is tempting and irreversible.

The database is not self-describing on its own. That is accepted: `GET /api/sensors` serves the
config, and the config lives in git beside the database on the same server, so any backup that
captures one captures the other. If it ever needs to be standalone, snapshotting config into a
`meta` table is a small job to do *then*, knowing what it is for.

## Retention and rollups — designed, deliberately not built

Not implemented yet. Recorded so the shape is settled when it is.

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
  `(source_id, kind, bucket_start)` so recomputation is harmless. Same discipline as ingest.
- **Prune strictly after the rollup succeeds, and only what the rollup actually contains.** Derive
  the prune from the rollup table, never from a clock. A prune that runs when the rollup failed
  silently destroys data permanently, and there is no recovering it.

Until the rollup exists, **nothing prunes**. There is no code path that deletes a reading.

## Ingest

`POST /api/readings` accepts a **batch**: one request carrying many readings, each with its own
`measured_at`. A SEN66 node reports nine measurements per cycle and must not make nine requests,
and a node that buffered through a network outage replays its backlog with the original
timestamps intact.

**Validate timestamps.** A node that has not synced NTP will report 1970 or 2106. Reject readings
whose `measured_at` is implausibly far from now (window in config) — one misconfigured device
otherwise poisons both the store and every freshness decision that reads from it.

## The read API

Two views of the same data, and one rule shared between them.

| Endpoint | Shape |
|---|---|
| `GET /api/state` | **Room-level.** One value per `(room, kind)`, plus the current control decision and its reasoning. |
| `GET /api/rooms/:room/readings` | Room-level history — sources expanded from config. |
| `GET /api/sensors` | The config topology, so a client can interpret ids without reading files. |
| `GET /api/sensors/:id/readings` | Per-instrument detail, when you want to see the raw instrument. |
| `GET /health` | Liveness. |

**The room-level view resolves its value with the same precedence function the controller uses.**
One implementation, two consumers. The dashboard therefore always shows what the controller is
actually seeing, and the two disagreeing is impossible by construction rather than by discipline.

Each room-level value reports **which sensor it came from and how fresh it is**. The general
overview only needs "bedroom temperature", but the moment a number looks wrong the first question
is which instrument said so, and the answer should already be in the response.

**Never average two instruments.** Precedence is an ordered list per `(room, kind)` and the first
fresh source wins. The kids' room has two Tado valves both reporting temperature; they read
differently because they are next to different radiators, and a mean describes neither.

## Architecture

```
src/
  config.ts             SOLE source of truth for topology: rooms, sensors
                        (with isActive), per-(room, kind) precedence, freshness
                        windows, thresholds — all `as const`
  domain/
    measurement.ts      MeasurementKind, Reading, RoomId, SensorId
    level.ts            Level + narrowing
    signal.ts           RoomSignal — fresh | stale | missing
    decision.ts         Decision, ControlOutcome
    precedence.ts       PURE. (room, kind, readings, now) -> winning RoomSignal.
                        Shared by the controller and /api/state — one rule.
  sources/
    source.ts           SensorSource interface, PollResult
    tado.ts             pull adapter
    netatmo.ts          pull adapter
  ingest/
    http.ts             POST /api/readings — batched, idempotent, timestamp-validated
  store/
    readings.ts         node:sqlite; append-only, no pruning path exists yet
  control/
    freshness.ts        PURE. reading + now + per-source window -> RoomSignal
    policy.ts           PURE. snapshot -> desired Level + reasons
    limiter.ts          PURE. desired + current + last-change -> ControlOutcome
    loop.ts             orchestration: poll -> store -> decide -> actuate
  actuator/
    unit.ts             VentilationUnit interface
    modbus-tcp.ts       real implementation, FC3 + FC6
    fake.ts             test double, records calls
  http/
    server.ts           the read API
  main.ts               wiring only
tests/
```

**`precedence.ts`, `freshness.ts`, `policy.ts` and `limiter.ts` are pure and contain all the
interesting reasoning.** No IO, no clock reads, no database. Time arrives as a parameter. This is
what makes the control logic testable without hardware, and it is the part of the codebase a
reviewer should spend their time in.

`main.ts` does wiring and nothing else.

---

## The control logic

Runs on a loop. Sensors are polled on their own cadences; the control decision is evaluated every
30 seconds.

Pipeline, in order:

1. **Snapshot.** For each room, the CO₂ reading from the **highest-precedence source that is
   fresh**, tagged with its freshness. Precedence is config, per `(room, kind)`: once a SEN66 is
   installed it outranks the Netatmo in that room, and the Netatmo is only consulted while the
   SEN66 is stale or absent. Never average two instruments — they have different calibration and
   latency, and a blended number belongs to neither.
2. **Sleep detection.** Asleep if *any* of:
   - inside fixed quiet hours (config, default 22:00–07:00), **or**
   - bedroom CO₂ is fresh and above the sleep threshold, **or**
   - it is night and bedroom CO₂ is **not** fresh.

   The third clause is the safety one. A dead or stale Netatmo must never let the unit run loud
   at 3am, so unknown data at night resolves to "asleep". The fixed quiet-hours clause is an
   independent second guard: sleep detection does not depend on a single sensor being alive.
3. **Demand.** Highest fresh CO₂ across all rooms drives the target — worst room wins. Stale and
   missing readings are excluded from demand entirely; they are never treated as low CO₂.
4. **No fresh CO₂ anywhere** → fall back to `safeDefaultLevel` (config, default 40). Moderate
   continuous ventilation is the safe answer when blind: quieter than boosting, safer than idling.
5. **Deadband.** Thresholds differ going up and coming down (e.g. boost above 800ppm, do not come
   back down until below 650ppm), and the target must differ from the current level by more than
   one step to trigger a change at all.
6. **Sleep cap.** If asleep, clamp to `sleepMaxLevel` (config, default 50). Above that the unit is
   audible in the bedroom.
7. **Dwell.** Do not change if the last change was less than `minDwellMinutes` ago (config).
8. **Clamp** to a valid `Level`.

**On steps 5 and 7 together:** the requirement is that the unit settles on a stable power level
rather than oscillating 100 → 20 → 100. Dwell alone only limits how *often* it swings; the
deadband is what makes the swing not happen. Both are needed.

**Every decision carries its reasoning.** `ControlOutcome` includes the reasons that produced it,
and those surface in `/api/state` and the logs. A decision you cannot explain after the fact is a
decision you cannot debug.

---

## Growth without a framework

More automations are coming, and a dashboard will be built on this. Neither justifies
infrastructure now.

The seams that make growth additive already exist:

- `policy.ts` is `(snapshot, now) => decision`. A second automation is a second pure function.
- Actuators sit behind an interface. A second device is a second adapter.
- Readings are `(source, room, kind, value, time)`. A new sensor is config plus an adapter.
- The store answers range queries. A dashboard is a read endpoint, not a schema change.

So: **no rule engine, no plugin loader, no automation registry, no event bus.** When the second
automation arrives, write the second function. If a third and fourth follow and a real pattern
emerges, abstract *then*, against evidence.

A reviewer has twenty minutes and wants to read one thing that works — not scaffolding for five
things that do not.

## Testing

**Full case list: [`docs/test-plan.md`](docs/test-plan.md).** Written before the implementation,
and it carries six open design questions (Q1–Q6) that must be answered before the modules they
affect are written.

The pure modules are written **test-first** — `freshness`, `precedence`, `policy`, `limiter`.
Adapters are tested after, against fakes, because their shape is not knowable until the real
protocol has been spoken.

`node:test` + `node:assert/strict`. No framework.

- **The pure core is tested directly** — `policy.ts` and `limiter.ts` take a snapshot and a
  timestamp and return a decision. Table-driven cases.
- **Time is injected**, never read from `Date.now()` inside logic. A `Clock` is a parameter.
- **Fakes, not mocks.** `actuator/fake.ts` records the levels it was told to set. Sources are
  plain functions returning canned readings.
- **The cases that matter** are the failure ones: sensor goes stale mid-run, Netatmo unreachable,
  all sensors dead, CO₂ hovering exactly on a threshold, quiet hours boundary, dwell boundary,
  Modbus write times out.

A reviewer should be able to read the policy tests alone and understand what the system does.

---

## Configuration

`config.ts` is the sole source of truth for both **topology** (rooms; sensors with their room,
kinds, `isActive` flag and freshness window; per-`(room, kind)` precedence order) and **tuning**
(thresholds, quiet hours, dwell). All `as const`, so ids are literal union types and a typo is a
compile error.

Secrets — Tado and Netatmo OAuth, the Modbus host, the ingest token — come from environment
variables and are never committed.

Starting defaults, all to be tuned against reality:

| Setting | Default |
|---|---|
| CO₂ boost threshold (rising) | 800 ppm |
| CO₂ release threshold (falling) | 650 ppm |
| CO₂ maximum demand | 1200 ppm |
| Bedroom sleep CO₂ threshold | 700 ppm |
| Quiet hours | 22:00–07:00 |
| Sleep max level | 50 |
| Safe default level (no data) | 40 |
| Minimum dwell | 10 minutes |
| Control evaluation interval | 30 s |

---

## Open questions

These are unresolved. Do not invent answers — ask.

1. **The rest of the Daphne register map.** Fan speed (21001) is confirmed. The old spike carries
   two contradictory comments — one says register 21002 is fan speed, another says it is
   temperature — and a stray note about register 14000 using "direct addressing" on
   Daphne/AirGENIO. Only 21001 is trusted. Anything else must be verified against the real 2VV
   documentation or probed against the unit before use.
2. **Does the unit accept only multiples of 10, or does it round?** We only ever write valid
   `Level` values, so this is a curiosity rather than a risk — but worth knowing when reading
   back a level the wall panel set.
3. **Exact CO₂ thresholds.** Defaults above are guesses and need tuning against real readings.
4. **Push authentication.** The SEN66 nodes need some shared secret to POST. Not yet decided.

---

## Out of scope — deliberately

Stated so the gaps read as decisions rather than omissions:

- **Docker.** Comes later; the service runs on a home server eventually.
- **Charts and UI.** JSON endpoints only. A dashboard adds hours and demonstrates nothing for a
  backend sample.
- **Controlling heating.** Tado keeps that. We read its sensors and nothing more.
- **Users, auth, multi-home.** Single home, single occupant-operator, trusted LAN.
- **Retention, downsampling, rollups.** Designed and costed above, not built. Nothing prunes.
- **A `rooms` / `sensors` table.** Topology is config-only, on purpose — see above.
- **Runtime topology changes.** Adding a sensor is a config edit and a restart, not an API call.
