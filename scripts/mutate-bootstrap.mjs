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
    // Nine round trips instead of one, and nine places to stop halfway. D1's only
    // transaction primitive is batch(), so this is the difference between all of
    // the schema and an arbitrary prefix of it.
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
    // A memo that is kept even when the work failed means one transient D1 error
    // on a cold isolate leaves that isolate believing the schema is there.
    name: 'the memo kept after a failure, so a transient error is remembered forever',
    file: INDEX,
    expect: 'nothing, and that is recorded rather than hidden',
    find: / {4}engineSchemaReady = null;\n {4}throw error;/,
    replace: '    throw error;',
    knownSurvivor:
      'no test makes applyEngineSchema fail transiently and then succeed. Doing it ' +
      'needs an executor that fails once, which means injecting one into the worker ' +
      'entry point, and there is no seam for that today. The same gap exists on the ' +
      'rate limit memo this was copied from, and it is the same size there.',
  },
];

await runMutations({
  files: [BOOTSTRAP, INDEX],
  suites: ['src/db/bootstrap.test.ts'],
  mutations: MUTATIONS,
});
