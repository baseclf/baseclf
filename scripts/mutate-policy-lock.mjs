/**
 * Break the write lock, and check the tests notice.
 *
 * Debt F3. There is no transaction on D1 and the REST endpoint refuses bound
 * parameters when a request carries more than one statement, so a policy write is a
 * sequence of single statements. Interleave two of them and `_policies` ends up holding
 * both sets, permissive policies OR together, and the effective grant is the union of
 * two documents nobody wrote.
 *
 * ⚠️ Two things close it and only one of them looks like the fix. The lock stops the
 * common case; the guard on the statement that exposes the table stops the case where a
 * holder is delayed past its own expiry. A version with only the lock passes any test
 * that interleaves two runs quickly, which is every test somebody would think to write.
 * The mutations below remove one at a time for that reason.
 *
 * Usage: node scripts/mutate-policy-lock.mjs
 */

import { runMutations } from './mutation-runner.mjs';

const CLI = 'cli/policy.ts';
const DOCUMENT = 'cli/policy-document.ts';

const MUTATIONS = [
  {
    // 🔴 The lock never refuses, so two runs proceed together and F3 is back.
    name: 'a held lock treated as taken',
    file: CLI,
    expect: 'the refuses-before-deleting-anything test',
    find: / {2}if \(\(taken\?\.rows\.length \?\? 0\) === 0\) \{/,
    replace: '  if (false) {',
  },
  {
    // 🔴 The half that looks unnecessary. Without the guard a writer delayed past its
    // own expiry still exposes its rules, over the top of the run that overtook it.
    name: 'the expose no longer guarded on holding the lock',
    file: DOCUMENT,
    expect: 'the guards-the-expose test',
    edits: [
      {
        file: DOCUMENT,
        find: /SELECT \?, \?, \? WHERE EXISTS \(\n {2}SELECT 1 FROM "_policy_lock" WHERE "table_name" = \? AND "holder" = \?\n\)\nRETURNING "table_name"`,\n {4}params: \[table, definition\.enabled \? 1 : 0, nextVersion, table, holder\],/,
        replace:
          'VALUES (?, ?, ?)\nRETURNING "table_name"`,\n' +
          '    params: [table, definition.enabled ? 1 : 0, nextVersion],',
      },
    ],
  },
  {
    // The result of the guard never read. The insert writes nothing, D1 reports no
    // error because nothing went wrong, and the run says it succeeded.
    name: 'the guard result ignored, so an overtaken run reports success',
    file: CLI,
    expect: 'the reports-a-run-that-was-overtaken test',
    find: / {2}if \(!exposed\) \{/,
    replace: '  if (false) {',
  },
  {
    // The lock taken after the deletes. The table is closed by a run that then finds
    // out it may not continue, so a loser still costs somebody their table.
    //
    // ⚠️ A move, written as a delete and an insert (debt B3).
    name: 'the lock taken after the table is already closed',
    expect: 'the takes-the-lock-before-the-first-delete test',
    edits: [
      {
        file: CLI,
        find: / {2}const holder = host\.newId\(\);\n {2}const lock = acquireLockStatement\(table, holder\);\n {2}const \[taken\] = await runSql\(endpoint, lock\.sql, lock\.params\);\n\n/,
        replace: '',
      },
      {
        file: CLI,
        find: / {2}const version = nextVersion\(await storedVersion\(endpoint, table\)\);/,
        replace:
          '  const holder = host.newId();\n' +
          '  const lock = acquireLockStatement(table, holder);\n' +
          '  const [taken] = await runSql(endpoint, lock.sql, lock.params);\n' +
          '  const version = nextVersion(await storedVersion(endpoint, table));',
      },
    ],
  },
  {
    // Releasing anybody's lock rather than only our own. A writer that was overtaken
    // would delete the row belonging to the one that overtook it, handing the table to
    // a third while the second is still working.
    name: 'the release not checking who holds it',
    file: DOCUMENT,
    expect: 'the gives-the-lock-back-and-only-its-own test',
    find: /sql: 'DELETE FROM "_policy_lock" WHERE "table_name" = \? AND "holder" = \?',\n {4}params: \[table, holder\],/,
    replace: 'sql: \'DELETE FROM "_policy_lock" WHERE "table_name" = ?\',\n    params: [table],',
  },
  {
    // A failed write keeping the lock. The obvious next thing somebody does is run it
    // again, and they would wait out the expiry for no reason.
    name: 'a failed write leaving the lock behind',
    file: CLI,
    expect: 'the gives-the-lock-back-even-when-the-write-failed test',
    find: / {6}await releaseLock\(endpoint, table, holder\);\n {6}return 'failed';/,
    replace: "      return 'failed';",
  },
];

await runMutations({
  files: [CLI, DOCUMENT],
  suites: ['cli/policy.test.ts', 'cli/policy-document.test.ts'],
  mutations: MUTATIONS,
});
