/**
 * `catch` hands you `unknown`, because JavaScript lets anything be thrown. This
 * narrows it to something a log line or an error body can carry.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
