import type { Reading } from '../domain/measurement.ts';

/**
 * Something that can be asked for readings on its own cadence.
 *
 * Pull adapters implement this — Tado and Netatmo poll a vendor API. Push nodes
 * do not: the SEN66 boards POST to the ingest endpoint, so they never appear
 * here, which is why there is no `transport` field to branch on.
 *
 * `poll` is allowed to reject. The loop isolates each source, because one vendor
 * being down must not stop the others being read or a decision being made.
 */
export interface SensorSource {
  readonly name: string;
  readonly pollIntervalMs: number;
  poll(now: number): Promise<readonly Reading[]>;
}
