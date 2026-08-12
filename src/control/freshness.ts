import type { Reading } from '../domain/measurement.ts';
import type { RoomSignal } from '../domain/signal.ts';

/**
 * How much one reading is currently worth, judged against that instrument's own
 * window. The window is a parameter rather than a lookup because the caller
 * knows which source it asked about, and because a single global staleness
 * window cannot judge a 30-second Tado reading and a 6-minute Netatmo one.
 */
export function toRoomSignal(
  reading: Reading | undefined,
  now: Temporal.Instant,
  window: Temporal.Duration,
): RoomSignal {
  if (reading === undefined) return { status: 'missing' };

  // On measuredAt, never receivedAt. A reading that arrived one second ago but
  // was taken an hour ago is an hour old, and treating it as fresh is how a
  // replayed backlog would drive the fan.
  const staleAfter = reading.measuredAt.add(window);

  // A reading from the near future — clock skew between us and the instrument —
  // sits before staleAfter as well, so it reads fresh. That is the right answer:
  // taking a healthy sensor offline over a couple of seconds of drift is the
  // worse failure.
  const status = Temporal.Instant.compare(now, staleAfter) <= 0 ? 'fresh' : 'stale';

  return {
    status,
    sourceId: reading.sourceId,
    value: reading.value,
    measuredAt: reading.measuredAt,
  };
}
