import type { SensorId } from '../config.ts';

/**
 * What one room currently says about one measurement, and how much that is
 * worth. `stale` and `missing` are distinct on purpose: one instrument went
 * quiet, the other was never there. Neither is a current reading, but a
 * dashboard showing "—" and a dashboard showing "1100 ppm, 40 minutes ago"
 * are telling you different things.
 */
export type RoomSignal =
  | {
      readonly status: 'fresh';
      readonly sourceId: SensorId;
      readonly value: number;
      readonly measuredAt: Temporal.Instant;
    }
  | {
      readonly status: 'stale';
      readonly sourceId: SensorId;
      readonly value: number;
      readonly measuredAt: Temporal.Instant;
    }
  | { readonly status: 'missing' };
