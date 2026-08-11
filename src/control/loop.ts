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

/**
 * The last decision, as the loop currently understands the world. This is what
 * `/api/state` serves: `level` and `actualLevel` are reported separately because
 * a mismatch means someone used the wall panel, and `desiredLevel` is demand
 * *before* the sleep cap, so "demand 80, held at 50 because the flat is asleep"
 * can be read off rather than inferred.
 */
export interface LoopState {
  readonly decidedAt: number;
  readonly level: CommandedLevel;
  readonly actualLevel: Level | undefined;
  readonly desiredLevel: CommandedLevel;
  readonly sleeping: boolean;
  readonly reasons: readonly string[];
}

export interface ControlLoop {
  tick(now: number): Promise<void>;
  /** Undefined until the first tick has run. */
  state(): LoopState | undefined;
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
  let lastState: LoopState | undefined;

  async function tick(now: number): Promise<void> {
    for (const source of dependencies.sources) {
      const polledAt = lastPolledAt.get(source.name);
      if (polledAt !== undefined && now - polledAt < source.pollIntervalMs) continue;
      lastPolledAt.set(source.name, now);

      // Per source: one vendor being unreachable must not stop the others being
      // read, or a decision being made from whatever did arrive.
      //
      // The poll and the write are caught separately because they fail for
      // unrelated reasons and an operator chases the one the log names. A full
      // disk reported as "the Netatmo did not report" sends them to the vendor's
      // status page at 3am.
      let readings: readonly Reading[];
      try {
        readings = await source.poll(now);
      } catch (error) {
        dependencies.log(`${source.name} did not report: ${messageOf(error)}`);
        continue;
      }

      try {
        dependencies.store.insert(readings);
      } catch (error) {
        dependencies.log(
          `could not store ${readings.length} readings from ${source.name}: ${messageOf(error)}`,
        );
      }
    }

    const actualLevel = await readActualLevel();

    if (currentLevel === undefined) {
      // Q4: the unit's level is read at startup, so the first decision is as
      // informed as any later one. A panel-set 90 is adopted as 80, because that
      // is the highest level we are allowed to hold it at.
      currentLevel = actualLevel === undefined ? CONTROL.safeDefaultLevel : underTheCeiling(actualLevel);
    } else if (actualLevel !== undefined && actualLevel !== currentLevel) {
      // Reported, not acted on. We keep deciding from our own level, and the next
      // change we make for our own reasons overwrites whatever is there.
      //
      // "Holding", not "commanded": after a failed read at startup the level is
      // an assumption we adopted rather than anything we ever sent, and a line
      // that accuses the wall panel of a mismatch we invented is worse than no
      // line at all.
      dependencies.log(
        `the unit reports ${actualLevel}% and we are holding ${currentLevel}% — ` +
          `the wall panel, or a write that did not land`,
      );
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

    // The one place the read-back is acted on, and the reason it is read at all.
    // "Not audible at night" is the hard requirement, so a level someone set
    // *above* the sleep cap is handed to the limiter as where the unit really is,
    // and its existing cap path pulls it back in one move.
    //
    // A level set below the cap is left alone. A quieter fan harms nobody, and
    // the panel should stay good for that — which is more than the original
    // design allowed, where a hand-set 30 was pushed back up to 50.
    const observed =
      decision.sleeping && actualLevel !== undefined && actualLevel > CONTROL.sleepMaxLevel
        ? underTheCeiling(actualLevel)
        : currentLevel;

    const outcome = limit(decision, observed, lastChangeAt, now);
    wasSleeping = decision.sleeping;

    const landed = outcome.write ? await command(outcome.level) : true;

    if (landed) {
      // Left alone on a failed write, deliberately, so the next tick tries again.
      currentLevel = outcome.level;
      lastChangeAt = outcome.lastChangeAt;
    }

    // On every tick, including one whose write failed. An earlier version
    // returned early there, so a spell of failing writes left the diagnostic
    // blind: the air could clear and go bad again unseen, and the alarm would
    // then date itself from before a clearing it never saw.
    //
    // Judged on where the unit actually is rather than on what we wanted, for
    // the same reason — after a failed write those are different levels.
    reportCapacity(snapshot, currentLevel, now);

    lastState = {
      decidedAt: now,
      level: currentLevel,
      actualLevel,
      desiredLevel: decision.desiredLevel,
      sleeping: decision.sleeping,
      reasons: outcome.reasons,
    };

    const action = outcome.write && landed ? 'set' : 'held';
    dependencies.log(`${currentLevel}% ${action} — ${outcome.reasons.join('; ')}`);
  }

  async function command(level: CommandedLevel): Promise<boolean> {
    try {
      await dependencies.unit.set(level);
      return true;
    } catch (error) {
      dependencies.log(`could not command ${level}%: ${messageOf(error)}`);
      return false;
    }
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

  return { tick, state: () => lastState };
}

function underTheCeiling(level: Level): CommandedLevel {
  return assertCommandedLevel(Math.min(level, MAX_COMMANDED_LEVEL));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
