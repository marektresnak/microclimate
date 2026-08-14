import type { Reading } from '../domain/measurement.ts';

/**
 * The seam every vendor adapter injects, and the one the onboarding routes take
 * too: `fetch` itself, passed as an ordinary parameter. Everything above it is
 * protocol logic testable against canned responses, and only main.ts ever passes
 * the real thing — exactly as `OpenStream` works in the Modbus client.
 *
 * It lives here, beside the source interface, because it belongs to no vendor:
 * declared inside either adapter, the other would have to import that vendor's
 * module for a type alias.
 */
export type FetchLike = typeof fetch;

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
