import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CONTROL, PRECEDENCE, ROOM_IDS, SENSORS } from '../src/config.ts';
import { MEASUREMENT_KINDS } from '../src/domain/measurement.ts';

describe('the band, which is the number that decides whether the loop settles', () => {
  // The band must be at least as wide as the CO2 swing the fan can itself
  // produce, or loop gain exceeds 1 and it hunts however much hysteresis is
  // added. Nobody has measured that swing for this flat; the plausible range is
  // 350-1100 ppm and 700 is a middle bet.
  //
  // This lives in a test rather than as a runtime check at config load because
  // turning an estimate into an invariant means picking the number that makes
  // the assertion pass. Here it records the current belief, and narrowing the
  // band fails loudly with the reason attached.
  const BELIEVED_FAN_AUTHORITY_PPM = 700;

  it('is at least as wide as the fan authority we currently believe in', () => {
    const width = CONTROL.bandHighPpm - CONTROL.bandLowPpm;
    assert.ok(
      width >= BELIEVED_FAN_AUTHORITY_PPM,
      `band is ${width} ppm wide, below the ${BELIEVED_FAN_AUTHORITY_PPM} ppm the fan is believed to swing`,
    );
  });

  it('has hysteresis smaller than one step, or no step is ever reachable', () => {
    const stepWidth = (CONTROL.bandHighPpm - CONTROL.bandLowPpm) / 6;
    assert.ok(
      CONTROL.hysteresisPpm < stepWidth,
      `hysteresis ${CONTROL.hysteresisPpm} ppm is not smaller than the ${stepWidth} ppm step`,
    );
  });
});

describe('the dwell floor', () => {
  it('is never shorter than the slowest CO2 source refreshes', () => {
    // Netatmo refreshes every 7-8 minutes on their side. Stepping down faster
    // than that means acting again before the last step could be observed.
    const slowestCo2RefreshMinutes = 8;
    assert.ok(CONTROL.minDwellMinutes >= slowestCo2RefreshMinutes);
  });
});

describe('topology', () => {
  it('ranks every sensor for every kind it reports', () => {
    // The mistake this catches: adding a sensor and forgetting to rank it, which
    // leaves it collecting readings that nothing ever consults.
    for (const [sensorId, sensor] of Object.entries(SENSORS)) {
      if (!sensor.isActive) continue;
      for (const kind of sensor.kinds) {
        const order = PRECEDENCE[sensor.room][kind] ?? [];
        assert.ok(
          order.some((ranked) => ranked === sensorId),
          `${sensorId} reports ${kind} but is not ranked for ${sensor.room}`,
        );
      }
    }
  });

  it('ranks only sensors that are in the room and report the kind', () => {
    for (const room of ROOM_IDS) {
      for (const kind of MEASUREMENT_KINDS) {
        const order = PRECEDENCE[room][kind] ?? [];
        for (const sensorId of order) {
          const sensor = SENSORS[sensorId];
          assert.equal(sensor.room, room, `${sensorId} is ranked in ${room} but lives in ${sensor.room}`);
          assert.ok(
            sensor.kinds.some((reported) => reported === kind),
            `${sensorId} is ranked for ${kind} but does not report it`,
          );
        }
      }
    }
  });

  it('never ranks a sensor that is out of service', () => {
    // isActive is descriptive; the ranked lists decide who is consulted. This is
    // what keeps the two from disagreeing — a decommissioned instrument left in
    // one of the lists would keep winning for that kind, silently, and taking a
    // sensor out means one edit per kind, which is exactly where a half-finished
    // removal happens.
    for (const [sensorId, sensor] of Object.entries(SENSORS)) {
      if (sensor.isActive) continue;

      for (const room of ROOM_IDS) {
        for (const kind of MEASUREMENT_KINDS) {
          const order = PRECEDENCE[room][kind] ?? [];
          assert.ok(
            !order.some((ranked) => ranked === sensorId),
            `${sensorId} is out of service but is still ranked for ${room} ${kind}`,
          );
        }
      }
    }
  });

  it('names each sensor at most once per kind', () => {
    for (const room of ROOM_IDS) {
      for (const kind of MEASUREMENT_KINDS) {
        const order = PRECEDENCE[room][kind] ?? [];
        assert.equal(new Set(order).size, order.length, `duplicate source ranked for ${room} ${kind}`);
      }
    }
  });

  it('has no CO2 instrument outside the bedroom yet', () => {
    // Not an aspiration — a fact that shapes the tests. Living-room CO2 is
    // genuinely `missing` until a SEN66 is installed, and the controller has
    // exactly one instrument standing between it and the safe default.
    assert.deepEqual(PRECEDENCE.living_room.co2, undefined);
    assert.deepEqual(PRECEDENCE.kids_room.co2, undefined);
    assert.deepEqual(PRECEDENCE.bedroom.co2, ['bedroom_netatmo']);
  });

  it('gives Netatmo a window wide enough for two of its own refreshes', () => {
    // The per-source design in one assertion: Tado's window would call a
    // perfectly healthy Netatmo reading dead within two minutes.
    assert.ok(SENSORS.bedroom_netatmo.freshnessWindowMs >= 15 * 60_000);
    assert.ok(SENSORS.bedroom_tado.freshnessWindowMs < SENSORS.bedroom_netatmo.freshnessWindowMs);
  });
});
