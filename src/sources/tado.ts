import type { SensorId } from '../config.ts';
import { messageOf } from '../domain/errors.ts';
import type { Reading } from '../domain/measurement.ts';
import { parseInstant } from '../domain/time.ts';
import { loadRefreshToken, saveRefreshToken } from './refresh-token-file.ts';
import type { FetchLike, SensorSource } from './source.ts';

/**
 * The Tado valves, over their cloud API.
 *
 * Pull adapter: the RFC 8628 device flow holds the credential (obtained once
 * through /auth/tado — see http/tado-auth.ts), and every poll is one bulk read
 * of the home's zone states. The endpoints and the auth are the ones proven by
 * the owner's tado-monitor client, which polls this same account today — not
 * taken from documentation. Tado removed the old password grant in March 2025,
 * so the device flow is not one option among several; it is what is left.
 *
 * We read and never write. Heating stays entirely with Tado.
 *
 * `fetchImpl` is the seam, exactly as in netatmo.ts and as `OpenStream` is in
 * the Modbus client: everything above it is protocol logic tested against canned
 * responses, and only main.ts ever passes the real `fetch`.
 */

// Exported because /auth/tado swaps its device code against the same endpoint.
// One URL, one place.
export const TADO_TOKEN_URL = 'https://login.tado.com/oauth2/token';

// Public by design and not a credential: Tado's device flow has no client
// secret, and this id is the one their own clients use. Hardcoded for the same
// reason the Modbus register number is — it describes the vendor, not this
// deployment, and an environment variable would only invite it to be wrong.
export const TADO_CLIENT_ID = '1bb50063-6b0c-4d11-bd99-387f4a91cc46';

const API_URL = 'https://my.tado.com/api/v2';

// A stalled vendor must not stall the collector's whole tick — the same bound
// and the same reason as the Netatmo adapter's.
const REQUEST_TIMEOUT = Temporal.Duration.from({ seconds: 10 });

// How Tado says a bearer token is no good: a plain 401. All three variants were
// measured against the live API on 2026-08-14 —
//
//   absent or garbage token: {"errors":[{"code":"unauthorized",
//                             "title":"Full authentication is required to access this resource"}]}
//   token held past its 10 minutes: {"errors":[{"code":"unauthorized",
//                             "title":"access token is expired"}]}
//
// — which is why the status alone decides and no body is read: every variant
// means the same thing and a fresh token is the only fix. The one that matters is
// the third, because it arrives every ten minutes forever; it was captured by
// holding a token for eleven and asking again. A permission refusal rides 403 and
// is reported as itself.
//
// Measured rather than assumed on purpose. The Netatmo adapter inferred its
// refusal shape from how OAuth APIs usually behave, its test pinned the guess,
// and the suite stayed green while the refresh path could not fire against the
// real API at all.
const REJECTED_TOKEN_STATUS = 401;

// A valve measures every minute, but the published value only moves when a
// reading crosses a threshold — around 0.5 °C or 5 %RH — or when the 20-minute
// heartbeat comes round regardless. So most polls ask for a value we already
// have, which the store's uniqueness constraint absorbs for free, and in
// exchange a threshold crossing is seen within a minute of Tado publishing it.
const POLL_INTERVAL = Temporal.Duration.from({ minutes: 1 });

/**
 * Tado's identity here, which is only where its token lives: the device flow has
 * no client secret and the client id above is public. Built once in main.ts and
 * handed whole to both consumers — this adapter and the /auth/tado onboarding
 * route — so the two cannot disagree about which file holds the credential. An
 * onboarding that saved the token where the poller does not read would be a
 * lockout wearing a success page.
 *
 * Its presence is also Tado's on-switch: with no TADO_TOKEN_PATH set there is
 * nothing to poll and nothing to authorise. See main.ts.
 */
export interface TadoSettings {
  readonly tokenPath: string;
}

/** Which Tado zone answers for which instrument in config. */
export interface TadoZone {
  readonly zoneId: number;
  readonly sourceId: SensorId;
}

export interface TadoOptions {
  /** The identity shared with the onboarding route — see TadoSettings. */
  readonly settings: TadoSettings;
  /** TADO_ZONES, from config by way of main.ts. Topology is config's business;
   * this adapter is handed the answer rather than deciding it. */
  readonly zones: readonly TadoZone[];
  readonly log: (line: string) => void;
}

export function createTadoSource(options: TadoOptions, fetchImpl: FetchLike = fetch): SensorSource {
  // Access tokens live ten minutes, so refreshing is the hot path here — every
  // tenth poll or so, where the Netatmo adapter refreshes every few hours.
  // Expiry is still discovered from the refusal rather than tracked against a
  // clock: that path has to exist anyway, and a timer doing the same job would
  // be a second mechanism to keep in agreement with it.
  let accessToken: string | undefined;

  // The home id and the zone list only change when someone rearranges the
  // flat's Tado setup, which is a config edit and a restart. So they are
  // discovered once per process and every later poll is a single request.
  let homeId: number | undefined;

  const fetchWithToken = (path: string, token: string): Promise<Response> =>
    fetchImpl(`${API_URL}${path}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT.total('milliseconds')),
    });

  const refreshAccessToken = async (): Promise<string> => {
    // Read the file on every refresh rather than once at start-up, so an
    // authorisation through /auth/tado takes effect at the next refresh without
    // a restart. There is no environment seed to fall back to, deliberately:
    // Tado's refresh tokens are single-use, so one pasted into .env would be
    // spent by the first refresh and a lie from then on.
    const refreshToken = loadRefreshToken(options.settings.tokenPath);
    if (refreshToken === undefined) {
      throw new Error('no Tado refresh token — authorise once at /auth/tado');
    }

    // Tado takes these as a query string on a POST with no body at all. It
    // looks like a mistake and is not: it is what the working client against
    // this account does, and it is what their device flow documents.
    const url = new URL(TADO_TOKEN_URL);
    url.searchParams.set('client_id', TADO_CLIENT_ID);
    url.searchParams.set('grant_type', 'refresh_token');
    url.searchParams.set('refresh_token', refreshToken);

    const response = await fetchImpl(url, {
      method: 'POST',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT.total('milliseconds')),
    });

    if (!response.ok) {
      const body = await response.text();
      const hint = body.includes('invalid_grant')
        ? ' — the refresh token is dead, re-authorise at /auth/tado'
        : '';
      throw new Error(`Tado token refresh failed (${response.status}): ${body}${hint}`);
    }

    const payload: unknown = await response.json();
    const tokens = tokenResponseOf(payload);

    // Tado rotates the refresh token on every refresh and revokes the old one
    // the moment the new one is issued, so the new one is persisted BEFORE the
    // access token is used: a crash in between must cost a poll, not the
    // credential. If the disk write fails we carry on with the token in memory —
    // degraded now beats dead now — and say so, because with the file behind
    // reality the next restart needs authorising by hand.
    try {
      saveRefreshToken(options.settings.tokenPath, tokens.refreshToken);
    } catch (error) {
      options.log(
        `could not persist the rotated Tado refresh token: ${messageOf(error)} — ` +
          'polling continues, but the next restart will need /auth/tado again',
      );
    }

    accessToken = tokens.accessToken;
    return tokens.accessToken;
  };

  /** One authenticated GET, with the token dance around it. */
  const get = async (path: string): Promise<unknown> => {
    const first = await fetchWithToken(path, accessToken ?? (await refreshAccessToken()));
    if (first.status !== REJECTED_TOKEN_STATUS) return payloadOf(first, path);

    // Refresh and retry exactly once. A second refusal means Tado is rejecting
    // a token it issued seconds ago, and asking a third time will not change
    // its mind — it would just spend refresh tokens in a loop.
    const retried = await fetchWithToken(path, await refreshAccessToken());
    if (retried.status === REJECTED_TOKEN_STATUS) {
      throw new Error(`Tado rejected an access token it just issued, asking for ${path}`);
    }

    return payloadOf(retried, path);
  };

  /**
   * Config is the truth about which zone answers for which instrument, so this
   * adjusts nothing — it says, once, where config and the account disagree. Both
   * directions are worth a line: a zone id that has moved makes an instrument
   * silent, and a heating zone nobody mapped is a radiator whose readings are
   * being thrown away. A hot-water zone is neither, and gets no line.
   */
  const reconcileZones = (zones: readonly DiscoveredZone[]): void => {
    const offered = zones.map((zone) => `${zone.id} ${zone.name} (${zone.type})`).join(', ');

    for (const configured of options.zones) {
      if (zones.some((zone) => zone.id === configured.zoneId)) continue;
      options.log(
        `Tado has no zone ${configured.zoneId}, which TADO_ZONES maps to ${configured.sourceId} — ` +
          `the account offers ${offered}`,
      );
    }

    for (const zone of zones) {
      if (zone.type !== 'HEATING') continue;
      if (options.zones.some((configured) => configured.zoneId === zone.id)) continue;
      options.log(
        `Tado zone ${zone.id} (${zone.name}) is in no TADO_ZONES entry — its readings are not collected`,
      );
    }
  };

  const discoveredHomeId = async (): Promise<number> => {
    if (homeId !== undefined) return homeId;

    const found = homeIdOf(await get('/me'));
    reconcileZones(zonesOf(await get(`/homes/${found}/zones`)));

    // Only cached once both calls have succeeded, so a half-finished discovery
    // is retried whole at the next poll rather than remembered.
    homeId = found;
    return found;
  };

  return {
    name: 'tado',
    pollInterval: POLL_INTERVAL,

    async poll(now) {
      const home = await discoveredHomeId();
      const states = zoneStatesOf(await get(`/homes/${home}/zoneStates`));

      const readings: Reading[] = [];
      for (const zone of options.zones) {
        readings.push(...zoneReadingsOf(states[String(zone.zoneId)], zone, now));
      }

      return readings;
    },
  };
}

/**
 * One zone's contribution to a poll — which is allowed to be nothing.
 *
 * That empty array is the whole of how a multi-zone answer degrades, and it is
 * **silent on purpose**. What the vendor *declares* absent — a zone missing from
 * the answer, a valve that is not connected, a zone with no sensors — costs that
 * zone its readings and nothing else; the other zones land, and the honest report
 * of the gap is `/api/state` turning that room stale against its own freshness
 * window, which is exactly what the window is for. A line per skipped zone per
 * poll would be 1,440 a day for one flat battery, and it would say nothing the
 * state endpoint does not already say better. The one skip that is *our* mistake
 * rather than the vendor's — a zone id that is not in the account — is logged
 * once at discovery, with the whole zone list beside it.
 *
 * What fails to narrow throws the poll away instead, because a payload we cannot
 * read might mean we are misreading the API, and storing the zones that happened
 * to parse would mask that.
 */
function zoneReadingsOf(
  state: unknown,
  zone: TadoZone,
  receivedAt: Temporal.Instant,
): readonly Reading[] {
  const where = `Tado zone ${zone.zoneId} (${zone.sourceId})`;

  // Not in the answer at all: either the id is wrong (said once at discovery) or
  // Tado left it out of this one.
  if (state === undefined) return [];
  if (state === null || typeof state !== 'object') {
    throw new Error(`${where} has a state that is not an object`);
  }

  // `link.state` is deliberately NOT read, and this is a measured decision
  // rather than an omission. It is the vendor's own opinion about whether the
  // valve is reachable — a second freshness mechanism beside the one this project
  // already has, and the weaker of the two: every datapoint carries the instant
  // Tado stamped it, and a valve that has stopped reporting keeps re-publishing
  // that same ageing instant until the per-source window calls the room stale.
  //
  // Reading the field as well would mean knowing its whole vocabulary, and the
  // first guess at it — `CONNECTED` — was wrong. The real answer is `ONLINE`,
  // measured on 2026-08-14, and the wrong guess silently dropped every reading in
  // the flat until the payload was dumped and looked at. Two switches answering
  // one question is one too many; this is the same argument that took `isActive`
  // out of precedence.ts.
  const sensors = 'sensorDataPoints' in state ? state.sensorDataPoints : undefined;
  // A zone that measures nothing — hot water is the one in this account.
  if (sensors === undefined || sensors === null) return [];
  if (typeof sensors !== 'object') {
    throw new Error(`${where} has sensorDataPoints that are not an object`);
  }

  // Each datapoint keeps the timestamp it arrived with. In the answer measured on
  // 2026-08-14 all three zones stamped temperature and humidity with the same
  // instant, so this is not two clocks in practice today — but they are two
  // fields, and letting one speak for the other would be inventing a rule the
  // payload does not state. Between zones the stamps genuinely differ (07:41,
  // 07:46 and 07:52 in one answer), which is what the freshness window is sized
  // for. °C and %RH are already the canonical units, so no value converts.
  //
  // A re-publication is not a duplicate: when a zone speaks again its datapoints
  // carry a new timestamp, so the row is genuinely new even if the value barely
  // moved. And because each zone keeps its own schedule, the normal collector line
  // for this source is a partial one — "6 readings, 2 new" was the second real
  // poll, one zone having re-published while the other two repeated themselves and
  // were absorbed by the uniqueness constraint. Netatmo, one device on one
  // schedule, reads "3 readings, 0 new" instead. Both are the dedup working.
  const readings: Reading[] = [];

  if ('insideTemperature' in sensors) {
    const point = temperaturePointOf(sensors.insideTemperature, where);
    readings.push({
      sourceId: zone.sourceId,
      kind: 'temperature',
      value: point.value,
      measuredAt: point.measuredAt,
      receivedAt,
    });
  }

  if ('humidity' in sensors) {
    const point = humidityPointOf(sensors.humidity, where);
    readings.push({
      sourceId: zone.sourceId,
      kind: 'humidity',
      value: point.value,
      measuredAt: point.measuredAt,
      receivedAt,
    });
  }

  return readings;
}

async function payloadOf(response: Response, path: string): Promise<unknown> {
  if (!response.ok) {
    throw new Error(`Tado answered ${response.status} for ${path}: ${await response.text()}`);
  }

  return response.json();
}

/** Everything below is narrowing, in the store's toReading style: each check
 * rejects one way the payload could be wrong, and names it. */

/**
 * Tado's token answer. Unlike Netatmo's, `refresh_token` is required rather than
 * optional: Tado's rotation revokes the token we sent the instant the new one is
 * issued, so an answer without a replacement means the credential is gone and
 * nothing took its place. That is a lockout to shout about, not a field to
 * shrug at.
 *
 * Exported because /auth/tado reads the same answer, from the device-code grant
 * — one narrowing so the two halves cannot disagree about what a Tado grant is.
 */
export function tokenResponseOf(payload: unknown): {
  accessToken: string;
  refreshToken: string;
} {
  if (payload === null || typeof payload !== 'object') {
    throw new Error('Tado token response is not an object');
  }
  if (!('access_token' in payload) || typeof payload.access_token !== 'string') {
    throw new Error('Tado token response has no access_token');
  }
  if (!('refresh_token' in payload) || typeof payload.refresh_token !== 'string') {
    throw new Error(
      'Tado token response has no refresh_token — the one we sent was single-use and is now ' +
        'spent, so re-authorise at /auth/tado',
    );
  }

  return { accessToken: payload.access_token, refreshToken: payload.refresh_token };
}

/**
 * The account's one home. Several would mean this flat is one of two homes'
 * worth of readings and the wiring has to say which — an assumption, so it fails
 * loudly rather than quietly taking the first.
 */
function homeIdOf(payload: unknown): number {
  if (payload === null || typeof payload !== 'object' || !('homes' in payload) || !Array.isArray(payload.homes)) {
    throw new Error('Tado answered /me without a homes list');
  }

  const entries: readonly unknown[] = payload.homes;
  const homes = entries.map(homeOf);
  const only = homes[0];
  if (homes.length !== 1 || only === undefined) {
    const found = homes.map((home) => `${home.id} ${home.name}`).join(', ');
    throw new Error(`expected exactly one Tado home, found ${homes.length}${found === '' ? '' : `: ${found}`}`);
  }

  return only.id;
}

function homeOf(payload: unknown): { id: number; name: string } {
  if (payload === null || typeof payload !== 'object') {
    throw new Error('a Tado home is not an object');
  }
  if (!('id' in payload) || typeof payload.id !== 'number') {
    throw new Error('a Tado home has no numeric id');
  }
  if (!('name' in payload) || typeof payload.name !== 'string') {
    throw new Error('a Tado home has no name');
  }

  return { id: payload.id, name: payload.name };
}

/** What the zone list says about one zone — enough to reconcile it against
 * config and to name it in a log line an operator can act on. */
interface DiscoveredZone {
  readonly id: number;
  readonly name: string;
  /** `HEATING`, `HOT_WATER`. Read only to decide whether an unmapped zone is
   * worth a warning: a radiator nobody mapped is, hot water is not. */
  readonly type: string;
}

function zonesOf(payload: unknown): readonly DiscoveredZone[] {
  if (!Array.isArray(payload)) {
    throw new Error('Tado answered the zone list with something that is not an array');
  }

  const entries: readonly unknown[] = payload;
  return entries.map(zoneOf);
}

function zoneOf(payload: unknown): DiscoveredZone {
  if (payload === null || typeof payload !== 'object') {
    throw new Error('a Tado zone is not an object');
  }
  if (!('id' in payload) || typeof payload.id !== 'number') {
    throw new Error('a Tado zone has no numeric id');
  }
  if (!('name' in payload) || typeof payload.name !== 'string') {
    throw new Error('a Tado zone has no name');
  }
  if (!('type' in payload) || typeof payload.type !== 'string') {
    throw new Error(`Tado zone ${payload.id} has no type`);
  }

  return { id: payload.id, name: payload.name, type: payload.type };
}

/**
 * The bulk endpoint's envelope: `{ zoneStates: { "1": {…}, "2": {…} } }`, keyed
 * by zone id written as a string.
 *
 * This is the one shape here that has not been spoken to the real API — the
 * reference client reads each zone on its own. If it turns out to differ, the
 * fallback is one verified `GET /homes/{id}/zones/{zoneId}/state` per zone,
 * which costs a request per room and changes nothing else.
 */
function zoneStatesOf(payload: unknown): Record<string, unknown> {
  if (payload === null || typeof payload !== 'object' || !('zoneStates' in payload)) {
    throw new Error('Tado answered without zoneStates');
  }

  const states = payload.zoneStates;
  // An array is refused louder than a wrong shape would be, because it would
  // half-work: `states['1']` on a list is its *second* element, so a list of
  // zone states would quietly file each zone's readings under the neighbouring
  // instrument's name — the one mistake in this project that is both tempting
  // and irreversible.
  if (Array.isArray(states) || !isKeyedObject(states)) {
    throw new Error('Tado answered with zoneStates that are not an object keyed by zone id');
  }

  return states;
}

/** `zoneStates` is the one payload read by a computed key rather than a literal
 * one, which is all this says. Every value in it is still `unknown` and goes
 * through `zoneOutcome`. */
function isKeyedObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

interface MeasurementPoint {
  readonly value: number;
  readonly measuredAt: Temporal.Instant;
}

function temperaturePointOf(point: unknown, where: string): MeasurementPoint {
  if (point === null || typeof point !== 'object') {
    throw new Error(`${where} has an insideTemperature that is not an object`);
  }
  if (!('celsius' in point) || typeof point.celsius !== 'number') {
    throw new Error(`${where} has an insideTemperature with no numeric celsius`);
  }

  return { value: point.celsius, measuredAt: timestampOf(point, where, 'insideTemperature') };
}

function humidityPointOf(point: unknown, where: string): MeasurementPoint {
  if (point === null || typeof point !== 'object') {
    throw new Error(`${where} has a humidity that is not an object`);
  }
  if (!('percentage' in point) || typeof point.percentage !== 'number') {
    throw new Error(`${where} has a humidity with no numeric percentage`);
  }

  return { value: point.percentage, measuredAt: timestampOf(point, where, 'humidity') };
}

// The same parse the API's own range parameters go through: an ISO 8601 instant
// with an explicit zone, truncated to the millisecond the store thinks in. Tado
// writes `2026-08-14T09:12:31.000Z`, so this is the vendor and the wire agreeing
// for once — and if a firmware ever stops agreeing, the poll says so instead of
// filing a reading under an invented time.
function timestampOf(point: object, where: string, what: string): Temporal.Instant {
  const measuredAt = parseInstant('timestamp' in point ? point.timestamp : undefined);
  if (measuredAt === undefined) {
    throw new Error(`${where} stamped its ${what} with something that is not an ISO 8601 instant`);
  }

  return measuredAt;
}
