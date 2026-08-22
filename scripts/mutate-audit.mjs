/**
 * Break the audit trail on purpose, and check the tests notice.
 *
 * Not a security boundary: nothing decides access here. What it decides is
 * whether an operator can find out what they changed, which matters most in the
 * situation the table exists for, when somebody wants to know what happened and
 * the answer is not in anybody's memory.
 *
 * Two of these are about what it deliberately does not record. That is a choice
 * with a cost written into the module comment, and a mutation is the right way
 * to hold it: adding a value column later should break something that says why
 * it was left out, rather than sliding in as an improvement.
 *
 * Usage: node scripts/mutate-audit.mjs
 */

import { runMutations } from './mutation-runner.mjs';

const TARGET = 'src/db/audit.ts';

const MUTATIONS = [
  {
    // The whole trade, reversed. It reads as a better log and it puts a second
    // copy of customer data in a table nobody thinks about, outliving every
    // deletion made in the table it shadows.
    name: 'the old and new values recorded after all',
    file: TARGET,
    expect: 'the column list test',
    find: /'INSERT INTO _audit_log \(at, lane, action, subject, detail\) '/,
    replace: "'INSERT INTO _audit_log (at, lane, action, subject, detail, old_value) '",
  },
  {
    // A Worker's clock is frozen between I/O and two machines have no reason to
    // agree, so an entry timed by the caller orders wrongly against every other
    // lane's.
    name: 'the time taken from the caller instead of the database',
    file: TARGET,
    expect: 'the database clock test',
    find: /'VALUES \(unixepoch\(\), \?1, \?2, \?3, \?4\)',/,
    replace: "'VALUES (?5, ?1, ?2, ?3, ?4)',",
  },
  {
    // STRICT is what refuses a time that is not a number, and G8 measured that
    // it accepts a string which converts cleanly, so dropping it is not obvious
    // from the outside.
    name: 'the table no longer STRICT',
    file: TARGET,
    expect: 'the STRICT refusal test',
    find: /\) STRICT`;/,
    replace: ')`;',
  },
  {
    // A row naming nothing is not an entry. Without NOT NULL it is storable.
    name: 'the subject allowed to be null, so an entry can name nothing',
    file: TARGET,
    expect: 'the null subject test',
    find: /subject {2}TEXT {4}NOT NULL,/,
    replace: 'subject  TEXT,',
  },
  {
    // The index is a bill rather than a nicety: D1 charges for rows scanned, and
    // reading a log means reading it newest first.
    //
    // ⚠️ Indexed on the wrong column rather than removed. The first version of
    // this replaced the statement with an empty string, which made
    // `prepare('')` throw and killed the mutation in twelve tests that have
    // nothing to say about indexes. A mutation that dies of an unrelated injury
    // reports coverage that is not there.
    name: 'the index put on the wrong column, so reading newest first scans',
    file: TARGET,
    expect: 'a test that reads the schema, if one exists',
    find: /ON _audit_log \(at DESC\)'/,
    replace: "ON _audit_log (lane)'",
  },
  {
    // Two rows of one table would render the same way, so a person looking for
    // a change they remember making cannot tell which row it was.
    name: 'the row key dropped from the subject, leaving only the table',
    file: TARGET,
    expect: 'the subject naming tests',
    find: /return parts\.length === 0 \? table : `\$\{table\}\[\$\{parts\.join\(','\)\}\]`;/,
    replace: 'return table;',
  },
];

await runMutations({
  files: [TARGET],
  suites: ['src/db/audit.test.ts'],
  mutations: MUTATIONS,
});
