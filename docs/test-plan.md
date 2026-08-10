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

## Design questions this raised

### Decided

**Q1 — The "night and bedroom CO₂ not fresh" sleep clause is DELETED.** Its window was the same
as quiet hours, which already caps unconditionally, so it could never fire.
*Superseded by F1: the remaining CO₂ clause was deleted too, and sleep is now quiet hours alone.*

**Q2 — The step-size deadband is DROPPED.** Requiring the target to differ by more than one step
created a dead zone: 20 → 40 possible, 20 → 30 never, and the top of the range unreachable.
*Superseded by F3 and F8: dropping it left no rate limit at all, and the 800/650 input band it
pointed at has since been replaced by a proportional band with per-boundary hysteresis.*

**Q3 — When every source is stale, report the MOST RECENTLY MEASURED one.** Precedence encodes
trust, which matters while a choice between live instruments exists. Once nothing is fresh there
is no such choice — only the question of the best remaining information, which is the newest
reading rather than the most trusted dead one.

**Q4 — On the first cycle the limiter ACTS IMMEDIATELY.** The unit's current level is read at
startup, so the first decision is as informed as any later one, and a restart during bad air
responds at once rather than waiting out a dwell period.

### Still open — ingest only, deferred with that module

**Q6 — Is a bad reading in a batch fatal to the whole batch?**
*Recommendation: no. Store the valid readings, report the rejected ones with reasons. One
misconfigured measurement should not discard eight good ones.*

### From the independent review

Two agents reviewed the design before any code existed: one given only the requirements and asked
to name the hard problems, one given the decisions with all reasoning stripped and told at least
three were wrong. Findings acted on, F1–F6; F7 and F8 came from a follow-up literature review:

**F1 — CO₂-based sleep inference is DELETED.** It was fatal, not imperfect. Bedroom CO₂ was both
the demand signal and the occupancy signal, so every reading high enough to create demand
(>800 ppm) had already asserted sleep (>700) and capped the response at 50. Levels 60–80 were
unreachable, and the state self-sustained because capped airflow clears CO₂ slowly. Sleep is now
quiet hours only. No threshold arrangement could have fixed a signal used to raise demand and
clamp the response at once.

**F3 — asymmetric rate limiting ADDED.** The design had none: demand crossing 800 slammed 20 → 80,
the unit pulled CO₂ under 650 within one dwell, and it slammed back — a square wave with a
~20-minute period, exactly what the project exists to prevent. Increases now apply immediately and
at full distance; decreases move one step per dwell. *This gap came from confusing two opposite
rules when Q2 was decided: "must differ by more than one step" (a dead zone, rightly removed) and
"may move at most one step" (rate limiting, which was never there).*

**F4 — the sleep cap applies to the current level**, not only to newly computed targets, and
bypasses dwell. Previously a unit left at 70 by evening cooking ran all night whenever demand sat
mid-range and produced no new target.

**F5 — the last change is persisted.** Without it every restart reset the dwell, so a crash loop
made one change per restart instead of one per ten minutes.

**F6 — ingest rejects future timestamps only.** A past-side window would discard the buffered
backlog that batching exists to carry, and buys nothing because `INSERT OR IGNORE` already makes
replay idempotent at any age.

**Considered and not acted on.** One reviewer argued that repeated identical Netatmo readings
would wind the controller up — "fresh is not novel". The mechanism assumes an integrating
controller; ours is stateless and proportional, so the same input yields the same target and
nothing accumulates. The real constraint underneath it *was* adopted: **dwell may never be shorter
than the slowest CO₂ source's refresh interval**, or the controller acts before it could observe
the previous change.

**F7 — a closed-loop settle test.** "It must settle" unfolds over hours with the room's CO₂
dynamics inside the loop, and no per-function assertion demonstrates it. See the section below.

**F8 — the demand curve is a proportional band sized to the unit's CO₂ authority.** A literature
review found this is ASHRAE Guideline 36's P-only DCV sequence, so the design is standard rather
than invented — but it also found the band must be far wider than commercial convention suggests.
The unit can only hold CO₂ between ~708 ppm (level 80) and ~1358 (level 20) at design occupancy;
a band narrower than that 650 ppm authority gives loop gain above 1 and hunts regardless of
hysteresis. Band is now 550 → 1250 ppm, loop gain 0.72, convergence demonstrable on paper. The
commercial 200 ppm figure would have given loop gain 2.5–19 and an hour-period limit cycle.

**Decided against the reviewers.** Both flagged that the service overwrites a hand-set level
within 30 seconds, and recommended honouring manual changes. Rejected knowingly — see the actuator
section for the reasoning and the residual risk.

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

1. **Twenty-four simulated hours, and the unit settles.** The closed-loop test below. Every other
   test asserts a rule; this one asserts the requirement the rules exist to serve.
2. **A stale low reading does not suppress a boost.** A dead sensor sitting at 400 ppm is
   excluded from demand entirely — never averaged in, never read as good air.
3. **The unit is at 70 when quiet hours begin, and drops at once.** No new target is computed and
   demand has not moved, yet the level still falls to 50 — because the cap is evaluated against
   where the unit *is*, not only against a freshly computed target.

Close behind, worth reading second: **hysteresis, both directions from one input** — CO₂ at 700
while running high stays high; at 700 while running low stays low. Same number, opposite outcome.

---

## The closed-loop settle test

The one test with time in it. `sim/room.ts` is a crude model — occupancy adds a fixed ppm per
minute, ventilation removes CO₂ in proportion to the level — and the clock is a counter rather
than a wall, so twenty-four simulated hours run in milliseconds.

- **Base case.** Two people in the bedroom 23:00–07:00, doors closed. Assert the level changes
  fewer than N times overnight, never exceeds `sleepMaxLevel`, and CO₂ stays below a stated
  ceiling.
- **The square wave F3 fixed.** A CO₂ profile that crosses 800 and, once ventilated, drops below
  650 inside one dwell. Assert the sequence contains no 20 → 80 → 20 and no single-move return to
  the floor.
- **Cooking spike at 19:00.** CO₂ rises fast. Assert the level reaches its demanded value on the
  *first* cycle — the asymmetry is the whole point, and a symmetric rate limit fails this test.
- **Evening at 70 into quiet hours.** Assert the drop lands at 22:00, not at the next dwell.
- **Netatmo's 8-minute refresh.** Feed the same reading repeatedly between vendor updates. Assert
  the controller neither accumulates nor repeatedly acts on unchanged input.
- **Sensor dies at 02:00.** Readings stop. Assert the level falls back to the safe default, stays
  capped, and does not drift.

### The sensitivity sweep

Nobody has measured this flat's response, and the band was sized against an estimate. So the
settle test runs the **base case across every plausible flat**, not just one:

| Axis | Range swept |
|---|---|
| Airflow at level 20 → 80 | 45 → 140 (restricted install) through 70 → 220 m³/h (optimistic) |
| Occupants | 2 to 5 |
| Outdoor CO₂ | 400–450 ppm |

Roughly a dozen combinations. **Assert it settles in all of them** — change count stays bounded
and there is no repeated full-range swing.

This is the point of the exercise: the controller does not need to know which flat it is in, it
needs to work in any of them. A failing corner is a result, not a bug — it says the band is too
narrow or the down-dwell too short for that case, and it says so before installation rather than
after a bad night.

The corner most likely to fail is restricted install with four or five occupants, where the fan's
CO₂ authority (~1070 ppm) exceeds the 700 ppm band. If it does fail, widen the band first.

This is where the requirements are actually tested. If one of these fails, the per-function tests
passing is not reassuring.

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
- every source stale → returns `stale` carrying the **most recently measured** reading, even when
  that came from a lower-precedence source (Q3)
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
  unit at the ceiling indefinitely. Symmetry matters; this is the failure that wastes power and
  noise rather than air quality, and it is easy to forget.
- a `missing` room contributes nothing and does not block the others
- CO₂ at or below `C_LO` (550) → 20; at or above `C_HI` (1250) → **80**, never 90 or 100
- the band maps linearly in between — table-driven across the seven steps
- **monotonic**: higher CO₂ never produces a lower level (property-style, table-driven)
- **hysteresis at a step boundary**: sitting exactly on a boundary and wobbling ±20 ppm produces
  no change; crossing it by more than 60 ppm does
- **the loop-gain guard**: assert at config load that `C_HI - C_LO` is at least the estimated fan
  authority, so a future narrowing of the band fails loudly rather than quietly oscillating in the
  flat. The authority figure is an estimate until there is logged data — the guard checks the
  band against whatever is currently believed, and the belief is expected to change.

### Sleep

Quiet hours only. **CO₂ never asserts sleep** — see F1.

- inside quiet hours → sleeping, whatever CO₂ says
- outside quiet hours → not sleeping, whatever CO₂ says
- **quiet hours wrap midnight** — 23:30 sleeping, 02:00 sleeping, 12:00 not. 22:00–07:00 is
  `hour >= 22 || hour < 7`; written with `&&` it is *always false* and the night cap silently
  never fires. Most likely bug in the project.
- quiet-hours boundaries exactly at 22:00 and 07:00 → pinned
- **F1 regression guard: bedroom CO₂ at 1100 ppm outside quiet hours → NOT sleeping, and the
  level is free to exceed 50.** This is the case that was structurally impossible before — high
  CO₂ asserted sleep, which capped the response to the CO₂. Levels 60–80 must be reachable on
  demand alone.
- **every sensor dead, inside quiet hours → still sleeping.** Quiet hours depends on no sensor,
  and is now the only thing between a dead Netatmo and a loud unit at 3am.
- sleeping caps the level to `sleepMaxLevel`
- sleeping with demand at the ceiling → capped to 50, and the reasons record **both** the demand
  and the cap, not just the outcome

## `limiter.ts`

`(desired, current, sleeping, lastChangeAt, now) -> ControlOutcome`

**Rate limiting — asymmetric (F3)**

- **an increase applies immediately and at full distance** — 20 → 80 in one move, no dwell wait
- **a decrease moves one step only** — desired 20 from current 80 yields 70, not 20
- a decrease is subject to dwell; the next step waits `minDwellMinutes`
- **descending 80 → 20 takes six changes and sixty minutes**, one step each
- an increase *during* a descent applies at once and is not held by the descent's dwell
- **F3 regression guard: demand crossing 800 must not produce 20 → 80 → 20.** Given a CO₂ series
  that rises past 800 and falls below 650 within one dwell, the level must not return to 20 in a
  single move.

**Dwell**

- desired equals current → `unchanged`, and **no write is issued**
- desired differs, dwell not elapsed → `unchanged`, reason names dwell
- dwell boundary exactly → pinned
- **dwell is measured from the last actual change, not the last evaluation** — evaluating every
  30 s must not keep resetting the timer, or nothing ever moves
- **no previous change at all → acts immediately** (Q4)
- **F5: a restart does not reset dwell.** Given `last_change_at` persisted two minutes ago, a
  freshly started limiter waits the remaining eight — it must not treat a restart as "no previous
  change". Guards the crash-loop case where every restart drives a change.
- a suppressed change is reported in the outcome, never silently dropped

**The sleep cap**

- **F4: the cap applies to the current level, not only to a computed target.** Unit at 70, quiet
  hours begin, demand unchanged at mid-range so no new target is produced → the level must still
  drop to 50.
- **the cap bypasses dwell** — a drop at the boundary is immediate even if the last change was
  one minute ago
- **the cap is not rate-limited** — 80 → 50 happens in one move, not one step per dwell
- **the cap does not update `lastChangeAt`** — otherwise it re-triggers every cycle all night and
  permanently resets the dwell timer
- **the cap clamps the output, not the loop's internal level** — after eight capped hours, leaving
  quiet hours returns the unit to whatever demand actually is, with no jump and no catch-up

**Levels**

- a single-step change is allowed — 70 → 80 and 20 → 30 must both be reachable (Q2 regression
  guard)
- values from outside (config, Modbus read) narrow to a valid `Level` or are rejected
- **the commanded ceiling holds** — a demand that would exceed 80 clamps to 80
- **a wall-panel level above the ceiling is readable and handled** — the unit reports 100, which
  is a valid `Level`; the next decision commands ≤ 80 and pulls it back. Reading 100 must not
  throw, and commanding 100 must not typecheck.

## `ingest/http.ts`

- a batch of nine readings is accepted and all nine stored
- **the identical batch replayed → row count unchanged**
- partial replay — some seen, some new → only the new ones stored
- a retried reading keeps its **original** `received_at`, not the retry's
- `measured_at` more than five minutes in the future → rejected
- **`measured_at` arbitrarily far in the past → ACCEPTED** (F6). A twelve-hour backlog must land
  intact; `INSERT OR IGNORE` already makes replay idempotent at any age, so a past-side window
  would discard real data for no benefit.
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
