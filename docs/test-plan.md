# Test plan

Written before the implementation, on purpose. Two reasons:

1. **It stops the suite validating itself.** If the implementation is written first and tests are
   generated afterwards, they get written against what the code *does* — bugs become expected
   behaviour and the suite cannot fail in the ways that matter.
2. **Enumerating cases finds design gaps while they are still free.** Several of the decisions
   recorded in `CLAUDE.md` were surfaced by writing the case lists below before a line of code
   existed.

The tests are also the document a reviewer reads to understand what the system does. They should
read as sentences.

---

## Strategy

| Module | Approach | Why |
|---|---|---|
| `freshness`, `precedence`, `time` | **Test-first** | Pure, enumerable, no IO. This is what a reviewer reads. |
| `ingest`, `store` | Test-first for rules, after for wiring | The validation and idempotency rules are known; the SQL shape is not. |
| `sources/*`, `actuator/modbus-tcp` | **Test-after**, against fakes | The shape is not knowable until the real protocol has been spoken. |
| `sources/collector`, `http/server` | **Test-after**, integration with fakes | Wiring. Tested for resilience, not logic. |

## Conventions

- `node:test` + `node:assert/strict`. No framework.
- **Time is a parameter.** No clock read inside any logic under test. A fixed `now` — a
  `Temporal.Instant` since 2026-08-12 — is passed in, so no test sleeps and no test is flaky.
- **`assertDeepEqual` is the only deep assertion, enforced by `conventions.test.ts`.** An
  instant's state lives in internal slots that `assert.deepEqual` cannot see, so two *different*
  instants compare as deeply equal and a wrong timestamp passes silently. The wrapper in
  `tests/support/deep-equal.ts` writes instants out as ISO strings first — the expected side can
  simply be the written-out string — and passes instant-free data through untouched, so the ban
  on the bare call is total and mechanical: the conventions test scans the suite and turns a
  forgotten import into a red build. Raw `epochMilliseconds` appears only where the number
  itself is the contract (millisecond truncation, the vendor's epoch seconds, raw SQL).
- **Fakes, not mocks.** `actuator/fake.ts` records the levels it was told to set. Sources are
  plain functions returning canned readings. Nothing asserts on call counts of a mocking library.
- **Table-driven** where cases are uniform (freshness windows, zone spellings); individually
  named tests where each case makes a distinct point.
- Test names state the behaviour, not the function: *"treats an offset timestamp as the instant
  it names"*, not *"test ingest 3"*.

---

## `domain/freshness.ts`

`(reading | undefined, now, window) -> RoomSignal`

- reading inside the window → `fresh`
- reading exactly at the window boundary → `fresh` (inclusive; pin it either way, but pin it)
- reading older than the window → `stale`, carrying the last value and its `measured_at`
- no reading at all → `missing`
- **`missing` and `stale` are distinct** — one means never heard from, the other means went quiet
- `measured_at` slightly in the future (small clock skew) → still `fresh`, not an error
- `received_at` is irrelevant: a reading received one second ago but measured an hour ago is
  `stale`
- **same reading, two windows, two verdicts** — 8 minutes old is `fresh` for Netatmo (15 min
  window) and `stale` for Tado (90 s window). One test that demonstrates the whole per-source
  design.

## `domain/precedence.ts`

`(room, kind, readings, now) -> RoomSignal + winning sourceId`

- highest-precedence source is fresh → it wins, and the result names it
- highest-precedence is stale, second is fresh → second wins, result names the second
- every source stale → returns `stale` carrying the **most recently measured** reading, even when
  that came from a lower-precedence source. Precedence encodes trust, which matters while a
  choice between live instruments exists; once nothing is fresh, the best remaining information
  is the newest reading rather than the most trusted dead one.
- no source has ever reported → `missing`
- **decommissioning is a `config.ts` invariant, not a `precedence.ts` branch.** `resolveSignal`
  consults exactly the ranked list and nothing else; `isActive` is descriptive and reported by
  `/api/sensors`. Asserted where the mistake happens: an inactive sensor must not appear in any
  ranked list. The earlier form — a skip inside `resolveSignal` — was unreachable from every
  possible test, because no instrument in this flat has ever been decommissioned, and two switches
  answering one question is one too many.
- room has exactly one source → that one, trivially
- kind not measured by any source in the room → `missing` (living-room CO₂ before the SEN66)
- **two fresh sources are never averaged** — assert the returned value is exactly equal to one
  source's reading
- order comes from config, not from which reading is newest — a fresher low-precedence source
  still loses to a fresh high-precedence one

## `ingest/http.ts`

- a batch of nine readings is accepted and all nine stored
- **the identical batch replayed → row count unchanged**
- partial replay — some seen, some new → only the new ones stored
- a retried reading keeps its **original** `received_at`, not the retry's
- `measured_at` more than five minutes in the future → rejected
- **`measured_at` arbitrarily far in the past → ACCEPTED.** A twelve-hour backlog must land
  intact; `INSERT OR IGNORE` already makes replay idempotent at any age, so a past-side window
  would discard real data for no benefit.
- a buffered backlog replay is stored with original `measured_at` and *now* as `received_at`
- one invalid reading in a batch → the rest lands; the reject carries its index and reason
- unknown `source_id` (not in config) → rejected
- unknown `kind` → rejected; so is a real kind the named instrument does not declare — a
  mislabelled reading files one instrument's data under another's name, permanently
- wrong value type → rejected before it reaches SQLite, not by the STRICT table throwing
- `measuredAt` as **epoch milliseconds → rejected**, in either spelling. It is the shape this
  endpoint used to take, and a node left on the old firmware must fail loudly rather than look
  healthy while storing nothing
- `measuredAt` with no zone → rejected; it would otherwise mean a different instant per machine
- **every zone spelling of one instant stores one row, carrying the correct UTC epoch** — nine
  spellings in one batch land as `stored: 1, duplicates: 8`, and the stored integer is asserted
  against `Date.UTC(...)` rather than against whatever the parser happened to produce
- the same holds across requests, not only within a batch: a node that changes zone between
  retries still replays idempotently
- **instants that genuinely differ stay two readings**, even written with the same wall clock —
  the +13:00/-12:00 pair, 25 hours apart, must not collapse into one row
- *These were checked by mutation: making the parser ignore the offset fails all of them, and
  fails nothing else. A test that cannot fail is not covering anything.*
- a CO₂ reading below 300 ppm is stored and flagged in the log — probable calibration drift,
  and the reading is the evidence
- ~~missing or wrong ingest token → 401~~ *removed 2026-08-11: ingest is open on the LAN like
  every other endpoint — the acceptance is recorded in CLAUDE.md*

## `domain/time.ts`

*Added 2026-08-12, when the API stopped speaking epoch milliseconds.*

- what it writes is what `measured_at_iso` computes — one string for anyone reading the database
  by hand and anyone reading the API
- accepts `Z`, with or without seconds and their fraction
- **every zone spelling of one instant reads as that one instant** — `Z`, `+00:00`, `-00:00`,
  Prague in both halves of the year, a negative offset, `+05:30` (half an hour, which an
  hours-only parse would lose) and `±13/12` (a day earlier or later on their own calendars)
- **and instants the zone separates stay separated**: one wall clock at opposite ends of the
  offset range is 25 hours apart across three calendar days
- refuses a zone-less timestamp, a bare date, and epoch milliseconds in either spelling
- refuses dates that do not exist. `2026-02-31`, `2026-04-31` and `2027-02-29` are pinned — and
  `2028-02-29`, which does exist, is pinned beside them so the guard cannot be tightened into
  rejecting leap days. *Reworded 2026-08-12: Temporal refuses these natively, where the first
  build had to rebuild the date by hand because `Date.parse` rolls an impossible day forward.
  The cases stay pinned so a retreat to `Date.parse` fails loudly.*
- **accepts the RFC 9557 spellings the hand-rolled grammar refused** (2026-08-12, with the move
  to `Temporal.Instant.from`): space and lowercase separators, a bracketed zone annotation, the
  compact form — pinned so the widening reads as a decision, not an accident
- **truncates sub-millisecond input to the millisecond the store thinks in** — one instant, one
  representation, or the uniqueness constraint could meet a nanosecond twin
- round-trips whatever it wrote

## `store/readings.ts`

- insert and read back, including the generated `measured_at_iso`
- latest-per-`(source, kind)` orders by **`measured_at`**, not `received_at`
- **the range query uses the index** — assert on `EXPLAIN QUERY PLAN` output. Cheap, and it fails
  loudly if someone later adds a column or changes the constraint and quietly turns the dashboard
  query into a full scan.
- no code path deletes a reading (asserted by review, not by test — noted here so it is not
  forgotten)

## `store/logs.ts`

*Added 2026-08-12 with `GET /api/logs`: the lines the `log` seam carries, kept beside the
readings so "what happened last night" is a dashboard question rather than a shell one.*

- append and read back by range, half-open `[from, to)` — same rule as the readings range
  *(both stores moved from inclusive-both-ends the same day: half-open windows are the only kind
  that tile, and a boundary instant must land in exactly one of two adjacent windows)*
- lines written in the same millisecond come back in the order they were written — `at` alone
  cannot order the collector logging two sources back to back, and `rowid` breaks the tie
- the same line twice is two events — no dedup, because nothing retries a log line
- the generated `at_iso` renders readable ISO without storing it
- **the range query uses the index** — asserted on `EXPLAIN QUERY PLAN` like the readings query.
  The index is explicit here, where the readings table borrows its own from the dedup constraint,
  so this is also what notices if it is dropped.
- no code path deletes a line (asserted by review, not by test — same note as the readings)

## `actuator/modbus-tcp.ts`

- 50% encodes to register value 500; 500 decodes to 50%
- writes to register **21001**
- FC6 request frame bytes are correct against a fake socket (MBAP header + PDU)
- FC3 response parsing
- transaction id increments, and a response with a mismatched id is not accepted as the answer
- timeout → error returned, no hang
- a Modbus **exception response** surfaces as an error — the original C# spike swallowed these in
  an empty `catch`, which is exactly the bug to test against
- read-back after write disagrees with what was written → reported, not ignored
- connection refused → the error propagates cleanly to the caller

## `sources/tado.ts`, `sources/netatmo.ts`

- vendor payload maps to `Reading[]` with the right kinds and canonical units
- **the vendor's timestamp becomes `measured_at`**, not the time we polled
- 401 → token refresh, then one retry
- vendor 500 → returns an error; does not throw into the collector
- malformed payload → error, and nothing partial is stored
- **Netatmo polled twice inside its 7–8 minute refresh returns the same reading, and the second
  poll stores nothing** — the idempotency constraint absorbs it for free. Nice demonstration that
  the dedup design pays for itself outside the push path.

## `sources/collector.ts`

- polls a due source and stores what it returns
- respects each source's own cadence rather than polling on every tick
- asks again once the interval has elapsed
- one source throwing does not stop the others
- a store that cannot be written does not kill the tick, and the log names the store, not the
  vendor
- a repeated reading logs as "0 new" — the dedup constraint absorbing Netatmo's refresh window,
  visible in the log

## `http/server.ts`

- `/api/state` returns room-level values, each naming its source and freshness
- **`/api/state` agrees with `resolveSignal`** — assert the endpoint's value equals a direct call
  to `precedence` with the same inputs. This is what enforces "one rule, every consumer" as a
  property rather than a promise.
- `/api/sensors` includes inactive sensors, so historical data stays interpretable
- room history expands to the configured sources for that room
- `/health`
- **a reading posted in one zone, fetched over a window written in another, comes back in UTC** —
  the whole round trip in one test: `13:59+02:00` in, `2026-08-11T11:59:00.000Z` out, and the
  echoed `from`/`to` show which window was actually applied
- unknown rooms, sensors and routes are refused with 404; a range bound that is not an ISO 8601
  instant with an explicit zone is refused with 400 — including epoch milliseconds, a zone-less
  string, and `2026-02-31`, which `Date.parse` would otherwise roll forward into March
  *Trimmed 2026-08-12: the wrong-method 405, the `from > to` 400 and the unknown-`kind` 400 are
  removed with the code that produced them — only their own tests ever consumed them. A wrong
  method now gets the ordinary 404, and an inverted range or unknown kind honestly returns an
  empty `readings`. The unparseable-bound rejection stays: `?from=yesterday` yielding an empty
  array would read as "no data".*
- `GET /api/unit/level` reads the fan live, and answers 502 when the unit does not
- `POST /api/unit/level` refuses 90 and 100 through `assertCommandedLevel`, and answers 502 when
  the write fails. *The token cases were removed the same day they were written: the endpoint is
  deliberately unauthenticated on the trusted LAN, reversing the earlier finding — the
  acceptance and its bounds are recorded in CLAUDE.md, "Both write endpoints are open on the
  LAN".*
- `/auth/netatmo` issues a single-use `state` and keeps the client secret out of the browser URL
- the callback rejects a forged state and a vendor refusal; a good code is exchanged and the
  refresh token lands in the token file
  *Trimmed 2026-08-12: the 10-minute state expiry is removed. The single-use exact-match state
  check is the CSRF defence and stays; the wall-clock deadline on top of it guarded against
  nothing any caller does, and only its own test ever consumed it.*

*Added 2026-08-12, with the log store:*

- `GET /api/logs` serves the stored log over the default last-day window, ISO in and out, and
  honours an explicit `?from=&to=`; a zone-less bound gets the same 400 as everywhere else — the
  log speaks the one range grammar the history endpoints already speak

---

## Deliberately not tested

- **Real hardware.** No test talks to the Daphne, Tado or Netatmo. Adapters are exercised against
  fakes; the real integration is verified by hand once, and by the thing running.

  **Done for the Daphne, 2026-08-11:** read 50%, wrote 70%, read back 70%, wrote 50%, read back
  50% — first attempt, against the unit in the flat. That is the check a fake stream cannot make,
  and it is a one-off by design: a suite that needs the hardware powered on is a suite nobody runs.
- **Wall-clock timing.** Nothing sleeps. Freshness and every range window are tested by passing
  different values of `now`.
- **SQLite itself.** We test our queries and constraints, not the engine's.
