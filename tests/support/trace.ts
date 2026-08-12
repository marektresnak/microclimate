import assert from 'node:assert/strict';

import { createFakeUnit } from '../../src/actuator/fake.ts';
import { CONTROL } from '../../src/config.ts';
import { createControlLoop } from '../../src/control/loop.ts';
import { MIN_LEVEL } from '../../src/domain/level.ts';
import type { CommandedLevel } from '../../src/domain/level.ts';
import type { Reading } from '../../src/domain/measurement.ts';
import type { SensorSource } from '../../src/sources/source.ts';
import { openReadingStore } from '../../src/store/readings.ts';

/**
 * The tests with time in them, and no physics in them.
 *
 * A trace is a hand-written CO2 curve plus a starting wall-clock time. The
 * harness samples the curve at the instrument's own refresh rate and feeds it to
 * **the real control loop** — through a real source, a real SQLite store and the
 * recording fake unit — then asserts on the sequence of commands. It makes no
 * claim to model a flat: it says "here is a CO2 series, here is what the service
 * does", which is what a bug that only exists across time needs and no more.
 *
 * It drives `createControlLoop` rather than calling `policy` and `limiter`
 * itself. An earlier version threaded `currentLevel`, `lastChangeAt` and
 * `wasSleeping` in this file, which made it a second copy of the loop's state
 * machine — and a copy that stayed green while the real one was broken. The
 * overnight trace exists to catch the 07:00 regression, and it did not notice
 * when the loop stopped carrying `wasSleeping` at all.
 *
 * What it structurally cannot answer is whether the loop *converges*, because the
 * controller's actions do not feed back into the series. That needs a plant
 * model, and a plant model needs parameters that are currently guesses.
 */
export interface TracePoint {
  readonly minute: number;
  readonly co2: number;
}

export interface TraceOptions {
  /** Minute zero. Written as UTC in the tests, with its local meaning spelled out. */
  readonly startsAt: Temporal.Instant;
  readonly minutes: number;
  readonly co2: readonly TracePoint[];
  /** Where the unit is found at startup. The loop adopts it on the first tick. */
  readonly startLevel?: CommandedLevel;
  /** After this minute the instrument stops reporting. Its last reading goes stale on its own. */
  readonly sensorDiesAtMinute?: number;
  /** Must land on a tick. The loop is rebuilt: the unit keeps its level, the loop's memory does not. */
  readonly restartAtMinute?: number;
  /** Minutes during which the unit refuses writes, so an outage can span many ticks. */
  readonly writeFailsBetweenMinutes?: { readonly from: number; readonly to: number };
}

export interface TraceStep {
  readonly minute: number;
  readonly level: CommandedLevel;
  readonly desiredLevel: CommandedLevel;
  readonly sleeping: boolean;
  readonly wrote: boolean;
}

export async function runTrace(options: TraceOptions): Promise<TraceStep[]> {
  const readings = sampleReadings(options);
  const store = openReadingStore(':memory:');
  const unit = createFakeUnit(options.startLevel ?? MIN_LEVEL);
  const steps: TraceStep[] = [];

  const build = (): ReturnType<typeof createControlLoop> =>
    createControlLoop({
      sources: [instrument(readings)],
      store,
      unit,
      log: () => undefined,
    });

  let loop = build();
  const evaluationMs = CONTROL.evaluationInterval.total('milliseconds');
  const totalTicks = Math.floor((options.minutes * 60_000) / evaluationMs);

  for (let tick = 0; tick <= totalTicks; tick += 1) {
    const now = options.startsAt.add({ milliseconds: tick * evaluationMs });
    const minute = (tick * evaluationMs) / 60_000;

    // A restart is a new loop against the same hardware and the same database:
    // it re-reads the unit and starts with no dwell timer and no sleep memory.
    if (minute === options.restartAtMinute) loop = build();

    unit.failWrites = isInside(options.writeFailsBetweenMinutes, minute);

    const commandsBefore = unit.commands.length;
    await loop.tick(now);

    const state = loop.state();
    if (state === undefined) throw new Error(`the loop reported no state at minute ${minute}`);

    steps.push({
      minute,
      level: state.level,
      desiredLevel: state.desiredLevel,
      sleeping: state.sleeping,
      wrote: unit.commands.length > commandsBefore,
    });
  }

  store.close();
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

// Shaped like the Netatmo: it hands back its current reading whenever asked, so
// polling faster than it refreshes returns the same row and the store absorbs it.
function instrument(readings: readonly Reading[]): SensorSource {
  return {
    name: 'trace-instrument',
    pollInterval: Temporal.Duration.from({ minutes: 1 }),

    async poll(now: Temporal.Instant): Promise<readonly Reading[]> {
      const reported = readings.filter(
        (reading) => Temporal.Instant.compare(reading.measuredAt, now) <= 0,
      );
      const newest = reported.at(-1);
      return newest === undefined ? [] : [newest];
    },
  };
}

// The instrument reports on its own schedule, which is what makes "the same
// reading repeated for eight minutes" a real case rather than a contrived one.
function sampleReadings(options: TraceOptions): Reading[] {
  const intervalMinutes = 8;
  const lastMinute = options.sensorDiesAtMinute ?? options.minutes;
  const readings: Reading[] = [];

  for (let minute = 0; minute <= lastMinute; minute += intervalMinutes) {
    const measuredAt = options.startsAt.add({ minutes: minute });
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

function isInside(window: { readonly from: number; readonly to: number } | undefined, minute: number): boolean {
  if (window === undefined) return false;
  return minute >= window.from && minute <= window.to;
}
