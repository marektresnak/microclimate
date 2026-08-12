// First, before anything that touches Temporal at load time — config builds
// Durations the moment it is imported.
import './temporal-guard.ts';

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { createFakeUnit } from './actuator/fake.ts';
import { createModbusUnit } from './actuator/modbus-tcp.ts';
import type { VentilationUnit } from './actuator/unit.ts';
import { CONTROL } from './config.ts';
import { createApiServer } from './http/server.ts';
import type { NetatmoAuthOptions } from './http/server.ts';
import { createCollector } from './sources/collector.ts';
import { createNetatmoSource } from './sources/netatmo.ts';
import type { SensorSource } from './sources/source.ts';
import { toIsoUtc } from './domain/time.ts';
import { createSyntheticNetatmo, createSyntheticTado } from './sources/synthetic.ts';
import { openLogStore } from './store/logs.ts';
import { openReadingStore } from './store/readings.ts';

// Wiring only. Every decision this file causes is made somewhere else.
//
// The control loop is deliberately NOT wired. It is built and tested —
// src/control/, and the scripted traces that drive it — and parked: the band
// cannot be validated before a stretch of real readings exists, so for now the
// service collects and the fan is driven by hand, over the wall panel or POST
// /api/unit/level. The collector below is the loop's polling step extracted;
// when the loop returns it replaces the collector here, never runs beside it.
// See CLAUDE.md, "The control loop is parked".

// The five seconds is the spike's, and covers connecting as well as answering.
// One retry, because the collector comes back around in thirty seconds anyway.
const MODBUS_TIMEOUT = Temporal.Duration.from({ seconds: 5 });
const MODBUS_RETRIES = 1;
// What NModbus paused by default, so it is what the old spike was proven with.
const MODBUS_RETRY_PAUSE = Temporal.Duration.from({ milliseconds: 250 });

// How often sources are OFFERED a poll, not how often they are polled — each
// carries its own cadence and mostly declines. Thirty seconds keeps a
// one-minute source honest without busy-waiting.
const COLLECT_TICK = Temporal.Duration.from({ seconds: 30 });

// Empty and unset behave the same everywhere: an empty string in .env is a
// placeholder, not a value.
function envOrUndefined(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

const databasePath = process.env.DATABASE_PATH ?? './data/home.db';
mkdirSync(dirname(databasePath), { recursive: true });
const store = openReadingStore(databasePath);
const logStore = openLogStore(databasePath);

// Stdout first, the table best-effort: when SQLite itself is what is broken —
// disk full, file locked — the database cannot carry the news of its own
// outage, and a logging failure must never take down the work it narrates.
const log = (line: string): void => {
  const at = Temporal.Now.instant();
  console.log(`${toIsoUtc(at)}  ${line}`);
  try {
    logStore.append(at, line);
  } catch {
    // stdout already has the line
  }
};

const port = Number(process.env.PORT ?? 3000);
const netatmoTokenPath = process.env.NETATMO_TOKEN_PATH ?? './data/netatmo-token.json';

// With no HRV_MODBUS_HOST there is no unit to talk to, so the recording fake
// stands in: it accepts a level, reports it back, and refuses anything above
// the ceiling. `npm start` then demonstrates the whole service on any machine.
function chooseUnit(): VentilationUnit {
  const host = envOrUndefined('HRV_MODBUS_HOST');
  if (host === undefined) return createFakeUnit(CONTROL.safeDefaultLevel);

  return createModbusUnit({
    host,
    port: Number(process.env.HRV_MODBUS_PORT ?? 502),
    unitId: Number(process.env.HRV_MODBUS_UNIT_ID ?? 1),
    timeout: MODBUS_TIMEOUT,
    retries: MODBUS_RETRIES,
    retryPause: MODBUS_RETRY_PAUSE,
  });
}

const netatmoClientId = envOrUndefined('NETATMO_CLIENT_ID');
const netatmoClientSecret = envOrUndefined('NETATMO_CLIENT_SECRET');

const netatmoAuth: NetatmoAuthOptions | undefined =
  netatmoClientId !== undefined && netatmoClientSecret !== undefined
    ? {
        clientId: netatmoClientId,
        clientSecret: netatmoClientSecret,
        redirectUri:
          process.env.NETATMO_REDIRECT_URI ?? `http://localhost:${port}/auth/netatmo/callback`,
        tokenPath: netatmoTokenPath,
      }
    : undefined;

// Real credentials mean ONLY real sources. The synthetic Netatmo writes under
// the same source_id as the real one, so mixing them would salt the database
// with invented readings — and the week of logged settling points the band
// recomputation waits for has to be real or it is worthless.
function chooseSources(): readonly SensorSource[] {
  if (netatmoAuth === undefined) return [createSyntheticNetatmo(), createSyntheticTado()];

  return [
    createNetatmoSource({
      clientId: netatmoAuth.clientId,
      clientSecret: netatmoAuth.clientSecret,
      deviceId: envOrUndefined('NETATMO_DEVICE_ID'),
      sourceId: 'bedroom_netatmo',
      tokenPath: netatmoTokenPath,
      seedRefreshToken: envOrUndefined('NETATMO_REFRESH_TOKEN'),
      log,
    }),
  ];
}

const unit = chooseUnit();
const sources = chooseSources();
const collector = createCollector({ sources, store, log });

const server = createApiServer({
  store,
  logs: logStore,
  unit,
  netatmoAuth,
  clock: () => Temporal.Now.instant(),
  log,
});
server.listen(port);

const unitDescription = envOrUndefined('HRV_MODBUS_HOST') ?? 'a fake unit (no HRV_MODBUS_HOST set)';
console.log(
  `microclimate — collecting from ${sources.map((source) => source.name).join(', ')}, ` +
    `serving http on :${port}, driving ${unitDescription} by hand only, storing to ${databasePath}`,
);

// Sequential rather than an interval, so a slow tick delays the next one
// instead of overlapping with it.
for (;;) {
  await collector.tick(Temporal.Now.instant());
  await new Promise((resolve) => setTimeout(resolve, COLLECT_TICK.total('milliseconds')));
}
