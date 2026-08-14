import { createServer } from 'node:http';
import type { Server } from 'node:http';

import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import type { VentilationUnit } from '../actuator/unit.ts';
import { PRECEDENCE, ROOM_IDS, SENSOR_IDS, SENSORS } from '../config.ts';
import type { RoomId, SensorId } from '../config.ts';
import { messageOf } from '../domain/errors.ts';
import { ingestBatch } from '../ingest/http.ts';
import { assertCommandedLevel } from '../domain/level.ts';
import type { CommandedLevel } from '../domain/level.ts';
import { MEASUREMENT_KINDS } from '../domain/measurement.ts';
import type { MeasurementKind, Reading } from '../domain/measurement.ts';
import { resolveSignal } from '../domain/precedence.ts';
import type { RoomSignal } from '../domain/signal.ts';
import { parseInstant, toIsoUtc } from '../domain/time.ts';
import { createNetatmoAuthRoutes } from './netatmo-auth.ts';
import { createTadoAuthRoutes } from './tado-auth.ts';
import type { NetatmoSettings } from '../sources/netatmo.ts';
import type { FetchLike } from '../sources/source.ts';
import type { TadoSettings } from '../sources/tado.ts';
import type { LogLine, LogStore } from '../store/logs.ts';
import type { ReadingStore } from '../store/readings.ts';

/**
 * The read API and the two open writes (fan level, ingest) — uniform JSON,
 * end to end. The vendor onboarding routes, the API's human-facing half, live
 * in netatmo-auth.ts and tado-auth.ts and are mounted whole below. Routes are declared on Hono
 * and served through `getRequestListener`, so this still returns an ordinary
 * `node:http` Server and nothing that wires or tests it knows a framework is
 * underneath.
 *
 * Hono and its node adapter are the project's only runtime dependencies,
 * admitted for exactly this layer: route dispatch, body reading and response
 * plumbing are boilerplate that kept failing the review contract's own
 * readability test, and they are also the code a framework can absorb without
 * absorbing any decision. Everything that decides — narrowing, precedence,
 * the OAuth state — is the same code it was without it.
 *
 * No endpoint carries auth — single home, trusted LAN, as designed. That
 * includes the two writes, which reverses an earlier decision and a review
 * finding; the acceptance and its bounds are recorded in CLAUDE.md ("Both
 * write endpoints are open on the LAN"). What any caller can do is bounded by
 * construction: 20-80, never off, never above the grille ceiling.
 *
 * Time arrives through `clock`, so every test runs against a fixed instant —
 * and the Tado onboarding route needs it for a second reason: a device code has
 * a deadline. `fetchImpl` exists for the onboarding modules' token exchanges and
 * passes straight through to them — a canned vendor in the tests, `fetch` in main.
 */

const DAY = Temporal.Duration.from({ hours: 24 });
// A command body is one small JSON object; refusing early beats buffering
// whatever a confused client pours in. Ingest is the exception: a node
// replaying a buffered backlog sends real batches, and a quarter megabyte is
// roughly three thousand readings.
const COMMAND_BODY_BYTES = 16 * 1024;
const INGEST_BODY_BYTES = 256 * 1024;

export interface ApiServerDependencies {
  readonly store: ReadingStore;
  readonly logs: LogStore;
  readonly unit: VentilationUnit;
  /** The identity the polling adapter also holds — the same object, so the
   * onboarding routes save the token where the poller reads it. Unset
   * disables the two /auth/netatmo routes, with an explanation. */
  readonly netatmoAuth: NetatmoSettings | undefined;
  /** The same, for Tado — one identity per vendor, each shared with its poller.
   * Unset disables /auth/tado, with an explanation. */
  readonly tadoAuth: TadoSettings | undefined;
  readonly clock: () => Temporal.Instant;
  readonly log: (line: string) => void;
}

/**
 * Every instant this API writes is an ISO 8601 string in UTC, and every one it
 * reads is an ISO 8601 string with an explicit zone. Epoch milliseconds are the
 * store's business — they are there so `measured_at` has one representation per
 * instant inside a uniqueness constraint, which is an argument about a column
 * and not about a wire format. `domain/time.ts` is the whole conversion.
 */

/** What /api/state says about one (room, kind). */
type SignalBody =
  | { readonly status: 'missing' }
  | {
      readonly status: 'fresh' | 'stale';
      readonly value: number;
      readonly sourceId: SensorId;
      readonly measuredAt: string;
    };

/** What both history endpoints say about one reading. */
interface ReadingBody {
  readonly sourceId: SensorId;
  readonly kind: MeasurementKind;
  readonly value: number;
  readonly measuredAt: string;
  readonly receivedAt: string;
}

export function createApiServer(
  dependencies: ApiServerDependencies,
  fetchImpl: FetchLike = fetch,
): Server {
  const app = new Hono();

  app.onError((error, c) => {
    dependencies.log(`${c.req.method} ${c.req.path} failed: ${messageOf(error)}`);
    return c.json({ error: messageOf(error) }, 500);
  });

  app.notFound((c) => c.json({ error: `no route for ${c.req.path}` }, 404));

  app.get('/health', (c) => c.json({ ok: true }));

  /**
   * One value per (room, kind), resolved through `resolveSignal` — the one
   * rule for what a room currently says. Anything added later that reads
   * room-level values goes through the same function, so two consumers can
   * never disagree.
   */
  app.get('/api/state', (c) => {
    const now = dependencies.clock();
    const rooms: Partial<Record<RoomId, Partial<Record<MeasurementKind, SignalBody>>>> = {};

    for (const room of ROOM_IDS) {
      const kinds: Partial<Record<MeasurementKind, SignalBody>> = {};

      for (const kind of MEASUREMENT_KINDS) {
        const ranked = PRECEDENCE[room][kind];
        if (ranked === undefined) continue;

        const latest = latestReadingsFrom(ranked, kind);
        kinds[kind] = describeSignal(resolveSignal(room, kind, latest, now));
      }

      rooms[room] = kinds;
    }

    return c.json({ rooms });
  });

  // The whole topology, inactive entries included — a client interpreting
  // historical readings needs the vocabulary of the past, not just the
  // instruments currently consulted.
  app.get('/api/sensors', (c) =>
    c.json({ rooms: ROOM_IDS, sensors: SENSORS, precedence: PRECEDENCE }),
  );

  app.get('/api/rooms/:room/readings', (c) => {
    const room = ROOM_IDS.find((candidate) => candidate === c.req.param('room'));
    if (room === undefined) {
      return c.json({ error: `no room called ${c.req.param('room')}` }, 404);
    }

    // Every sensor config places in the room, inactive ones included: history
    // outlives decommissioning, and this endpoint is where it stays readable.
    const sensorIds = SENSOR_IDS.filter((id) => SENSORS[id].room === room);
    const result = historyBody(sensorIds, c.req.query('from'), c.req.query('to'), c.req.query('kind'), dependencies.clock());
    if ('error' in result) return c.json(result, 400);

    return c.json({ room, ...result });
  });

  app.get('/api/sensors/:id/readings', (c) => {
    const sensorId = SENSOR_IDS.find((candidate) => candidate === c.req.param('id'));
    if (sensorId === undefined) {
      return c.json({ error: `no sensor called ${c.req.param('id')}` }, 404);
    }

    const result = historyBody([sensorId], c.req.query('from'), c.req.query('to'), c.req.query('kind'), dependencies.clock());
    if ('error' in result) return c.json(result, 400);

    return c.json({ sensorId, ...result });
  });

  // The same lines the process writes to stdout, queryable by time range —
  // so "what happened last night" is a dashboard question, not a shell one.
  // Same grammar as every other range: ISO 8601 with a zone, default last 24 h.
  app.get('/api/logs', (c) => {
    const range = rangeOf(c.req.query('from'), c.req.query('to'), dependencies.clock());
    if ('error' in range) return c.json(range, 400);

    return c.json({
      from: toIsoUtc(range.from),
      to: toIsoUtc(range.to),
      lines: dependencies.logs.linesInRange(range.from, range.to).map(describeLogLine),
    });
  });

  app.get('/api/unit/level', async (c) => {
    try {
      return c.json({ level: await dependencies.unit.read() });
    } catch (error) {
      // 502, not 500: this service is fine, the thing behind it is not.
      return c.json({ error: `could not read the unit: ${messageOf(error)}` }, 502);
    }
  });

  app.post('/api/unit/level', bodyLimit({ maxSize: COMMAND_BODY_BYTES }), async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'the body is not JSON' }, 400);
    }

    if (body === null || typeof body !== 'object' || !('level' in body) || typeof body.level !== 'number') {
      return c.json({ error: 'expected {"level": <20-80 in steps of 10>}' }, 400);
    }

    // The runtime half of CommandedLevel, at the boundary where a number
    // enters from outside. 90 and 100 die here — the intake grille cannot
    // pass the air, and type stripping checks nothing.
    let level: CommandedLevel;
    try {
      level = assertCommandedLevel(body.level);
    } catch (error) {
      return c.json({ error: messageOf(error) }, 400);
    }

    try {
      await dependencies.unit.set(level);
    } catch (error) {
      return c.json({ error: `could not command ${level}%: ${messageOf(error)}` }, 502);
    }

    dependencies.log(`${level}% set over the API`);
    return c.json({ level });
  });

  // Open like every write on this LAN, and this one carries the sharper risk
  // of the two: a poisoned reading outlives its request, and the day an
  // automation drives the fan from CO2, invented bedroom readings steer it.
  // Accepted knowingly — the decision and its bounds are in CLAUDE.md beside
  // the unit endpoint's.
  //
  // 200 whenever the batch was processed, verdicts inside: a rejected reading
  // cannot be fixed by resending it, so a status a simple node reads as
  // "retry" would have it replaying poison forever.
  app.post('/api/readings', bodyLimit({ maxSize: INGEST_BODY_BYTES }), async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'the body is not JSON' }, 400);
    }

    const outcome = ingestBatch(body, dependencies.store, dependencies.clock(), dependencies.log);
    if ('error' in outcome) return c.json(outcome, 400);

    dependencies.log(
      `ingest: ${outcome.stored} new, ${outcome.duplicates} duplicate, ${outcome.rejected.length} rejected`,
    );
    return c.json(outcome);
  });

  // Mounted at '/' so every full path stays declared — and greppable — where
  // the routes live. Errors thrown inside still land in app.onError above.
  // One onboarding module per vendor, because the two flows have nothing in
  // common but their purpose: Netatmo redirects and is called back, Tado hands
  // out a code and waits to be asked.
  app.route('/', createNetatmoAuthRoutes(dependencies.netatmoAuth, dependencies.log, fetchImpl));
  app.route(
    '/',
    createTadoAuthRoutes(dependencies.tadoAuth, dependencies.log, dependencies.clock, fetchImpl),
  );

  function latestReadingsFrom(ranked: readonly SensorId[], kind: MeasurementKind): Reading[] {
    const readings: Reading[] = [];

    for (const sourceId of ranked) {
      const latest = dependencies.store.latestReading(sourceId, kind);
      if (latest !== undefined) readings.push(latest);
    }

    return readings;
  }

  function historyBody(
    sensorIds: readonly SensorId[],
    fromRaw: string | undefined,
    toRaw: string | undefined,
    kindRaw: string | undefined,
    now: Temporal.Instant,
  ): { from: string; to: string; readings: ReadingBody[] } | { error: string } {
    const range = rangeOf(fromRaw, toRaw, now);
    if ('error' in range) return range;

    const readings: Reading[] = [];
    for (const sensorId of sensorIds) {
      for (const kind of SENSORS[sensorId].kinds) {
        // No filter means every kind. An unknown ?kind= matches no declared
        // kind and yields an empty history — the same honest answer as a kind
        // nothing has reported yet.
        if (kindRaw !== undefined && kind !== kindRaw) continue;
        readings.push(...dependencies.store.readingsInRange(sensorId, kind, range.from, range.to));
      }
    }
    readings.sort((first, second) => Temporal.Instant.compare(first.measuredAt, second.measuredAt));

    // Sorted as numbers, then written as text. The two orders agree for UTC
    // ISO strings anyway, but sorting the instants is the honest version.
    return {
      from: toIsoUtc(range.from),
      to: toIsoUtc(range.to),
      readings: readings.map(describeReading),
    };
  }

  return createServer(getRequestListener(app.fetch));
}

// ── helpers with no state ────────────────────────────────────────────────────

// Named once because both bounds answer with it, and because it is the only
// place the accepted grammar is spelled out for a human.
const BAD_RANGE = 'from and to must be ISO 8601 timestamps with a zone, e.g. 2026-08-12T09:36:00Z';

function rangeOf(
  fromRaw: string | undefined,
  toRaw: string | undefined,
  now: Temporal.Instant,
): { from: Temporal.Instant; to: Temporal.Instant } | { error: string } {
  // Refusing an unparseable bound beats an empty result, which a client would
  // read as "no data". An inverted range needs no such guard — the store
  // honestly returns nothing for it.
  const to = toRaw === undefined ? now : parseInstant(toRaw);
  if (to === undefined) return { error: BAD_RANGE };

  const from = fromRaw === undefined ? to.subtract(DAY) : parseInstant(fromRaw);
  if (from === undefined) return { error: BAD_RANGE };

  return { from, to };
}

/**
 * No age travels with the value. `status` already carries the freshness
 * judgement, made here against that source's own window and this server's
 * clock; an age invites the client to make a second judgement against a clock
 * that may not agree, and two answers to one question is one too many.
 * `measuredAt` is there for anyone who wants to plot it.
 */
function describeSignal(signal: RoomSignal): SignalBody {
  if (signal.status === 'missing') return { status: 'missing' };

  return {
    status: signal.status,
    value: signal.value,
    sourceId: signal.sourceId,
    measuredAt: toIsoUtc(signal.measuredAt),
  };
}

function describeReading(reading: Reading): ReadingBody {
  return {
    sourceId: reading.sourceId,
    kind: reading.kind,
    value: reading.value,
    // Never conflated, and both readable: the instrument's clock says when it
    // measured, ours says when we learned about it.
    measuredAt: toIsoUtc(reading.measuredAt),
    receivedAt: toIsoUtc(reading.receivedAt),
  };
}

function describeLogLine(line: LogLine): { at: string; message: string } {
  return { at: toIsoUtc(line.at), message: line.message };
}
