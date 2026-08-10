/**
 * Break the upload path on purpose, and check the tests notice.
 *
 * The size cap here is not a byte counter, because `put` refuses a stream of
 * unknown length and a counter produces exactly that. It is the declared length
 * checked against the policy, and then a `FixedLengthStream` of that exact length
 * so the runtime refuses a caller who sends anything else. Both halves are load
 * bearing and neither is obvious, so both get mutated.
 *
 * One mutation is a regression guard for a bug this file's first version had:
 * `Promise.all` instead of `Promise.allSettled`. When the length does not match,
 * both halves fail, `all` rejects with whichever lost the race, and the caller got
 * a 500 for its own mistake.
 *
 * Usage: node scripts/mutate-storage-router.mjs
 */

import { runMutations } from './mutation-runner.mjs';

const TARGET = 'src/storage/router.ts';

const MUTATIONS = [
  {
    // Number(null) is 0, so without the refusal an upload declaring nothing gets a
    // FixedLengthStream(0) and whatever happens next is an accident.
    name: 'an upload with no Content-Length accepted instead of refused',
    file: TARGET,
    expect: 'the 411 test',
    find: /if \(header === null\) \{/,
    replace: 'if (header === null && false) {',
  },
  {
    name: 'the policy limits never consulted',
    file: TARGET,
    expect: 'the 413 and 415 tests',
    find: /assertUploadAllowed\(grant, length, contentType\);/,
    replace: 'void [grant, length, contentType];',
  },
  {
    // The bug the first version of this file actually had.
    name: 'Promise.all instead of allSettled, so the raw runtime error wins the race',
    file: TARGET,
    expect: 'the lying size tests, which must still be 400 rather than 500',
    edits: [
      {
        find: /const \[piped, stored\] = await Promise\.allSettled\(\[piping, storing\]\);/,
        replace:
          'const [piped, stored] = (await Promise.all([piping, storing]).then(\n' +
          '    (values) => values.map((value) => ({ status: "fulfilled", value })),\n' +
          '  ));',
      },
    ],
  },
  {
    name: 'the declared length ignored, and a huge bound used instead',
    file: TARGET,
    expect: 'the lying size tests',
    find: /const bounded = new FixedLengthStream\(length\);/,
    replace: 'const bounded = new FixedLengthStream(Number.MAX_SAFE_INTEGER);',
  },
  {
    name: 'every failed write blamed on the caller',
    file: TARGET,
    expect: 'the failure that is not the caller test',
    find: /if \(isLengthMismatch\(piped, stored\)\) \{/,
    replace: 'if (true) {',
  },
  {
    name: 'the download headers passed through instead of rebuilt from the closed list',
    file: TARGET,
    expect: 'the crafted header test',
    find: /return new Response\(object\.body, \{ status: 200, headers: safe \}\);/,
    replace: 'return new Response(object.body, { status: 200, headers });',
  },
  {
    name: 'a negative Content-Length accepted',
    file: TARGET,
    expect: 'the negative length test, which this mutation is the reason for',
    find: /if \(!Number\.isSafeInteger\(length\) \|\| length < 0\) \{/,
    replace: 'if (!Number.isSafeInteger(length)) {',
  },
];

await runMutations({
  files: [TARGET],
  suites: ['src/storage/router.test.ts'],
  mutations: MUTATIONS,
});
