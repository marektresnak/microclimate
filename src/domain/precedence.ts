import { PRECEDENCE, SENSORS } from '../config.ts';
import type { RoomId, SensorId } from '../config.ts';
import { toRoomSignal } from './freshness.ts';
import type { MeasurementKind, Reading } from './measurement.ts';
import type { RoomSignal } from './signal.ts';

/**
 * One value per (room, kind), resolved by the ranked list in config.
 *
 * This is the one rule for what a room currently says. `/api/state` is its
 * consumer today; anything later that reads room-level values — a dashboard,
 * an automation — must come through here too, so two readers disagreeing is
 * impossible by construction rather than by discipline.
 *
 * The ranked list is the whole of who gets consulted. Decommissioning an
 * instrument means taking it out of those lists — there is deliberately no
 * second switch here that could disagree with them.
 */
export function resolveSignal(
  room: RoomId,
  kind: MeasurementKind,
  readings: readonly Reading[],
  now: Temporal.Instant,
): RoomSignal {
  const ranked = PRECEDENCE[room][kind] ?? [];

  // Kept as we go, in case nothing turns out to be fresh. Precedence encodes
  // trust, and trust only matters while a choice between live instruments
  // exists; once nothing is fresh, the best remaining information is the
  // newest reading, not the most trusted dead one.
  let newestStale: RoomSignal = { status: 'missing' };
  let newestStaleMeasuredAt: Temporal.Instant | undefined;

  for (const sourceId of ranked) {
    const sensor = SENSORS[sourceId];
    const latest = newestReadingFrom(readings, sourceId, kind);
    const signal = toRoomSignal(latest, now, sensor.freshnessWindow);

    if (signal.status === 'fresh') return signal;

    if (signal.status === 'stale' && (newestStaleMeasuredAt === undefined || Temporal.Instant.compare(signal.measuredAt, newestStaleMeasuredAt) > 0)) {
      newestStale = signal;
      newestStaleMeasuredAt = signal.measuredAt;
    }
  }

  return newestStale;
}

function newestReadingFrom(
  readings: readonly Reading[],
  sourceId: SensorId,
  kind: MeasurementKind,
): Reading | undefined {
  let newest: Reading | undefined;

  for (const reading of readings) {
    if (reading.sourceId !== sourceId) continue;
    if (reading.kind !== kind) continue;
    if (newest === undefined || Temporal.Instant.compare(reading.measuredAt, newest.measuredAt) > 0) {
      newest = reading;
    }
  }

  return newest;
}
