/**
 * The API speaks ISO 8601; the domain carries `Temporal.Instant`; the store
 * keeps integer epoch milliseconds. These two functions are the whole of the
 * wire conversion, and they sit at the edge for the same reason a unit
 * conversion does.
 *
 * The column stays an integer because `measured_at` is part of a uniqueness
 * constraint, and an integer has exactly one representation per instant. The
 * parse enforces the same invariant on the way in: Temporal reads nanosecond
 * precision, so the result is truncated to the millisecond — one instant, one
 * representation, from the edge to the column, and no two in-memory instants
 * the store would collapse into one row.
 *
 * The grammar is the platform's — `Temporal.Instant.from`, which is RFC 9557:
 * an instant with an explicit zone. Everything the hand-rolled parser used to
 * enforce still holds: a zone-less timestamp is refused (it would mean a
 * different moment on every machine), a bare date is refused, and a date that
 * does not exist (2026-02-31) is refused rather than rolled forward. What
 * widens is spelling tolerance — a space or lowercase separator, a bracketed
 * zone annotation, the compact form. All of them are unambiguous instants, so
 * the one rule survives: name a moment explicitly or be refused.
 */

/** How the API writes an instant: always UTC, always milliseconds — byte for
 * byte what the `measured_at_iso` generated column computes. */
export function toIsoUtc(instant: Temporal.Instant): string {
  return instant.toString({ fractionalSecondDigits: 3 });
}

/** The instant an ISO 8601 string names — truncated to the millisecond the
 * store thinks in — or undefined if it does not name one. */
export function parseInstant(value: unknown): Temporal.Instant | undefined {
  if (typeof value !== 'string') return undefined;

  try {
    const parsed = Temporal.Instant.from(value);
    return Temporal.Instant.fromEpochMilliseconds(parsed.epochMilliseconds);
  } catch {
    return undefined;
  }
}
