import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { createFakeUnit } from './actuator/fake.ts';
import { createModbusUnit } from './actuator/modbus-tcp.ts';
import type { VentilationUnit } from './actuator/unit.ts';
import { CONTROL } from './config.ts';
import { createControlLoop } from './control/loop.ts';
import { createSyntheticNetatmo, createSyntheticTado } from './sources/synthetic.ts';
import { openReadingStore } from './store/readings.ts';

// Wiring only. Every decision this file causes is made somewhere else.

// The five seconds is the spike's, and covers connecting as well as answering.
//
// The retries are not the spike's three, because the spike was a one-shot HTTP
// handler and this is a loop: another attempt comes along in thirty seconds
// regardless, so a blip costs one late fan movement rather than a lost one.
// Two attempts also keeps an unreachable unit from stalling the sensor polling
// that shares the tick — the worst case is 2 × 5 s + one pause per operation,
// and a tick makes at most two operations, which fits inside the interval.
const MODBUS_TIMEOUT_MS = 5_000;
const MODBUS_RETRIES = 1;
// What NModbus paused by default, so it is what the old spike was proven with.
const MODBUS_RETRY_PAUSE_MS = 250;

const databasePath = process.env.DATABASE_PATH ?? './data/home.db';
mkdirSync(dirname(databasePath), { recursive: true });

const store = openReadingStore(databasePath);

// With no HRV_MODBUS_HOST there is no unit to talk to, so the recording fake
// stands in: it accepts a level, reports it back, and refuses anything above the
// ceiling. `npm start` then demonstrates the whole loop on any machine.
function chooseUnit(): VentilationUnit {
  const host = process.env.HRV_MODBUS_HOST;
  if (host === undefined || host === '') return createFakeUnit(CONTROL.safeDefaultLevel);

  return createModbusUnit({
    host,
    port: Number(process.env.HRV_MODBUS_PORT ?? 502),
    unitId: Number(process.env.HRV_MODBUS_UNIT_ID ?? 1),
    timeoutMs: MODBUS_TIMEOUT_MS,
    retries: MODBUS_RETRIES,
    retryPauseMs: MODBUS_RETRY_PAUSE_MS,
  });
}

const unit = chooseUnit();
const unitDescription = process.env.HRV_MODBUS_HOST ?? 'a fake unit (no HRV_MODBUS_HOST set)';

const loop = createControlLoop({
  sources: [createSyntheticNetatmo(), createSyntheticTado()],
  store,
  unit,
  // The loop says what happened; how it is rendered is wiring, which is why the
  // timestamp is stamped here rather than inside the decision.
  log: (line) => console.log(`${new Date().toISOString()}  ${line}`),
});

console.log(
  `microclimate — deciding every ${CONTROL.evaluationIntervalMs / 1000}s, ` +
    `synthetic sensors, driving ${unitDescription}, storing to ${databasePath}`,
);

// Sequential rather than an interval, so a slow tick delays the next one instead
// of overlapping with it.
for (;;) {
  await loop.tick(Date.now());
  await new Promise((resolve) => setTimeout(resolve, CONTROL.evaluationIntervalMs));
}
