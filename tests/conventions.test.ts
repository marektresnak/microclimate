import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/**
 * The suite's own rules, enforced where forgetting them fails a build instead
 * of silently weakening a test.
 */
describe('test conventions', () => {
  it('never calls node:assert deepEqual directly — instants would compare blind', () => {
    // A Temporal.Instant keeps its state in internal slots that deepEqual
    // cannot see, so two *different* instants compare as deeply equal and a
    // wrong timestamp passes without a sound. `assertDeepEqual` in
    // support/deep-equal.ts writes instants out as ISO strings first and
    // passes everything else through untouched, which makes it a drop-in
    // superset — so the rule can be total: no test calls the bare assertion,
    // and nobody has to judge whether a shape happens to carry an instant.
    //
    // Built in two halves so this file does not flag itself.
    const forbidden = 'assert.deepEqual' + '(';
    const offenders: string[] = [];

    for (const file of testSourceFiles('tests')) {
      // The helper is the one place allowed to say it: it IS the wrapper.
      if (file.endsWith('deep-equal.ts')) continue;

      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (line.includes(forbidden)) offenders.push(`${file}:${index + 1}`);
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
