import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createFakeUnit } from '../src/actuator/fake.ts';
import { CONTROL } from '../src/config.ts';
import type { SensorId } from '../src/config.ts';
import { createControlLoop } from '../src/control/loop.ts';
import type { MeasurementKind, Reading } from '../src/domain/measurement.ts';
import type { SensorSource } from '../src/sources/source.ts';
import { openReadingStore } from '../src/store/readings.ts';
import type { ReadingStore } from '../src/store/readings.ts';

const MIDDAY = Temporal.Instant.from('2026-01-15T11:00:00Z'); // 12:00 in Prague
const NIGHT = Temporal.Instant.from('2026-01-15T01:00:00Z'); // 02:00 in Prague

function co2Source(name: string, value: number, measuredAt: Temporal.Instant): SensorSource {
  return {
    name,
    pollInterval: Temporal.Duration.from({ minutes: 1 }),
    async poll() {
      return [{ sourceId: 'bedroom_netatmo', kind: 'co2', value, measuredAt, receivedAt: measuredAt }];
    },
  };
}

/**
 * A source that reports whatever `ppm` currently says, stamped with the time it
 * was asked. Needed wherever a test runs for longer than the freshness window:
 * with a fixed `measuredAt`, the reading goes stale and the loop stops seeing
 * CO2 at all, which quietly satisfies assertions for the wrong reason.
 */
interface LiveSource {
  readonly source: SensorSource;
  ppm: number;
}

function liveCo2Source(name: string, ppm: number): LiveSource {
  const live: LiveSource = {
    ppm,
    source: {
      name,
      pollInterval: Temporal.Duration.from({ minutes: 1 }),
      async poll(now: Temporal.Instant): Promise<readonly Reading[]> {
        return [reading('bedroom_netatmo', 'co2', live.ppm, now)];
      },
    },
  };

  return live;
}

function brokenSource(name: string): SensorSource {
  return {
    name,
    pollInterval: Temporal.Duration.from({ minutes: 1 }),
    async poll() {
      throw new Error('vendor returned 500');
    },
  };
}

interface Recorder {
  readonly lines: string[];
  log(line: string): void;
}

function recorder(): Recorder {
  const lines: string[] = [];
  return { lines, log: (line) => void lines.push(line) };
}

describe('the control loop', () => {
  it('polls, stores, decides and commands in one cycle', async () => {
    const store = openReadingStore(':memory:');
    const unit = createFakeUnit(20);
    const log = recorder();
    const loop = createControlLoop({
      sources: [co2Source('netatmo', 1300, MIDDAY)],
      store,
      unit,
      log: log.log,
    });

    await loop.tick(MIDDAY);

    assert.deepEqual(unit.commands, [80]);
    assert.equal(store.latestReading('bedroom_netatmo', 'co2')?.value, 1300);
    assert.match(log.lines.join('\n'), /1300 ppm/);

    store.close();
  });

  it('keeps polling the other sources when one throws', async () => {
    const store = openReadingStore(':memory:');
    const log = recorder();
    const loop = createControlLoop({
      sources: [brokenSource('tado'), co2Source('netatmo', 1300, MIDDAY)],
      store,
      unit: createFakeUnit(20),
      log: log.log,
    });

    await loop.tick(MIDDAY);

    assert.equal(store.latestReading('bedroom_netatmo', 'co2')?.value, 1300);
    assert.match(log.lines.join('\n'), /tado did not report/);

    store.close();
  });

  it('still decides from the data that did arrive', async () => {
    const store = openReadingStore(':memory:');
    const unit = createFakeUnit(20);
    const loop = createControlLoop({
      sources: [co2Source('netatmo', 1300, MIDDAY), brokenSource('tado')],
      store,
      unit,
      log: recorder().log,
    });

    await loop.tick(MIDDAY);

    assert.deepEqual(unit.commands, [80]);
    store.close();
  });

  it('survives a store that cannot be read, and decides blind', async () => {
    const unit = createFakeUnit(20);
    const log = recorder();
    const unreadableStore: ReadingStore = {
      insert: () => 0,
      latestReading: () => {
        throw new Error('database is locked');
      },
      readingsInRange: () => [],
      close: () => undefined,
    };

    const loop = createControlLoop({
      sources: [co2Source('netatmo', 1300, MIDDAY)],
      store: unreadableStore,
      unit,
      log: log.log,
    });

    await loop.tick(MIDDAY);

    assert.deepEqual(unit.commands, [CONTROL.safeDefaultLevel]);
    assert.match(log.lines.join('\n'), /database is locked/);
  });

  it('survives a store that cannot be written', async () => {
    const unit = createFakeUnit(20);
    const log = recorder();
    const unwritableStore: ReadingStore = {
      insert: () => {
        throw new Error('disk is full');
      },
      latestReading: () => undefined,
      readingsInRange: () => [],
      close: () => undefined,
    };

    const loop = createControlLoop({
      sources: [co2Source('netatmo', 1300, MIDDAY)],
      store: unwritableStore,
      unit,
      log: log.log,
    });

    await loop.tick(MIDDAY);

    assert.deepEqual(unit.commands, [CONTROL.safeDefaultLevel]);
    assert.match(log.lines.join('\n'), /could not store 1 readings from netatmo: disk is full/);
    // The source polled perfectly well. Blaming it sends whoever is reading this
    // at 3am to the vendor's status page instead of to the disk.
    assert.doesNotMatch(log.lines.join('\n'), /did not report/);
  });

  it('retries a level the unit refused rather than recording it as achieved', async () => {
    const store = openReadingStore(':memory:');
    const unit = createFakeUnit(20);
    const log = recorder();
    const loop = createControlLoop({
      sources: [co2Source('netatmo', 1300, MIDDAY)],
      store,
      unit,
      log: log.log,
    });

    unit.failWrites = true;
    await loop.tick(MIDDAY);
    assert.deepEqual(unit.commands, []);

    unit.failWrites = false;
    await loop.tick(MIDDAY.add({ seconds: 30 }));
    assert.deepEqual(unit.commands, [80]);

    assert.match(log.lines.join('\n'), /could not command 80%/);
    store.close();
  });

  it('adopts the level the unit is already at, under the ceiling', async () => {
    // The wall panel can leave it at 100, which is a valid level to read and one
    // we may never command. Adopting it as 80 is the only honest starting point.
    const store = openReadingStore(':memory:');
    const unit = createFakeUnit(100);
    const loop = createControlLoop({
      sources: [co2Source('netatmo', 1250, MIDDAY)],
      store,
      unit,
      log: recorder().log,
    });

    await loop.tick(MIDDAY);

    assert.deepEqual(unit.commands, []);
    assert.equal(unit.level, 100);
    store.close();
  });

  it('falls back to the safe default when the unit cannot be read at startup', async () => {
    const store = openReadingStore(':memory:');
    const unit = createFakeUnit(20);
    const log = recorder();
    unit.failReads = true;

    const loop = createControlLoop({ sources: [], store, unit, log: log.log });
    await loop.tick(MIDDAY);

    assert.match(log.lines.join('\n'), /could not read the unit/);
    // Blind on both counts — no sensors and no read-back — so it holds the safe
    // default, which is where it assumed it already was. Nothing to command.
    assert.deepEqual(unit.commands, []);
    store.close();
  });

  it('cannot enforce the cap while the unit is unreadable, and resumes when it is', async () => {
    // The cap against the wall panel is the only protection the hard requirement
    // has, and it rests entirely on the read-back. A unit we cannot read is a
    // unit whose level we do not know, so there is nothing to enforce against —
    // correct by necessity, but it makes "not audible at night" depend on Modbus
    // reads succeeding, which is worth stating out loud and worth a test.
    const store = openReadingStore(':memory:');
    const unit = createFakeUnit(20);
    const log = recorder();
    const loop = createControlLoop({
      sources: [liveCo2Source('netatmo', 900).source],
      store,
      unit,
      log: log.log,
    });

    await loop.tick(NIGHT);
    assert.deepEqual(unit.commands, [40]);

    unit.level = 80; // the wall panel, at 02:00
    unit.failReads = true;
    await loop.tick(NIGHT.add({ seconds: 30 }));

    assert.equal(unit.level, 80, 'nothing can be corrected while the level is unknown');
    assert.deepEqual(unit.commands, [40]);
    assert.match(log.lines.join('\n'), /could not read the unit/);

    // And the moment the unit answers again, the breach is found and corrected.
    unit.failReads = false;
    await loop.tick(NIGHT.add({ minutes: 1 }));

    assert.equal(unit.level, CONTROL.sleepMaxLevel);
    assert.deepEqual(unit.commands, [40, CONTROL.sleepMaxLevel]);
    store.close();
  });

  it('reports a hand-set level in the daytime without acting on it', async () => {
    // Outside the sleep cap there is no requirement to enforce, so the mismatch
    // is visible and left alone: the panel wins until the controller changes its
    // mind for its own reasons. Compare the night case above, where it does not.
    const store = openReadingStore(':memory:');
    const unit = createFakeUnit(20);
    const log = recorder();
    const loop = createControlLoop({
      sources: [liveCo2Source('netatmo', 500).source],
      store,
      unit,
      log: log.log,
    });

    await loop.tick(MIDDAY);
    unit.level = 80;
    await loop.tick(MIDDAY.add({ seconds: 30 }));

    assert.match(log.lines.join('\n'), /the unit reports 80% and we are holding 20%/);
    assert.deepEqual(unit.commands, []);
    store.close();
  });

  it('reports desired and actual separately, which is what makes a mismatch visible', async () => {
    // The shape /api/state serves. Reporting one number would make "the fan is
    // at 80 because someone pressed a button" indistinguishable from "the fan is
    // at 80 because the air is bad", which is the one thing the endpoint is for.
    const store = openReadingStore(':memory:');
    const unit = createFakeUnit(20);
    const loop = createControlLoop({
      sources: [liveCo2Source('netatmo', 1400).source],
      store,
      unit,
      log: recorder().log,
    });

    assert.equal(loop.state(), undefined, 'there is no decision before the first tick');

    await loop.tick(NIGHT);
    unit.level = 100;
    await loop.tick(NIGHT.add({ seconds: 30 }));

    const state = loop.state();
    assert.ok(state !== undefined);
    assert.equal(state.level, CONTROL.sleepMaxLevel); // where we are holding it
    assert.equal(state.actualLevel, 100); // where the wall panel put it
    assert.equal(state.desiredLevel, 80); // what the air actually demands
    assert.equal(state.sleeping, true);
    assert.match(state.reasons.join(' '), /1400 ppm/);
    store.close();
  });

  it('pulls a hand-set level back under the sleep cap, in one move', async () => {
    // The hard requirement is silence in the bedroom at night. Without this the
    // panel defeats it: the loop would compare its own last command to its own
    // target, find them equal, write nothing, and log "50% held" for eight hours
    // while the fan ran at 80.
    const store = openReadingStore(':memory:');
    const unit = createFakeUnit(20);
    const loop = createControlLoop({
      sources: [liveCo2Source('netatmo', 900).source],
      store,
      unit,
      log: recorder().log,
    });

    await loop.tick(NIGHT);
    unit.level = 80; // somebody presses the wall panel at 02:00
    await loop.tick(NIGHT.add({ seconds: 30 }));

    assert.equal(unit.level, CONTROL.sleepMaxLevel);
    assert.deepEqual(unit.commands, [40, CONTROL.sleepMaxLevel]);
    store.close();
  });

  it('leaves a hand-set level below the cap alone', async () => {
    // Quieter than we asked for harms nobody, so the panel stays usable for the
    // thing people actually want it for at night. The original design pushed a
    // hand-set 30 back up to 50; this does not.
    const store = openReadingStore(':memory:');
    const unit = createFakeUnit(20);
    const loop = createControlLoop({
      sources: [liveCo2Source('netatmo', 900).source],
      store,
      unit,
      log: recorder().log,
    });

    await loop.tick(NIGHT);
    unit.level = 30;
    await loop.tick(NIGHT.add({ seconds: 30 }));

    assert.equal(unit.level, 30);
    assert.deepEqual(unit.commands, [40]);
    store.close();
  });

  it('does not claim to have commanded a level it only assumed', async () => {
    // The read fails at startup, so the level is adopted from the safe default —
    // nothing was ever sent. When the unit becomes readable and disagrees, the
    // report must not invent a command, and must not accuse the wall panel of a
    // mismatch that a transient read failure manufactured.
    const store = openReadingStore(':memory:');
    const unit = createFakeUnit(60);
    const log = recorder();
    const loop = createControlLoop({ sources: [], store, unit, log: log.log });

    unit.failReads = true;
    await loop.tick(MIDDAY);
    unit.failReads = false;
    await loop.tick(MIDDAY.add({ seconds: 30 }));

    assert.deepEqual(unit.commands, []);
    assert.match(log.lines.join('\n'), /the unit reports 60% and we are holding 40%/);
    assert.doesNotMatch(log.lines.join('\n'), /commanded/);
    store.close();
  });

  it('reports being out of capacity once it has been pinned long enough', async () => {
    // 1400 ppm is above C_HI + 10%, and the fan is already at its ceiling. That
    // is the intake grille or too many people, not a control failure.
    const store = openReadingStore(':memory:');
    const live = liveCo2Source('netatmo', 1400);
    const log = recorder();
    const loop = createControlLoop({
      sources: [live.source],
      store,
      unit: createFakeUnit(80),
      log: log.log,
    });

    await loop.tick(MIDDAY);
    await loop.tick(MIDDAY.add({ minutes: 9 }));
    assert.equal(capacityReports(log), 0, 'reported before the ten minutes were up');

    await loop.tick(MIDDAY.add({ minutes: 10 }));
    assert.equal(capacityReports(log), 1);
    assert.match(log.lines.join('\n'), /pinned at 80% with 1400 ppm in the bedroom/);

    store.close();
  });

  it('keeps saying so while it lasts, at most once per window', async () => {
    const store = openReadingStore(':memory:');
    const live = liveCo2Source('netatmo', 1400);
    const log = recorder();
    const loop = createControlLoop({
      sources: [live.source],
      store,
      unit: createFakeUnit(80),
      log: log.log,
    });

    for (let minute = 0; minute <= 30; minute += 0.5) {
      await loop.tick(MIDDAY.add({ seconds: minute * 60 }));
    }

    assert.equal(capacityReports(log), 3);
    store.close();
  });

  it('starts the clock again once the condition clears', async () => {
    const store = openReadingStore(':memory:');
    const live = liveCo2Source('netatmo', 1400);
    const log = recorder();
    const loop = createControlLoop({
      sources: [live.source],
      store,
      unit: createFakeUnit(80),
      log: log.log,
    });

    await loop.tick(MIDDAY);
    await loop.tick(MIDDAY.add({ minutes: 10 }));
    assert.equal(capacityReports(log), 1);

    // Still demanding the ceiling, but back inside the margin, so the unit is no
    // longer out of capacity — it is merely working hard.
    live.ppm = 1300;
    await loop.tick(MIDDAY.add({ minutes: 11 }));

    live.ppm = 1400;
    await loop.tick(MIDDAY.add({ minutes: 12 }));
    await loop.tick(MIDDAY.add({ minutes: 20 }));
    assert.equal(capacityReports(log), 1, 'the ten minutes started again from the clearing');

    await loop.tick(MIDDAY.add({ minutes: 22 }));
    assert.equal(capacityReports(log), 2);

    store.close();
  });

  it('does not report a capacity problem while the air is merely bad', async () => {
    // 1300 ppm is above the band and below the margin. The unit sitting at its
    // ceiling here is the design working, not the unit running out of air.
    const store = openReadingStore(':memory:');
    const live = liveCo2Source('netatmo', 1300);
    const log = recorder();
    const loop = createControlLoop({
      sources: [live.source],
      store,
      unit: createFakeUnit(80),
      log: log.log,
    });

    for (let minute = 0; minute <= 30; minute += 1) {
      await loop.tick(MIDDAY.add({ seconds: minute * 60 }));
    }

    assert.equal(capacityReports(log), 0);
    store.close();
  });

  it('does not cry capacity while the sleep cap is what is holding the fan down', async () => {
    // 1400 ppm all night, but the unit is at 50 because someone is asleep. The
    // fan is not out of capacity; it is under orders. Without the ceiling half
    // of the condition this fires every ten minutes, every night.
    const store = openReadingStore(':memory:');
    const live = liveCo2Source('netatmo', 1400);
    const log = recorder();
    const loop = createControlLoop({
      sources: [live.source],
      store,
      unit: createFakeUnit(20),
      log: log.log,
    });

    for (let minute = 0; minute <= 30; minute += 0.5) {
      await loop.tick(NIGHT.add({ seconds: minute * 60 }));
    }

    assert.equal(capacityReports(log), 0);
    store.close();
  });

  it('does not let a failed write freeze the capacity clock', async () => {
    // The air clears while the unit cannot be written to. If that tick skips the
    // diagnostic, the clearing is never seen, and when the air goes bad again the
    // alarm dates itself from before it — firing early and claiming ten minutes
    // of a condition that lasted two.
    const store = openReadingStore(':memory:');
    const live = liveCo2Source('netatmo', 1400);
    const unit = createFakeUnit(80);
    const log = recorder();
    const loop = createControlLoop({ sources: [live.source], store, unit, log: log.log });

    await loop.tick(MIDDAY);

    live.ppm = 500;
    unit.failWrites = true;
    await loop.tick(MIDDAY.add({ minutes: 1 }));

    live.ppm = 1400;
    unit.failWrites = false;
    for (let minute = 2; minute <= 10; minute += 1) {
      await loop.tick(MIDDAY.add({ seconds: minute * 60 }));
    }

    // The condition re-asserted at minute two, so the earliest honest alarm is
    // minute twelve.
    assert.equal(capacityReports(log), 0);
    store.close();
  });

  it('carries the sleep state from one tick to the next', async () => {
    // The R1 regression, at the level the loop is responsible for: the extender
    // only works if the loop remembers what the last cycle decided. Keyed to the
    // clock alone, this jumps to 80 at 07:00 into a bedroom of sleeping people.
    const store = openReadingStore(':memory:');
    const live = liveCo2Source('netatmo', 1300);
    const unit = createFakeUnit(20);
    const loop = createControlLoop({ sources: [live.source], store, unit, log: recorder().log });

    await loop.tick(Temporal.Instant.from('2026-01-15T05:50:00Z')); // 06:50 Prague, inside quiet hours
    await loop.tick(Temporal.Instant.from('2026-01-15T06:05:00Z')); // 07:05 Prague, and the room has not cleared

    assert.deepEqual(unit.commands, [CONTROL.sleepMaxLevel]);
    store.close();
  });

  it('carries the dwell timer from one tick to the next', async () => {
    // Twenty minutes of evaluations every thirty seconds. If the loop forgot when
    // it last changed, the whole range would be given back inside three minutes.
    const store = openReadingStore(':memory:');
    const live = liveCo2Source('netatmo', 500);
    const unit = createFakeUnit(80);
    const loop = createControlLoop({ sources: [live.source], store, unit, log: recorder().log });

    for (let minute = 0; minute <= 20; minute += 0.5) {
      await loop.tick(MIDDAY.add({ seconds: minute * 60 }));
    }

    assert.deepEqual(unit.commands, [70, 60, 50]);
    store.close();
  });

  it('respects each source own poll interval', async () => {
    const store = openReadingStore(':memory:');
    let polls = 0;
    const counted: SensorSource = {
      name: 'netatmo',
      pollInterval: Temporal.Duration.from({ minutes: 8 }),
      async poll(now: Temporal.Instant): Promise<readonly Reading[]> {
        polls += 1;
        return [reading('bedroom_netatmo', 'co2', 700, now)];
      },
    };

    const loop = createControlLoop({
      sources: [counted],
      store,
      unit: createFakeUnit(40),
      log: recorder().log,
    });

    for (let tick = 0; tick < 20; tick += 1) {
      await loop.tick(MIDDAY.add({ seconds: tick * 30 }));
    }

    // Twenty ticks is ten minutes: the first poll, and one more once the eight
    // minutes were up.
    assert.equal(polls, 2);
    store.close();
  });
});

function reading(sourceId: SensorId, kind: MeasurementKind, value: number, measuredAt: Temporal.Instant): Reading {
  return { sourceId, kind, value, measuredAt, receivedAt: measuredAt };
}

function capacityReports(log: Recorder): number {
  return log.lines.filter((line) => line.includes('a capacity problem')).length;
}
