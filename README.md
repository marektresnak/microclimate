# microclimate

Collects readings from the sensors in my flat, stores them, exposes them over a small JSON API,
and sets the HRV (heat-recovery ventilation) unit's fan level over Modbus when asked to.

> **Status.** The collection platform is built and tested — config and domain types, freshness,
> precedence, the SQLite store, the batch ingest endpoint, both pull adapters (Netatmo and Tado)
> with their OAuth onboarding pages, the Modbus TCP client, and the JSON API. What is left is the
> push hardware and the automation; see [Not built yet](#not-built-yet). Both adapters have been
> run against the real vendors, and the Modbus client against the real unit.
>
> **Nothing moves the fan automatically — yet.** An automation driving the unit from CO₂ is the
> intention, and a first implementation existed. It was removed rather than shipped: every
> number it depended on was an assumption about a flat nobody has measured, and this phase
> collects the data that will replace those assumptions. The last commit carrying that
> implementation is
> [`a75fba3`](https://github.com/marektresnak/microclimate/tree/a75fba33d1969e072f918b45944595cb0659f160).
>
> `npm start` serves the API and lets you drive a recording fake unit; set `HRV_MODBUS_HOST` to
> drive the real one. Each vendor has its own switch — the Netatmo credentials, or
> `TADO_TOKEN_PATH` — and only a configured vendor is polled. With neither set the service
> collects nothing and every room reads `missing`: nothing invented stands in, because a stand-in
> would write under the real instruments' ids.

## The problem

Three rooms, sensors from two vendors with completely different refresh rates, one CO₂
instrument, and a ventilation unit that runs at 20–80% in 10% steps. Before anything can drive
that unit well, the flat has to be understood: how fresh each instrument's word is, which
instrument answers for a room, and how the air actually responds when the fan holds a level —
none of which has ever been measured.

So the service does the durable part first. It collects every reading with its provenance and
two timestamps, serves current state and history over JSON, and sets the fan level over Modbus
when asked — which is how the measurement data gets made: hold a level over the API, watch CO₂
settle, and the service log keeps the record of what was set when, next to the curve it
explains.

## Where to look first

A reviewer with twenty minutes should read these, in this order. The first two are pure
functions — time arrives as a parameter, nothing reads a clock or a database:

| | | |
|---|---|---|
| [`src/domain/precedence.ts`](src/domain/precedence.ts) | ~65 lines | which instrument answers for a room |
| [`src/domain/freshness.ts`](src/domain/freshness.ts) | ~35 lines | whether a reading still counts |
| [`src/config.ts`](src/config.ts) | ~145 lines | the whole topology |
| [`src/ingest/http.ts`](src/ingest/http.ts) | ~155 lines | batch ingest: what lands, what is refused, and why |

If you want to see the code that talks to hardware rather than the code that decides, read
[`src/actuator/modbus-tcp.ts`](src/actuator/modbus-tcp.ts) — hand-rolled Modbus TCP, two
function codes against one register, tested byte by byte against a fake stream and verified end
to end against the real unit.

Then the tests, which are meant to read as sentences:

- [`tests/precedence.test.ts`](tests/precedence.test.ts) — who answers for a room, and when
- [`tests/ingest.test.ts`](tests/ingest.test.ts) — what is accepted, refused, and deduplicated,
  and why a replayed backlog is welcome at any age

Around 3,600 lines of source and 3,900 of tests. Two runtime dependencies — `hono` and its Node
adapter, serving the API — admitted late and deliberately; everything else is Node built-ins.

## Four decisions worth knowing before you read

**Freshness is per source, never global.** A 20-minute-old Tado reading is healthy — that is how
often a valve publishes when nothing changes — while a Netatmo silent that long has missed two
refreshes. One staleness window cannot judge both. Freshness is always judged on when the
instrument measured, never on when the reading arrived.

**Two instruments are never averaged.** Precedence is an ordered list per (room, kind) and the
first fresh source wins. The bedroom has a Tado valve head on the radiator and a Netatmo Home
Coach across the room; they disagree by a degree and a half, and a mean belongs to neither. Every
consumer of room-level values resolves them through the same one function, so two views
disagreeing is impossible by construction.

**`measured_at` and `received_at` are never conflated.** Netatmo hands over readings minutes
after taking them, and a push node replaying a buffered backlog delivers hours-old readings in
one request. Collapsing the two would make historical graphs quietly wrong.

**Every instant on the wire is an ISO 8601 string with an explicit zone.** Epoch milliseconds
exist only inside the store, where a uniqueness constraint needs one representation per instant.
A zone-less timestamp is refused rather than guessed at — it would mean different instants on
different machines.

Full reasoning, including what was tried and rejected, is in [`CLAUDE.md`](CLAUDE.md); the case
list is in [`docs/test-plan.md`](docs/test-plan.md).

## Running

Requires **Node 26 or later, and an official nodejs.org build** (developed on 26.7.0 via nvm;
`.nvmrc` says so) — `Temporal` is built in there, and Homebrew's node compiles it out. No build
step otherwise — Node strips the types at runtime and `node:sqlite` is built in, so there is
nothing to compile, native or otherwise. The two runtime dependencies (`hono`,
`@hono/node-server`) are plain JavaScript.

```sh
npm install
npm start                             # fake unit, API on :3000, whichever vendors .env configures
HRV_MODBUS_HOST=192.168.0.65 npm start  # …with the real HRV unit behind the API
```

`npm start` loads `.env` if one exists (`--env-file-if-exists`); variables already exported in
the shell win over the file.

```sh
curl localhost:3000/api/state                       # what every room currently says
curl localhost:3000/api/unit/level                  # where the fan actually is
curl -X POST localhost:3000/api/unit/level \
  -H 'content-type: application/json' -d '{"level":50}'
open http://localhost:3000/auth/netatmo             # one-time Netatmo authorisation
open http://localhost:3000/auth/tado                # one-time Tado authorisation
```

Both onboarding pages exist so no refresh token is ever pasted by hand: each vendor rotates its
token on every refresh, so the file the page writes is the only copy that stays true.

```sh
npm test       # typechecks first, then node:test — no framework
npm run typecheck
```

`npm test` runs `tsc --noEmit` before the suite, and that is not a convenience. Type stripping
deletes the types without checking them, so nothing at runtime enforces `CommandedLevel` — and
`CommandedLevel` is the entire guard against commanding 90% into an intake grille that cannot pass
the air. A suite that runs green without a typecheck would not notice the guard had gone.

## Not built yet

- **The SEN66 push nodes.** The ingest endpoint is live and tested; the hardware is not built.
- **The CO₂ automation.** See the status note up top — it returns designed against real
  readings, and the commit that carries the first implementation is linked there.

## Deliberately out of scope

Docker, any UI or charting, control of the Tado heating (read-only to us), authentication —
every endpoint is open on the trusted LAN, a recorded acceptance in `CLAUDE.md` — and
retention/downsampling — the rollup tier is designed and costed in `CLAUDE.md` but not built,
and until it exists **nothing prunes**.

Sensor topology lives in config rather than the database, on purpose: it gives literal union types
for room and sensor ids, so a typo is a compile error, and git records *why* a sensor moved in a
way a table never could.
