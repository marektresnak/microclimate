import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CONTROL } from '../src/config.ts';
import { limit } from '../src/control/limiter.ts';
import type { Decision } from '../src/domain/decision.ts';
import type { CommandedLevel } from '../src/domain/level.ts';
import { assertDeepEqual } from './support/deep-equal.ts';

const NOW = Temporal.Instant.from('2026-08-10T12:00:00Z');
const DWELL = CONTROL.minDwell;
const LONG_AGO = NOW.subtract({ hours: 24 });

function wants(desiredLevel: CommandedLevel, sleeping = false): Decision {
  return { desiredLevel, sleeping, reasons: ['because the test said so'] };
}

describe('increases', () => {
  it('apply at once, at any distance', () => {
    const outcome = limit(wants(80), 20, LONG_AGO, NOW);

    assert.equal(outcome.level, 80);
    assert.equal(outcome.write, true);
  });

  it('are not gated by the dwell timer', () => {
    // Down is the safe direction and up is where the air is already bad, so the
    // rate limit only ever applies to one of them.
    const oneMinuteAgo = NOW.subtract({ minutes: 1 });

    const outcome = limit(wants(70), 30, oneMinuteAgo, NOW);

    assert.equal(outcome.level, 70);
    assert.equal(outcome.write, true);
  });

  it('restart the dwell clock', () => {
    const outcome = limit(wants(50), 20, LONG_AGO, NOW);

    assertDeepEqual(outcome.lastChangeAt, NOW);
  });
});

describe('decreases', () => {
  it('move one step at a time', () => {
    const outcome = limit(wants(20), 80, LONG_AGO, NOW);

    assert.equal(outcome.level, 70);
    assert.equal(outcome.write, true);
    assertDeepEqual(outcome.lastChangeAt, NOW);
  });

  it('take six steps and an hour to walk the whole range down', () => {
    // The slow retreat is what stops CO2 crashing and rebounding into the next
    // boost, and it is the backstop if the band turns out too narrow.
    const commanded: CommandedLevel[] = [];
    let level: CommandedLevel = 80;
    let lastChangeAt: Temporal.Instant | undefined = LONG_AGO;

    for (let minute = 0; minute <= 60; minute += 1) {
      const outcome = limit(wants(20), level, lastChangeAt, NOW.add({ minutes: minute }));
      if (outcome.write) commanded.push(outcome.level);
      level = outcome.level;
      lastChangeAt = outcome.lastChangeAt;
    }

    assert.deepEqual(commanded, [70, 60, 50, 40, 30, 20]);
  });

  it('never return to the floor in a single move', () => {
    const outcome = limit(wants(20), 80, LONG_AGO, NOW);

    assert.notEqual(outcome.level, 20);
  });

  it('give way at once to a demand that reverses direction', () => {
    const stepped = limit(wants(20), 80, LONG_AGO, NOW);
    const reversed = limit(wants(80), stepped.level, stepped.lastChangeAt, NOW.add({ minutes: 1 }));

    assert.equal(reversed.level, 80);
    assert.equal(reversed.write, true);
  });
});

describe('dwell', () => {
  it('suppresses a step down until it has elapsed', () => {
    const outcome = limit(wants(20), 80, NOW.subtract({ minutes: 9 }), NOW);

    assert.equal(outcome.level, 80);
    assert.equal(outcome.write, false);
    assert.match(outcome.reasons.join(' '), /dwell/);
  });

  it('permits a step down exactly on the boundary', () => {
    const outcome = limit(wants(20), 80, NOW.subtract(DWELL), NOW);

    assert.equal(outcome.level, 70);
    assert.equal(outcome.write, true);
  });

  it('is measured from the last change, not the last evaluation', () => {
    // Evaluating every 30 s must not keep resetting the timer, or nothing ever
    // moves. Each call below is an evaluation that changes nothing.
    const lastChangeAt = NOW;

    // Nineteen evaluations spread across the dwell, none of which may push the
    // deadline out. The demand is unchanged throughout, so nothing else moves.
    for (let tick = 0; tick < 19; tick += 1) {
      const evaluation = limit(wants(20), 80, lastChangeAt, NOW.add({ seconds: 30 * tick }));
      assert.equal(evaluation.write, false);
      assertDeepEqual(evaluation.lastChangeAt, lastChangeAt, 'an evaluation must not restart the dwell');
    }

    const onceElapsed = limit(wants(20), 80, lastChangeAt, lastChangeAt.add(DWELL));
    assert.equal(onceElapsed.write, true);
  });

  it('does not block the very first decision (Q4)', () => {
    // Which is also every restart: the timer lives in memory, so a restart acts
    // immediately rather than waiting out a dwell it cannot remember.
    const outcome = limit(wants(20), 80, undefined, NOW);

    assert.equal(outcome.level, 70);
    assert.equal(outcome.write, true);
  });

  it('reports a suppressed change rather than dropping it silently', () => {
    const outcome = limit(wants(20), 80, NOW.subtract({ minutes: 1 }), NOW);

    assert.ok(outcome.reasons.length > 0);
    assert.match(outcome.reasons.join(' '), /80%/);
  });
});

describe('no change needed', () => {
  it('issues no write when the demand is already the current level', () => {
    const outcome = limit(wants(50), 50, LONG_AGO, NOW);

    assert.equal(outcome.level, 50);
    assert.equal(outcome.write, false);
    assertDeepEqual(outcome.lastChangeAt, LONG_AGO);
  });
});

describe('the sleep cap', () => {
  it('applies to where the unit is, not only to a freshly computed target (F4)', () => {
    // Evening cooking leaves the unit at 70. Quiet hours begin, demand has not
    // moved, so no new target is produced — and it must still drop.
    const outcome = limit(wants(70, true), 70, LONG_AGO, NOW);

    assert.equal(outcome.level, CONTROL.sleepMaxLevel);
    assert.equal(outcome.write, true);
  });

  it('drops in one move rather than one step per dwell', () => {
    const outcome = limit(wants(80, true), 80, LONG_AGO, NOW);

    assert.equal(outcome.level, 50);
  });

  it('bypasses the dwell timer entirely', () => {
    // A hard requirement does not wait on a rate limiter.
    const outcome = limit(wants(70, true), 70, NOW.subtract({ minutes: 1 }), NOW);

    assert.equal(outcome.level, 50);
    assert.equal(outcome.write, true);
  });

  it('does not restart the dwell clock', () => {
    // Otherwise the drop at 22:00 delays the genuine walk down that follows it
    // by ten minutes, for nothing.
    const lastChangeAt = NOW.subtract({ minutes: 5 });

    const outcome = limit(wants(30, true), 70, lastChangeAt, NOW);

    assertDeepEqual(outcome.lastChangeAt, lastChangeAt);
  });

  it('changes nothing when demand is already below it', () => {
    const outcome = limit(wants(30, true), 30, LONG_AGO, NOW);

    assert.equal(outcome.level, 30);
    assert.equal(outcome.write, false);
  });

  it('still allows a rise up to the cap while asleep', () => {
    const outcome = limit(wants(80, true), 20, LONG_AGO, NOW);

    assert.equal(outcome.level, 50);
    assert.equal(outcome.write, true);
  });

  it('clamps the output and never the demand behind it', () => {
    // After eight capped hours, leaving quiet hours returns the unit to whatever
    // demand actually is — no catch-up, no surprise, because the cap was only
    // ever a clamp.
    const capped = limit(wants(80, true), 50, LONG_AGO, NOW);
    const released = limit(wants(80, false), capped.level, capped.lastChangeAt, NOW.add({ minutes: 1 }));

    assert.equal(capped.level, 50);
    assert.equal(released.level, 80);
  });

  it('says which level it pulled back, and from where', () => {
    const outcome = limit(wants(80, true), 80, LONG_AGO, NOW);

    assert.match(outcome.reasons.join(' '), /80%/);
    assert.match(outcome.reasons.join(' '), /50%/);
  });
});

describe('reasoning', () => {
  it('carries the decision reasons through to the outcome', () => {
    // A decision you cannot explain after the fact is a decision you cannot
    // debug, so the policy's reasoning travels with the limiter's.
    const outcome = limit(wants(80), 20, LONG_AGO, NOW);

    assert.ok(outcome.reasons.includes('because the test said so'));
    assert.ok(outcome.reasons.length > 1);
  });
});
