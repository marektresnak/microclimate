import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CONTROL } from '../src/config.ts';
import {
  assertCapRespected,
  assertStepwiseDescent,
  commandedLevels,
  commands,
  runTrace,
} from './support/trace.ts';

// Europe/Prague is UTC+1 in January, so every start time below is written as UTC
// with the local hour it means.
const AT_2100 = Date.UTC(2026, 0, 15, 20, 0);
const AT_2150 = Date.UTC(2026, 0, 15, 20, 50);
const AT_2200 = Date.UTC(2026, 0, 15, 21, 0);
const AT_1900 = Date.UTC(2026, 0, 15, 18, 0);
const AT_1200 = Date.UTC(2026, 0, 15, 11, 0);
const AT_0700 = Date.UTC(2026, 0, 15, 6, 0);

describe('overnight, clearing late', () => {
  // The regression two independent reviewers found by reasoning, and the reason
  // the CO2 term survived the simplification pass at all. It would have failed
  // here immediately.
  const steps = runTrace({
    startsAt: AT_2100,
    minutes: 780, // 21:00 through 10:00
    startLevel: 40,
    co2: [
      { minute: 0, co2: 600 }, // 21:00, flat evening
      { minute: 120, co2: 800 }, // 23:00, everyone is in bed
      { minute: 240, co2: 1300 }, // 01:00, and it stays there
      { minute: 630, co2: 1300 }, // 07:30, the alarm goes off
      { minute: 690, co2: 700 }, // 08:30, door open, room clearing
      { minute: 780, co2: 550 }, // 10:00
    ],
  });

  it('never runs above the cap while anyone is asleep', () => {
    assertCapRespected(steps);
  });

  it('holds the cap past 07:00 while the room is still stuffy', () => {
    const at0705 = steps.find((step) => step.minute === 605);

    assert.ok(at0705 !== undefined);
    assert.equal(at0705.sleeping, true);
    // The cap is actively binding, not merely inactive: demand is at the ceiling
    // and the output is at the cap. Keyed to the clock alone this is where the
    // level would have jumped 50 -> 80 into a bedroom of sleeping people.
    assert.equal(at0705.desiredLevel, 80);
    assert.equal(at0705.level, CONTROL.sleepMaxLevel);
  });

  it('releases only once the room has actually cleared', () => {
    const released = steps.find((step) => step.minute > 420 && !step.sleeping);

    assert.ok(released !== undefined, 'sleep never released');
    assert.ok(
      released.minute >= 690,
      `sleep released at minute ${released.minute}, before the room reached 700 ppm at 690`,
    );
  });

  it('walks the level down afterwards rather than dropping it', () => {
    assertStepwiseDescent(steps);
  });
});

describe('the square wave', () => {
  // CO2 rises past the band and falls back within one dwell. With no rate limit
  // at all this produced 20 -> 80 -> 20 with a twenty-minute period, which is
  // precisely the behaviour the project exists to eliminate.
  const steps = runTrace({
    startsAt: AT_1200,
    minutes: 90,
    startLevel: 20,
    co2: [
      { minute: 0, co2: 600 },
      { minute: 10, co2: 1300 },
      { minute: 20, co2: 500 },
      { minute: 90, co2: 500 },
    ],
  });

  it('comes back down one step at a time', () => {
    assertStepwiseDescent(steps);
  });

  it('never returns to the floor in a single move', () => {
    const levels = commandedLevels(steps);
    const straightToTheFloor = commands(steps).some(
      (step, index) => index > 0 && step.level === 20 && (levels[index - 1] ?? 20) > 30,
    );

    assert.equal(straightToTheFloor, false);
  });

  it('takes the whole dwell-limited hour to give the boost back', () => {
    const lastCommand = commands(steps).at(-1);

    assert.equal(lastCommand?.level, 20);
    assert.ok(lastCommand !== undefined && lastCommand.minute >= 50, 'the retreat was too fast');
  });
});

describe('cooking spike', () => {
  // The asymmetry is the point: a rate limit on increases fails this trace.
  const steps = runTrace({
    startsAt: AT_1900,
    minutes: 60,
    startLevel: 20,
    co2: [
      { minute: 0, co2: 600 },
      { minute: 20, co2: 1300 },
      { minute: 60, co2: 1300 },
    ],
  });

  it('goes straight to the level the band asks for', () => {
    const firstCommand = commands(steps)[0];

    assert.ok(firstCommand !== undefined);
    assert.ok(
      firstCommand.level - 20 > 10,
      `first command was ${firstCommand.level}%, only one step above the floor`,
    );
  });

  it('reaches the ceiling within a couple of minutes of the reading that demands it', () => {
    const atCeiling = commands(steps).find((step) => step.level === 80);

    assert.ok(atCeiling !== undefined, 'never reached the ceiling');
    assert.ok(atCeiling.minute <= 25, `reached the ceiling at minute ${atCeiling.minute}`);
  });
});

describe('evening at 70 into quiet hours', () => {
  // No new target is computed and demand has not moved, yet the level must still
  // fall — because the cap is evaluated against where the unit is.
  const steps = runTrace({
    startsAt: AT_2150,
    minutes: 30,
    startLevel: 70,
    co2: [
      { minute: 0, co2: 1100 },
      { minute: 30, co2: 1100 },
    ],
  });

  it('drops at the boundary, not at the next dwell', () => {
    const firstCommand = commands(steps)[0];

    assert.ok(firstCommand !== undefined, 'the unit ran at 70% into the night');
    assert.equal(firstCommand.minute, 10); // 22:00
    assert.equal(firstCommand.level, CONTROL.sleepMaxLevel);
  });

  it('does not move again for the rest of the evening', () => {
    assert.deepEqual(commandedLevels(steps), [50]);
  });
});

describe("Netatmo's refresh", () => {
  // The same reading repeated for eight minutes at a time. A reviewer once
  // argued this would wind the controller up; it cannot, because nothing here
  // integrates.
  const steps = runTrace({
    startsAt: AT_1200,
    minutes: 60,
    startLevel: 20,
    co2: [
      { minute: 0, co2: 900 },
      { minute: 60, co2: 900 },
    ],
  });

  it('acts once and then leaves it alone', () => {
    assert.deepEqual(commandedLevels(steps), [40]);
  });
});

describe('the sensor dies at 02:00', () => {
  const steps = runTrace({
    startsAt: AT_2200,
    minutes: 480, // 22:00 through 06:00
    startLevel: 20,
    sensorDiesAtMinute: 240,
    co2: [
      { minute: 0, co2: 1300 },
      { minute: 480, co2: 1300 },
    ],
  });

  it('falls back to the safe default rather than trusting the last reading', () => {
    // The last thing it heard was 1300 ppm. Holding the fan at the cap all night
    // on the strength of a dead instrument is the failure this guards.
    assert.equal(commandedLevels(steps).at(-1), CONTROL.safeDefaultLevel);
  });

  it('is still capped, and does not drift afterwards', () => {
    assertCapRespected(steps);
    assert.deepEqual(commandedLevels(steps), [50, 40]);
  });
});

describe('hovering at a step boundary', () => {
  // The 40/50 boundary is 841.7 ppm. This is what the 60 ppm hysteresis is for.
  const steps = runTrace({
    startsAt: AT_1200,
    minutes: 120,
    startLevel: 40,
    co2: [
      { minute: 0, co2: 822 },
      { minute: 16, co2: 862 },
      { minute: 32, co2: 822 },
      { minute: 48, co2: 862 },
      { minute: 64, co2: 822 },
      { minute: 80, co2: 862 },
      { minute: 96, co2: 822 },
      { minute: 120, co2: 862 },
    ],
  });

  it('does not flutter', () => {
    assert.deepEqual(commandedLevels(steps), []);
  });
});

describe('a full sweep across every step edge', () => {
  const steps = runTrace({
    startsAt: AT_0700,
    minutes: 840, // 07:00 through 21:00, entirely outside quiet hours
    startLevel: 20,
    co2: [
      { minute: 0, co2: 400 },
      { minute: 420, co2: 1400 },
      { minute: 840, co2: 400 },
    ],
  });

  it('visits every step in both directions', () => {
    assert.deepEqual(new Set(commandedLevels(steps)), new Set([20, 30, 40, 50, 60, 70, 80]));
  });

  it('comes down one step at a time the whole way', () => {
    assertStepwiseDescent(steps);
  });

  it('never asserts sleep in the middle of the day', () => {
    assert.equal(
      steps.some((step) => step.sleeping),
      false,
    );
  });
});

describe('a restart mid-trace', () => {
  const falling = {
    startsAt: AT_1200,
    minutes: 30,
    startLevel: 80,
    co2: [
      { minute: 0, co2: 400 },
      { minute: 30, co2: 400 },
    ],
  } as const;

  it('waits out the dwell when nothing has restarted', () => {
    const secondCommand = commands(runTrace(falling))[1];

    assert.equal(secondCommand?.minute, CONTROL.minDwellMinutes);
  });

  it('acts on the next cycle after a restart, because the timer is in memory', () => {
    // The documented consequence of dropping the control_state table: a restart
    // does not remember the dwell. Accepted — a service that crash-loops is a
    // thing to fix, not a thing to rate-limit.
    const secondCommand = commands(runTrace({ ...falling, restartAtMinute: 2 }))[1];

    assert.equal(secondCommand?.minute, 2);
  });
});
