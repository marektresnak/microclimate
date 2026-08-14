import assert from 'node:assert/strict';

/**
 * `assert.deepEqual` cannot see inside a `Temporal.Instant` or a
 * `Temporal.Duration`: the state lives in internal slots, so two *different*
 * instants — or two freshness windows minutes apart — compare as deeply equal
 * and a wrong value passes silently. Every deep assertion goes through here,
 * which writes both types out as ISO text first, where equality means what it
 * says. Duration is in for the same reason as Instant and one more: it has no
 * `.equals` method at all, so deep equality is the comparison someone reaches
 * for when `Temporal.Duration.compare` is the only correct one.
 *
 * Because both sides are projected, the expected side can simply BE the
 * written-out text: `assertDeepEqual(row.measuredAt, '2026-08-07T00:00:00Z')`.
 * Spell it the way `toString()` does — seconds always, no trailing zeros, `Z`,
 * and `PT15M` for a duration — or the strings will honestly differ. A duration
 * therefore compares by spelling rather than by length: `{ hours: 1 }` and
 * `{ minutes: 60 }` are one span in two texts. That is the side to err on for a
 * number a reviewer reads out of config.
 *
 * What the projection gives up: an instant and its own ISO text are
 * indistinguishable here, so this cannot assert that a field carries a real
 * instant rather than a pre-formatted string. That drift is a type error, and
 * `npm test` typechecks before it runs a thing.
 */
export function assertDeepEqual(actual: unknown, expected: unknown, message?: string): void {
  assert.deepEqual(temporalWrittenOut(actual), temporalWrittenOut(expected), message);
}

function temporalWrittenOut(value: unknown): unknown {
  if (value instanceof Temporal.Instant || value instanceof Temporal.Duration) {
    return value.toString();
  }
  if (Array.isArray(value)) return value.map(temporalWrittenOut);

  // Plain objects only: class instances are left alone rather than flattened
  // into something deepEqual would judge by the wrong rules.
  if (value !== null && typeof value === 'object' && value.constructor === Object) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, temporalWrittenOut(entry)]),
    );
  }

  return value;
}
