/**
 * Break the object record on purpose, and check the tests notice.
 *
 * Two properties matter here and neither is obvious from reading the code:
 *
 *   1. **R2 is the truth, D1 follows it.** There is no transaction spanning the
 *      two, so the order is the whole design. Reversing it on upload leaves a
 *      record for an object that does not exist, and then a join returns a row
 *      whose image is a 404. Reversing it on delete leaves the BYTES in place after
 *      somebody asked for them to be deleted.
 *   2. **The record is not a permission.** An object is reachable because a policy
 *      resolved its key. If a row could grant or withhold access, the record would
 *      be a second permission system and the weaker one, because a row can be stale
 *      while a policy cannot.
 *
 * Usage: node scripts/mutate-storage-objects.mjs
 */

import { runMutations } from './mutation-runner.mjs';

const OBJECTS = 'src/storage/objects.ts';
const ROUTER = 'src/storage/router.ts';

const MUTATIONS = [
  {
    name: 'the record written even when the bytes were refused',
    file: ROUTER,
    expect: 'the ordering tests',
    edits: [
      {
        file: ROUTER,
        find: / {2}const stored = await writeBounded\(context\.bucket, grant\.key, request\.body, length, contentType\);/,
        // No `if (context.db !== undefined)` around it any more: `db` is
        // mandatory since `14f65dd`, so that guard was always true and read as
        // a condition that still existed.
        replace:
          '  await recordObject(context.db, {\n' +
          '    key: grant.key,\n' +
          '    bucket: context.bucketName,\n' +
          '    auth: context.auth,\n' +
          '    sizeBytes: length,\n' +
          '    contentType,\n' +
          '  });\n' +
          '  const stored = await writeBounded(context.bucket, grant.key, request.body, length, contentType);',
      },
    ],
  },
  {
    // The first version of this mutation did not skip anything. It read
    // `await Promise.resolve(db) && void 0 || await recordObject(...)`, and since
    // `void 0` is falsy the `||` still called it. A mutation that applies while
    // changing nothing is the same trap as one that does not apply, and the
    // exactly-once check cannot catch it.
    // ⚠️ Rewritten 2026-08-22. It used to remove an `if (context.db !==
    // undefined)` guard, and that guard is gone: `14f65dd` made `db` mandatory
    // so that "skip the record" stopped being expressible, which is the fix
    // working. The pattern went stale the same day and the full sweep has
    // refused to run since, because nobody ran it between then and now.
    name: 'the record not written at all',
    file: ROUTER,
    expect: 'the joinable row tests',
    find: /await recordObject\(context\.db, \{/,
    replace: 'await Promise.resolve({',
  },
  {
    name: 'the record not removed on delete, so a join keeps returning it',
    file: ROUTER,
    expect: 'the delete record test',
    // Two spaces, not four: the same removed guard that broke the mutation
    // above de-indented this line too.
    find: /^ {2}await forgetObject\(context\.db, grant\.key\);$/m,
    replace: '  void grant.key;',
  },
  {
    name: 'created_at overwritten on every write, losing when the object first appeared',
    file: OBJECTS,
    expect: 'the created_at preserved test',
    find: /' "bucket" = \?2, "owner" = \?3, "size_bytes" = \?4, "content_type" = \?5,' \+/,
    replace:
      '\' "bucket" = ?2, "owner" = ?3, "size_bytes" = ?4, "content_type" = ?5, "created_at" = unixepoch(),\' +',
  },
  {
    name: 'the owner left as it was, so a shared prefix records the wrong writer',
    file: OBJECTS,
    expect: 'the last writer test',
    find: /' "bucket" = \?2, "owner" = \?3, "size_bytes" = \?4, "content_type" = \?5,' \+/,
    replace: '\' "bucket" = ?2, "size_bytes" = ?4, "content_type" = ?5,\' +',
  },
  {
    // Measured 2026-08-11: this one SURVIVES, and the reason corrects a rule
    // rather than exposing a gap. A STRICT table refuses a TEXT value by whether
    // it converts losslessly, not by the declared type of the expression, so
    // `strftime('%s','now')` is stored as an integer just like `unixepoch()`.
    // `rules/01` §G8 records the probe, and the note in §G7 that implied otherwise
    // was stronger than the truth and has been corrected.
    //
    // `unixepoch()` is still the right call, for readability rather than for
    // correctness, and no test can tell the two apart because there is nothing to
    // tell apart.
    name: "strftime('%s','now') instead of unixepoch(), which returns TEXT",
    file: OBJECTS,
    expect: 'nothing, see below',
    knownSurvivor:
      'a STRICT table converts a losslessly-convertible TEXT value, so both spellings store an integer (rules/01 §G8)',
    find: /VALUES \(\?1, \?2, \?3, \?4, \?5, unixepoch\(\), unixepoch\(\)\)/,
    replace: "VALUES (?1, ?2, ?3, ?4, ?5, strftime('%s','now'), strftime('%s','now'))",
  },
  {
    name: 'a delete of an unknown key reports whether it existed',
    file: OBJECTS,
    expect: 'the forget-an-unknown-key test',
    find: / {2}const sql = 'DELETE FROM "_storage_objects" WHERE "key" = \?1';/,
    replace:
      '  const sql = \'DELETE FROM "_storage_objects" WHERE "key" = ?1 RETURNING "key"\';\n' +
      '  {\n' +
      '    const found = await executor.prepare(sql).bind(key).first();\n' +
      '    if (found === null) throw new Error(`no such object: ${key}`);\n' +
      '    return;\n' +
      '  }\n' +
      '  // biome-ignore lint/correctness/noUnreachable: mutation',
  },
];

await runMutations({
  files: [OBJECTS, ROUTER],
  suites: ['src/storage/objects.test.ts'],
  mutations: MUTATIONS,
});
