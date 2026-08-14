import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/**
 * The suite's own rules, enforced where forgetting them fails a build instead
 * of silently weakening a test.
 */
describe('test conventions', () => {
  it('never calls the node:assert deep-equality family — Temporal compares blind', () => {
    // A Temporal.Instant and a Temporal.Duration both keep their state in
    // internal slots that deepEqual cannot see, so two *different* instants —
    // or two freshness windows minutes apart — compare as deeply equal and a
    // wrong value passes without a sound. Deep equality is the only silent way
    // to get this wrong: `==` fails as not-reference-equal, and `<` throws a
    // TypeError naming `compare`. `assertDeepEqual` in support/deep-equal.ts
    // writes both types out as ISO text first and passes the rest through
    // untouched, so the rule can be total over the shapes this suite compares
    // and nobody has to judge which of them happens to carry an instant.
    //
    // The whole family is forbidden, and matched without the `assert.` prefix:
    // under node:assert/strict the strict spelling IS the same function, and
    // the named-import form has no prefix to match at all. Lower case is what
    // keeps `assertDeepEqual` from flagging itself.
    //
    // Built in halves so this file does not flag itself either.
    const forbidden = ['deepEqual' + '(', 'deepStrictEqual' + '('];
    const offenders: string[] = [];

    for (const file of testSourceFiles('tests')) {
      // The helper is the one place allowed to say it: it IS the wrapper.
      if (file.endsWith('deep-equal.ts')) continue;

      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (forbidden.some((call) => line.includes(call))) offenders.push(`${file}:${index + 1}`);
        });
    }

    assert.equal(
      offenders.length,
      0,
      `use assertDeepEqual from tests/support/deep-equal.ts instead:\n${offenders.join('\n')}`,
    );
  });
});

function testSourceFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((path) => path.endsWith('.ts'))
    .map((path) => join(root, path));
}
