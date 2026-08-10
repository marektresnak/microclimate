import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SENSORS } from '../src/config.ts';
import { createSyntheticNetatmo, createSyntheticTado } from '../src/sources/synthetic.ts';
import { openReadingStore } from '../src/store/readings.ts';

const NOW = Date.UTC(2026, 0, 15, 21, 0, 0); // 22:00 in Prague

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

  it('gives the two kids-room valves different temperatures', async () => {
    // Not a detail: the whole never-average rule exists because these two
    // disagree, and a demo where they agree hides the thing worth showing.
    const readings = await createSyntheticTado().poll(NOW);
    const temperatures = readings.filter((reading) => reading.kind === 'temperature');

    const left = temperatures.find((reading) => reading.sourceId === 'kids_room_tado_left');
    const right = temperatures.find((reading) => reading.sourceId === 'kids_room_tado_right');

    assert.notEqual(left?.value, right?.value);
  });

  it('repeats itself inside a Netatmo refresh, and the store absorbs the repeat', async () => {
    // Netatmo only refreshes every 7-8 minutes on their side, so polling faster
    // gains nothing — and the uniqueness constraint means it also costs nothing.
    const source = createSyntheticNetatmo();
    const store = openReadingStore(':memory:');

    const first = await source.poll(NOW);
    const twoMinutesLater = await source.poll(NOW + 2 * 60_000);

    assert.deepEqual(
      first.map((reading) => reading.measuredAt),
      twoMinutesLater.map((reading) => reading.measuredAt),
    );
    assert.equal(store.insert(first), 3);
    assert.equal(store.insert(twoMinutesLater), 0);

    store.close();
  });

  it('separates when a reading was measured from when we heard about it', async () => {
    const readings = await createSyntheticNetatmo().poll(NOW + 3 * 60_000);

    for (const reading of readings) {
      assert.ok(reading.measuredAt < reading.receivedAt, 'Netatmo reports minutes after it measures');
    }
  });

  it('drives the bedroom above the sleep threshold overnight and clears it by lunchtime', async () => {
    const night = await createSyntheticNetatmo().poll(Date.UTC(2026, 0, 15, 3, 0)); // 04:00 local
    const midday = await createSyntheticNetatmo().poll(Date.UTC(2026, 0, 15, 12, 0)); // 13:00 local

    const nightCo2 = night.find((reading) => reading.kind === 'co2')?.value ?? 0;
    const middayCo2 = midday.find((reading) => reading.kind === 'co2')?.value ?? 0;

    assert.ok(nightCo2 > 1_000, `overnight CO2 was only ${nightCo2} ppm`);
    assert.ok(middayCo2 < 700, `midday CO2 was ${middayCo2} ppm`);
  });
});
