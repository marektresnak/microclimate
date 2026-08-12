import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createNetatmoSource } from '../src/sources/netatmo.ts';
import type { FetchLike, NetatmoOptions } from '../src/sources/netatmo.ts';
import { loadRefreshToken, saveRefreshToken } from '../src/sources/netatmo-token.ts';
import { openReadingStore } from '../src/store/readings.ts';

const NOW = Temporal.Instant.from('2026-08-11T12:00:00Z');
// Deliberately unlike NOW, so a test can tell the vendor's clock from ours.
const VENDOR_SECONDS = 1_770_000_000;

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly form: URLSearchParams | undefined;
}

interface ScriptStep {
  readonly status: number;
  readonly json: unknown;
}

/** Canned responses in order; records what was asked. Not a mock — tests
 * assert on the recorded conversation, not on call counts of a library. */
function scriptedFetch(script: ScriptStep[]): { impl: FetchLike; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];

  const impl: FetchLike = async (input, init) => {
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      authorization: new Headers(init?.headers).get('authorization'),
      form: init?.body instanceof URLSearchParams ? init.body : undefined,
    });

    const step = script.shift();
    if (step === undefined) throw new Error('the adapter made a request the script did not expect');

    return new Response(JSON.stringify(step.json), {
      status: step.status,
      headers: { 'content-type': 'application/json' },
    });
  };

  return { impl, requests };
}

function tokenGrant(refreshToken: string): ScriptStep {
  return { status: 200, json: { access_token: `access-for-${refreshToken}`, refresh_token: `rotated-${refreshToken}`, expires_in: 10_800 } };
}

function homeCoach(co2: number): ScriptStep {
  return {
    status: 200,
    json: {
      body: {
        devices: [
          {
            _id: '70:ee:50:00:00:01',
            dashboard_data: {
              time_utc: VENDOR_SECONDS,
              Temperature: 21.4,
              Humidity: 52,
              CO2: co2,
              Noise: 38,
              Pressure: 1013.2,
            },
          },
        ],
      },
    },
  };
}

function temporaryTokenPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'netatmo-')), 'token.json');
}

function options(overrides: Partial<NetatmoOptions> = {}): NetatmoOptions {
  return {
    clientId: 'client-id',
    clientSecret: 'client-secret',
    deviceId: undefined,
    sourceId: 'bedroom_netatmo',
    tokenPath: temporaryTokenPath(),
    seedRefreshToken: 'seed-token',
    log: () => undefined,
    ...overrides,
  };
}

describe('the netatmo source', () => {
  it('maps the vendor payload to readings in canonical units', async () => {
    const fake = scriptedFetch([tokenGrant('seed-token'), homeCoach(842)]);
    const source = createNetatmoSource(options(), fake.impl);

    const readings = await source.poll(NOW);

    assert.deepEqual(
      readings.map((reading) => [reading.sourceId, reading.kind, reading.value]).sort(),
      [
        ['bedroom_netatmo', 'co2', 842],
        ['bedroom_netatmo', 'humidity', 52],
        ['bedroom_netatmo', 'temperature', 21.4],
      ],
    );
  });

  it("stamps measuredAt from the vendor's clock in milliseconds, and receivedAt from ours", async () => {
    const fake = scriptedFetch([tokenGrant('seed-token'), homeCoach(842)]);
    const source = createNetatmoSource(options(), fake.impl);

    const readings = await source.poll(NOW);

    for (const reading of readings) {
      // Seconds times a thousand — off by that factor every reading dates from
      // 1970 and quietly reads as stale forever.
      assert.equal(reading.measuredAt.epochMilliseconds, VENDOR_SECONDS * 1000);
      assert.notEqual(reading.measuredAt.epochMilliseconds, NOW.epochMilliseconds);
      assert.equal(reading.receivedAt.epochMilliseconds, NOW.epochMilliseconds);
    }
  });

  it('asks with the bearer token, and names the device when configured', async () => {
    const fake = scriptedFetch([tokenGrant('seed-token'), homeCoach(842)]);
    const source = createNetatmoSource(options({ deviceId: '70:ee:50:00:00:01' }), fake.impl);

    await source.poll(NOW);

    const dataRequest = fake.requests[1];
    assert.equal(dataRequest?.authorization, 'Bearer access-for-seed-token');
    assert.match(dataRequest?.url ?? '', /gethomecoachsdata\?device_id=70%3Aee/);
  });

  it('refreshes once on a 401 and retries once', async () => {
    const fake = scriptedFetch([
      tokenGrant('seed-token'),
      homeCoach(842),
      { status: 401, json: { error: { code: 3 } } },
      tokenGrant('rotated-seed-token'),
      homeCoach(910),
    ]);
    const source = createNetatmoSource(options(), fake.impl);

    await source.poll(NOW);
    const readings = await source.poll(NOW.add({ minutes: 1 }));

    assert.equal(readings.find((reading) => reading.kind === 'co2')?.value, 910);
    // The conversation, in order: bootstrap refresh, data, expired data,
    // refresh, retried data — and nothing after.
    assert.deepEqual(
      fake.requests.map((request) => request.method),
      ['POST', 'GET', 'GET', 'POST', 'GET'],
    );
  });

  it('gives up when the retry is also refused, rather than retrying forever', async () => {
    const fake = scriptedFetch([
      tokenGrant('seed-token'),
      { status: 401, json: {} },
      tokenGrant('rotated-seed-token'),
      { status: 401, json: {} },
    ]);
    const source = createNetatmoSource(options(), fake.impl);

    await assert.rejects(source.poll(NOW), /rejected an access token it just issued/);
    // Exactly one retry: four requests, none after the second refusal.
    assert.equal(fake.requests.length, 4);
  });

  it('returns an error on a vendor 500, with nothing partial', async () => {
    const fake = scriptedFetch([tokenGrant('seed-token'), { status: 500, json: { error: 'boom' } }]);
    const source = createNetatmoSource(options(), fake.impl);

    await assert.rejects(source.poll(NOW), /Netatmo answered 500/);
  });

  it('returns an error on a payload without dashboard_data', async () => {
    const fake = scriptedFetch([
      tokenGrant('seed-token'),
      { status: 200, json: { body: { devices: [{ _id: 'x' }] } } },
    ]);
    const source = createNetatmoSource(options(), fake.impl);

    await assert.rejects(source.poll(NOW), /no dashboard_data/);
  });

  it('persists the rotated refresh token and uses it for the next refresh', async () => {
    const tokenPath = temporaryTokenPath();
    const fake = scriptedFetch([
      tokenGrant('seed-token'),
      homeCoach(842),
      { status: 401, json: {} },
      tokenGrant('rotated-seed-token'),
      homeCoach(842),
    ]);
    const source = createNetatmoSource(options({ tokenPath }), fake.impl);

    await source.poll(NOW);
    assert.equal(loadRefreshToken(tokenPath), 'rotated-seed-token');

    await source.poll(NOW.add({ minutes: 1 }));
    assert.equal(fake.requests[3]?.form?.get('refresh_token'), 'rotated-seed-token');
    assert.equal(loadRefreshToken(tokenPath), 'rotated-rotated-seed-token');
  });

  it('prefers the token file over the environment seed', async () => {
    const tokenPath = temporaryTokenPath();
    saveRefreshToken(tokenPath, 'from-the-file');
    const fake = scriptedFetch([tokenGrant('from-the-file'), homeCoach(842)]);
    const source = createNetatmoSource(options({ tokenPath }), fake.impl);

    await source.poll(NOW);

    assert.equal(fake.requests[0]?.form?.get('refresh_token'), 'from-the-file');
  });

  it('points at /auth/netatmo when there is no token anywhere', async () => {
    const fake = scriptedFetch([]);
    const source = createNetatmoSource(options({ seedRefreshToken: undefined }), fake.impl);

    await assert.rejects(source.poll(NOW), /auth\/netatmo/);
    assert.equal(fake.requests.length, 0);
  });

  it('says the refresh token is dead when Netatmo answers invalid_grant', async () => {
    const fake = scriptedFetch([{ status: 400, json: { error: 'invalid_grant' } }]);
    const source = createNetatmoSource(options(), fake.impl);

    await assert.rejects(source.poll(NOW), /re-authorise at \/auth\/netatmo/);
  });

  it('keeps polling when the rotated token cannot be persisted, and says so', async () => {
    // The directory exists but cannot be written, so loading finds no file
    // (fine) while saving the rotation fails (the case under test).
    const readOnly = mkdtempSync(join(tmpdir(), 'netatmo-'));
    chmodSync(readOnly, 0o500);
    const lines: string[] = [];
    const fake = scriptedFetch([tokenGrant('seed-token'), homeCoach(842)]);
    const source = createNetatmoSource(
      options({ tokenPath: join(readOnly, 'token.json'), log: (line) => void lines.push(line) }),
      fake.impl,
    );

    const readings = await source.poll(NOW);

    assert.equal(readings.length, 3);
    assert.match(lines.join('\n'), /could not persist the rotated Netatmo refresh token/);
  });

  it('polled twice inside the refresh window, the second poll stores nothing', async () => {
    const store = openReadingStore(':memory:');
    const fake = scriptedFetch([tokenGrant('seed-token'), homeCoach(842), homeCoach(842)]);
    const source = createNetatmoSource(options(), fake.impl);

    const first = await source.poll(NOW);
    const second = await source.poll(NOW.add({ minutes: 1 }));

    // The idempotency constraint absorbs the repeat for free — the dedup
    // design paying for itself outside the push path it was built for.
    assert.equal(store.insert(first), 3);
    assert.equal(store.insert(second), 0);

    store.close();
  });
});
