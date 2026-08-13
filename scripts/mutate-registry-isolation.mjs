/**
 * Reopen the outage, and check the tests notice.
 *
 * 🔴 The behaviour these guard was decided rather than discovered. Measured on
 * 2026-08-13: one enabled policy document that failed validation threw inside
 * `loadRegistry`, nothing caught it, and `/rest/v1/*` failed for every table on
 * the deployment. Two neighbouring cases were already contained on purpose, with
 * the reason written in the file; the third was not. The owner decided on
 * 2026-08-14 that it should be contained the same way.
 *
 * Every mutation below is a way of putting one bad document back in charge of
 * every other table. None of them leaks: the direction was fail-closed before
 * and after, and what is at stake is how far a single mistake reaches.
 *
 * Usage: node scripts/mutate-registry-isolation.mjs
 */

import { runMutations } from './mutation-runner.mjs';

const REGISTRY = 'src/policy/registry.ts';

const MUTATIONS = [
  {
    // 🔴 The outage itself, restored in one line. The catch stops containing
    // anything and every document failure is fatal again.
    name: 'a document failure taking the whole registry down again',
    file: REGISTRY,
    expect: 'the drops-an-enabled-document test, and the malformed-JSON test',
    find: / {6}if \(!\(cause instanceof PolicyError\)\) throw cause;/,
    replace: '      throw cause;',
  },
  {
    // The quiet version: the table vanishes and nothing anywhere says so. An
    // operator would see a table that simply stopped existing.
    name: 'dropping a table without saying which one, or why',
    file: REGISTRY,
    expect: 'the says-out-loud-which-table-it-dropped test',
    find: / {6}logEvent\(\{\n {8}event: 'error',/,
    replace: "      ((x) => x)({\n        event: 'error',",
  },
  {
    // `parseJson` wraps every JSON failure in a PolicyError, and that wrapping is
    // load-bearing rather than cosmetic: the catch above only contains
    // PolicyError, so an unwrapped SyntaxError is rethrown and the load dies.
    // This is what makes the malformed-JSON case a one-table problem.
    name: 'parseJson raising the raw parse error instead of a PolicyError',
    file: REGISTRY,
    expect: 'the malformed-JSON test',
    find: / {4}throw new PolicyError\('INVALID_EXPR', 500, \{/,
    replace: "    throw cause;\n    throw new PolicyError('INVALID_EXPR', 500, {",
  },
  {
    // Catching everything rather than document failures only. Recorded rather
    // than deleted: see the note beside the line it targets.
    name: 'the catch swallowing failures that are not about the document',
    file: REGISTRY,
    expect: 'nothing, and that is recorded rather than hidden',
    find: /if \(!\(cause instanceof PolicyError\)\) throw cause;/,
    replace: 'if (false) throw cause;',
    knownSurvivor:
      'nothing reachable inside that block throws anything but a PolicyError today. ' +
      'The three functions it calls raise PolicyError and only PolicyError, and parseJson ' +
      'catches everything JSON.parse can raise and rewraps it, which the mutation above ' +
      'proves by removing the wrapping and dying. The catalogue is built before the loop, ' +
      'so a failure loading it never arrives here. A test for this would have to reach a ' +
      'path that does not exist. The guard is for the next call added to the block.',
  },
];

await runMutations({
  files: [REGISTRY],
  suites: [
    'src/policy/registry.test.ts',
    'src/policy/security.test.ts',
    'src/db/reserved-tables.test.ts',
  ],
  mutations: MUTATIONS,
});
