/**
 * Remove the brakes on the reconciliation sweep, one at a time, and check the
 * tests notice.
 *
 * This is the only job in the engine that deletes rows with nobody watching, so
 * "the tests pass" is not the claim worth making about it. The claim worth making
 * is that every brake described at the top of `reconcile.ts` has been taken off
 * and shown to turn the suite red.
 *
 * Two of these are the ones that matter. Taking off the direct read turns a bad
 * listing into cascading deletions, and taking off the verification cap removes
 * the bound on every other failure mode at once. Both leave a suite that still
 * looks like it is testing something.
 *
 * Usage: node scripts/mutate-storage-reconcile.mjs
 */

import { runMutations } from './mutation-runner.mjs';

const RECONCILE = 'src/storage/reconcile.ts';
const INDEX = 'src/index.ts';

const MUTATIONS = [
  {
    // 🔴 The brake that stops a wrong listing cascading. Without it, a page that
    // came back empty for a bucket that is not empty deletes every row in range.
    name: 'the direct read skipped, so a listing alone decides a row is gone',
    file: RECONCILE,
    expect: 'the head-contradicts-the-listing test',
    find: / {8}if \(\(await bucket\.head\(row\.key\)\) === null\) \{/,
    replace: '        if (true) {',
  },
  {
    // 🔴 The bound on every other failure mode, including ones nobody has thought
    // of. Without it a single misread of the bucket empties the table.
    name: 'the verification cap removed, so one invocation may repair without bound',
    file: RECONCILE,
    expect: 'the maxVerifications test',
    find: /const DEFAULT_MAX_VERIFICATIONS = 24;/,
    replace: 'const DEFAULT_MAX_VERIFICATIONS = 1_000_000;',
    knownSurvivor:
      'the test passes maxVerifications explicitly, which is the right thing for it to ' +
      'do: the cap being honoured is the property, and the default is a judgment about ' +
      'the D1 and R2 call budgets that no test can check without asserting a number ' +
      'twice. The mutation below removes the cap itself, which is the behaviour.',
  },
  {
    name: 'the verification budget never spent, so the cap bounds nothing',
    file: RECONCILE,
    expect: 'the maxVerifications test',
    find: / {2}let verificationsLeft = maxVerifications;/,
    replace: '  let verificationsLeft = Number.MAX_SAFE_INTEGER;',
  },
  {
    // An upload writes bytes and then the row. A row younger than the grace period
    // may belong to bytes the listing was taken before.
    name: 'the grace period ignored for rows, so a fresh upload looks like drift',
    file: RECONCILE,
    expect: 'the still-inside-the-grace-period test',
    find: / {6}if \(!present\.has\(row\.key\) && readAge\(row\) >= graceSeconds\) \{/,
    replace: '      if (!present.has(row.key)) {',
  },
  {
    name: 'the grace period ignored for objects, so an in-flight upload reads as an orphan',
    file: RECONCILE,
    expect: 'the orphan-inside-the-grace-period test',
    find: / {6}if \(nowMs - object\.uploaded\.getTime\(\) < graceMs\) continue;/,
    replace: '      if (false) continue;',
  },
  {
    // A diagnostic that moved the resume point would skip the cron past a stretch
    // of the bucket, and whoever ran the diagnostic would have no reason to guess.
    name: 'a dry run writing the resume point anyway',
    file: RECONCILE,
    expect: 'the repair-is-off test',
    find: / {2}if \(repair\) await writeSweepState\(executor, afterKey, passes\);/,
    replace: '  await writeSweepState(executor, afterKey, passes);',
  },
  {
    name: 'a dry run removing rows anyway',
    file: RECONCILE,
    expect: 'the repair-is-off test',
    find: / {4}if \(repair && confirmed\.length > 0\) \{/,
    replace: '    if (confirmed.length > 0) {',
  },
  {
    // Deleting the last objects in a bucket would leave their rows unreachable by
    // any pass, forever, because every window has an upper bound from the listing.
    name: 'the unbounded tail read dropped, so rows past the last object are never seen',
    file: RECONCILE,
    expect: 'the sorts-past-every-object test',
    find: /const pageEnd: string \| null = lastObject === undefined \? null : lastObject\.key;/,
    replace:
      "const pageEnd: string | null = lastObject === undefined ? '\\uffff' : lastObject.key;",
  },
  {
    // The deployment state every deployment is actually in, because nothing outside
    // the tests applies STORAGE_SCHEMA yet.
    name: 'the storage-not-provisioned check removed, so the cron throws hourly',
    file: RECONCILE,
    expect: 'the no-storage-tables test',
    find: / {2}if \(!\(await storageIsProvisioned\(executor\)\)\) return skippedReport\(\);/,
    replace: '  void storageIsProvisioned;',
  },
  {
    name: 'a table matched by prefix rather than by its whole name',
    file: RECONCILE,
    expect: 'the no-storage-tables test',
    find: /return \(listed\.results \?\? \[\]\)\.some\(\(row\) => row\.name === OBJECTS_TABLE\);/,
    replace:
      'return (listed.results ?? []).some((row) => String(row.name).startsWith("_storage"));',
  },
  {
    // Invariant I9. A key holds a uid, so an hourly line naming whose uploads went
    // wrong is personal data accumulating where nobody decided to keep it.
    name: 'a key put into the log line',
    file: RECONCILE,
    expect: 'the names-no-key test',
    find: /`deferred=\$\{report\.recordsDeferred\} ` \+/,
    replace:
      '`deferred=${report.recordsDeferred} ` +\n    `sample=${report.orphanedObjectSample.map((o) => o.key).join(",")} ` +',
  },
  {
    name: 'a skipped report described as a clean pass',
    file: RECONCILE,
    expect: 'the describes-itself-as-skipped test',
    find: / {2}if \(!report\.ran\) return 'skipped: this deployment has no _storage_objects table';/,
    replace: '  void report;',
  },
  {
    name: 'a skipped report counted as drift',
    file: RECONCILE,
    expect: 'the not-reported-as-drift test',
    find: / {2}if \(!report\.ran\) return false;/,
    replace: '  void report;',
  },

  // The cron, where the two jobs meet. Both mutations below leave a handler that
  // still runs and still logs, which is what makes them worth guarding.
  {
    name: 'the two cron jobs sharing one failure, so one throwing skips the other',
    file: INDEX,
    expect: 'the scheduled-sweep tests',
    find: / {6}try \{\n {8}await work\(\);\n {6}\} catch \(error\) \{/,
    replace: '      try {\n        await work();\n      } catch (error) {\n        throw error;',
    // Was a knownSurvivor until 2026-08-24, on the claim that the condition
    // needed a deployment whose rate limit table is missing but whose storage
    // table is not. It never did: a Proxy over `env.DB` that throws on `prepare`
    // while `withSession` still answers is that deployment, per isolate, and the
    // test counts the second job's statements rather than trusting its silence.
  },
  {
    name: 'a failed cron job logged and then swallowed, so the platform sees success',
    file: INDEX,
    expect: 'the scheduled-sweep tests',
    find: / {4}if \(failed\.length > 0\) \{\n {6}throw new Error\(`Scheduled jobs failed: \$\{failed\.join\(', '\)\}\.`\);\n {4}\}/,
    replace: '    void failed;',
  },
];

await runMutations({
  files: [RECONCILE, INDEX],
  suites: ['src/storage/reconcile.test.ts', 'src/auth/routes.test.ts'],
  mutations: MUTATIONS,
});
