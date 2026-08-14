# Architecture

What the modules are, why there are two dependencies, and why growth needs no framework. The rules
this shape exists to keep — no rule engine, no plugin loader, dependencies passed as ordinary
parameters — are in [`CLAUDE.md`](../CLAUDE.md).

## The module map

```
src/
  config.ts             SOLE source of truth for topology: rooms, sensors
                        (with isActive), per-(room, kind) precedence, freshness
                        windows, the Tado zone map — all `as const`. RoomId and
                        SensorId are derived from it, so a typo is a compile
                        error. Also TIME_ZONE.
  domain/
    measurement.ts      MeasurementKind, Reading
    level.ts            Level, CommandedLevel, narrowing
    signal.ts           RoomSignal — fresh | stale | missing
    freshness.ts        PURE. reading + now + per-source window -> RoomSignal
    time.ts             PURE. the ISO 8601 the API speaks <-> the
                        Temporal.Instant the domain carries. Two functions.
    precedence.ts       PURE. (room, kind, readings, now) -> winning RoomSignal.
                        The one rule for what a room currently says.
    errors.ts           messageOf: `catch` hands you `unknown`, this narrows it
                        to something a log line or an error body can carry.
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
  main.ts               wiring only, and the home of every timing constant
tests/
```

**`precedence.ts`, `freshness.ts` and `time.ts` are pure and contain the interesting reasoning.**
No IO, no clock reads, no database. Time arrives as a parameter, which is what makes them testable
without hardware, and they are where to start reading.

Coming to this cold, that first paragraph is the fastest way in, in this order:

| | |
|---|---|
| [`precedence.ts`](../src/domain/precedence.ts) | which instrument answers for a room |
| [`freshness.ts`](../src/domain/freshness.ts) | whether a reading still counts |
| [`config.ts`](../src/config.ts) | the whole topology |
| [`ingest/http.ts`](../src/ingest/http.ts) | what lands, what is refused, and why |

Then [`tests/precedence.test.ts`](../tests/precedence.test.ts) and
[`tests/ingest.test.ts`](../tests/ingest.test.ts), which are written to read as sentences. For the
code that talks to hardware rather than the code that decides, read
[`actuator/modbus-tcp.ts`](../src/actuator/modbus-tcp.ts) — two function codes against one
register, tested byte by byte against a fake stream and verified against the real unit.

**Room-level values are resolved by one precedence function**, `domain/precedence.ts`. Every
consumer, present and future, reads through the same rule, so two views disagreeing is impossible
by construction rather than by discipline.

## Why there are two dependencies

`hono` and `@hono/node-server`, both admitted late. What cleared them: each is pure JavaScript with
no transitive dependencies, no native code and no install scripts, so the entire supply chain is two
packages small enough to read. The adapter is the second one only because Hono speaks web-standard
`Request`/`Response` and Node does not — `getRequestListener` bridges the two, which is how
`server.ts` still returns an ordinary `node:http` server and nothing that wires or tests it knows a
framework is underneath.

Everything else is a built-in: `fetch`, `node:http`, `node:sqlite`, `node:test`.

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
