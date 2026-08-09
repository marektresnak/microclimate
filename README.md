# microclimate

Collects readings from the sensors in my flat, stores them, exposes them over a small JSON API,
and drives the HRV (heat-recovery ventilation) unit based on air quality — primarily CO₂.

> **Status: in progress.** The design is settled and recorded in [`CLAUDE.md`](CLAUDE.md);
> implementation is underway. See *Scope* below for what is deliberately excluded.

Designed as a collection platform, shipped as one complete vertical slice. The store is where
home metrics live long term — further automations will read from it and a dashboard will be built
on top — but the only automation that exists today is ventilation control, and there is
deliberately no rule engine or plugin system waiting for the others.

## The problem

Three rooms, sensors from two vendors with completely different refresh rates, and a ventilation
unit that runs at 20–100% in 10% steps. The unit should keep the air fresh without being audible
in the bedroom at night, and it should settle on a stable power level rather than oscillating
between full boost and idle.

That last requirement is most of the difficulty. Naively recomputing a target from current CO₂
gives you a unit that boosts to 100%, ventilates the room, drops to 20%, lets CO₂ climb, and
boosts again — technically correct, unbearable to live with.

## Design in one paragraph

Sensors sit behind one `SensorSource` interface with two transports: **pull** (Tado and Netatmo,
polled on their own cadences) and **push** (Sensirion SEN66 nodes POSTing batches). Readings are
appended to SQLite, each tagged with the instrument that produced it and with the time it was
*measured* kept separate from the time it was *received* — Netatmo reports minutes late, and a
push node can replay a buffered backlog. Freshness is therefore judged **per source**: a
30-second-old Tado reading and a 6-minute-old Netatmo reading are both fine, and no single global
staleness window can say so. A pure function turns the current snapshot into a desired power
level with its reasoning attached; a second pure function applies a deadband, a night-time cap
and a dwell timer before anything reaches the hardware over Modbus TCP.

The interesting properties are the safety ones: a sensor that goes silent must never read as
"air is fine", and a dead sensor at 3am must never let the unit run loud.

## Running

Requires **Node 24 or later** (developed on 26). No build step — Node strips the types at
runtime, and `node:sqlite` is built in, so there are no native modules to compile and no
runtime dependencies at all.

```sh
npm install
cp .env.example .env   # fill in
npm start
```

```sh
npm test         # node:test, no framework
npm run typecheck
```

## Scope

Deliberately excluded: Docker, any UI or charting, control of the Tado heating (read-only to us),
authentication beyond a shared token on the ingest endpoint, and retention/downsampling — the
rollup tier is designed and costed in [`CLAUDE.md`](CLAUDE.md) but not built, and until it exists
nothing prunes.

Sensor topology lives in config rather than the database, on purpose: it gives literal union
types for room and sensor ids, and git records *why* a sensor moved in a way a table never could.

Full design notes, conventions, and open questions: [`CLAUDE.md`](CLAUDE.md).
