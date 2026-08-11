import { PRECEDENCE, SENSORS } from '../config.ts';
import type { RoomId, SensorId } from '../config.ts';
import { toRoomSignal } from '../control/freshness.ts';
import type { MeasurementKind, Reading } from './measurement.ts';
import type { RoomSignal } from './signal.ts';

/**
 * One value per (room, kind), resolved by the ranked list in config.
 *
 * This is the rule the controller and `/api/state` share. One implementation,
 * two consumers: the dashboard therefore always shows what the controller is
 * actually seeing, and the two disagreeing is impossible by construction rather
 * than by discipline.
 *
 * The ranked list is the whole of who gets consulted. Decommissioning an
 * instrument means taking it out of those lists — there is deliberately no
 * second switch here that could disagree with them.
 */
export function resolveSignal(
  room: RoomId,
  kind: MeasurementKind,
  readings: readonly Reading[],
  now: number,
): RoomSignal {
  const ranked = PRECEDENCE[room][kind] ?? [];

  // Kept as we go, in case nothing turns out to be fresh (Q3).
  let newestStale: RoomSignal = { status: 'missing' };
  let newestStaleMeasuredAt = Number.NEGATIVE_INFINITY;

  for (const sourceId of ranked) {
    const sensor = SENSORS[sourceId];
    const latest = newestReadingFrom(readings, sourceId, kind);
    const signal = toRoomSignal(latest, now, sensor.freshnessWindowMs);

    if (signal.status === 'fresh') return signal;

    if (signal.status === 'stale' && signal.measuredAt > newestStaleMeasuredAt) {
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
    if (newest === undefined || reading.measuredAt > newest.measuredAt) newest = reading;
  }

  return newest;
}
