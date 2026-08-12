import { CONTROL, ROOM_IDS } from '../config.ts';
import type { RoomId, SensorId } from '../config.ts';
import { localHourOfDay } from '../domain/clock.ts';
import type { Decision, Snapshot } from '../domain/decision.ts';
import { MAX_COMMANDED_LEVEL, MIN_LEVEL, toCommandedLevel } from '../domain/level.ts';
import type { CommandedLevel } from '../domain/level.ts';
import type { RoomSignal } from '../domain/signal.ts';

/**
 * What the air demands, and whether anyone is asleep. Pure: time arrives as a
 * parameter, nothing here reads a clock or touches the database, and the sleep
 * cap is deliberately *not* applied — that belongs to the limiter, in one place.
 */
export function decide(snapshot: Snapshot, now: Temporal.Instant): Decision {
  const reasons: string[] = [];
  const sleeping = decideSleep(snapshot, now, reasons);

  const worst = worstFreshCo2(snapshot.co2ByRoom);
  if (worst === undefined) {
    // Moderate continuous ventilation is the safe answer when blind: quieter
    // than boosting, safer than idling. Never the minimum.
    reasons.push(`no fresh CO2 in any room — holding the safe default ${CONTROL.safeDefaultLevel}%`);
    return { desiredLevel: CONTROL.safeDefaultLevel, sleeping, reasons };
  }

  const rounded = Math.round(worst.value);
  reasons.push(`${worst.room} at ${rounded} ppm (${worst.sourceId}) is the worst fresh reading`);

  const fromBand = bandLevel(worst.value);
  const desiredLevel = withHysteresis(worst.value, snapshot.currentLevel);
  reasons.push(`the band puts ${rounded} ppm at ${fromBand}%`);

  // Says what the bias did, not whether the level moved. Whether anything is
  // held is the limiter's sentence to write.
  if (desiredLevel !== fromBand) {
    reasons.push(`${desiredLevel}% after ${CONTROL.hysteresisPpm} ppm of hysteresis in the direction of travel`);
  }

  return { desiredLevel, sleeping, reasons };
}

/**
 * The proportional band: a straight line from the floor at `C_LO` to the ceiling
 * at `C_HI`, quantised onto the seven legal steps. No integral term and no
 * accumulated state — CO2 is a limit to stay under, not a setpoint to chase, so
 * the unit settling somewhere inside the band rather than on a number is the
 * intended behaviour rather than an error to wind out.
 */
export function bandLevel(co2Ppm: number): CommandedLevel {
  const span = CONTROL.bandHighPpm - CONTROL.bandLowPpm;
  const fraction = (co2Ppm - CONTROL.bandLowPpm) / span;
  const clamped = Math.min(Math.max(fraction, 0), 1);

  return toCommandedLevel(MIN_LEVEL + clamped * (MAX_COMMANDED_LEVEL - MIN_LEVEL));
}

/**
 * Hysteresis at every step boundary, done by biasing the reading in the
 * direction of travel rather than as a separate state machine: to move up, CO2
 * must be a further `CO2_HYSTERESIS` past the boundary, and to move down the
 * same below it. A reading between the two biases moves nothing.
 */
function withHysteresis(co2Ppm: number, current: CommandedLevel): CommandedLevel {
  const ifRising = bandLevel(co2Ppm - CONTROL.hysteresisPpm);
  if (ifRising > current) return ifRising;

  const ifFalling = bandLevel(co2Ppm + CONTROL.hysteresisPpm);
  if (ifFalling < current) return ifFalling;

  return current;
}

/**
 * Quiet hours assert sleep. Bedroom CO2 only *extends* an assertion that already
 * holds, and the difference is the whole design.
 *
 * Asserting on CO2 alone self-latches. The band puts 50% near 900 ppm, so any
 * reading high enough to demand more than 50 has already crossed the sleep
 * threshold and capped the response at 50 — and with the bedroom door open, an
 * ordinary busy evening reaches that with nobody in bed. As an extender the term
 * cannot false-trigger, because it requires having already been asleep, while
 * still doing the job it exists for: holding the cap past 07:00 until the room
 * actually clears, rather than lifting it because a clock struck.
 *
 * The bedroom is never merely occupied in this flat — nobody sits in it — which
 * is what makes CO2 readable as "still asleep" at all. If the room's use ever
 * changes, delete the clause.
 */
function decideSleep(snapshot: Snapshot, now: Temporal.Instant, reasons: string[]): boolean {
  if (inQuietHours(now)) {
    reasons.push(
      `quiet hours ${CONTROL.quietHoursStartHour}:00-${CONTROL.quietHoursEndHour}:00 ${CONTROL.timeZone}`,
    );
    return true;
  }

  const bedroom = snapshot.co2ByRoom.bedroom;
  const stillStuffy =
    snapshot.wasSleeping && bedroom.status === 'fresh' && bedroom.value > CONTROL.sleepCo2Ppm;

  if (stillStuffy) {
    reasons.push(`bedroom has not cleared — sleep continues past quiet hours`);
    return true;
  }

  if (snapshot.wasSleeping) reasons.push('sleep released');
  return false;
}

// 22:00-07:00 wraps midnight, so this is `||`. Written with `&&` it is always
// false and the night cap silently never fires.
function inQuietHours(now: Temporal.Instant): boolean {
  const hour = localHourOfDay(now);
  return hour >= CONTROL.quietHoursStartHour || hour < CONTROL.quietHoursEndHour;
}

export interface WorstReading {
  readonly room: RoomId;
  readonly sourceId: SensorId;
  readonly value: number;
}

/**
 * Worst room wins. Stale and missing readings are excluded entirely, in both
 * directions: a stale low reading is never treated as good air, and a stale high
 * one never pins the unit at the ceiling.
 *
 * Exported because the pinned-at-the-ceiling diagnostic asks the same question
 * the demand curve does, and two answers to it could disagree.
 */
export function worstFreshCo2(co2ByRoom: Record<RoomId, RoomSignal>): WorstReading | undefined {
  let worst: WorstReading | undefined;

  for (const room of ROOM_IDS) {
    const signal = co2ByRoom[room];
    if (signal.status !== 'fresh') continue;

    if (worst === undefined || signal.value > worst.value) {
      worst = { room, sourceId: signal.sourceId, value: signal.value };
    }
  }

  return worst;
}
