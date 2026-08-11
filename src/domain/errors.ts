/**
 * `catch` hands you `unknown`, because JavaScript lets anything be thrown. This
 * narrows it to something a log line or an error body can carry.
 *
 * The control loop carries its own private copy from before this existed; the
 * loop is parked and deliberately untouched, so the copy stays until the loop
 * is either rewired or deleted.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
