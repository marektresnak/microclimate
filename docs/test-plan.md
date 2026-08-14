# Test plan

## Strategy

| Module | Approach | Why |
|---|---|---|
| `freshness`, `precedence`, `time` | **Test-first** | Pure, enumerable, no IO. This is what to read first. |
| `ingest`, `store` | Test-first for rules, after for wiring | The validation and idempotency rules are known; the SQL shape is not. |
| `sources/*`, `actuator/modbus-tcp` | **Test-after**, against fakes | The shape is not knowable until the real protocol has been spoken. |
| `sources/collector`, `http/server` | **Test-after**, integration with fakes | Wiring. Tested for resilience, not logic. |

## Conventions

- `node:test` + `node:assert/strict`. No framework.
- **Time is a parameter.** A fixed `now` — a `Temporal.Instant` since 2026-08-12 — is passed in,
  and no logic under test reads a clock. So no test sleeps and no test is flaky.
- **`assertDeepEqual` is the only deep assertion**, enforced by `conventions.test.ts`. A bare
  `assert.deepEqual` cannot see an instant's internal slots, so two *different* instants compare
  as deeply equal and a wrong timestamp passes silently. The full argument is in CLAUDE.md,
  "Testing".
- **Raw `epochMilliseconds` only where the number itself is the contract**: millisecond
  truncation, the vendor's epoch seconds, raw SQL.
- **Fakes, not mocks.** `actuator/fake.ts` records the levels it was told to set; sources are
  plain functions returning canned readings. Nothing asserts on a mocking library's call counts.
- **Table-driven where the cases are uniform** — freshness windows, zone spellings, link states;
  individually named tests where each case makes a distinct point.
- **Test names state the behaviour, not the function**: *"treats an offset timestamp as the
  instant it names"*, not *"test ingest 3"*. This is the convention that lets the suite stand in
  for the case list that used to be here.
- **A case that cannot fail is not covering anything.** The zone-handling cases are checked by
  mutation, re-run 2026-08-14: making `parseInstant` read the wall clock and ignore the offset
  fails six tests — two in `time`, three in `ingest`, one round trip through the server — and
  moves nothing else in the suite.

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
