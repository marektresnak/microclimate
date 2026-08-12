/**
 * The API speaks ISO 8601; the store speaks integer epoch milliseconds. These
 * two functions are the whole of the conversion, and they sit at the edge for
 * the same reason a unit conversion does.
 *
 * The column stays an integer because `measured_at` is part of a uniqueness
 * constraint, and an integer has exactly one representation per instant. That
 * argument is about the *column*, not about the wire: two spellings of one
 * instant both parse to the same integer here, so dedup never sees the
 * difference and the API is free to be readable.
 */

// An ISO 8601 instant with an explicit zone. Seconds and their fraction are
// optional; the zone is not.
//
// A zone-less string like `2026-08-12T09:36:00` is refused rather than guessed
// at. `Date.parse` reads that form as the *host's* local time, so the same
// request would mean a different instant on the server than on the laptop that
// sent it, and would shift by an hour twice a year besides — the machine
// dependence quiet hours already refuses. A range bound that is silently wrong
// is worse than one that is rejected.
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** How the API writes an instant: always UTC, always milliseconds. */
export function toIsoUtc(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/**
 * The instant an ISO 8601 string names, or undefined if it does not name one.
 * An explicit offset is accepted and normalised — `2026-08-12T11:36:00+02:00`
 * and `2026-08-12T09:36:00Z` are the same moment and yield the same number.
 */
export function parseInstant(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;

  const match = ISO_INSTANT.exec(value);
  if (match === null) return undefined;

  // Measured rather than assumed: `Date.parse` rejects month 13, hour 25 and
  // minute 61, but silently rolls `2026-02-31` forward into March. Day of the
  // month is the only field that does this, and rebuilding the date is what
  // catches it — including the leap years a table of month lengths would have
  // to get right on its own.
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (new Date(Date.UTC(year, month - 1, day)).getUTCDate() !== day) return undefined;

  const epochMs = Date.parse(value);
  return Number.isNaN(epochMs) ? undefined : epochMs;
}
