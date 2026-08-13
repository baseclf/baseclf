/**
 * Break the four read-only tools, and check the tests notice.
 *
 * These tools were shipped with seventeen tests and no mutation run at all, which
 * is the one arrangement this project has already been burned by: six of the
 * eleven mistakes caught in an earlier session came from mutations rather than
 * from re-reading the code. Two of the filters below had no test of any kind when
 * this file was written, so the first thing it measured was its own test suite.
 *
 * What a tool leaks is not what a tool crashes on. Every mutation here keeps the
 * tools working and changes only what comes back, because that is the failure
 * shape: an answer that is still an answer and says one thing too many.
 *
 * Usage: node scripts/mutate-mcp-tools.mjs
 */

import { runMutations } from './mutation-runner.mjs';

const DESCRIBE = 'src/mcp/tools/schema-describe.ts';
const LINT = 'src/mcp/tools/policy-lint.ts';
const LIST = 'src/mcp/tools/policy-list.ts';
const RESULT = 'src/mcp/tools/result.ts';

const MUTATIONS = [
  {
    // The filter that had no test when this file was written. A foreign key is a
    // way back to a table the listing withholds, through a field nobody reads as
    // a table listing.
    name: 'schema_describe reporting a foreign key into an engine table',
    file: DESCRIBE,
    expect: 'the never-reports-a-foreign-key-into-an-engine-table test',
    find: /\n {12}\.filter\(\(key\) => !isReservedTableName\(key\.referencesTable\)\)/,
    replace: '',
  },
  {
    // The other half of the pair. A filter that drops everything also passes a
    // test that only checks the engine table is absent, so the positive test is
    // what keeps the first mutation honest.
    name: 'schema_describe reporting no foreign keys at all',
    file: DESCRIBE,
    expect: 'the reports-a-foreign-key-into-another-application-table test',
    find: /foreignKeys: info\.foreignKeys\n/,
    replace: 'foreignKeys: []\n',
  },
  {
    name: 'schema_describe dropping its second reserved-name check',
    file: DESCRIBE,
    expect: 'nothing, and that is recorded rather than hidden',
    find: /if \(info === undefined \|\| info\.isSystem \|\| isReservedTableName\(name\)\) \{/,
    replace: 'if (info === undefined) {',
    knownSurvivor:
      '`resolveTable` refuses every reserved name before this line is reached, and the ' +
      'catalogue sets `isSystem` from `isReservedTableName`, so all three conditions ' +
      'answer the same question and no behavioural test can separate them. Invariant I8 ' +
      'asks for independent checks precisely so that one of them may be redundant today. ' +
      'The allow list has its own test on its own contract, which is where the mutation ' +
      'that reopens this hole dies: see mutate-reserved-tables.mjs.',
  },
  {
    // The second filter that had no test. A finding does not have to be about the
    // table being linted: `_exists` moves it to the target.
    name: 'policy_lint reporting a finding that names an engine table',
    file: LINT,
    expect: 'the withholds-a-finding-that-names-an-engine-table test',
    find: /const findings = all\.filter\(\(finding\) => !isReservedTableName\(finding\.table\)\);/,
    replace: 'const findings = all;',
  },
  {
    // Dropping findings silently is the quiet version of the same bug: the tool
    // still answers, and the answer reads as a clean bill of health.
    name: 'policy_lint withholding findings without saying so',
    file: LINT,
    expect: 'the withholds-a-finding test, on the count rather than on the findings',
    find: /withheld: all\.length - findings\.length,/,
    replace: 'withheld: 0,',
  },
  {
    name: 'policy_lint dropping its table-level reserved check',
    file: LINT,
    expect: 'nothing, and that is recorded rather than hidden',
    find: /\n {10}\.filter\(\(definition\) => !isReservedTableName\(definition\.table\)\)/,
    replace: '',
    knownSurvivor:
      '`loadRegistry` drops a reserved row before it is parsed, so `registry.definitions` ' +
      'cannot contain one and this filter never has anything to remove. It is the second ' +
      'independent check invariant I8 asks for. The finding-level filter above it is a ' +
      'different question and is killed, because `_exists` puts a table into a finding ' +
      'without that table ever having a policy document.',
  },
  {
    // 🔴 The invariant gap itself, written as one line. A predicate carries tenant
    // ids, org ids and allowlisted domains that invariant I9 does not cover,
    // because I9 is about bound parameters at query time and these were baked in
    // when the document was written.
    name: 'policy_list publishing the predicate',
    file: LIST,
    expect: 'the never-reports-a-predicate test',
    find: / {16}hasCheck: policy\.check !== null,\n/,
    replace:
      '                hasCheck: policy.check !== null,\n                using: policy.using,\n',
  },
  {
    name: 'policy_list dropping its table-level reserved check',
    file: LIST,
    expect: 'nothing, and that is recorded rather than hidden',
    find: /\n {10}\.filter\(\(definition\) => !isReservedTableName\(definition\.table\)\)/,
    replace: '',
    knownSurvivor:
      'same reason as the lint filter: the loader already dropped the row. ⚠️ Worth ' +
      'reading with the test named "never reports a table the engine owns", which ' +
      'passes for a reason weaker than its name suggests. It registers a document for ' +
      '`account` and the loader refuses it, so the test proves the loader rather than ' +
      'this filter. The name is aspirational; the coverage is real but lives elsewhere.',
  },
  {
    // The fence is what tells a model that table and column names out of somebody
    // else's database are data. Removing it leaves every tool working.
    name: 'the untrusted-data fence removed from every tool answer',
    file: RESULT,
    expect: 'the is-fenced-as-untrusted-data test',
    find: /wrapWithUntrustedDataBoundary\(JSON\.stringify\(structured, null, 2\)\)/,
    replace: 'JSON.stringify(structured, null, 2)',
  },
  {
    // `detail` is written for logs. Publishing it turns one refusal into three
    // distinguishable ones, which is invariant I5 defeated by a field rather than
    // by a status.
    name: 'a refusal carrying the server-side detail',
    file: RESULT,
    expect: 'the says-nothing-about-why test, and the three-refusals-look-identical test',
    find: /\? error\.toResponseBody\(\)/,
    replace: '? { ...error.toResponseBody(), detail: error.detail }',
  },
];

await runMutations({
  files: [DESCRIBE, LINT, LIST, RESULT],
  suites: ['src/mcp/tools/tools.test.ts'],
  mutations: MUTATIONS,
});
