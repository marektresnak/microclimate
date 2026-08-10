import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CONTROL } from '../src/config.ts';
import type { SensorId } from '../src/config.ts';
import { bandLevel, decide } from '../src/control/policy.ts';
import type { CommandedLevel } from '../src/domain/level.ts';
import type { Snapshot } from '../src/domain/decision.ts';
import type { RoomSignal } from '../src/domain/signal.ts';

// Europe/Prague is UTC+1 in January and UTC+2 in July, so every constant below
// is written as UTC with its local meaning spelled out.
const WINTER_MIDDAY = Date.UTC(2026, 0, 15, 11, 0); // 12:00 local
const WINTER_AFTERNOON = Date.UTC(2026, 0, 15, 14, 0); // 15:00 local
const WINTER_2159 = Date.UTC(2026, 0, 15, 20, 59); // 21:59 local
const WINTER_2200 = Date.UTC(2026, 0, 15, 21, 0); // 22:00 local
const WINTER_2330 = Date.UTC(2026, 0, 15, 22, 30); // 23:30 local
const WINTER_0200 = Date.UTC(2026, 0, 15, 1, 0); // 02:00 local
const WINTER_0659 = Date.UTC(2026, 0, 15, 5, 59); // 06:59 local
const WINTER_0700 = Date.UTC(2026, 0, 15, 6, 0); // 07:00 local
const WINTER_0705 = Date.UTC(2026, 0, 15, 6, 5); // 07:05 local

const MISSING: RoomSignal = { status: 'missing' };

function fresh(sourceId: SensorId, value: number): RoomSignal {
  return { status: 'fresh', sourceId, value, measuredAt: 0 };
}

function stale(sourceId: SensorId, value: number): RoomSignal {
  return { status: 'stale', sourceId, value, measuredAt: 0 };
}

interface SnapshotOptions {
  readonly livingRoom?: RoomSignal;
  readonly kidsRoom?: RoomSignal;
  readonly bedroom?: RoomSignal;
  readonly currentLevel?: CommandedLevel;
  readonly wasSleeping?: boolean;
}

// The policy only passes sourceId through to its reasons, so which instrument a
// synthetic signal names changes no rule. The kids' room has no CO2 instrument
// until a SEN66 is installed; these cases are what the policy will do when it is.
function snapshotOf(options: SnapshotOptions): Snapshot {
  return {
    co2ByRoom: {
      living_room: options.livingRoom ?? MISSING,
      kids_room: options.kidsRoom ?? MISSING,
      bedroom: options.bedroom ?? MISSING,
    },
    currentLevel: options.currentLevel ?? 40,
    wasSleeping: options.wasSleeping ?? false,
  };
}

describe('the proportional band', () => {
  it('runs from the floor at C_LO to the ceiling at C_HI', () => {
    assert.equal(bandLevel(CONTROL.bandLowPpm), 20);
    assert.equal(bandLevel(CONTROL.bandHighPpm), 80);
  });

  it('never asks for 90 or 100, however bad the air is', () => {
    // The intake grille, not the device. 80 is the ceiling and it is a type,
    // but the band is where a mistake would first show up.
    assert.equal(bandLevel(2_000), 80);
    assert.equal(bandLevel(10_000), 80);
  });

  it('never falls below the floor, however good the air is', () => {
    // The unit is never turned off.
    assert.equal(bandLevel(400), 20);
    assert.equal(bandLevel(0), 20);
  });

  it('maps the line onto the seven steps', () => {
    const table: readonly (readonly [number, CommandedLevel])[] = [
      [400, 20],
      [600, 20],
      [610, 30],
      [700, 30],
      [730, 40],
      [850, 50],
      [1000, 60],
      [1100, 70],
      [1200, 80],
      [1600, 80],
    ];

    for (const [co2, expected] of table) {
      assert.equal(bandLevel(co2), expected, `${co2} ppm should be ${expected}%`);
    }
  });

  it('is monotonic — worse air never asks for less fan', () => {
    let previous = bandLevel(200);
    for (let co2 = 200; co2 <= 2_000; co2 += 5) {
      const level = bandLevel(co2);
      assert.ok(level >= previous, `${co2} ppm asked for ${level}% after ${previous}%`);
      previous = level;
    }
  });
});

describe('demand', () => {
  it('lets the worst fresh room drive', () => {
    const snapshot = snapshotOf({
      bedroom: fresh('bedroom_netatmo', 600),
      kidsRoom: fresh('kids_room_tado_left', 1120),
      currentLevel: 20,
    });

    assert.equal(decide(snapshot, WINTER_MIDDAY).desiredLevel, 60);
  });

  it('excludes a stale LOW reading rather than averaging the demand down', () => {
    // A dead sensor sitting at 400 ppm must never read as good air.
    const snapshot = snapshotOf({
      bedroom: stale('bedroom_netatmo', 400),
      kidsRoom: fresh('kids_room_tado_left', 1100),
      currentLevel: 20,
    });

    assert.equal(decide(snapshot, WINTER_MIDDAY).desiredLevel, 60);
  });

  it('excludes a stale HIGH reading rather than pinning the unit at the ceiling', () => {
    // The symmetric failure, and the one that is easy to forget: a sensor last
    // seen at 1400 ppm must not hold the fan at full power indefinitely.
    const snapshot = snapshotOf({
      kidsRoom: stale('kids_room_tado_left', 1400),
      bedroom: fresh('bedroom_netatmo', 500),
      currentLevel: 80,
    });

    assert.equal(decide(snapshot, WINTER_MIDDAY).desiredLevel, 20);
  });

  it('lets a missing room contribute nothing without blocking the others', () => {
    const snapshot = snapshotOf({
      livingRoom: MISSING,
      bedroom: fresh('bedroom_netatmo', 1300),
      currentLevel: 20,
    });

    assert.equal(decide(snapshot, WINTER_MIDDAY).desiredLevel, 80);
  });

  it('holds the safe default when no room has a fresh reading', () => {
    // Moderate continuous ventilation is the right answer when blind: quieter
    // than boosting, safer than idling, and never the minimum.
    const snapshot = snapshotOf({
      bedroom: stale('bedroom_netatmo', 1400),
      currentLevel: 20,
    });

    const decision = decide(snapshot, WINTER_MIDDAY);

    assert.equal(decision.desiredLevel, CONTROL.safeDefaultLevel);
    assert.ok(decision.desiredLevel > 20, 'the blind fallback must never be the minimum');
    assert.match(decision.reasons.join(' '), /no fresh CO2/);
  });

  it('names the room, the instrument and the reading that drove the decision', () => {
    const snapshot = snapshotOf({
      bedroom: fresh('bedroom_netatmo', 1180),
      currentLevel: 20,
    });

    const reasons = decide(snapshot, WINTER_MIDDAY).reasons.join(' ');

    assert.match(reasons, /bedroom/);
    assert.match(reasons, /bedroom_netatmo/);
    assert.match(reasons, /1180 ppm/);
  });
});

describe('hysteresis', () => {
  // The 40/50 boundary sits at 841.7 ppm: the band spans six steps of 116.7 ppm
  // each, and hysteresis is 60 ppm either side of every boundary.
  const BOUNDARY_40_50 = 841.7;

  it('gives the same reading opposite answers depending on where the fan is', () => {
    // Nothing else in the controller behaves like this, and it is the whole
    // point: 850 ppm while running low stays low, while running high stays high.
    //
    // Both readings are needed, and one is not enough. 850 is above the boundary,
    // so the raw band already answers 50 and only the *upward* bias is doing work
    // there; 822 is below it, so only the downward bias is. Assert one of them
    // and half the mechanism can be deleted without a test noticing.
    const above = 850;
    const below = 822;

    assert.equal(decide(snapshotOf({ bedroom: fresh('bedroom_netatmo', above), currentLevel: 40 }), WINTER_MIDDAY).desiredLevel, 40);
    assert.equal(decide(snapshotOf({ bedroom: fresh('bedroom_netatmo', above), currentLevel: 50 }), WINTER_MIDDAY).desiredLevel, 50);
    assert.equal(decide(snapshotOf({ bedroom: fresh('bedroom_netatmo', below), currentLevel: 40 }), WINTER_MIDDAY).desiredLevel, 40);
    assert.equal(decide(snapshotOf({ bedroom: fresh('bedroom_netatmo', below), currentLevel: 50 }), WINTER_MIDDAY).desiredLevel, 50);
  });

  it('does not flutter when a reading wobbles across a boundary from above', () => {
    // The mirror of the case below it. Running at 50, a reading that dips under
    // the boundary but not past the hysteresis must not drag the level down.
    for (const co2 of [BOUNDARY_40_50 + 20, BOUNDARY_40_50, BOUNDARY_40_50 - 20]) {
      const snapshot = snapshotOf({ bedroom: fresh('bedroom_netatmo', co2), currentLevel: 50 });
      assert.equal(decide(snapshot, WINTER_MIDDAY).desiredLevel, 50, `${co2} ppm moved the level`);
    }
  });

  it('does not flutter when a reading wobbles across a boundary', () => {
    for (const co2 of [BOUNDARY_40_50 - 20, BOUNDARY_40_50, BOUNDARY_40_50 + 20]) {
      const snapshot = snapshotOf({ bedroom: fresh('bedroom_netatmo', co2), currentLevel: 40 });
      assert.equal(decide(snapshot, WINTER_MIDDAY).desiredLevel, 40, `${co2} ppm moved the level`);
    }
  });

  it('lets a reading that clears the boundary by more than the hysteresis through', () => {
    const rising = snapshotOf({
      bedroom: fresh('bedroom_netatmo', BOUNDARY_40_50 + CONTROL.hysteresisPpm + 1),
      currentLevel: 40,
    });
    const falling = snapshotOf({
      bedroom: fresh('bedroom_netatmo', BOUNDARY_40_50 - CONTROL.hysteresisPpm - 1),
      currentLevel: 50,
    });

    assert.equal(decide(rising, WINTER_MIDDAY).desiredLevel, 50);
    assert.equal(decide(falling, WINTER_MIDDAY).desiredLevel, 40);
  });

  it('says so in the reasons when it is what held the level', () => {
    const snapshot = snapshotOf({ bedroom: fresh('bedroom_netatmo', 850), currentLevel: 40 });

    assert.match(decide(snapshot, WINTER_MIDDAY).reasons.join(' '), /hysteresis/);
  });
});

describe('sleep', () => {
  it('is asserted by quiet hours whatever CO2 says', () => {
    const snapshot = snapshotOf({ bedroom: fresh('bedroom_netatmo', 450) });

    assert.equal(decide(snapshot, WINTER_2330).sleeping, true);
  });

  it('wraps midnight', () => {
    // 22:00-07:00 is `hour >= 22 || hour < 7`. Written with `&&` it is always
    // false and the night cap silently never fires. Most likely bug in the project.
    const snapshot = snapshotOf({});

    assert.equal(decide(snapshot, WINTER_2330).sleeping, true);
    assert.equal(decide(snapshot, WINTER_0200).sleeping, true);
    assert.equal(decide(snapshot, WINTER_MIDDAY).sleeping, false);
  });

  it('starts exactly at 22:00 and ends exactly at 07:00', () => {
    const snapshot = snapshotOf({});

    assert.equal(decide(snapshot, WINTER_2159).sleeping, false);
    assert.equal(decide(snapshot, WINTER_2200).sleeping, true);
    assert.equal(decide(snapshot, WINTER_0659).sleeping, true);
    assert.equal(decide(snapshot, WINTER_0700).sleeping, false);
  });

  it('reads the hour in the configured zone, not the host clock', () => {
    // The same instant in UTC, six months apart. 20:30 UTC is 21:30 in Prague
    // in January and 22:30 in July, and only one of those is quiet hours.
    const januaryEvening = Date.UTC(2026, 0, 15, 20, 30);
    const julyEvening = Date.UTC(2026, 6, 15, 20, 30);
    const snapshot = snapshotOf({});

    assert.equal(decide(snapshot, januaryEvening).sleeping, false);
    assert.equal(decide(snapshot, julyEvening).sleeping, true);
  });

  it('is still asserted at 3am with every sensor dead', () => {
    // Quiet hours consults no sensor, which is the point of keeping it. A dead
    // Netatmo must never let the unit run loud at night.
    const snapshot = snapshotOf({ currentLevel: 80 });

    assert.equal(decide(snapshot, WINTER_0200).sleeping, true);
  });

  it('is NOT asserted by bedroom CO2 alone', () => {
    // The afternoon nap is deliberately uncovered. Asserting on CO2 alone
    // self-latches: the band puts 50% near 900 ppm, so every reading that
    // demands more than 50 has already crossed 700 and capped the response at
    // 50 — and with the bedroom door open, a busy flat gets there with nobody
    // in bed.
    const snapshot = snapshotOf({
      bedroom: fresh('bedroom_netatmo', 1100),
      wasSleeping: false,
      currentLevel: 20,
    });

    const decision = decide(snapshot, WINTER_AFTERNOON);

    assert.equal(decision.sleeping, false);
    assert.equal(decision.desiredLevel, 60);
  });

  it('is extended past 07:00 while the bedroom has not cleared', () => {
    // The regression two independent reviewers found by reasoning: keyed to the
    // clock alone, the cap lifts at 07:00 into a bedroom where people are still
    // asleep. It has to lift when the room clears, not when the clock strikes.
    const snapshot = snapshotOf({
      bedroom: fresh('bedroom_netatmo', 1300),
      wasSleeping: true,
      currentLevel: 50,
    });

    assert.equal(decide(snapshot, WINTER_0705).sleeping, true);
  });

  it('releases as soon as the bedroom clears, with no hold', () => {
    // There is nothing to chatter between: the term can only ever release, and
    // once released only quiet hours can assert sleep again.
    const snapshot = snapshotOf({
      bedroom: fresh('bedroom_netatmo', CONTROL.sleepCo2Ppm),
      wasSleeping: true,
      currentLevel: 50,
    });

    assert.equal(decide(snapshot, WINTER_0705).sleeping, false);
  });

  it('is not extended by a stale or missing bedroom reading', () => {
    // Only a fresh reading can hold the cap on. A dead Netatmo must not cap
    // ventilation all day.
    const staleBedroom = snapshotOf({
      bedroom: stale('bedroom_netatmo', 1300),
      wasSleeping: true,
    });
    const noBedroom = snapshotOf({ wasSleeping: true });

    assert.equal(decide(staleBedroom, WINTER_0705).sleeping, false);
    assert.equal(decide(noBedroom, WINTER_0705).sleeping, false);
  });

  it('is not extended by another room being stuffy', () => {
    // Only the bedroom bears on sleep. Demand comes from everywhere.
    const snapshot = snapshotOf({
      livingRoom: fresh('living_room_tado', 1400),
      bedroom: fresh('bedroom_netatmo', 500),
      wasSleeping: true,
      currentLevel: 20,
    });

    const decision = decide(snapshot, WINTER_0705);

    assert.equal(decision.sleeping, false);
    assert.equal(decision.desiredLevel, 80);
  });

  it('does not apply the cap — that is the limiter job', () => {
    // Keeping the clamp in one place matters more than it looks: the policy
    // must keep tracking real demand all night, or leaving quiet hours becomes
    // a jump to a level nobody asked for.
    const snapshot = snapshotOf({
      bedroom: fresh('bedroom_netatmo', 1400),
      currentLevel: 50,
    });

    const decision = decide(snapshot, WINTER_0200);

    assert.equal(decision.sleeping, true);
    assert.equal(decision.desiredLevel, 80);
  });

  it('records both the demand and the sleep in its reasons', () => {
    const snapshot = snapshotOf({
      bedroom: fresh('bedroom_netatmo', 1400),
      currentLevel: 50,
    });

    const reasons = decide(snapshot, WINTER_0200).reasons.join(' ');

    assert.match(reasons, /quiet hours/);
    assert.match(reasons, /1400 ppm/);
  });
});
