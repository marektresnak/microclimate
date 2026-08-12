import assert from 'node:assert/strict';

/**
 * `assert.deepEqual` cannot see inside a `Temporal.Instant`: the state lives in
 * internal slots, so two *different* instants compare as deeply equal and a
 * wrong timestamp passes silently. Every deep assertion on an instant-bearing
 * shape goes through here, which writes the instants out as ISO strings first —
 * where equality means what it says.
 */
export function assertDeepEqual(actual: unknown, expected: unknown): void {
  assert.deepEqual(instantsWrittenOut(actual), instantsWrittenOut(expected));
}

function instantsWrittenOut(value: unknown): unknown {
  if (value instanceof Temporal.Instant) return value.toString();
  if (Array.isArray(value)) return value.map(instantsWrittenOut);

  // Plain objects only: class instances are left alone rather than flattened
  // into something deepEqual would judge by the wrong rules.
  if (value !== null && typeof value === 'object' && value.constructor === Object) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, instantsWrittenOut(entry)]),
    );
  }

  return value;
}
