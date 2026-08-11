import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { CONTROL } from '../src/config.ts';
import type { TraceStep } from './support/trace.ts';
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
  let steps: TraceStep[] = [];

  before(async () => {
    steps = await runTrace({
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
  let steps: TraceStep[] = [];

  before(async () => {
    steps = await runTrace({
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
  let steps: TraceStep[] = [];

  before(async () => {
    steps = await runTrace({
      startsAt: AT_1900,
      minutes: 60,
      startLevel: 20,
      co2: [
        { minute: 0, co2: 600 },
        { minute: 20, co2: 1300 },
        { minute: 60, co2: 1300 },
      ],
    });
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
  let steps: TraceStep[] = [];

  before(async () => {
    steps = await runTrace({
      startsAt: AT_2150,
      minutes: 30,
      startLevel: 70,
      co2: [
        { minute: 0, co2: 1100 },
        { minute: 30, co2: 1100 },
      ],
    });
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

  it('is the trace that makes the descent rule exempt the cap', () => {
    // 70 -> 50 is two steps in one move, which the descent rule forbids and the
    // sleep cap requires. This is the only trace that performs a cap move, so
    // without it here the exemption in the helper is never taken and could be
    // deleted with the suite still green — an exemption nothing exercises is
    // indistinguishable from a mistake.
    assertStepwiseDescent(steps);
    assertCapRespected(steps);
  });
});

describe("Netatmo's refresh", () => {
  // The same reading repeated for eight minutes at a time. A reviewer once
  // argued this would wind the controller up; it cannot, because nothing here
  // integrates.
  let steps: TraceStep[] = [];

  before(async () => {
    steps = await runTrace({
      startsAt: AT_1200,
      minutes: 60,
      startLevel: 20,
      co2: [
        { minute: 0, co2: 900 },
        { minute: 60, co2: 900 },
      ],
    });
  });

  it('acts once and then leaves it alone', () => {
    assert.deepEqual(commandedLevels(steps), [40]);
  });
});

describe('the sensor dies at 02:00', () => {
  let steps: TraceStep[] = [];

  before(async () => {
    steps = await runTrace({
      startsAt: AT_2200,
      minutes: 480, // 22:00 through 06:00
      startLevel: 20,
      sensorDiesAtMinute: 240,
      co2: [
        { minute: 0, co2: 1300 },
        { minute: 480, co2: 1300 },
      ],
    });
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
  let steps: TraceStep[] = [];

  before(async () => {
    steps = await runTrace({
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
  });

  it('does not flutter', () => {
    assert.deepEqual(commandedLevels(steps), []);
  });
});

describe('a full sweep across every step edge', () => {
  let steps: TraceStep[] = [];

  before(async () => {
    steps = await runTrace({
      startsAt: AT_0700,
      minutes: 840, // 07:00 through 21:00, entirely outside quiet hours
      startLevel: 20,
      co2: [
        { minute: 0, co2: 400 },
        { minute: 420, co2: 1400 },
        { minute: 840, co2: 400 },
      ],
    });
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

describe('a write outage across the morning release', () => {
  // Modbus drops out for an hour around the time the bedroom clears. Sleep
  // releases during the outage, and when CO2 climbs again later that morning the
  // extender must not re-latch — it can only ever extend a sleep quiet hours
  // asserted, and quiet hours ended at 07:00.
  //
  // This is the trace that pins the loop's update ordering. Carrying the sleep
  // state only on ticks whose write succeeded re-creates exactly the
  // self-latching failure the extender exists to prevent, and it is invisible to
  // every other trace because none of them has an actuator that fails.
  let steps: TraceStep[] = [];

  before(async () => {
    steps = await runTrace({
      startsAt: AT_2100,
      minutes: 840, // 21:00 through 11:00
      startLevel: 40,
      writeFailsBetweenMinutes: { from: 640, to: 700 }, // 07:40 to 08:40
      co2: [
        { minute: 0, co2: 600 },
        { minute: 240, co2: 1300 }, // 01:00, and it stays there
        { minute: 600, co2: 1300 }, // 07:00, quiet hours end
        { minute: 660, co2: 600 }, // 08:00, the room clears
        { minute: 720, co2: 900 }, // 09:00, and fills again with the door shut
        { minute: 840, co2: 900 },
      ],
    });
  });

  it('releases sleep during the outage and never re-asserts it', () => {
    const released = steps.find((step) => step.minute > 600 && !step.sleeping);
    assert.ok(released !== undefined, 'sleep never released');

    const relatched = steps.filter((step) => step.minute > released.minute && step.sleeping);
    assert.deepEqual(
      relatched.map((step) => step.minute),
      [],
      'the cap came back during the day, with nobody asleep',
    );
  });

  it('commands nothing while the unit is refusing writes', () => {
    const duringOutage = commands(steps).filter((step) => step.minute >= 640 && step.minute <= 700);

    assert.deepEqual(duringOutage, []);
  });

  it('resumes commanding once the unit comes back', () => {
    const afterOutage = commands(steps).filter((step) => step.minute > 700);

    assert.ok(afterOutage.length > 0, 'the loop never recovered from the outage');
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

  it('waits out the dwell when nothing has restarted', async () => {
    const secondCommand = commands(await runTrace(falling))[1];

    assert.equal(secondCommand?.minute, CONTROL.minDwellMinutes);
  });

  it('acts on the next cycle after a restart, because the timer is in memory', async () => {
    // The documented consequence of dropping the control_state table: a restart
    // does not remember the dwell. Accepted — a service that crash-loops is a
    // thing to fix, not a thing to rate-limit.
    const secondCommand = commands(await runTrace({ ...falling, restartAtMinute: 2 }))[1];

    assert.equal(secondCommand?.minute, 2);
  });
});
