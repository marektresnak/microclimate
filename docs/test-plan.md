# Test plan

Written before the implementation, on purpose. Two reasons:

1. **It stops the suite validating itself.** If the implementation is written first and tests are
   generated afterwards, they get written against what the code *does* — bugs become expected
   behaviour and the suite cannot fail in the ways that matter.
2. **Enumerating cases finds design gaps while they are still free.** Writing this document
   surfaced six, listed below, before a line of code existed.

The tests are also the document a reviewer reads to understand what the system does. They should
read as sentences.

---

## Open questions this raised

Unresolved. Each needs a decision before the module it affects is written.

**Q1 — Is the "unknown bedroom CO₂ at night" sleep clause redundant?**
Sleep is asserted if (a) inside quiet hours, (b) bedroom CO₂ is fresh and above threshold, or
(c) it is night and bedroom CO₂ is not fresh. If "night" means the same window as quiet hours,
then (a) already caps unconditionally and **(c) never fires**. Either "night" is a wider window
than quiet hours, or (c) should be deleted. *Recommendation: delete (c).* Quiet hours already
guarantees the 3am safety, and (b) exists to catch early nights and daytime naps outside it.

**Q2 — Does the step-size deadband stay?** "Target must differ from current by more than one
step" creates a dead zone: the unit could go 20 → 40 but never 20 → 30, and could never make a
final 90 → 100. Minimum dwell already prevents twitchiness.
*Recommendation: drop it. Keep the deadband on the input only (CO₂ rising 800 / falling 650).*

**Q3 — When every source for a `(room, kind)` is stale, which one is reported?** The
highest-precedence source, or the most recently measured? They differ, and the answer is visible
in `/api/state`. *Recommendation: most recently measured — it is the best information available,
and precedence is about trust, not recency, once nothing is fresh.*

**Q4 — First run has no previous change, so dwell has no baseline.** Act immediately, or wait one
interval? *Recommendation: act immediately; the unit's current level is read from Modbus at
startup, so the first decision is as informed as any later one.*

**Q5 — How old is "too old" on ingest?** Timestamp validation must reject a node that has not
synced NTP, but a node replaying a buffered backlog legitimately sends hours-old readings. These
pull in opposite directions. *Recommendation: reject `measured_at` more than 7 days old or more
than 5 minutes in the future.*

**Q6 — Is a bad reading in a batch fatal to the whole batch?**
*Recommendation: no. Store the valid readings, report the rejected ones with reasons. One
misconfigured measurement should not discard eight good ones.*

---

## Strategy

| Module | Approach | Why |
|---|---|---|
| `freshness`, `precedence`, `policy`, `limiter` | **Test-first** | Pure, enumerable, no IO. This is what a reviewer reads. |
| `ingest`, `store` | Test-first for rules, after for wiring | The validation and idempotency rules are known; the SQL shape is not. |
| `sources/*`, `actuator/modbus-tcp` | **Test-after**, against fakes | The shape is not knowable until the real protocol has been spoken. |
| `control/loop`, `http/server` | **Test-after**, integration with fakes | Wiring. Tested for resilience, not logic. |

## Conventions

- `node:test` + `node:assert/strict`. No framework.
- **Time is a parameter.** No `Date.now()` inside any logic under test. A fixed `now` is passed
  in, so no test sleeps and no test is flaky.
- **Fakes, not mocks.** `actuator/fake.ts` records the levels it was told to set. Sources are
  plain functions returning canned readings. Nothing asserts on call counts of a mocking library.
- **Table-driven** where cases are uniform (threshold maps, quiet-hours boundaries); individually
  named tests where each case makes a distinct point.
- Test names state the behaviour, not the function: *"a stale low reading does not suppress a
  boost"*, not *"test policy 3"*.

## The three that matter most

Put these first in their files. If a reviewer reads nothing else, these are the argument.

1. **A stale low reading does not suppress a boost.** A dead sensor sitting at 400 ppm is
   excluded from demand entirely — never averaged in, never read as good air.
2. **Hysteresis, both directions from one input.** CO₂ at 700 while running high stays high; CO₂
   at 700 while running low stays low. Same number, opposite outcome — that pair is the proof
   the oscillation problem is solved.
3. **Night, bedroom sensor dead, unit stays quiet.** The guard that stops a failed Netatmo
   running the unit at 100% at 3am.

---

## `freshness.ts`

`(reading | undefined, now, windowMs) -> RoomSignal`

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

## `precedence.ts`

`(room, kind, readings, now) -> RoomSignal + winning sourceId`

- highest-precedence source is fresh → it wins, and the result names it
- highest-precedence is stale, second is fresh → second wins, result names the second
- every source stale → **Q3**
- no source has ever reported → `missing`
- a source is `isActive: false` → skipped, even if it is the freshest reading present
- room has exactly one source → that one, trivially
- kind not measured by any source in the room → `missing` (living-room CO₂ before the SEN66)
- **two fresh sources are never averaged** — assert the returned value is exactly equal to one
  source's reading
- order comes from config, not from which reading is newest — a fresher low-precedence source
  still loses to a fresh high-precedence one

## `policy.ts`

`(snapshot, now) -> { desiredLevel, sleeping, reasons }`

### Demand

- no fresh CO₂ anywhere → `safeDefaultLevel`, and a reason saying the system is blind
- every room below the release threshold → minimum (20)
- one room above the boost threshold → raised
- two rooms with fresh CO₂ → **the worse one drives**
- **a stale LOW reading is excluded** — bedroom stale at 400, kids fresh at 1100 → boost. The
  stale value must not average the demand down.
- **a stale HIGH reading is also excluded** — a dead sensor last seen at 1400 must not pin the
  unit at 100 indefinitely. Symmetry matters; this is the failure that wastes power and noise
  rather than air quality, and it is easy to forget.
- a `missing` room contributes nothing and does not block the others
- CO₂ exactly at the boost threshold → pin the inclusive/exclusive choice
- CO₂ at or above maximum demand → 100
- **monotonic**: higher CO₂ never produces a lower level (property-style, table-driven)

### Sleep

- bedroom CO₂ fresh and above the sleep threshold → sleeping
- bedroom CO₂ fresh and below it, in daytime → not sleeping
- inside quiet hours → sleeping regardless of CO₂
- **quiet hours wrap midnight** — 23:30 sleeping, 02:00 sleeping, 12:00 not. 22:00–07:00 is
  `hour >= 22 || hour < 7`; written with `&&` it is *always false* and the night cap silently
  never fires. Most likely bug in the project.
- quiet-hours boundaries exactly at 22:00 and 07:00 → pinned
- **daytime + bedroom CO₂ stale → NOT sleeping.** If the unknown-data clause is not scoped to
  night, a dead Netatmo caps ventilation twenty-four hours a day. (See **Q1**.)
- sleeping caps the level to `sleepMaxLevel`
- sleeping with demand of 100 → capped to 50, and the reasons record **both** the demand and the
  cap, not just the outcome

## `limiter.ts`

`(desired, current, lastChangeAt, now) -> ControlOutcome`

- desired equals current → `unchanged`, and **no write is issued**
- desired differs, dwell elapsed → `changed`
- desired differs, dwell not elapsed → `unchanged`, reason names dwell
- dwell boundary exactly → pinned
- no previous change → **Q4**
- **dwell is measured from the last actual change, not the last evaluation** — evaluating every
  30 s must not keep resetting the timer, or nothing ever moves
- a suppressed change is reported in the outcome, never silently dropped
- **the hysteresis pair** (headline case 2)
- values from outside (config, Modbus read) narrow to a valid `Level` or are rejected

## `ingest/http.ts`

- a batch of nine readings is accepted and all nine stored
- **the identical batch replayed → row count unchanged**
- partial replay — some seen, some new → only the new ones stored
- a retried reading keeps its **original** `received_at`, not the retry's
- `measured_at` far in the future → rejected
- `measured_at` far in the past → rejected (**Q5** — must still accept a legitimate buffered
  backlog)
- a buffered backlog replay is stored with original `measured_at` and *now* as `received_at`
- one invalid reading in a batch → **Q6**
- unknown `source_id` (not in config) → rejected
- unknown `kind` → rejected
- wrong value type → rejected before it reaches SQLite, not by the STRICT table throwing
- missing or wrong ingest token → 401

## `store/readings.ts`

- insert and read back, including the generated `measured_at_iso`
- latest-per-`(source, kind)` orders by **`measured_at`**, not `received_at`
- **the range query uses the index** — assert on `EXPLAIN QUERY PLAN` output. Cheap, and it fails
  loudly if someone later adds a column or changes the constraint and quietly turns the dashboard
  query into a full scan.
- no code path deletes a reading (asserted by review, not by test — noted here so it is not
  forgotten)

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
- connection refused → error propagates cleanly and the loop survives

## `sources/tado.ts`, `sources/netatmo.ts`

- vendor payload maps to `Reading[]` with the right kinds and canonical units
- **the vendor's timestamp becomes `measured_at`**, not the time we polled
- 401 → token refresh, then one retry
- vendor 500 → returns an error; does not throw into the control loop
- malformed payload → error, and nothing partial is stored
- **Netatmo polled twice inside its 7–8 minute refresh returns the same reading, and the second
  poll stores nothing** — the idempotency constraint absorbs it for free. Nice demonstration that
  the dedup design pays for itself outside the push path.

## `control/loop.ts` — integration, all fakes

- one source throwing does not stop the others being polled
- one source failing does not prevent a control decision from the remaining data
- actuator failure does not kill the loop; the next tick still runs
- store failure does not kill the loop
- a full cycle end to end: fake sources → store → decide → fake actuator receives the expected
  level

## `http/server.ts`

- `/api/state` returns room-level values, each naming its source and freshness
- **`/api/state` agrees with the controller** — assert the endpoint's value equals a direct call
  to `precedence` with the same inputs. This is what enforces "one implementation, two consumers"
  as a property rather than a promise.
- `/api/sensors` includes inactive sensors, so historical data stays interpretable
- room history expands to the configured sources for that room
- `/health`

---

## Deliberately not tested

- **Real hardware.** No test talks to the Daphne, Tado or Netatmo. Adapters are exercised against
  fakes; the real integration is verified by hand once, and by the thing running.
- **Wall-clock timing.** Nothing sleeps. Dwell, quiet hours and freshness are all tested by
  passing different values of `now`.
- **SQLite itself.** We test our queries and constraints, not the engine's.
