import type { CommandedLevel, Level } from '../domain/level.ts';

/**
 * The HRV unit, behind the smallest interface that covers what the service needs.
 *
 * The two methods use different types on purpose. `read` returns `Level`,
 * because someone can put the wall panel at 90 or 100 and refusing to represent
 * that would make the real world unreportable. `set` accepts only
 * `CommandedLevel`, so commanding 90 into a restricted intake grille is a
 * compile error rather than a runtime check somebody has to remember to write.
 */
export interface VentilationUnit {
  read(): Promise<Level>;
  set(level: CommandedLevel): Promise<void>;
}
