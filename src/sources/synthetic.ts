import type { SensorId } from '../config.ts';
import { localHourOfDay } from '../domain/clock.ts';
import type { MeasurementKind, Reading } from '../domain/measurement.ts';
import type { SensorSource } from './source.ts';

/**
 * Plausible curves on a schedule, so `npm start` runs, collects and serves
 * without any hardware attached.
 *
 * **A demo, not a simulation of the flat.** The curves follow the clock and
 * react to nothing — they exist so every endpoint has something real-shaped
 * to say, not so anyone can draw conclusions from them.
 */
interface DailyPoint {
  readonly hour: number;
  readonly value: number;
}

// Overnight the bedroom fills up, the morning clears it, the flat idles through
// the day and fills again over the evening.
const CO2_THROUGH_THE_DAY: readonly DailyPoint[] = [
  { hour: 0, value: 1050 },
  { hour: 4, value: 1250 },
  { hour: 7, value: 1200 },
  { hour: 9, value: 700 },
  { hour: 13, value: 600 },
  { hour: 17, value: 720 },
  { hour: 20, value: 900 },
  { hour: 22, value: 780 },
  { hour: 24, value: 1050 },
];

const TEMPERATURE_THROUGH_THE_DAY: readonly DailyPoint[] = [
  { hour: 0, value: 20.5 },
  { hour: 6, value: 19.8 },
  { hour: 9, value: 21.0 },
  { hour: 15, value: 22.4 },
  { hour: 20, value: 22.0 },
  { hour: 24, value: 20.5 },
];

const HUMIDITY_THROUGH_THE_DAY: readonly DailyPoint[] = [
  { hour: 0, value: 52 },
  { hour: 7, value: 55 },
  { hour: 12, value: 44 },
  { hour: 18, value: 47 },
  { hour: 24, value: 52 },
];

const NETATMO_REFRESH = Temporal.Duration.from({ minutes: 8 });
const TADO_REFRESH = Temporal.Duration.from({ minutes: 1 });
const POLL_INTERVAL = Temporal.Duration.from({ minutes: 1 });

export function createSyntheticNetatmo(): SensorSource {
  return {
    name: 'synthetic-netatmo',
    pollInterval: POLL_INTERVAL,

    async poll(now) {
      // Netatmo refreshes on their side every 7-8 minutes, so polling faster
      // hands back the same reading with the same timestamp — and the store's
      // uniqueness constraint absorbs it for free. Worth being able to watch.
      const measuredAt = flooredTo(now, NETATMO_REFRESH);
      const hour = localHourOfDay(measuredAt);
      const drift = wobbleAt(measuredAt);

      return [
        reading('bedroom_netatmo', 'co2', valueAt(CO2_THROUGH_THE_DAY, hour) + drift * 25, measuredAt, now),
        reading('bedroom_netatmo', 'temperature', valueAt(TEMPERATURE_THROUGH_THE_DAY, hour) + drift * 0.3, measuredAt, now),
        reading('bedroom_netatmo', 'humidity', valueAt(HUMIDITY_THROUGH_THE_DAY, hour) + drift * 2, measuredAt, now),
      ];
    },
  };
}

// The valves read differently because they sit in different places. The offsets
// are what makes the never-average rule visible in the demo output.
const VALVES: readonly { readonly id: SensorId; readonly temperatureOffset: number }[] = [
  { id: 'living_room_tado', temperatureOffset: 0 },
  { id: 'kids_room_tado_left', temperatureOffset: 0.8 },
  { id: 'kids_room_tado_right', temperatureOffset: -0.6 },
  { id: 'bedroom_tado', temperatureOffset: -1.4 },
];

export function createSyntheticTado(): SensorSource {
  return {
    name: 'synthetic-tado',
    pollInterval: POLL_INTERVAL,

    async poll(now) {
      const measuredAt = flooredTo(now, TADO_REFRESH);
      const hour = localHourOfDay(measuredAt);
      const drift = wobbleAt(measuredAt);
      const readings: Reading[] = [];

      for (const valve of VALVES) {
        const temperature = valueAt(TEMPERATURE_THROUGH_THE_DAY, hour) + valve.temperatureOffset;
        readings.push(reading(valve.id, 'temperature', temperature + drift * 0.2, measuredAt, now));
        readings.push(reading(valve.id, 'humidity', valueAt(HUMIDITY_THROUGH_THE_DAY, hour) + drift * 1.5, measuredAt, now));
      }

      return readings;
    },
  };
}

function reading(
  sourceId: SensorId,
  kind: MeasurementKind,
  value: number,
  measuredAt: Temporal.Instant,
  receivedAt: Temporal.Instant,
): Reading {
  return { sourceId, kind, value: Math.round(value * 10) / 10, measuredAt, receivedAt };
}

// Quantised onto the vendor's refresh grid. Temporal's own round() cannot do
// this one: it requires the increment to divide its unit evenly, and eight
// minutes does not divide an hour.
function flooredTo(now: Temporal.Instant, refresh: Temporal.Duration): Temporal.Instant {
  const refreshMs = refresh.total('milliseconds');
  return Temporal.Instant.fromEpochMilliseconds(Math.floor(now.epochMilliseconds / refreshMs) * refreshMs);
}

// Deterministic, so two runs of the demo tell the same story and a poll repeated
// inside one refresh window is byte-for-byte identical.
function wobbleAt(measuredAt: Temporal.Instant): number {
  return Math.sin(measuredAt.epochMilliseconds / 720_000);
}

function valueAt(points: readonly DailyPoint[], hour: number): number {
  const first = points[0];
  if (first === undefined) throw new Error('a daily curve needs at least one point');

  let previous = first;
  for (const point of points) {
    if (point.hour >= hour) {
      const span = point.hour - previous.hour;
      if (span === 0) return point.value;
      const progress = (hour - previous.hour) / span;
      return previous.value + progress * (point.value - previous.value);
    }
    previous = point;
  }

  return previous.value;
}
