import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { createFakeUnit } from './actuator/fake.ts';
import { CONTROL } from './config.ts';
import { createControlLoop } from './control/loop.ts';
import { createSyntheticNetatmo, createSyntheticTado } from './sources/synthetic.ts';
import { openReadingStore } from './store/readings.ts';

// Wiring only. Every decision this file causes is made somewhere else.

const databasePath = process.env.DATABASE_PATH ?? './data/home.db';
mkdirSync(dirname(databasePath), { recursive: true });

const store = openReadingStore(databasePath);

// There is no Modbus adapter yet, so the recording fake stands in: it accepts a
// level, reports it back, and refuses anything above the ceiling. That is enough
// to watch the whole loop work, and it is honest about what is not built.
const unit = createFakeUnit(CONTROL.safeDefaultLevel);

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
    `synthetic sensors, fake unit, storing to ${databasePath}`,
);

// Sequential rather than an interval, so a slow tick delays the next one instead
// of overlapping with it.
for (;;) {
  await loop.tick(Date.now());
  await new Promise((resolve) => setTimeout(resolve, CONTROL.evaluationIntervalMs));
}
