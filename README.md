# microclimate

A home service for one flat. It reads the temperature, humidity and CO₂ sensors in three rooms,
keeps every reading in a local database, serves the current state and the history over a small
JSON API, and sets the fan level on the flat's ventilation unit over Modbus.

That unit is an HRV — heat-recovery ventilation. It runs continuously, pushing stale air out and
drawing fresh air in through a heat exchanger, so the flat gets fresh air without losing the heat
along with it. Its fan runs at 20–80% in steps of 10, and that dial is the only lever over the air
in here: turn it up and CO₂ should clear faster. By how much, in this flat, nobody has measured.

**The main goal is to automate that dial.** The service should read CO₂, pick a fan level, set it,
and keep doing that without anyone touching the panel. Everything built so far is groundwork for
that loop: every reading kept with its source and its timestamps, one rule for what a room
currently says, and a log of every level that was set. A dashboard over the same data can come
later.

**It is not built yet, on purpose.** An automation needs thresholds: run at this level above that
CO₂ reading. Picking them means knowing how the air in here actually responds, which is the thing
nobody has measured. So the fan is set by hand for now, from the wall panel or
`POST /api/unit/level`, and this phase collects the data those thresholds will come from. A first
version was written and removed instead of shipped, at
[`a75fba3`](https://github.com/marektresnak/microclimate/tree/a75fba33d1969e072f918b45944595cb0659f160).

**Status.** The collection platform is built and tested: config and domain, the SQLite store, the
batch ingest endpoint, both pull adapters with their OAuth onboarding pages, the Modbus TCP client
and the JSON API. Both adapters have been run against the real vendors, and the Modbus client
against the real unit. What is left is the push hardware and the automation.

## Running

Requires **Node 26 or later, and an official nodejs.org build** (developed on 26.7.0 via nvm;
`.nvmrc` says so) — `Temporal` is built in there, and Homebrew's node compiles it out. There is no
build step: Node strips the types at runtime and `node:sqlite` is built in, so there is nothing to
compile, native or otherwise.

```sh
npm install
npm start                               # fake unit, API on :3000, whichever vendors .env configures
HRV_MODBUS_HOST=192.168.0.65 npm start  # …with the real HRV unit behind the API
```

`npm start` loads `.env` if one exists (`--env-file-if-exists`); variables already exported in the
shell win over the file. Each vendor has its own switch — the Netatmo credentials, or
`TADO_TOKEN_PATH` — and only a configured vendor is polled. With neither set the service collects
nothing and every room reads `missing`.

```sh
curl localhost:3000/api/state                       # what every room currently says
curl localhost:3000/api/unit/level                  # where the fan actually is
curl -X POST localhost:3000/api/unit/level \
  -H 'content-type: application/json' -d '{"level":50}'
open http://localhost:3000/auth/netatmo             # one-time Netatmo authorisation
open http://localhost:3000/auth/tado                # one-time Tado authorisation
```

```sh
npm test       # typechecks first, then node:test — no framework
npm run typecheck
```

**Never run `node --test` on its own** — the suite goes green without the typecheck that enforces
`CommandedLevel`. [`CLAUDE.md`](CLAUDE.md) says why.

## Where the rest is written

| | |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | The rules, and the facts that cost a live session with the hardware. |
| [`docs/architecture.md`](docs/architecture.md) | The module map, the two dependencies, and where to start reading. |
| [`docs/sensors.md`](docs/sensors.md) | Both vendors, and where the freshness windows and poll intervals come from. |
| [`docs/storage.md`](docs/storage.md) | The schema, the service log, topology-in-config, the retention design. |
| [`docs/api.md`](docs/api.md) | The endpoints, the wire format, and the ingest and auth arguments. |
| [`docs/test-plan.md`](docs/test-plan.md) | Per-module test strategy and conventions. |
