import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_COMMANDED_LEVEL,
  MIN_LEVEL,
  assertCommandedLevel,
  stepDown,
  toCommandedLevel,
  toLevel,
} from '../src/domain/level.ts';

describe('reading a level back from the unit', () => {
  it('accepts the wall panel levels we are not allowed to command', () => {
    // Someone can put the panel at 100. Reading that must not throw; it is a
    // fact about the world, not an error.
    assert.equal(toLevel(90), 90);
    assert.equal(toLevel(100), 100);
  });

  it('accepts every step the unit can be at', () => {
    for (const level of [20, 30, 40, 50, 60, 70, 80, 90, 100]) {
      assert.equal(toLevel(level), level);
    }
  });

  it('rejects anything that is not a step', () => {
    assert.equal(toLevel(0), undefined);
    assert.equal(toLevel(45), undefined);
    assert.equal(toLevel(110), undefined);
    assert.equal(toLevel('40'), undefined);
    assert.equal(toLevel(undefined), undefined);
    assert.equal(toLevel(Number.NaN), undefined);
  });
});

describe('the commanded ceiling', () => {
  it('refuses 90 and 100 at runtime, not only at compile time', () => {
    // Type stripping checks nothing, so the union guarantees nothing once the
    // process is running. This is the guard that survives that.
    assert.throws(() => assertCommandedLevel(90), /not a commandable level/);
    assert.throws(() => assertCommandedLevel(100), /not a commandable level/);
  });

  it('refuses values that are not steps at all', () => {
    assert.throws(() => assertCommandedLevel(0));
    assert.throws(() => assertCommandedLevel(35));
    assert.throws(() => assertCommandedLevel(Number.NaN));
  });

  it('clamps a demand above the ceiling down to it', () => {
    assert.equal(toCommandedLevel(95), MAX_COMMANDED_LEVEL);
    assert.equal(toCommandedLevel(1000), MAX_COMMANDED_LEVEL);
  });

  it('clamps a demand below the floor up to it — the unit is never off', () => {
    assert.equal(toCommandedLevel(0), MIN_LEVEL);
    assert.equal(toCommandedLevel(-40), MIN_LEVEL);
  });
});

describe('quantising the proportional band onto the seven steps', () => {
  it('rounds to the nearest step', () => {
    assert.equal(toCommandedLevel(44), 40);
    assert.equal(toCommandedLevel(46), 50);
    assert.equal(toCommandedLevel(50), 50);
  });

  it('rounds a value sitting exactly between two steps upward', () => {
    // Pinned rather than argued about: the boundary is a knife edge either way,
    // and hysteresis is what stops it mattering.
    assert.equal(toCommandedLevel(45), 50);
  });

  it('makes every single step reachable', () => {
    // The Q2 regression guard: an earlier design required targets to differ by
    // more than one step, which made 20 -> 30 and 70 -> 80 impossible.
    const reachable = [20, 30, 40, 50, 60, 70, 80].map((step) => toCommandedLevel(step));
    assert.deepEqual(reachable, [20, 30, 40, 50, 60, 70, 80]);
  });
});

describe('stepping down', () => {
  it('moves exactly one step', () => {
    assert.equal(stepDown(80), 70);
    assert.equal(stepDown(30), 20);
  });

  it('stops at the floor', () => {
    assert.equal(stepDown(MIN_LEVEL), MIN_LEVEL);
  });
});
