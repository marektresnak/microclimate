import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseInstant, toIsoUtc } from '../src/domain/time.ts';

const NOON = Temporal.Instant.from('2026-08-12T09:36:00Z');

// Instants keep their state in internal slots, which deepEqual cannot see —
// two *different* instants compare as deeply equal. Every assertion here goes
// through epochMilliseconds so a wrong instant actually fails.
function epochMsOf(instant: Temporal.Instant | undefined): number | undefined {
  return instant?.epochMilliseconds;
}

describe('writing an instant for the API', () => {
  it('always emits UTC with milliseconds', () => {
    assert.equal(toIsoUtc(NOON), '2026-08-12T09:36:00.000Z');
  });

  it('emits exactly what the measured_at_iso column computes', () => {
    // The generated column is `strftime('%Y-%m-%dT%H:%M:%fZ', ...)`. Anyone
    // reading the database by hand and anyone reading the API see one string.
    // Temporal's own toJSON would drop the trailing zeros, which is why the
    // wire never sees an instant that has not passed through here.
    assert.equal(toIsoUtc(Temporal.Instant.fromEpochMilliseconds(1786527360123)), '2026-08-12T09:36:00.123Z');
  });
});

describe('reading an instant from the API', () => {
  it('accepts UTC, with or without seconds and fractions', () => {
    assert.equal(epochMsOf(parseInstant('2026-08-12T09:36:00.000Z')), NOON.epochMilliseconds);
    assert.equal(epochMsOf(parseInstant('2026-08-12T09:36:00Z')), NOON.epochMilliseconds);
    assert.equal(epochMsOf(parseInstant('2026-08-12T09:36Z')), NOON.epochMilliseconds);
  });

  it('reads every zone spelling of one instant as that same instant', () => {
    // The flat is in Prague, but nothing in this grammar says so: a push node
    // stamps readings in whatever zone its firmware was given, and all of these
    // name one moment. They must all become one instant, or the uniqueness
    // constraint would file the same reading several times over.
    //
    // Checked by mutation (2026-08-14): making parseInstant read the wall clock
    // and ignore the offset fails six tests — two here, three in ingest, one
    // round trip through the server — and nothing else in the suite moves. A
    // case that cannot fail is not covering anything.
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
      assert.equal(epochMsOf(parseInstant(spelling)), NOON.epochMilliseconds, spelling);
    }
  });

  it('accepts the RFC 9557 spellings the hand-rolled grammar used to refuse', () => {
    // The grammar is the platform's now, and it is wider than the old regex:
    // different spellings, but every one of them names a moment explicitly.
    // Pinned so the widening is a decision in the diff, not an accident.
    const nowAccepted = [
      '2026-08-12 09:36:00Z', // space separator
      '2026-08-12t09:36:00z', // lowercase separators
      '2026-08-12T09:36:00Z[Europe/Prague]', // bracketed annotation
      '20260812T093600Z', // compact form
    ];

    for (const spelling of nowAccepted) {
      assert.equal(epochMsOf(parseInstant(spelling)), NOON.epochMilliseconds, spelling);
    }
  });

  it('truncates sub-millisecond input to the millisecond the store thinks in', () => {
    // Temporal reads nanoseconds; the store keys uniqueness on milliseconds.
    // Truncating at the edge keeps one representation per instant everywhere —
    // two in-memory instants must never collapse into one row.
    const parsed = parseInstant('2026-08-12T09:36:00.123456789Z');

    assert.equal(epochMsOf(parsed), 1786527360123);
    assert.equal(parsed === undefined ? undefined : toIsoUtc(parsed), '2026-08-12T09:36:00.123Z');
  });

  it('keeps instants apart when the zone is what separates them', () => {
    // One wall clock at opposite ends of the offset range is 25 hours apart,
    // and lands on three different calendar days. Reading the zone as decoration
    // would collapse these into one reading.
    assert.equal(epochMsOf(parseInstant('2026-08-12T12:00:00+13:00')), Date.UTC(2026, 7, 11, 23, 0));
    assert.equal(epochMsOf(parseInstant('2026-08-12T12:00:00Z')), Date.UTC(2026, 7, 12, 12, 0));
    assert.equal(epochMsOf(parseInstant('2026-08-12T12:00:00-12:00')), Date.UTC(2026, 7, 13, 0, 0));
  });

  it('refuses a timestamp with no zone', () => {
    // Read as wall-clock time, this would mean a different instant on every
    // machine. Temporal refuses it for an Instant; the old regex did too.
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
    // The old parser rebuilt the date by hand because Date.parse rolls an
    // impossible day forward into the next month. Temporal refuses outright;
    // these stay pinned so a retreat to Date.parse would fail loudly.
    assert.equal(parseInstant('2026-02-31T00:00:00Z'), undefined);
    assert.equal(parseInstant('2026-04-31T00:00:00Z'), undefined);
    assert.equal(parseInstant('2027-02-29T00:00:00Z'), undefined);
    assert.equal(parseInstant('2026-13-01T00:00:00Z'), undefined);
    assert.equal(parseInstant('2026-08-12T25:00:00Z'), undefined);
  });

  it('accepts the leap day that does exist', () => {
    assert.equal(epochMsOf(parseInstant('2028-02-29T00:00:00Z')), Date.UTC(2028, 1, 29));
  });

  it('refuses what is not a string at all', () => {
    assert.equal(parseInstant(undefined), undefined);
    assert.equal(parseInstant(null), undefined);
    assert.equal(parseInstant({ measuredAt: '2026-08-12T09:36:00Z' }), undefined);
    assert.equal(parseInstant('yesterday'), undefined);
  });

  it('round-trips whatever it wrote', () => {
    assert.equal(epochMsOf(parseInstant(toIsoUtc(NOON))), NOON.epochMilliseconds);
  });
});
