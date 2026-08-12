import type { SensorId } from '../config.ts';
import { messageOf } from '../domain/errors.ts';
import type { Reading } from '../domain/measurement.ts';
import { loadRefreshToken, saveRefreshToken } from './netatmo-token.ts';
import type { SensorSource } from './source.ts';

/**
 * The Netatmo Home Coach, over their cloud API.
 *
 * Pull adapter: OAuth refresh flow, then `gethomecoachsdata`. The endpoint and
 * flow are the ones proven by the owner's netatmo-sync worker, which has been
 * polling this same device for months — not taken from documentation.
 *
 * `fetchImpl` is the seam, exactly as `OpenStream` is in the Modbus client:
 * everything above it is protocol logic tested against canned responses, and
 * only `main.ts` ever passes the real `fetch`.
 */

// Exported because the OAuth callback in the HTTP server exchanges its code
// against the same endpoint. One URL, one place.
export const NETATMO_TOKEN_URL = 'https://api.netatmo.com/oauth2/token';
const HOME_COACH_URL = 'https://api.netatmo.com/api/gethomecoachsdata';

// A stalled vendor must not stall the collector's whole tick — the same reason
// the Modbus client carries a budget. Ten seconds is generous for one HTTPS
// round trip and still small against the poll interval below.
const REQUEST_TIMEOUT = Temporal.Duration.from({ seconds: 10 });

// Netatmo refreshes server-side every 7-8 minutes, so polling faster gains
// nothing. Polling slower has a bound too: a reading is up to one vendor
// refresh old when fetched, plus up to one poll interval older before we ask
// again. Against the 15-minute freshness window in config, the interval must
// therefore stay under 7 minutes or a perfectly healthy instrument would
// periodically read as stale through our own polling. Five minutes gives
// margin on both sides; the store's uniqueness constraint absorbs the repeats.
const POLL_INTERVAL = Temporal.Duration.from({ minutes: 5 });

export type FetchLike = typeof fetch;

/**
 * The app registration and the token file — one identity, built once in
 * main.ts and handed whole to both of its consumers: this adapter and the
 * /auth/netatmo onboarding routes. Sharing the object is what keeps them
 * agreeing on `tokenPath`; an onboarding that saved a token where the poller
 * does not read would be a lockout wearing a success page. `redirectUri`
 * belongs to the onboarding half alone — the poller carries it unread, the
 * price of one type instead of two overlapping ones.
 */
export interface NetatmoSettings {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Must match the Netatmo app registration exactly, or the exchange fails. */
  readonly redirectUri: string;
  readonly tokenPath: string;
}

export interface NetatmoOptions {
  /** The identity shared with the onboarding routes — see NetatmoSettings. */
  readonly settings: NetatmoSettings;
  /** Narrows the response to one station when the account has several. */
  readonly deviceId: string | undefined;
  /** Which instrument in config these readings belong to. Identity is the
   * wiring's decision, not the protocol's — see config on relocation. */
  readonly sourceId: SensorId;
  /** NETATMO_REFRESH_TOKEN from the environment, used only until the token
   * file exists. After the first rotation the file is the truth and this is a
   * stale credential kept for nothing but the bootstrap. */
  readonly seedRefreshToken: string | undefined;
  readonly log: (line: string) => void;
}

export function createNetatmoSource(
  options: NetatmoOptions,
  fetchImpl: FetchLike = fetch,
): SensorSource {
  // Access tokens last about three hours. Expiry is discovered by the 401
  // rather than tracked against a clock: the 401 path has to exist anyway, and
  // a timer doing the same job would be a second mechanism. The price is one
  // wasted request every few hours.
  let accessToken: string | undefined;

  const fetchHomeCoach = async (token: string): Promise<Response> => {
    const url = new URL(HOME_COACH_URL);
    if (options.deviceId !== undefined) url.searchParams.set('device_id', options.deviceId);

    return fetchImpl(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT.total('milliseconds')),
    });
  };

  const refreshAccessToken = async (): Promise<string> => {
    // Read the file on every refresh rather than once at start-up, so a
    // re-authorisation through /auth/netatmo takes effect at the next refresh
    // without a restart.
    const refreshToken = loadRefreshToken(options.settings.tokenPath) ?? options.seedRefreshToken;
    if (refreshToken === undefined) {
      throw new Error('no Netatmo refresh token — authorise once at /auth/netatmo');
    }

    const response = await fetchImpl(NETATMO_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: options.settings.clientId,
        client_secret: options.settings.clientSecret,
        refresh_token: refreshToken,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT.total('milliseconds')),
    });

    if (!response.ok) {
      const body = await response.text();
      const hint = body.includes('invalid_grant')
        ? ' — the refresh token is dead, re-authorise at /auth/netatmo'
        : '';
      throw new Error(`Netatmo token refresh failed (${response.status}): ${body}${hint}`);
    }

    const payload: unknown = await response.json();
    const tokens = tokenResponseOf(payload);

    // Netatmo rotates the refresh token on every refresh, so the new one is
    // persisted BEFORE the access token is used: a crash in between must lose
    // a poll, not the credential. If the disk write fails we carry on with the
    // in-memory token — degraded now beats dead now — and say so, because the
    // next restart may need re-authorising by hand.
    if (tokens.refreshToken !== undefined) {
      try {
        saveRefreshToken(options.settings.tokenPath, tokens.refreshToken);
      } catch (error) {
        options.log(
          `could not persist the rotated Netatmo refresh token: ${messageOf(error)} — ` +
            'polling continues, but the next restart may need /auth/netatmo again',
        );
      }
    }

    accessToken = tokens.accessToken;
    return tokens.accessToken;
  };

  return {
    name: 'netatmo',
    pollInterval: POLL_INTERVAL,

    async poll(now) {
      const first = await fetchHomeCoach(accessToken ?? (await refreshAccessToken()));
      if (first.status !== 401) return readingsOf(first, options.sourceId, now);

      // The access token aged out. Refresh and retry once — a second 401 means
      // Netatmo is rejecting a token it just issued, and asking a third time
      // is not going to change its mind.
      const retried = await fetchHomeCoach(await refreshAccessToken());
      if (retried.status === 401) {
        throw new Error('Netatmo rejected an access token it just issued');
      }
      return readingsOf(retried, options.sourceId, now);
    },
  };
}

async function readingsOf(
  response: Response,
  sourceId: SensorId,
  receivedAt: Temporal.Instant,
): Promise<Reading[]> {
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Netatmo answered ${response.status}: ${body}`);
  }

  const payload: unknown = await response.json();
  const dashboard = dashboardOf(payload);

  // time_utc is epoch SECONDS, and fromEpochSeconds does not exist — Temporal
  // dropped it — so the factor of a thousand is written out. A test pins it:
  // off by that factor, every reading dates from January 1970 and is
  // discarded as stale.
  const measuredAt = Temporal.Instant.fromEpochMilliseconds(dashboard.time_utc * 1000);

  // The vendor's own timestamp, never the poll time: Netatmo reports minutes
  // after it measures, and freshness is judged on when the instrument spoke.
  //
  // Temperature (°C), Humidity (% RH) and CO2 (ppm) already match the
  // canonical units, so no value converts. Noise and Pressure are dropped —
  // the design has no vocabulary (kind, canonical unit) for them yet, and
  // smuggling one in past config is not this adapter's call.
  return [
    { sourceId, kind: 'co2', value: dashboard.CO2, measuredAt, receivedAt },
    { sourceId, kind: 'temperature', value: dashboard.Temperature, measuredAt, receivedAt },
    { sourceId, kind: 'humidity', value: dashboard.Humidity, measuredAt, receivedAt },
  ];
}

/** Everything below is narrowing, in the store's toReading style: each check
 * rejects one way the payload could be wrong, and names it. */

function tokenResponseOf(payload: unknown): {
  accessToken: string;
  refreshToken: string | undefined;
} {
  if (payload === null || typeof payload !== 'object') {
    throw new Error('Netatmo token response is not an object');
  }
  if (!('access_token' in payload) || typeof payload.access_token !== 'string') {
    throw new Error('Netatmo token response has no access_token');
  }

  const refreshToken =
    'refresh_token' in payload && typeof payload.refresh_token === 'string'
      ? payload.refresh_token
      : undefined;

  return { accessToken: payload.access_token, refreshToken };
}

function dashboardOf(payload: unknown): {
  time_utc: number;
  Temperature: number;
  Humidity: number;
  CO2: number;
} {
  if (payload === null || typeof payload !== 'object' || !('body' in payload)) {
    throw new Error('Netatmo answered without a body');
  }

  const body = payload.body;
  if (body === null || typeof body !== 'object' || !('devices' in body) || !Array.isArray(body.devices)) {
    throw new Error('Netatmo answered without a devices list');
  }

  const devices: readonly unknown[] = body.devices;
  const device = devices[0];
  if (device === undefined) {
    throw new Error('no Home Coach in the Netatmo response');
  }

  if (device === null || typeof device !== 'object' || !('dashboard_data' in device)) {
    // Happens when the device is offline on Netatmo's side; the poll fails
    // whole, nothing partial is stored, and the collector logs it.
    throw new Error('the Home Coach sent no dashboard_data — the device may be offline');
  }

  const dashboard = device.dashboard_data;
  if (dashboard === null || typeof dashboard !== 'object') {
    throw new Error('dashboard_data is not an object');
  }
  if (!('time_utc' in dashboard) || typeof dashboard.time_utc !== 'number') {
    throw new Error('dashboard_data has no numeric time_utc');
  }
  if (!('Temperature' in dashboard) || typeof dashboard.Temperature !== 'number') {
    throw new Error('dashboard_data has no numeric Temperature');
  }
  if (!('Humidity' in dashboard) || typeof dashboard.Humidity !== 'number') {
    throw new Error('dashboard_data has no numeric Humidity');
  }
  if (!('CO2' in dashboard) || typeof dashboard.CO2 !== 'number') {
    throw new Error('dashboard_data has no numeric CO2');
  }

  return {
    time_utc: dashboard.time_utc,
    Temperature: dashboard.Temperature,
    Humidity: dashboard.Humidity,
    CO2: dashboard.CO2,
  };
}
