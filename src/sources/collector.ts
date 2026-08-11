import { messageOf } from '../domain/errors.ts';
import type { Reading } from '../domain/measurement.ts';
import type { ReadingStore } from '../store/readings.ts';
import type { SensorSource } from './source.ts';

/**
 * Polls every source on its own cadence and stores whatever arrives. Collection
 * and nothing else — no decision, no actuation.
 *
 * This is the control loop's first step, extracted. The loop is parked (see
 * CLAUDE.md): while it is, something still has to gather readings, because
 * collection is the platform and the controller was only its first consumer.
 * The loop polls for itself when it runs, so the two are alternatives wired in
 * `main.ts` — never both, or every source would be asked twice.
 */
export interface CollectorDependencies {
  readonly sources: readonly SensorSource[];
  readonly store: ReadingStore;
  readonly log: (line: string) => void;
}

export interface Collector {
  tick(now: number): Promise<void>;
}

export function createCollector(dependencies: CollectorDependencies): Collector {
  // When each source was last polled, so a five-minute source is not asked on
  // every thirty-second tick.
  const lastPolledAt = new Map<string, number>();

  return {
    async tick(now) {
      for (const source of dependencies.sources) {
        const polledAt = lastPolledAt.get(source.name);
        if (polledAt !== undefined && now - polledAt < source.pollIntervalMs) continue;
        lastPolledAt.set(source.name, now);

        // Per source: one vendor being unreachable must not stop the others
        // being read. The poll and the store are caught separately because they
        // fail for unrelated reasons, and an operator chases the one the log
        // names — a full disk reported as "the Netatmo did not report" sends
        // them to the vendor's status page at 3am.
        let readings: readonly Reading[];
        try {
          readings = await source.poll(now);
        } catch (error) {
          dependencies.log(`${source.name} did not report: ${messageOf(error)}`);
          continue;
        }

        try {
          const inserted = dependencies.store.insert(readings);
          // "3 readings, 0 new" is Netatmo repeating itself inside its 7-8
          // minute refresh and the uniqueness constraint absorbing it — worth
          // being able to watch, not worth hiding.
          dependencies.log(`${source.name}: ${readings.length} readings, ${inserted} new`);
        } catch (error) {
          dependencies.log(
            `could not store ${readings.length} readings from ${source.name}: ${messageOf(error)}`,
          );
        }
      }
    },
  };
}
