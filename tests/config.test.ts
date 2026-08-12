import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PRECEDENCE, ROOM_IDS, SENSORS } from '../src/config.ts';
import { MEASUREMENT_KINDS } from '../src/domain/measurement.ts';
import { assertDeepEqual } from './support/deep-equal.ts';

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
    // genuinely `missing` until a SEN66 is installed.
    assertDeepEqual(PRECEDENCE.living_room.co2, undefined);
    assertDeepEqual(PRECEDENCE.kids_room.co2, undefined);
    assertDeepEqual(PRECEDENCE.bedroom.co2, ['bedroom_netatmo']);
  });

  it('gives Netatmo a window wide enough for two of its own refreshes', () => {
    // The per-source design in one assertion: Tado's window would call a
    // perfectly healthy Netatmo reading dead within two minutes.
    assert.ok(Temporal.Duration.compare(SENSORS.bedroom_netatmo.freshnessWindow, { minutes: 15 }) >= 0);
    assert.ok(
      Temporal.Duration.compare(SENSORS.bedroom_tado.freshnessWindow, SENSORS.bedroom_netatmo.freshnessWindow) < 0,
    );
  });
});
