import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';

import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { html } from 'hono/html';

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
import { NETATMO_TOKEN_URL } from '../sources/netatmo.ts';
import type { FetchLike } from '../sources/netatmo.ts';
import { saveRefreshToken } from '../sources/netatmo-token.ts';
import type { LogLine, LogStore } from '../store/logs.ts';
import type { ReadingStore } from '../store/readings.ts';

/**
 * The read API, the two open writes (fan level, ingest), and the Netatmo
 * onboarding pair. Routes are declared on Hono and served through
 * `getRequestListener`, so this still returns an ordinary `node:http` Server
 * and nothing that wires or tests it knows a framework is underneath.
 *
 * Hono and its node adapter are the project's only runtime dependencies,
 * admitted for exactly this file: route dispatch, body reading and response
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
 * Time arrives through `clock` and the vendor through `fetchImpl`, so every
 * test runs against a fixed instant and a canned Netatmo.
 */

const AUTHORIZE_URL = 'https://api.netatmo.com/oauth2/authorize';
// The one scope gethomecoachsdata needs.
const HOME_COACH_SCOPE = 'read_homecoach';
const EXCHANGE_TIMEOUT = Temporal.Duration.from({ seconds: 10 });
const DAY = Temporal.Duration.from({ hours: 24 });
// A command body is one small JSON object; refusing early beats buffering
// whatever a confused client pours in. Ingest is the exception: a node
// replaying a buffered backlog sends real batches, and a quarter megabyte is
// roughly three thousand readings.
const COMMAND_BODY_BYTES = 16 * 1024;
const INGEST_BODY_BYTES = 256 * 1024;

export interface NetatmoAuthOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Must match the Netatmo app registration exactly, or the exchange fails. */
  readonly redirectUri: string;
  readonly tokenPath: string;
}

export interface ApiServerDependencies {
  readonly store: ReadingStore;
  readonly logs: LogStore;
  readonly unit: VentilationUnit;
  /** Unset disables the two /auth/netatmo routes, with an explanation. */
  readonly netatmoAuth: NetatmoAuthOptions | undefined;
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
  // The one live OAuth state, single-use. Only the most recent flow counts, so
  // opening the auth page twice invalidates the first tab — acceptable for a
  // single-operator system, and it keeps this a value instead of a table.
  let pendingState: string | undefined;

  const app = new Hono();

  app.onError((error, c) => {
    dependencies.log(`${c.req.method} ${c.req.path} failed: ${messageOf(error)}`);
    return c.json({ error: messageOf(error) }, 500);
  });

  app.notFound((c) => c.json({ error: `no route for ${c.req.path}` }, 404));

  app.get('/health', (c) => c.json({ ok: true }));

  /**
   * One value per (room, kind), resolved by the same `resolveSignal` the
   * controller uses — one implementation, two consumers, so the dashboard and
   * the control decision cannot disagree about what a room currently says.
   * The control block itself is parked with the loop; see CLAUDE.md.
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
  // of the two: a poisoned reading outlives its request, and once the loop is
  // rewired, invented bedroom CO2 steers the fan. Accepted knowingly — the
  // decision and its bounds are in CLAUDE.md beside the unit endpoint's.
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

  app.get('/auth/netatmo', (c) => {
    const auth = dependencies.netatmoAuth;
    if (auth === undefined) {
      return c.json(
        { error: 'set NETATMO_CLIENT_ID and NETATMO_CLIENT_SECRET to enable Netatmo onboarding' },
        503,
      );
    }

    const state = randomUUID();
    pendingState = state;

    // No client_secret in this URL, deliberately: it travels through the
    // user's browser and history, and the authorisation step does not need it.
    // (Netatmo's own PHP client does send it there. We do not copy that.)
    const authorize = new URL(AUTHORIZE_URL);
    authorize.searchParams.set('client_id', auth.clientId);
    authorize.searchParams.set('redirect_uri', auth.redirectUri);
    authorize.searchParams.set('scope', HOME_COACH_SCOPE);
    authorize.searchParams.set('state', state);
    authorize.searchParams.set('response_type', 'code');

    return c.redirect(authorize.toString());
  });

  app.get('/auth/netatmo/callback', async (c) => {
    const auth = dependencies.netatmoAuth;
    if (auth === undefined) {
      return c.json(
        { error: 'set NETATMO_CLIENT_ID and NETATMO_CLIENT_SECRET to enable Netatmo onboarding' },
        503,
      );
    }

    const refusal = c.req.query('error');
    if (refusal !== undefined) {
      return c.html(
        page('Netatmo said no', `Netatmo refused the authorisation: ${refusal}. Start again at /auth/netatmo.`),
        400,
      );
    }

    // Single-use, consumed before anything else can go wrong with it.
    const presented = c.req.query('state');
    const pending = pendingState;
    pendingState = undefined;
    if (pending === undefined || presented !== pending) {
      return c.html(
        page(
          'Not our flow',
          'This callback did not come from a flow this server just started. Start again at /auth/netatmo.',
        ),
        400,
      );
    }

    const code = c.req.query('code');
    if (code === undefined) {
      return c.html(page('No code', 'Netatmo sent no authorisation code. Start again at /auth/netatmo.'), 400);
    }

    const exchanged = await fetchImpl(NETATMO_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: auth.clientId,
        client_secret: auth.clientSecret,
        code,
        redirect_uri: auth.redirectUri,
        scope: HOME_COACH_SCOPE,
      }),
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT.total('milliseconds')),
    });

    if (!exchanged.ok) {
      const body = await exchanged.text();
      return c.html(
        page(
          'Exchange failed',
          `Netatmo answered ${exchanged.status}: ${body}. If this mentions the redirect URI, it must match the app registration exactly (this server sent ${auth.redirectUri}).`,
        ),
        502,
      );
    }

    const payload: unknown = await exchanged.json();
    saveRefreshToken(auth.tokenPath, refreshTokenOf(payload));
    dependencies.log('Netatmo authorised — refresh token saved');

    return c.html(
      page(
        'Netatmo connected',
        'The refresh token is saved. The adapter picks it up on its next poll; you can close this tab.',
      ),
    );
  });

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

function refreshTokenOf(payload: unknown): string {
  if (
    payload === null ||
    typeof payload !== 'object' ||
    !('refresh_token' in payload) ||
    typeof payload.refresh_token !== 'string'
  ) {
    throw new Error('Netatmo token response carried no refresh_token');
  }
  return payload.refresh_token;
}

function page(title: string, text: string): string | Promise<string> {
  // Netatmo's error strings and query parameters end up interpolated into the
  // onboarding pages, and they arrive from the outside world. The tagged
  // template escapes every interpolation by default, so an interpolation added
  // later is safe whether or not its author thought about it.
  return html`<!doctype html><meta charset="utf-8"><title>${title}</title><h1>${title}</h1><p>${text}</p>`;
}
