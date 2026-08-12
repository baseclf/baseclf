/**
 * Break the storage rate limit, and check the tests notice.
 *
 * Debt 70 was not a wrong limit, it was no limit: `enforceRateLimit` was called
 * inside the auth branch and nowhere else, so anybody holding a session could upload
 * in a loop. An upload is an R2 write plus a row in D1, and the object it leaves goes
 * on costing after the request ends.
 *
 * A hole like that is invisible from outside, because a path with no limit and a path
 * with a limit nobody has reached look identical. So every mutation here reopens it in
 * a different way, and each has to turn a test red.
 *
 * ⚠️ Two of them survive an assertion about the limiter itself and only die against the
 * worker. What was missing was the **wiring**, and `checkRateLimit` was correct
 * throughout, so a test that called it would have passed on the day the hole was open.
 *
 * Usage: node scripts/mutate-storage-ratelimit.mjs
 */

import { runMutations } from './mutation-runner.mjs';

const INDEX = 'src/index.ts';
const RATELIMIT = 'src/utils/ratelimit.ts';

const MUTATIONS = [
  {
    // 🔴 Debt 70 itself, put back.
    name: 'the storage path not limited at all',
    file: INDEX,
    expect: 'the refuses-a-caller-who-keeps-deleting test',
    find: / {2}const limited = await enforceStorageRateLimit\(request, env, operation, auth\);\n {2}if \(limited !== null\) return limited;\n\n/,
    replace: '',
  },
  {
    // The limit reached only on the operation somebody thought of first. Uploads are
    // the expensive one, so limiting those alone reads as the careful choice, and it
    // leaves delete and download open.
    //
    // ⚠️ A move, written as a delete and an insert (debt B3). Reversing the pair would
    // reassemble the original and mutate nothing.
    name: 'the limit applied to uploads only',
    expect: 'the refuses-a-caller-who-keeps-deleting test, which deletes',
    edits: [
      {
        file: INDEX,
        find: / {2}const limited = await enforceStorageRateLimit\(request, env, operation, auth\);\n {2}if \(limited !== null\) return limited;\n/,
        replace: '',
      },
      {
        file: INDEX,
        find: / {2}const stored = await uploadObject\(context, request\);/,
        replace:
          '  const limited = await enforceStorageRateLimit(request, env, operation, auth);\n' +
          '  if (limited !== null) return limited;\n' +
          '  const stored = await uploadObject(context, request);',
      },
    ],
  },
  {
    // One budget for both, which is the shape that looks simpler and quietly makes a
    // client that has been uploading unable to read back what it already has.
    name: 'reads and writes sharing one budget',
    expect: 'the does-not-spend-the-read-budget-on-writes test',
    edits: [
      {
        file: INDEX,
        find: /write \? 'storage_write' : 'storage_read'/,
        replace: "'storage_write'",
      },
      {
        file: INDEX,
        find: /\.\.\.\(write \? STORAGE_WRITE_LIMIT : STORAGE_READ_LIMIT\)/,
        replace: '...STORAGE_WRITE_LIMIT',
      },
    ],
  },
  {
    // 🔴 Back to counting addresses. It looks like a simplification and it is the
    // failure that hurts real users rather than attackers: carrier NAT puts thousands
    // of unrelated people behind one address, and they would take the budget from each
    // other while one account with a proxy pool keeps going.
    name: 'the identity ignored, so one address is one budget',
    file: RATELIMIT,
    expect: 'the gives-two-accounts-behind-one-address-a-budget-each test',
    find: / {2}if \(identity !== undefined && identity !== null && IDENTITY_PATTERN\.test\(identity\)\) \{/,
    replace: '  if (identity === undefined && identity !== undefined) {',
  },
];

await runMutations({
  files: [INDEX, RATELIMIT],
  suites: ['src/index.test.ts', 'src/utils/ratelimit.test.ts'],
  mutations: MUTATIONS,
});
