import assert from 'node:assert/strict';

import { CONTROL, SENSORS } from '../../src/config.ts';
import { limit } from '../../src/control/limiter.ts';
import { decide } from '../../src/control/policy.ts';
import type { Snapshot } from '../../src/domain/decision.ts';
import { MIN_LEVEL } from '../../src/domain/level.ts';
import type { CommandedLevel } from '../../src/domain/level.ts';
import type { Reading } from '../../src/domain/measurement.ts';
import { resolveSignal } from '../../src/domain/precedence.ts';

/**
 * The tests with time in them, and no physics in them.
 *
 * A trace is a hand-written CO2 curve plus a starting wall-clock time. The
 * harness samples the curve at the instrument's own refresh rate, feeds the
 * readings to the real control modules tick by tick, and records what came out.
 * It makes no claim to model a flat — it says "here is a CO2 series, here is
 * what the controller does", which is exactly what a bug that only exists
 * across time needs and no more.
 *
 * What it structurally cannot answer is whether the loop *converges*, because
 * the controller's actions do not feed back into the series. That needs a plant
 * model, and a plant model needs plant parameters that are currently guesses.
 */
export interface TracePoint {
  readonly minute: number;
  readonly co2: number;
}

export interface TraceOptions {
  /** Epoch ms of minute zero. Written as UTC in the tests, with its local meaning spelled out. */
  readonly startsAt: number;
  readonly minutes: number;
  readonly co2: readonly TracePoint[];
  readonly startLevel?: CommandedLevel;
  /** After this minute the instrument stops reporting. Its last reading goes stale on its own. */
  readonly sensorDiesAtMinute?: number;
  /** Must land on a tick. The unit keeps its level; the dwell timer and the sleep state do not. */
  readonly restartAtMinute?: number;
}

export interface TraceStep {
  readonly minute: number;
  readonly level: CommandedLevel;
  readonly desiredLevel: CommandedLevel;
  readonly sleeping: boolean;
  readonly wrote: boolean;
}

export function runTrace(options: TraceOptions): TraceStep[] {
  const readings = sampleReadings(options);
  const steps: TraceStep[] = [];

  let currentLevel: CommandedLevel = options.startLevel ?? MIN_LEVEL;
  let lastChangeAt: number | undefined;
  let wasSleeping = false;

  const totalTicks = Math.floor((options.minutes * 60_000) / CONTROL.evaluationIntervalMs);

  for (let tick = 0; tick <= totalTicks; tick += 1) {
    const now = options.startsAt + tick * CONTROL.evaluationIntervalMs;
    const minute = (tick * CONTROL.evaluationIntervalMs) / 60_000;

    if (minute === options.restartAtMinute) {
      lastChangeAt = undefined;
      wasSleeping = false;
    }

    const reported = readings.filter((reading) => reading.measuredAt <= now);
    const snapshot: Snapshot = {
      co2ByRoom: {
        living_room: resolveSignal('living_room', 'co2', reported, now),
        kids_room: resolveSignal('kids_room', 'co2', reported, now),
        bedroom: resolveSignal('bedroom', 'co2', reported, now),
      },
      currentLevel,
      wasSleeping,
    };

    const decision = decide(snapshot, now);
    const outcome = limit(decision, currentLevel, lastChangeAt, now);

    steps.push({
      minute,
      level: outcome.level,
      desiredLevel: decision.desiredLevel,
      sleeping: decision.sleeping,
      wrote: outcome.write,
    });

    currentLevel = outcome.level;
    lastChangeAt = outcome.lastChangeAt;
    wasSleeping = decision.sleeping;
  }

  return steps;
}

/** The steps that actually commanded something. */
export function commands(steps: readonly TraceStep[]): TraceStep[] {
  return steps.filter((step) => step.wrote);
}

export function commandedLevels(steps: readonly TraceStep[]): CommandedLevel[] {
  return commands(steps).map((step) => step.level);
}

export function assertCapRespected(steps: readonly TraceStep[]): void {
  for (const step of steps) {
    if (!step.sleeping) continue;
    assert.ok(
      step.level <= CONTROL.sleepMaxLevel,
      `minute ${step.minute}: ${step.level}% while asleep, above the ${CONTROL.sleepMaxLevel}% cap`,
    );
  }
}

/**
 * No two consecutive commands may drop by more than one step.
 *
 * One-directional on purpose: increases are unbounded by design, so a symmetric
 * version of this rule contradicts the controller and leaves every trace red.
 * The exemption matters just as much — the sleep cap is specified to drop 80 to
 * 50 in a single move, so a rule without it fails the trace the cap exists for.
 */
export function assertStepwiseDescent(steps: readonly TraceStep[]): void {
  let previous: CommandedLevel | undefined;

  for (const step of steps) {
    if (previous !== undefined) {
      const isSleepCapMove =
        step.sleeping && previous > CONTROL.sleepMaxLevel && step.level === CONTROL.sleepMaxLevel;

      assert.ok(
        previous - step.level <= 10 || isSleepCapMove,
        `minute ${step.minute}: ${previous}% -> ${step.level}% in one move`,
      );
    }
    previous = step.level;
  }
}

// The instrument reports on its own schedule, which is what makes "the same
// reading repeated for eight minutes" a real case rather than a contrived one.
function sampleReadings(options: TraceOptions): Reading[] {
  const intervalMinutes = 8;
  const lastMinute = options.sensorDiesAtMinute ?? options.minutes;
  const readings: Reading[] = [];

  for (let minute = 0; minute <= lastMinute; minute += intervalMinutes) {
    const measuredAt = options.startsAt + minute * 60_000;
    readings.push({
      sourceId: 'bedroom_netatmo',
      kind: 'co2',
      value: co2At(options.co2, minute),
      measuredAt,
      receivedAt: measuredAt,
    });
  }

  return readings;
}

// Straight lines between the written points. Not a model of anything — just a
// way to write "climbs from 800 to 1300 over two hours" in two lines.
function co2At(points: readonly TracePoint[], minute: number): number {
  const first = points[0];
  if (first === undefined) throw new Error('a trace needs at least one CO2 point');
  if (minute <= first.minute) return first.co2;

  let previous = first;
  for (const point of points) {
    if (point.minute >= minute) {
      const span = point.minute - previous.minute;
      if (span === 0) return point.co2;
      const progress = (minute - previous.minute) / span;
      return previous.co2 + progress * (point.co2 - previous.co2);
    }
    previous = point;
  }

  return previous.co2;
}

// Named here so a trace can say how long it takes for a dead instrument to be
// recognised as dead, without repeating the number.
export const NETATMO_FRESHNESS_MINUTES = SENSORS.bedroom_netatmo.freshnessWindowMs / 60_000;
