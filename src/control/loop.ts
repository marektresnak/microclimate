import type { VentilationUnit } from '../actuator/unit.ts';
import { CONTROL, PRECEDENCE } from '../config.ts';
import type { RoomId } from '../config.ts';
import type { Snapshot } from '../domain/decision.ts';
import { MAX_COMMANDED_LEVEL, assertCommandedLevel } from '../domain/level.ts';
import type { CommandedLevel, Level } from '../domain/level.ts';
import type { Reading } from '../domain/measurement.ts';
import { resolveSignal } from '../domain/precedence.ts';
import type { SensorSource } from '../sources/source.ts';
import type { ReadingStore } from '../store/readings.ts';
import { limit } from './limiter.ts';
import { decide, worstFreshCo2 } from './policy.ts';

export interface ControlLoopDependencies {
  readonly sources: readonly SensorSource[];
  readonly store: ReadingStore;
  readonly unit: VentilationUnit;
  readonly log: (line: string) => void;
}

export interface ControlLoop {
  tick(now: number): Promise<void>;
}

/**
 * Orchestration, and nothing else: poll, store, decide, actuate. All the
 * reasoning is in the pure modules this calls.
 *
 * It owns the only mutable state in the system — the last commanded level, when
 * that changed, whether the last cycle was asleep — and holds it in memory. A
 * restart loses all three, which means a restart acts immediately rather than
 * waiting out a dwell it cannot remember.
 *
 * Every step that touches the outside world is isolated, because the loop
 * surviving a bad tick matters more than any single tick succeeding.
 */
export function createControlLoop(dependencies: ControlLoopDependencies): ControlLoop {
  const lastPolledAt = new Map<string, number>();

  let currentLevel: CommandedLevel | undefined;
  let lastChangeAt: number | undefined;
  let wasSleeping = false;
  let pinnedSince: number | undefined;

  async function tick(now: number): Promise<void> {
    for (const source of dependencies.sources) {
      const polledAt = lastPolledAt.get(source.name);
      if (polledAt !== undefined && now - polledAt < source.pollIntervalMs) continue;
      lastPolledAt.set(source.name, now);

      // Per source: one vendor being unreachable must not stop the others being
      // read, or a decision being made from whatever did arrive.
      try {
        dependencies.store.insert(await source.poll(now));
      } catch (error) {
        dependencies.log(`${source.name} did not report: ${messageOf(error)}`);
      }
    }

    const actualLevel = await readActualLevel();

    if (currentLevel === undefined) {
      // Q4: the unit's level is read at startup, so the first decision is as
      // informed as any later one. A panel-set 90 is adopted as 80, because that
      // is the highest level we are allowed to hold it at.
      currentLevel = actualLevel === undefined ? CONTROL.safeDefaultLevel : underTheCeiling(actualLevel);
    } else if (actualLevel !== undefined && actualLevel !== currentLevel) {
      // Reported, not acted on. Somebody used the wall panel; we keep deciding
      // from our own last commanded value, and the next change overwrites theirs.
      dependencies.log(`the unit is at ${actualLevel}% and we last commanded ${currentLevel}% — wall panel?`);
    }

    const snapshot: Snapshot = {
      co2ByRoom: {
        living_room: resolveSignal('living_room', 'co2', latestCo2('living_room'), now),
        kids_room: resolveSignal('kids_room', 'co2', latestCo2('kids_room'), now),
        bedroom: resolveSignal('bedroom', 'co2', latestCo2('bedroom'), now),
      },
      currentLevel,
      wasSleeping,
    };

    const decision = decide(snapshot, now);
    const outcome = limit(decision, currentLevel, lastChangeAt, now);
    wasSleeping = decision.sleeping;

    if (outcome.write) {
      try {
        await dependencies.unit.set(outcome.level);
      } catch (error) {
        // The state is left alone deliberately, so the next tick tries again.
        dependencies.log(`could not command ${outcome.level}%: ${messageOf(error)}`);
        return;
      }
    }

    currentLevel = outcome.level;
    lastChangeAt = outcome.lastChangeAt;

    reportCapacity(snapshot, outcome.level, now);
    const action = outcome.write ? 'set' : 'held';
    dependencies.log(`${outcome.level}% ${action} — ${outcome.reasons.join('; ')}`);
  }

  async function readActualLevel(): Promise<Level | undefined> {
    try {
      return await dependencies.unit.read();
    } catch (error) {
      dependencies.log(`could not read the unit: ${messageOf(error)}`);
      return undefined;
    }
  }

  function latestCo2(room: RoomId): Reading[] {
    const ranked = PRECEDENCE[room].co2 ?? [];
    const readings: Reading[] = [];

    for (const sourceId of ranked) {
      try {
        const latest = dependencies.store.latestReading(sourceId, 'co2');
        if (latest !== undefined) readings.push(latest);
      } catch (error) {
        // A store that cannot be read degrades to "no reading", which the policy
        // already handles by falling back to the safe default.
        dependencies.log(`could not read ${sourceId}: ${messageOf(error)}`);
      }
    }

    return readings;
  }

  // ASHRAE Guideline 36's pinned-at-the-ceiling alarm. Full power with CO2 still
  // well above the top of the band is a capacity problem — the intake grille, or
  // simply more people than the unit can serve — and no amount of control can fix
  // it. Without this it looks like the controller failing.
  function reportCapacity(snapshot: Snapshot, level: CommandedLevel, now: number): void {
    const worst = worstFreshCo2(snapshot.co2ByRoom);
    const outOfCapacity =
      level === MAX_COMMANDED_LEVEL &&
      worst !== undefined &&
      worst.value > CONTROL.ceilingDiagnosticPpm;

    if (!outOfCapacity || worst === undefined) {
      pinnedSince = undefined;
      return;
    }

    pinnedSince ??= now;
    if (now - pinnedSince < CONTROL.ceilingDiagnosticMinutes * 60_000) return;

    // Re-armed rather than latched: while the condition lasts this repeats once
    // per window, which is what an ongoing capacity problem deserves.
    pinnedSince = now;
    dependencies.log(
      `pinned at ${MAX_COMMANDED_LEVEL}% with ${Math.round(worst.value)} ppm in the ${worst.room} ` +
        `for ${CONTROL.ceilingDiagnosticMinutes} minutes — a capacity problem, not a control one`,
    );
  }

  return { tick };
}

function underTheCeiling(level: Level): CommandedLevel {
  return assertCommandedLevel(Math.min(level, MAX_COMMANDED_LEVEL));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
