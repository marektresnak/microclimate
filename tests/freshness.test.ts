import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SENSORS } from '../src/config.ts';
import { toRoomSignal } from '../src/control/freshness.ts';
import type { Reading } from '../src/domain/measurement.ts';
import { assertDeepEqual } from './support/deep-equal.ts';

const NOW = Temporal.Instant.from('2026-08-10T12:00:00Z');
const WINDOW = Temporal.Duration.from({ seconds: 90 });

function co2ReadingAt(measuredAt: Temporal.Instant, receivedAt = measuredAt): Reading {
  return { sourceId: 'bedroom_netatmo', kind: 'co2', value: 812, measuredAt, receivedAt };
}

describe('freshness', () => {
  it('calls a reading inside the window fresh', () => {
    const signal = toRoomSignal(co2ReadingAt(NOW.subtract({ seconds: 30 })), NOW, WINDOW);

    assert.equal(signal.status, 'fresh');
  });

  it('calls a reading exactly at the window boundary fresh', () => {
    // Inclusive. Pinned either way, but pinned.
    const signal = toRoomSignal(co2ReadingAt(NOW.subtract(WINDOW)), NOW, WINDOW);

    assert.equal(signal.status, 'fresh');
  });

  it('calls a reading one millisecond past the window stale', () => {
    const oneMsPast = NOW.subtract(WINDOW).subtract({ milliseconds: 1 });
    const signal = toRoomSignal(co2ReadingAt(oneMsPast), NOW, WINDOW);

    assert.equal(signal.status, 'stale');
  });

  it('carries the last value and its timestamp through staleness', () => {
    // A stale reading is excluded from demand, but a dashboard showing
    // "1100 ppm, 40 minutes ago" is telling you something a blank cannot.
    const measuredAt = NOW.subtract({ minutes: 40 });
    const signal = toRoomSignal(co2ReadingAt(measuredAt), NOW, WINDOW);

    assertDeepEqual(signal, {
      status: 'stale',
      sourceId: 'bedroom_netatmo',
      value: 812,
      measuredAt,
    });
  });

  it('names the instrument that produced a fresh reading', () => {
    // The moment a number looks wrong, the first question is which instrument
    // said so, and the answer should already be in the response.
    const signal = toRoomSignal(co2ReadingAt(NOW), NOW, WINDOW);

    assertDeepEqual(signal, {
      status: 'fresh',
      sourceId: 'bedroom_netatmo',
      value: 812,
      measuredAt: NOW,
    });
  });

  it('distinguishes never heard from from went quiet', () => {
    const neverHeardFrom = toRoomSignal(undefined, NOW, WINDOW);
    const wentQuiet = toRoomSignal(co2ReadingAt(NOW.subtract({ seconds: 180 })), NOW, WINDOW);

    assertDeepEqual(neverHeardFrom, { status: 'missing' });
    assert.equal(wentQuiet.status, 'stale');
  });

  it('tolerates a reading from the near future', () => {
    // Small clock skew between us and the instrument. Taking a healthy sensor
    // offline over two seconds of drift would be the worse failure.
    const signal = toRoomSignal(co2ReadingAt(NOW.add({ seconds: 2 })), NOW, WINDOW);

    assert.equal(signal.status, 'fresh');
  });

  it('ignores when we received the reading, only when it was measured', () => {
    // Netatmo hands us readings minutes after it took them, and a push node
    // replaying a backlog hands us hours-old ones. Judging on arrival time
    // would make a twelve-hour-old reading look brand new.
    const measuredAnHourAgo = co2ReadingAt(NOW.subtract({ minutes: 60 }), NOW);

    assert.equal(toRoomSignal(measuredAnHourAgo, NOW, WINDOW).status, 'stale');
  });

  it('gives the same reading two different verdicts under two windows', () => {
    // The whole per-source design in one assertion. Eight minutes old is a
    // perfectly healthy Netatmo reading and a long-dead Tado one.
    const eightMinutesOld = co2ReadingAt(NOW.subtract({ minutes: 8 }));

    assert.equal(
      toRoomSignal(eightMinutesOld, NOW, SENSORS.bedroom_netatmo.freshnessWindow).status,
      'fresh',
    );
    assert.equal(
      toRoomSignal(eightMinutesOld, NOW, SENSORS.bedroom_tado.freshnessWindow).status,
      'stale',
    );
  });
});
