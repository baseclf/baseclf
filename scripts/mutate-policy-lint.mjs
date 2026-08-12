/**
 * Break the linter, and check the tests notice.
 *
 * Debt 4. D1 bills for rows **scanned**, not rows returned, so a policy column with no
 * index is a line on a bill on every request for as long as the policy exists. The
 * author has nowhere else to see that, which is why `rules/01` section D calls this a
 * feature rather than a nice-to-have.
 *
 * ⚠️ A broken linter is silent, and silence is what a correct one looks like most of
 * the time. Every mutation here makes it quieter rather than louder, because that is
 * the direction it fails in.
 *
 * One of them makes it **noisier**, and that is deliberate too: a warning that fires on
 * something an index cannot help is worse than no warning, since it spends the reader's
 * trust on advice that costs writes and changes no reads.
 *
 * Usage: node scripts/mutate-policy-lint.mjs
 */

import { runMutations } from './mutation-runner.mjs';

const LINT = 'src/policy/lint.ts';
const CLI = 'cli/policy.ts';

const MUTATIONS = [
  {
    // 🔴 The whole check, gone. Nothing else in the product measures scan cost.
    name: 'unindexed columns never reported',
    file: LINT,
    expect: 'the names-an-unindexed-column test',
    find: / {4}if \(catalogue\.isIndexed\(use\.table, use\.column\)\) continue;/,
    replace: '    if (true) continue;',
  },
  {
    // The opposite failure, and the one that reads as thorough. Reporting a column
    // that is already indexed teaches the reader to stop reading the warnings.
    name: 'every column reported, indexed or not',
    file: LINT,
    expect: 'the says-nothing-about-a-column-that-is-already-indexed test',
    find: / {4}if \(catalogue\.isIndexed\(use\.table, use\.column\)\) continue;/,
    replace: '    if (false) continue;',
  },
  {
    // 🔴 Found by a test rather than by review. In a correlated subquery the outer
    // column is a value read from the row the scan already holds, not a key anything
    // is looked up by, so an index on it costs writes and changes no reads.
    name: 'the outer column of a subquery treated as a search key',
    file: LINT,
    expect: 'the says-nothing-about-the-outer-column test',
    edits: [
      {
        file: LINT,
        find: / {4}case 'compare':\n {6}state\.uses\.push\(\{/,
        replace:
          "    case 'compare':\n" +
          "      if (predicate.value.kind === 'outerColumn' && state.outer !== null) {\n" +
          '        state.uses.push({\n' +
          '          table: state.outer,\n' +
          '          column: predicate.value.column,\n' +
          '          negated: false,\n' +
          '        });\n' +
          '      }\n' +
          '      state.uses.push({',
      },
    ],
  },
  {
    // The joined table attributed outwards. It reports a column on the wrong table and
    // stays quiet about the one that decides whether the subquery is a lookup or a
    // scan of somebody's whole membership table.
    name: 'a subquery column attributed to the outer table',
    file: LINT,
    expect: 'the checks-the-column-on-the-joined-table test',
    find: / {8}table: predicate\.table,\n {8}outer: state\.table,/,
    replace: '        table: state.table,\n        outer: state.table,',
  },
  {
    // NULL rows dropped without anybody being told. Fails closed, so not a leak: an
    // author seeing fewer rows than they wrote a policy for, with nothing to point at.
    name: 'the nullable _neq warning never fired',
    file: LINT,
    expect: 'the warns-that-_neq-on-a-nullable-column test',
    find: / {4}if \(!use\.negated\) continue;/,
    replace: '    if (true) continue;',
  },
  {
    // The wiring rather than the linter. A correct linter nobody calls is the same
    // silence as no linter, which is the shape debt 70 had in the storage path.
    name: 'apply never running the linter',
    file: CLI,
    expect: 'the warns-on-apply test',
    find: / {2}writeFindings\(lintTable\(catalogue, document\.definition\), write, style\);/,
    replace: '  void lintTable;',
  },
  {
    // 🔴 The duplicate remedy, which is how it shipped for an hour. Two policies on
    // the same column both printed the same `CREATE INDEX`, and the reader who copies
    // both gets an error from D1 on the second. Found by running the command; every
    // test looked for the statement and none counted them.
    name: 'the same statement printed once per policy',
    file: CLI,
    expect: 'the one-statement-per-index test',
    find: / {4}if \(finding\.remedy !== undefined && !printed\.has\(finding\.remedy\)\) \{/,
    replace: '    if (finding.remedy !== undefined) {',
  },
  {
    // The remedy indented, which is the one failure that looks like nothing. It reads
    // correctly on screen and does not survive a double-click, and whoever pastes the
    // spaces gets a syntax error from D1 with nothing to explain it.
    name: 'the remedy indented like a note',
    file: CLI,
    expect: 'the statement-that-can-be-pasted-as-it-is test',
    find: / {6}write\(copyable\(finding\.remedy\)\);/,
    replace: '      write(note(finding.remedy));',
  },
];

await runMutations({
  files: [LINT, CLI],
  suites: ['src/policy/lint.test.ts', 'cli/policy.test.ts'],
  mutations: MUTATIONS,
});
