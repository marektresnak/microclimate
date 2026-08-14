import { randomUUID } from 'node:crypto';

import { Hono } from 'hono';
import { html } from 'hono/html';

import { NETATMO_TOKEN_URL } from '../sources/netatmo.ts';
import type { NetatmoSettings } from '../sources/netatmo.ts';
import { saveRefreshToken } from '../sources/refresh-token-file.ts';
import type { FetchLike } from '../sources/source.ts';

/**
 * The Netatmo onboarding pair — GET /auth/netatmo and its callback — mounted
 * whole by http/server.ts.
 *
 * Its own module because it is the API's other half in kind, not only a pair
 * of routes: the caller is a human in a browser rather than a node, so it
 * answers in HTML; it holds the HTTP layer's only mutable value (the OAuth
 * state); and it makes the layer's only outbound request (the code-for-token
 * exchange). With it out, server.ts is uniform JSON with no vendor imports.
 *
 * `settings` is the same object the polling adapter holds — see
 * NetatmoSettings — so the token this flow saves lands exactly where the
 * poller reads. Unset means the two routes answer 503 naming what to set,
 * rather than a 404 that looks like a typo in the URL.
 */

const AUTHORIZE_URL = 'https://api.netatmo.com/oauth2/authorize';
// The one scope gethomecoachsdata needs.
const HOME_COACH_SCOPE = 'read_homecoach';
const EXCHANGE_TIMEOUT = Temporal.Duration.from({ seconds: 10 });

export function createNetatmoAuthRoutes(
  settings: NetatmoSettings | undefined,
  log: (line: string) => void,
  fetchImpl: FetchLike = fetch,
): Hono {
  // The one live OAuth state, single-use. Only the most recent flow counts, so
  // opening the auth page twice invalidates the first tab — acceptable for a
  // single-operator system, and it keeps this a value instead of a table.
  let pendingState: string | undefined;

  const app = new Hono();

  app.get('/auth/netatmo', (c) => {
    if (settings === undefined) {
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
    authorize.searchParams.set('client_id', settings.clientId);
    authorize.searchParams.set('redirect_uri', settings.redirectUri);
    authorize.searchParams.set('scope', HOME_COACH_SCOPE);
    authorize.searchParams.set('state', state);
    authorize.searchParams.set('response_type', 'code');

    return c.redirect(authorize.toString());
  });

  app.get('/auth/netatmo/callback', async (c) => {
    if (settings === undefined) {
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
        client_id: settings.clientId,
        client_secret: settings.clientSecret,
        code,
        redirect_uri: settings.redirectUri,
        scope: HOME_COACH_SCOPE,
      }),
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT.total('milliseconds')),
    });

    if (!exchanged.ok) {
      const body = await exchanged.text();
      return c.html(
        page(
          'Exchange failed',
          `Netatmo answered ${exchanged.status}: ${body}. If this mentions the redirect URI, it must match the app registration exactly (this server sent ${settings.redirectUri}).`,
        ),
        502,
      );
    }

    const payload: unknown = await exchanged.json();
    saveRefreshToken(settings.tokenPath, refreshTokenOf(payload));
    log('Netatmo authorised — refresh token saved');

    return c.html(
      page(
        'Netatmo connected',
        'The refresh token is saved. The adapter picks it up on its next poll; you can close this tab.',
      ),
    );
  });

  return app;
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
