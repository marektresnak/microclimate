# microclimate

A service that collects readings from the sensors in my flat, stores them, exposes them over a
small JSON API, and sets the HRV (heat-recovery ventilation) unit's fan level over Modbus when
asked to.

**It is a collection platform.** Long term this is where home metrics live: automations will read
from the same store, and a dashboard will be built on top. That shapes the data model —
provenance, timestamps and units are designed for a reader that does not exist yet — but it does
**not** license building a rule engine, a plugin system, or an automation registry.

**Legibility is a requirement, not a nicety.** Someone should be able to read this cold and come
away with an accurate picture of it. Small, obvious, well-tested, defensible line by line. If a
change makes the codebase harder to explain to someone coming to it fresh, it is the wrong change.

This file holds the rules, and the facts that cost a live session to learn. The reasoning that
spans files lives beside it:

| | |
|---|---|
| [`README.md`](README.md) | What it is and how to run it. |
| [`docs/sensors.md`](docs/sensors.md) | Both vendors, and where the freshness windows and poll intervals come from. |
| [`docs/storage.md`](docs/storage.md) | The schema, the service log, topology-in-config, the retention design. |
| [`docs/api.md`](docs/api.md) | The endpoints, the wire format, and the ingest and auth arguments. |
| [`docs/architecture.md`](docs/architecture.md) | The module map, the two dependencies, and why there is no framework. |
| [`docs/test-plan.md`](docs/test-plan.md) | Per-module test strategy and conventions. |

---

## Commands

```sh
npm start          # fake unit, API on :3000, whichever vendors .env configures
npm test           # tsc --noEmit first, then node:test
npm run typecheck
```

**Never run `node --test` on its own.** Type stripping deletes the types without ever checking
them, so nothing at runtime enforces `CommandedLevel` — and `CommandedLevel` is the entire guard
against commanding 90 or 100 into a restricted intake grille. A suite that runs green without a
typecheck would not notice the guard had gone.

---

## Where reasoning lives

One argument, one home. A `why` written in two places drifts, and the copy that goes stale is
never the one you are looking at.

| | |
|---|---|
| **Code comment** | The constraint an edit *at this line* would violate. Must be within eyeshot of what it defends. |
| **This document** | Rules, and measurements that cost a live session to get. |
| **`docs/`** | Decisions and arguments that span files. |
| **README** | What it is and how to run it. |
| **Git** | What it used to be. |

Before writing a sentence anywhere, apply the deletion test: *if I cut this, what wrong thing
becomes possible?* No answer, no sentence.

**Do not restate a constant, a type, or a file tree in this document.** A number lives at the
constant that owns it; what belongs here is the property the number has to keep. Every duplicated
value is a future contradiction with a straight face.

**A rule whose argument lives in `docs/` needs a pointer here only when breaking it would not touch
a line that carries the reason.** Most do touch one — the append-only rule is argued in
`store/readings.ts`, per-source freshness in `config.ts`, the ingest verdicts in `ingest/http.ts` —
and a reader editing those lines cannot miss it. The exceptions are the decisions that start from
no existing line: a new sensor, a new endpoint, the rollup, an automation. Those get a **Before …,
read …** line at the point where the decision starts. Apart from the index above, that is the only
place this document sends a reader elsewhere.

When a section moves, the pointers aimed at it are part of the move:
`grep -rn "CLAUDE.md\|docs/" src tests docs` names every one.

---

## The automation comes later — the service collects, a human drives

Nothing automatic moves the fan. `main.ts` runs collection (sources → store), the read API, and
one write endpoint; the fan is driven by the wall panel or by `POST /api/unit/level`. The service
adds observability, not protection — a hand-set 80 at 23:30 runs all night.

**An automation driving the fan from CO₂ is intended, and must not be built until the data
exists.** How much air the unit moves in this flat, and therefore how CO₂ responds to a level
change, has never been measured; an automation tuned by guesses is not something to let drive the
flat. A first implementation was written and removed rather than shipped — the last commit
carrying it is
[`a75fba3`](https://github.com/marektresnak/microclimate/tree/a75fba33d1969e072f918b45944595cb0659f160)
(`src/control/` and its tests).

**This phase gathers the missing data.** Manual control over the API is the instrument: hold a
level, watch CO₂ settle, log it — the service log records every level set over the API next to the
CO₂ curve it explains. When a stretch of real readings exists, the automation returns as a pure
function reading from the same store. The collector is its polling step already in place.

**Before building the automation — or a dashboard, or a second actuator — read
[`docs/architecture.md`](docs/architecture.md)** — the seams that make each of them additive
already exist, which is why none of them justifies a rule engine, a plugin loader, an automation
registry, or an event bus.

---

## The review contract

I review every line and must be able to explain it without notes. Code that is clever, generic, or
written for a requirement we do not have fails review even if it works.

**Hard rules:**

- **No `any`.** Not in source, not in tests. `unknown` plus a narrowing function instead.
- **No new dependencies** without asking me first, with a reason.
- **No classes** unless the thing genuinely owns mutable state. Prefer plain functions and
  modules. Dependencies are passed as ordinary function parameters — no DI container, no
  decorators, no service locator.
- **No `enum`, no `namespace`, no parameter properties.** Node strips types at runtime rather than
  compiling, so these do not exist for us. `as const` unions instead of enums. Enforced by
  `erasableSyntaxOnly` in `tsconfig.json`, not left to discipline.
- **Type-only imports must say `import type`.** Same reason.
- **Explicit return types on every exported function.**
- **No type-level cleverness.** Conditional types, mapped types, generic gymnastics and branded
  types are all rejected. Plain interfaces and discriminated unions cover everything here.
- **Comments explain *why*, never *what*.** A comment restating the code is noise. A comment
  recording a constraint or a failure we are defending against is the point.

### Readable over compact

Write idiomatic TypeScript and stop there. The test for any line is whether it can be **narrated
out loud** — if explaining it takes a paragraph, it is wrong however elegant it looks.

- **Name the intermediate steps.** A chain read right-to-left gets broken into named `const`s.
- **No nested ternaries.** One level is fine for a genuine either/or. Two is a rewrite.
- **Early returns over nested `if`.** The happy path is the least-indented code in the function.
- **A `for...of` loop is not a failure.** Reach for `reduce` when the operation genuinely is a
  fold, not to avoid writing a loop.
- **Do not split functions to hit a line count.** One coherent 40-line function beats four
  10-line ones with invented names and a call graph to trace.
- **`?.` and `??` are good; a five-link optional chain is not.** If absence is meaningful, handle
  it explicitly.
- **No abbreviated identifiers.** `bedroomSignal`, not `bdSig`.
- **Keep destructuring simple.** Renames, defaults and nesting in one pattern is a puzzle.

Not idiomatic *here*, however common elsewhere: classes with inheritance, decorators, getters that
do work, point-free style, currying, heavy functional composition.

**Working style:** build one module at a time, with its tests, and stop. Do not scaffold five files
ahead. I review each before the next starts.

---

## Runtime

**Node 26 or later, and it must be an official nodejs.org build.** Homebrew compiles its node
without Temporal (it conflicts with their shared ICU library), so `src/temporal-guard.ts` — the
first import in `main.ts` — refuses to start with a sentence naming the fix instead of dying on a
bare `ReferenceError`. The version buys four things with no flag and no build step: `node:sqlite`,
native type stripping, `node:test`, and `Temporal`. TypeScript is only ever run `--noEmit`, and is
pinned to 6 because it is the first release whose `lib` knows Temporal.

**Every instant in the domain is a `Temporal.Instant` and every tunable span a
`Temporal.Duration`**, so an instant, a duration and a fan level are three different types rather
than three numbers. Spans become numbers only at the platform's door — `setTimeout`,
`AbortSignal.timeout` — one `total()` call at the top of the module that owns the timer.

**Anything needing a local hour reads `TIME_ZONE` from `config.ts`** (the flat's IANA zone), never
the host's clock configuration. Temporal handles the DST transitions; a fixed offset would not.

**Runtime dependencies are `hono` and `@hono/node-server`, and a third needs asking.** The bar:
something that absorbs boilerplate rather than decisions. That is why the framework stops at
routing, body plumbing and the onboarding pages' HTML escaping, while every narrowing, the OAuth
state and the precedence rule remain this project's own code.

**Modbus is hand-rolled**, not a library. We need exactly two function codes against a documented
register map. A general Modbus library is several thousand lines of protocol we do not use.

---

## The actuator

A **2VV Daphne** HRV unit with heat recovery, controlled over **Modbus TCP**.

- Power is a discrete level: **20, 30, 40, … 100 percent**, in steps of 10.
- **20 is the floor** — a device limit. The unit is never turned off.
- **80 is the ceiling** — an *installation* limit. The intake grille in this flat cannot pass
  enough air above roughly 80%, so running higher makes the fan work against a restriction: noisy,
  inefficient, and it unbalances supply against extract on a heat-recovery unit. The device would
  accept 90 and 100. **We never send them.**
- There is a wall panel, and **the service never undoes a change made there**: nothing automatic
  moves the fan, so the panel and the API are two hands on the same dial. A panel change is
  *visible* — `GET /api/unit/level` reads the unit live — but not recorded, because nothing polls
  the unit.

**Protocol facts**, every one confirmed against the real unit:

| | |
|---|---|
| Address | `192.168.0.65:502` |
| Unit / slave id | `1` |
| Fan-speed register | **21001** on the wire |
| Value encoding | percent × 10 — `400` means 40% |
| Set | FC6, write single register |
| Read back | FC3, read holding registers |

**The register is 21001, not the 21002 the documentation gives.** The usual Modbus convention
clash: documentation numbers registers from 1, the wire numbers them from 0. **This is not a bug
and must not be "corrected".** A comment at the call site says so.

The timeout, retry count and retry pause live in `main.ts` and are argued at those constants. Two
properties they have to keep: the attempt budget covers *connecting as well as answering*, and the
pause between attempts is long enough that a retry is genuinely a second try.

**Read and command ranges genuinely differ, so they are two types** — `Level` (what the unit can
report, including a wall-panel 90) and `CommandedLevel` (what we may send) in `domain/level.ts`.
`CommandedLevel` is assignable to `Level` with no conversion, so `read()` returns `Level` and
`set()` accepts only `CommandedLevel`, and **commanding 90 is a compile error rather than a runtime
check someone has to remember to write.**

**The runtime guard is narrowed once, at the edge, and nowhere else.** `POST /api/unit/level` is
the only way a level enters this process from outside, and `assertCommandedLevel` stands there. Do
not add a second check at the Modbus write site: two runtime checks of one value is two places to
keep in agreement, and one type whose signature says `CommandedLevel` while its body says it does
not believe it.

---

## Rules the data keeps

**Canonical units, fixed.** Never store a value in anything else; conversion happens in the
adapter, at the edge.

| Kind | Unit |
|---|---|
| `temperature` | °C |
| `humidity` | % RH |
| `co2` | ppm |
| `pm1`, `pm2_5`, `pm4`, `pm10` | µg/m³ |
| `voc_index`, `nox_index` | Sensirion index, 1–500 |

- **Every table is append-only. There is no mutable row in the database at all.** A row is written
  once, so nothing in the file can be half-updated and any backup is consistent by construction.
  The property is load-bearing: the one thing that genuinely must mutate — each vendor's refresh
  token — lives in a file precisely so the database does not have to give this up.
- **`measured_at` and `received_at` are never conflated**, and **freshness is always judged on
  `measured_at`.** Readings arrive minutes to hours after they were taken.
- **Freshness is per source, never global.** A 20-minute-old Tado reading is healthy — that is its
  heartbeat — while a Netatmo silent for 20 minutes has missed two refreshes and is not. One
  global window cannot judge both, in either direction. This is a load-bearing design constraint,
  not a detail.
- **Never average two instruments.** Precedence is an ordered list per `(room, kind)` and the first
  fresh source wins. The bedroom's Tado valve head sits on the radiator and reads warm, the Netatmo
  stands across the room, and a mean describes neither.
- **Store everything, control on a subset.** All nine SEN66 measurements are persisted even though
  only CO₂ will drive the unit. Collection is the point of the system — do not "optimise" the
  unused kinds away.
- **Sensors are never deleted from `config.ts`**; decommissioning means dropping them from the
  precedence lists and setting `isActive: false`. **The precedence lists are the only thing that
  decides who is consulted** — do not add a second switch.
- **Relocating a sensor means a new sensor id.** Editing the room of an existing id retroactively
  relabels every historical reading. This is the one mistake that is tempting and irreversible.
- **Nothing prunes.** There is no code path that deletes a reading, and there is not to be one
  until the rollup it must derive from exists.

**Before adding a sensor or a vendor, read [`docs/sensors.md`](docs/sensors.md)** — the freshness
window and the poll interval come from an inequality against how that vendor publishes, not from
taste, and a rotating credential has a settled home.

**Before building the rollup or anything that deletes a row, read
[`docs/storage.md`](docs/storage.md)** — the prune has to derive from the rollup table rather than
from a clock, and getting that backwards destroys data permanently and silently.

---

## Rules the API keeps

- **Every instant on the wire is an ISO 8601 string, in and out. Epoch milliseconds never appear.**
  Out: UTC with milliseconds. In: an explicit zone, `Z` or an offset.
- **A zone-less timestamp, a bare date, and an impossible date are all refused**, never guessed at.
  Do not retreat to `Date.parse`, which rolls `2026-02-31` forward into March; tests pin the
  rejections.
- **Ranges are half-open: `from` included, `to` excluded.** Half-open windows are the only kind
  that tile.
- **`/api/state` reports `status` and `measuredAt`, and no age.** Two answers to one question is
  one too many.
- **Ingest is a batch, answers 200 whenever the batch was processed, with verdicts inside**, and
  **one bad reading never sinks the batch**. A status a simple node reads as "retry" would have it
  replaying poison forever.
- **Reject future timestamps, accept any past one.** `INSERT OR IGNORE` already makes replay
  idempotent at any age, and a buffered backlog is exactly what batching exists to carry.
- **A valid kind the instrument does not declare is rejected**, not stored. **A CO₂ reading below
  300 ppm is logged, never rejected** — it is the evidence of a drifted NDIR zero.
- **Both write endpoints are open on the LAN, knowingly. Do not add auth inside this process, and
  do not report its absence as a finding.** If exposure ever grows beyond the LAN, auth returns at
  the edge, in front of the whole service, and never inside this process.

**Before adding or changing an endpoint, read [`docs/api.md`](docs/api.md)** — it holds the current
surface and the argument each rule above is the short form of.

---

## Testing

**The case list is the suite itself.** Test names are written to be read as sentences, and the
reasoning behind a case is a comment above that case, where it cannot drift from the assertion it
explains.

**Before writing the tests for a new module, read [`docs/test-plan.md`](docs/test-plan.md)** — it
says which modules are written test-first and which are tested after, and carries the cases
deliberately removed and what is not tested at all.

`node:test` + `node:assert/strict`. No framework.

- The pure modules are written **test-first** — `freshness`, `precedence`, `time`. Adapters are
  tested after, against fakes, because their shape is not knowable until the real protocol has been
  spoken.
- **Time is injected**, never read from a clock inside logic. `now` arrives as a
  `Temporal.Instant` parameter; only `main.ts` calls `Temporal.Now.instant()`.
- **`assertDeepEqual` is the only deep assertion, and a test enforces it.** A `Temporal.Instant`
  keeps its state in internal slots, which `assert.deepEqual` cannot see — two *different* instants
  compare as deeply equal, so a wrong timestamp passes silently, the one way this suite could go
  green while checking nothing. The wrapper in `tests/support/deep-equal.ts` writes instants out as
  ISO strings first and passes everything else through untouched, so the rule is total rather than
  a judgement about which shapes carry an instant. `tests/conventions.test.ts` scans the suite and
  fails on any bare `assert.deepEqual`. Raw `epochMilliseconds` appears only where the number
  itself is the contract: the truncation tests, the vendor's seconds-to-milliseconds conversion,
  and the raw-SQL schema tests.
- **Fakes, not mocks.** `actuator/fake.ts` records the levels it was told to set. Sources are plain
  functions returning canned readings.
- **The cases that matter** are the failure ones: a sensor going stale mid-run, Netatmo
  unreachable, a reading exactly on a freshness boundary, a Modbus write timing out, a batch with
  one poisoned reading.

---

## Measured against the real thing

Facts that cost a live session with hardware or a vendor account. Everything here was observed,
not inferred; that is why it is recorded rather than left to the code.

| Date | What | Result |
|---|---|---|
| 2026-08-11 | Daphne, end to end | Read 50%, wrote 70%, read back 70%, wrote 50%, read back 50% — first attempt. Framing, transaction ids, register 21001 and the ×10 encoding all confirmed. |
| 2026-08-11 | Fresh TCP connection per request | Ten consecutive connections, 6–11 ms each, no refusals. The risk was a cheap embedded stack accepting one session and holding a dead one open. |
| 2026-08-11 | Connect timeout | Deleting it made a test take exactly 75 seconds — the OS default for an address that stops answering SYNs. Connecting needs its own bound inside the attempt budget. |
| 2026-08-14 | Netatmo expired access token | HTTP **403** carrying Netatmo's own `error.code` **3** — not the 401 an OAuth API is usually assumed to answer with. Both halves are checked because both were observed. A 403 with any other code is a permission and is not retried. |
| 2026-08-14 | Tado expired/absent access token | Plain **401**, all three variants (absent, garbage, expired). Status alone triggers refresh-and-retry; no body is read. A 403 is a permission and is reported as itself. |
| 2026-08-14 | Tado refresh-and-retry, live | Ran through a token expiry at 08:13: one 401, one refresh, one retry, no log line, no missed reading, rotated token on disk behind it. |
| 2026-08-14 | Tado `zoneStates` envelope | `{"zoneStates": {"1": {…}, "2": {…}, "5": {…}}}`, keyed by zone id as a string, byte for byte the same state a per-zone `/zones/{id}/state` returns. One request for the whole flat. |
| 2026-08-14 | Tado zone ids | Read from `GET /homes/1819708/zones`. Not consecutive: 2 living room, 5 kids' room, 1 bedroom. |
| 2026-08-14 | Tado `link.state` | The real value is `ONLINE`. Nothing reads the field — see `tado.ts` for why. |
| 2026-08-14 | Tado publication gaps | 6 to 19.7 minutes across three zones over 45 minutes. The 20-minute heartbeat holds as the upper bound, which is what the 25-minute window was sized against. |
| 2026-08-14 | Tado per-zone stamps | Three zones stamped 07:41, 07:46 and 07:52 in one answer. Temperature and humidity share one stamp within a zone; the adapter still keeps each field's own. |

---

## Open questions

These are unresolved. Do not invent answers — ask.

1. **The rest of the Daphne register map.** Fan speed at wire 21001 is confirmed. Every other
   register is unprobed.

   The −1 against documentation is demonstrated for exactly **one** register, so **no global −1
   rule may be assumed**. Every new register gets probed individually: read both N and N−1 and see
   which answers sensibly.

   There is a loose claim that **the register immediately after fan speed is temperature**, and it
   is inference rather than evidence. **One FC3 read of wire 21002 settles it.** A value near
   200–250 means temperature at ×10; a value tracking the fan level means the claim was wrong.

   **Register 14000 is pure hearsay** — a number attached to nothing that was ever probed, and its
   claim of "direct addressing" contradicts the −1 rule besides. It is a research note, not a
   finding.
2. **Does the unit accept only multiples of 10, or does it round?** We only ever write valid
   `Level` values, so this is a curiosity rather than a risk — but worth knowing when reading back
   a level the wall panel set.
3. **What a Tado `HOT_WATER` zone's `sensorDataPoints` looks like.** This account has no such zone
   to ask.

---

## Out of scope — deliberately

Stated so the gaps read as decisions rather than omissions:

- **The CO₂ automation.** Intended, previously implemented, removed until real data exists to
  design it against.
- **Docker.** Comes later; the service runs on a home server eventually.
- **Charts and UI.** JSON endpoints only.
- **Controlling heating.** Tado keeps that. We read its sensors and nothing more.
- **Users, auth, multi-home.** Single home, single occupant-operator, trusted LAN.
- **Retention, downsampling, rollups.** Designed and costed, not built. Nothing prunes.
- **A `rooms` / `sensors` table.** Topology is config-only, on purpose.
- **Runtime topology changes.** Adding a sensor is a config edit and a restart, not an API call.
