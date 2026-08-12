import { CONTROL } from '../config.ts';

/**
 * The time of day at an instant, as a fractional hour: 21:30 is 21.5.
 *
 * The zone is explicit so that behaviour does not depend on how the host is
 * configured, and does not shift by an hour twice a year if the host is ever
 * UTC. Temporal handles the DST transitions; a fixed offset would not.
 */
export function localHourOfDay(now: Temporal.Instant): number {
  const local = now.toZonedDateTimeISO(CONTROL.timeZone);
  return local.hour + local.minute / 60;
}
