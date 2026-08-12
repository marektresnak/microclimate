import { CONTROL } from '../config.ts';
import type { ControlOutcome, Decision } from '../domain/decision.ts';
import { MAX_COMMANDED_LEVEL, stepDown } from '../domain/level.ts';
import type { CommandedLevel } from '../domain/level.ts';

/**
 * Everything between a demanded level and the wire: the sleep cap, then the one
 * timing rule the controller has.
 *
 * That rule is asymmetric on purpose. Increases apply immediately at any
 * distance, because up is the direction where the air is already bad. Decreases
 * move one step per `minDwell`, because a fast retreat is what lets CO2
 * crash and rebound into the next boost — a square wave with a twenty-minute
 * period, which is the behaviour this project exists to eliminate.
 *
 * Pure: `now` and `lastChangeAt` are parameters, and the caller carries the
 * returned `lastChangeAt` into the next cycle.
 */
export function limit(
  decision: Decision,
  currentLevel: CommandedLevel,
  lastChangeAt: Temporal.Instant | undefined,
  now: Temporal.Instant,
): ControlOutcome {
  const cap = decision.sleeping ? CONTROL.sleepMaxLevel : MAX_COMMANDED_LEVEL;

  // Checked against where the unit *is*, not only against a freshly computed
  // target: evening cooking leaving it at 70 must not run all night because
  // demand sat mid-range and produced nothing new to compare against.
  if (currentLevel > cap) {
    return {
      level: cap,
      write: true,
      // Deliberately not `now`. Starting a fresh dwell here would delay the
      // genuine walk down that follows the drop, by ten minutes, for nothing.
      lastChangeAt,
      reasons: [...decision.reasons, `asleep — dropping ${currentLevel}% to the ${cap}% cap in one move`],
    };
  }

  const target = decision.desiredLevel > cap ? cap : decision.desiredLevel;

  if (target === currentLevel) {
    return {
      level: currentLevel,
      write: false,
      lastChangeAt,
      reasons: [...decision.reasons, `already at ${currentLevel}%`],
    };
  }

  if (target > currentLevel) {
    return {
      level: target,
      write: true,
      lastChangeAt: now,
      reasons: [...decision.reasons, `raising ${currentLevel}% to ${target}%`],
    };
  }

  if (!dwellElapsed(lastChangeAt, now)) {
    return {
      level: currentLevel,
      write: false,
      lastChangeAt,
      reasons: [...decision.reasons, `holding ${currentLevel}% — the dwell since the last change has not elapsed`],
    };
  }

  const stepped = stepDown(currentLevel);
  return {
    level: stepped,
    write: true,
    lastChangeAt: now,
    reasons: [...decision.reasons, `stepping ${currentLevel}% down to ${stepped}%`],
  };
}

function dwellElapsed(lastChangeAt: Temporal.Instant | undefined, now: Temporal.Instant): boolean {
  // Nothing has changed yet — a genuine first run, and also every restart, since
  // the timer lives in memory. Acting at once is right in both cases: the unit's
  // level is read at startup, so the first decision is as informed as any later
  // one, and a restart during bad air should respond rather than wait (Q4).
  if (lastChangeAt === undefined) return true;

  return Temporal.Instant.compare(now, lastChangeAt.add(CONTROL.minDwell)) >= 0;
}
