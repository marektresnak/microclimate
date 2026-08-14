import { Hono } from 'hono';
import type { Context } from 'hono';
import { html } from 'hono/html';

import type { FetchLike } from '../sources/source.ts';
import { saveRefreshToken } from '../sources/refresh-token-file.ts';
import { TADO_CLIENT_ID, TADO_TOKEN_URL, tokenResponseOf } from '../sources/tado.ts';
import type { TadoSettings } from '../sources/tado.ts';

/**
 * The Tado onboarding route — GET /auth/tado — mounted whole by http/server.ts,
 * beside the Netatmo pair and for the same reasons: the caller is a human in a
 * browser rather than a node, so it answers in HTML; it holds a mutable value of
 * its own; and it makes an outbound request the JSON API does not.
 *
 * **One route, not a pair.** Tado uses the RFC 8628 device flow, where the
 * vendor never calls us back: we ask for a code, a human approves it somewhere
 * else, and we ask again until the answer changes. So the page is the state
 * machine — a `<meta http-equiv="refresh">` at the interval Tado asked for
 * drives exactly one token poll per load. The rate is then the vendor's own
 * number rather than a loop of ours, which is what keeps a 429 out of a flow
 * whose whole job is to be waited on.
 *
 * `settings` is the same object the polling adapter holds — see TadoSettings —
 * so the token this flow saves lands exactly where the poller reads. Unset means
 * 503 naming what to set, rather than a 404 that looks like a typo in the URL.
 */

const DEVICE_AUTHORIZE_URL = 'https://login.tado.com/oauth2/device_authorize';
const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

// Without offline_access the grant is an access token and nothing else, and an
// access token lives ten minutes. This one scope is the difference between
// authorising once and authorising all day.
const TADO_SCOPE = 'offline_access';

const EXCHANGE_TIMEOUT = Temporal.Duration.from({ seconds: 10 });

// RFC 8628's answer to slow_down: add five seconds and keep going. Not a guess
// at a good rhythm — the vendor's rhythm, adjusted the way the spec says.
const SLOW_DOWN_STEP = Temporal.Duration.from({ seconds: 5 });

const EXPIRED_LINE = 'the Tado device code expired before anyone approved it — starting a new one';

/** The flow between asking for a code and someone approving it. Replaced whole
 * rather than mutated, so the interval cannot drift out of the page showing it. */
interface PendingFlow {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly interval: Temporal.Duration;
  readonly expiresAt: Temporal.Instant;
}

export function createTadoAuthRoutes(
  settings: TadoSettings | undefined,
  log: (line: string) => void,
  clock: () => Temporal.Instant,
  fetchImpl: FetchLike = fetch,
): Hono {
  // The one live flow, exactly as the Netatmo module holds the one live OAuth
  // state: opening this page in a second tab abandons the first code, which is
  // fine for a single operator and keeps this a value instead of a table.
  let pendingFlow: PendingFlow | undefined;

  const app = new Hono();

  /** The pending flow if there is still time to approve it. A code that has run
   * out is not a flow, and saying so here keeps the deadline in one place. */
  const liveFlow = (now: Temporal.Instant): PendingFlow | undefined => {
    const flow = pendingFlow;
    if (flow === undefined) return undefined;
    if (Temporal.Instant.compare(now, flow.expiresAt) < 0) return flow;

    log(EXPIRED_LINE);
    pendingFlow = undefined;
    return undefined;
  };

  // Asking for a code needs no credential of ours at all — the client id is
  // public and there is no secret — so this half runs without `settings`. It is
  // only the token that has somewhere to be saved.
  const beginFlow = async (c: Context): Promise<Response> => {
    // Same shape as the token call: parameters on the query string, no body.
    const url = new URL(DEVICE_AUTHORIZE_URL);
    url.searchParams.set('client_id', TADO_CLIENT_ID);
    url.searchParams.set('scope', TADO_SCOPE);

    const response = await fetchImpl(url, {
      method: 'POST',
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT.total('milliseconds')),
    });

    if (!response.ok) {
      const body = await response.text();
      return c.html(
        notePage('Tado would not start a flow', `Tado answered ${response.status}: ${body}`),
        502,
      );
    }

    const payload: unknown = await response.json();
    const started = deviceCodeOf(payload);
    const flow: PendingFlow = {
      deviceCode: started.deviceCode,
      userCode: started.userCode,
      verificationUri: started.verificationUri,
      // Both spans are the vendor's, carried as Durations from the edge inwards
      // like every other span in this project.
      interval: Temporal.Duration.from({ seconds: started.intervalSeconds }),
      expiresAt: clock().add({ seconds: started.expiresInSeconds }),
    };
    pendingFlow = flow;

    return c.html(waitingPage(flow));
  };

  app.get('/auth/tado', async (c) => {
    if (settings === undefined) {
      return c.json({ error: 'set TADO_TOKEN_PATH to enable Tado onboarding' }, 503);
    }

    const flow = liveFlow(clock());
    if (flow === undefined) return beginFlow(c);

    // One poll per page load, and the page decides when the next load is.
    const url = new URL(TADO_TOKEN_URL);
    url.searchParams.set('client_id', TADO_CLIENT_ID);
    url.searchParams.set('device_code', flow.deviceCode);
    url.searchParams.set('grant_type', DEVICE_CODE_GRANT);

    const response = await fetchImpl(url, {
      method: 'POST',
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT.total('milliseconds')),
    });

    if (response.ok) {
      const payload: unknown = await response.json();
      // The adapter's own narrowing, so the two halves cannot disagree about
      // what a Tado grant is — and it insists on the refresh token, which is the
      // only part of the answer that outlives this page.
      saveRefreshToken(settings.tokenPath, tokenResponseOf(payload).refreshToken);
      pendingFlow = undefined;
      log('Tado authorised — refresh token saved');

      return c.html(
        notePage(
          'Tado connected',
          'The refresh token is saved. The adapter picks it up on its next poll; you can close this tab.',
        ),
      );
    }

    const body = await response.text();
    const refusal = refusalOf(body);

    // Still waiting on the human. The page reloads and asks again.
    if (refusal === 'authorization_pending') return c.html(waitingPage(flow));

    if (refusal === 'slow_down') {
      const slower: PendingFlow = { ...flow, interval: flow.interval.add(SLOW_DOWN_STEP) };
      pendingFlow = slower;
      return c.html(waitingPage(slower));
    }

    if (refusal === 'expired_token') {
      log(EXPIRED_LINE);
      pendingFlow = undefined;
      return beginFlow(c);
    }

    if (refusal === 'access_denied') {
      pendingFlow = undefined;
      return c.html(
        notePage('Tado said no', 'The authorisation was refused. Reload this page to start again.'),
        400,
      );
    }

    // Something we have no rule for. Report it whole rather than waiting on it
    // forever, and drop the flow so a reload starts cleanly.
    pendingFlow = undefined;
    return c.html(
      notePage('Tado answered something unexpected', `Tado answered ${response.status}: ${body}`),
      502,
    );
  });

  return app;
}

/** The refusal code out of an OAuth error body, or undefined if this is not one
 * — in which case the caller reports the answer as itself. */
function refusalOf(body: string): string | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return undefined;
  }

  if (payload === null || typeof payload !== 'object' || !('error' in payload) || typeof payload.error !== 'string') {
    return undefined;
  }

  return payload.error;
}

function deviceCodeOf(payload: unknown): {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  intervalSeconds: number;
  expiresInSeconds: number;
} {
  if (payload === null || typeof payload !== 'object') {
    throw new Error('Tado answered the device-code request with something that is not an object');
  }
  if (!('device_code' in payload) || typeof payload.device_code !== 'string') {
    throw new Error('Tado answered the device-code request without a device_code');
  }
  if (!('user_code' in payload) || typeof payload.user_code !== 'string') {
    throw new Error('Tado answered the device-code request without a user_code');
  }
  if (!('interval' in payload) || typeof payload.interval !== 'number') {
    throw new Error('Tado answered the device-code request without a poll interval');
  }
  if (!('expires_in' in payload) || typeof payload.expires_in !== 'number') {
    throw new Error('Tado answered the device-code request without an expiry');
  }

  // verification_uri_complete carries the code already in it, so the page is one
  // click; verification_uri is the bare page a human types the code into. Prefer
  // the complete one, fall back to the plain one — the code is on the page
  // either way.
  const complete = 'verification_uri_complete' in payload ? payload.verification_uri_complete : undefined;
  const plain = 'verification_uri' in payload ? payload.verification_uri : undefined;
  const verificationUri = typeof complete === 'string' ? complete : plain;
  if (typeof verificationUri !== 'string') {
    throw new Error('Tado answered the device-code request without a verification URL');
  }

  return {
    deviceCode: payload.device_code,
    userCode: payload.user_code,
    verificationUri,
    intervalSeconds: payload.interval,
    expiresInSeconds: payload.expires_in,
  };
}

/**
 * The page that waits. Its meta refresh is the whole polling mechanism, set to
 * the interval Tado asked for — so closing the tab stops the polling, which is
 * the honest behaviour for a flow nobody is watching.
 */
function waitingPage(flow: PendingFlow): string | Promise<string> {
  const seconds = flow.interval.total('seconds');

  // Tado's own strings — the URL and the user code — are interpolated here, and
  // they arrive from outside. The tagged template escapes every interpolation by
  // default, so an interpolation added later is safe whether or not its author
  // thought about it.
  return html`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="${seconds}"><title>Authorising Tado</title><h1>Authorising Tado</h1><p><a href="${flow.verificationUri}">Open Tado and approve this device</a>, then leave this page alone — it asks Tado once every ${seconds} seconds.</p><p>If Tado asks for the code, it is <code>${flow.userCode}</code>.</p>`;
}

/** A page that says one thing and stops — no refresh, so an answer never turns
 * into a loop. */
function notePage(title: string, text: string): string | Promise<string> {
  return html`<!doctype html><meta charset="utf-8"><title>${title}</title><h1>${title}</h1><p>${text}</p>`;
}
