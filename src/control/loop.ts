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

// ─────────────────────────────────────────────────────────────────────────────
// TEACHING NOTES — how to read this file
//
// This is the only place in the control path that talks to the outside world.
// Every decision it makes is made somewhere else:
//
//   precedence.ts  which instrument answers for a room  (pure)
//   freshness.ts   whether a reading still counts        (pure)
//   policy.ts      CO2 -> a demanded level + asleep?     (pure)
//   limiter.ts     the sleep cap and the timing rule     (pure)
//
// "Pure" means: same inputs, same output, no clock, no database, no network.
// That is what makes them testable without hardware, and it is why this file is
// the messy one — all the IO and all the mutable state live here on purpose,
// concentrated where they can be seen rather than scattered.
//
// One tick, in order:
//   1. poll any source that is due, store what it returns
//   2. read the fan's actual level from the hardware
//   3. build a snapshot: what each room's CO2 currently is
//   4. decide  (policy)  -> what the air demands, and is anyone asleep
//   5. limit   (limiter) -> what we are allowed to command right now
//   6. write it to the hardware, if it changed
//   7. record the decision, log it, check the capacity alarm
// ─────────────────────────────────────────────────────────────────────────────

// TEACHING: the four things this loop needs from outside itself. Bundling them
// in one named type means a reader can see the loop's ENTIRE contact with the
// world in four lines — three seams and a log sink. Swapping any of them (a fake
// unit, an in-memory store) needs no change in this file.
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
  readonly decidedAt: Temporal.Instant;
  readonly level: CommandedLevel; // where we believe the fan is
  readonly actualLevel: Level | undefined; // where it says it is; undefined if unreadable
  readonly desiredLevel: CommandedLevel; // what the air asked for, before any cap
  readonly sleeping: boolean;
  readonly reasons: readonly string[];
}

export interface ControlLoop {
  tick(now: Temporal.Instant): Promise<void>;
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
// TEACHING: `now` is passed INTO tick rather than read inside it. That one
// choice is why the trace tests can run fourteen simulated hours in
// milliseconds, and why no test in this project ever sleeps.
export function createControlLoop(dependencies: ControlLoopDependencies): ControlLoop {
  // TEACHING: everything below is the loop's memory, living in a closure. Each
  // variable exists for one named reason:

  // when each source was last polled, so a 15-minute source is not asked every 30s
  const lastPolledAt = new Map<string, Temporal.Instant>();

  // where we believe the fan is. `undefined` = we have not started yet, which is
  // what triggers the read-and-adopt on the very first tick
  let currentLevel: CommandedLevel | undefined;
  // when the level last actually changed — the clock the descent rate limit uses
  let lastChangeAt: Temporal.Instant | undefined;
  // was the previous cycle asleep? the CO2 sleep term can only EXTEND a sleep
  // that quiet hours already asserted, so it needs to know
  let wasSleeping = false;
  // when the fan first went out of capacity, for the ten-minute alarm
  let pinnedSince: Temporal.Instant | undefined;
  // the last decision, handed out by state() for /api/state
  let lastState: LoopState | undefined;

  async function tick(now: Temporal.Instant): Promise<void> {
    // ── 1. POLL ──────────────────────────────────────────────────────────────
    for (const source of dependencies.sources) {
      // TEACHING: each source has its own cadence. Netatmo only refreshes every
      // 7-8 minutes on their side, so polling it every 30 seconds gains nothing
      // and just burns API quota.
      const polledAt = lastPolledAt.get(source.name);
      const dueAt = polledAt?.add(source.pollInterval);
      if (dueAt !== undefined && Temporal.Instant.compare(now, dueAt) < 0) continue;
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
        // TEACHING: `continue`, not `return` — the next source still gets asked.
        continue;
      }

      try {
        dependencies.store.insert(readings);
      } catch (error) {
        // TEACHING: no `continue` needed; this is the end of the loop body. A
        // failed store still leaves the reading lost, but the decision below
        // proceeds on whatever is already in the database.
        dependencies.log(
          `could not store ${readings.length} readings from ${source.name}: ${messageOf(error)}`,
        );
      }
    }

    // ── 2. READ THE HARDWARE ─────────────────────────────────────────────────
    // TEACHING: `undefined` if the unit could not be reached. Everything below
    // has to cope with not knowing where the fan is.
    const actualLevel = await readActualLevel();

    if (currentLevel === undefined) {
      // Q4: the unit's level is read at startup, so the first decision is as
      // informed as any later one. A panel-set 90 is adopted as 80, because that
      // is the highest level we are allowed to hold it at.
      //
      // TEACHING: this branch runs exactly once per process. If the read failed
      // we assume the safe default (40%) — a guess, but a documented one, and
      // better than refusing to start.
      currentLevel = actualLevel === undefined ? CONTROL.safeDefaultLevel : underTheCeiling(actualLevel);
    } else if (actualLevel !== undefined && actualLevel !== currentLevel) {
      // "Holding", not "commanded": after a failed read at startup the level is
      // an assumption we adopted rather than anything we ever sent.
      //
      // TEACHING: a mismatch means someone used the wall panel, or a write we
      // thought succeeded did not. We report it and, except for the sleep-cap
      // case below, do not correct it.
      dependencies.log(
        `the unit reports ${actualLevel}% and we are holding ${currentLevel}% — ` +
          `the wall panel, or a write that did not land`,
      );
    }

    // ── 3. SNAPSHOT ──────────────────────────────────────────────────────────
    // TEACHING: for each room, ask the database for the newest reading from each
    // ranked instrument, then let `resolveSignal` pick the winner — the highest
    // ranked one that is still FRESH, judged against that instrument's own
    // window. The result is fresh / stale / missing, and the policy treats the
    // last two as "no reading" in both directions.
    //
    // Written out per room rather than looped, because the type is a Record with
    // exactly these three keys and listing them is clearer than building it.
    const snapshot: Snapshot = {
      co2ByRoom: {
        living_room: resolveSignal('living_room', 'co2', latestCo2('living_room'), now),
        kids_room: resolveSignal('kids_room', 'co2', latestCo2('kids_room'), now),
        bedroom: resolveSignal('bedroom', 'co2', latestCo2('bedroom'), now),
      },
      currentLevel,
      wasSleeping,
    };

    // ── 4. DECIDE ────────────────────────────────────────────────────────────
    // TEACHING: pure. Returns what the air demands (before any cap) and whether
    // anyone is asleep. It does NOT apply the sleep cap — that is the limiter's
    // job, kept in one place so two modules cannot disagree about it.
    const decision = decide(snapshot, now);

    // The one place the read-back is acted on, and the reason it is read at all.
    // "Not audible at night" is the hard requirement, so a level someone set
    // *above* the sleep cap is handed to the limiter as where the unit really is,
    // and its existing cap path pulls it back in one move.
    //
    // A level set below the cap is left alone. A quieter fan harms nobody, and
    // the panel should stay good for that — which is more than the original
    // design allowed, where a hand-set 30 was pushed back up to 50.
    //
    // TEACHING: read it as "which number do we tell the limiter the fan is at?"
    // Normally our own belief. But if someone hand-set it loud while the flat is
    // asleep, we tell the truth instead, and the limiter's cap path corrects it.
    // If the read failed, `actualLevel` is undefined and we cannot enforce
    // anything — correct by necessity, and the tests say so out loud.
    const observed =
      decision.sleeping && actualLevel !== undefined && actualLevel > CONTROL.sleepMaxLevel
        ? underTheCeiling(actualLevel)
        : currentLevel;

    // ── 5. LIMIT ─────────────────────────────────────────────────────────────
    // TEACHING: pure. Applies the sleep cap, then the one timing rule: increases
    // apply at once (up is where the air is already bad), decreases move one step
    // per ten minutes (a fast retreat lets CO2 crash and rebound into the next
    // boost — the square wave this project exists to prevent).
    const outcome = limit(decision, observed, lastChangeAt, now);
    // TEACHING: updated BEFORE the write, so a failed write cannot freeze the
    // sleep state. Getting this ordering wrong re-creates the self-latching cap.
    wasSleeping = decision.sleeping;

    // ── 6. ACTUATE ───────────────────────────────────────────────────────────
    // TEACHING: `outcome.write` is false when the target already equals where we
    // are, which is most ticks. `landed` is true when nothing needed doing.
    const landed = outcome.write ? await command(outcome.level) : true;

    if (landed) {
      // Left alone on a failed write, deliberately, so the next tick tries again.
      //
      // TEACHING: this is why a failed write is not a lost command. We keep
      // believing the OLD level, so the next tick computes the same target,
      // sees it still differs, and writes again.
      currentLevel = outcome.level;
      lastChangeAt = outcome.lastChangeAt;
    }

    // ── 7. RECORD ────────────────────────────────────────────────────────────
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

    // TEACHING: the reasons come from the policy and the limiter, concatenated,
    // so the log line explains the whole chain: what the air said, what the band
    // made of it, and what the timing rules allowed.
    const action = outcome.write && landed ? 'set' : 'held';
    dependencies.log(`${currentLevel}% ${action} — ${outcome.reasons.join('; ')}`);
  }

  // TEACHING: returns whether the write landed rather than throwing, so the
  // caller can decide what to believe. Throwing here would abort the tick and
  // skip the recording below it.
  async function command(level: CommandedLevel): Promise<boolean> {
    try {
      await dependencies.unit.set(level);
      return true;
    } catch (error) {
      dependencies.log(`could not command ${level}%: ${messageOf(error)}`);
      return false;
    }
  }

  // TEACHING: a failed read degrades to "we do not know", not to a crash and not
  // to a guess. Everything downstream handles `undefined`.
  async function readActualLevel(): Promise<Level | undefined> {
    try {
      return await dependencies.unit.read();
    } catch (error) {
      dependencies.log(`could not read the unit: ${messageOf(error)}`);
      return undefined;
    }
  }

  // TEACHING: fetch the newest CO2 reading from each instrument ranked for this
  // room. `PRECEDENCE[room].co2` is the ordered list from config — today only the
  // bedroom has one entry, the Netatmo. `?? []` handles rooms with no CO2
  // instrument at all, which is the living room and the kids' room until a SEN66
  // is installed.
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
  //
  // TEACHING: this is the only state in the loop that is not the control
  // decision itself. It answers "have we been flat out and still losing, for long
  // enough that it is not a blip?"
  function reportCapacity(snapshot: Snapshot, level: CommandedLevel, now: Temporal.Instant): void {
    const worst = worstFreshCo2(snapshot.co2ByRoom);
    // TEACHING: BOTH halves matter. At the ceiling with merely-bad air is the
    // design working. Bad air while the sleep cap holds the fan at 50 is not a
    // capacity problem either — the fan is under orders, not out of breath.
    const outOfCapacity =
      level === MAX_COMMANDED_LEVEL &&
      worst !== undefined &&
      worst.value > CONTROL.ceilingDiagnosticPpm;

    // TEACHING: the condition cleared, so the ten minutes start again from zero
    // next time. (`worst === undefined` is redundant with the line above but
    // convinces the typechecker that `worst` is defined below.)
    if (!outOfCapacity || worst === undefined) {
      pinnedSince = undefined;
      return;
    }

    // TEACHING: `??=` assigns only if currently undefined — so this records when
    // the episode STARTED and leaves it alone on every tick after.
    pinnedSince ??= now;
    if (Temporal.Instant.compare(now, pinnedSince.add(CONTROL.ceilingDiagnosticWindow)) < 0) return;

    // Re-armed rather than latched: while the condition lasts this repeats once
    // per window, which is what an ongoing capacity problem deserves.
    pinnedSince = now;
    dependencies.log(
      `pinned at ${MAX_COMMANDED_LEVEL}% with ${Math.round(worst.value)} ppm in the ${worst.room} ` +
        `for ${CONTROL.ceilingDiagnosticWindow.minutes} minutes — a capacity problem, not a control one`,
    );
  }

  return { tick, state: () => lastState };
}

// TEACHING: the fan can REPORT 90 or 100 (someone used the wall panel) but we
// may only ever COMMAND up to 80 — the intake grille in this flat cannot pass
// more air than that. This converts the wider type to the narrower one by
// clamping, and `assertCommandedLevel` proves the result at runtime, because
// Node strips types without checking them.
function underTheCeiling(level: Level): CommandedLevel {
  return assertCommandedLevel(Math.min(level, MAX_COMMANDED_LEVEL));
}

// TEACHING: `catch (error)` gives you `unknown` — anything can be thrown in
// JavaScript, not just Errors. This narrows it safely for a log line.
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
