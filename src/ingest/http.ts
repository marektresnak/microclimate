import { SENSOR_IDS, SENSORS } from '../config.ts';
import { MEASUREMENT_KINDS } from '../domain/measurement.ts';
import type { MeasurementKind, Reading } from '../domain/measurement.ts';
import type { ReadingStore } from '../store/readings.ts';

/**
 * Batch ingest for the push nodes: validation and storage for
 * `POST /api/readings`. The route itself lives in `http/server.ts`; this is
 * everything about a batch that is worth testing without a socket.
 *
 * A batch is a JSON array of readings, each with its own `measuredAt` — a
 * SEN66 reports nine measurements per cycle and must not make nine requests,
 * and a node that buffered through an outage replays its backlog with the
 * original timestamps intact.
 *
 * One invalid reading does not discard the batch (Q6, decided as the plan
 * recommended): the valid readings are stored and the rejects are reported
 * back, each with its index and the reason. A node cannot fix a bad reading
 * by resending it, so failing the whole batch would just make eight good
 * readings hostage to one bad one, forever.
 */

// Reject the future beyond ordinary clock skew: a node reporting from 2106
// would otherwise look eternally fresh and poison every decision downstream.
// The past is deliberately unbounded (F6) — a replayed backlog is exactly the
// data batching exists to carry, and INSERT OR IGNORE already makes replay
// idempotent at any age.
const FUTURE_SKEW_MS = 5 * 60_000;

// NDIR CO2 sensors self-calibrate by assuming they periodically see outdoor
// air (~420 ppm). A reading below what outdoor air can be means that
// assumption has failed and the whole curve has drifted. Logged, never
// rejected: a drifted instrument is still reporting real air, just with a
// shifted zero, and discarding it would hide the very evidence of the fault.
const CO2_CALIBRATION_FLOOR_PPM = 300;

export interface RejectedReading {
  readonly index: number;
  readonly reason: string;
}

export interface IngestOutcome {
  /** Rows that were genuinely new. */
  readonly stored: number;
  /** Valid readings the store had already seen — a replayed batch lands here. */
  readonly duplicates: number;
  readonly rejected: readonly RejectedReading[];
}

export function ingestBatch(
  body: unknown,
  store: ReadingStore,
  now: number,
  log: (line: string) => void,
): IngestOutcome | { error: string } {
  if (!Array.isArray(body)) {
    return { error: 'expected a JSON array of readings' };
  }
  const batch: readonly unknown[] = body;

  const accepted: Reading[] = [];
  const rejected: RejectedReading[] = [];

  for (const [index, candidate] of batch.entries()) {
    const verdict = toReading(candidate, now);
    if (typeof verdict === 'string') {
      rejected.push({ index, reason: verdict });
      continue;
    }

    if (verdict.kind === 'co2' && verdict.value < CO2_CALIBRATION_FLOOR_PPM) {
      log(
        `${verdict.sourceId} reports ${verdict.value} ppm CO2, below outdoor air — ` +
          'probable calibration drift, stored anyway',
      );
    }

    accepted.push(verdict);
  }

  // One transaction for the whole batch; the ignore keeps the FIRST
  // received_at, which is when the reading genuinely first arrived.
  const stored = store.insert(accepted);

  return { stored, duplicates: accepted.length - stored, rejected };
}

/** The reading, or the reason the candidate is not one. Every check runs
 * before SQLite sees the value — the STRICT table throwing would fail the
 * whole batch, and its error would name a column, not a reading. */
function toReading(candidate: unknown, now: number): Reading | string {
  if (candidate === null || typeof candidate !== 'object') {
    return 'not an object';
  }

  if (!('sourceId' in candidate) || typeof candidate.sourceId !== 'string') {
    return 'sourceId is missing';
  }
  const rawSourceId = candidate.sourceId;
  const sourceId = SENSOR_IDS.find((known) => known === rawSourceId);
  if (sourceId === undefined) {
    return `unknown source ${rawSourceId}`;
  }

  if (!('kind' in candidate) || typeof candidate.kind !== 'string') {
    return 'kind is missing';
  }
  const rawKind = candidate.kind;
  const kind = MEASUREMENT_KINDS.find((known) => known === rawKind);
  if (kind === undefined) {
    return `${rawKind} is not a measurement kind`;
  }
  // A valid kind the instrument does not report is a mislabelled reading —
  // most likely a wrong sourceId in node firmware — and storing it would file
  // one instrument's data under another's name, permanently.
  //
  // Widened from the config's literal tuple so `includes` can be asked about
  // any kind at all, which is the question being asked.
  const declaredKinds: readonly MeasurementKind[] = SENSORS[sourceId].kinds;
  if (!declaredKinds.includes(kind)) {
    return `${sourceId} does not report ${kind}`;
  }

  if (!('value' in candidate) || typeof candidate.value !== 'number' || !Number.isFinite(candidate.value)) {
    return 'value must be a finite number';
  }

  // Integer epoch milliseconds, exactly what the column holds. Rejecting a
  // float here beats the STRICT table refusing it with a column error later.
  if (!('measuredAt' in candidate) || typeof candidate.measuredAt !== 'number' || !Number.isInteger(candidate.measuredAt)) {
    return 'measuredAt must be integer epoch milliseconds';
  }
  if (candidate.measuredAt > now + FUTURE_SKEW_MS) {
    return `measuredAt is ${candidate.measuredAt - now} ms in the future`;
  }

  return {
    sourceId,
    kind,
    value: candidate.value,
    measuredAt: candidate.measuredAt,
    receivedAt: now,
  };
}
