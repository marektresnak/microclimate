import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Where a vendor's refresh token lives: one JSON file on disk, deliberately not
 * the database. One file per vendor, named by the `path` the caller passes.
 *
 * Both vendors we poll rotate the refresh token on every refresh, so *something*
 * mutable has to hold the current one — and the database is append-only on
 * purpose, with no mutable row in it at all (see CLAUDE.md's data-model
 * section). A file also keeps a live credential out of every database backup:
 * the readings are worth copying around, a secret is not. `data/` is gitignored,
 * so it cannot be committed.
 *
 * Shared by each adapter (reads it before every refresh, writes the rotation)
 * and each onboarding route (writes the first token), which is why it is its own
 * module rather than living inside either. It was `netatmo-token.ts` until
 * 2026-08-14; Tado needed the identical thing, down to the corrupt-file rule, so
 * the module lost the vendor from its name rather than gaining a copy.
 */

export function loadRefreshToken(path: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    // No file yet is the normal first-run state, before the vendor's onboarding
    // page has been visited. Anything else — permissions, IO — is a real
    // failure to surface.
    if (isFileMissing(error)) return undefined;
    throw error;
  }

  // A corrupt file throws rather than returning undefined: undefined means
  // "there is no token here", which the caller answers either by falling back
  // to a stale environment seed or by asking for a fresh authorisation. Both
  // are worse than saying what is actually wrong, and the first is a lockout
  // wearing a fallback's clothes.
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`${path} does not hold an object`);
  }
  if (!('refreshToken' in parsed) || typeof parsed.refreshToken !== 'string') {
    throw new Error(`${path} has no refreshToken string`);
  }

  return parsed.refreshToken;
}

export function saveRefreshToken(path: string, refreshToken: string): void {
  mkdirSync(dirname(path), { recursive: true });

  // Write-then-rename, so a crash mid-write leaves the old token intact rather
  // than a truncated file. The rename is atomic on the same filesystem, and the
  // temp file sits beside the target to guarantee it is the same filesystem.
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ refreshToken }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function isFileMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
