// What the unit can report. A wall-panel user can put it at 90 or 100, so
// anything we read back has to be able to represent those.
export type Level = 20 | 30 | 40 | 50 | 60 | 70 | 80 | 90 | 100;

// What we are ever allowed to send. The intake grille in this flat cannot pass
// enough air above roughly 80%, so the fan would work against a restriction:
// noisy, inefficient, and it unbalances supply against extract. The device
// would accept 90 and 100. We never send them.
export type CommandedLevel = 20 | 30 | 40 | 50 | 60 | 70 | 80;

// Physical, not tuning. 20 is what the unit does; 80 is what the grille allows.
export const MIN_LEVEL: CommandedLevel = 20;
export const MAX_COMMANDED_LEVEL: CommandedLevel = 80;

const READABLE_LEVELS: readonly Level[] = [20, 30, 40, 50, 60, 70, 80, 90, 100];
const COMMANDED_LEVELS: readonly CommandedLevel[] = [20, 30, 40, 50, 60, 70, 80];

/** Narrows something that came from outside — a Modbus read, config, a request body. */
export function toLevel(value: unknown): Level | undefined {
  if (typeof value !== 'number') return undefined;
  return READABLE_LEVELS.find((level) => level === value);
}

/**
 * The runtime half of `CommandedLevel`. Node strips types rather than compiling
 * them, so the union guarantees nothing once the process is running; this is
 * what stands between a rounding mistake and 100% into a restricted grille.
 */
export function assertCommandedLevel(value: number): CommandedLevel {
  const found = COMMANDED_LEVELS.find((level) => level === value);
  if (found === undefined) {
    throw new Error(`${value} is not a commandable level (20-80 in steps of 10)`);
  }
  return found;
}

/** Quantises a percentage from the proportional band onto the seven legal steps. */
export function toCommandedLevel(percent: number): CommandedLevel {
  const stepped = Math.round(percent / 10) * 10;
  const clamped = Math.min(Math.max(stepped, MIN_LEVEL), MAX_COMMANDED_LEVEL);
  return assertCommandedLevel(clamped);
}

/** One step down, or the floor. Decreases are the only rate-limited direction. */
export function stepDown(level: CommandedLevel): CommandedLevel {
  const index = COMMANDED_LEVELS.indexOf(level);
  return COMMANDED_LEVELS[index - 1] ?? MIN_LEVEL;
}
