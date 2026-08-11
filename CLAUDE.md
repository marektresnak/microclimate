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

## The control loop is parked — the service collects, a human drives

**As of 2026-08-11 the loop is not wired.** `main.ts` runs collection (sources → store), the
read API, and one write endpoint. Nothing automatic moves the fan; it is driven by
the wall panel or by `POST /api/unit/level`. The control code — `src/control/`, the scripted
traces — stays in the tree and green in CI: built and tested, deliberately unwired.

**Why.** The band is an estimate until a week of real settling points exists (see "What is
actually known about this flat"), and convergence cannot be validated before that data does.
Rather than let a controller tuned by guesses drive the flat, the automation waits for its
calibration data — and manual control over the API is the instrument of that campaign: hold a
level, watch CO₂ settle, log it. The loop comes back with a band computed from measurement.

**What is suspended while it is parked, said out loud:**

- **The hard requirement is suspended.** Nothing corrects a fan left loud while someone is
  asleep — a hand-set 80 at 23:30 runs all night. This returns the flat to its actual status
  quo (wall panel plus human memory); the service adds observability, not yet protection. There
  is deliberately **no quiet-hours check on the POST endpoint**: the wall panel would bypass it
  anyway, and partial cover that reads as protection is worse than a known gap (R8's words).
- The pinned-at-ceiling diagnostic, the startup adoption of the unit's level (Q4), and the
  sleep logic run only in tests.
- `/api/state` carries no control block. It returns with the loop.

**How it returns:** the collector in `main.ts` is the loop's own polling step, extracted. The
loop polls for itself, so rewiring it *replaces* the collector — the two never run together, or
every source would be polled twice.

**The plan of record for the control code: delete it.** Once this phase settles, the control
modules, their tests and the documentation sections describing them are to be removed outright,
leaving a pointer to the git commit that carries them — git is the attic, not the working tree.
Decided, not yet done; this round only unwired it.

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

### Readable over compact

Write idiomatic TypeScript and stop there. Respect the language's conventions; do not show them
off. The test for any line is whether it can be **narrated out loud** — if explaining it takes a
paragraph, it is wrong however elegant it looks.

- **Name the intermediate steps.** A chain that has to be read right-to-left or inside-out gets
  broken into named `const`s. Three short named steps beat one dense expression, always.
- **No nested ternaries.** One level is fine for a genuine either/or. Two is a rewrite.
- **Early returns over nested `if`.** The happy path should be the least-indented code in the
  function.
- **A `for...of` loop is not a failure.** Reach for `reduce` when the operation genuinely is a
  fold, not to avoid writing a loop.
- **Do not split functions to hit a line count.** One coherent 40-line function beats four
  10-line ones with invented names and a call graph to trace.
- **`?.` and `??` are good; a five-link optional chain is not** — it hides whether the thing was
  ever supposed to exist. If absence is meaningful, handle it explicitly.
- **No abbreviated identifiers.** `bedroomSignal`, not `bdSig`.
- **Keep destructuring simple.** Renames, defaults and nesting stacked into one pattern is a
  puzzle, not a convenience.

Not idiomatic *here*, however common elsewhere: classes with inheritance, decorators, getters
that do work, point-free style, currying, and heavy functional composition.

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

**`npm test` runs `tsc --noEmit` first, and that is not a convenience.** Type stripping deletes the
types without ever checking them, so nothing at runtime enforces `CommandedLevel` — and
`CommandedLevel` is the entire guard against commanding 90 or 100 into a restricted intake grille.
A suite that runs green without a typecheck is a suite that would not notice the guard had gone.
The Modbus adapter carries a runtime range assertion at the write site for the same reason: the
one place where a number leaves the type system and becomes bytes on a wire deserves a belt as
well as braces.

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

  `~/RiderProjects/DaphneControl` has files under `Sensors/Netatmo/`, and they are **stubs** —
  every method throws `NotImplementedException`. There is no auth flow, no endpoint and no response
  shape to recover there, so `netatmo-sync` is the only reference. Its one real contribution is a
  comment on `ISensor`: *"if the bedroom CO2 is over some threshold, we can assume someone is
  sleeping and restrict max fan speed to 50%"* — which is where `SLEEP_CO2` and `sleepMaxLevel`
  came from, already absorbed above.
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

- Power is a discrete level: **20, 30, 40, … 100 percent**, in steps of 10.
- **20 is the floor** — a device limit. The unit is never turned off.
- **80 is the ceiling** — an *installation* limit, not a device one. The intake grille in this
  flat cannot pass enough air above roughly 80%, so running higher makes the fan work against a
  restriction: noisy, inefficient, and it unbalances supply against extract on a heat-recovery
  unit. The device would accept 90 and 100. **We never send them.**
- There is a wall panel. Someone may change the level by hand. **We act on that in exactly one
  case: when it would make the flat loud while somebody is asleep.**

  The actual level is read back every tick and reported next to the desired level in `/api/state`,
  so any mismatch is visible. If the unit is above `sleepMaxLevel` while sleep is asserted, that
  level is handed to the limiter as where the unit really is, and the existing cap path pulls it
  back in one move. Otherwise the controller decides from its own last commanded value, and the
  hand-set level survives until our decision changes for its own reasons.

  **A hand-set level *below* the cap is never undone.** A quieter fan harms nobody, so the panel
  stays good for the thing people actually reach for it at night. That is strictly better than the
  original design, which reasserted unconditionally and pushed a hand-set 30 back up to 50.

  **This makes the hard requirement depend on the Modbus read.** A unit we cannot read is a unit
  whose level we do not know, so a hand-set breach goes uncorrected for as long as reads are
  failing — the loop logs each failure and enforces the cap again on the first tick that answers.
  Correct by necessity rather than by choice, but it is a dependency the requirement did not have
  before the cap started consulting the read-back, and it is worth knowing when reads get flaky.

  This is the third position this decision has occupied, and the reasoning for landing here is
  worth keeping. Reasserting *always* makes the panel useless, which two independent reviewers
  argued against. Reasserting *never* — briefly the design, for one round — means a hand-set 80 at
  23:30 runs all night while the log reports *"50% held"*, so the one hard requirement in the
  product loses to a button press. **Correcting only a breach of the cap is the smallest mechanism
  that makes the hard requirement actually hard**, and the asymmetry it introduces is one sentence:
  we ignore the panel except when it would make the flat loud while someone is asleep.
- **If the service dies, the unit holds its last commanded level indefinitely.** There is no
  watchdog and we do not set a safe level on shutdown. A crash at 21:30 with the unit at 80 leaves
  it audible all night, and the next night too. Accepted, and re-affirmed after a reviewer pressed
  the point: a shutdown handler covers only graceful exits, a hard crash or power cut bypasses it
  entirely, and partial cover that looks like protection is worse than a known gap. The honest fix
  is a device-side watchdog we do not have.

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
| Timeouts used | 5 s, 3 retries, 250 ms between attempts |

**The register is 21001, not the 21002 the documentation gives.** This is the usual Modbus
convention clash — documentation numbers registers from 1, the wire numbers them from 0. It is
not a bug and must not be "corrected". Put this in a comment at the call site.

**The TypeScript client has been verified against the real unit**, not only against a fake stream:
on 2026-08-11 it read 50%, wrote 70%, read back 70%, wrote 50% and read back 50%, first attempt.
Every recovered detail above therefore now holds for this code and not just for the C# spikes —
framing, transaction ids, the register number and the ×10 encoding.

**The 5 seconds covers connecting, not only waiting for an answer.** The old spike set
`ReceiveTimeout` and `SendTimeout`, both of which govern an already-established stream, and left
`TcpClient.Connect` unbounded — so the recovered "5 s" never covered connection setup in either
codebase. An address that stops answering SYNs then blocks for the operating system's default,
about 75 seconds per attempt, which with retries is minutes against a thirty-second control cycle.
Confirmed by deleting the connect timeout and watching a test take exactly 75 seconds.

**A fresh TCP connection per request**, rather than holding one open. At two requests every thirty
seconds a persistent socket is state to manage — stale connections, reconnection, half-open
detection — bought with nothing. The risk was that a cheap embedded stack accepts only one session
and holds a dead one open; measured instead of assumed, on 2026-08-11: ten consecutive fresh
connections completed in 6–11 ms each with no refusals, which is about a hundred times the rate
this will ever run at.

**The five seconds is one budget per attempt, not one per phase.** Connecting spends from the same
clock as waiting for the answer, so an attempt cannot quietly cost double — which matters because
a tick makes up to two of these and has thirty seconds to do it in.

**250 ms between attempts** is not invented either: NModbus, which the spike used, waited that long
by default, so it is what the field-proven behaviour actually included. Reconnecting the instant a
device refuses you is the least likely attempt to succeed, and four of them inside a millisecond is
one attempt wearing a disguise.

Because FC3 reads back successfully, **the current level is observable**. `/api/state` reports
desired and actual separately, and a mismatch means someone used the wall panel.

Because the readable range and the commandable range genuinely differ, they are two types:

```ts
// What the unit can report. A wall-panel user can put it at 90 or 100.
export type Level = 20 | 30 | 40 | 50 | 60 | 70 | 80 | 90 | 100;

// What we are ever allowed to send. See the intake-grille limit above.
export type CommandedLevel = 20 | 30 | 40 | 50 | 60 | 70 | 80;
```

`CommandedLevel` is assignable to `Level` with no conversion, so `VentilationUnit.read()` returns
`Level` and `set()` accepts only `CommandedLevel`. **Commanding 90 is then a compile error, not a
runtime check that someone has to remember to write.** The ceiling is also a named constant,
`MAX_COMMANDED_LEVEL`, for the places that need it as a value rather than a type.

Both are plain literal unions — anything arriving from outside (config, a Modbus read) goes
through a narrowing function.

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

**There is no second table.** The controller's working state — last commanded level, when it last
changed, whether the previous cycle was asleep — lives in memory and is lost on restart. A restart
therefore acts immediately rather than waiting out a dwell period.

An earlier revision persisted the last change in a `control_state` table, on the grounds that a
crash loop would otherwise make one change per restart instead of one per ten minutes. The table
came with a clamp on read (a future timestamp made the dwell never expire), and a rule that an
unreadable row is an error rather than a first run — two guards protecting one guard. **All three
are removed.** The database is now append-only with no mutable row in it at all, which is a
property worth more than the failure mode it gives up. A service that crash-loops is a problem to
fix, not a problem to rate-limit.

## Topology lives in config, not the database

Rooms and sensors are declared in `config.ts` as an `as const` object. There is **no `rooms` or
`sensors` table.**

Config wins because it gives literal union types for `RoomId` and `SensorId` (a typo is a compile
error, precedence lists are exhaustively checkable), because git records *why* a sensor moved and
a database row never could, and because a mirrored table would need a startup reconciliation step
that can drift.

Two conventions make that safe for historical data:

1. **Sensors are never deleted from config.** Decommissioning takes the sensor out of the
   precedence lists and sets `isActive: false`. The entry stays forever so that old readings remain
   interpretable. Config describes the present; the readings table is a record of the past, and the
   past needs its vocabulary kept.

   **The precedence lists are the only thing that decides who is consulted.** `isActive` is
   descriptive — it is what `/api/sensors` reports so a client can tell a retired instrument from a
   live one, and `precedence.ts` does not look at it. An earlier revision had it skip inactive
   sources, which meant two switches answering one question and one of them unreachable from any
   test, because nothing in this flat has ever been decommissioned. The ranked list also says in
   what *order*, so it has to be edited anyway; the flag did not.

   The cost is that taking a sensor out is one edit per kind rather than one per sensor, and a
   half-finished removal would leave a retired instrument still winning for the kind that was
   missed. That is a config inconsistency rather than a silent runtime one, and a test asserts an
   inactive sensor is never ranked anywhere — so it fails at the moment the mistake is made.
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

**Validate timestamps in one direction only: reject the future**, beyond about five minutes of
clock skew. A node reporting 2106 would otherwise look eternally fresh and poison every decision
downstream.

**Any past timestamp is accepted.** Rejecting old readings would discard exactly the buffered
backlog that batching exists to carry: a node offline for twelve hours replays around 1,300
batches, and any window shorter than the outage throws them all away — data the system exists to
keep. The past-side check also buys nothing, because `INSERT OR IGNORE` already makes replay
idempotent at any age.

**Built 2026-08-11**, with three decisions folded in as it landed:

- **Q6 is decided as the plan recommended: one bad reading does not sink the batch.** The valid
  readings land; each reject is reported with its index and reason. A node cannot fix a bad
  reading by resending it, so failing the batch holds eight good readings hostage to one bad
  one, forever. For the same reason the response is **200 whenever the batch was processed**,
  verdicts inside — a status a simple node reads as "retry" would have it replaying poison
  until the end of time.
- **A valid kind the instrument does not declare is rejected**, not stored: `bedroom_netatmo`
  claiming `pm2_5` is a wrong sourceId in node firmware, and storing it files one instrument's
  data under another's name, permanently.
- **The below-300-ppm calibration diagnostic lives here now** (it was deferred with this
  module): logged, never rejected. A drifted NDIR instrument is still reporting real air with a
  shifted zero, and the low reading is the evidence of the fault — discarding it would hide the
  diagnosis.

There is no push authentication — see the open-endpoints decision in the read API section.

## The read API

Two views of the same data, and one rule shared between them.

| Endpoint | Shape |
|---|---|
| `GET /api/state` | **Room-level.** One value per `(room, kind)`, each naming its source and freshness. The control block is parked with the loop and returns with it. |
| `GET /api/rooms/:room/readings` | Room-level history — sources expanded from config, inactive ones included, `?from=&to=` as epoch ms (default last 24 h), `?kind=` to filter. |
| `GET /api/sensors` | The config topology, so a client can interpret ids without reading files. |
| `GET /api/sensors/:id/readings` | Per-instrument detail, when you want to see the raw instrument. |
| `GET /api/unit/level` | The fan's actual level, read live over Modbus. This is how a wall-panel change stays visible while the loop's read-every-tick is parked. |
| `POST /api/unit/level` | Sets the fan. `assertCommandedLevel` refuses 90 and 100. **Deliberately unauthenticated** — see below. |
| `POST /api/readings` | Batch ingest for the push nodes: a JSON array of readings, each with its own `measuredAt`. Future rejected beyond 5 min of skew, any past accepted, replay idempotent. **Also unauthenticated** — same decision below. |
| `GET /auth/netatmo` (+ `/callback`) | Netatmo OAuth onboarding, so no token is ever pasted by hand. |
| `GET /health` | Liveness. |

History range params are epoch milliseconds for the same reason the column is an integer: one
representation per instant. There is no range cap — single user, trusted LAN, accepted.

**Both write endpoints are open on the LAN (2026-08-11), reversing an earlier decision.** The
C# prototype's unauthenticated actuation endpoint was a review finding, and the first build of
this server answered it with a bearer token whose absence meant 503, never open. Removed
knowingly, and the full argument for keeping it was on the table when it went:

- For the **fan endpoint**, the residual attacker on a trusted LAN is a web page inside
  someone's browser — CSRF, which a `text/plain` form body gets past JSON-only parsing, with
  browser private-network blocking only partial — and while the loop is parked nothing pulls a
  hostile 80 back down. What decided it anyway: everything such a caller can do is bounded by
  construction — 20 to 80, never off, never above the grille ceiling — so the harm ceiling is a
  noisy night, accepted by the person who sleeps there.
- The **ingest endpoint** carries the sharper risk of the two, named before it went: a poisoned
  reading outlives its request — it sits in the store, skews history and the calibration week —
  and once the loop is rewired, invented bedroom CO₂ steers the fan from anything on the
  network. Accepted with the same posture, same bounded actuator underneath.

If exposure ever grows beyond the LAN or tailnet, auth returns **at the edge** (a tunnel with
SSO in front of the whole service), not inside this process. There is no `INGEST_TOKEN`; the
SEN66 nodes will POST bare JSON.

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
                        windows, thresholds — all `as const`. RoomId and SensorId
                        are derived from it, so a typo is a compile error.
  domain/
    measurement.ts      MeasurementKind, Reading
    level.ts            Level, CommandedLevel, narrowing, one step up/down
    signal.ts           RoomSignal — fresh | stale | missing
    decision.ts         Snapshot, Decision, ControlOutcome
    precedence.ts       PURE. (room, kind, readings, now) -> winning RoomSignal.
                        Shared by the controller and /api/state — one rule.
  sources/
    source.ts           SensorSource interface
    synthetic.ts        plausible CO₂ curves on a schedule, so `npm start` runs
                        without hardware. A demo, not a plant model. Never runs
                        beside a real source — same source ids, real database.
    collector.ts        poll -> store, each source on its own cadence. The
                        loop's first step, extracted while the loop is parked.
    netatmo.ts          pull adapter: OAuth refresh, gethomecoachsdata.
                        fetch is injected the way OpenStream is in modbus-tcp.
    netatmo-token.ts    the rotating refresh token, as a file on disk —
                        deliberately not a database row. See "Configuration".
    tado.ts             pull adapter                          (not built yet)
  ingest/
    http.ts             batch validation and storage for POST /api/readings;
                        the route itself lives in http/server.ts
  store/
    readings.ts         node:sqlite; append-only, no pruning path exists yet.
                        The only table there is.
  control/              policy, limiter and the loop are PARKED — built, tested,
                        not wired; see the section up top. freshness stays live:
                        /api/state judges readings through it via precedence.
    freshness.ts        PURE. reading + now + per-source window -> RoomSignal
    policy.ts           PURE. snapshot -> desired Level + sleeping + reasons
    limiter.ts          PURE. decision + current + last-change -> ControlOutcome
    loop.ts             orchestration: poll -> store -> decide -> actuate.
                        Owns the only mutable state there is, and exposes the
                        last decision through state() for /api/state.
  actuator/
    unit.ts             VentilationUnit interface
    modbus-tcp.ts       real implementation, FC3 + FC6
    fake.ts             test double, records calls
  http/
    server.ts           the read API, POST /api/unit/level, netatmo onboarding
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

   **When every source is stale, report the most recently measured one** (Q3). Precedence encodes
   trust, and trust is what matters while a choice between *live* instruments exists. Once nothing
   is fresh there is no such choice, only the question of what the best remaining information is —
   and that is the newest reading, not the most trusted dead one.
2. **Sleep detection. Quiet hours assert it; bedroom CO₂ only extends it.**

   ```
   sleeping = inQuietHours(now) || (wasSleeping && bedroomCo2 is fresh && bedroomCo2 > SLEEP_CO2)
   ```

   `wasSleeping` is the previous cycle's value, held in memory. Nothing else asserts sleep.

   **Why the CO₂ term is an extender and not an assertion.** Asserting on CO₂ alone self-latches.
   The band puts level 50 at roughly 900 ppm, so *any* CO₂ high enough to demand more than 50 has
   already crossed 700 and capped the response at 50 — the demand signal and the occupancy signal
   are the same number, and the one silences the other. With the bedroom door open, an ordinary
   busy evening drives bedroom CO₂ past 700 with nobody in bed, and the flat is then pinned at 50
   with no way to earn its way out. As an extender the term cannot false-trigger, because it
   requires having already been asleep.

   **What the term is for**, and it is worth keeping for exactly this: the cap must lift when the
   room clears, not when the clock strikes. Keyed to the clock alone, the level would jump at
   07:00 into a bedroom where people are still asleep. Two independent reviewers found that
   regression by reasoning, and it is the one behaviour the scripted traces exist to pin.

   The bedroom is never merely occupied in this flat — nobody sits in it — which is what makes
   CO₂ readable as *still asleep* at all. That is a fact about this flat, not a general principle.
   If the room's use changes, delete the clause.

   **Two accepted losses, both consequences of the extender form:**
   - **An afternoon nap gets no cap.** Sleep was not already asserted, so nothing extends. Someone
     napping at 15:00 can hear the unit at up to 80.
   - **A restart while asleep after 07:00 drops the cap.** `wasSleeping` starts false, quiet hours
     have ended, so the extender cannot re-latch until 22:00.

   Quiet hours is the sensor-independent guarantee underneath all of this: a dead Netatmo can
   never let the unit run loud at 3am, because that path does not consult a sensor at all.

   The open-window case is not covered either — someone asleep with the window open clears below
   700 and loses the cap. Accepted: an open window already admits more noise than the unit makes.
3. **Demand — a proportional band.** Highest fresh CO₂ across all rooms drives the target; worst
   room wins. Stale and missing readings are excluded entirely, **in both directions**: a stale low
   reading is never treated as good air, and a stale high one never pins the unit at the ceiling.

   ```
   frac   = clamp((co2 - C_LO) / (C_HI - C_LO), 0, 1)
   target = quantise(MIN_LEVEL + frac * (MAX_COMMANDED_LEVEL - MIN_LEVEL))
   ```

   with `C_LO = 550`, `C_HI = 1250`. A straight line from 20% at 550 ppm to 80% at 1250, quantised
   to the seven legal steps. No integral term, no accumulated state.
4. **No fresh CO₂ anywhere** → fall back to `safeDefaultLevel` (config, default 40). Moderate
   continuous ventilation is the safe answer when blind: quieter than boosting, safer than idling.
   **Never fall back to the minimum.**
5. **Hysteresis at each step boundary.** To move up, CO₂ must be `CO2_HYSTERESIS` (60 ppm) past the
   boundary; to move down, the same below it. Implemented by biasing the reading in the direction
   of travel and re-quantising, rather than as a separate state machine.

   This replaces an earlier "boost above 800, release below 650" band, which was a *binary*
   trigger dressed as a deadband and contradicted the proportional curve specified two lines
   above it. One mechanism now, not two.
6. **Sleep cap.** The whole cap lives in `limiter.ts`, in one place, and it is applied to **where
   the unit is**, not only to a newly computed target:

   ```
   cap    = sleeping ? sleepMaxLevel : MAX_COMMANDED_LEVEL
   if current > cap  -> command cap now, in one move
   target = min(desired, cap)
   ```

   Three properties, all of which matter:
   - **`policy.ts` never applies the cap.** It reports demand and whether we are asleep, and the
     limiter clamps. One rule, one place — a cap applied in both modules is two mechanisms that
     have to agree.
   - **It bypasses the rate limit.** A unit at 70 when quiet hours begin drops to 50 immediately,
     in one move. Evening cooking leaving it at 70 must not run all night because demand sat
     mid-range and produced no new target. A hard requirement does not wait on a rate limiter.
   - **It does not update `lastChangeAt`.** Otherwise the drop at 22:00 also starts a fresh dwell,
     and the genuine walk down that follows it is delayed by ten minutes for no reason.
7. **Rate limit — asymmetric. Only decreases are limited.**
   - **Increases apply immediately, at any distance.** Demand at 80 from a current 20 commands 80
     on that cycle.
   - **Decreases move one step per `minDwellMinutes` (10 min).** The slow retreat is what stops
     CO₂ crashing and rebounding into the next boost, and it is the damper that keeps a
     mis-sized band degrading into slow drift rather than a square wave.
   - The sleep cap in step 6 is **not** a decrease for this purpose. It is immediate and unlimited.

   **This is the only timing rule in the controller.** An earlier revision had two — a dwell that
   gated every change, plus a separate one-step-per-90s limit on increases — and they overlapped
   on the down side while contradicting each other on the up side. There is now one clock:
   *how long since the level last changed*, consulted only when going down.

   Bounding increases was argued for on noise grounds: a step change in fan speed is more
   noticeable than a ramp to the same level. That is true and it is given up knowingly. It bought
   a four-and-a-half-minute climb from 20 to 80 at the cost of a second timer, a second config
   value, and a rule that reads as symmetric while behaving asymmetrically. **Up is the direction
   where the air is already bad**; making it wait is the wrong instinct even when it is quieter.
   If the ramp turns out to be audibly necessary, it comes back as one line in the limiter —
   not as a second timing concept.

   What must *not* come back is the version with no limit in either direction. With only an input
   deadband, demand crossing 800 slammed 20 → 80, the unit pulled CO₂ under 650 inside one dwell,
   and it slammed back to 20 — a square wave with roughly a twenty-minute period, which is
   precisely the behaviour this project exists to eliminate. The one-step-per-dwell *decrease* is
   what kills that, and it is retained.

   The confusion that produced that gap is worth recording, because the two rules sound alike and
   are opposites: *"must differ by more than one step to change at all"* creates a dead zone and
   was rightly removed (Q2); *"may move at most one step per change"* is rate limiting and is what
   was actually needed. Removing the first was mistaken for having the second.

   **The decrease interval must be at least as long as the slowest CO₂ source's refresh
   interval.** Netatmo updates every 7–8 minutes, so anything shorter would step down again before
   the effect of the last step could possibly be observed. Ten minutes satisfies this; it is a
   constraint, not a coincidence, and it moves if the sensor fleet does.

   **The timer is in memory and resets on restart.** A restart therefore acts immediately, which
   is also what a genuine first run does (Q4). See "Data model" for why the table that used to
   persist it is gone.
8. **Clamp** to a valid `CommandedLevel` — floor 20, ceiling `MAX_COMMANDED_LEVEL` (80). The type
   does this at compile time; `assertCommandedLevel` does it at runtime for anything crossing a
   boundary, because type stripping performs no checking at all.
9. **Read the unit's actual level back every tick** (FC3, already verified). It is surfaced next to
   the desired level in `/api/state` and logged when the two disagree, which is how a wall-panel
   change becomes visible.

   **It is acted on in one case only:** if the unit is above `sleepMaxLevel` while sleep is
   asserted, that level is passed to the limiter in place of our own, and step 6's cap path pulls
   it back in one move. Everything else is reported and left alone. See the actuator section for
   why this is the position rather than always or never.

**On steps 3, 5 and 7 together:** the band's *width* sets the loop gain and is what makes
convergence provable; hysteresis stops boundary chatter; the one-step-per-dwell decrease stops the
swing and is the backstop if the band turns out too narrow. The band is doing the real work.

## Why this control law, in plain terms

Written out because it has to be explained aloud, and the vocabulary is worse than the idea.

**The proportional band** is a straight line: 20% at 550 ppm, 80% at 1250 ppm, read off the line
in between. The 700 ppm span is the "band". A wider band means a gentler reaction to the same
change in CO₂.

**The failure it prevents, without the maths.** It is a shower with a long pipe. The water is
cold, so you turn the tap up hard. Nothing happens — the pipe is long — so you turn it further.
Then scalding water arrives and you crank it back. Freezing again. You weave between extremes, and
the harder you react the worse it gets.

Two fixes, and they are the two things in this controller: **smaller adjustments per unit of
wrongness** (that is the band width) and **wait before adjusting again** (that is dwell).

In one sentence: **if the fan reacts more strongly than its own action changes things, it chases
its own tail.**

**How wide is wide enough.** The fan can only hold CO₂ somewhere between a floor (at level 80) and
a ceiling (at level 20). That span is its *authority*. A band narrower than the authority means
driving the fan end to end moves CO₂ further than the band covers, so it slams between extremes.

> **The band must be at least as wide as the CO₂ swing the fan can actually produce.**

Worked illustration, using *assumed* airflow of 80 m³/h at level 20 and 260 at level 80, four
occupants. Start deliberately wrong at level 70:

| Fan at | CO₂ settles at | Line says |
|---|---|---|
| 70 | 746 | 37 |
| 37 | 1010 | 58 |
| 58 | 810 | 42 |
| 42 | 940 | 53 |
| 53 | 840 | 45 |
| 45 | 900 | 50 |
| 50 | 861 | 47 |
| | | ≈ **48**, settled |

Each swing is smaller than the last. That ratio — fan movement against CO₂ movement — is the
**loop gain**; here it is 0.72. Below 1 converges, above 1 grows into oscillation.

**Read that table as an illustration of the mechanism, not as a measurement of this flat.** See
the next section for what is actually known.

This is also why the commercial 200 ppm band does not transfer. An office VAV damper has enormous
airflow authority relative to its zone, so one step barely moves CO₂. A restricted HRV in a small
flat moves it a lot, and at 200 ppm the loop gain here would be several times 1 — a guaranteed
limit cycle with roughly an hour period.

## What is actually known about this flat, and what is not

**Flat volume does not affect the band.** Steady-state CO₂ is `outdoor + generation ÷ airflow`;
volume does not appear. 58 m² × 2.55 m ≈ **148 m³** sets how *fast* the room responds — a time
constant of roughly 35 minutes to 3 hours depending on level — not where it settles. An earlier
revision cited a 200 m³ figure as though it mattered to the band. It never did.

**What does matter is the airflow range and the occupancy**, and occupancy dominates. The unit is
a **2VV Daphne HRDA2-030**, nominally around 300 m³/h — but that is a test-rig figure at zero
external pressure. Real ducting plus the restricted intake grille could plausibly halve it, and
nobody has measured it.

Authority across the plausible corners:

| | 2 people | 4 people |
|---|---|---|
| Optimistic install (70 → 220 m³/h) | ~350 ppm | ~690 ppm |
| Restricted install (45 → 140 m³/h) | ~540 ppm | ~1070 ppm |

**So authority is somewhere between roughly 350 and 1100 ppm, and the 700 ppm band sits in the
middle of that range.** At the restricted-install, four-occupant corner the pure loop gain would
be about 1.5 — the hunting condition.

**Why that is tolerable rather than alarming.** The loop-gain argument assumes the controller
jumps straight to its computed target each round. This one cannot: decreases move one step per
dwell. That rate limit is a damper the gain analysis does not model, so where the band turns out
too narrow the failure degrades into slow drift with mild overshoot rather than a square wave.
The band handles stability when it is sized right; the rate limiter is the backstop when it is not.

**How this gets resolved properly.** Two steps, in order:

1. **Ship the estimate and instrument it.** The band is a middle bet across that range. Scripted
   trace tests cover the controller's *sequence* behaviour, which needs no plant parameters at all;
   convergence is the one question they cannot answer, and it is the one question that genuinely
   needs the plant measured.
2. **Measure it after a week of logs.** CO₂ settling points at several levels give real airflow and
   real authority, the band is recomputed from observation, and a calibrated plant model becomes
   worth building. Every assumption above then drops out.

   Sweeping a simulator across guessed corners was considered and rejected: it would prove the
   controller settles in an imaginary flat, which is easy to mistake for validation.

If the restricted corner turns out to be real, four people may keep CO₂ above ~900 ppm even at
level 80. The unit will sit pinned at the ceiling, and that is correct behaviour — a capacity
problem, not a control one, which is what the pinned-at-ceiling diagnostic exists to surface.

**Droop is intentional.** The unit settles wherever ventilation balances CO₂ production — inside
the band, not at a target number. ASHRAE's framing is that CO₂ is a **limit, not a setpoint**:
maximum ventilation when CO₂ reaches the maximum, proportionally less below. Chasing an exact
value is what an integral term does, and here it would solve a non-problem while winding itself up
on Netatmo's repeated readings.

**Provenance.** This is ASHRAE Guideline 36's P-only DCV sequence with Trim-and-Respond-style
asymmetry, not something invented here. Guideline 36 Addendum q (2024) specifies P-only for CO₂
and states the reason: CO₂ is a limit to stay under, not a value to oscillate around. Hysteresis
of 50–100 ppm at switching points is standard practice (Honeywell Jade uses 100). The one place
this design departs from commercial convention is band width, for the reason set out above.

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
Q1–Q4 are decided and folded into the control logic above. Q6 concerns only the ingest endpoint
and is deferred with it.

The plan also records **F1–F6**, the findings from an independent review run before any code
existed — two agents, one given only the requirements, one given the decisions with all reasoning
stripped. Three of the six changed the control logic materially, and one of those was fatal.

The pure modules are written **test-first** — `freshness`, `precedence`, `policy`, `limiter`.
Adapters are tested after, against fakes, because their shape is not knowable until the real
protocol has been spoken.

**Some tests are traces.** A hand-written series of `(minute, co2)` pairs plus a clock, fed to
**the real control loop** — through a real source, a real SQLite store and the recording fake unit
— asserting on the *sequence* of commands rather than on one decision. No physics: it says "here
is a CO₂ trace, here is what the service does". That is what catches bugs which only exist across
time — the cap releasing too early, a square wave, flutter at a step boundary.

**The harness drives `createControlLoop` rather than calling `policy` and `limiter` itself**, and
that is not a detail. An earlier version threaded `currentLevel`, `lastChangeAt` and `wasSleeping`
in the test file, which made it a second copy of the loop's state machine — one that stayed green
while the real one was broken. The overnight trace exists to catch the 07:00 regression and did
not notice when the loop stopped carrying `wasSleeping` at all. **Wiring that the tests
re-implement is wiring that is not tested.**

Driving the real loop also means the fake unit is right there, so a trace can make writes fail for
an hour and see what the loop does across the outage. That is what pins the loop's update
ordering, which nothing else can reach.

**A closed-loop plant model is deliberately deferred**, not omitted. It would answer whether the
loop converges, which a scripted trace structurally cannot. But every parameter it needs — airflow
per level, each room's share, transfer through open doors — is currently a guess, so it would
prove the controller settles in an imaginary flat. Its precondition is a week of logged settling
points. Build it then, with the band recomputation it enables. See `docs/test-plan.md`.

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
variables and are never committed. One secret cannot live there:

**The Netatmo refresh token lives in a file** (`data/netatmo-token.json`, `NETATMO_TOKEN_PATH`
to move it), because Netatmo **rotates** it on every refresh — the reference worker observed
this live against this device, it is not caution. Something mutable has to hold the current one,
and the two other candidates lose: an environment variable cannot be rewritten by a running
process, and the database gave up its last mutable row on purpose when `control_state` was cut —
a credentials row would quietly re-spend that, and would put a live secret inside every database
backup besides. The file is written atomically (temp + rename, mode 0600), the new token is
persisted **before** the new access token is used (a crash in between must cost a poll, not the
credential), and the adapter re-reads the file on every refresh, so a re-authorisation through
`/auth/netatmo` takes effect without a restart. Cost, accepted: one more file to back up beside
the database, and a secret unencrypted on disk — which `.env` already is. A corrupt file throws
rather than falling back to the environment seed: the seed is stale after the first rotation,
and silently using it is a lockout dressed as a fallback.

Access-token expiry is deliberately not tracked. The token is used until Netatmo answers 401,
then refreshed and the request retried once — that path has to exist anyway, and a timer doing
the same job would be a second mechanism. The price is one wasted request every ~3 hours.

**The Netatmo poll interval is 5 minutes, from an inequality rather than taste.** A reading is
up to one vendor refresh (≤ 8 min) old when fetched, plus up to one poll interval older before
the next fetch. Against the 15-minute freshness window the interval must stay under 7 minutes,
or a healthy instrument periodically reads as stale through our own polling.

Starting defaults, all to be tuned against reality:

| Setting | Default | |
|---|---|---|
| `C_LO` — band bottom, level 20 | 550 ppm | **derived** |
| `C_HI` — band top, level 80 | 1250 ppm | **derived** |
| `CO2_HYSTERESIS` | 60 ppm | derived (≈ ½ step) |
| `SLEEP_CO2` — bedroom, *extends* sleep | 700 ppm | tune |
| Quiet hours, and the zone they are read in | 22:00–07:00, `Europe/Prague` | tune |
| Sleep max level | 50 | tune |
| Safe default level (no data) | 40 | tune |
| `minDwellMinutes` — one step down | 10 minutes | tune, floor ≥ 8 min |
| Control evaluation interval | 30 s | tune |
| `MIN_LEVEL` | 20 | **physical** |
| `MAX_COMMANDED_LEVEL` | 80 | **physical** |

The last two are **not tuning knobs.** 20 is what the unit does; 80 is what the intake grille in
this flat allows. Everything above is a preference to be adjusted against real readings; these two
describe the world and should only change if the hardware does.

**The band is sized by a rule, not tuned by feel** — but the number it produces is currently an
estimate, not a measurement. `C_HI − C_LO` must be at least the CO₂ swing the unit can produce
between level 20 and level 80 at design occupancy, or loop gain exceeds 1 and it hunts no matter
how much hysteresis is added. That swing is somewhere between ~350 and ~1100 ppm for this flat
(see "What is actually known" above), so 700 is a middle bet validated by a sensitivity sweep
rather than a derived certainty. `C_HI = 1250` also matches EN 16798-1 Category II (800 ppm above
outdoors). `CO2_HYSTERESIS` follows from the band: step width is 700/6 ≈ 117 ppm, and half a step
is the conventional size.

**Recompute the band from logged data once a week of readings exists.** Settling points at several
levels give real airflow and real authority, which replaces every assumption behind the 700.

**Minimum dwell has a floor**, not just a default: it may never be set below the slowest CO₂
source's refresh interval (8 minutes for Netatmo). Below that the controller steps down again
before it can observe the last step.

**Quiet hours carry an explicit IANA time zone.** Reading the hour out of the host's local time
would make the tests depend on the machine they run on, and would silently shift the night cap by
an hour twice a year if the host were ever UTC. `Europe/Prague` is where the flat is; the
conversion goes through `Intl.DateTimeFormat`, which handles the DST transitions for free.

**One diagnostic, built:** CO₂ above `C_HI` + 10% for more than 10 minutes while pinned at the
ceiling → log it. That is a capacity problem (or the intake grille), not something the controller
can fix by trying harder, and ASHRAE Guideline 36 specifies it. It is the only piece of state in
the loop that is not the control decision itself.

**It repeats once per ten-minute window while the condition lasts**, and the ten minutes start
again from the moment it clears. An earlier draft said "log it once", which is what an alarm does
when it is trying not to be noisy — but this one is not noisy next to 120 decision lines an hour,
and a single line eight hours ago does not tell you the flat is *still* out of capacity. Latching
it would also have cost a second piece of state next to `pinnedSince` purely to remember that we
had already spoken. One variable, and an alarm that behaves like an alarm.

**One diagnostic, built with the ingest endpoint it belongs to:** any reading **below 300 ppm** is a
probable calibration fault — NDIR sensors self-calibrate by assuming they periodically see outdoor
air, and a flat that never gets down to outdoor CO₂ will drift, shifting the whole band. That is a
check on readings as they arrive, so it belongs in the ingest endpoint, which is not built.

`SLEEP_CO2` at 700 ppm rests on a fact about this flat — the bedroom is never merely occupied, so
CO₂ above 700 there means someone is *still* asleep. It only extends a sleep that quiet hours
already asserted; see the control logic for why it may not assert one on its own.

---

## Open questions

These are unresolved. Do not invent answers — ask.

1. **The rest of the Daphne register map.** Fan speed at wire 21001 is confirmed twice over — by
   the spikes and by this client driving the real unit.

   The "contradiction" in the old comments is softer than it looked, having now read them properly.
   The block is `// This is always -1 against documentation. / 21002 = fan speed (400 = 40 %) /
   21002 = temperature`. The first two lines agree: "21002 = fan speed" is *documentation*
   numbering, which the −1 rule turns into wire 21001 — exactly what the code writes and what
   works. Only the third line is odd, and it reads either as a typo for 21003 or as a switch to
   wire numbering. **Both readings collapse to the same physical claim: the register immediately
   after fan speed is temperature.** That is inference from a comment, not evidence from code —
   no spike ever reads any register but 21001.

   **One FC3 read of wire 21002 settles it.** A value near 200–250 means temperature at ×10; a
   value tracking the fan level means the note was wrong.

   **Register 14000 remains pure hearsay.** It appears in a comment, in no code, attached to
   nothing that was ever probed, and its claim of "direct addressing" contradicts the word
   "always" two lines above it. The offset machinery those comments discuss was never even
   implemented — the spike assigns `modbusAddress = register` and prints them as equal. Treat the
   comments as research notes rather than findings: **no global −1 rule may be assumed**, and every
   new register gets probed individually — read both N and N−1 and see which answers sensibly.
2. **Does the unit accept only multiples of 10, or does it round?** We only ever write valid
   `Level` values, so this is a curiosity rather than a risk — but worth knowing when reading
   back a level the wall panel set.
3. **Exact CO₂ thresholds.** Defaults above are guesses and need tuning against real readings.
4. **Push authentication — decided (2026-08-11): none.** Every endpoint is open on the trusted
   LAN; the acceptance and its bounds are recorded in the read-API section. If exposure ever
   grows beyond the LAN or tailnet, auth arrives at the edge, in front of the whole service.

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
