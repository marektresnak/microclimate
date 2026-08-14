import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SENSORS } from '../src/config.ts';
import { createSyntheticNetatmo, createSyntheticTado } from '../src/sources/synthetic.ts';
import { openReadingStore } from '../src/store/readings.ts';
import { assertDeepEqual } from './support/deep-equal.ts';

const NOW = Temporal.Instant.from('2026-01-15T21:00:00Z'); // 22:00 in Prague

describe('the synthetic sources', () => {
  it('report exactly the kinds their sensors are configured to report', async () => {
    const netatmo = await createSyntheticNetatmo().poll(NOW);
    const tado = await createSyntheticTado().poll(NOW);

    for (const reading of [...netatmo, ...tado]) {
      const sensor = SENSORS[reading.sourceId];
      assert.ok(
        sensor.kinds.some((kind) => kind === reading.kind),
        `${reading.sourceId} reported ${reading.kind}, which it does not measure`,
      );
    }
  });

  it('gives the bedroom valve and the Home Coach different temperatures', async () => {
    // Not a detail: the whole never-average rule exists because two instruments
    // in one room disagree, and a demo where they agree hides the thing worth
    // showing. The bedroom is where that pair lives — the valve head on the
    // radiator against the Home Coach across the room.
    const netatmo = await createSyntheticNetatmo().poll(NOW);
    const tado = await createSyntheticTado().poll(NOW);

    const coach = netatmo.find((reading) => reading.kind === 'temperature');
    const valve = tado.find(
      (reading) => reading.kind === 'temperature' && reading.sourceId === 'bedroom_tado',
    );

    assert.notEqual(coach?.value, valve?.value);
  });

  it('repeats itself inside a Netatmo refresh, and the store absorbs the repeat', async () => {
    // Netatmo only refreshes every 7-8 minutes on their side, so polling faster
    // gains nothing — and the uniqueness constraint means it also costs nothing.
    const source = createSyntheticNetatmo();
    const store = openReadingStore(':memory:');

    const first = await source.poll(NOW);
    const twoMinutesLater = await source.poll(NOW.add({ minutes: 2 }));

    // Through the projecting helper: two different instants deepEqual as
    // equal, so comparing them bare would pass even if quantisation broke.
    assertDeepEqual(
      first.map((reading) => reading.measuredAt),
      twoMinutesLater.map((reading) => reading.measuredAt),
    );
    assert.equal(store.insert(first), 3);
    assert.equal(store.insert(twoMinutesLater), 0);

    store.close();
  });

  it('separates when a reading was measured from when we heard about it', async () => {
    const readings = await createSyntheticNetatmo().poll(NOW.add({ minutes: 3 }));

    for (const reading of readings) {
      assert.ok(
        Temporal.Instant.compare(reading.measuredAt, reading.receivedAt) < 0,
        'Netatmo reports minutes after it measures',
      );
    }
  });

  it('fills the bedroom with CO2 overnight and clears it by lunchtime', async () => {
    const night = await createSyntheticNetatmo().poll(Temporal.Instant.from('2026-01-15T03:00:00Z')); // 04:00 local
    const midday = await createSyntheticNetatmo().poll(Temporal.Instant.from('2026-01-15T12:00:00Z')); // 13:00 local

    const nightCo2 = night.find((reading) => reading.kind === 'co2')?.value ?? 0;
    const middayCo2 = midday.find((reading) => reading.kind === 'co2')?.value ?? 0;

    assert.ok(nightCo2 > 1_000, `overnight CO2 was only ${nightCo2} ppm`);
    assert.ok(middayCo2 < 700, `midday CO2 was ${middayCo2} ppm`);
  });
});
