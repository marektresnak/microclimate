import { CONTROL } from '../config.ts';

// The zone is explicit so that behaviour does not depend on how the host is
// configured, and does not shift by an hour twice a year if the host is ever
// UTC. Intl handles the DST transitions; a fixed offset would not.
const inConfiguredZone = new Intl.DateTimeFormat('en-GB', {
  timeZone: CONTROL.timeZone,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** The time of day at an instant, as a fractional hour: 21:30 is 21.5. */
export function localHourOfDay(now: number): number {
  const parts = inConfiguredZone.formatToParts(new Date(now));
  return partAsNumber(parts, 'hour') + partAsNumber(parts, 'minute') / 60;
}

function partAsNumber(parts: readonly Intl.DateTimeFormatPart[], type: string): number {
  const part = parts.find((candidate) => candidate.type === type);

  // Loudly. A silent NaN here would make every quiet-hours comparison false, and
  // the only symptom would be a loud fan at 3am.
  if (part === undefined) throw new Error(`Intl reported no ${type} for ${CONTROL.timeZone}`);

  return Number(part.value);
}
