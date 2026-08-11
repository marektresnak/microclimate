# microclimate

Collects readings from the sensors in my flat, stores them, and drives the HRV (heat-recovery
ventilation) unit based on air quality — primarily CO₂.

> **Status.** The control core is built and tested: config and domain types, freshness,
> precedence, the policy, the limiter, the store, the loop, and a scripted-trace suite. The vendor
> adapters (Tado, Netatmo), the Modbus TCP adapter, the ingest endpoint and the read API exist as
> interfaces and fakes only — see [Not built yet](#not-built-yet).

## The problem

Three rooms, sensors from two vendors with completely different refresh rates, and a ventilation
unit that runs at 20–80% in 10% steps. The unit has to keep the air fresh without being audible
in the bedroom at night, and it has to settle on a stable power level rather than oscillating
between full boost and idle.

That last requirement is most of the difficulty. Naively recomputing a target from current CO₂
gives you a unit that boosts to 80%, ventilates the room, drops to 20%, lets CO₂ climb, and boosts
again — technically correct, unbearable to live with.

## The control law, in plain terms

**A straight line.** 20% at 550 ppm, 80% at 1250 ppm, read off the line in between and quantised
onto the seven legal steps. The 700 ppm span is the *band*, and its width is the one parameter
that decides whether the loop settles.

**Why width decides it.** The fan can only hold CO₂ somewhere between a floor and a ceiling; that
span is its *authority*. A band narrower than the authority means driving the fan end to end moves
CO₂ further than the band covers, so it slams between extremes. It is a shower with a long pipe:
react harder than your own action changes things and you weave between scalding and freezing.

**What is honestly known.** The authority of this unit in this flat is somewhere between 350 and
1100 ppm and **nobody has measured it**. 700 is a middle bet. Recomputing it from a week of logged
settling points is the next real piece of work, and until then the one-step-per-ten-minutes
retreat is the backstop that turns a mis-sized band into slow drift rather than a square wave.

The design is ASHRAE Guideline 36's proportional-only demand-controlled-ventilation sequence, not
something invented here. The one place it departs from commercial convention is band width, for
the reason above.

## Where to look first

A reviewer with twenty minutes should read these, in this order. They are pure functions: time
arrives as a parameter, nothing reads a clock or a database, and all the interesting reasoning is
here.

| | | |
|---|---|---|
| [`src/control/policy.ts`](src/control/policy.ts) | 142 lines | CO₂ → a demanded level, plus whether anyone is asleep |
| [`src/control/limiter.ts`](src/control/limiter.ts) | 87 lines | the sleep cap, and the one timing rule |
| [`src/domain/precedence.ts`](src/domain/precedence.ts) | 61 lines | which instrument answers for a room |
| [`src/control/freshness.ts`](src/control/freshness.ts) | 33 lines | whether a reading still counts |
| [`src/config.ts`](src/config.ts) | 170 lines | the whole topology and every tunable number |

Then the tests, which are meant to read as sentences:

- [`tests/policy.test.ts`](tests/policy.test.ts) — what the system does, one rule per sentence
- [`tests/trace.test.ts`](tests/trace.test.ts) — what it does *over time*: nine hand-written CO₂
  curves fed through the real control modules, asserting on the sequence of commands

**Three tests carry most of the argument.** Overnight, the cap holds past 07:00 until the room
actually clears. A stale low reading does not suppress a boost. The unit is at 70 when quiet hours
begin and drops at once — because the cap is evaluated against where the unit *is*, not only
against a freshly computed target.

About 1,250 lines of source and 2,100 of tests, no runtime dependencies.

## Four decisions worth knowing before you read

**Freshness is per source, never global.** A 30-second-old Tado reading and a 6-minute-old Netatmo
reading are both fine; one staleness window cannot judge both. Stale and missing readings are then
excluded from demand *in both directions* — a dead sensor sitting at 400 ppm is never good air,
and one last seen at 1400 never pins the fan at full power.

**Two instruments are never averaged.** Precedence is an ordered list per (room, kind) and the
first fresh source wins. The kids' room has two valves next to different radiators that disagree
by a degree and a half; a mean belongs to neither. `/api/state` will resolve its values with the
same function the controller uses, so the two disagreeing is impossible by construction.

**Sleep is asserted by quiet hours and only *extended* by bedroom CO₂.** Asserted independently,
the CO₂ term self-latches: the band puts 50% near 900 ppm, so any reading high enough to demand
more than 50 has already crossed the sleep threshold and capped the response at 50. As an extender
it cannot false-trigger, and it still does the job it exists for — holding the cap past 07:00
until the room clears rather than when a clock strikes.

**The rate limit is asymmetric and applies to one direction.** Increases apply at once, because up
is where the air is already bad. Decreases move one step per ten minutes, which may never be
shorter than the slowest CO₂ source's refresh — otherwise the controller steps again before it
could observe the last step.

Full reasoning, including what was tried and rejected, is in [`CLAUDE.md`](CLAUDE.md); the case
list and four rounds of design review are in [`docs/test-plan.md`](docs/test-plan.md).

## Running

Requires **Node 24 or later** (developed on 26). No build step — Node strips the types at runtime
and `node:sqlite` is built in, so there are no native modules to compile and no runtime
dependencies at all.

```sh
npm install
npm start      # synthetic sensors, recording fake unit, logs every decision with its reasoning
```

```sh
npm test       # typechecks first, then node:test — no framework
npm run typecheck
```

`npm test` runs `tsc --noEmit` before the suite, and that is not a convenience. Type stripping
deletes the types without checking them, so nothing at runtime enforces `CommandedLevel` — and
`CommandedLevel` is the entire guard against commanding 90% into an intake grille that cannot pass
the air. A suite that runs green without a typecheck would not notice the guard had gone.

## Not built yet

Interfaces and fakes stand in for all of these; none of them changes the control core.

- **Tado and Netatmo adapters.** `SensorSource` is the seam; `sources/synthetic.ts` stands in.
- **Modbus TCP.** `VentilationUnit` is the seam; `actuator/fake.ts` stands in. The protocol details
  are recovered and recorded in `CLAUDE.md` — register 21001, percent × 10, FC3 and FC6.
- **`POST /api/readings`** and the JSON read API. The seams are in place: `resolveSignal` is the
  same function the controller uses, so `/api/state` cannot disagree with it, and the loop already
  exposes its last decision — level held, level the unit reports, demand before the cap, reasons —
  through `state()`.
- **The below-300-ppm calibration check.** A reading under 300 ppm means an NDIR sensor's
  self-calibration has drifted, which silently shifts the whole band. It is a check on readings as
  they arrive, so it belongs with the ingest endpoint rather than in the control loop. The other
  diagnostic — pinned at the ceiling — is built, because that one is about the decision.

## Deliberately out of scope

Docker, any UI or charting, control of the Tado heating (read-only to us), authentication beyond a
shared token on the ingest endpoint, and retention/downsampling — the rollup tier is designed and
costed in `CLAUDE.md` but not built, and until it exists **nothing prunes**.

Sensor topology lives in config rather than the database, on purpose: it gives literal union types
for room and sensor ids, so a typo is a compile error, and git records *why* a sensor moved in a
way a table never could.

**One gap is known and accepted rather than overlooked.** If the service dies, the unit holds its
last commanded level indefinitely — a shutdown handler covers only graceful exits, a hard crash or
power cut bypasses it entirely, and partial cover that reads as protection is worse than a known
gap. The honest fix is a device-side watchdog that does not exist.

**The wall panel is honoured in one direction only.** A level set by hand is reported but not
corrected — except when it would run the fan above the sleep cap while somebody is asleep, which is
pulled back on the next tick. Making the flat quieter always wins; making it louder than the night
cap never does.
