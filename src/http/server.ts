import { randomUUID } from 'node:crypto';
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
import { NETATMO_TOKEN_URL } from '../sources/netatmo.ts';
import type { FetchLike } from '../sources/netatmo.ts';
import { saveRefreshToken } from '../sources/netatmo-token.ts';
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
// A callback presenting a state older than this is not a flow anyone is still
// sitting in front of.
const STATE_VALID_MS = 10 * 60_000;
const EXCHANGE_TIMEOUT_MS = 10_000;
const DAY_MS = 24 * 60 * 60_000;
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
  readonly unit: VentilationUnit;
  /** Unset disables the two /auth/netatmo routes, with an explanation. */
  readonly netatmoAuth: NetatmoAuthOptions | undefined;
  readonly clock: () => number;
  readonly log: (line: string) => void;
}

/** What /api/state says about one (room, kind). */
type SignalBody =
  | { readonly status: 'missing' }
  | {
      readonly status: 'fresh' | 'stale';
      readonly value: number;
      readonly sourceId: SensorId;
      readonly measuredAt: number;
      readonly ageMs: number;
    };

export function createApiServer(
  dependencies: ApiServerDependencies,
  fetchImpl: FetchLike = fetch,
): Server {
  // The one live OAuth state, single-use. Only the most recent flow counts, so
  // opening the auth page twice invalidates the first tab — acceptable for a
  // single-operator system, and it keeps this a value instead of a table.
  let pendingState: { readonly value: string; readonly issuedAt: number } | undefined;

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
        kinds[kind] = describeSignal(resolveSignal(room, kind, latest, now), now);
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
    pendingState = { value: state, issuedAt: dependencies.clock() };

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
    const expired = pending !== undefined && dependencies.clock() - pending.issuedAt > STATE_VALID_MS;
    if (pending === undefined || presented !== pending.value || expired) {
      return c.html(
        page(
          'Not our flow',
          'This callback did not come from a flow this server just started, or it took longer than ten minutes. Start again at /auth/netatmo.',
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
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
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

  // Registration order decides: each path above answers its own methods, and
  // anything else on a known path lands here as a 405 rather than the 404.
  for (const knownPath of [
    '/health',
    '/api/state',
    '/api/sensors',
    '/api/rooms/:room/readings',
    '/api/sensors/:id/readings',
    '/api/unit/level',
    '/api/readings',
    '/auth/netatmo',
    '/auth/netatmo/callback',
  ]) {
    app.all(knownPath, (c) => c.json({ error: 'method not allowed' }, 405));
  }

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
    now: number,
  ): { from: number; to: number; readings: Reading[] } | { error: string } {
    const range = rangeOf(fromRaw, toRaw, now);
    if ('error' in range) return range;

    const kinds = kindFilterOf(kindRaw);
    if ('error' in kinds) return kinds;

    const readings: Reading[] = [];
    for (const sensorId of sensorIds) {
      for (const kind of SENSORS[sensorId].kinds) {
        if (!kinds.kinds.includes(kind)) continue;
        readings.push(...dependencies.store.readingsInRange(sensorId, kind, range.from, range.to));
      }
    }
    readings.sort((first, second) => first.measuredAt - second.measuredAt);

    return { from: range.from, to: range.to, readings };
  }

  return createServer(getRequestListener(app.fetch));
}

// ── helpers with no state ────────────────────────────────────────────────────

function rangeOf(
  fromRaw: string | undefined,
  toRaw: string | undefined,
  now: number,
): { from: number; to: number } | { error: string } {
  const to = toRaw === undefined ? now : Number(toRaw);
  const from = fromRaw === undefined ? to - DAY_MS : Number(fromRaw);

  // Epoch milliseconds, for the same reason the column is an integer: one
  // representation per instant. Rejecting NaN beats an empty result that would
  // read as "no data".
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    return { error: 'from and to must be epoch milliseconds' };
  }
  if (from > to) {
    return { error: 'from is after to' };
  }

  return { from, to };
}

function kindFilterOf(raw: string | undefined): { kinds: readonly MeasurementKind[] } | { error: string } {
  if (raw === undefined) return { kinds: MEASUREMENT_KINDS };

  const kind = MEASUREMENT_KINDS.find((candidate) => candidate === raw);
  if (kind === undefined) return { error: `unknown kind ${raw}` };

  return { kinds: [kind] };
}

function describeSignal(signal: RoomSignal, now: number): SignalBody {
  if (signal.status === 'missing') return { status: 'missing' };

  return {
    status: signal.status,
    value: signal.value,
    sourceId: signal.sourceId,
    measuredAt: signal.measuredAt,
    ageMs: now - signal.measuredAt,
  };
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

function page(title: string, text: string): string {
  // Netatmo's error strings and query parameters end up interpolated into the
  // onboarding pages, and they arrive from the outside world — hence escaped.
  return (
    `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
    `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p>`
  );
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
