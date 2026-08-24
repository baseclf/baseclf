/**
 * Take the schema bootstrap away, and check the tests notice.
 *
 * This exists because of a failure nothing noticed for four slices: `POLICY_SCHEMA`
 * and `STORAGE_SCHEMA` were declared, imported by fixtures, and applied to no real
 * database ever. Every suite was green the whole time, because every suite created
 * the tables itself before using them.
 *
 * So the mutations that matter here are the ones that put that state back. If they
 * survive, the tests are once again only proving that a database somebody already
 * set up behaves correctly, which was never the thing in doubt.
 *
 * Usage: node scripts/mutate-bootstrap.mjs
 */

import { runMutations } from './mutation-runner.mjs';

const BOOTSTRAP = 'src/db/bootstrap.ts';
const INDEX = 'src/index.ts';

const MUTATIONS = [
  {
    // 🔴 The original bug, restored. Every REST request answers 500 with a D1
    // error naming an internal table, on every deployment nobody provisioned.
    name: 'the bootstrap dropped from the REST path',
    file: INDEX,
    expect: 'the unprovisioned-deployment REST tests',
    find: / {4}if \(table !== null\) \{\n {6}await ensureEngineSchemaOnce\(env\.DB\);/,
    replace: '    if (table !== null) {',
  },
  {
    name: 'the bootstrap dropped from the storage path',
    file: INDEX,
    expect: 'the unprovisioned-deployment storage test',
    find: / {6}await ensureEngineSchemaOnce\(env\.DB\);\n {6}return await handleStorage/,
    replace: '      return await handleStorage',
  },
  {
    // One round trip per statement instead of one in total, and as many places to
    // stop halfway. D1's only transaction primitive is batch(), so this is the
    // difference between all of the schema and an arbitrary prefix of it.
    name: 'the schema sent one statement at a time rather than as one batch',
    file: BOOTSTRAP,
    expect: 'the one-batch test',
    find: / {2}await executor\.batch\(statements\.map\(\(statement\) => executor\.prepare\(statement\.sql\)\)\);/,
    replace: '  for (const statement of statements) await executor.prepare(statement.sql).run();',
  },
  {
    // The guard that keeps the second run of a CLI from failing on what the first
    // run created.
    name: 'the IF NOT EXISTS check made to accept anything',
    file: BOOTSTRAP,
    expect: 'the lost-the-clause test',
    find: /return schema\.filter\(\(sql\) => !\/\\bIF\\s\+NOT\\s\+EXISTS\\b\/i\.test\(sql\)\);/,
    replace: '  return [];',
  },
  {
    name: 'a schema with an unrepeatable statement applied anyway',
    file: BOOTSTRAP,
    expect: 'the lost-the-clause test, through the applier',
    find: / {2}if \(unrepeatable\.length > 0\) \{/,
    replace: '  if (false) {',
    knownSurvivor:
      'the real schema never contains an unrepeatable statement, so this branch is ' +
      'unreachable with the constant as it stands. `unrepeatableStatements` is tested ' +
      'directly with a bad statement, which is the part that can be wrong; the throw ' +
      'around it is what happens after, and reaching it needs a schema that this ' +
      'project would have to break first. If this ever gets killed, somebody added a ' +
      'statement without the clause and the test above should have caught it sooner.',
  },
  {
    // The memo the entry point uses, mutated where it is now built rather than
    // where it used to be hand-rolled.
    //
    // ⭐ This entry was a `knownSurvivor` until 2026-08-24, and the justification
    // it carried was wrong rather than stale. It said "there is no seam for that
    // today", in a repository that had grown the seam, the helper, its test and a
    // passing mutation for it five days before that note was last edited:
    // `src/utils/memo.ts`, `src/utils/memo.test.ts` and the
    // `a failed load left in the memo` mutation in `mutate-registry-cache.mjs`,
    // which is killed.
    //
    // So the fix was not a new test. It was deleting the second copy: the entry
    // point now builds both memos with `isolateMemo`, and the behaviour is covered
    // where every other call site's is. What is mutated here is the wiring that is
    // left, which is the part this file can still be wrong about.
    name: 'the schema memo built without a label, so a cold start reports nothing',
    file: INDEX,
    expect: 'the isolate_init report, and the memo tests behind it',
    find: /const engineSchemaMemo = isolateMemo<void>\(\{ label: 'engine_schema' \}\);/,
    replace: 'const engineSchemaMemo = isolateMemo<void>();',
    knownSurvivor:
      'the label only decides whether a duration is reported, and nothing asserts ' +
      'that report from the worker entry point. `memo.test.ts` covers the reporting ' +
      'itself, so what survives here is the wiring rather than the behaviour. Unlike ' +
      'the justification this entry used to carry, that is checkable: grep the suite ' +
      'for `isolate_init` and there is no assertion on `engine_schema`.',
  },
];

await runMutations({
  files: [BOOTSTRAP, INDEX],
  suites: ['src/db/bootstrap.test.ts'],
  mutations: MUTATIONS,
});
