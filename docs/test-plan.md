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
- **same reading, two windows, two verdicts** — 20 minutes old is `stale` for Netatmo (15 min
  window, two of its 7–8 minute refreshes) and `fresh` for Tado (25 min window, one 20-minute
  heartbeat plus a poll interval). One test that demonstrates the whole per-source design.
  *Inverted 2026-08-14, with the Tado adapter: Tado's window was 90 seconds, a number that
  assumed a poll produces a fresh value. The vendor's heartbeat is what decides, and it is the
  longer of the two — so the example now runs the other way round.*

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
- a Modbus **exception response** surfaces as an error, not a silent no-op
- read-back after write disagrees with what was written → reported, not ignored
- connection refused → the error propagates cleanly to the caller

## `sources/netatmo.ts`

*Split from a shared "the pull adapters" section on 2026-08-14, when the Tado adapter was built.
The two vendors turned out to share a shape (a token file, a refusal, one retry) and to disagree
on every detail of it — which refusal, whether the rotation is optional, how many rooms come back
per request — so one list was describing neither.*

- vendor payload maps to `Reading[]` with the right kinds and canonical units
- **the vendor's timestamp becomes `measured_at`**, not the time we polled — and it arrives in
  epoch *seconds*, so the factor of a thousand is pinned; off by it, every reading dates from 1970
- **the expired-token answer — 403 with `error.code` 3 — → token refresh, then one retry.**
  The status and the code both matter: the fixture used to say 401, which no real response ever
  carries, so the case passed while the adapter could not refresh against the live API
  (2026-08-14)
- a 403 with any other code → reported as itself, no refresh, no retry
- vendor 500 → returns an error; does not throw into the collector
- malformed payload → error, and nothing partial is stored
- the rotated refresh token is persisted before the new access token is used, and the *next*
  refresh sends the rotated one
- no token anywhere → the error names `/auth/netatmo`, and zero requests are made
- **polled twice inside its 7–8 minute refresh returns the same reading, and the second
  poll stores nothing** — the idempotency constraint absorbs it for free. Nice demonstration that
  the dedup design pays for itself outside the push path.

## `sources/tado.ts`

*Written before the adapter, 2026-08-14. Two facts shape the list, and both were measured rather
than assumed: the refusal is a plain **401** (curl against the live API with a garbage bearer
token), and access tokens live **10 minutes**, so refreshing is the hot path — roughly every tenth
poll — rather than the rare one. Tado rotates its refresh token on every refresh and the old one
is revoked immediately, so a lost rotation is a lockout within the hour.*

Mapping:

- a zone-states payload maps to `Reading[]` with the right kinds, canonical units (°C and %RH need
  no conversion) and the `sourceId` config maps that zone to
- **each datapoint keeps its own timestamp.** `insideTemperature.timestamp` and
  `humidity.timestamp` are independent instants — one is not allowed to stand in for the other —
  and `received_at` is the poll's `now`
- fields the adapter has no vocabulary for (`fahrenheit`, `precision`, `setting`,
  `activityDataPoints`) are present in the fixtures and dropped

The conversation:

- **discovery happens once per process**: `GET /me` for the home id, then `GET /homes/{id}/zones`;
  every later poll is one `GET /homes/{id}/zoneStates` and nothing else
- an account with zero or several homes → throws naming what it found. One home is an assumption,
  so it is an assumption that fails loudly
- the bearer token rides every data request
- **a 401 → refresh, then exactly one retry of the same request** — the conversation asserted in
  order. A second 401 throws ("rejected an access token it just issued") rather than looping
- the auth parameters ride the **query string of a body-less POST**, which is what Tado accepts
- refresh answer with no `refresh_token` → throws naming the credential loss. Unlike Netatmo's,
  where the field is optional, a Tado answer without the replacement means the one we sent has
  just been revoked and nothing replaced it
- `invalid_grant` → the error points at `/auth/tado`
- no token file → the error names `/auth/tado`, and zero requests are made
- the rotation is persisted **before** the new access token is used, and the next refresh sends
  the rotated one; a persist that fails (read-only directory) is logged and the readings still
  come back

Many zones, one answer — what is skipped and what is fatal:

- **skipped silently, other zones still land**: a mapped zone missing from the answer, or a zone
  with absent or empty `sensorDataPoints` (hot water measures nothing). These are the vendor
  *declaring* it has nothing to say, and the honest report of the gap is `/api/state` turning that
  room stale against its own window — a line per skipped zone per poll would be 1,440 a day for one
  flat battery and would say nothing the state endpoint does not. **The silence is asserted**, not
  just the readings
- **`link.state` is not one of those cases, because nothing reads it.** A well-formed datapoint is
  a reading whatever the field says — `ONLINE`, `DISCONNECTED`, a word Tado has not invented yet, or
  nothing at all — and that is table-driven, because it is a decision rather than an accident. The
  first build skipped anything that was not `CONNECTED`, a value from the reference client's types
  that no real answer carries, and it silently dropped every reading in the flat (2026-08-14).
  Freshness is judged on the vendor's timestamp; a second opinion about reachability is a second
  switch for one question
- **fatal, nothing partial stored**: the envelope is not what we think it is, or a datapoint that
  is present carries wrong-typed innards (`celsius` not a number, a timestamp that does not
  parse). A malformed payload could mean *we* are misreading the API, and storing the zones that
  happened to parse would mask it
- **a `zoneStates` that is a list is refused by name**, and this one is not defensive
  bookkeeping: `states['1']` on a list is its *second* element, so a list would half-work and file
  every zone's readings under the neighbouring instrument's name. Silent, permanent, and the exact
  mistake the "relocating a sensor means a new id" convention exists to prevent
- reconciliation logs, at discovery and **only there** — once per process, where the per-poll
  skips are silent: a configured zone the API does not offer names every zone it *did* offer (id,
  name, type — fixing config is then copy-paste from the log); an unmapped `HEATING` zone gets a
  line of its own, so a new radiator is never silently invisible; an unmapped `HOT_WATER` zone is
  ignored in silence. Neither log stops the mapped zones polling
- **polled twice inside the 20-minute heartbeat, the second poll stores nothing** — same
  demonstration as Netatmo's, and the reason the poll interval can stay at one minute

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
  *Moved 2026-08-12: the pair lives in `http/netatmo-auth.ts`, mounted whole by the server. The
  tests stay against the assembled server on purpose — that way the mounting itself is covered,
  and the cases below needed no edit to survive the move.*
  *Trimmed 2026-08-12: the 10-minute state expiry is removed. The single-use exact-match state
  check is the CSRF defence and stays; the wall-clock deadline on top of it guarded against
  nothing any caller does, and only its own test ever consumed it.*

*Added 2026-08-14, with the Tado onboarding route. Tested against the assembled server for the
same reason the Netatmo pair is — the mounting is then covered too:*

- **`/auth/tado` is one route, not a pair.** The device flow has no callback: the vendor never
  calls us, so the page polls. A `<meta http-equiv="refresh">` at the interval Tado asked for
  drives **exactly one token poll per page load** — asserted, because a client-side loop is how
  a 429 happens
- a first GET starts a flow: the query carries `client_id` and `scope=offline_access`, and the
  page carries the verification link, the user code and the meta refresh
- reloading while the flow is pending polls once more and shows the same code
- `authorization_pending` → keep waiting; `slow_down` → the interval grows by 5 s (RFC 8628) and
  the page says so
- granted → the refresh token lands in the token file (asserted through `loadRefreshToken`), the
  success page carries **no** meta refresh, and the flow is cleared
- `access_denied` → 400, the flow cleared, and the next GET starts a fresh one
- the code expires two ways and both give a fresh code: the clock advanced past the vendor's
  `expires_in`, and Tado answering `expired_token`
- an unexpected status → 502 carrying the body; unconfigured (no `TADO_TOKEN_PATH`) → 503 naming
  the variable, not a 404 that reads as a typo in the URL

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

  **Done for Tado, 2026-08-14:** authorised through `/auth/tado` against the real account —
  approved on the fourth poll of the waiting page — then one poll produced `tado: 6 readings, 6 new`
  and all three rooms answered `/api/state` under the right sourceIds. Twelve minutes of running
  then carried it through a real token expiry: the poll at 08:13 refused, refreshed and retried
  without a log line or a missed reading, which is the one path a fake stream cannot honestly
  exercise and the one whose failure mode is a lockout within the hour.

  That session is also what corrected two things no fake could have: every zone id in `TADO_ZONES`
  (the placeholders were wrong in all three entries) and `link.state`, which is `ONLINE` and not the
  `CONNECTED` the fixtures had been asserting happily. **The fixtures in `tado.test.ts` are now
  copies of that real payload**, down to the expired-token body, which is the only reason they are
  worth anything.
- **Wall-clock timing.** Nothing sleeps. Freshness and every range window are tested by passing
  different values of `now`.
- **SQLite itself.** We test our queries and constraints, not the engine's.
