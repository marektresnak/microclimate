import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { loadRefreshToken, saveRefreshToken } from '../src/sources/netatmo-token.ts';
import { assertDeepEqual } from './support/deep-equal.ts';

function temporaryPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'netatmo-token-')), 'token.json');
}

describe('the netatmo token file', () => {
  it('round-trips a token', () => {
    const path = temporaryPath();

    saveRefreshToken(path, 'abc|123');

    assert.equal(loadRefreshToken(path), 'abc|123');
  });

  it('reports no token when the file does not exist yet', () => {
    assert.equal(loadRefreshToken(temporaryPath()), undefined);
  });

  it('creates the directory if it is not there yet', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'netatmo-token-')), 'deeper', 'token.json');

    saveRefreshToken(path, 'abc');

    assert.equal(loadRefreshToken(path), 'abc');
  });

  it('keeps the file readable by the owner only', () => {
    const path = temporaryPath();

    saveRefreshToken(path, 'abc');

    assert.equal(statSync(path).mode & 0o777, 0o600);
  });

  it('a later save replaces the token', () => {
    const path = temporaryPath();

    saveRefreshToken(path, 'first');
    saveRefreshToken(path, 'second');

    assert.equal(loadRefreshToken(path), 'second');
  });

  it('a corrupt file throws rather than falling back silently', () => {
    // undefined means "use the seed token from the environment", which after
    // the first rotation is stale — the distinction is the point of this test.
    const path = temporaryPath();
    writeFileSync(path, 'not json');

    assert.throws(() => loadRefreshToken(path));
  });

  it('a file holding the wrong shape names the problem', () => {
    const path = temporaryPath();
    writeFileSync(path, JSON.stringify({ token: 'abc' }));

    assert.throws(() => loadRefreshToken(path), /no refreshToken string/);
  });

  it('writes the whole file or nothing - the temp file never lingers as the token', () => {
    const path = temporaryPath();

    saveRefreshToken(path, 'abc');

    // The rename landed: the target parses, and what it holds is the token.
    const onDisk: unknown = JSON.parse(readFileSync(path, 'utf8'));
    assertDeepEqual(onDisk, { refreshToken: 'abc' });
  });
});
