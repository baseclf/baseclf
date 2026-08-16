/**
 * Break the batched catalogue loader, and check the tests notice.
 *
 * 🔴 This file is where a wrong answer is worst. The catalogue is what every
 * identifier is matched against, and DQS is on, so a catalogue that hands one table
 * another table's columns does not raise: it answers a column that does not exist
 * with the string of its own name, for every row. `rules/00` §I6 is the invariant and
 * this loader is its foundation.
 *
 * The mutations are all about the seam that batching introduced: results come back
 * matched to statements by position, three per table, and every one of these breaks
 * that correspondence in a way that still produces a plausible catalogue.
 *
 * Usage: node scripts/mutate-introspect-batch.mjs
 */

import { runMutations } from './mutation-runner.mjs';

const FILE = 'src/db/introspect.ts';

const MUTATIONS = [
  {
    // Off by one across the whole table list: every table gets the previous table's
    // index list read as its columns. Plausible, and completely wrong.
    name: 'the column statement of each table read one slot early',
    file: FILE,
    expect: 'the gives-every-table-its-own test',
    find: /const columnRows = \(tableRows\[at \* 3\] \?\? \[\]\) as PragmaTableInfoRow\[\];/,
    replace: 'const columnRows = (tableRows[at * 3 + 1] ?? []) as PragmaTableInfoRow[];',
  },
  {
    // The foreign keys and the index list swapped. Both are lists of objects, so
    // nothing about the shape complains.
    name: 'the foreign key and index statements swapped',
    file: FILE,
    expect: 'the gives-every-table-its-own test',
    find: /const fkRows = \(tableRows\[at \* 3 \+ 2\] \?\? \[\]\) as PragmaForeignKeyListRow\[\];/,
    replace: 'const fkRows = (tableRows[at * 3 + 1] ?? []) as PragmaForeignKeyListRow[];',
  },
  {
    // The index members never advance, so every index reports the first one's columns.
    // On a table with two indexes that is a lint that points at the wrong column.
    name: 'the index member cursor never advancing',
    file: FILE,
    expect: 'the reads-each-index-its-own-members test',
    find: /\n {6}indexAt \+= 1;/,
    replace: '',
  },
  {
    // 🔴 The count check removed. A batch that answers short then shifts every table
    // after the gap, and the loader walks it anyway.
    name: 'a short batch answer walked instead of refused',
    file: FILE,
    expect: 'the refuses-a-batch-with-the-wrong-number test',
    find: / {4}if \(results\.length !== statements\.length\) \{/,
    replace: '    if (false) {',
  },
  {
    // The fallback removed, so a D1 that refuses PRAGMA in a batch produces an empty
    // catalogue rather than a slower one. Empty is not degraded: it means every
    // identifier is unknown and the deployment refuses everything.
    name: 'a refused batch answered with no tables at all',
    file: FILE,
    expect: 'the builds-the-identical-catalogue-when-refused test',
    find: / {4}const rows: R\[\]\[\] = \[\];/,
    replace: '    return [];\n    const rows: R[][] = [];',
  },
  {
    // The guard dropped from the batched path. Every statement here is built from
    // PRAGMA output rather than from a request, so this is defence in depth, and the
    // invariant is "every path to D1 is guarded" rather than "every path but one".
    name: 'the executable guard skipped on the batched statements',
    file: FILE,
    expect: 'nothing, and that is recorded rather than hidden',
    find: / {2}for \(const statement of statements\) \{\n {4}assertExecutable\(\{ sql: statement, parameters: \[\] \}\);\n {2}\}/,
    replace: '',
    knownSurvivor:
      'nothing reaches this function with a statement a guard would reject. They are ' +
      'built here from PRAGMA output, never from a request, so no test can supply one ' +
      'without calling a private function directly. The guard is there for the day ' +
      'somebody adds a parameter, which is the day it stops surviving.',
  },
];

await runMutations({
  files: [FILE],
  suites: [
    'src/db/introspect.test.ts',
    'src/rest/allowlist.test.ts',
    'src/policy/validate.test.ts',
  ],
  mutations: MUTATIONS,
});
