import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createFakeUnit } from '../src/actuator/fake.ts';

describe('the fake unit', () => {
  it('records what it was told and reports it back', async () => {
    const unit = createFakeUnit(20);

    await unit.set(60);

    assert.deepEqual(unit.commands, [60]);
    assert.equal(await unit.read(), 60);
  });

  it('can be moved by hand, the way the wall panel moves the real one', async () => {
    const unit = createFakeUnit(40);

    unit.level = 100;

    assert.equal(await unit.read(), 100);
    assert.deepEqual(unit.commands, []);
  });

  it('surfaces a write failure rather than swallowing it', async () => {
    // The original C# spike swallowed Modbus exceptions in an empty catch, which
    // is exactly the behaviour the loop must be able to see.
    const unit = createFakeUnit(40);
    unit.failWrites = true;

    await assert.rejects(unit.set(50), /modbus write/);
    assert.deepEqual(unit.commands, []);
  });

  it('refuses a level above the ceiling even when the types have been stripped', async () => {
    // Reachable only from JavaScript that skipped the typecheck — which is every
    // run of the service, since Node strips types rather than compiling them.
    const unit = createFakeUnit(40);
    const bypassingTheTypes: { set(level: number): Promise<void> } = unit;

    await assert.rejects(bypassingTheTypes.set(100), /not a commandable level/);
  });
});
