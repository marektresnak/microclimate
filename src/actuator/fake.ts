import { assertCommandedLevel } from '../domain/level.ts';
import type { CommandedLevel, Level } from '../domain/level.ts';
import type { VentilationUnit } from './unit.ts';

/**
 * A unit that records what it was told, and can be pushed around like the real
 * one. Not a mock: nothing asserts on call counts, and `level` is public so a
 * test can move it the way a person at the wall panel would.
 *
 * It also stands in for the real unit in `npm start` when no HRV_MODBUS_HOST is
 * set, which is why the failure switches are here rather than in a test file.
 */
export interface FakeVentilationUnit extends VentilationUnit {
  readonly commands: readonly CommandedLevel[];
  /** Where the unit is. Assign to it to simulate someone using the wall panel. */
  level: Level;
  failReads: boolean;
  failWrites: boolean;
}

export function createFakeUnit(startLevel: Level = 40): FakeVentilationUnit {
  const commands: CommandedLevel[] = [];

  const unit: FakeVentilationUnit = {
    commands,
    level: startLevel,
    failReads: false,
    failWrites: false,

    async read() {
      if (unit.failReads) throw new Error('modbus read timed out');
      return unit.level;
    },

    async set(level) {
      if (unit.failWrites) throw new Error('modbus write timed out');

      // The same runtime range check the Modbus adapter carries at its write
      // site. Type stripping performs no checking, so the one place a level
      // stops being a type and becomes bytes deserves a belt as well as braces.
      const checked = assertCommandedLevel(level);

      commands.push(checked);
      unit.level = checked;
    },
  };

  return unit;
}
