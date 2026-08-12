import type { RoomId } from '../config.ts';
import type { CommandedLevel } from './level.ts';
import type { RoomSignal } from './signal.ts';

/**
 * Everything the policy is allowed to look at. `currentLevel` and `wasSleeping`
 * are in here rather than being read from anywhere because both rules that need
 * them are relative to the previous cycle: hysteresis asks which direction we
 * would be travelling, and the sleep term can only extend a sleep that was
 * already asserted.
 */
export interface Snapshot {
  readonly co2ByRoom: Record<RoomId, RoomSignal>;
  readonly currentLevel: CommandedLevel;
  readonly wasSleeping: boolean;
}

/** What the air demands, and whether anyone is asleep. Not what we will do. */
export interface Decision {
  readonly desiredLevel: CommandedLevel;
  readonly sleeping: boolean;
  readonly reasons: readonly string[];
}

/** What we will actually do about it. A decision you cannot explain afterwards
 * is a decision you cannot debug, so the reasons travel with the outcome into
 * both the log and `/api/state`. */
export interface ControlOutcome {
  readonly level: CommandedLevel;
  readonly write: boolean;
  // Carried forward by the caller. Undefined means nothing has changed yet, which
  // is both a genuine first run and every restart — the dwell timer is in memory.
  readonly lastChangeAt: Temporal.Instant | undefined;
  readonly reasons: readonly string[];
}
