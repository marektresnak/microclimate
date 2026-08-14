import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createFakeUnit } from '../src/actuator/fake.ts';
import type { FakeVentilationUnit } from '../src/actuator/fake.ts';
import type { SensorId } from '../src/config.ts';
import type { MeasurementKind, Reading } from '../src/domain/measurement.ts';
import { resolveSignal } from '../src/domain/precedence.ts';
import { toIsoUtc } from '../src/domain/time.ts';
import { createApiServer } from '../src/http/server.ts';
import type { ApiServerDependencies } from '../src/http/server.ts';
import type { NetatmoSettings } from '../src/sources/netatmo.ts';
import { loadRefreshToken } from '../src/sources/refresh-token-file.ts';
import type { FetchLike } from '../src/sources/source.ts';
import type { TadoSettings } from '../src/sources/tado.ts';
import { openLogStore } from '../src/store/logs.ts';
import type { LogStore } from '../src/store/logs.ts';
import { openReadingStore } from '../src/store/readings.ts';
import type { ReadingStore } from '../src/store/readings.ts';
import { assertDeepEqual } from './support/deep-equal.ts';

// The tests listen on a loopback ephemeral port and talk to it with fetch —
// the same precedent the Modbus socket tests set. "No network" means nothing
// beyond this machine; the vendor exchange goes through a scripted fetchImpl.

const NOW = Temporal.Instant.from('2026-08-11T12:00:00Z');

function reading(sourceId: SensorId, kind: MeasurementKind, value: number, measuredAt: Temporal.Instant): Reading {
  return { sourceId, kind, value, measuredAt, receivedAt: measuredAt };
}

/**
 * The same reading as the API writes it. The store keeps epoch milliseconds
 * because the uniqueness constraint needs one representation per instant; the
 * wire never sees them, and this is the seam where that becomes visible.
 */
function onTheWire(source: Reading): Record<string, unknown> {
  return {
    sourceId: source.sourceId,
    kind: source.kind,
    value: source.value,
    measuredAt: toIsoUtc(source.measuredAt),
    receivedAt: toIsoUtc(source.receivedAt),
  };
}

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  // Netatmo's exchange carries a form body; Tado's parameters ride the URL, and
  // the tests below read them off `url` instead.
  readonly form: URLSearchParams | undefined;
}

interface ScriptStep {
  readonly status: number;
  readonly json: unknown;
}

function scriptedFetch(script: ScriptStep[]): { impl: FetchLike; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];

  const impl: FetchLike = async (input, init) => {
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      form: init?.body instanceof URLSearchParams ? init.body : undefined,
    });

    const step = script.shift();
    if (step === undefined) throw new Error('the server made a request the script did not expect');

    return new Response(JSON.stringify(step.json), {
      status: step.status,
      headers: { 'content-type': 'application/json' },
    });
  };

  return { impl, requests };
}

interface Overrides {
  readonly netatmoAuth?: NetatmoSettings | undefined;
  readonly tadoAuth?: TadoSettings | undefined;
  /** A clock a test can move, for the one flow with a deadline in it. */
  readonly clock?: () => Temporal.Instant;
  readonly script?: ScriptStep[];
}

interface TestServer {
  readonly baseUrl: string;
  readonly store: ReadingStore;
  readonly logs: LogStore;
  readonly unit: FakeVentilationUnit;
  readonly tokenPath: string;
  /** One file per vendor, kept apart here so a test cannot pass by writing the
   * other vendor's token. */
  readonly tadoTokenPath: string;
  readonly requests: RecordedRequest[];
}

async function withServer(overrides: Overrides, run: (context: TestServer) => Promise<void>): Promise<void> {
  const store = openReadingStore(':memory:');
  const logs = openLogStore(':memory:');
  const unit = createFakeUnit(40);
  const directory = mkdtempSync(join(tmpdir(), 'server-'));
  const tokenPath = join(directory, 'netatmo-token.json');
  const tadoTokenPath = join(directory, 'tado-token.json');
  const fake = scriptedFetch(overrides.script ?? []);

  const dependencies: ApiServerDependencies = {
    store,
    logs,
    unit,
    netatmoAuth: {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'http://flat.local:3000/auth/netatmo/callback',
      tokenPath,
    },
    tadoAuth: { tokenPath: tadoTokenPath },
    clock: () => NOW,
    log: () => undefined,
    ...overrides,
  };

  const server = createApiServer(dependencies, fake.impl);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server has no port');

  try {
    await run({
      baseUrl: `http://127.0.0.1:${address.port}`,
      store,
      logs,
      unit,
      tokenPath,
      tadoTokenPath,
      requests: fake.requests,
    });
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    store.close();
    logs.close();
  }
}

/** Tado's device-flow answers. The vendor never calls us back, so onboarding is
 * this page asking these questions — see http/tado-auth.ts. */
function deviceCode(code: string): ScriptStep {
  const userCode = code.toUpperCase();
  return {
    status: 200,
    json: {
      device_code: code,
      user_code: userCode,
      verification_uri: 'https://login.tado.com/oauth2/device',
      verification_uri_complete: `https://login.tado.com/oauth2/device?user_code=${userCode}`,
      expires_in: 300,
      interval: 5,
    },
  };
}

function tadoRefusal(error: string): ScriptStep {
  return { status: 400, json: { error } };
}

function tadoGrant(): ScriptStep {
  return {
    status: 200,
    json: { access_token: 'access-1', refresh_token: 'tado-refresh-1', token_type: 'bearer', expires_in: 599 },
  };
}

function pathsOf(requests: readonly RecordedRequest[]): string[] {
  return requests.map((request) => new URL(request.url).pathname);
}

function postLevel(baseUrl: string, body: string): Promise<Response> {
  return fetch(`${baseUrl}/api/unit/level`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

describe('the http server', () => {
  it('answers /health', async () => {
    await withServer({}, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/health`);

      assert.equal(response.status, 200);
      assertDeepEqual(await response.json(), { ok: true });
    });
  });

  it('serves room state that agrees with resolveSignal, the one rule for every consumer', async () => {
    await withServer({}, async ({ baseUrl, store }) => {
      // The Netatmo leads for bedroom temperature but is stale; the Tado is
      // fresh and second — precedence has something real to decide.
      const netatmo = reading('bedroom_netatmo', 'temperature', 23.1, NOW.subtract({ minutes: 16 }));
      const tado = reading('bedroom_tado', 'temperature', 21.4, NOW.subtract({ minutes: 1 }));
      store.insert([netatmo, tado]);

      const expected = resolveSignal('bedroom', 'temperature', [netatmo, tado], NOW);
      assert.equal(expected.status, 'fresh');

      const response = await fetch(`${baseUrl}/api/state`);
      const body = await response.json();

      assert.equal(response.status, 200);
      // The whole shape, pinned: every configured (room, kind) pair answers,
      // and the bedroom temperature is exactly what resolveSignal said —
      // "one implementation, two consumers" as a property, not a promise.
      assertDeepEqual(body, {
        rooms: {
          living_room: {
            temperature: { status: 'missing' },
            humidity: { status: 'missing' },
          },
          kids_room: {
            temperature: { status: 'missing' },
            humidity: { status: 'missing' },
          },
          bedroom: {
            temperature: {
              status: expected.status,
              value: expected.value,
              sourceId: expected.sourceId,
              measuredAt: toIsoUtc(expected.measuredAt),
            },
            humidity: { status: 'missing' },
            co2: { status: 'missing' },
          },
        },
      });
    });
  });

  it('reports a stale value as stale, naming its source', async () => {
    await withServer({}, async ({ baseUrl, store }) => {
      store.insert([reading('bedroom_netatmo', 'co2', 910, NOW.subtract({ minutes: 20 }))]);

      const response = await fetch(`${baseUrl}/api/state`);
      const body: unknown = await response.json();

      assert.match(JSON.stringify(body), /"co2":\{"status":"stale","value":910,"sourceId":"bedroom_netatmo"/);
    });
  });

  it('serves the whole topology, inactive sensors included', async () => {
    await withServer({}, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/sensors`);
      const body: unknown = await response.json();
      const text = JSON.stringify(body);

      // Every configured sensor appears, and isActive travels with each entry —
      // nothing is filtered on it, so a retired instrument stays interpretable.
      for (const sensorId of ['living_room_tado', 'kids_room_tado', 'bedroom_tado', 'bedroom_netatmo']) {
        assert.match(text, new RegExp(`"${sensorId}"`));
      }
      assert.match(text, /"isActive":true/);
      assert.match(text, /"precedence"/);
    });
  });

  it('expands room history to every source config puts in the room', async () => {
    await withServer({}, async ({ baseUrl, store }) => {
      // The bedroom is the room with two instruments in it, so it is the one
      // where "expands to every source" has something to expand.
      const coach = reading('bedroom_netatmo', 'temperature', 22.3, NOW.subtract({ minutes: 2 }));
      const valve = reading('bedroom_tado', 'temperature', 23.8, NOW.subtract({ minutes: 1 }));
      const elsewhere = reading('kids_room_tado', 'temperature', 20.0, NOW.subtract({ minutes: 1 }));
      store.insert([coach, valve, elsewhere]);

      const from = toIsoUtc(NOW.subtract({ minutes: 10 }));
      const response = await fetch(`${baseUrl}/api/rooms/bedroom/readings?from=${from}&to=${toIsoUtc(NOW)}`);

      assert.equal(response.status, 200);
      assertDeepEqual(await response.json(), {
        room: 'bedroom',
        from,
        to: toIsoUtc(NOW),
        // Both instruments, in measured order; the kids-room reading stays out.
        readings: [onTheWire(coach), onTheWire(valve)],
      });
    });
  });

  it('serves per-instrument history', async () => {
    await withServer({}, async ({ baseUrl, store }) => {
      const mine = reading('bedroom_netatmo', 'co2', 870, NOW.subtract({ minutes: 1 }));
      const other = reading('bedroom_tado', 'temperature', 20.0, NOW.subtract({ minutes: 1 }));
      store.insert([mine, other]);

      const response = await fetch(`${baseUrl}/api/sensors/bedroom_netatmo/readings?kind=co2`);
      const body = await response.json();

      assert.equal(response.status, 200);
      assertDeepEqual(body, {
        sensorId: 'bedroom_netatmo',
        from: toIsoUtc(NOW.subtract({ hours: 24 })),
        to: toIsoUtc(NOW),
        readings: [onTheWire(mine)],
      });
    });
  });

  it('serves the log over the default last-day window, ISO in and out', async () => {
    await withServer({}, async ({ baseUrl, logs }) => {
      logs.append(NOW.subtract({ hours: 25 }), 'yesterday, outside the default window');
      logs.append(NOW.subtract({ minutes: 1 }), '50% set over the API');

      const response = await fetch(`${baseUrl}/api/logs`);

      assert.equal(response.status, 200);
      assertDeepEqual(await response.json(), {
        from: toIsoUtc(NOW.subtract({ hours: 24 })),
        to: toIsoUtc(NOW),
        lines: [{ at: toIsoUtc(NOW.subtract({ minutes: 1 })), message: '50% set over the API' }],
      });
    });
  });

  it('serves an explicit log range', async () => {
    await withServer({}, async ({ baseUrl, logs }) => {
      logs.append(NOW.subtract({ minutes: 3 }), 'before the range');
      logs.append(NOW.subtract({ minutes: 2 }), 'inside it');

      const from = toIsoUtc(NOW.subtract({ minutes: 2 }));
      const to = toIsoUtc(NOW.subtract({ minutes: 1 }));
      const response = await fetch(`${baseUrl}/api/logs?from=${from}&to=${to}`);

      assert.equal(response.status, 200);
      assertDeepEqual(await response.json(), {
        from,
        to,
        lines: [{ at: toIsoUtc(NOW.subtract({ minutes: 2 })), message: 'inside it' }],
      });
    });
  });

  it('rejects what it does not know: rooms, sensors, timestamps, routes', async () => {
    await withServer({}, async ({ baseUrl }) => {
      const cases: readonly [string, number][] = [
        ['/api/rooms/garage/readings', 404],
        ['/api/sensors/attic_sen66/readings', 404],
        ['/api/rooms/bedroom/readings?from=yesterday', 400],
        // Epoch milliseconds are the store's business, not the API's.
        [`/api/rooms/bedroom/readings?from=${NOW.subtract({ minutes: 1 }).epochMilliseconds}`, 400],
        // No zone, so it would mean a different instant on every machine.
        ['/api/rooms/bedroom/readings?from=2026-08-11T12:00:00', 400],
        ['/api/rooms/bedroom/readings?to=2026-02-31T00:00:00Z', 400],
        // The log speaks the same grammar as every other range.
        ['/api/logs?from=2026-08-11T12:00:00', 400],
        ['/api/nope', 404],
      ];

      for (const [path, status] of cases) {
        const response = await fetch(`${baseUrl}${path}`);
        assert.equal(response.status, status, path);
      }
    });
  });

  it('reads the unit level live, and says when it cannot', async () => {
    await withServer({}, async ({ baseUrl, unit }) => {
      unit.level = 60;
      const healthy = await fetch(`${baseUrl}/api/unit/level`);
      assertDeepEqual(await healthy.json(), { level: 60 });

      unit.failReads = true;
      const failing = await fetch(`${baseUrl}/api/unit/level`);
      assert.equal(failing.status, 502);
    });
  });

  it('drives the unit', async () => {
    // No token, deliberately: the endpoint is open on the trusted LAN, a
    // decision that reversed a review finding — recorded in docs/api.md.
    await withServer({}, async ({ baseUrl, unit }) => {
      const response = await postLevel(baseUrl, JSON.stringify({ level: 50 }));

      assert.equal(response.status, 200);
      assertDeepEqual(await response.json(), { level: 50 });
      assertDeepEqual(unit.commands, [50]);
      assert.equal(unit.level, 50);
    });
  });

  it('refuses 90 and 100 — the readable levels that must never be commanded', async () => {
    await withServer({}, async ({ baseUrl, unit }) => {
      for (const level of [90, 100, 55, -10]) {
        const response = await postLevel(baseUrl, JSON.stringify({ level }));
        assert.equal(response.status, 400, `level ${level}`);
      }

      const garbage = await postLevel(baseUrl, 'not json');
      assert.equal(garbage.status, 400);

      const wrongShape = await postLevel(baseUrl, JSON.stringify({ level: 'high' }));
      assert.equal(wrongShape.status, 400);

      assertDeepEqual(unit.commands, []);
    });
  });

  it('answers 502 when the unit refuses the write', async () => {
    await withServer({}, async ({ baseUrl, unit }) => {
      unit.failWrites = true;

      const response = await postLevel(baseUrl, JSON.stringify({ level: 50 }));

      assert.equal(response.status, 502);
    });
  });

  it('ingests a batch, stamping receivedAt from its own clock', async () => {
    await withServer({}, async ({ baseUrl }) => {
      const batch = JSON.stringify([
        { sourceId: 'bedroom_netatmo', kind: 'co2', value: 842, measuredAt: toIsoUtc(NOW.subtract({ minutes: 1 })) },
      ]);
      const response = await fetch(`${baseUrl}/api/readings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: batch,
      });

      assert.equal(response.status, 200);
      assertDeepEqual(await response.json(), { stored: 1, duplicates: 0, rejected: [] });

      const readBack = await fetch(`${baseUrl}/api/sensors/bedroom_netatmo/readings?kind=co2`);
      assertDeepEqual(await readBack.json(), {
        sensorId: 'bedroom_netatmo',
        from: toIsoUtc(NOW.subtract({ hours: 24 })),
        to: toIsoUtc(NOW),
        // The node's clock says when it measured; ours says when it arrived.
        readings: [
          {
            sourceId: 'bedroom_netatmo',
            kind: 'co2',
            value: 842,
            measuredAt: toIsoUtc(NOW.subtract({ minutes: 1 })),
            receivedAt: toIsoUtc(NOW),
          },
        ],
      });
    });
  });

  it('takes a reading in any zone and gives it back in UTC', async () => {
    await withServer({}, async ({ baseUrl }) => {
      // Prague summer time, which is what a node in this flat would most
      // plausibly stamp if it were told the local zone rather than UTC.
      const batch = JSON.stringify([
        { sourceId: 'bedroom_netatmo', kind: 'co2', value: 842, measuredAt: '2026-08-11T13:59:00+02:00' },
      ]);
      const ingested = await fetch(`${baseUrl}/api/readings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: batch,
      });
      assertDeepEqual(await ingested.json(), { stored: 1, duplicates: 0, rejected: [] });

      // Asked for over a window written in a third zone, to make the point that
      // no part of this depends on which spelling arrived.
      const readBack = await fetch(
        `${baseUrl}/api/sensors/bedroom_netatmo/readings?kind=co2&from=2026-08-11T06:00:00-05:00`,
      );

      assertDeepEqual(await readBack.json(), {
        sensorId: 'bedroom_netatmo',
        // Echoed in UTC, so the window that was actually applied is visible.
        from: '2026-08-11T11:00:00.000Z',
        to: toIsoUtc(NOW),
        readings: [
          {
            sourceId: 'bedroom_netatmo',
            kind: 'co2',
            value: 842,
            // 13:59+02:00 is 11:59Z. One instant, and the API only ever says it
            // one way however it was told.
            measuredAt: '2026-08-11T11:59:00.000Z',
            receivedAt: toIsoUtc(NOW),
          },
        ],
      });
    });
  });

  it('refuses an ingest body that is not JSON, or not an array', async () => {
    await withServer({}, async ({ baseUrl }) => {
      const notJson = await fetch(`${baseUrl}/api/readings`, { method: 'POST', body: 'not json' });
      assert.equal(notJson.status, 400);

      const notArray = await fetch(`${baseUrl}/api/readings`, { method: 'POST', body: '{}' });
      assert.equal(notArray.status, 400);
      assert.match(JSON.stringify(await notArray.json()), /array of readings/);
    });
  });

  it('starts the netatmo flow with a state and without the client secret', async () => {
    await withServer({}, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/auth/netatmo`, { redirect: 'manual' });

      assert.equal(response.status, 302);
      const location = new URL(response.headers.get('location') ?? '');
      assert.equal(location.origin + location.pathname, 'https://api.netatmo.com/oauth2/authorize');
      assert.equal(location.searchParams.get('client_id'), 'client-id');
      assert.equal(location.searchParams.get('redirect_uri'), 'http://flat.local:3000/auth/netatmo/callback');
      assert.equal(location.searchParams.get('scope'), 'read_homecoach');
      assert.equal(location.searchParams.get('response_type'), 'code');
      assert.notEqual(location.searchParams.get('state'), null);
      // The secret stays out of the browser's address bar and history.
      assert.ok(!location.toString().includes('client-secret'));
    });
  });

  it('exchanges the callback code and persists the refresh token', async () => {
    const script = [{ status: 200, json: { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 10_800 } }];

    await withServer({ script }, async ({ baseUrl, tokenPath, requests }) => {
      const redirect = await fetch(`${baseUrl}/auth/netatmo`, { redirect: 'manual' });
      const state = new URL(redirect.headers.get('location') ?? '').searchParams.get('state');

      const callback = await fetch(`${baseUrl}/auth/netatmo/callback?code=the-code&state=${state}`);

      assert.equal(callback.status, 200);
      assert.match(await callback.text(), /refresh token is saved/);
      assert.equal(loadRefreshToken(tokenPath), 'refresh-1');

      const exchange = requests[0];
      assert.equal(exchange?.url, 'https://api.netatmo.com/oauth2/token');
      assert.equal(exchange?.form?.get('grant_type'), 'authorization_code');
      assert.equal(exchange?.form?.get('code'), 'the-code');
      assert.equal(exchange?.form?.get('redirect_uri'), 'http://flat.local:3000/auth/netatmo/callback');
      assert.equal(exchange?.form?.get('scope'), 'read_homecoach');
    });
  });

  it('rejects a callback whose state is not the one it issued', async () => {
    await withServer({}, async ({ baseUrl, tokenPath, requests }) => {
      await fetch(`${baseUrl}/auth/netatmo`, { redirect: 'manual' });

      const callback = await fetch(`${baseUrl}/auth/netatmo/callback?code=the-code&state=forged`);

      assert.equal(callback.status, 400);
      assert.equal(loadRefreshToken(tokenPath), undefined);
      assert.equal(requests.length, 0);
    });
  });

  it('shows the refusal when the user clicks deny at Netatmo', async () => {
    await withServer({}, async ({ baseUrl, requests }) => {
      const callback = await fetch(`${baseUrl}/auth/netatmo/callback?error=access_denied`);

      assert.equal(callback.status, 400);
      assert.match(await callback.text(), /access_denied/);
      assert.equal(requests.length, 0);
    });
  });

  it('says what is missing when onboarding is not configured', async () => {
    await withServer({ netatmoAuth: undefined }, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/auth/netatmo`);

      assert.equal(response.status, 503);
      assert.match(JSON.stringify(await response.json()), /NETATMO_CLIENT_ID/);
    });
  });

  it('hands out a Tado device code, and a page that polls at the vendor’s interval', async () => {
    await withServer({ script: [deviceCode('code-1')] }, async ({ baseUrl, requests }) => {
      const response = await fetch(`${baseUrl}/auth/tado`);
      const page = await response.text();

      assert.equal(response.status, 200);
      const asked = new URL(requests[0]?.url ?? '');
      assert.equal(requests[0]?.method, 'POST');
      assert.equal(asked.pathname, '/oauth2/device_authorize');
      // Without offline_access the grant carries no refresh token, and the
      // whole point of authorising once is a token that outlives this page.
      assert.equal(asked.searchParams.get('scope'), 'offline_access');
      assert.notEqual(asked.searchParams.get('client_id'), null);

      // The meta refresh IS the polling mechanism, set to Tado's own interval.
      assert.match(page, /<meta http-equiv="refresh" content="5">/);
      assert.match(page, /login\.tado\.com\/oauth2\/device\?user_code=CODE-1/);
    });
  });

  it('polls Tado exactly once per page load', async () => {
    const script = [deviceCode('code-1'), tadoRefusal('authorization_pending'), tadoRefusal('authorization_pending')];

    await withServer({ script }, async ({ baseUrl, requests }) => {
      await fetch(`${baseUrl}/auth/tado`);
      const reload = await fetch(`${baseUrl}/auth/tado`);
      await fetch(`${baseUrl}/auth/tado`);

      // One request per load and no loop anywhere — Tado has historically rate
      // limited clients that poll harder than they were told to.
      assertDeepEqual(pathsOf(requests), ['/oauth2/device_authorize', '/oauth2/token', '/oauth2/token']);
      // Still the same code: waiting is not starting over.
      assert.match(await reload.text(), /CODE-1/);
    });
  });

  it('saves the refresh token once the code is approved, and stops polling', async () => {
    const script = [deviceCode('code-1'), tadoGrant(), deviceCode('code-2')];

    await withServer({ script }, async ({ baseUrl, tadoTokenPath, requests }) => {
      await fetch(`${baseUrl}/auth/tado`);
      const granted = await fetch(`${baseUrl}/auth/tado`);
      const page = await granted.text();

      assert.equal(granted.status, 200);
      assert.equal(loadRefreshToken(tadoTokenPath), 'tado-refresh-1');
      // No meta refresh on the success page: an answer must not become a loop.
      assert.ok(!page.includes('http-equiv="refresh"'), page);

      const poll = new URL(requests[1]?.url ?? '');
      assert.equal(poll.searchParams.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
      assert.equal(poll.searchParams.get('device_code'), 'code-1');

      // The flow is cleared, so the next visit starts a new one rather than
      // polling a code that has already been spent.
      await fetch(`${baseUrl}/auth/tado`);
      assert.equal(pathsOf(requests)[2], '/oauth2/device_authorize');
    });
  });

  it('backs off five seconds when Tado says slow down', async () => {
    const script = [deviceCode('code-1'), tadoRefusal('slow_down')];

    await withServer({ script }, async ({ baseUrl }) => {
      await fetch(`${baseUrl}/auth/tado`);
      const slower = await fetch(`${baseUrl}/auth/tado`);

      // RFC 8628's answer to slow_down, and the page carries the new rhythm.
      assert.match(await slower.text(), /<meta http-equiv="refresh" content="10">/);
    });
  });

  it('shows the refusal when the Tado approval is denied, and starts again after it', async () => {
    const script = [deviceCode('code-1'), tadoRefusal('access_denied'), deviceCode('code-2')];

    await withServer({ script }, async ({ baseUrl }) => {
      await fetch(`${baseUrl}/auth/tado`);
      const denied = await fetch(`${baseUrl}/auth/tado`);

      assert.equal(denied.status, 400);
      assert.match(await denied.text(), /refused/);

      const again = await fetch(`${baseUrl}/auth/tado`);
      assert.match(await again.text(), /CODE-2/);
    });
  });

  it('starts a fresh code when the old one has expired, however it learns that', async () => {
    // Our own clock says so...
    let now = NOW;
    await withServer({ clock: () => now, script: [deviceCode('code-1'), deviceCode('code-2')] }, async ({ baseUrl }) => {
      await fetch(`${baseUrl}/auth/tado`);
      now = NOW.add({ minutes: 6 }); // the code was good for 300 seconds

      assert.match(await (await fetch(`${baseUrl}/auth/tado`)).text(), /CODE-2/);
    });

    // ...or Tado does, which is the same answer arriving the other way round.
    const script = [deviceCode('code-3'), tadoRefusal('expired_token'), deviceCode('code-4')];
    await withServer({ script }, async ({ baseUrl }) => {
      await fetch(`${baseUrl}/auth/tado`);

      assert.match(await (await fetch(`${baseUrl}/auth/tado`)).text(), /CODE-4/);
    });
  });

  it('reports a Tado answer it has no rule for, rather than waiting on it forever', async () => {
    const script = [deviceCode('code-1'), { status: 500, json: { errors: [{ code: 'internalError' }] } }];

    await withServer({ script }, async ({ baseUrl }) => {
      await fetch(`${baseUrl}/auth/tado`);
      const unexpected = await fetch(`${baseUrl}/auth/tado`);

      assert.equal(unexpected.status, 502);
      assert.match(await unexpected.text(), /internalError/);
    });
  });

  it('says what is missing when Tado onboarding is not configured', async () => {
    await withServer({ tadoAuth: undefined }, async ({ baseUrl, requests }) => {
      const response = await fetch(`${baseUrl}/auth/tado`);

      assert.equal(response.status, 503);
      assert.match(JSON.stringify(await response.json()), /TADO_TOKEN_PATH/);
      // Nothing asked of Tado: there would be nowhere to put the answer.
      assert.equal(requests.length, 0);
    });
  });
});
