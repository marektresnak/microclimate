import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseInstant, toIsoUtc } from '../src/domain/time.ts';

const NOON = Date.UTC(2026, 7, 12, 9, 36);

describe('writing an instant for the API', () => {
  it('always emits UTC with milliseconds', () => {
    assert.equal(toIsoUtc(NOON), '2026-08-12T09:36:00.000Z');
  });

  it('emits exactly what the measured_at_iso column computes', () => {
    // The generated column is `strftime('%Y-%m-%dT%H:%M:%fZ', ...)`. Anyone
    // reading the database by hand and anyone reading the API see one string.
    assert.equal(toIsoUtc(1786527360123), '2026-08-12T09:36:00.123Z');
  });
});

describe('reading an instant from the API', () => {
  it('accepts UTC, with or without seconds and fractions', () => {
    assert.equal(parseInstant('2026-08-12T09:36:00.000Z'), NOON);
    assert.equal(parseInstant('2026-08-12T09:36:00Z'), NOON);
    assert.equal(parseInstant('2026-08-12T09:36Z'), NOON);
  });

  it('reads every zone spelling of one instant as that same instant', () => {
    // The flat is in Prague, but nothing in this grammar says so: a push node
    // stamps readings in whatever zone its firmware was given, and all of these
    // name one moment. They must all become one number, or the uniqueness
    // constraint would file the same reading several times over.
    const sameMoment = [
      '2026-08-12T09:36:00Z',
      '2026-08-12T09:36:00+00:00',
      '2026-08-12T09:36:00-00:00',
      '2026-08-12T11:36:00+02:00', // Prague in summer
      '2026-08-12T10:36:00+01:00', // Prague in winter
      '2026-08-12T04:36:00-05:00',
      '2026-08-12T15:06:00+05:30', // half an hour, which an hours-only parse would lose
      '2026-08-12T22:36:00+13:00',
      '2026-08-11T21:36:00-12:00', // a day earlier on its own calendar
    ];

    for (const spelling of sameMoment) {
      assert.equal(parseInstant(spelling), NOON, spelling);
    }
  });

  it('keeps instants apart when the zone is what separates them', () => {
    // One wall clock at opposite ends of the offset range is 25 hours apart,
    // and lands on three different calendar days. Reading the zone as decoration
    // would collapse these into one reading.
    assert.equal(parseInstant('2026-08-12T12:00:00+13:00'), Date.UTC(2026, 7, 11, 23, 0));
    assert.equal(parseInstant('2026-08-12T12:00:00Z'), Date.UTC(2026, 7, 12, 12, 0));
    assert.equal(parseInstant('2026-08-12T12:00:00-12:00'), Date.UTC(2026, 7, 13, 0, 0));
  });

  it('refuses a timestamp with no zone', () => {
    // `Date.parse` would read this as the host's local time, so the same
    // request would mean different instants on different machines.
    assert.equal(parseInstant('2026-08-12T09:36:00'), undefined);
    assert.equal(parseInstant('2026-08-12T09:36'), undefined);
  });

  it('refuses a bare date', () => {
    assert.equal(parseInstant('2026-08-12'), undefined);
  });

  it('refuses epoch milliseconds, in either spelling', () => {
    // The format this API used to speak. It must fail loudly rather than be
    // guessed at, or a node left on the old shape would look healthy while
    // storing nothing.
    assert.equal(parseInstant(1786527360000), undefined);
    assert.equal(parseInstant('1786527360000'), undefined);
  });

  it('refuses dates that do not exist', () => {
    // Date.parse rejects month 13, hour 25 and minute 61 on its own, but rolls
    // an impossible day forward into the next month instead of refusing it.
    assert.equal(parseInstant('2026-02-31T00:00:00Z'), undefined);
    assert.equal(parseInstant('2026-04-31T00:00:00Z'), undefined);
    assert.equal(parseInstant('2027-02-29T00:00:00Z'), undefined);
    assert.equal(parseInstant('2026-13-01T00:00:00Z'), undefined);
    assert.equal(parseInstant('2026-08-12T25:00:00Z'), undefined);
  });

  it('accepts the leap day that does exist', () => {
    assert.equal(parseInstant('2028-02-29T00:00:00Z'), Date.UTC(2028, 1, 29));
  });

  it('refuses what is not a string at all', () => {
    assert.equal(parseInstant(undefined), undefined);
    assert.equal(parseInstant(null), undefined);
    assert.equal(parseInstant({ measuredAt: '2026-08-12T09:36:00Z' }), undefined);
    assert.equal(parseInstant('yesterday'), undefined);
  });

  it('round-trips whatever it wrote', () => {
    assert.equal(parseInstant(toIsoUtc(NOON)), NOON);
  });
});
