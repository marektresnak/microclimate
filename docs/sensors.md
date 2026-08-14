# Sensors and vendors

Where the readings come from, and where the freshness windows and poll intervals in
[`src/config.ts`](../src/config.ts) get their numbers. The rules that follow from this — freshness
is per source, two instruments are never averaged — are in [`CLAUDE.md`](../CLAUDE.md).

## The physical setup

Three rooms. Sensors are pulled from vendor APIs today; custom nodes will push later.

| Room | Sensors today | Planned |
|---|---|---|
| `living_room` | 1× Tado valve (temperature, humidity) | SEN66 |
| `kids_room` | 2× Tado valve on two radiators — **one zone, one reading** | SEN66 |
| `bedroom` | 1× Tado valve + Netatmo Home Coach (temperature, humidity, **CO₂**) | SEN66 |

## Tado

Pull adapter, ported from `~/dev/tado-monitor` (mine, polling this same account).

Temperature and humidity are reported **per zone, not per valve**: a zone reports one
`sensorDataPoints`, so the readable instrument is the zone and the kids' room's two valves are one
reading.

Auth is the RFC 8628 device flow and **there is no client secret** — the client id is public and
hardcoded in the adapter. Tado removed the password grant on 2025-03-04, so this is not one option
among several. `/auth/tado` runs it.

**Access tokens live 10 minutes and the refresh token is single-use**, so refreshing is the hot path
here — roughly every tenth poll, where Netatmo's is a three-hourly event. A lost rotation is a
lockout within the hour.

**A healthy reading can be 20 minutes old.** A valve measures every minute, but the published value
only moves when a reading crosses a threshold (~0.5 °C or 5 %RH), with a 20-minute heartbeat
regardless. Tado's freshness window is derived from that heartbeat, and the derivation is written
at the constant in `config.ts`.

**One poll is one request for the whole flat**: `GET /homes/{id}/zoneStates`, after a one-time
discovery of the home id and the zone list.

**Tado thermostats are read-only to us.** We collect their values. We never control heating.

## Netatmo Home Coach

Pull, OAuth refresh flow, `gethomecoachsdata`. Temperature, humidity, CO₂. Reference:
`~/dev/netatmo-sync` (mine, working).

**Netatmo only refreshes every 7–8 minutes on their side.** Polling it faster gains nothing.

## SEN66

Sensirion nine-in-one node (PM1, PM2.5, PM4, PM10, temperature, humidity, VOC index, NOx index,
CO₂) over I²C behind an ESP32, pushing JSON to us. Not built yet; the ingest endpoint and a
simulator script stand in.

## Why the poll intervals are what they are

**Both intervals come from an inequality rather than from taste.** A reading is up to one vendor
publishing interval old when fetched, plus up to one poll interval older before the next fetch, and
the sum has to fit inside that source's freshness window:

> poll interval < freshness window − vendor publishing interval

The publishing intervals are the measured facts above. The two windows live in
[`src/config.ts`](../src/config.ts) and each poll interval at the `POLL_INTERVAL` constant of the
adapter that does the polling, every one of them argued where it sits — this page deliberately
copies none of the four numbers, so there is nothing here that can come to contradict them.

Tado's interval sits well under its bound on purpose: a threshold crossing should be seen promptly,
and the `UNIQUE (source_id, kind, measured_at)` constraint absorbs the repeated readings for free.

## Credentials

Netatmo's OAuth app and the Modbus host come from environment variables and are never committed.
Tado has no secret to keep.

**Each vendor's refresh token lives in a file** — `data/netatmo-token.json` and
`data/tado-token.json`, moved with `NETATMO_TOKEN_PATH` and `TADO_TOKEN_PATH`, both through
[`src/sources/refresh-token-file.ts`](../src/sources/refresh-token-file.ts) — because **both
vendors rotate it on every refresh**. Something mutable has to hold the current one, and the two
other candidates lose: an environment variable cannot be rewritten by a running process, and the
database is append-only with no mutable row in it, on purpose — a credentials row would quietly
spend that property, and would put a live secret inside every database backup besides.

The file is written atomically (temp + rename, mode 0600), the new token is persisted **before** the
new access token is used, and each adapter re-reads its file on every refresh, so a re-authorisation
takes effect without a restart. Cost, accepted: two more files to back up, and a secret unencrypted
on disk — which `.env` already is.

**`TADO_TOKEN_PATH` is also Tado's on-switch**, since there is no credential in the environment to
key on. Keyed on the *variable* rather than on whether the file exists, deliberately — a token file
that has gone missing must fail loudly at every poll and point at `/auth/tado`, not quietly go
silent while looking healthy. One switch per vendor, and they are independent: with only Netatmo
configured the Tado rooms simply read `missing`, which is the honest answer.

**Access-token expiry is deliberately not tracked for either vendor.** The token is used until the
vendor refuses it, then refreshed and the request retried once — that path has to exist anyway, and
a timer doing the same job would be a second mechanism. The price is one wasted request per token
lifetime. What the refusal looks like is a measured fact rather than a convention for both of them;
each adapter states its own at the constant, and both are in CLAUDE.md's measurement table.
