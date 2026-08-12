import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { RANGE_QUERY_SQL, SCHEMA, openLogStore } from '../src/store/logs.ts';
import { assertDeepEqual } from './support/deep-equal.ts';

const NOW = Temporal.Instant.from('2026-08-12T12:00:00Z');
const BEGINNING = Temporal.Instant.fromEpochMilliseconds(0);

describe('the log store', () => {
  it('stores lines and reads back the ones in range', () => {
    const store = openLogStore(':memory:');

    store.append(NOW.subtract({ minutes: 3 }), 'bedroom_netatmo: 3 readings, 3 new');
    store.append(NOW.subtract({ minutes: 2 }), '50% set over the API');
    store.append(NOW.subtract({ minutes: 1 }), 'bedroom_netatmo did not report: fetch failed');

    assertDeepEqual(store.linesInRange(NOW.subtract({ minutes: 2 }), NOW), [
      { at: NOW.subtract({ minutes: 2 }), message: '50% set over the API' },
      { at: NOW.subtract({ minutes: 1 }), message: 'bedroom_netatmo did not report: fetch failed' },
    ]);

    store.close();
  });

  it('keeps lines written in the same millisecond in the order they were written', () => {
    // The collector logs two sources back to back; `at` alone cannot order
    // them, and a log that shuffles cause and effect is worse than none.
    const store = openLogStore(':memory:');

    store.append(NOW, 'first');
    store.append(NOW, 'second');
    store.append(NOW, 'third');

    assert.deepEqual(
      store.linesInRange(NOW, NOW.add({ milliseconds: 1 })).map((line) => line.message),
      ['first', 'second', 'third'],
    );

    store.close();
  });

  it('stores the same line twice as two events', () => {
    // No dedup, deliberately: nothing retries a log line, and two identical
    // failures a minute apart are two facts, not one.
    const store = openLogStore(':memory:');

    store.append(NOW.subtract({ minutes: 1 }), 'bedroom_netatmo did not report: fetch failed');
    store.append(NOW, 'bedroom_netatmo did not report: fetch failed');

    assert.equal(store.linesInRange(BEGINNING, NOW.add({ milliseconds: 1 })).length, 2);
    store.close();
  });

  it('includes the from bound and excludes the to bound', () => {
    // Half-open [from, to), the same rule as the readings range: adjacent
    // windows tile, so a line on the boundary lands in exactly one of them.
    const store = openLogStore(':memory:');
    store.append(NOW.subtract({ minutes: 2 }), 'on the from bound');
    store.append(NOW.subtract({ minutes: 1 }), 'on the to bound');

    const window = store.linesInRange(NOW.subtract({ minutes: 2 }), NOW.subtract({ minutes: 1 }));

    assert.deepEqual(
      window.map((line) => line.message),
      ['on the from bound'],
    );
    store.close();
  });

  it('reports nothing before the first line was written', () => {
    const store = openLogStore(':memory:');

    assertDeepEqual(store.linesInRange(BEGINNING, NOW), []);
    store.close();
  });
});

describe('the log schema', () => {
  // These two speak raw SQL, below the store's Instant boundary, so epoch
  // milliseconds appear here as the numbers the column actually holds.
  it('renders at as readable ISO without storing it', () => {
    // The same generated-column trick the readings table uses, for the same
    // reason: SELECT * stays legible without a converter.
    const database = new DatabaseSync(':memory:');
    database.exec(SCHEMA);
    database
      .prepare('INSERT INTO logs (at, message) VALUES (?, ?)')
      .run(Date.UTC(2026, 7, 12, 13, 45, 30, 250), 'hello');

    const row = database.prepare('SELECT at_iso FROM logs').get();
    const iso = row !== null && typeof row === 'object' && 'at_iso' in row ? row.at_iso : undefined;

    assert.equal(iso, '2026-08-12T13:45:30.250Z');
    database.close();
  });

  it('serves the range query from the index', () => {
    // The readings table gets its index free from the dedup constraint; this
    // one is explicit, and this is what notices if it is dropped.
    const database = new DatabaseSync(':memory:');
    database.exec(SCHEMA);

    const plan = database
      .prepare(`EXPLAIN QUERY PLAN ${RANGE_QUERY_SQL}`)
      .all(0, NOW.epochMilliseconds)
      .map((row) => (row !== null && typeof row === 'object' && 'detail' in row ? row.detail : ''))
      .join('\n');

    assert.match(plan, /SEARCH logs USING INDEX logs_at/);
    assert.doesNotMatch(plan, /SCAN logs/);
    database.close();
  });
});
