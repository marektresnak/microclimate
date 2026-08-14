# microclimate

A service that collects readings from the sensors in my flat, stores them, exposes them over a
small JSON API, and sets the HRV (heat-recovery ventilation) unit's fan level over Modbus when
asked to.

**It is a collection platform.** Long term this is where home metrics live: automations will
read from the same store — the first one, driving the HRV from CO₂, is planned and not yet
built (see "The automation comes later" below) — and a dashboard will be built on top. That
shapes the data model — provenance, timestamps and units are designed for a reader that does
not exist yet — but it does **not** license building a rule engine, a plugin system, or an
automation registry. See "Growth without a framework" below.

**This is also a job-application work sample.** A reviewer should be able to read it and form an
opinion in 15–30 minutes. That sets the bar for everything below: small, obvious, well-tested,
and defensible line by line. If a change makes the codebase harder to explain to someone reading
it cold, it is the wrong change.

---

## The automation comes later — the service collects, a human drives

Nothing automatic moves the fan. `main.ts` runs collection (sources → store), the read API, and
one write endpoint; the fan is driven by the wall panel or by `POST /api/unit/level`, and the
service adds observability, not protection — a hand-set 80 at 23:30 runs all night, exactly as
it would have before this service existed.

**The intention is that an automation will drive the fan from CO₂**, and a first implementation
existed: a proportional controller with its own polling loop, built test-first and green. It
was removed rather than shipped, because every number it depended on was an assumption — how
much air the unit actually moves in this flat, and therefore how CO₂ responds to a level
change, has never been measured, and an automation tuned by guesses is not something to let
drive the flat. Git is the attic, not the working tree: **the last commit carrying that
implementation is [`a75fba3`](https://github.com/marektresnak/microclimate/tree/a75fba33d1969e072f918b45944595cb0659f160)**
(`src/control/`, its tests, and the documentation sections that reasoned it out).

**This phase gathers the data that was missing.** Manual control over the API is the
instrument: hold a level, watch CO₂ settle, log it — the service log records every level set
over the API next to the CO₂ curve it explains. When a stretch of real readings exists, the
automation returns designed against measurement rather than assumption, as a pure function
reading from the same store. The collector is its polling step already in place.

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

**Node 26 or later, and it must be an official nodejs.org build** (developed on 26.7.0 via nvm;
`.nvmrc` says so). Chosen so that four things need no flags and no build step:

- `node:sqlite` is built in — no `better-sqlite3`, therefore no native compilation.
- TypeScript type-stripping is native — no `tsc` build, no bundler. `tsc` is used only for
  `--noEmit` typechecking. TypeScript 6, bumped from 5.9 on 2026-08-12 because 6 is the first
  line whose `lib` knows Temporal.
- `node:test` + `node:assert/strict` — no vitest, no jest.
- **`Temporal` is built in** (adopted 2026-08-12): every instant in the domain is a
  `Temporal.Instant` and every tunable span a `Temporal.Duration`, so an instant, a duration and
  a fan level are three different types rather than three numbers. This is what moved the floor
  from 24 to 26 — and it is why the *build* matters, not only the version. Homebrew compiles its
  node without Temporal (it conflicts with their shared ICU library), so `src/temporal-guard.ts`,
  the first import in `main.ts`, refuses to start with a sentence naming the fix instead of dying
  on a bare ReferenceError at the first instant touched. The tests need the same runtime; a
  Temporal-less node fails them loudly but less politely.

**`npm test` runs `tsc --noEmit` first, and that is not a convenience.** Type stripping deletes the
types without ever checking them, so nothing at runtime enforces `CommandedLevel` — and
`CommandedLevel` is the entire guard against commanding 90 or 100 into a restricted intake grille.
A suite that runs green without a typecheck is a suite that would not notice the guard had gone.

**The guard is narrowed once, at the edge, and nowhere else (2026-08-13).** `POST /api/unit/level`
is the only way a level enters this process from outside, and `assertCommandedLevel` stands there —
so by the time a level reaches `VentilationUnit.set()` it has already been checked, and the adapter
and the fake both carried a second assertion that no reachable path could fire. That reversed an
earlier "belt as well as braces" at the Modbus write site. Two runtime checks of one value is two
places to keep in agreement and one type whose signature says `CommandedLevel` while its body says
it does not believe it. The narrowing belongs where the untrusted number arrives, not where the
trusted one leaves.

Runtime dependencies: **two** — `hono` and `@hono/node-server`, admitted 2026-08-12 for the
HTTP layer — `http/server.ts` and the onboarding module it mounts, `http/netatmo-auth.ts` —
after the hand-rolled dispatch kept failing this document's own readability test on re-reading. Both are pure JavaScript with no transitive dependencies, no
native code and no install scripts; the adapter exists only because Hono speaks web-standard
Request/Response and Node does not. The bar for any further dependency is unchanged: something I
would have to defend in an interview, admitted only when it absorbs boilerplate rather than
decisions — which is also why the framework stops at routing, body plumbing and the onboarding
pages' HTML escaping (`hono/html`'s tagged template replaced a hand-rolled escaper on
2026-08-12: it escapes every interpolation by default, so a future edit cannot forget to),
while every narrowing, the OAuth state and the precedence rule remain this project's own code.

Everything else is built in: `fetch`, `node:http` underneath the adapter, `node:sqlite`,
`node:test`. The project held at zero dependencies until the day it stopped being the cheapest
way to be readable, and that history is in git.

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
| `kids_room` | 2× Tado valve on two radiators — **one zone, one reading** (temperature, humidity) | SEN66 |
| `bedroom` | 1× Tado valve + Netatmo Home Coach (temperature, humidity, **CO₂**) | SEN66 |

- **Tado** — pull, **built 2026-08-14**, ported from `~/dev/tado-monitor/src/tado-client.ts`
  (mine, polling this same account today). Temperature and humidity **per zone, not per valve**:
  a zone reports one `sensorDataPoints`, from whichever device Tado designates, so the readable
  instrument is the zone and the kids' room's two valves are one reading. Both datapoints carry
  their own timestamp and both are kept.

  **The auth is the RFC 8628 device flow and there is no client secret** — the client id is
  public and hardcoded in the adapter. Tado removed the old password grant on 2025-03-04, so this
  is not one option among several. `/auth/tado` runs it: hand out a code, let a human approve it
  elsewhere, ask again until the answer changes.

  **Access tokens live 10 minutes and the refresh token is single-use** — Tado's own documentation
  says the old one is revoked the moment the new one is issued. So refreshing is the *hot path*
  here, roughly every tenth poll, where Netatmo's is a three-hourly event. The rotation is
  persisted before the new access token is used, as it is for Netatmo, and here a lost rotation is
  a lockout within the hour rather than within the month.

  **The refusal is a plain HTTP 401**, in all three variants measured against the live API on
  2026-08-14. An absent or garbage bearer token answers `{"errors":[{"code":"unauthorized",
  "title":"Full authentication is required to access this resource"}]}`; a token held past its ten
  minutes answers the same status with `"title":"access token is expired"`. So the status alone
  triggers refresh-and-retry-once and no body is read — every variant means the same thing and a
  fresh token is the only fix, while a 403 is a permission and is reported as itself. Measured
  rather than inferred *because* of the Netatmo entry below.

  **The refresh-and-retry path has been watched firing against the live API**, which for a
  ten-minute token is not a rare branch but a thing that happens six times an hour: the service ran
  through its token's expiry at 08:13 on 2026-08-14 and the poll simply succeeded — one 401, one
  refresh, one retry, no log line, no missed reading, and the rotated token in the file behind it.
  That is the risk this vendor carries (a bug here is a lockout within the hour, not the month) and
  it is the one that most needed seeing rather than asserting.

  **The auth parameters ride the query string of a POST with no body at all.** It looks like a
  mistake and it is what the endpoint accepts; the call site says so, and a test pins the absent
  body.

  **A healthy reading can be 20 minutes old.** A valve measures every minute, but the published
  value only moves when a reading crosses a threshold — around 0.5 °C or 5 %RH — with a 20-minute
  heartbeat regardless. That is where the 25-minute freshness window comes from: up to 20 minutes
  old when fetched, plus up to one 1-minute poll interval before the next fetch, so any window
  under 21 minutes calls a healthy instrument stale. It was 90 seconds until the adapter was
  built, a number that assumed a poll produces a fresh value.

  **One poll is one request for the whole flat**: `GET /homes/{id}/zoneStates`, after a one-time
  discovery of the home id and the zone list. Confirmed against the account on 2026-08-14 —
  `{"zoneStates": {"1": {…}, "2": {…}, "5": {…}}}`, keyed by zone id as a string, and byte for byte
  the same state a per-zone `/zones/{id}/state` returns.

  **`link.state` is `ONLINE`, and nothing reads it.** The first build skipped any zone whose link
  was not `CONNECTED` — a value taken from the reference client's type definition, which no real
  answer has ever carried. Every zone in the flat was silently skipped: `tado: 0 readings, 0 new`,
  with no reason given, because a skip is deliberately quiet. Rather than trade one guess for a
  measured constant, the check is gone: the field is the vendor's *second* opinion about freshness,
  and this project already judges freshness on the instant the reading was stamped with — a valve
  that stops reporting keeps re-publishing its last stamp until the window calls the room stale.
  One question, one switch, the same argument that took `isActive` out of `precedence.ts`.

  **Each zone publishes on its own schedule, and both of its datapoints share one stamp.** In the
  measured answer the three zones were stamped 07:41, 07:46 and 07:52 — so a reading 17 minutes old
  is a healthy one, which is the 25-minute window earning its derivation. Temperature and humidity
  carried the *same* instant within each zone, so they are not two clocks in practice; the adapter
  still keeps each field's own stamp, because they are two fields and letting one speak for the
  other would be a rule the payload does not state.

  **Publication gaps measured over 45 minutes: 6 to 19.7 minutes**, across the three zones. The
  20-minute heartbeat holds as the upper bound, which is what the freshness window was derived
  against — a worst case of 19.7 plus a one-minute poll interval, comfortably inside 25.

  **The heartbeat does re-publish an unchanged value, and it is stored.** `bedroom_tado` humidity
  read 38.2 at 07:52:57, 38.3 at 08:12:39 and 38.2 again at 08:30:38: three facts about three
  moments, three rows, because the instrument genuinely spoke three times. The uniqueness
  constraint is on `(source_id, kind, measured_at)` and the instant is what differs, so nothing
  here is a duplicate — this is the dedup rule doing exactly what it says rather than a case it
  fails to catch. It does mean this source's collector line reads "6 readings, 2 new" where
  Netatmo's reads "3 readings, 0 new": a difference in the vendors, not something to fix.

  **A zone with nothing to say is skipped in silence**, and the other zones' readings still land:
  not connected, no sensors, missing from the answer. The report of that gap is `/api/state`
  turning the room stale against its own window, which is what the window is for — where a line
  per skipped zone per poll would be 1,440 a day for one flat battery, saying nothing the state
  endpoint does not say better. The one skip that is *our* mistake rather than the vendor's — a
  zone id the account does not have — is logged once at discovery with the whole zone list beside
  it. A payload that fails to *narrow* is the opposite case and throws the poll away whole.
- **Netatmo Home Coach** — pull, OAuth refresh flow, `gethomecoachsdata`. Temperature, humidity,
  CO₂. Reference: `~/dev/netatmo-sync/src/worker.js` (mine, working). **Netatmo only refreshes
  every 7–8 minutes on their side.** Polling it faster gains nothing.

  **An expired access token comes back as HTTP 403 with Netatmo's own `error.code` 3** — not the
  401 an OAuth API is usually assumed to answer with. Measured against the real API on
  2026-08-14, and it cost something to learn: the first build guessed 401 and its test pinned the
  guess, so the suite ran green while the refresh path could not fire against Netatmo at all, and
  polling died about three hours after every start. The reference worker never met this, which is
  why nothing was mis-ported — it refreshes on every run, so it never holds an access token long
  enough to expire. Both the status and the code are checked because both were observed; the
  reasoning that produced the bug was inferring one of them from how OAuth APIs usually behave.
  A 403 with any other code is reported as itself and not retried — a permission is not something
  a fresh token fixes.
- **SEN66** — Sensirion nine-in-one node (PM1, PM2.5, PM4, PM10, temperature, humidity, VOC
  index, NOx index, CO₂) over I²C behind an ESP32, pushing JSON to us. Not built yet; the
  ingest endpoint and a simulator script stand in.
- **Tado thermostats** are read-only to us. We collect their values. We never control heating.
  That stays entirely with Tado.

**Because sources publish at wildly different rates, freshness is per-source, not global.** A
20-minute-old Tado reading is healthy — that is its heartbeat — while a Netatmo that has said
nothing for 20 minutes has missed two refreshes and is not. One global staleness window cannot
judge both, in either direction. This is a load-bearing design constraint, not a detail.

---

## The actuator

A **2VV Daphne** HRV unit with heat recovery, controlled over **Modbus TCP**.

- Power is a discrete level: **20, 30, 40, … 100 percent**, in steps of 10.
- **20 is the floor** — a device limit. The unit is never turned off.
- **80 is the ceiling** — an *installation* limit, not a device one. The intake grille in this
  flat cannot pass enough air above roughly 80%, so running higher makes the fan work against a
  restriction: noisy, inefficient, and it unbalances supply against extract on a heat-recovery
  unit. The device would accept 90 and 100. **We never send them.**
- There is a wall panel. Someone may change the level by hand, and **the service never undoes
  that**: nothing automatic moves the fan, so the panel and the API are two hands on the same
  dial. A panel change is *visible* — `GET /api/unit/level` reads the unit live over Modbus —
  but it is not recorded anywhere, because nothing polls the unit; the service log records what
  the service was told, not what the panel did.

**Known protocol details**, every one of them confirmed against the real unit:

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

**The client has been verified against the real unit**, not only against a fake stream: on
2026-08-11 it read 50%, wrote 70%, read back 70%, wrote 50% and read back 50%, first attempt.
That run is what the table above rests on — framing, transaction ids, the register number and
the ×10 encoding.

**The 5 seconds covers connecting, not only waiting for an answer.** A read or write timeout
governs an already-established stream, so connecting needs its own bound or it has none: an
address that stops answering SYNs blocks for the operating system's default, about 75 seconds per
attempt, which with retries is minutes against an API caller waiting for the answer. Confirmed by
deleting the connect timeout and watching a test take exactly 75 seconds.

**A fresh TCP connection per request**, rather than holding one open. At the request rates this
will ever see, a persistent socket is state to manage — stale connections, reconnection,
half-open detection — bought with nothing. The risk was that a cheap embedded stack accepts only
one session and holds a dead one open; measured instead of assumed, on 2026-08-11: ten
consecutive fresh connections completed in 6–11 ms each with no refusals.

**The five seconds is one budget per attempt, not one per phase.** Connecting spends from the same
clock as waiting for the answer, so an attempt cannot quietly cost double — and the caller on the
other end of the API is waiting the whole time.

**250 ms between attempts.** Reconnecting the instant a device refuses you is the least likely
attempt to succeed, and four of them inside a millisecond is one attempt wearing a disguise. A
quarter of a second is long enough that a retry is genuinely a second try, and small enough beside
the five-second attempt it follows that the caller does not notice it.

Because FC3 reads back successfully, **the current level is observable**. `GET /api/unit/level`
reads it live, which is how a wall-panel change stays visible.

Because the readable range and the commandable range genuinely differ, they are two types:

```ts
// What the unit can report. A wall-panel user can put it at 90 or 100.
export type Level = 20 | 30 | 40 | 50 | 60 | 70 | 80 | 90 | 100;

// What we are ever allowed to send. See the intake-grille limit above.
export type CommandedLevel = 20 | 30 | 40 | 50 | 60 | 70 | 80;
```

`CommandedLevel` is assignable to `Level` with no conversion, so `VentilationUnit.read()` returns
`Level` and `set()` accepts only `CommandedLevel`. **Commanding 90 is then a compile error, not a
runtime check that someone has to remember to write.**

Both are plain literal unions — anything arriving from outside (config, a Modbus read, a request
body) goes through a narrowing function.

---

## Data model and storage

**One table of readings.** Every reading is a fact that was true at a point in time, from a named
instrument. (The service log keeps a second, append-only table beside it — its own section below.)

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
`WHERE source_id IN (...) AND kind = ? AND measured_at >= ? AND measured_at < ?` — a prefix match
on the UNIQUE constraint's implicit index. Verified:

```
SEARCH readings USING INDEX sqlite_autoindex_readings_1 (source_id=? AND kind=? AND measured_at>?)
```

So **the dedup index doubles as the query index.** No second index, no denormalised column.

**`UNIQUE (source_id, kind, measured_at)` with `INSERT OR IGNORE`.** Push nodes retry, and a
retried batch must be a no-op. Duplicates in a metrics store do not announce themselves; they
surface months later as spikes in a graph. Note the ignore keeps the *first* `received_at`, which
is correct — that is when the reading genuinely first arrived.

**Stored timestamps are integer epoch milliseconds, UTC.** Not ISO text. The reason is narrow and
decisive: `measured_at` is part of a uniqueness constraint, so it must have exactly one
representation per instant. `2026-08-09T13:45:30+02:00` and `2026-08-09T11:45:30Z` are the same
moment and different strings, and the constraint would not catch the duplicate. Integers have one
representation. The `measured_at_iso` generated column costs zero storage — it is computed on
read — and makes `SELECT *` human-readable, so nothing is given up for this.

**That argument is about the column, and it does not reach the wire — or the domain.** The API
speaks ISO 8601 in both directions and **no epoch millisecond is visible anywhere in it**; since
2026-08-12 the code between the two edges carries `Temporal.Instant` for instants and
`Temporal.Duration` for spans, so a timestamp, a window and a fan level are three types the
compiler keeps apart rather than three numbers. `domain/time.ts` is still the whole wire
conversion, two functions; the store modules hold the only `epochMilliseconds` conversions, at
the SQL boundary. Temporal reads nanosecond precision, and `parseInstant` truncates to the
millisecond on the way in — one instant, one representation, from the wire to the column, so the
constraint never meets a sub-millisecond twin of a reading it already holds. What the store keeps
and what the API says are separate decisions, and these are the two places they are allowed to
disagree.

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

**Every table is append-only. There is no mutable row in the database at all.** A row is a fact
about a point in time, written once; nothing in the file can be half-updated, and any backup of
it is consistent by construction. The property is load-bearing: the one thing that genuinely
must mutate — the Netatmo refresh token — lives in a file precisely so the database does not
have to give this up (see "Configuration").

## The service log — the second table, deliberately

Added 2026-08-12 so "what happened last night" is a dashboard question rather than a shell one:
this service is operated from its API, and the log was the one thing still requiring a login to
the machine. Every line the `log` seam carries — poll failures, store failures, ingest verdicts,
fan commands over the API — goes to stdout as before **and**, best-effort, into a `logs` table in
the same database file. `GET /api/logs` serves it back.

- **Append-only, like everything else in the file.** A log line is a fact about a point in time;
  the no-mutable-row property that `control_state` died for is untouched.
- **stdout stays, and the table write is best-effort** — stdout first, a failed insert swallowed.
  When SQLite itself is what is broken (disk full, file locked), the database cannot carry the
  news of its own outage, and a logging failure must never take down the work it was narrating.
- **No severity column.** The lines carry no level today, and a taxonomy invented for a few
  hundred lines a day serves no consumer — a time range and an eye find everything. If a
  dashboard later needs to filter errors, the column arrives together with every call site
  classified, not before. (Decided with the feature, 2026-08-12.)
- **No dedup, no uniqueness constraint.** Nothing retries a log line; two identical lines a
  minute apart are two events, not a duplicate. The range index is therefore explicit, where the
  readings table gets its own free from the dedup constraint. Ties inside one millisecond come
  back in the order they were written — `rowid` breaks them, because the collector can log two
  sources back to back.
- **Nothing prunes it**, consistent with the readings table — tens of megabytes a year at current
  volume. When retention is built it is the easiest target there is, a plain DELETE below a
  cutoff with no rollup to wait for, and it joins the same six-month revisit.

The log is also the durable record of when the fan level changed over the API — `"70% set over
the API"` next to the CO₂ curve it explains, which is half the axis the measurement campaign
needs (see "The automation comes later"). Wall-panel changes stay invisible here: nothing polls
the unit, so the log records what the service did and was told, not what the panel did.

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
`measuredAt`. A SEN66 node reports nine measurements per cycle and must not make nine requests,
and a node that buffered through a network outage replays its backlog with the original
timestamps intact.

`measuredAt` is an ISO 8601 instant with an explicit zone, the same grammar the range params take
and the same one the responses emit — see the read API section for why offsets are accepted and
zone-less strings are not. **Epoch milliseconds are refused rather than guessed at**: it is the
shape this endpoint used to take, and a node left on the old firmware must fail loudly instead of
looking healthy while storing nothing.

**Validate timestamps in one direction only: reject the future**, beyond about five minutes of
clock skew. A node reporting 2106 would otherwise look eternally fresh and poison every decision
downstream. The reject names the instant back — a node has to find the fault in its own clock, and
its clock reads in dates.

**Any past timestamp is accepted.** Rejecting old readings would discard exactly the buffered
backlog that batching exists to carry: a node offline for twelve hours replays around 1,300
batches, and any window shorter than the outage throws them all away — data the system exists to
keep. The past-side check also buys nothing, because `INSERT OR IGNORE` already makes replay
idempotent at any age.

**Built 2026-08-11**, with three decisions folded in as it landed:

- **One bad reading does not sink the batch.** The valid
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
| `GET /api/state` | **Room-level.** One value per `(room, kind)`, each naming its source and freshness. |
| `GET /api/rooms/:room/readings` | Room-level history — sources expanded from config, inactive ones included, `?from=&to=` as ISO 8601 (default last 24 h), `?kind=` to filter. |
| `GET /api/sensors` | The config topology, so a client can interpret ids without reading files. |
| `GET /api/sensors/:id/readings` | Per-instrument detail, when you want to see the raw instrument. |
| `GET /api/logs` | The service log — the same lines stdout gets, `?from=&to=` as ISO 8601 (default last 24 h). Level-less and append-only; see "The service log" in the data-model section. |
| `GET /api/unit/level` | The fan's actual level, read live over Modbus — how a wall-panel change stays visible. |
| `POST /api/unit/level` | Sets the fan. `assertCommandedLevel` refuses 90 and 100. **Deliberately unauthenticated** — see below. |
| `POST /api/readings` | Batch ingest for the push nodes: a JSON array of readings, each with its own ISO 8601 `measuredAt`. Future rejected beyond 5 min of skew, any past accepted, replay idempotent. **Also unauthenticated** — same decision below. |
| `GET /auth/netatmo` (+ `/callback`) | Netatmo OAuth onboarding, so no token is ever pasted by hand. |
| `GET /auth/tado` | Tado device-flow onboarding. One route, no callback: the page shows the code and polls the vendor once per load. |
| `GET /health` | Liveness. |

**Every instant in this API is an ISO 8601 string, in and out. Epoch milliseconds never appear.**
They are how the store keeps `measured_at` unique, which is an argument about a column; a client
reading `2026-08-12T09:36:00.000Z` can see what it is looking at, and `1786527360000` is a number
you have to go and paste somewhere to understand.

- **Out: always UTC, always milliseconds** — `2026-08-12T09:36:00.000Z`, byte for byte what the
  `measured_at_iso` generated column computes. Reading the database by hand and reading the API
  give the same string.
- **In: an ISO 8601 instant with an explicit zone**, `Z` or an offset. An offset is accepted and
  normalised — two spellings of one moment become the same instant at the edge, so replay stays
  idempotent across them, and a node whose clock reads in local time is not made to convert.
  The grammar is `Temporal.Instant.from`'s (RFC 9557) since 2026-08-12, which is wider in
  spelling than the hand-rolled regex it replaced — a space or lowercase separator, a bracketed
  zone annotation, the compact form all parse now, and sub-millisecond fractions truncate to the
  millisecond the store thinks in. Every widened spelling is an unambiguous instant, so the one
  rule survives unchanged: name a moment explicitly or be refused. The tests pin the widening as
  a decision, not an accident.
- **A zone-less timestamp is refused**, not guessed at. `Date.parse` reads `2026-08-12T09:36:00`
  as the *host's* local time, so the same request would mean different instants on the server and
  on the laptop that sent it, and would shift by an hour twice a year besides — exactly the
  machine dependence `TIME_ZONE` exists to refuse. A bare date is refused for the same reason a
  second grammar is: one rule, spelled out in the error.
- **A date that does not exist is refused.** Temporal refuses `2026-02-31` outright. The first
  build had to rebuild the date by hand because `Date.parse` silently rolls an impossible day
  forward into March; that guard is deleted, and the tests keep pinning the rejections so a
  retreat to `Date.parse` would fail loudly.
- **Ranges are half-open: `from` is included, `to` is not** (2026-08-12, on every range endpoint).
  Half-open windows are the only kind that tile — a client walking `00:00–06:00, 06:00–12:00`
  sees a reading measured exactly at 06:00 once. The first build was inclusive on both ends,
  which has no crack for a boundary reading to fall down but counts it in *both* windows, and a
  duplicate in a walked history is the same quiet poison the ingest dedup exists to keep out.

There is no range cap — single user, trusted LAN, accepted.

**`/api/state` reports `status` and `measuredAt`, and no age.** The freshness judgement is made
here, against that source's own window and this server's clock. Handing the client an age invites
it to make a second judgement against a clock that may not agree with ours, and two answers to one
question is one too many. Anyone who wants to plot the gap has `measuredAt`.

**Both write endpoints are open on the LAN (2026-08-11), reversing an earlier decision.** The first
build of this server carried a bearer token whose absence meant 503, never open. Removed knowingly,
and the full argument for keeping it was on the table when it went:

- For the **fan endpoint**, the residual attacker on a trusted LAN is a web page inside
  someone's browser — CSRF, which a `text/plain` form body gets past JSON-only parsing, with
  browser private-network blocking only partial — and nothing pulls a hostile 80 back down.
  What decided it anyway: everything such a caller can do is bounded by construction — 20 to
  80, never off, never above the grille ceiling — so the harm ceiling is a noisy night,
  accepted by the person who sleeps there.
- The **ingest endpoint** carries the sharper risk of the two, named before it went: a poisoned
  reading outlives its request — it sits in the store, skews history and the measurement
  campaign — and the day an automation drives the fan from CO₂, invented bedroom readings
  steer it from anything on the network. Accepted with the same posture, same bounded actuator
  underneath.

If exposure ever grows beyond the LAN or tailnet, auth returns **at the edge** (a tunnel with
SSO in front of the whole service), not inside this process. There is no `INGEST_TOKEN`; the
SEN66 nodes will POST bare JSON.

**Room-level values are resolved by one precedence function**, `domain/precedence.ts`. Every
consumer, present and future — the dashboard, an automation — reads through the same rule, so
two views disagreeing is impossible by construction rather than by discipline.

Each room-level value reports **which sensor it came from and how fresh it is**. The general
overview only needs "bedroom temperature", but the moment a number looks wrong the first question
is which instrument said so, and the answer should already be in the response.

**Never average two instruments.** Precedence is an ordered list per `(room, kind)` and the first
fresh source wins. The bedroom has two instruments reporting temperature and humidity — the Tado
valve head sits on the radiator and reads warm, the Netatmo Home Coach stands across the room —
and a mean describes neither. (The kids' room used to be this example, on the assumption that its
two valves were two readable instruments. They are one Tado zone and one reading; see "The
physical setup".)

## Architecture

```
src/
  config.ts             SOLE source of truth for topology: rooms, sensors
                        (with isActive), per-(room, kind) precedence, freshness
                        windows, the Tado zone map — all `as const`. RoomId and
                        SensorId are derived from it, so a typo is a compile
                        error, in TADO_ZONES as much as in a precedence list.
  domain/
    measurement.ts      MeasurementKind, Reading
    level.ts            Level, CommandedLevel, narrowing
    signal.ts           RoomSignal — fresh | stale | missing
    freshness.ts        PURE. reading + now + per-source window -> RoomSignal
    time.ts             PURE. the ISO 8601 the API speaks <-> the
                        Temporal.Instant the domain carries. Two functions;
                        the store's epoch-ms columns convert inside store/,
                        at the SQL boundary.
    precedence.ts       PURE. (room, kind, readings, now) -> winning RoomSignal.
                        The one rule for what a room currently says.
  sources/
    source.ts           the two seams an adapter is built from: the
                        SensorSource interface, and FetchLike — `fetch` as a
                        parameter. Neither belongs to a vendor, which is why
                        FetchLike stopped living in netatmo.ts (2026-08-14):
                        the Tado adapter was importing the Netatmo one for a
                        type alias.
    collector.ts        poll -> store, each source on its own cadence.
    netatmo.ts          pull adapter: OAuth refresh, gethomecoachsdata.
                        fetch is injected the way OpenStream is in modbus-tcp.
                        Also defines NetatmoSettings — the identity main.ts
                        builds once and hands whole to this adapter AND the
                        onboarding routes, so the two cannot disagree on
                        where the token file lives.
    refresh-token-file.ts
                        a rotating refresh token, as a file on disk —
                        deliberately not a database row. See "Configuration".
                        One file per vendor, named by the caller; it lost the
                        vendor from its name (2026-08-14) when Tado turned out
                        to need the identical thing.
    tado.ts             pull adapter: device-flow refresh, then one bulk read
                        of every zone's state per poll. Defines TadoSettings —
                        the same shared-identity trick as NetatmoSettings, and
                        also Tado's on-switch. fetch injected the same way.
  ingest/
    http.ts             batch validation and storage for POST /api/readings;
                        the route itself lives in http/server.ts
  store/
    logs.ts             the service log behind GET /api/logs — what the `log`
                        seam carries, append-only, level-less. The second
                        table, and the whole of why it exists is in the
                        data-model section.
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
                        the device flow has no callback: the page polls the
                        vendor once per load, driven by a meta refresh at the
                        interval Tado asked for. Mounted the same way.
  temporal-guard.ts     refuses a runtime without Temporal, as main.ts's first
                        import — Homebrew's node compiles it out. See "Runtime
                        and dependencies".
  main.ts               wiring only
tests/
```

**`precedence.ts`, `freshness.ts` and `time.ts` are pure and contain the interesting
reasoning.** No IO, no clock reads, no database. Time arrives as a parameter, which is what
makes them testable without hardware, and they are where a reviewer should start.

`main.ts` does wiring and nothing else.

---

## Growth without a framework

Automations are coming, and a dashboard will be built on this. Neither justifies
infrastructure now.

The seams that make growth additive already exist:

- An automation is a pure function over a snapshot of readings and a timestamp. The first one
  will be exactly that when its data exists; a second is a second function.
- Actuators sit behind an interface. A second device is a second adapter.
- Readings are `(source, room, kind, value, time)`. A new sensor is config plus an adapter.
- The store answers range queries. A dashboard is a read endpoint, not a schema change.

So: **no rule engine, no plugin loader, no automation registry, no event bus.** When an
automation arrives, write the function. If a third and fourth follow and a real pattern
emerges, abstract *then*, against evidence.

A reviewer has twenty minutes and wants to read one thing that works — not scaffolding for five
things that do not.

## Testing

**Full case list: [`docs/test-plan.md`](docs/test-plan.md)** — written before the
implementation, module by module, and kept current as modules land.

The pure modules are written **test-first** — `freshness`, `precedence`, `time`. Adapters are
tested after, against fakes, because their shape is not knowable until the real protocol has
been spoken.

`node:test` + `node:assert/strict`. No framework.

- **Time is injected**, never read from a clock inside logic. `now` arrives as a
  `Temporal.Instant` parameter; only `main.ts` calls `Temporal.Now.instant()`.
- **`assertDeepEqual` is the only deep assertion, and a test enforces it.** A `Temporal.Instant`
  keeps its state in internal slots, which `assert.deepEqual` cannot see — two *different*
  instants compare as deeply equal, so a wrong timestamp passes silently, the one way this suite
  could go green while checking nothing. The project wrapper in `tests/support/deep-equal.ts`
  writes instants out as ISO strings first (so the expected side can simply be the written-out
  string: `assertDeepEqual(row.measuredAt, '2026-08-07T00:00:00Z')`) and passes everything else
  through untouched — a drop-in superset of the bare call. That makes the rule total rather than
  a judgement about which shapes carry an instant, and `tests/conventions.test.ts` scans the
  suite and fails on any bare `assert.deepEqual`, so forgetting is a red build, not a silent
  green. Raw `epochMilliseconds` appears only where the number itself is the contract: the
  millisecond-truncation tests, the vendor's seconds-to-milliseconds conversion, and the raw-SQL
  schema tests.
- **Fakes, not mocks.** `actuator/fake.ts` records the levels it was told to set. Sources are
  plain functions returning canned readings.
- **The cases that matter** are the failure ones: a sensor going stale mid-run, Netatmo
  unreachable, a reading exactly on a freshness boundary, a Modbus write timing out, a batch
  with one poisoned reading.

A reviewer should be able to read the precedence and ingest tests alone and understand what the
system promises.

---

## Configuration

`config.ts` is the sole source of truth for **topology**: rooms; sensors with their room, kinds,
`isActive` flag and freshness window; per-`(room, kind)` precedence order; and `TADO_ZONES`, which
says which Tado zone answers for which sensor id. All `as const`, so
ids are literal union types and a typo is a compile error. Every time span in it — the freshness
windows, the poll intervals — is a `Temporal.Duration` (2026-08-12), so the unit travels with
the type instead of living in an `Ms` suffix. Spans become numbers again only at the platform's
door — `setTimeout`, `AbortSignal.timeout` — one `total()` call at the top of the module that
owns the timer.

It also carries **`TIME_ZONE`**, the flat's IANA zone (`Europe/Prague`): anything that needs a
local hour reads it from there, so behaviour never depends on how the host's clock is configured
and never shifts by an hour twice a year if the host is ever UTC. Temporal handles the DST
transitions; a fixed offset would not.

Secrets — Netatmo's OAuth app, the Modbus host — come from environment variables and are never
committed. Tado has no secret to keep: its device flow has no client secret at all, and the
client id is public. What neither vendor's credential can do is live in the environment:

**Each vendor's refresh token lives in a file** — `data/netatmo-token.json` and
`data/tado-token.json`, moved with `NETATMO_TOKEN_PATH` and `TADO_TOKEN_PATH`, both through the
one `sources/refresh-token-file.ts` — because **both vendors rotate it on every refresh**. For
Netatmo the reference worker observed it live against this device; for Tado the documentation is
explicit that the old token is revoked the instant the new one is issued. Something mutable has to
hold the current one, and the two other candidates lose: an environment variable cannot be
rewritten by a running process, and the database is append-only with no mutable row in it, on
purpose — a credentials row would quietly spend that property, and would put a live secret inside
every database backup besides. The file is written atomically (temp + rename, mode 0600), the new
token is persisted **before** the new access token is used (a crash in between must cost a poll,
not the credential), and each adapter re-reads its file on every refresh, so a re-authorisation
through `/auth/netatmo` or `/auth/tado` takes effect without a restart. Cost, accepted: two more
files to back up beside the database, and a secret unencrypted on disk — which `.env` already is.
A corrupt file throws rather than returning "no token": for Netatmo that would silently fall back
to an environment seed that is stale after the first rotation, and for Tado it would ask for a
fresh authorisation the operator did not know they needed.

**`TADO_TOKEN_PATH` is also Tado's on-switch**, since there is no credential in the environment to
key on: set it and the real valves are polled, unset and they are not. Keyed on the *variable*
rather than on whether the file exists, deliberately — a token file that has gone missing must
fail loudly at every poll and point at `/auth/tado`, not quietly go silent while looking healthy.
One switch per vendor, and they are independent: with only Netatmo configured the Tado rooms
simply read `missing`, which is the honest answer. With neither configured nothing is collected
and nothing stands in — see "No synthetic sources" below.

Access-token expiry is deliberately not tracked for either vendor. The token is used until the
vendor refuses it, then refreshed and the request retried once — that path has to exist anyway,
and a timer doing the same job would be a second mechanism. The price is one wasted request per
token lifetime: every ~3 hours for Netatmo, every 10 minutes for Tado, which is the same argument
holding at a hundred times the rate rather than a different one. What the refusal looks like is a
measured fact rather than a convention for both of them — 403 with code 3, and a plain 401; see
"The physical setup".

**Both poll intervals come from an inequality rather than from taste.** A reading is up to one
vendor publishing interval old when fetched, plus up to one poll interval older before the next
fetch, and the sum has to fit inside that source's freshness window. For Netatmo: ≤ 8 min refresh
against a 15-minute window, so the interval must stay under 7 — it is 5. For Tado: a 20-minute
heartbeat against a 25-minute window, so the interval must stay under 5 — it is 1, because a
threshold crossing should be seen promptly and the dedup constraint absorbs the repeats for free.

**Two numbers describe the world rather than configure the service: 20 and 80.** The floor is
what the unit does; the ceiling is what the intake grille in this flat allows. They live in the
`Level` and `CommandedLevel` types (see "The actuator") and change only if the hardware does.

**One diagnostic, built into the ingest endpoint:** any reading **below 300 ppm** is a probable
calibration fault — NDIR sensors self-calibrate by assuming they periodically see outdoor air,
and a flat that never gets down to outdoor CO₂ will drift, shifting every reading with it. It is
logged, never rejected: a drifted instrument is still reporting real air with a shifted zero,
and the low reading is the evidence of the fault.

---

## Open questions

These are unresolved. Do not invent answers — ask.

1. **The rest of the Daphne register map.** Fan speed at wire 21001 is confirmed, by this client
   driving the real unit. Every other register is unprobed, and nothing here has ever read one.

   The −1 against documentation is demonstrated for exactly **one** register, so **no global −1
   rule may be assumed**. Every new register gets probed individually: read both N and N−1 and
   see which answers sensibly.

   There is a loose claim that **the register immediately after fan speed is temperature**, and
   it is inference rather than evidence. **One FC3 read of wire 21002 settles it.** A value near
   200–250 means temperature at ×10; a value tracking the fan level means the claim was wrong.

   **Register 14000 is pure hearsay** — a number attached to nothing that was ever probed, and
   its claim of "direct addressing" contradicts the −1 rule besides. It is a research note, not
   a finding.
2. **Does the unit accept only multiples of 10, or does it round?** We only ever write valid
   `Level` values, so this is a curiosity rather than a risk — but worth knowing when reading
   back a level the wall panel set.
3. **Push authentication — decided (2026-08-11): none.** Every endpoint is open on the trusted
   LAN; the acceptance and its bounds are recorded in the read-API section. If exposure ever
   grows beyond the LAN or tailnet, auth arrives at the edge, in front of the whole service.

*Tado was the fourth entry here until 2026-08-14, when one authorised session answered all of it —
the zone ids, the `zoneStates` envelope, `link.state`, the expired-token refusal, the publication
gaps and what the heartbeat does to dedup. It is all written up in the Tado entry under "The
physical setup". The only thing left unknown is what a `HOT_WATER` zone's `sensorDataPoints` looks
like, and this account has no such zone to ask.*

---

## Out of scope — deliberately

Stated so the gaps read as decisions rather than omissions:

- **The CO₂ automation.** Intended, previously implemented, removed until real data exists to
  design it against — see "The automation comes later", which carries the pointer to the
  implementation in git.
- **No synthetic sources (removed 2026-08-14).** A pair of them used to stand in while neither
  vendor was configured, so `npm start` demonstrated the whole service on a machine with no
  credentials. Both vendors are configured now and the pair had become unreachable code on the
  only machine that runs this — kept alive for a reviewer who would have to be told they were
  reading invented numbers anyway, and paid for with a module, its tests, a branch in `main.ts`
  and `domain/clock.ts`, which existed for nothing else. The demo was the weaker half of the
  argument: what a reviewer should read is the pure modules and their tests, which say more about
  the design than a curve nobody measured. With no vendor configured the service now collects
  nothing, serves the API, and accepts pushed readings — the same honest silence a half-configured
  service already gave. The last commit carrying them is
  [`ea1713c`](https://github.com/marektresnak/microclimate/tree/ea1713ca3b2c32b15c9ae3a155c1117a60207c1c).
- **Docker.** Comes later; the service runs on a home server eventually.
- **Charts and UI.** JSON endpoints only. A dashboard adds hours and demonstrates nothing for a
  backend sample.
- **Controlling heating.** Tado keeps that. We read its sensors and nothing more.
- **Users, auth, multi-home.** Single home, single occupant-operator, trusted LAN.
- **Retention, downsampling, rollups.** Designed and costed above, not built. Nothing prunes.
- **A `rooms` / `sensors` table.** Topology is config-only, on purpose — see above.
- **Runtime topology changes.** Adding a sensor is a config edit and a restart, not an API call.
