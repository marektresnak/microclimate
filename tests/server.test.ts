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
import type { ApiServerDependencies, NetatmoAuthOptions } from '../src/http/server.ts';
import type { FetchLike } from '../src/sources/netatmo.ts';
import { loadRefreshToken } from '../src/sources/netatmo-token.ts';
import { openLogStore } from '../src/store/logs.ts';
import type { LogStore } from '../src/store/logs.ts';
import { openReadingStore } from '../src/store/readings.ts';
import type { ReadingStore } from '../src/store/readings.ts';

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
  readonly netatmoAuth?: NetatmoAuthOptions | undefined;
  readonly script?: ScriptStep[];
}

interface TestServer {
  readonly baseUrl: string;
  readonly store: ReadingStore;
  readonly logs: LogStore;
  readonly unit: FakeVentilationUnit;
  readonly tokenPath: string;
  readonly requests: RecordedRequest[];
}

async function withServer(overrides: Overrides, run: (context: TestServer) => Promise<void>): Promise<void> {
  const store = openReadingStore(':memory:');
  const logs = openLogStore(':memory:');
  const unit = createFakeUnit(40);
  const tokenPath = join(mkdtempSync(join(tmpdir(), 'server-')), 'token.json');
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
      assert.deepEqual(await response.json(), { ok: true });
    });
  });

  it('serves room state that agrees with resolveSignal, the same rule the controller uses', async () => {
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
      assert.deepEqual(body, {
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
      for (const sensorId of ['living_room_tado', 'kids_room_tado_left', 'kids_room_tado_right', 'bedroom_tado', 'bedroom_netatmo']) {
        assert.match(text, new RegExp(`"${sensorId}"`));
      }
      assert.match(text, /"isActive":true/);
      assert.match(text, /"precedence"/);
    });
  });

  it('expands room history to every source config puts in the room', async () => {
    await withServer({}, async ({ baseUrl, store }) => {
      const left = reading('kids_room_tado_left', 'temperature', 22.3, NOW.subtract({ minutes: 2 }));
      const right = reading('kids_room_tado_right', 'temperature', 21.1, NOW.subtract({ minutes: 1 }));
      const elsewhere = reading('bedroom_tado', 'temperature', 20.0, NOW.subtract({ minutes: 1 }));
      store.insert([left, right, elsewhere]);

      const from = toIsoUtc(NOW.subtract({ minutes: 10 }));
      const response = await fetch(`${baseUrl}/api/rooms/kids_room/readings?from=${from}&to=${toIsoUtc(NOW)}`);

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        room: 'kids_room',
        from,
        to: toIsoUtc(NOW),
        // Both valves, in measured order; the bedroom reading stays out.
        readings: [onTheWire(left), onTheWire(right)],
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
      assert.deepEqual(body, {
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
      assert.deepEqual(await response.json(), {
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
      assert.deepEqual(await response.json(), {
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
      assert.deepEqual(await healthy.json(), { level: 60 });

      unit.failReads = true;
      const failing = await fetch(`${baseUrl}/api/unit/level`);
      assert.equal(failing.status, 502);
    });
  });

  it('drives the unit', async () => {
    // No token, deliberately: the endpoint is open on the trusted LAN, a
    // decision that reversed a review finding — recorded in CLAUDE.md.
    await withServer({}, async ({ baseUrl, unit }) => {
      const response = await postLevel(baseUrl, JSON.stringify({ level: 50 }));

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { level: 50 });
      assert.deepEqual(unit.commands, [50]);
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

      assert.deepEqual(unit.commands, []);
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
      assert.deepEqual(await response.json(), { stored: 1, duplicates: 0, rejected: [] });

      const readBack = await fetch(`${baseUrl}/api/sensors/bedroom_netatmo/readings?kind=co2`);
      assert.deepEqual(await readBack.json(), {
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
      assert.deepEqual(await ingested.json(), { stored: 1, duplicates: 0, rejected: [] });

      // Asked for over a window written in a third zone, to make the point that
      // no part of this depends on which spelling arrived.
      const readBack = await fetch(
        `${baseUrl}/api/sensors/bedroom_netatmo/readings?kind=co2&from=2026-08-11T06:00:00-05:00`,
      );

      assert.deepEqual(await readBack.json(), {
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
});
