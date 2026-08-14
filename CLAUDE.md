# microclimate

A service that collects readings from the sensors in my flat, stores them, exposes them over a
small JSON API, and sets the HRV (heat-recovery ventilation) unit's fan level over Modbus when
asked to.

**It is a collection platform.** Long term this is where home metrics live: automations will read
from the same store, and a dashboard will be built on top. That shapes the data model —
provenance, timestamps and units are designed for a reader that does not exist yet — but it does
**not** license building a rule engine, a plugin system, or an automation registry.

**Legibility is a requirement, not a nicety.** Someone should be able to read this cold and come
away with an accurate picture of it. Small, obvious, well-tested, defensible line by line. If a
change makes the codebase harder to explain to someone coming to it fresh, it is the wrong change.

---

## Where reasoning lives

One argument, one home. A `why` written in two places drifts, and the copy that goes stale is
never the one you are looking at.

| | |
|---|---|
| **Code comment** | The constraint an edit *at this line* would violate. Must be within eyeshot of what it defends. |
| **This document** | Rules, decisions that span files, and measurements that cost a live session to get. |
| **README** | What it is and how to run it. |
| **Git** | What it used to be. |

Before writing a sentence anywhere, apply the deletion test: *if I cut this, what wrong thing
becomes possible?* No answer, no sentence.

---

## The automation comes later — the service collects, a human drives

Nothing automatic moves the fan. `main.ts` runs collection (sources → store), the read API, and
one write endpoint; the fan is driven by the wall panel or by `POST /api/unit/level`. The service
adds observability, not protection — a hand-set 80 at 23:30 runs all night.

**An automation driving the fan from CO₂ is intended, and must not be built until the data
exists.** How much air the unit moves in this flat, and therefore how CO₂ responds to a level
change, has never been measured; an automation tuned by guesses is not something to let drive the
flat. A first implementation was written and removed rather than shipped — the last commit
carrying it is
[`a75fba3`](https://github.com/marektresnak/microclimate/tree/a75fba33d1969e072f918b45944595cb0659f160)
(`src/control/` and its tests).

**This phase gathers the missing data.** Manual control over the API is the instrument: hold a
level, watch CO₂ settle, log it — the service log records every level set over the API next to the
CO₂ curve it explains. When a stretch of real readings exists, the automation returns as a pure
function reading from the same store. The collector is its polling step already in place.

---

## The review contract

I review every line and must be able to explain it without notes. Code that is clever, generic, or
written for a requirement we do not have fails review even if it works.

**Hard rules:**

- **No `any`.** Not in source, not in tests. `unknown` plus a narrowing function instead.
- **No new dependencies** without asking me first, with a reason.
- **No classes** unless the thing genuinely owns mutable state. Prefer plain functions and
  modules. Dependencies are passed as ordinary function parameters — no DI container, no
  decorators, no service locator.
- **No `enum`, no `namespace`, no parameter properties.** Node strips types at runtime rather than
  compiling, so these do not exist for us. `as const` unions instead of enums. Enforced by
  `erasableSyntaxOnly` in `tsconfig.json`, not left to discipline.
- **Type-only imports must say `import type`.** Same reason.
- **Explicit return types on every exported function.**
- **No type-level cleverness.** Conditional types, mapped types, generic gymnastics and branded
  types are all rejected. Plain interfaces and discriminated unions cover everything here.
- **Comments explain *why*, never *what*.** A comment restating the code is noise. A comment
  recording a constraint or a failure we are defending against is the point.

### Readable over compact

Write idiomatic TypeScript and stop there. The test for any line is whether it can be **narrated
out loud** — if explaining it takes a paragraph, it is wrong however elegant it looks.

- **Name the intermediate steps.** A chain read right-to-left gets broken into named `const`s.
- **No nested ternaries.** One level is fine for a genuine either/or. Two is a rewrite.
- **Early returns over nested `if`.** The happy path is the least-indented code in the function.
- **A `for...of` loop is not a failure.** Reach for `reduce` when the operation genuinely is a
  fold, not to avoid writing a loop.
- **Do not split functions to hit a line count.** One coherent 40-line function beats four
  10-line ones with invented names and a call graph to trace.
- **`?.` and `??` are good; a five-link optional chain is not.** If absence is meaningful, handle
  it explicitly.
- **No abbreviated identifiers.** `bedroomSignal`, not `bdSig`.
- **Keep destructuring simple.** Renames, defaults and nesting in one pattern is a puzzle.

Not idiomatic *here*, however common elsewhere: classes with inheritance, decorators, getters that
do work, point-free style, currying, heavy functional composition.

**Working style:** build one module at a time, with its tests, and stop. Do not scaffold five files
ahead. I review each before the next starts.

---

## Runtime and dependencies

**Node 26 or later, and it must be an official nodejs.org build** (developed on 26.7.0 via nvm;
`.nvmrc` says so). Chosen so that four things need no flags and no build step:

- `node:sqlite` is built in — no `better-sqlite3`, therefore no native compilation.
- TypeScript type-stripping is native — no `tsc` build, no bundler. `tsc` is used only for
  `--noEmit`. TypeScript 6, the first line whose `lib` knows Temporal.
- `node:test` + `node:assert/strict` — no vitest, no jest.
- **`Temporal` is built in.** Every instant in the domain is a `Temporal.Instant` and every tunable
  span a `Temporal.Duration`, so an instant, a duration and a fan level are three different types
  rather than three numbers.

**The build matters, not only the version.** Homebrew compiles its node without Temporal (it
conflicts with their shared ICU library), so `src/temporal-guard.ts` — the first import in
`main.ts` — refuses to start with a sentence naming the fix instead of dying on a bare
`ReferenceError`.

**`npm test` runs `tsc --noEmit` first, and that is not a convenience.** Type stripping deletes the
types without ever checking them, so nothing at runtime enforces `CommandedLevel` — and
`CommandedLevel` is the entire guard against commanding 90 or 100 into a restricted intake grille.
A suite that runs green without a typecheck would not notice the guard had gone.

**The guard is narrowed once, at the edge, and nowhere else.** `POST /api/unit/level` is the only
way a level enters this process from outside, and `assertCommandedLevel` stands there. Do not add
a second check at the Modbus write site: two runtime checks of one value is two places to keep in
agreement, and one type whose signature says `CommandedLevel` while its body says it does not
believe it.

Runtime dependencies: **two** — `hono` and `@hono/node-server`, for the HTTP layer. Both are pure
JavaScript with no transitive dependencies, no native code and no install scripts; the adapter
exists only because Hono speaks web-standard Request/Response and Node does not. The bar for any
further dependency: something I would have to defend line by line, admitted only when it absorbs
boilerplate rather than decisions. That is why the framework stops at routing, body plumbing and
the onboarding pages' HTML escaping, while every narrowing, the OAuth state and the precedence rule
remain this project's own code.

Everything else is built in: `fetch`, `node:http` underneath the adapter, `node:sqlite`,
`node:test`.

**Modbus is hand-rolled**, not a library. We need exactly two function codes against a documented
register map. A general Modbus library is several thousand lines of protocol we do not use. The
minimal client is ~100 lines, fully testable against a fake socket, and is a better thing to read.

---

## The physical setup

Three rooms. Sensors are pulled from vendor APIs today; custom nodes will push later.

| Room | Sensors today | Planned |
|---|---|---|
| `living_room` | 1× Tado valve (temperature, humidity) | SEN66 |
| `kids_room` | 2× Tado valve on two radiators — **one zone, one reading** | SEN66 |
| `bedroom` | 1× Tado valve + Netatmo Home Coach (temperature, humidity, **CO₂**) | SEN66 |

- **Tado** — pull adapter, ported from `~/dev/tado-monitor` (mine, polling this same account).
  Temperature and humidity **per zone, not per valve**: a zone reports one `sensorDataPoints`, so
  the readable instrument is the zone and the kids' room's two valves are one reading.

  Auth is the RFC 8628 device flow and **there is no client secret** — the client id is public and
  hardcoded in the adapter. Tado removed the password grant on 2025-03-04, so this is not one
  option among several. `/auth/tado` runs it.

  **Access tokens live 10 minutes and the refresh token is single-use**, so refreshing is the hot
  path here — roughly every tenth poll, where Netatmo's is a three-hourly event. A lost rotation is
  a lockout within the hour.

  **A healthy reading can be 20 minutes old.** A valve measures every minute, but the published
  value only moves when a reading crosses a threshold (~0.5 °C or 5 %RH), with a 20-minute
  heartbeat regardless. The 25-minute freshness window is derived from that; the derivation is at
  the constant in `config.ts`.

  **One poll is one request for the whole flat**: `GET /homes/{id}/zoneStates`, after a one-time
  discovery of the home id and the zone list.
- **Netatmo Home Coach** — pull, OAuth refresh flow, `gethomecoachsdata`. Temperature, humidity,
  CO₂. Reference: `~/dev/netatmo-sync` (mine, working). **Netatmo only refreshes every 7–8 minutes
  on their side.** Polling it faster gains nothing.
- **SEN66** — Sensirion nine-in-one node (PM1, PM2.5, PM4, PM10, temperature, humidity, VOC index,
  NOx index, CO₂) over I²C behind an ESP32, pushing JSON to us. Not built yet; the ingest endpoint
  and a simulator script stand in.
- **Tado thermostats are read-only to us.** We collect their values. We never control heating.

**Because sources publish at wildly different rates, freshness is per-source, not global.** A
20-minute-old Tado reading is healthy — that is its heartbeat — while a Netatmo that has said
nothing for 20 minutes has missed two refreshes and is not. One global staleness window cannot
judge both, in either direction. This is a load-bearing design constraint, not a detail.

---

## The actuator

A **2VV Daphne** HRV unit with heat recovery, controlled over **Modbus TCP**.

- Power is a discrete level: **20, 30, 40, … 100 percent**, in steps of 10.
- **20 is the floor** — a device limit. The unit is never turned off.
- **80 is the ceiling** — an *installation* limit. The intake grille in this flat cannot pass
  enough air above roughly 80%, so running higher makes the fan work against a restriction: noisy,
  inefficient, and it unbalances supply against extract on a heat-recovery unit. The device would
  accept 90 and 100. **We never send them.**
- There is a wall panel, and **the service never undoes a change made there**: nothing automatic
  moves the fan, so the panel and the API are two hands on the same dial. A panel change is
  *visible* — `GET /api/unit/level` reads the unit live — but not recorded, because nothing polls
  the unit.

**Protocol details**, every one confirmed against the real unit:

| | |
|---|---|
| Address | `192.168.0.65:502` |
| Unit / slave id | `1` |
| Fan-speed register | **21001** on the wire |
| Value encoding | percent × 10 — `400` means 40% |
| Set | FC6, write single register |
| Read back | FC3, read holding registers |
| Timeouts | 5 s per attempt, 3 retries, 250 ms between |

**The register is 21001, not the 21002 the documentation gives.** The usual Modbus convention
clash: documentation numbers registers from 1, the wire numbers them from 0. **This is not a bug
and must not be "corrected".** A comment at the call site says so.

The timing numbers are chosen in `main.ts` and argued at the constants there. Two properties they
have to keep: the 5 seconds is one budget per attempt covering *connecting as well as answering*,
and the pause between attempts is long enough that a retry is genuinely a second try.

Because FC3 reads back successfully, **the current level is observable**, which is how a wall-panel
change stays visible.

Because the readable and commandable ranges genuinely differ, they are two types:

```ts
// What the unit can report. A wall-panel user can put it at 90 or 100.
export type Level = 20 | 30 | 40 | 50 | 60 | 70 | 80 | 90 | 100;

// What we are ever allowed to send. See the intake-grille limit above.
export type CommandedLevel = 20 | 30 | 40 | 50 | 60 | 70 | 80;
```

`CommandedLevel` is assignable to `Level` with no conversion, so `read()` returns `Level` and
`set()` accepts only `CommandedLevel`. **Commanding 90 is a compile error, not a runtime check
someone has to remember to write.**

Both are plain literal unions — anything arriving from outside goes through a narrowing function.

---

## Data model and storage

**One table of readings.** Every reading is a fact that was true at a point in time, from a named
instrument. (The service log is a second table, below.)

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
directions and **no epoch millisecond is visible anywhere in it**. Between the two edges the code
carries `Temporal.Instant` and `Temporal.Duration`. `domain/time.ts` is the whole wire conversion;
the store modules hold the only `epochMilliseconds` conversions, at the SQL boundary.

**`measured_at` and `received_at` are never conflated.** Netatmo readings arrive minutes after they
were taken, and a push node replaying a buffered backlog can deliver hours-old readings in one
request. Collapsing the two makes historical graphs quietly wrong and makes staleness detection
impossible — **freshness is always judged on `measured_at`**.

**IDs are TEXT, not integer foreign keys.** Roughly 20 MB across the raw table, buying a `SELECT *`
that is readable without a join. At this scale that is the right trade.

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
only CO₂ will drive the unit. Collection is the point of the system — do not "optimise" the unused
kinds away.

**Every table is append-only. There is no mutable row in the database at all.** A row is written
once, so nothing in the file can be half-updated and any backup is consistent by construction. The
property is load-bearing: the one thing that genuinely must mutate — each vendor's refresh token —
lives in a file precisely so the database does not have to give this up.

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

Two conventions make that safe for historical data:

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

## Ingest

`POST /api/readings` accepts a **batch**: one request carrying many readings, each with its own
`measuredAt`. A SEN66 node reports nine measurements per cycle and must not make nine requests, and
a node that buffered through a network outage replays its backlog with the original timestamps
intact.

`measuredAt` is an ISO 8601 instant with an explicit zone — the same grammar the range params take
and the responses emit. **Epoch milliseconds are refused rather than guessed at**, so a node left
on old firmware fails loudly instead of looking healthy while storing nothing.

**Validate timestamps in one direction only: reject the future**, beyond about five minutes of
clock skew. A node reporting 2106 would otherwise look eternally fresh and poison every decision
downstream. The reject names the instant back — a node has to find the fault in its own clock, and
its clock reads in dates.

**Any past timestamp is accepted.** Rejecting old readings would discard exactly the buffered
backlog that batching exists to carry: a node offline for twelve hours replays around 1,300
batches, and any window shorter than the outage throws them all away. The past-side check also buys
nothing, because `INSERT OR IGNORE` already makes replay idempotent at any age.

Three rules the endpoint keeps:

- **One bad reading does not sink the batch.** The valid readings land; each reject is reported
  with its index and reason. A node cannot fix a bad reading by resending it, so failing the batch
  holds eight good readings hostage to one bad one, forever. For the same reason the response is
  **200 whenever the batch was processed**, verdicts inside — a status a simple node reads as
  "retry" would have it replaying poison until the end of time.
- **A valid kind the instrument does not declare is rejected**, not stored: `bedroom_netatmo`
  claiming `pm2_5` is a wrong sourceId in node firmware, and storing it files one instrument's data
  under another's name, permanently.
- **A CO₂ reading below 300 ppm is logged, never rejected.** NDIR sensors self-calibrate by
  assuming they periodically see outdoor air; a flat that never gets down to outdoor CO₂ will
  drift. A drifted instrument is still reporting real air with a shifted zero, and the low reading
  is the evidence of the fault — discarding it would hide the diagnosis.

## The read API

| Endpoint | Shape |
|---|---|
| `GET /api/state` | **Room-level.** One value per `(room, kind)`, each naming its source and freshness. |
| `GET /api/rooms/:room/readings` | Room-level history — sources expanded from config, inactive ones included, `?from=&to=` (default last 24 h), `?kind=` to filter. |
| `GET /api/sensors` | The config topology, so a client can interpret ids without reading files. |
| `GET /api/sensors/:id/readings` | Per-instrument detail. |
| `GET /api/logs` | The service log — the same lines stdout gets, `?from=&to=` (default last 24 h). |
| `GET /api/unit/level` | The fan's actual level, read live over Modbus. |
| `POST /api/unit/level` | Sets the fan. `assertCommandedLevel` refuses 90 and 100. |
| `POST /api/readings` | Batch ingest for the push nodes. |
| `GET /auth/netatmo` (+ `/callback`) | Netatmo OAuth onboarding, so no token is pasted by hand. |
| `GET /auth/tado` | Tado device-flow onboarding. One route, no callback. |
| `GET /health` | Liveness. |

**Every instant in this API is an ISO 8601 string, in and out. Epoch milliseconds never appear.**

- **Out: always UTC, always milliseconds** — `2026-08-12T09:36:00.000Z`, byte for byte what the
  `measured_at_iso` generated column computes. Reading the database by hand and reading the API
  give the same string.
- **In: an ISO 8601 instant with an explicit zone**, `Z` or an offset. An offset is accepted and
  normalised, so replay stays idempotent across two spellings of one moment and a node whose clock
  reads in local time is not made to convert. The grammar is `Temporal.Instant.from`'s (RFC 9557),
  so a space or lowercase separator, a bracketed zone annotation and the compact form all parse,
  and sub-millisecond fractions truncate to the millisecond the store thinks in.
- **A zone-less timestamp is refused**, not guessed at. It would mean different instants on the
  server and on the machine that sent it, and would shift by an hour twice a year besides. A bare
  date is refused for the same reason: one rule, spelled out in the error.
- **A date that does not exist is refused.** Temporal rejects `2026-02-31` outright. Do not retreat
  to `Date.parse`, which rolls an impossible day forward into March; tests pin the rejections.
- **Ranges are half-open: `from` is included, `to` is not.** Half-open windows are the only kind
  that tile — a client walking `00:00–06:00, 06:00–12:00` sees a reading measured exactly at 06:00
  once. Counting it in both windows is the same quiet poison the ingest dedup exists to keep out.

There is no range cap — single user, trusted LAN, accepted.

**`/api/state` reports `status` and `measuredAt`, and no age.** The freshness judgement is made
here, against that source's own window and this server's clock. Handing the client an age invites a
second judgement against a clock that may not agree with ours, and two answers to one question is
one too many. Anyone who wants to plot the gap has `measuredAt`.

**Both write endpoints are open on the LAN, knowingly. Do not add auth inside this process, and do
not report its absence as a finding.** The acceptance:

- For the **fan endpoint**, the residual attacker on a trusted LAN is a web page inside someone's
  browser — CSRF, which a `text/plain` form body gets past JSON-only parsing — and nothing pulls a
  hostile 80 back down. Everything such a caller can do is bounded by construction: 20 to 80, never
  off, never above the grille ceiling. The harm ceiling is a noisy night, accepted by the person
  who sleeps there.
- The **ingest endpoint** carries the sharper risk: a poisoned reading outlives its request — it
  sits in the store, skews history and the measurement campaign — and the day an automation drives
  the fan from CO₂, invented bedroom readings steer it from anything on the network. Accepted with
  the same posture, same bounded actuator underneath.

If exposure ever grows beyond the LAN or tailnet, auth returns **at the edge** (a tunnel with SSO
in front of the whole service), not inside this process. There is no `INGEST_TOKEN`; the SEN66
nodes POST bare JSON.

**Room-level values are resolved by one precedence function**, `domain/precedence.ts`. Every
consumer, present and future, reads through the same rule, so two views disagreeing is impossible
by construction rather than by discipline.

**Never average two instruments.** Precedence is an ordered list per `(room, kind)` and the first
fresh source wins. The bedroom has two instruments reporting temperature and humidity — the Tado
valve head sits on the radiator and reads warm, the Netatmo Home Coach stands across the room — and
a mean describes neither.

## Architecture

```
src/
  config.ts             SOLE source of truth for topology: rooms, sensors
                        (with isActive), per-(room, kind) precedence, freshness
                        windows, the Tado zone map — all `as const`. RoomId and
                        SensorId are derived from it, so a typo is a compile
                        error.
  domain/
    measurement.ts      MeasurementKind, Reading
    level.ts            Level, CommandedLevel, narrowing
    signal.ts           RoomSignal — fresh | stale | missing
    freshness.ts        PURE. reading + now + per-source window -> RoomSignal
    time.ts             PURE. the ISO 8601 the API speaks <-> the
                        Temporal.Instant the domain carries. Two functions.
    precedence.ts       PURE. (room, kind, readings, now) -> winning RoomSignal.
                        The one rule for what a room currently says.
  sources/
    source.ts           the two seams an adapter is built from: the
                        SensorSource interface, and FetchLike — `fetch` as a
                        parameter. Neither belongs to a vendor.
    collector.ts        poll -> store, each source on its own cadence.
    netatmo.ts          pull adapter: OAuth refresh, gethomecoachsdata.
                        Defines NetatmoSettings.
    refresh-token-file.ts
                        a rotating refresh token, as a file on disk —
                        deliberately not a database row. One file per vendor,
                        named by the caller.
    tado.ts             pull adapter: device-flow refresh, then one bulk read
                        of every zone's state per poll. Defines TadoSettings,
                        which is also Tado's on-switch.
  ingest/
    http.ts             batch validation and storage for POST /api/readings;
                        the route itself lives in http/server.ts
  store/
    logs.ts             the service log behind GET /api/logs — append-only,
                        level-less.
    readings.ts         node:sqlite; append-only, no pruning path exists yet.
  actuator/
    unit.ts             VentilationUnit interface
    modbus-tcp.ts       real implementation, FC3 + FC6
    fake.ts             test double, records calls
  http/
    server.ts           the read API, POST /api/unit/level, the ingest route —
                        uniform JSON, no vendor imports
    netatmo-auth.ts     the /auth/netatmo onboarding pair, mounted whole by
                        server.ts — the HTTP layer's human-facing half: its
                        only HTML, its only mutable value (the OAuth state)
                        and its only outbound fetch
    tado-auth.ts        the /auth/tado onboarding route — ONE route, because
                        the device flow has no callback.
  temporal-guard.ts     refuses a runtime without Temporal, as main.ts's first
                        import.
  main.ts               wiring only
tests/
```

**`precedence.ts`, `freshness.ts` and `time.ts` are pure and contain the interesting reasoning.**
No IO, no clock reads, no database. Time arrives as a parameter, which is what makes them testable
without hardware, and they are where to start reading.

## Growth without a framework

Automations are coming, and a dashboard will be built on this. Neither justifies infrastructure
now. The seams that make growth additive already exist:

- An automation is a pure function over a snapshot of readings and a timestamp.
- Actuators sit behind an interface. A second device is a second adapter.
- Readings are `(source, room, kind, value, time)`. A new sensor is config plus an adapter.
- The store answers range queries. A dashboard is a read endpoint, not a schema change.

So: **no rule engine, no plugin loader, no automation registry, no event bus.** When an automation
arrives, write the function. If a third and fourth follow and a real pattern emerges, abstract
*then*, against evidence.

## Testing

**The case list is the suite itself.** Test names are written to be read as sentences, and the
reasoning behind a case is a comment above that case, where it cannot drift from the assertion it
explains. [`docs/test-plan.md`](docs/test-plan.md) carries what a suite cannot: the per-module
strategy, the conventions, the cases deliberately removed, and what is not tested at all.

The pure modules are written **test-first** — `freshness`, `precedence`, `time`. Adapters are
tested after, against fakes, because their shape is not knowable until the real protocol has been
spoken.

`node:test` + `node:assert/strict`. No framework.

- **Time is injected**, never read from a clock inside logic. `now` arrives as a
  `Temporal.Instant` parameter; only `main.ts` calls `Temporal.Now.instant()`.
- **`assertDeepEqual` is the only deep assertion, and a test enforces it.** A `Temporal.Instant`
  keeps its state in internal slots, which `assert.deepEqual` cannot see — two *different* instants
  compare as deeply equal, so a wrong timestamp passes silently, the one way this suite could go
  green while checking nothing. The wrapper in `tests/support/deep-equal.ts` writes instants out as
  ISO strings first and passes everything else through untouched, so the rule is total rather than
  a judgement about which shapes carry an instant. `tests/conventions.test.ts` scans the suite and
  fails on any bare `assert.deepEqual`. Raw `epochMilliseconds` appears only where the number
  itself is the contract: the truncation tests, the vendor's seconds-to-milliseconds conversion,
  and the raw-SQL schema tests.
- **Fakes, not mocks.** `actuator/fake.ts` records the levels it was told to set. Sources are plain
  functions returning canned readings.
- **The cases that matter** are the failure ones: a sensor going stale mid-run, Netatmo
  unreachable, a reading exactly on a freshness boundary, a Modbus write timing out, a batch with
  one poisoned reading.

## Configuration

`config.ts` is the sole source of truth for **topology**: rooms; sensors with their room, kinds,
`isActive` flag and freshness window; per-`(room, kind)` precedence order; and `TADO_ZONES`. All
`as const`, so ids are literal union types and a typo is a compile error. Every time span in it is
a `Temporal.Duration`, so the unit travels with the type instead of living in an `Ms` suffix. Spans
become numbers again only at the platform's door — `setTimeout`, `AbortSignal.timeout` — one
`total()` call at the top of the module that owns the timer.

It also carries **`TIME_ZONE`**, the flat's IANA zone (`Europe/Prague`): anything that needs a
local hour reads it from there, so behaviour never depends on how the host's clock is configured.
Temporal handles the DST transitions; a fixed offset would not.

Secrets — Netatmo's OAuth app, the Modbus host — come from environment variables and are never
committed. Tado has no secret to keep. What neither vendor's credential can do is live in the
environment:

**Each vendor's refresh token lives in a file** — `data/netatmo-token.json` and
`data/tado-token.json`, moved with `NETATMO_TOKEN_PATH` and `TADO_TOKEN_PATH`, both through
`sources/refresh-token-file.ts` — because **both vendors rotate it on every refresh**. Something
mutable has to hold the current one, and the two other candidates lose: an environment variable
cannot be rewritten by a running process, and the database is append-only with no mutable row in
it, on purpose — a credentials row would quietly spend that property, and would put a live secret
inside every database backup besides. The file is written atomically (temp + rename, mode 0600),
the new token is persisted **before** the new access token is used, and each adapter re-reads its
file on every refresh, so a re-authorisation takes effect without a restart. Cost, accepted: two
more files to back up, and a secret unencrypted on disk — which `.env` already is.

**`TADO_TOKEN_PATH` is also Tado's on-switch**, since there is no credential in the environment to
key on. Keyed on the *variable* rather than on whether the file exists, deliberately — a token file
that has gone missing must fail loudly at every poll and point at `/auth/tado`, not quietly go
silent while looking healthy. One switch per vendor, and they are independent: with only Netatmo
configured the Tado rooms simply read `missing`, which is the honest answer.

**Access-token expiry is deliberately not tracked for either vendor.** The token is used until the
vendor refuses it, then refreshed and the request retried once — that path has to exist anyway, and
a timer doing the same job would be a second mechanism. The price is one wasted request per token
lifetime. What the refusal looks like is a measured fact rather than a convention for both of them;
each adapter states its own at the constant.

**Both poll intervals come from an inequality rather than from taste.** A reading is up to one
vendor publishing interval old when fetched, plus up to one poll interval older before the next
fetch, and the sum has to fit inside that source's freshness window. For Netatmo: ≤ 8 min refresh
against a 15-minute window, so the interval must stay under 7 — it is 5. For Tado: a 20-minute
heartbeat against a 25-minute window, so the interval must stay under 5 — it is 1, because a
threshold crossing should be seen promptly and the dedup constraint absorbs the repeats for free.

**Two numbers describe the world rather than configure the service: 20 and 80.** The floor is what
the unit does; the ceiling is what the intake grille allows. They live in the `Level` and
`CommandedLevel` types and change only if the hardware does.

---

## Measured against the real thing

Facts that cost a live session with hardware or a vendor account. Everything here was observed,
not inferred; that is why it is recorded rather than left to the code.

| Date | What | Result |
|---|---|---|
| 2026-08-11 | Daphne, end to end | Read 50%, wrote 70%, read back 70%, wrote 50%, read back 50% — first attempt. Framing, transaction ids, register 21001 and the ×10 encoding all confirmed. |
| 2026-08-11 | Fresh TCP connection per request | Ten consecutive connections, 6–11 ms each, no refusals. The risk was a cheap embedded stack accepting one session and holding a dead one open. |
| 2026-08-11 | Connect timeout | Deleting it made a test take exactly 75 seconds — the OS default for an address that stops answering SYNs. Connecting needs its own bound inside the attempt budget. |
| 2026-08-14 | Netatmo expired access token | HTTP **403** carrying Netatmo's own `error.code` **3** — not the 401 an OAuth API is usually assumed to answer with. Both halves are checked because both were observed. A 403 with any other code is a permission and is not retried. |
| 2026-08-14 | Tado expired/absent access token | Plain **401**, all three variants (absent, garbage, expired). Status alone triggers refresh-and-retry; no body is read. A 403 is a permission and is reported as itself. |
| 2026-08-14 | Tado refresh-and-retry, live | Ran through a token expiry at 08:13: one 401, one refresh, one retry, no log line, no missed reading, rotated token on disk behind it. |
| 2026-08-14 | Tado `zoneStates` envelope | `{"zoneStates": {"1": {…}, "2": {…}, "5": {…}}}`, keyed by zone id as a string, byte for byte the same state a per-zone `/zones/{id}/state` returns. One request for the whole flat. |
| 2026-08-14 | Tado zone ids | Read from `GET /homes/1819708/zones`. Not consecutive: 2 living room, 5 kids' room, 1 bedroom. |
| 2026-08-14 | Tado `link.state` | The real value is `ONLINE`. Nothing reads the field — see `tado.ts` for why. |
| 2026-08-14 | Tado publication gaps | 6 to 19.7 minutes across three zones over 45 minutes. The 20-minute heartbeat holds as the upper bound, which is what the 25-minute window was sized against. |
| 2026-08-14 | Tado per-zone stamps | Three zones stamped 07:41, 07:46 and 07:52 in one answer. Temperature and humidity share one stamp within a zone; the adapter still keeps each field's own. |

---

## Open questions

These are unresolved. Do not invent answers — ask.

1. **The rest of the Daphne register map.** Fan speed at wire 21001 is confirmed. Every other
   register is unprobed.

   The −1 against documentation is demonstrated for exactly **one** register, so **no global −1
   rule may be assumed**. Every new register gets probed individually: read both N and N−1 and see
   which answers sensibly.

   There is a loose claim that **the register immediately after fan speed is temperature**, and it
   is inference rather than evidence. **One FC3 read of wire 21002 settles it.** A value near
   200–250 means temperature at ×10; a value tracking the fan level means the claim was wrong.

   **Register 14000 is pure hearsay** — a number attached to nothing that was ever probed, and its
   claim of "direct addressing" contradicts the −1 rule besides. It is a research note, not a
   finding.
2. **Does the unit accept only multiples of 10, or does it round?** We only ever write valid
   `Level` values, so this is a curiosity rather than a risk — but worth knowing when reading back
   a level the wall panel set.
3. **What a Tado `HOT_WATER` zone's `sensorDataPoints` looks like.** This account has no such zone
   to ask.

---

## Out of scope — deliberately

Stated so the gaps read as decisions rather than omissions:

- **The CO₂ automation.** Intended, previously implemented, removed until real data exists to
  design it against.
- **Docker.** Comes later; the service runs on a home server eventually.
- **Charts and UI.** JSON endpoints only.
- **Controlling heating.** Tado keeps that. We read its sensors and nothing more.
- **Users, auth, multi-home.** Single home, single occupant-operator, trusted LAN.
- **Retention, downsampling, rollups.** Designed and costed above, not built. Nothing prunes.
- **A `rooms` / `sensors` table.** Topology is config-only, on purpose.
- **Runtime topology changes.** Adding a sensor is a config edit and a restart, not an API call.
