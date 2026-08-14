import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createFakeUnit } from '../src/actuator/fake.ts';
import { assertDeepEqual } from './support/deep-equal.ts';

describe('the fake unit', () => {
  it('records what it was told and reports it back', async () => {
    const unit = createFakeUnit(20);

    await unit.set(60);

    assertDeepEqual(unit.commands, [60]);
    assert.equal(await unit.read(), 60);
  });

  it('can be moved by hand, the way the wall panel moves the real one', async () => {
    const unit = createFakeUnit(40);

    unit.level = 100;

    assert.equal(await unit.read(), 100);
    assertDeepEqual(unit.commands, []);
  });

  it('surfaces a write failure rather than swallowing it', async () => {
    const unit = createFakeUnit(40);
    unit.failWrites = true;

    await assert.rejects(unit.set(50), /modbus write/);
    assertDeepEqual(unit.commands, []);
  });
});
