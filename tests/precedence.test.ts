import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SensorId } from '../src/config.ts';
import type { MeasurementKind, Reading } from '../src/domain/measurement.ts';
import { resolveSignal } from '../src/domain/precedence.ts';

const NOW = Date.UTC(2026, 7, 10, 12, 0, 0);
const SECOND = 1_000;
const MINUTE = 60_000;

function reading(sourceId: SensorId, kind: MeasurementKind, value: number, ageMs: number): Reading {
  return { sourceId, kind, value, measuredAt: NOW - ageMs, receivedAt: NOW };
}

describe('precedence', () => {
  it('lets the highest-ranked fresh source win, and names it', () => {
    const readings = [
      reading('kids_room_tado_left', 'temperature', 21.5, 20 * SECOND),
      reading('kids_room_tado_right', 'temperature', 23.1, 20 * SECOND),
    ];

    assert.deepEqual(resolveSignal('kids_room', 'temperature', readings, NOW), {
      status: 'fresh',
      sourceId: 'kids_room_tado_left',
      // Exactly one instrument's reading, never a mean of the two. The valves
      // sit next to different radiators; an average describes neither.
      value: 21.5,
      measuredAt: NOW - 20 * SECOND,
    });
  });

  it('ignores recency while a choice between live instruments exists', () => {
    // The lower-ranked valve reported one second ago and the higher-ranked one
    // a minute ago. Both are fresh, so trust decides, not recency.
    const readings = [
      reading('kids_room_tado_left', 'temperature', 21.5, 60 * SECOND),
      reading('kids_room_tado_right', 'temperature', 23.1, 1 * SECOND),
    ];

    assert.deepEqual(resolveSignal('kids_room', 'temperature', readings, NOW), {
      status: 'fresh',
      sourceId: 'kids_room_tado_left',
      value: 21.5,
      measuredAt: NOW - 60 * SECOND,
    });
  });

  it('falls through to the next source when the first has gone stale', () => {
    const readings = [
      reading('kids_room_tado_left', 'temperature', 21.5, 10 * MINUTE),
      reading('kids_room_tado_right', 'temperature', 23.1, 20 * SECOND),
    ];

    assert.deepEqual(resolveSignal('kids_room', 'temperature', readings, NOW), {
      status: 'fresh',
      sourceId: 'kids_room_tado_right',
      value: 23.1,
      measuredAt: NOW - 20 * SECOND,
    });
  });

  it('reports the most recently measured reading once nothing is fresh (Q3)', () => {
    // Precedence encodes trust, and trust is what matters while there is a
    // choice between live instruments. Once nothing is fresh there is no such
    // choice, only the question of the best remaining information — which is
    // the newest reading, not the most trusted dead one.
    const readings = [
      reading('kids_room_tado_left', 'temperature', 21.5, 40 * MINUTE),
      reading('kids_room_tado_right', 'temperature', 23.1, 5 * MINUTE),
    ];

    assert.deepEqual(resolveSignal('kids_room', 'temperature', readings, NOW), {
      status: 'stale',
      sourceId: 'kids_room_tado_right',
      value: 23.1,
      measuredAt: NOW - 5 * MINUTE,
    });
  });

  it('picks the newest stale reading even when it is the higher-ranked one', () => {
    // The mirror of the case above, and it is not redundant: there, the newest
    // reading was also the last one in the list, so "newest" and "whichever we
    // looked at last" are the same answer. Only this direction can tell them apart.
    const readings = [
      reading('kids_room_tado_left', 'temperature', 21.5, 5 * MINUTE),
      reading('kids_room_tado_right', 'temperature', 23.1, 40 * MINUTE),
    ];

    assert.deepEqual(resolveSignal('kids_room', 'temperature', readings, NOW), {
      status: 'stale',
      sourceId: 'kids_room_tado_left',
      value: 21.5,
      measuredAt: NOW - 5 * MINUTE,
    });
  });

  it('resolves a room with exactly one source', () => {
    const readings = [reading('living_room_tado', 'temperature', 20.4, 30 * SECOND)];

    assert.deepEqual(resolveSignal('living_room', 'temperature', readings, NOW), {
      status: 'fresh',
      sourceId: 'living_room_tado',
      value: 20.4,
      measuredAt: NOW - 30 * SECOND,
    });
  });

  it('reports missing when no source in the room measures the kind', () => {
    // Living-room CO2 has no instrument until a SEN66 is installed. Missing is
    // the honest answer, and it is not the same as a sensor that went quiet.
    const readings = [reading('living_room_tado', 'temperature', 20.4, 30 * SECOND)];

    assert.deepEqual(resolveSignal('living_room', 'co2', readings, NOW), { status: 'missing' });
  });

  it('reports missing when the ranked sources have never reported', () => {
    assert.deepEqual(resolveSignal('kids_room', 'temperature', [], NOW), { status: 'missing' });
  });

  it('does not let one kind answer for another', () => {
    // The bedroom Netatmo reports CO2 and temperature. Asking for temperature
    // when only CO2 has arrived must not hand back a CO2 value in °C.
    const readings = [reading('bedroom_netatmo', 'co2', 812, 30 * SECOND)];

    assert.deepEqual(resolveSignal('bedroom', 'temperature', readings, NOW), { status: 'missing' });
  });

  it('ignores a source that is not ranked for the room', () => {
    const readings = [reading('bedroom_tado', 'temperature', 19.2, 30 * SECOND)];

    assert.deepEqual(resolveSignal('kids_room', 'temperature', readings, NOW), { status: 'missing' });
  });

  it('judges each source against its own freshness window', () => {
    // Eight minutes is dead for a Tado valve and healthy for a Netatmo. Had the
    // windows been global, this would have fallen through to a stale answer.
    const readings = [
      reading('bedroom_netatmo', 'temperature', 18.9, 8 * MINUTE),
      reading('bedroom_tado', 'temperature', 19.2, 8 * MINUTE),
    ];

    assert.deepEqual(resolveSignal('bedroom', 'temperature', readings, NOW), {
      status: 'fresh',
      sourceId: 'bedroom_netatmo',
      value: 18.9,
      measuredAt: NOW - 8 * MINUTE,
    });
  });

  it('takes the newest reading a source has produced', () => {
    const readings = [
      reading('living_room_tado', 'temperature', 20.4, 60 * SECOND),
      reading('living_room_tado', 'temperature', 20.9, 10 * SECOND),
    ];

    assert.deepEqual(resolveSignal('living_room', 'temperature', readings, NOW), {
      status: 'fresh',
      sourceId: 'living_room_tado',
      value: 20.9,
      measuredAt: NOW - 10 * SECOND,
    });
  });
});
