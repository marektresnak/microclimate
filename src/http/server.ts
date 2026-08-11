import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

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
 * onboarding pair. Hand-rolled on `node:http`: nine routes do not justify a
 * router dependency.
 *
 * No endpoint carries auth — single home, trusted LAN, as designed. That
 * includes the one that moves the hardware, which reverses an earlier decision
 * and a review finding; the acceptance and its bounds are recorded in
 * CLAUDE.md ("The write endpoint is open on the LAN"). What any caller can do
 * is bounded by construction: 20-80, never off, never above the grille
 * ceiling.
 *
 * Time arrives through `clock` and the network through `fetchImpl`, so every
 * test runs against a fixed instant and a canned vendor.
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
// whatever a confused client pours in.
const MAX_BODY_BYTES = 16 * 1024;
// Ingest is the exception: a node replaying a buffered backlog sends real
// batches. A quarter megabyte is roughly three thousand readings.
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

export function createApiServer(
  dependencies: ApiServerDependencies,
  fetchImpl: FetchLike = fetch,
): Server {
  // The one live OAuth state, single-use. Only the most recent flow counts, so
  // opening the auth page twice invalidates the first tab — acceptable for a
  // single-operator system, and it keeps this a value instead of a table.
  let pendingState: { readonly value: string; readonly issuedAt: number } | undefined;

  const server = createServer((request, response) => {
    void handle(request, response).catch((error) => {
      dependencies.log(`${request.method ?? '?'} ${request.url ?? '?'} failed: ${messageOf(error)}`);
      if (!response.headersSent) {
        sendJson(response, 500, { error: messageOf(error) });
      } else {
        response.end();
      }
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // The base is only there to satisfy URL's parser; requests carry a path.
    const url = new URL(request.url ?? '/', 'http://microclimate.local');
    const method = request.method ?? 'GET';
    const path = url.pathname;
    const now = dependencies.clock();

    if (path === '/health') {
      if (method !== 'GET') return methodNotAllowed(response);
      return sendJson(response, 200, { ok: true });
    }

    if (path === '/api/state') {
      if (method !== 'GET') return methodNotAllowed(response);
      return sendJson(response, 200, stateBody(now));
    }

    if (path === '/api/sensors') {
      if (method !== 'GET') return methodNotAllowed(response);
      // The whole topology, inactive entries included — a client interpreting
      // historical readings needs the vocabulary of the past, not just the
      // instruments currently consulted.
      return sendJson(response, 200, { rooms: ROOM_IDS, sensors: SENSORS, precedence: PRECEDENCE });
    }

    if (path === '/api/unit/level') {
      if (method === 'GET') return readUnitLevel(response);
      if (method === 'POST') return setUnitLevel(request, response);
      return methodNotAllowed(response);
    }

    if (path === '/api/readings') {
      if (method !== 'POST') return methodNotAllowed(response);
      return ingestReadings(request, response, now);
    }

    if (path === '/auth/netatmo') {
      if (method !== 'GET') return methodNotAllowed(response);
      return startNetatmoAuth(response, now);
    }

    if (path === '/auth/netatmo/callback') {
      if (method !== 'GET') return methodNotAllowed(response);
      return finishNetatmoAuth(url, response, now);
    }

    const segments = path.split('/').filter((segment) => segment !== '');

    // /api/rooms/:room/readings — room history, sources expanded from config.
    if (segments.length === 4 && segments[0] === 'api' && segments[1] === 'rooms' && segments[3] === 'readings') {
      if (method !== 'GET') return methodNotAllowed(response);
      const room = ROOM_IDS.find((candidate) => candidate === segments[2]);
      if (room === undefined) {
        return sendJson(response, 404, { error: `no room called ${segments[2] ?? ''}` });
      }
      // Every sensor config places in the room, inactive ones included: history
      // outlives decommissioning, and this endpoint is where it stays readable.
      const sensorIds = SENSOR_IDS.filter((id) => SENSORS[id].room === room);
      return history(response, url, now, { room }, sensorIds);
    }

    // /api/sensors/:id/readings — one instrument, raw.
    if (segments.length === 4 && segments[0] === 'api' && segments[1] === 'sensors' && segments[3] === 'readings') {
      if (method !== 'GET') return methodNotAllowed(response);
      const sensorId = SENSOR_IDS.find((candidate) => candidate === segments[2]);
      if (sensorId === undefined) {
        return sendJson(response, 404, { error: `no sensor called ${segments[2] ?? ''}` });
      }
      return history(response, url, now, { sensorId }, [sensorId]);
    }

    sendJson(response, 404, { error: `no route for ${path}` });
  }

  // ── the read API ───────────────────────────────────────────────────────────

  /**
   * One value per (room, kind), resolved by the same `resolveSignal` the
   * controller uses — one implementation, two consumers, so the dashboard and
   * the control decision cannot disagree about what a room currently says.
   * The control block itself is parked with the loop; see CLAUDE.md.
   */
  function stateBody(now: number): unknown {
    const rooms: Partial<Record<RoomId, Partial<Record<MeasurementKind, unknown>>>> = {};

    for (const room of ROOM_IDS) {
      const kinds: Partial<Record<MeasurementKind, unknown>> = {};

      for (const kind of MEASUREMENT_KINDS) {
        const ranked = PRECEDENCE[room][kind];
        if (ranked === undefined) continue;

        const latest = latestReadingsFrom(ranked, kind);
        kinds[kind] = describeSignal(resolveSignal(room, kind, latest, now), now);
      }

      rooms[room] = kinds;
    }

    return { rooms };
  }

  function latestReadingsFrom(ranked: readonly SensorId[], kind: MeasurementKind): Reading[] {
    const readings: Reading[] = [];

    for (const sourceId of ranked) {
      const latest = dependencies.store.latestReading(sourceId, kind);
      if (latest !== undefined) readings.push(latest);
    }

    return readings;
  }

  function history(
    response: ServerResponse,
    url: URL,
    now: number,
    subject: Record<string, string>,
    sensorIds: readonly SensorId[],
  ): void {
    const range = rangeOf(url, now);
    if ('error' in range) return sendJson(response, 400, range);

    const kinds = kindFilterOf(url);
    if ('error' in kinds) return sendJson(response, 400, kinds);

    const readings: Reading[] = [];
    for (const sensorId of sensorIds) {
      for (const kind of SENSORS[sensorId].kinds) {
        if (!kinds.kinds.includes(kind)) continue;
        readings.push(...dependencies.store.readingsInRange(sensorId, kind, range.from, range.to));
      }
    }
    readings.sort((first, second) => first.measuredAt - second.measuredAt);

    sendJson(response, 200, { ...subject, from: range.from, to: range.to, readings });
  }

  // ── the unit ───────────────────────────────────────────────────────────────

  async function readUnitLevel(response: ServerResponse): Promise<void> {
    try {
      const level = await dependencies.unit.read();
      sendJson(response, 200, { level });
    } catch (error) {
      // 502, not 500: this service is fine, the thing behind it is not.
      sendJson(response, 502, { error: `could not read the unit: ${messageOf(error)}` });
    }
  }

  async function setUnitLevel(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = await jsonBodyOf(request, MAX_BODY_BYTES);
    } catch (error) {
      return sendJson(response, 400, { error: messageOf(error) });
    }

    if (body === null || typeof body !== 'object' || !('level' in body) || typeof body.level !== 'number') {
      return sendJson(response, 400, { error: 'expected {"level": <20-80 in steps of 10>}' });
    }

    // The runtime half of CommandedLevel, at the boundary where a number enters
    // from outside. 90 and 100 die here — the intake grille cannot pass the
    // air, and type stripping checks nothing.
    let level: CommandedLevel;
    try {
      level = assertCommandedLevel(body.level);
    } catch (error) {
      return sendJson(response, 400, { error: messageOf(error) });
    }

    try {
      await dependencies.unit.set(level);
    } catch (error) {
      return sendJson(response, 502, { error: `could not command ${level}%: ${messageOf(error)}` });
    }

    dependencies.log(`${level}% set over the API`);
    sendJson(response, 200, { level });
  }

  // Open like every write on this LAN, and this one carries the sharper risk
  // of the two: a poisoned reading outlives its request, and once the loop is
  // rewired, invented bedroom CO2 steers the fan. Accepted knowingly — the
  // decision and its bounds are in CLAUDE.md beside the unit endpoint's.
  //
  // 200 whenever the batch was processed, verdicts inside: a rejected reading
  // cannot be fixed by resending it, so a status a simple node reads as "retry"
  // would have it replaying poison forever.
  async function ingestReadings(
    request: IncomingMessage,
    response: ServerResponse,
    now: number,
  ): Promise<void> {
    let body: unknown;
    try {
      body = await jsonBodyOf(request, INGEST_BODY_BYTES);
    } catch (error) {
      return sendJson(response, 400, { error: messageOf(error) });
    }

    const outcome = ingestBatch(body, dependencies.store, now, dependencies.log);
    if ('error' in outcome) return sendJson(response, 400, outcome);

    dependencies.log(
      `ingest: ${outcome.stored} new, ${outcome.duplicates} duplicate, ${outcome.rejected.length} rejected`,
    );
    sendJson(response, 200, outcome);
  }

  // ── netatmo onboarding ─────────────────────────────────────────────────────

  function startNetatmoAuth(response: ServerResponse, now: number): void {
    const auth = dependencies.netatmoAuth;
    if (auth === undefined) {
      return sendJson(response, 503, {
        error: 'set NETATMO_CLIENT_ID and NETATMO_CLIENT_SECRET to enable Netatmo onboarding',
      });
    }

    const state = randomUUID();
    pendingState = { value: state, issuedAt: now };

    // No client_secret in this URL, deliberately: it travels through the
    // user's browser and history, and the authorisation step does not need it.
    // (Netatmo's own PHP client does send it there. We do not copy that.)
    const authorize = new URL(AUTHORIZE_URL);
    authorize.searchParams.set('client_id', auth.clientId);
    authorize.searchParams.set('redirect_uri', auth.redirectUri);
    authorize.searchParams.set('scope', HOME_COACH_SCOPE);
    authorize.searchParams.set('state', state);
    authorize.searchParams.set('response_type', 'code');

    response.writeHead(302, { location: authorize.toString() });
    response.end();
  }

  async function finishNetatmoAuth(url: URL, response: ServerResponse, now: number): Promise<void> {
    const auth = dependencies.netatmoAuth;
    if (auth === undefined) {
      return sendJson(response, 503, {
        error: 'set NETATMO_CLIENT_ID and NETATMO_CLIENT_SECRET to enable Netatmo onboarding',
      });
    }

    const refusal = url.searchParams.get('error');
    if (refusal !== null) {
      return sendPage(response, 400, 'Netatmo said no', `Netatmo refused the authorisation: ${refusal}. Start again at /auth/netatmo.`);
    }

    // Single-use, consumed before anything else can go wrong with it.
    const presented = url.searchParams.get('state');
    const pending = pendingState;
    pendingState = undefined;
    if (pending === undefined || presented !== pending.value || now - pending.issuedAt > STATE_VALID_MS) {
      return sendPage(response, 400, 'Not our flow', 'This callback did not come from a flow this server just started, or it took longer than ten minutes. Start again at /auth/netatmo.');
    }

    const code = url.searchParams.get('code');
    if (code === null) {
      return sendPage(response, 400, 'No code', 'Netatmo sent no authorisation code. Start again at /auth/netatmo.');
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
      return sendPage(
        response,
        502,
        'Exchange failed',
        `Netatmo answered ${exchanged.status}: ${body}. If this mentions the redirect URI, it must match the app registration exactly (this server sent ${auth.redirectUri}).`,
      );
    }

    const payload: unknown = await exchanged.json();
    saveRefreshToken(auth.tokenPath, refreshTokenOf(payload));
    dependencies.log('Netatmo authorised — refresh token saved');

    sendPage(
      response,
      200,
      'Netatmo connected',
      'The refresh token is saved. The adapter picks it up on its next poll; you can close this tab.',
    );
  }

  return server;
}

// ── helpers with no state ────────────────────────────────────────────────────

function rangeOf(url: URL, now: number): { from: number; to: number } | { error: string } {
  const toRaw = url.searchParams.get('to');
  const fromRaw = url.searchParams.get('from');

  const to = toRaw === null ? now : Number(toRaw);
  const from = fromRaw === null ? to - DAY_MS : Number(fromRaw);

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

function kindFilterOf(url: URL): { kinds: readonly MeasurementKind[] } | { error: string } {
  const raw = url.searchParams.get('kind');
  if (raw === null) return { kinds: MEASUREMENT_KINDS };

  const kind = MEASUREMENT_KINDS.find((candidate) => candidate === raw);
  if (kind === undefined) return { error: `unknown kind ${raw}` };

  return { kinds: [kind] };
}

function describeSignal(signal: RoomSignal, now: number): unknown {
  if (signal.status === 'missing') return { status: 'missing' };

  return {
    status: signal.status,
    value: signal.value,
    sourceId: signal.sourceId,
    measuredAt: signal.measuredAt,
    ageMs: now - signal.measuredAt,
  };
}

function jsonBodyOf(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('the body is too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('the body is not JSON'));
      }
    });

    request.on('error', reject);
  });
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

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function sendPage(response: ServerResponse, status: number, title: string, text: string): void {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  response.end(
    `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
      `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p>`,
  );
}

// Netatmo's error strings and query parameters end up interpolated into the
// onboarding pages, and they arrive from the outside world.
function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function methodNotAllowed(response: ServerResponse): void {
  sendJson(response, 405, { error: 'method not allowed' });
}
