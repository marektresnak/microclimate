import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SENSORS } from '../src/config.ts';
import { toRoomSignal } from '../src/control/freshness.ts';
import type { Reading } from '../src/domain/measurement.ts';

const NOW = Date.UTC(2026, 7, 10, 12, 0, 0);
const SECOND = 1_000;
const MINUTE = 60_000;
const WINDOW = 90 * SECOND;

function co2ReadingAt(measuredAt: number, receivedAt = measuredAt): Reading {
  return { sourceId: 'bedroom_netatmo', kind: 'co2', value: 812, measuredAt, receivedAt };
}

describe('freshness', () => {
  it('calls a reading inside the window fresh', () => {
    const signal = toRoomSignal(co2ReadingAt(NOW - 30 * SECOND), NOW, WINDOW);

    assert.equal(signal.status, 'fresh');
  });

  it('calls a reading exactly at the window boundary fresh', () => {
    // Inclusive. Pinned either way, but pinned.
    const signal = toRoomSignal(co2ReadingAt(NOW - WINDOW), NOW, WINDOW);

    assert.equal(signal.status, 'fresh');
  });

  it('calls a reading one millisecond past the window stale', () => {
    const signal = toRoomSignal(co2ReadingAt(NOW - WINDOW - 1), NOW, WINDOW);

    assert.equal(signal.status, 'stale');
  });

  it('carries the last value and its timestamp through staleness', () => {
    // A stale reading is excluded from demand, but a dashboard showing
    // "1100 ppm, 40 minutes ago" is telling you something a blank cannot.
    const measuredAt = NOW - 40 * MINUTE;
    const signal = toRoomSignal(co2ReadingAt(measuredAt), NOW, WINDOW);

    assert.deepEqual(signal, {
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

    assert.deepEqual(signal, {
      status: 'fresh',
      sourceId: 'bedroom_netatmo',
      value: 812,
      measuredAt: NOW,
    });
  });

  it('distinguishes never heard from from went quiet', () => {
    const neverHeardFrom = toRoomSignal(undefined, NOW, WINDOW);
    const wentQuiet = toRoomSignal(co2ReadingAt(NOW - 2 * WINDOW), NOW, WINDOW);

    assert.deepEqual(neverHeardFrom, { status: 'missing' });
    assert.equal(wentQuiet.status, 'stale');
  });

  it('tolerates a reading from the near future', () => {
    // Small clock skew between us and the instrument. Taking a healthy sensor
    // offline over two seconds of drift would be the worse failure.
    const signal = toRoomSignal(co2ReadingAt(NOW + 2 * SECOND), NOW, WINDOW);

    assert.equal(signal.status, 'fresh');
  });

  it('ignores when we received the reading, only when it was measured', () => {
    // Netatmo hands us readings minutes after it took them, and a push node
    // replaying a backlog hands us hours-old ones. Judging on arrival time
    // would make a twelve-hour-old reading look brand new.
    const measuredAnHourAgo = co2ReadingAt(NOW - 60 * MINUTE, NOW);

    assert.equal(toRoomSignal(measuredAnHourAgo, NOW, WINDOW).status, 'stale');
  });

  it('gives the same reading two different verdicts under two windows', () => {
    // The whole per-source design in one assertion. Eight minutes old is a
    // perfectly healthy Netatmo reading and a long-dead Tado one.
    const eightMinutesOld = co2ReadingAt(NOW - 8 * MINUTE);

    assert.equal(
      toRoomSignal(eightMinutesOld, NOW, SENSORS.bedroom_netatmo.freshnessWindowMs).status,
      'fresh',
    );
    assert.equal(
      toRoomSignal(eightMinutesOld, NOW, SENSORS.bedroom_tado.freshnessWindowMs).status,
      'stale',
    );
  });
});
