import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Reading } from '../src/domain/measurement.ts';
import { createCollector } from '../src/sources/collector.ts';
import type { SensorSource } from '../src/sources/source.ts';
import { openReadingStore } from '../src/store/readings.ts';
import type { ReadingStore } from '../src/store/readings.ts';

const NOON = Date.UTC(2026, 0, 15, 12, 0);
const MINUTE = 60_000;

function countingSource(name: string, intervalMs: number, value: number): {
  readonly source: SensorSource;
  polls: number;
} {
  const counter = {
    polls: 0,
    source: {
      name,
      pollIntervalMs: intervalMs,
      async poll(now: number): Promise<readonly Reading[]> {
        counter.polls += 1;
        return [{ sourceId: 'bedroom_netatmo', kind: 'co2', value, measuredAt: now, receivedAt: now }];
      },
    },
  };

  return counter;
}

function brokenSource(name: string): SensorSource {
  return {
    name,
    pollIntervalMs: MINUTE,
    async poll() {
      throw new Error('vendor returned 500');
    },
  };
}

interface Recorder {
  readonly lines: string[];
  log(line: string): void;
}

function recorder(): Recorder {
  const lines: string[] = [];
  return { lines, log: (line) => void lines.push(line) };
}

describe('the collector', () => {
  it('polls a due source and stores what it returns', async () => {
    const store = openReadingStore(':memory:');
    const netatmo = countingSource('netatmo', MINUTE, 840);
    const log = recorder();
    const collector = createCollector({ sources: [netatmo.source], store, log: log.log });

    await collector.tick(NOON);

    assert.equal(store.latestReading('bedroom_netatmo', 'co2')?.value, 840);
    assert.match(log.lines.join('\n'), /netatmo: 1 readings, 1 new/);

    store.close();
  });

  it('respects each source cadence rather than polling on every tick', async () => {
    const store = openReadingStore(':memory:');
    const slow = countingSource('netatmo', 5 * MINUTE, 840);
    const fast = countingSource('tado', MINUTE, 21);
    const collector = createCollector({
      sources: [slow.source, fast.source],
      store,
      log: recorder().log,
    });

    await collector.tick(NOON);
    await collector.tick(NOON + MINUTE);
    await collector.tick(NOON + 2 * MINUTE);

    assert.equal(slow.polls, 1);
    assert.equal(fast.polls, 3);

    store.close();
  });

  it('asks a source again once its interval has elapsed', async () => {
    const store = openReadingStore(':memory:');
    const slow = countingSource('netatmo', 5 * MINUTE, 840);
    const collector = createCollector({ sources: [slow.source], store, log: recorder().log });

    await collector.tick(NOON);
    await collector.tick(NOON + 5 * MINUTE);

    assert.equal(slow.polls, 2);

    store.close();
  });

  it('keeps polling the other sources when one throws', async () => {
    const store = openReadingStore(':memory:');
    const log = recorder();
    const collector = createCollector({
      sources: [brokenSource('tado'), countingSource('netatmo', MINUTE, 840).source],
      store,
      log: log.log,
    });

    await collector.tick(NOON);

    assert.equal(store.latestReading('bedroom_netatmo', 'co2')?.value, 840);
    assert.match(log.lines.join('\n'), /tado did not report: vendor returned 500/);

    store.close();
  });

  it('survives a store that cannot be written, and says which failure it was', async () => {
    const netatmo = countingSource('netatmo', MINUTE, 840);
    const log = recorder();
    const failing: ReadingStore = {
      insert() {
        throw new Error('disk full');
      },
      latestReading: () => undefined,
      readingsInRange: () => [],
      close: () => undefined,
    };
    const collector = createCollector({ sources: [netatmo.source], store: failing, log: log.log });

    await collector.tick(NOON);
    await collector.tick(NOON + MINUTE);

    // The tick survived — the second poll happened — and the log names the
    // store, not the vendor.
    assert.equal(netatmo.polls, 2);
    assert.match(log.lines.join('\n'), /could not store 1 readings from netatmo: disk full/);
  });

  it('shows a repeated reading being absorbed as "0 new"', async () => {
    const store = openReadingStore(':memory:');
    const log = recorder();
    const repeating: SensorSource = {
      name: 'netatmo',
      pollIntervalMs: MINUTE,
      // The same reading with the same measuredAt, as Netatmo hands back inside
      // its 7-8 minute refresh window.
      async poll() {
        return [{ sourceId: 'bedroom_netatmo', kind: 'co2', value: 840, measuredAt: NOON, receivedAt: NOON }];
      },
    };
    const collector = createCollector({ sources: [repeating], store, log: log.log });

    await collector.tick(NOON);
    await collector.tick(NOON + MINUTE);

    const lines = log.lines.join('\n');
    assert.match(lines, /1 readings, 1 new/);
    assert.match(lines, /1 readings, 0 new/);

    store.close();
  });
});
