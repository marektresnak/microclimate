import type { Reading } from '../domain/measurement.ts';

/**
 * Something that can be asked for readings on its own cadence.
 *
 * Pull adapters implement this — Tado and Netatmo poll a vendor API. Push nodes
 * do not: the SEN66 boards POST to the ingest endpoint, so they never appear
 * here, which is why there is no `transport` field to branch on.
 *
 * `poll` is allowed to reject. The collector isolates each source, because one
 * vendor being down must not stop the others being read.
 */
export interface SensorSource {
  readonly name: string;
  readonly pollInterval: Temporal.Duration;
  poll(now: Temporal.Instant): Promise<readonly Reading[]>;
}
