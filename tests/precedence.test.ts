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
  it('lets the highest-ranked fresh source win, and names it', () => {
    const readings = [
      reading('kids_room_tado_left', 'temperature', 21.5, { seconds: 20 }),
      reading('kids_room_tado_right', 'temperature', 23.1, { seconds: 20 }),
    ];

    assertDeepEqual(resolveSignal('kids_room', 'temperature', readings, NOW), {
      status: 'fresh',
      sourceId: 'kids_room_tado_left',
      // Exactly one instrument's reading, never a mean of the two. The valves
      // sit next to different radiators; an average describes neither.
      value: 21.5,
      measuredAt: NOW.subtract({ seconds: 20 }),
    });
  });

  it('ignores recency while a choice between live instruments exists', () => {
    // The lower-ranked valve reported one second ago and the higher-ranked one
    // a minute ago. Both are fresh, so trust decides, not recency.
    const readings = [
      reading('kids_room_tado_left', 'temperature', 21.5, { seconds: 60 }),
      reading('kids_room_tado_right', 'temperature', 23.1, { seconds: 1 }),
    ];

    assertDeepEqual(resolveSignal('kids_room', 'temperature', readings, NOW), {
      status: 'fresh',
      sourceId: 'kids_room_tado_left',
      value: 21.5,
      measuredAt: NOW.subtract({ seconds: 60 }),
    });
  });

  it('falls through to the next source when the first has gone stale', () => {
    const readings = [
      reading('kids_room_tado_left', 'temperature', 21.5, { minutes: 10 }),
      reading('kids_room_tado_right', 'temperature', 23.1, { seconds: 20 }),
    ];

    assertDeepEqual(resolveSignal('kids_room', 'temperature', readings, NOW), {
      status: 'fresh',
      sourceId: 'kids_room_tado_right',
      value: 23.1,
      measuredAt: NOW.subtract({ seconds: 20 }),
    });
  });

  it('reports the most recently measured reading once nothing is fresh (Q3)', () => {
    // Precedence encodes trust, and trust is what matters while there is a
    // choice between live instruments. Once nothing is fresh there is no such
    // choice, only the question of the best remaining information — which is
    // the newest reading, not the most trusted dead one.
    const readings = [
      reading('kids_room_tado_left', 'temperature', 21.5, { minutes: 40 }),
      reading('kids_room_tado_right', 'temperature', 23.1, { minutes: 5 }),
    ];

    assertDeepEqual(resolveSignal('kids_room', 'temperature', readings, NOW), {
      status: 'stale',
      sourceId: 'kids_room_tado_right',
      value: 23.1,
      measuredAt: NOW.subtract({ minutes: 5 }),
    });
  });

  it('picks the newest stale reading even when it is the higher-ranked one', () => {
    // The mirror of the case above, and it is not redundant: there, the newest
    // reading was also the last one in the list, so "newest" and "whichever we
    // looked at last" are the same answer. Only this direction can tell them apart.
    const readings = [
      reading('kids_room_tado_left', 'temperature', 21.5, { minutes: 5 }),
      reading('kids_room_tado_right', 'temperature', 23.1, { minutes: 40 }),
    ];

    assertDeepEqual(resolveSignal('kids_room', 'temperature', readings, NOW), {
      status: 'stale',
      sourceId: 'kids_room_tado_left',
      value: 21.5,
      measuredAt: NOW.subtract({ minutes: 5 }),
    });
  });

  it('breaks a tie between stale sources on precedence, not on where they sat in the array', () => {
    // Not a hypothetical tie: the Tado poll quantises its timestamp, so both
    // valves carry the identical measuredAt on every single cycle. When the
    // vendor goes quiet they go stale together, still tied, and trust is the
    // only thing left to decide with — which is what the ranked list is for.
    // The lower-ranked valve is listed first here so that array order cannot be
    // what produces the right answer.
    const readings = [
      reading('kids_room_tado_right', 'temperature', 23.1, { minutes: 40 }),
      reading('kids_room_tado_left', 'temperature', 21.5, { minutes: 40 }),
    ];

    assertDeepEqual(resolveSignal('kids_room', 'temperature', readings, NOW), {
      status: 'stale',
      sourceId: 'kids_room_tado_left',
      value: 21.5,
      measuredAt: NOW.subtract({ minutes: 40 }),
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
    // Eight minutes is dead for a Tado valve and healthy for a Netatmo. Had the
    // windows been global, this would have fallen through to a stale answer.
    const readings = [
      reading('bedroom_netatmo', 'temperature', 18.9, { minutes: 8 }),
      reading('bedroom_tado', 'temperature', 19.2, { minutes: 8 }),
    ];

    assertDeepEqual(resolveSignal('bedroom', 'temperature', readings, NOW), {
      status: 'fresh',
      sourceId: 'bedroom_netatmo',
      value: 18.9,
      measuredAt: NOW.subtract({ minutes: 8 }),
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
