import { describe, it } from 'node:test';

import type { SensorId } from '../src/config.ts';
import type { MeasurementKind, Reading } from '../src/domain/measurement.ts';
import { resolveSignal } from '../src/domain/precedence.ts';
import { assertDeepEqual } from './support/deep-equal.ts';

const NOW = Temporal.Instant.from('2026-08-10T12:00:00Z');

function reading(
  sourceId: SensorId,
  kind: MeasurementKind,
  value: number,
  age: Temporal.DurationLike,
): Reading {
  return { sourceId, kind, value, measuredAt: NOW.subtract(age), receivedAt: NOW };
}

describe('precedence', () => {
  // The bedroom is the flat's one genuine two-instrument room: the Home Coach
  // leads, and the valve head on the radiator reads warm behind it. Every case
  // that needs a choice between live instruments is written there, and each age
  // is chosen against that source's OWN window — 15 minutes for the Netatmo,
  // 25 for the Tado — because that is the only thing that makes them differ.
  it('lets the highest-ranked fresh source win, and names it', () => {
    const readings = [
      reading('bedroom_netatmo', 'temperature', 21.4, { seconds: 20 }),
      reading('bedroom_tado', 'temperature', 22.9, { seconds: 20 }),
    ];

    assertDeepEqual(resolveSignal('bedroom', 'temperature', readings, NOW), {
      status: 'fresh',
      sourceId: 'bedroom_netatmo',
      // Exactly one instrument's reading, never a mean of the two. The valve
      // sits on the radiator and the Home Coach across the room; 22.15 would
      // describe neither of them.
      value: 21.4,
      measuredAt: NOW.subtract({ seconds: 20 }),
    });
  });

  it('ignores recency while a choice between live instruments exists', () => {
    // The lower-ranked valve reported one second ago and the higher-ranked
    // Home Coach a minute ago. Both are fresh, so trust decides, not recency.
    const readings = [
      reading('bedroom_netatmo', 'temperature', 21.4, { seconds: 60 }),
      reading('bedroom_tado', 'temperature', 22.9, { seconds: 1 }),
    ];

    assertDeepEqual(resolveSignal('bedroom', 'temperature', readings, NOW), {
      status: 'fresh',
      sourceId: 'bedroom_netatmo',
      value: 21.4,
      measuredAt: NOW.subtract({ seconds: 60 }),
    });
  });

  it('falls through to the next source when the first has gone stale', () => {
    // Sixteen minutes is past the Netatmo's window and nowhere near the Tado's.
    const readings = [
      reading('bedroom_netatmo', 'temperature', 21.4, { minutes: 16 }),
      reading('bedroom_tado', 'temperature', 22.9, { seconds: 20 }),
    ];

    assertDeepEqual(resolveSignal('bedroom', 'temperature', readings, NOW), {
      status: 'fresh',
      sourceId: 'bedroom_tado',
      value: 22.9,
      measuredAt: NOW.subtract({ seconds: 20 }),
    });
  });

  it('reports the most recently measured reading once nothing is fresh (Q3)', () => {
    // Precedence encodes trust, and trust is what matters while there is a
    // choice between live instruments. Once nothing is fresh there is no such
    // choice, only the question of the best remaining information — which is
    // the newest reading, not the most trusted dead one.
    const readings = [
      reading('bedroom_netatmo', 'temperature', 21.4, { minutes: 90 }),
      reading('bedroom_tado', 'temperature', 22.9, { minutes: 30 }),
    ];

    assertDeepEqual(resolveSignal('bedroom', 'temperature', readings, NOW), {
      status: 'stale',
      sourceId: 'bedroom_tado',
      value: 22.9,
      measuredAt: NOW.subtract({ minutes: 30 }),
    });
  });

  it('picks the newest stale reading even when it is the higher-ranked one', () => {
    // The mirror of the case above, and it is not redundant: there, the newest
    // reading was also the last one in the list, so "newest" and "whichever we
    // looked at last" are the same answer. Only this direction can tell them apart.
    const readings = [
      reading('bedroom_netatmo', 'temperature', 21.4, { minutes: 30 }),
      reading('bedroom_tado', 'temperature', 22.9, { minutes: 90 }),
    ];

    assertDeepEqual(resolveSignal('bedroom', 'temperature', readings, NOW), {
      status: 'stale',
      sourceId: 'bedroom_netatmo',
      value: 21.4,
      measuredAt: NOW.subtract({ minutes: 30 }),
    });
  });

  it('breaks a tie between stale sources on precedence, not on where they sat in the array', () => {
    // Two vendors' clocks rarely land on the same millisecond, so this tie is
    // rarer than it was when both readings came out of one Tado poll — but the
    // rule still cannot be "whichever we happened to look at last", or the
    // answer would depend on the order the store handed the readings over.
    // Trust is the only thing left to decide with, which is what the ranked
    // list is for. The lower-ranked source is listed first here so that array
    // order cannot be what produces the right answer.
    const readings = [
      reading('bedroom_tado', 'temperature', 22.9, { minutes: 90 }),
      reading('bedroom_netatmo', 'temperature', 21.4, { minutes: 90 }),
    ];

    assertDeepEqual(resolveSignal('bedroom', 'temperature', readings, NOW), {
      status: 'stale',
      sourceId: 'bedroom_netatmo',
      value: 21.4,
      measuredAt: NOW.subtract({ minutes: 90 }),
    });
  });

  it('consults a lower-ranked source when the leading one has never reported', () => {
    // The Home Coach leads for bedroom temperature. If it has said nothing at
    // all, a stale valve reading is still the best information in the flat, and
    // answering `missing` would throw away the one number there is.
    const readings = [reading('bedroom_tado', 'temperature', 19.2, { minutes: 40 })];

    assertDeepEqual(resolveSignal('bedroom', 'temperature', readings, NOW), {
      status: 'stale',
      sourceId: 'bedroom_tado',
      value: 19.2,
      measuredAt: NOW.subtract({ minutes: 40 }),
    });
  });

  it('resolves a room with exactly one source', () => {
    const readings = [reading('living_room_tado', 'temperature', 20.4, { seconds: 30 })];

    assertDeepEqual(resolveSignal('living_room', 'temperature', readings, NOW), {
      status: 'fresh',
      sourceId: 'living_room_tado',
      value: 20.4,
      measuredAt: NOW.subtract({ seconds: 30 }),
    });
  });

  it('reports missing when no source in the room measures the kind', () => {
    // Living-room CO2 has no instrument until a SEN66 is installed. Missing is
    // the honest answer, and it is not the same as a sensor that went quiet.
    const readings = [reading('living_room_tado', 'temperature', 20.4, { seconds: 30 })];

    assertDeepEqual(resolveSignal('living_room', 'co2', readings, NOW), { status: 'missing' });
  });

  it('reports missing when the ranked sources have never reported', () => {
    assertDeepEqual(resolveSignal('kids_room', 'temperature', [], NOW), { status: 'missing' });
  });

  it('does not let one kind answer for another', () => {
    // The bedroom Netatmo reports CO2 and temperature. Asking for temperature
    // when only CO2 has arrived must not hand back a CO2 value in °C.
    const readings = [reading('bedroom_netatmo', 'co2', 812, { seconds: 30 })];

    assertDeepEqual(resolveSignal('bedroom', 'temperature', readings, NOW), { status: 'missing' });
  });

  it('ignores a source that is not ranked for the room', () => {
    const readings = [reading('bedroom_tado', 'temperature', 19.2, { seconds: 30 })];

    assertDeepEqual(resolveSignal('kids_room', 'temperature', readings, NOW), { status: 'missing' });
  });

  it('judges each source against its own freshness window', () => {
    // Twenty minutes is dead for a Netatmo, which refreshes every 7-8 minutes,
    // and healthy for a Tado, which publishes on a 20-minute heartbeat. Both
    // readings are the same age, so only the per-source windows can separate
    // them: the leading Home Coach has aged out and the valve behind it has
    // not. Under one global window this would have been a stale answer.
    const readings = [
      reading('bedroom_netatmo', 'temperature', 18.9, { minutes: 20 }),
      reading('bedroom_tado', 'temperature', 19.2, { minutes: 20 }),
    ];

    assertDeepEqual(resolveSignal('bedroom', 'temperature', readings, NOW), {
      status: 'fresh',
      sourceId: 'bedroom_tado',
      value: 19.2,
      measuredAt: NOW.subtract({ minutes: 20 }),
    });
  });

  it('takes the newest reading a source has produced', () => {
    const readings = [
      reading('living_room_tado', 'temperature', 20.4, { seconds: 60 }),
      reading('living_room_tado', 'temperature', 20.9, { seconds: 10 }),
    ];

    assertDeepEqual(resolveSignal('living_room', 'temperature', readings, NOW), {
      status: 'fresh',
      sourceId: 'living_room_tado',
      value: 20.9,
      measuredAt: NOW.subtract({ seconds: 10 }),
    });
  });
});
