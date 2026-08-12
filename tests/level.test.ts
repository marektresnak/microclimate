import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assertCommandedLevel, toLevel } from '../src/domain/level.ts';

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
});
