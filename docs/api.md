# The HTTP surface

The endpoints, and the reasoning behind the wire format and the ingest rules. The rules themselves,
in imperative form, are in [`CLAUDE.md`](../CLAUDE.md).

## Endpoints

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

There is no range cap — single user, trusted LAN, accepted.

## Instants on the wire

Every instant in this API is an ISO 8601 string, in and out. Epoch milliseconds never appear.

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

**`/api/state` reports `status` and `measuredAt`, and no age.** The freshness judgement is made
here, against that source's own window and this server's clock. Handing the client an age invites a
second judgement against a clock that may not agree with ours, and two answers to one question is
one too many. Anyone who wants to plot the gap has `measuredAt`.

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

## Both write endpoints are open on the LAN, knowingly

Do not add auth inside this process, and do not report its absence as a finding. The acceptance:

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
