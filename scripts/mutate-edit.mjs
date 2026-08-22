/**
 * Break the row edit on purpose, and check the tests notice.
 *
 * This is the first lane in the project that writes application data on behalf
 * of somebody clicking, on a database with no interactive transaction and a
 * restore that works a database at a time. Its defences are mostly of the kind
 * that make a bad state unrepresentable rather than checking for it, and those
 * are the ones worth mutating hardest: "there is no rule against updating every
 * row, a filter simply cannot be expressed" is only true while nothing in the
 * request reaches the WHERE.
 *
 * The audit floor is in here too. It is not a security boundary, but it is the
 * difference between a change that is recorded and one that is not, and it
 * already failed once against a real deployment while every test passed.
 *
 * Usage: node scripts/mutate-edit.mjs
 */

import { runMutations } from './mutation-runner.mjs';

const EDIT = 'cli/edit.ts';
const BRIDGE = 'cli/studio.ts';

const MUTATIONS = [
  {
    // The compare-and-swap, and the whole concurrency answer with it. Without
    // the old value in the WHERE, an edit overwrites whatever somebody else
    // wrote in the meantime and reports success.
    name: 'the old value dropped from the WHERE, so an edit always wins',
    file: EDIT,
    expect: 'the conflict tests, here and in the bridge',
    find: /`\$\{quote\(target\.name\)\} IS \?\$\{expectedNames\.length \+ 2\}`,/,
    replace: '`1 = 1`,',
  },
  {
    // `col = NULL` is NULL rather than true, so this reports a conflict on every
    // column that is currently null while nothing has changed. It passes every
    // test that only edits a column holding a value.
    name: 'IS relaxed to =, which never matches a null old value',
    file: EDIT,
    expect: 'the null old value tests',
    find: /`\$\{quote\(target\.name\)\} IS \?\$\{expectedNames\.length \+ 2\}`,/,
    replace: '`${quote(target.name)} = ?${expectedNames.length + 2}`,',
  },
  {
    // A partial composite key addresses more than one row: the one way this lane
    // could touch something nobody pointed at.
    name: 'a partial primary key accepted, addressing more than one row',
    file: EDIT,
    expect: 'the composite key tests',
    find: /if \(missing\.length > 0 \|\| extra\.length > 0\) \{/,
    replace: 'if (extra.length > 0) {',
  },
  {
    name: 'a key column allowed as the target, so a row can be moved',
    file: EDIT,
    expect: 'the key column test',
    find: /if \(target\.primaryKey\) \{/,
    replace: 'if (false) {',
  },
  {
    // Both layers of I8 at once, since a mutation that removed only one would
    // leave the other answering and look like the check was never needed.
    name: 'engine tables editable: the name check dropped',
    file: EDIT,
    expect: 'the engine table test',
    find: /if \(isReservedTableName\(request\.table\)\) return refuse\(ENGINE_TABLE_REFUSAL\);/,
    replace: 'if (false) return refuse(ENGINE_TABLE_REFUSAL);',
  },
  {
    name: 'engine tables editable: the catalogue flag ignored',
    file: EDIT,
    expect: 'the engine table test',
    find: /if \(info\.isSystem\) return refuse\(ENGINE_TABLE_REFUSAL\);/,
    replace: 'if (false) return refuse(ENGINE_TABLE_REFUSAL);',
  },
  {
    // A table with no key cannot name a row, and rowid is not a substitute
    // because it moves when the database is vacuumed.
    name: 'a table with no primary key edited anyway',
    file: EDIT,
    expect: 'the keyless table test',
    find: /if \(keyColumns\.length === 0\) \{/,
    replace: 'if (false) {',
  },
  {
    // A value typed into a browser is a string. A table that is not STRICT
    // applies affinity and stores it, so the column ends up holding text.
    name: 'the declared column type no longer checked',
    file: EDIT,
    expect: 'the value type tests',
    find: /const badNext = valueFitsColumn\(target, request\.next\);/,
    replace: 'const badNext = null;',
  },
  {
    // The quietest one here. Nothing throws, nothing looks wrong, and every
    // edit on a deployment that has not served a request goes unrecorded. This
    // is the mutation that reproduces a bug found by running the real thing.
    name: 'the audit floor removed, so a fresh database records nothing',
    file: BRIDGE,
    expect: 'the bridge edit records the change',
    find: /await ensureAuditTable\(\);/,
    replace: '',
  },
  {
    // `restExecutor` implements all() and nothing else, on purpose. Writing
    // run() here threw against a real deployment while the tests, which handed
    // the bridge a full D1Database, all passed.
    name: 'the audit write back on run(), which this transport does not have',
    file: BRIDGE,
    expect: 'the bridge edit records the change',
    find: /\.bind\(\.\.\.entry\.parameters\)\n {10}\.all\(\);/,
    replace: '.bind(...entry.parameters)\n          .run();',
  },
];

await runMutations({
  files: [EDIT, BRIDGE],
  suites: ['cli/edit.test.ts', 'cli/studio.test.ts'],
  mutations: MUTATIONS,
});
