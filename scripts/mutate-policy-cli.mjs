/**
 * Break the policy write path, and check the tests notice.
 *
 * This is the command that decides which tables on somebody's deployment are readable
 * and by whom. Nothing else in the CLI writes a security decision into a database.
 *
 * The mutations are grouped by what they cost. The first four leave a deployment that
 * answers requests normally and is wrong about who may see what. The rest are
 * ordinary failures, loud when they happen.
 *
 * Usage: node scripts/mutate-policy-cli.mjs
 */

import { runMutations } from './mutation-runner.mjs';

const POLICY = 'cli/policy.ts';
const DOCUMENT = 'cli/policy-document.ts';

const MUTATIONS = [
  {
    // 🔴 Invariant I6. Without this the document is written whatever it says, and a
    // mistyped column becomes a predicate that stops filtering rather than an error,
    // because double-quoted strings are enabled on D1.
    name: 'the schema check skipped, so a wrong column is stored',
    file: POLICY,
    expect: 'the refuses-a-column-the-table-does-not-have test',
    find: / {4}checkAgainstSchema\(catalogue, document\.definition\);/,
    replace: '    void catalogue;',
  },
  {
    // 🔴 The registry caches compiled SQL against the version. Reusing one leaves the
    // deployment serving the policy it had before the command ran, and the command
    // reports success.
    name: 'the version reused instead of bumped',
    file: POLICY,
    expect: 'the bumps-the-version test',
    find: / {2}const version = nextVersion\(await storedVersion\(endpoint, table\)\);/,
    replace: '  const version = (await storedVersion(endpoint, table)) ?? 1;',
  },
  {
    // 🔴 The whole safety argument for having no transaction. Exposing first means an
    // interruption leaves the table reachable with half its rules, which is a state
    // that answers requests and answers them wrongly.
    name: 'the table exposed before its rules are written',
    file: DOCUMENT,
    expect: 'the closes-the-table-first test',
    find: / {4}\{ sql: 'DELETE FROM "_exposed_tables" WHERE "table_name" = \?', params: \[table\] \},\n/,
    replace: '',
  },
  {
    // 🔴 A bind nothing refers to is never exercised by parsing the document, so it
    // could hold `$auth.user.*` and be stored. It breaks the day somebody references
    // it, in a deployment, pointing at a file edited weeks earlier.
    name: 'unreferenced binds left unchecked',
    file: DOCUMENT,
    expect: 'the rejects-user-metadata-inside-an-unreferenced-bind test',
    find: / {2}for \(const name of Object\.keys\(binds\)\) \{\n {4}assertBindParses/,
    replace: '  for (const name of []) {\n    assertBindParses',
  },
  {
    // The document is parsed before anything is asked of the network, so the first
    // thing that is wrong is the thing reported. Reverting it means a document naming
    // a forbidden claim can be answered with "no such database", which is true and is
    // not the problem the reader has.
    name: 'the document parsed only after the database is found',
    file: POLICY,
    expect: 'the refuses-without-touching-the-database test',
    find: / {2}const document = verb === 'apply' \? loadDocument\(host, target \?\? '', write, style\) : null;\n {2}if \(verb === 'apply' && document === null\) return 'usage';/,
    replace: '  let document = null;',
  },
  {
    // Deleting every rule on a table with no confirmation, from a command somebody
    // may have autocompleted.
    name: 'rm proceeding without --confirm',
    file: POLICY,
    expect: 'the does-nothing-without-confirm test',
    find: / {2}if \(!confirmed\) \{/,
    replace: '  if (false) {',
  },
  {
    // A prefix match writes policies into `blog-staging` when asked for `blog`, and
    // the author finds out from the wrong deployment.
    name: 'the database matched by prefix rather than exactly',
    file: 'cli/d1-api.ts',
    expect: 'the matches-the-database-name-exactly test',
    find: / {2}return \(envelope\.result \?\? \[\]\)\.find\(\(database\) => database\.name === name\) \?\? null;/,
    replace: '  return (envelope.result ?? [])[0] ?? null;',
  },
  {
    // Invariant I1 makes the engine throw for a table with no matching policy, so
    // listing it as working reports the opposite of what a request gets.
    name: 'a table with no rules listed as working',
    file: POLICY,
    expect: 'the does-not-report-a-table-with-no-rules test',
    find: / {4}const verdict = row\.enabled === 1 && rules > 0 \? 'allow' : 'attention';/,
    replace: "    const verdict = row.enabled === 1 ? 'allow' : 'attention';",
  },
];

await runMutations({
  files: [POLICY, DOCUMENT, 'cli/d1-api.ts'],
  suites: ['cli/policy.test.ts', 'cli/policy-document.test.ts'],
  mutations: MUTATIONS,
});
