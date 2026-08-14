import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { loadRefreshToken, saveRefreshToken } from '../src/sources/refresh-token-file.ts';
import type { FetchLike } from '../src/sources/source.ts';
import { TADO_CLIENT_ID, createTadoSource } from '../src/sources/tado.ts';
import type { TadoOptions, TadoZone } from '../src/sources/tado.ts';
import { openReadingStore } from '../src/store/readings.ts';
import { assertDeepEqual } from './support/deep-equal.ts';

const NOW = Temporal.Instant.from('2026-08-14T09:00:00Z');

// Two datapoints of one zone, stamped minutes apart, both deliberately unlike
// NOW so a test can tell either vendor clock from ours. The real API stamped both
// fields of a zone with the *same* instant on 2026-08-14 — these are kept apart
// on purpose, because they are two fields and the contract is that each keeps its
// own. The millisecond fraction is Tado's own spelling.
const TEMPERATURE_AT = '2026-08-14T08:52:31.038Z';
const HUMIDITY_AT = '2026-08-14T08:47:03.533Z';

// The real account's, so the paths in these tests are the paths it answers on.
const HOME_ID = 1819708;

// The adapter is handed its zone map rather than reading config, so the tests
// hand it one too. config's own TADO_ZONES carries the real account's ids.
const ZONES: readonly TadoZone[] = [
  { zoneId: 2, sourceId: 'living_room_tado' }, // Obývák
  { zoneId: 5, sourceId: 'kids_room_tado' }, // Pokojík
  { zoneId: 1, sourceId: 'bedroom_tado' }, // Ložnice
];

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly hasBody: boolean;
}

interface ScriptStep {
  readonly status: number;
  readonly json: unknown;
}

/** Canned responses in order; records what was asked. Not a mock — the tests
 * assert on the recorded conversation, not on call counts of a library. */
function scriptedFetch(script: ScriptStep[]): { impl: FetchLike; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];

  const impl: FetchLike = async (input, init) => {
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      authorization: new Headers(init?.headers).get('authorization'),
      // Tado's auth parameters ride the query string, so what matters about the
      // body is that there isn't one. Netatmo's recorder keeps the form instead.
      hasBody: init?.body !== undefined && init.body !== null,
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
  return {
    status: 200,
    json: {
      access_token: `access-for-${refreshToken}`,
      // Single-use: the answer always carries the replacement, and the adapter
      // treats an answer without one as a lost credential.
      refresh_token: `rotated-${refreshToken}`,
      token_type: 'bearer',
      // Ten minutes, which is why refreshing is the hot path here.
      expires_in: 599,
    },
  };
}

/**
 * What Tado answers to an access token it has aged out — measured on 2026-08-14
 * by holding a real token for eleven minutes and asking again. This is the variant
 * that matters, because at ten-minute tokens it arrives every ten minutes forever.
 *
 * An absent or garbage token answers the same 401 with a different title ("Full
 * authentication is required to access this resource"), which is why the adapter
 * reads the status and not the body. Written down because the Netatmo build
 * guessed its refusal shape and stayed green while it could not refresh at all.
 */
function rejectedToken(): ScriptStep {
  return {
    status: 401,
    json: { errors: [{ code: 'unauthorized', title: 'access token is expired' }] },
  };
}

function me(): ScriptStep {
  return { status: 200, json: { homes: [{ id: HOME_ID, name: 'Domov', isAdmin: true }] } };
}

function zone(id: number, name: string, type = 'HEATING'): Record<string, unknown> {
  return {
    id,
    name,
    type,
    dateCreated: '2024-11-02T18:21:35.000Z',
    deviceTypes: ['VA02'],
    reportAvailable: true,
    supportsDazzle: true,
  };
}

function zoneList(...zones: readonly Record<string, unknown>[]): ScriptStep {
  const declared =
    zones.length > 0 ? zones : [zone(1, 'Ložnice'), zone(2, 'Obývák'), zone(5, 'Pokojík')];
  return { status: 200, json: declared };
}

/**
 * A heating zone as Tado really sends it — copied from the 2026-08-14 dump of the
 * live account, including every field the adapter drops (`fahrenheit`,
 * `precision`, `setting`, `activityDataPoints`, `link`). They are in the fixture
 * so that a change which started reading one of them would be visible here rather
 * than invisible everywhere.
 *
 * `link.state` is `ONLINE`, which is the value the first build of this adapter
 * guessed as `CONNECTED` — and then skipped every zone in the flat over. Nothing
 * reads it now; see the comment in tado.ts.
 */
function heatingZone(celsius: number, percentage: number): Record<string, unknown> {
  return {
    tadoMode: 'HOME',
    geolocationOverride: false,
    preparation: null,
    setting: { type: 'HEATING', power: 'ON', temperature: { celsius: 23.5, fahrenheit: 74.3 } },
    overlayType: null,
    overlay: null,
    openWindow: null,
    nextScheduleChange: null,
    nextTimeBlock: null,
    link: { state: 'ONLINE' },
    runningOfflineSchedule: false,
    activityDataPoints: {
      heatingPower: { type: 'PERCENTAGE', percentage: 0, timestamp: TEMPERATURE_AT },
    },
    sensorDataPoints: {
      insideTemperature: {
        celsius,
        fahrenheit: Math.round((celsius * 1.8 + 32) * 100) / 100,
        timestamp: TEMPERATURE_AT,
        type: 'TEMPERATURE',
        precision: { celsius: 0.1, fahrenheit: 0.1 },
      },
      humidity: { type: 'PERCENTAGE', percentage, timestamp: HUMIDITY_AT },
    },
  };
}

function zoneStates(states: Record<string, unknown>): ScriptStep {
  return { status: 200, json: { zoneStates: states } };
}

/** The three rooms, all healthy — the payload most tests do not care about. */
function everyZoneHealthy(): ScriptStep {
  return zoneStates({
    '2': heatingZone(20.4, 48), // Obývák, the living room
    '5': heatingZone(21.9, 51), // Pokojík, the kids' room
    '1': heatingZone(19.2, 55), // Ložnice, the bedroom
  });
}

function temporaryTokenPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'tado-')), 'token.json');
}

/** Tado has no environment seed — a single-use token pasted into .env would be
 * spent by the first refresh — so an authorised adapter means a token file. */
function authorisedTokenPath(refreshToken = 'first-token'): string {
  const path = temporaryTokenPath();
  saveRefreshToken(path, refreshToken);
  return path;
}

function options(overrides: Partial<TadoOptions> = {}): TadoOptions {
  return {
    settings: { tokenPath: authorisedTokenPath() },
    zones: ZONES,
    log: () => undefined,
    ...overrides,
  };
}

function pathsOf(requests: readonly RecordedRequest[]): string[] {
  return requests.map((request) => `${request.method} ${new URL(request.url).pathname}`);
}

describe('the tado source', () => {
  it('maps a zone-states payload to readings in canonical units', async () => {
    const fake = scriptedFetch([tokenGrant('first-token'), me(), zoneList(), everyZoneHealthy()]);
    const source = createTadoSource(options(), fake.impl);

    const readings = await source.poll(NOW);

    // °C and %RH are already canonical, so nothing converts — and each zone's
    // readings are filed under the sourceId config maps that zone to.
    assertDeepEqual(
      readings.map((reading) => [reading.sourceId, reading.kind, reading.value]),
      [
        ['living_room_tado', 'temperature', 20.4],
        ['living_room_tado', 'humidity', 48],
        ['kids_room_tado', 'temperature', 21.9],
        ['kids_room_tado', 'humidity', 51],
        ['bedroom_tado', 'temperature', 19.2],
        ['bedroom_tado', 'humidity', 55],
      ],
    );
  });

  it("keeps each datapoint's own timestamp, and stamps receivedAt from our clock", async () => {
    const fake = scriptedFetch([
      tokenGrant('first-token'),
      me(),
      zoneList(),
      zoneStates({ '2': heatingZone(21.9, 51) }),
    ]);
    const source = createTadoSource(options(), fake.impl);

    const readings = await source.poll(NOW);

    // Each field keeps the stamp it arrived with; only when we heard about them is
    // shared, and that is our clock. The live API stamped both fields of a zone
    // with one instant, but they are two fields and this is the contract.
    assertDeepEqual(
      readings.map((reading) => [reading.kind, reading.measuredAt, reading.receivedAt]),
      [
        ['temperature', Temporal.Instant.from(TEMPERATURE_AT), NOW],
        ['humidity', Temporal.Instant.from(HUMIDITY_AT), NOW],
      ],
    );
  });

  it('discovers the home and its zones once, then asks only for zone states', async () => {
    const fake = scriptedFetch([
      tokenGrant('first-token'),
      me(),
      zoneList(),
      everyZoneHealthy(),
      everyZoneHealthy(),
    ]);
    const source = createTadoSource(options(), fake.impl);

    await source.poll(NOW);
    await source.poll(NOW.add({ minutes: 1 }));

    // Discovery is three requests once; steady state is one request a minute,
    // for every room at once.
    assertDeepEqual(pathsOf(fake.requests), [
      'POST /oauth2/token',
      'GET /api/v2/me',
      `GET /api/v2/homes/${HOME_ID}/zones`,
      `GET /api/v2/homes/${HOME_ID}/zoneStates`,
      `GET /api/v2/homes/${HOME_ID}/zoneStates`,
    ]);
  });

  it('sends the refresh grant as query parameters on a POST with no body', async () => {
    const fake = scriptedFetch([tokenGrant('first-token'), me(), zoneList(), everyZoneHealthy()]);
    const source = createTadoSource(options(), fake.impl);

    await source.poll(NOW);

    // This looks like a mistake and is not: Tado's token endpoint reads its
    // parameters off the query string, and the request carries no body at all.
    const refresh = fake.requests[0];
    assert.equal(refresh?.method, 'POST');
    assert.equal(refresh?.hasBody, false);

    const sent = new URL(refresh?.url ?? '').searchParams;
    assert.equal(sent.get('grant_type'), 'refresh_token');
    assert.equal(sent.get('refresh_token'), 'first-token');
    assert.equal(sent.get('client_id'), TADO_CLIENT_ID);
  });

  it('carries the bearer token on every data request, and only there', async () => {
    const fake = scriptedFetch([tokenGrant('first-token'), me(), zoneList(), everyZoneHealthy()]);
    const source = createTadoSource(options(), fake.impl);

    await source.poll(NOW);

    assertDeepEqual(
      fake.requests.map((request) => request.authorization),
      [
        // The token request authenticates with the refresh token itself.
        null,
        'Bearer access-for-first-token',
        'Bearer access-for-first-token',
        'Bearer access-for-first-token',
      ],
    );
  });

  it('refreshes once on a 401 and retries the same request', async () => {
    const fake = scriptedFetch([
      tokenGrant('first-token'),
      me(),
      zoneList(),
      zoneStates({ '2': heatingZone(21.9, 51) }),
      rejectedToken(),
      tokenGrant('rotated-first-token'),
      zoneStates({ '2': heatingZone(22.4, 51) }),
    ]);
    const source = createTadoSource(options(), fake.impl);

    await source.poll(NOW);
    const readings = await source.poll(NOW.add({ minutes: 1 }));

    assert.equal(readings.find((reading) => reading.kind === 'temperature')?.value, 22.4);
    // The conversation, in order: the bootstrap refresh, discovery, the first
    // poll, the refused poll, one refresh, the retried poll — and nothing after.
    assertDeepEqual(pathsOf(fake.requests), [
      'POST /oauth2/token',
      'GET /api/v2/me',
      `GET /api/v2/homes/${HOME_ID}/zones`,
      `GET /api/v2/homes/${HOME_ID}/zoneStates`,
      `GET /api/v2/homes/${HOME_ID}/zoneStates`,
      'POST /oauth2/token',
      `GET /api/v2/homes/${HOME_ID}/zoneStates`,
    ]);
  });

  it('gives up when the retry is also refused, rather than spending tokens in a loop', async () => {
    const fake = scriptedFetch([
      tokenGrant('first-token'),
      rejectedToken(),
      tokenGrant('rotated-first-token'),
      rejectedToken(),
    ]);
    const source = createTadoSource(options(), fake.impl);

    await assert.rejects(source.poll(NOW), /rejected an access token it just issued/);
    // Exactly one retry: four requests, none after the second refusal.
    assert.equal(fake.requests.length, 4);
  });

  it('persists the rotated refresh token and sends it at the next refresh', async () => {
    const tokenPath = authorisedTokenPath('first-token');
    const fake = scriptedFetch([
      tokenGrant('first-token'),
      me(),
      zoneList(),
      everyZoneHealthy(),
      rejectedToken(),
      tokenGrant('rotated-first-token'),
      everyZoneHealthy(),
    ]);
    const source = createTadoSource(options({ settings: { tokenPath } }), fake.impl);

    await source.poll(NOW);
    // Persisted before the access token it came with was used — which with
    // single-use rotation is the difference between losing a poll and losing the
    // credential.
    assert.equal(loadRefreshToken(tokenPath), 'rotated-first-token');

    await source.poll(NOW.add({ minutes: 1 }));

    assert.equal(
      new URL(fake.requests[5]?.url ?? '').searchParams.get('refresh_token'),
      'rotated-first-token',
    );
    assert.equal(loadRefreshToken(tokenPath), 'rotated-rotated-first-token');
  });

  it('points at /auth/tado when there is no token file, without asking Tado anything', async () => {
    const fake = scriptedFetch([]);
    const source = createTadoSource(
      options({ settings: { tokenPath: temporaryTokenPath() } }),
      fake.impl,
    );

    await assert.rejects(source.poll(NOW), /authorise once at \/auth\/tado/);
    assert.equal(fake.requests.length, 0);
  });

  it('shouts when a refresh answer carries no replacement token', async () => {
    // Netatmo's refresh_token is optional; Tado's is not. The token we just sent
    // is revoked either way, so an answer without a replacement has locked us
    // out and the log has to say so rather than report a parse problem.
    const fake = scriptedFetch([{ status: 200, json: { access_token: 'access-1', expires_in: 599 } }]);
    const source = createTadoSource(options(), fake.impl);

    await assert.rejects(source.poll(NOW), /single-use and is now spent/);
  });

  it('says the refresh token is dead when Tado answers invalid_grant', async () => {
    const fake = scriptedFetch([
      { status: 400, json: { error: 'invalid_grant', error_description: 'Invalid refresh token' } },
    ]);
    const source = createTadoSource(options(), fake.impl);

    await assert.rejects(source.poll(NOW), /re-authorise at \/auth\/tado/);
  });

  it('keeps polling when the rotated token cannot be persisted, and says so', async () => {
    // The directory exists but cannot be written, so loading finds no file and
    // the seed... does not exist for Tado. So the file is written first, then
    // the directory is closed: loading works, saving the rotation does not.
    const readOnly = mkdtempSync(join(tmpdir(), 'tado-'));
    const tokenPath = join(readOnly, 'token.json');
    saveRefreshToken(tokenPath, 'first-token');
    chmodSync(readOnly, 0o500);

    const lines: string[] = [];
    const fake = scriptedFetch([tokenGrant('first-token'), me(), zoneList(), everyZoneHealthy()]);
    const source = createTadoSource(
      options({ settings: { tokenPath }, log: (line) => void lines.push(line) }),
      fake.impl,
    );

    const readings = await source.poll(NOW);

    assert.equal(readings.length, 6);
    assert.match(lines.join('\n'), /could not persist the rotated Tado refresh token/);
  });

  it('reads a zone whatever its link state says, or does not say', async () => {
    // The freshness judgement is made on the timestamp Tado stamped the reading
    // with, and nowhere else. `link.state` is the vendor's separate opinion about
    // reachability — a second switch for one question — and reading it would mean
    // knowing its whole vocabulary. The first build guessed `CONNECTED`, the real
    // value is `ONLINE`, and the guess silently dropped every reading in the flat.
    // So: whatever it says, a well-formed datapoint is a reading.
    const linkStates: readonly (Record<string, unknown> | undefined)[] = [
      { state: 'ONLINE' },
      { state: 'DISCONNECTED' },
      { state: 'A_WORD_TADO_HAS_NOT_INVENTED_YET' },
      undefined,
    ];

    for (const link of linkStates) {
      const zoneState = { ...heatingZone(21.9, 51), link };
      const fake = scriptedFetch([
        tokenGrant('first-token'),
        me(),
        zoneList(),
        zoneStates({ '2': zoneState }),
      ]);
      const source = createTadoSource(options(), fake.impl);

      const readings = await source.poll(NOW);

      assertDeepEqual(
        readings.map((reading) => [reading.kind, reading.value]),
        [
          ['temperature', 21.9],
          ['humidity', 51],
        ],
        `link ${JSON.stringify(link)}`,
      );
    }
  });

  it('lets a zone say nothing, silently, and keeps the other zones', async () => {
    // Three ways one zone can have nothing to say. None is a fault in the payload,
    // so the other rooms' readings land — and none of them is logged either: the
    // honest report of the gap is /api/state turning that room stale against its
    // own window, and a line per skipped zone per poll would be 1,440 a day for
    // one flat battery. (The one skip that is our own mistake — a zone id the
    // account does not have — is logged once at discovery, two tests down.)
    const cases: readonly [string, Record<string, unknown> | undefined][] = [
      ['a zone that measures nothing', { link: { state: 'ONLINE' } }],
      ['a zone whose sensors are empty', { link: { state: 'ONLINE' }, sensorDataPoints: {} }],
      ['a zone missing from the answer', undefined],
    ];

    for (const [name, state] of cases) {
      const states: Record<string, unknown> = { '2': heatingZone(20.4, 48), '1': heatingZone(19.2, 55) };
      if (state !== undefined) states['5'] = state;

      const lines: string[] = [];
      const fake = scriptedFetch([tokenGrant('first-token'), me(), zoneList(), zoneStates(states)]);
      const source = createTadoSource(
        options({ log: (line) => void lines.push(line) }),
        fake.impl,
      );

      const readings = await source.poll(NOW);

      assertDeepEqual(
        readings.map((reading) => reading.sourceId),
        ['living_room_tado', 'living_room_tado', 'bedroom_tado', 'bedroom_tado'],
        name,
      );
      assertDeepEqual(lines, [], name);
    }
  });

  it('names every zone the account offers when a configured one is not there', async () => {
    const lines: string[] = [];
    const fake = scriptedFetch([
      tokenGrant('first-token'),
      me(),
      zoneList(zone(2, 'Obývák'), zone(5, 'Pokojík'), zone(7, 'Ložnice')),
      zoneStates({ '2': heatingZone(20.4, 48), '5': heatingZone(21.9, 51), '7': heatingZone(19.2, 55) }),
    ]);
    const source = createTadoSource(options({ log: (line) => void lines.push(line) }), fake.impl);

    const readings = await source.poll(NOW);

    // The bedroom moved to zone 7 in the account. Fixing TADO_ZONES is then
    // copy-paste from this line, and the two zones that do match keep polling.
    assert.match(
      lines.join('\n'),
      /Tado has no zone 1, which TADO_ZONES maps to bedroom_tado — the account offers 2 Obývák \(HEATING\), 5 Pokojík \(HEATING\), 7 Ložnice \(HEATING\)/,
    );
    assertDeepEqual(
      readings.map((reading) => reading.sourceId),
      ['living_room_tado', 'living_room_tado', 'kids_room_tado', 'kids_room_tado'],
    );
  });

  it('names an unmapped heating zone, and says nothing about hot water', async () => {
    const lines: string[] = [];
    const fake = scriptedFetch([
      tokenGrant('first-token'),
      me(),
      zoneList(
        zone(1, 'Ložnice'),
        zone(2, 'Obývák'),
        zone(5, 'Pokojík'),
        zone(4, 'Koupelna'),
        zone(0, 'Hot water', 'HOT_WATER'),
      ),
      everyZoneHealthy(),
    ]);
    const source = createTadoSource(options({ log: (line) => void lines.push(line) }), fake.impl);

    await source.poll(NOW);

    // A radiator nobody mapped is readings being thrown away, so it gets a line.
    assert.match(lines.join('\n'), /Tado zone 4 \(Koupelna\) is in no TADO_ZONES entry/);
    // Hot water measures nothing this project has a vocabulary for, so warning
    // about it would be noise on every start-up forever.
    assert.ok(!lines.join('\n').includes('Hot water'), lines.join('\n'));
  });

  it('rejects the whole poll when a datapoint that is present is malformed', async () => {
    // Nothing partial: a payload we cannot read might mean we are misreading the
    // API, and storing the zones that happened to parse would mask that.
    const cases: readonly [Record<string, unknown>, RegExp][] = [
      [
        { celsius: '21.9', timestamp: TEMPERATURE_AT },
        /kids_room_tado\) has an insideTemperature with no numeric celsius/,
      ],
      [
        { celsius: 21.9, timestamp: 'a moment ago' },
        /kids_room_tado\) stamped its insideTemperature with something that is not an ISO 8601 instant/,
      ],
      [{ celsius: 21.9 }, /stamped its insideTemperature with something that is not an ISO 8601 instant/],
    ];

    for (const [insideTemperature, expected] of cases) {
      const fake = scriptedFetch([
        tokenGrant('first-token'),
        me(),
        zoneList(),
        zoneStates({
          '2': heatingZone(20.4, 48),
          '5': { link: { state: 'ONLINE' }, sensorDataPoints: { insideTemperature } },
          '1': heatingZone(19.2, 55),
        }),
      ]);
      const source = createTadoSource(options(), fake.impl);

      await assert.rejects(source.poll(NOW), expected);
    }
  });

  it('rejects a zone-states answer that is not the shape it expects', async () => {
    const fake = scriptedFetch([
      tokenGrant('first-token'),
      me(),
      zoneList(),
      { status: 200, json: [{ id: 1 }] },
    ]);
    const source = createTadoSource(options(), fake.impl);

    await assert.rejects(source.poll(NOW), /answered without zoneStates/);
  });

  it('refuses a list of zone states rather than reading it off by one', async () => {
    // The bulk endpoint's shape is the one thing here not yet spoken to the real
    // API, and a list is the plausible way it could differ. It has to be refused
    // rather than indexed: `states['1']` on a list is its SECOND element, so
    // every zone's readings would land under the neighbouring instrument's name
    // — wrong, permanent, and completely silent.
    const fake = scriptedFetch([
      tokenGrant('first-token'),
      me(),
      zoneList(),
      { status: 200, json: { zoneStates: [heatingZone(20.4, 48), heatingZone(21.9, 51)] } },
    ]);
    const source = createTadoSource(options(), fake.impl);

    await assert.rejects(source.poll(NOW), /not an object keyed by zone id/);
  });

  it('refuses to guess which home to read', async () => {
    // One home is an assumption, so it is an assumption that fails loudly: two
    // homes means half these readings would belong to another flat.
    const two = scriptedFetch([
      tokenGrant('first-token'),
      { status: 200, json: { homes: [{ id: HOME_ID, name: 'Domov' }, { id: 5, name: 'Chata' }] } },
    ]);
    await assert.rejects(
      createTadoSource(options(), two.impl).poll(NOW),
      /expected exactly one Tado home, found 2: 1819708 Domov, 5 Chata/,
    );

    const none = scriptedFetch([tokenGrant('first-token'), { status: 200, json: { homes: [] } }]);
    await assert.rejects(
      createTadoSource(options(), none.impl).poll(NOW),
      /expected exactly one Tado home, found 0/,
    );
  });

  it('reports a vendor 500 as itself, with nothing partial', async () => {
    const fake = scriptedFetch([
      tokenGrant('first-token'),
      me(),
      zoneList(),
      { status: 500, json: { errors: [{ code: 'internalError' }] } },
    ]);
    const source = createTadoSource(options(), fake.impl);

    await assert.rejects(source.poll(NOW), /Tado answered 500 for \/homes\/1819708\/zoneStates/);
  });

  it('polled twice inside the heartbeat, the second poll stores nothing', async () => {
    // Tado publishes on a 20-minute heartbeat unless a reading crosses a
    // threshold, so most of a minute's polling is the same value with the same
    // timestamp — and the uniqueness constraint absorbs it for free, exactly as
    // it does for Netatmo's refresh window.
    const store = openReadingStore(':memory:');
    const fake = scriptedFetch([
      tokenGrant('first-token'),
      me(),
      zoneList(),
      zoneStates({ '2': heatingZone(21.9, 51) }),
      zoneStates({ '2': heatingZone(21.9, 51) }),
    ]);
    const source = createTadoSource(options(), fake.impl);

    const first = await source.poll(NOW);
    const second = await source.poll(NOW.add({ minutes: 1 }));

    assert.equal(store.insert(first), 2);
    assert.equal(store.insert(second), 0);

    store.close();
  });
});
