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

One append-only table. Every reading is a fact that was true at a point in time, from a named
instrument.

| Column | Why |
|---|---|
| `source_id` | **Which instrument**, not just which room. The bedroom will have both a Netatmo and a SEN66 reporting CO₂; control needs a precedence rule and the dashboard needs to know which line it is drawing across the changeover. |
| `room_id` | |
| `kind` | Stored as TEXT so a new measurement kind never needs a migration. |
| `value` | REAL, always in the canonical unit for that kind. |
| `measured_at` | When the **instrument** took the reading. |
| `received_at` | When **we** learned about it. |

**`measured_at` and `received_at` are never conflated.** Netatmo readings arrive minutes after
they were taken, and a push node replaying a buffered backlog can deliver hours-old readings in
one request. Collapsing the two makes historical graphs quietly wrong and makes staleness
detection impossible — freshness is judged on `measured_at`.

**Canonical units, fixed:**

| Kind | Unit |
|---|---|
| `temperature` | °C |
| `humidity` | % RH |
| `co2` | ppm |
| `pm1`, `pm2_5`, `pm4`, `pm10` | µg/m³ |
| `voc_index`, `nox_index` | Sensirion index, 1–500 |

Never store a value in anything else. Conversion happens in the adapter, at the edge.

**Index on `(room_id, kind, measured_at)`** — that is the dashboard's access pattern, and adding
it later against tens of millions of rows is a bad afternoon. Expect roughly 100k rows/day once
the SEN66 nodes are in.

**`UNIQUE (source_id, kind, measured_at)`, written with `INSERT OR IGNORE`.** Push nodes retry,
and a retried batch must be a no-op rather than a duplicate. Duplicates in a metrics store do not
announce themselves; they surface months later as spikes in a graph.

**Store everything, control on a subset.** All nine SEN66 measurements are persisted even though
only CO₂ drives the unit. Collection is the point of the system — do not "optimise" the unused
kinds away.

Retention and downsampling are deliberately not built yet. The schema does not prevent them.

## Ingest

`POST /api/readings` accepts a **batch**: one request carrying many readings, each with its own
`measured_at`. A SEN66 node reports nine measurements per cycle and must not make nine requests,
and a node that buffered through a network outage replays its backlog with the original
timestamps intact.

**Validate timestamps.** A node that has not synced NTP will report 1970 or 2106. Reject readings
whose `measured_at` is implausibly far from now (window in config) — one misconfigured device
otherwise poisons both the store and every freshness decision that reads from it.

## Architecture

```
src/
  config.ts             all thresholds, room list, source definitions,
                        per-(room, kind) source precedence — as const
  domain/
    measurement.ts      MeasurementKind, Reading, RoomId
    level.ts            Level + narrowing
    signal.ts           RoomSignal — fresh | stale | missing
    decision.ts         Decision, ControlOutcome
  sources/
    source.ts           SensorSource interface, PollResult
    tado.ts             pull adapter
    netatmo.ts          pull adapter
  ingest/
    http.ts             POST /api/readings — push sensors land here
  store/
    readings.ts         node:sqlite; append-only readings, latest-per-(room,kind) read
  control/
    freshness.ts        readings + now -> RoomSignal, per-source windows
    policy.ts           PURE. snapshot -> desired Level + reasons
    limiter.ts          PURE. desired + current + last-change -> ControlOutcome
    loop.ts             orchestration: poll -> store -> decide -> actuate
  actuator/
    unit.ts             VentilationUnit interface
    modbus-tcp.ts       real implementation, FC3 + FC6
    fake.ts             test double, records calls
  http/
    server.ts           GET /api/state, GET /health
  main.ts               wiring only
tests/
```

**`policy.ts` and `limiter.ts` are pure and contain all the interesting reasoning.** No IO, no
clock reads, no database. Time arrives as a parameter. This is what makes the control logic
testable without hardware, and it is the part of the codebase a reviewer should spend their time
in.

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

Everything tunable lives in `config.ts` as an `as const` object — thresholds, quiet hours, dwell,
room list, per-source freshness windows. Secrets (Tado and Netatmo OAuth, Modbus host) come from
environment variables and are never committed.

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
- **Retention, downsampling, rollups.** Readings are appended and kept. At ~100k rows/day this is
  fine for a long while; the schema does not prevent adding rollups when it stops being fine.
- **Time-range query endpoint.** The store supports it; the endpoint arrives with the dashboard
  that needs it. `/api/state` (current values) is enough for now.
