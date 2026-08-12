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
*Decided with the module, 2026-08-11: as recommended — and the response is 200 whenever the
batch was processed, verdicts inside, so a simple node never retries poison.*

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

**F7 — tests that exercise behaviour over time.** "It must settle" unfolds over hours and no
per-function assertion demonstrates it. Originally specified as a closed-loop simulator; **later
reduced to scripted traces**, because every plant parameter the simulator needs is a guess, and a
settling test against a guessed plant proves the controller settles in an imaginary flat. The
plant model is deferred until there is measured data. See below.

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

### Second review round, R1–R8

The design was reviewed again after F1–F8, by a fresh adversarial pass and a pass asked
specifically to find regressions the fixes had introduced. Both independently found the same one.

**R1 — CO₂ sleep inference is RESTORED**, with a 10-minute hold below 700 before it de-asserts.
F1 deleted it on the grounds that bedroom CO₂ both created demand and capped the response. That
overlap is real and it is *intended*: this bedroom is never merely occupied, so CO₂ above 700
there means someone is asleep, and levels above 50 being unreachable then is the requirement, not
a defect. The scenario used to condemn the rule — children playing in the bedroom on a Saturday
afternoon — does not occur in this flat.

Deleting it also caused the regression both reviewers found: with the cap keyed to the clock, the
loop's internal level tracked to 70–80 overnight and released **50 → 80 in one cycle at 07:00**,
into a bedroom where people were still asleep. It fired only when the requirement was active — had
they woken and opened the door, CO₂ would have collapsed and the level walked down first. Keying
the cap to CO₂ means it lifts when the room clears, not when the clock strikes.

**R2 — increases are now rate-limited**, one step per 90 s. Unbounded increases were wrong on the
requirement's own terms: *not audible* makes up the dangerous direction, and the design bounded
the safe one. The CO₂ signal already lags 7–8 minutes, so a four-minute ramp is invisible in
control terms and removes every audible step change.

**R3 — the band is unchanged.** A reviewer argued the 1/Q² plant makes one step move CO₂ further
than the band's step width at low levels, so the loop hunts below level 50. Not acted on: the
high-gain zone is the bedroom behind a closed door, and the bedroom only dominates demand when
someone is asleep in it — at which point the output is capped and the loop is saturated, so it
cannot hunt. Daytime demand comes from the living room, which has a larger flow share and gentler
gain. Recompute from measured data in week one rather than tuning against a model.

**R4 — the loop reads the actual level back every tick.** Nothing previously said it did, so a
hand-set 80 could run all night while the log reported "level 40, no change needed".

**R5 — the simulator models rooms separately.** With one well-mixed volume the sleep logic is
untestable, because bedroom CO₂ and demand CO₂ are the same number.

**R6 — the persisted last-change timestamp is clamped on read**, and an unreadable state row is an
error rather than a first run.

**R7 — deferred, noted.** A push node with a stuck clock stamps every reading identically and
`INSERT OR IGNORE` silently swallows all but the first, so the node looks online and stores
nothing. The fix is an alarm on duplicate-ignore rate per source. Ingest is tier 2 and the nodes
do not exist yet; **build this with the ingest endpoint, not after it.**

**R8 — no safe level on shutdown, re-affirmed.** A handler covers only graceful exits; a hard
crash or power cut bypasses it, and partial cover that reads as protection is worse than a known
gap.

### Third round, S1–S5 — the simplification pass

The first three rounds each added a mechanism, and several of the mechanisms existed only to
protect other mechanisms. This round ran in the opposite direction: **it removed things, and it is
the round that happened immediately before the code was written.** The project is judged on being
readable in twenty minutes, and by R8 it was not.

The test for each cut was the same: *does this defend against a failure that actually happens
here, or against a failure another mechanism introduced?*

**S1 — read-back reconciliation in the control path is CUT** (reverses R4). The actual level is
still read every tick and reported next to the desired level, so a wall-panel change is visible.
The controller no longer compares them or acts on the difference. What R4 bought back — a hand-set
80 at 23:30 being pulled to 50 — is given up, and the log will say so rather than hide it.

> **S1 was partly reversed after implementation — see S6.** Giving that up turned out to mean the
> one hard requirement in the product losing to a button press, which is not a thing a review
> budget gets to decide.

**S2 — the `control_state` table is CUT** (reverses F5 and R6), and with it the clamp-on-read and
the unreadable-row-is-an-error rule. Two guards existed only to protect one guard. The dwell timer
lives in memory and resets on restart; a crash loop is a thing to fix, not to rate-limit. The
database is now append-only with no mutable row in it at all.

**S3 — rate limiting on increases is CUT** (reverses R2). Increases apply immediately, at any
distance. R2's noise argument is real and is given up knowingly; what it cost was a second timing
rule that made the limiter read as symmetric while behaving asymmetrically. The one-step-per-dwell
*decrease* — which is what actually kills the square wave — is retained.

**S4 — the 10-minute sleep de-assert hold is CUT** (reverses part of R1), replaced by a different
shape for the CO₂ term:

```
sleeping = inQuietHours(now) || (wasSleeping && bedroomCo2 fresh && bedroomCo2 > SLEEP_CO2)
```

R1 restored CO₂ as an independent assertion, and F1 was right that this self-latches: the band puts
level 50 near 900 ppm, so any CO₂ high enough to demand more than 50 has already asserted sleep and
capped the response at 50. With the bedroom door open an ordinary busy evening reaches that with
nobody in bed. **As an extender the term cannot false-trigger**, because it requires having already
been asleep — and it still does the one job R1 wanted, which is to hold the cap past 07:00 until
the room actually clears. The hold becomes unnecessary: the term can only ever release sleep, so
there is nothing to chatter between.

Two losses, both accepted and both testable: an afternoon nap gets no cap, and a restart while
asleep after 07:00 drops the cap.

**S5 — the pinned-at-ceiling diagnostic is KEPT.** It was on the list to cut and should not have
been: ASHRAE Guideline 36 specifies it, it is the only way a capacity problem announces itself
rather than looking like a control failure, and it is one line plus one timestamp.

**S6 — cap-breach enforcement is RESTORED, and nothing else with it** (partly reverses S1). This
one came from reading the finished code rather than the design: with S1 in place, a level hand-set
above `sleepMaxLevel` at 23:30 runs until morning, because the loop compares its own last command
to its own target, finds them equal and writes nothing.

The rule is now: if the unit is above the cap while sleep is asserted, that level is handed to the
limiter as where the unit really is, and the cap path already there pulls it back in one move.
Everything else about the read-back stays reported-and-ignored.

Three positions have now been occupied, and the middle one is the right one:

| | daytime hand-set | night hand-set above the cap |
|---|---|---|
| reassert always (original) | overwritten within 30 s | corrected |
| reassert never (S1) | survives until we change our mind | **runs all night** |
| **cap breach only (S6)** | survives until we change our mind | corrected in one move |

It costs one conditional and no new concept — the cap path, the immediacy, the dwell bypass and
the not-touching-`lastChangeAt` were all already built and tested. It is also *better* than the
original: a hand-set level **below** the cap is never undone now, where the original pushed a
hand-set 30 back up to 50. The panel stays good for making the flat quieter, which is what anyone
reaching for it at 2am actually wants.

**What the first five cuts did *not* touch**, listed so they read as targeted rather than
indiscriminate: the proportional band and its hysteresis, worst-room-wins demand, stale and
missing excluded in both directions, the safe default when blind, the cap applied to the current
level rather than only to computed targets, decreases at one step per ten minutes, the two level
types, per-source freshness, config-only topology, and the storage schema.

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
- **Time is a parameter.** No clock read inside any logic under test. A fixed `now` — a
  `Temporal.Instant` since 2026-08-12 — is passed in, so no test sleeps and no test is flaky.
- **Instants never meet a bare `deepEqual`.** An instant's state lives in internal slots that
  `assert.deepEqual` cannot see, so two *different* instants compare as deeply equal and a wrong
  timestamp passes silently. Instant-bearing shapes are asserted through
  `tests/support/deep-equal.ts`, which writes instants out as ISO strings first; single instants
  compare by `epochMilliseconds`.
- **Fakes, not mocks.** `actuator/fake.ts` records the levels it was told to set. Sources are
  plain functions returning canned readings. Nothing asserts on call counts of a mocking library.
- **Table-driven** where cases are uniform (threshold maps, quiet-hours boundaries); individually
  named tests where each case makes a distinct point.
- Test names state the behaviour, not the function: *"a stale low reading does not suppress a
  boost"*, not *"test policy 3"*.

## The three that matter most

Put these first in their files. If a reviewer reads nothing else, these are the argument.

1. **Overnight, and the cap holds past 07:00 until the room clears.** A scripted trace, and the
   regression two independent reviewers found by reasoning. Every other test asserts a rule; this
   one asserts behaviour over time.
2. **A stale low reading does not suppress a boost.** A dead sensor sitting at 400 ppm is
   excluded from demand entirely — never averaged in, never read as good air.
3. **The unit is at 70 when quiet hours begin, and drops at once.** No new target is computed and
   demand has not moved, yet the level still falls to 50 — because the cap is evaluated against
   where the unit *is*, not only against a freshly computed target.

Close behind, worth reading second: **hysteresis, both directions from one input** — CO₂ at 700
while running high stays high; at 700 while running low stays low. Same number, opposite outcome.

---

## Scripted trace tests

The tests with time in them. **No physics.** A trace is a hand-written series of `(minute, co2)`
pairs plus a starting wall-clock time; the harness samples the curve at the instrument's own
refresh rate and feeds it to **the real control loop** — a real `SensorSource`, a real in-memory
SQLite store, the recording fake unit — then asserts on the *sequence* of commands.

It makes no claim to model a flat. It says "here is a CO₂ trace, here is what the service does",
which is exactly what a sequence bug needs and no more.

**The harness must drive `createControlLoop`, not `policy` and `limiter` directly.** It used to
thread `currentLevel`, `lastChangeAt` and `wasSleeping` itself, which made it a second copy of the
loop's state machine — and a copy that went on passing while the real one was broken. Mutating
`wasSleeping = false` inside the loop left all nine traces green, including the one that exists to
catch precisely that regression. Wiring the tests re-implement is wiring that is not tested.

Driving the loop also puts the fake unit inside the harness, so a trace can make writes fail across
many ticks. That is the only way to reach the loop's update *ordering*, as distinct from whether it
threads state at all.

Assertions are on the sequence, not on individual decisions:

- output never exceeded `sleepMaxLevel` while sleep was asserted
- **no two consecutive commands *decrease* by more than one step**, except a sleep-cap enforcement
  move, which is immediate and unlimited by design. The rule is one-directional on purpose:
  increases are unbounded since S3, so a symmetric version of it contradicts the design and leaves
  every trace permanently red. The exemption for the cap move matters just as much — the cap is
  specified to drop 80 → 50 in one move, so a rule without it fails the trace that the cap exists
  for.
- fewer than N changes across the trace
- the level never returns to the floor in a single move

### The traces

- **Overnight, clearing late.** CO₂ climbs from 23:00, sits at 1300, starts falling at 07:30. Assert
  the cap holds past 07:00 while CO₂ is high and releases only as the room clears. This is the
  regression that two independent reviewers found; it would have failed here immediately.
- **The square wave.** CO₂ rises past the band, then falls below the release point within one dwell.
  Assert no 80 → 20 and no single-move return to the floor.
- **Cooking spike.** Fast rise at 19:00. Assert the level reaches its demanded value on the cycle
  that sees the reading — up is unbounded, and a rate limit on increases fails this trace.
- **Evening at 70 into quiet hours.** Level 70 at 21:55, demand flat, clock passes 22:00. Assert the
  drop lands at the boundary, not at the next dwell.
- **Netatmo's refresh.** The same reading repeated for 8 simulated minutes between changes. Assert
  the controller neither accumulates nor re-acts on unchanged input.
- **Sensor dies at 02:00.** Readings stop. Assert fallback to the safe default, still capped, no
  drift.
- **Hovering at a step boundary.** CO₂ oscillating ±20 ppm around a step edge. Assert no flutter —
  this is what the 60 ppm hysteresis is for.
- **Threshold boundaries.** CO₂ exactly at `C_LO`, `C_HI`, the sleep threshold, and each step edge.
- **Restart mid-trace.** The loop is rebuilt against the same unit and the same database: it
  re-reads the level from the hardware and starts with no dwell timer and no sleep memory. Assert
  it acts on the next cycle rather than waiting out a dwell — the documented consequence of S2.
- **A write outage across the morning release.** Modbus refuses writes for an hour around the time
  the bedroom clears. Assert sleep releases during the outage and never re-asserts, and that the
  loop resumes commanding when the unit comes back. This is the trace that pins the loop's update
  *ordering*: carrying the sleep state only on ticks whose write succeeded re-creates exactly the
  self-latching failure the extender exists to prevent, and no other trace can see it, because no
  other trace has an actuator that fails.

### What this deliberately cannot do

It cannot tell you whether the loop **converges**, because convergence is a property of the closed
loop and a scripted trace is open — the controller's actions do not feed back into the CO₂ series.
That question needs a plant model, and a plant model needs plant parameters.

## Later: the plant model, once there is data

Noted here so it is a deferred plan rather than an omission.

A closed-loop simulator — per-room CO₂ mass balance, occupancy, airflow shares, the controller's own
output feeding back — would answer the convergence question and let thresholds be tuned in
milliseconds instead of one experiment per night.

**Its precondition is measured data.** Every parameter that matters is currently a guess: airflow at
each level, each room's share of it, inter-room transfer through open doors. Built now it would prove
the controller settles in an imaginary flat, which is a weaker claim than it appears and easy to
mistake for validation.

After a week of operation there are logged settling points at several levels, which pin the airflow
curve and the flow shares. At that point the model is calibrated against this flat rather than swept
across plausible ones, and it becomes genuinely predictive. Build it then, together with the band
recomputation it enables.

The parameters it will need, and what will be known about each by then:

| Parameter | Currently a guess |
|---|---|
| Airflow at level 20 → 80 | 45 → 140 (restricted install) through 70 → 220 m³/h (optimistic) |
| Occupants, and which room they are in | 2 to 5, distributed |
| Bedroom's share of total flow | 20–50% |
| Outdoor CO₂ | 400–450 ppm |

Once those are measured rather than guessed, the model answers one question the scripted traces
structurally cannot: **does it settle?** Assert that the change count stays bounded and there is no
repeated full-range swing.

The corner most likely to fail is restricted install with four or five occupants, where the fan's
CO₂ authority (~1070 ppm) exceeds the 700 ppm band. If it does fail, widen the band first.

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

## `policy.ts`

`(snapshot, now) -> { desiredLevel, sleeping, reasons }`

### Demand

- no fresh CO₂ anywhere → `safeDefaultLevel`, and a reason saying the system is blind
- every room below the release threshold → minimum (20)
- one room above the boost threshold → raised
- two rooms with fresh CO₂ → **the worse one drives**, and assert it with the worse room *last* in
  the config order as well as first. With only the first-is-worst case, "worst room wins" and
  "first fresh room wins" give the same answer, and the difference is a fan idling at the floor
  while a room sits at 1300 ppm.
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
  no change; crossing it by more than 60 ppm does. **Assert it from both sides.** A reading above
  the boundary is already answered by the raw band when the fan is high, so that case exercises
  only the upward bias; the downward bias needs a reading *below* the boundary while running high.
  One side alone leaves half the mechanism deletable without a test noticing.
- **the loop-gain guard**: assert that `C_HI - C_LO` is at least the fan authority currently
  believed, so a future narrowing of the band fails loudly rather than quietly oscillating in the
  flat. Written as a test rather than a runtime check at config load: the authority is an estimate
  spanning 350–1100 ppm, and turning an estimate into a runtime invariant means choosing the number
  that makes the assertion pass. The belief is expected to change; the test is where it is recorded.

### Sleep

Quiet hours assert it. Fresh bedroom CO₂ above 700 only *extends* an assertion that already holds
(S4).

- inside quiet hours → sleeping, whatever CO₂ says
- **bedroom CO₂ fresh and above 700, outside quiet hours, not previously sleeping → NOT sleeping.**
  The afternoon-nap case, now uncovered by design. This is the assertion that pins S4: written as
  an independent assertion the term self-latches, because the band puts 50 near 900 ppm and every
  reading that demands more than 50 has already crossed 700.
- **previously sleeping, CO₂ fresh above 700, outside quiet hours → still sleeping.** The extension.
- **previously sleeping, CO₂ falls below 700 → not sleeping**, on that cycle, with no hold. There is
  nothing to chatter between: the term can only release, and once released only quiet hours can
  reassert.
- **bedroom CO₂ stale or missing, outside quiet hours → not sleeping**, whatever `wasSleeping` said.
  A dead Netatmo must not cap ventilation all day.
- **living-room CO₂ at 1400 while bedroom sits at 500 → not sleeping**, and the level is free to
  reach 80. Only the *bedroom* sensor bears on sleep; demand comes from all rooms.
- **the 07:00 regression guard**: sleeping overnight with bedroom CO₂ at 1300, clock passes 07:00 →
  still sleeping, because the room has not cleared. The cap must lift when CO₂ falls, not when the
  clock strikes. This is what the extender exists for.
- **quiet hours wrap midnight** — 23:30 sleeping, 02:00 sleeping, 12:00 not. 22:00–07:00 is
  `hour >= 22 || hour < 7`; written with `&&` it is *always false* and the night cap silently
  never fires. Most likely bug in the project.
- quiet-hours boundaries exactly at 22:00 and 07:00 → pinned
- the hour is read in the configured zone, not the host's — assert one case across a DST change,
  because a test that passes only in Prague is a test that fails in CI
- **every sensor dead, inside quiet hours → still sleeping.** Quiet hours depends on no sensor,
  and is the only thing between a dead Netatmo and a loud unit at 3am.
- **`policy` does not apply the cap** — sleeping with demand at the ceiling still reports 80 as the
  desired level, with `sleeping: true` and both facts in the reasons. The clamp is the limiter's,
  and it is asserted there.

## `limiter.ts`

`(decision, current, lastChangeAt, now) -> ControlOutcome`

**Rate limiting — asymmetric, bounded on the way down only**

- **an increase applies immediately, at any distance** — desired 80 from current 20 yields 80 on
  that cycle (S3)
- **a decrease moves one step per `minDwellMinutes` (10 min)** — desired 20 from current 80 yields
  70, not 20
- descending 80 → 20 takes six steps and sixty minutes
- a reversal mid-descent is honoured at once, because it is an increase
- **the square-wave regression guard**: a CO₂ series that rises past the band and falls back
  within one dwell must produce no single-move return to the floor and no 80 → 20 transition

**Dwell**

- desired equals current → `unchanged`, and **no write is issued**
- a decrease with the dwell not elapsed → `unchanged`, reason names dwell
- dwell boundary exactly → pinned
- **dwell never gates an increase** — one minute after a change, a higher demand still applies
- **dwell is measured from the last actual change, not the last evaluation** — evaluating every
  30 s must not keep resetting the timer, or nothing ever moves
- **no previous change at all → acts immediately** (Q4), which is also the restart case (S2)
- a suppressed change is reported in the outcome, never silently dropped

**The sleep cap**

- **F4: the cap applies to the current level, not only to a computed target.** Unit at 70, quiet
  hours begin, demand unchanged at mid-range so no new target is produced → the level must still
  drop to 50.
- **the cap bypasses dwell** — a drop at the boundary is immediate even if the last change was
  one minute ago
- **the cap is not rate-limited** — 80 → 50 happens in one move, not one step per dwell
- **the cap does not update `lastChangeAt`** — otherwise the drop at 22:00 starts a fresh dwell and
  delays the genuine walk down that follows it by ten minutes for nothing
- **the cap does not stop demand being tracked** — leaving quiet hours with demand at 80 returns
  the unit to 80 at once, because the cap was a clamp and never an internal state
- **below the cap, sleep changes nothing** — sleeping with demand at 30 yields 30, not 50

**Levels**

- a single-step change is allowed — 70 → 80 and 20 → 30 must both be reachable (Q2 regression
  guard)
- values from outside (config, Modbus read) narrow to a valid `Level` or are rejected
- **the commanded ceiling holds** — a demand that would exceed 80 clamps to 80
- **a wall-panel level above the ceiling is readable** — the unit reports 100, which is a valid
  `Level`; reading it must not throw. Commanding it must not typecheck, and `assertCommandedLevel`
  must throw on it at runtime, because type stripping checks nothing.
- **a hand-set level above the cap, while asleep, is corrected in one move** (S6). Unit at 80 at
  02:00: the next tick commands `sleepMaxLevel`, not a walk down over forty minutes and not
  "no change needed".
- **a hand-set level below the cap is left alone**, asleep or not — the panel stays usable for
  making the flat quieter.
- **a hand-set level in the daytime is reported and left alone**, and pulled back only by the next
  change the controller makes for its own reasons.

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
- one invalid reading in a batch → the rest lands; the reject carries its index and reason
  (Q6, decided as recommended)
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
- actuator failure does not kill the loop; the next tick still runs, and the failed level is
  **retried** rather than recorded as achieved
- store failure does not kill the loop
- a full cycle end to end: fake sources → store → decide → fake actuator receives the expected
  level
- **the level is adopted from the unit at startup** (Q4), clamped to the ceiling if the panel left
  it at 90 or 100; if that read fails, the safe default stands in
- **the read-back is reported, not acted on** (S1): move the fake unit's level by hand, and the
  loop logs the disagreement while its decision continues from its own last commanded value
- **the loop carries `wasSleeping` and `lastChangeAt` from one tick to the next.** The traces cover
  this too, now that they drive the real loop, and these stay as the direct statement of it: a
  failing fourteen-hour trace reports "sleep re-asserted at minute 688", while these report
  "commands were [50, 80], expected [50]". Same requirement, one of them debuggable in seconds.
- **`state()` reports the last decision** — the level we are holding, the level the unit reports,
  demand before the cap, and the reasons. This is what `/api/state` serves, and what lets the trace
  harness assert on a decision rather than only on the commands that came out of it.
- **the pinned-at-ceiling diagnostic** fires after 10 minutes at the ceiling with CO₂ above
  `C_HI` + 10%, and not before; it repeats at most once per window while the condition lasts; and
  the 10 minutes start again from the moment it clears. Three assertions rather than one, because
  the middle one is the difference between an alarm and a note, and the last one is a mutation the
  first two do not catch.
- **the margin is pinned, not merely present.** The "merely bad air" case has to run against a
  source that keeps reporting, or the reading goes stale, the alarm is disarmed by staleness rather
  than by the threshold, and the assertion holds however wrong the threshold is.
- **the ceiling half of the condition is pinned too** — 1400 ppm at night with the sleep cap
  holding the fan at 50 must produce no alarm. The fan is under orders, not out of air.
- **a failed write does not freeze the clock.** The diagnostic runs on every tick, including one
  whose write failed, and judges on where the unit actually is. Skipping it there lets a spell of
  failing writes hide a clearing, after which the alarm dates itself from before it.
- **the below-300-ppm calibration check is deferred with the ingest endpoint**, where readings
  arrive. Recorded here so its absence reads as a decision.

## `sources/collector.ts`

*Added when the loop was parked (2026-08-11): the loop's polling step, extracted so collection
runs without control. The loop's own copy of these behaviours keeps its tests; the loop and the
collector are alternatives in `main.ts`, never concurrent.*

- polls a due source and stores what it returns
- respects each source's own cadence rather than polling on every tick
- asks again once the interval has elapsed
- one source throwing does not stop the others (same case as the loop's)
- a store that cannot be written does not kill the tick, and the log names the store, not the
  vendor
- a repeated reading logs as "0 new" — the dedup constraint absorbing Netatmo's refresh window,
  visible in the log

## `http/server.ts`

- `/api/state` returns room-level values, each naming its source and freshness
- **`/api/state` agrees with the controller** — assert the endpoint's value equals a direct call
  to `precedence` with the same inputs. This is what enforces "one implementation, two consumers"
  as a property rather than a promise.
- `/api/sensors` includes inactive sensors, so historical data stays interpretable
- room history expands to the configured sources for that room
- `/health`

*Built 2026-08-11, with the loop parked. The control block of `/api/state` is parked with it;
what was added instead:*

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
  acceptance and its bounds are recorded in CLAUDE.md, "The write endpoint is open on the LAN".*
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
- **Wall-clock timing.** Nothing sleeps. Dwell, quiet hours and freshness are all tested by
  passing different values of `now`.
- **SQLite itself.** We test our queries and constraints, not the engine's.
