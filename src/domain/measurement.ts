import type { SensorId } from '../config.ts';

// TEXT in the database for the same reason this is a plain union here: a new
// measurement is a new member, never a migration. Canonical units are fixed and
// documented in CLAUDE.md — conversion happens in the adapter, at the edge.
export type MeasurementKind =
  | 'temperature' // °C
  | 'humidity' // % RH
  | 'co2' // ppm
  | 'pm1' // µg/m³
  | 'pm2_5' // µg/m³
  | 'pm4' // µg/m³
  | 'pm10' // µg/m³
  | 'voc_index' // Sensirion index, 1-500
  | 'nox_index'; // Sensirion index, 1-500

/** The runtime companion of the union, for the places that have to iterate or
 * validate — where a type alone cannot help, because Node strips it. */
export const MEASUREMENT_KINDS: readonly MeasurementKind[] = [
  'temperature',
  'humidity',
  'co2',
  'pm1',
  'pm2_5',
  'pm4',
  'pm10',
  'voc_index',
  'nox_index',
];

/** One fact that was true at a point in time, from a named instrument. */
export interface Reading {
  readonly sourceId: SensorId;
  readonly kind: MeasurementKind;
  readonly value: number;

  // Never conflated. Netatmo reports minutes after it measured, and a push node
  // replaying a buffered backlog delivers hours-old readings in one request.
  // Freshness is always judged on measuredAt.
  readonly measuredAt: number; // epoch ms, UTC — when the instrument took it
  readonly receivedAt: number; // epoch ms, UTC — when we learned about it
}
