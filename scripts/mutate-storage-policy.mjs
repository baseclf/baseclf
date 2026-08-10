/**
 * Break the storage boundary on purpose, and check the tests notice.
 *
 * `src/storage/policy.ts` decides which key a request may touch, and several of
 * its defences work by making a bad state unrepresentable rather than by checking
 * for it. Those are the ones worth mutating hardest, because "there is no rule
 * about traversal, a name simply cannot contain a slash" is only true while the
 * character set says so, and a character set is exactly the kind of thing somebody
 * relaxes for a reason that sounds good at the time.
 *
 * Usage: node scripts/mutate-storage-policy.mjs
 */

import { runMutations } from './mutation-runner.mjs';

const TARGET = 'src/storage/policy.ts';

const MUTATIONS = [
  {
    name: 'a file name may contain a separator after all',
    file: TARGET,
    expect: 'the traversal tests',
    find: /const FILE_NAME_PATTERN = \/\^\[A-Za-z0-9\]\[A-Za-z0-9\._-\]\*\$\/;/,
    replace: 'const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\\-/]*$/;',
  },
  {
    name: 'a file name may start with a dot, so . and .. and hidden names return',
    file: TARGET,
    expect: 'the relative segment and hidden name tests',
    find: /const FILE_NAME_PATTERN = \/\^\[A-Za-z0-9\]\[A-Za-z0-9\._-\]\*\$\/;/,
    replace: 'const FILE_NAME_PATTERN = /^[A-Za-z0-9.][A-Za-z0-9._-]*$/;',
  },
  {
    name: 'the length limit relaxed tenfold',
    file: TARGET,
    expect: 'the long name test',
    find: /if \(fileName\.length > MAX_FILE_NAME_LENGTH\) \{/,
    replace: 'if (fileName.length > MAX_FILE_NAME_LENGTH * 10) {',
  },
  {
    // The quietest of the lot. Nothing throws, nothing logs, and every caller
    // without the claim shares one directory.
    name: 'a missing claim substituted instead of refused',
    file: TARGET,
    expect: 'the absent claim test',
    find: /if \(value === null \|\| value === ''\) \{/,
    replace: "if (value === null && value === '') {",
  },
  {
    name: 'a claim containing a separator trusted as it comes',
    file: TARGET,
    expect: 'the smuggled claim test',
    find: /if \(value\.includes\('\/'\)\) \{/,
    replace: 'if (false) {',
  },
  {
    name: 'fail-open: no matching policy is not a refusal',
    file: TARGET,
    expect: 'the operation and role tests',
    find: /if \(matching\.length === 0\) \{/,
    replace: 'if (matching.length < 0) {',
  },
  {
    name: 'any $auth token accepted at validate time, including user_metadata',
    file: TARGET,
    expect: 'the I4 test and the unknown token test',
    find: /if \(token in PREFIX_TOKENS\) continue;/,
    replace: "if (token.startsWith('$auth.')) continue;",
  },
  {
    name: 'the trailing separator requirement dropped',
    file: TARGET,
    expect: 'the prefix separator test',
    find: /if \(!policy\.prefix\.endsWith\('\/'\)\) \{/,
    replace: "if (false && !policy.prefix.endsWith('/')) {",
  },
  {
    // Invariant I5. A caller that can tell "not there" from "not yours" can map
    // what exists by iterating names.
    name: 'refusals made distinguishable: 403 with the reason in the message',
    file: TARGET,
    expect: 'every refusal test, and the I5 sameness test in particular',
    find: /return new PolicyError\('NO_POLICY', 404, \{ message: 'Not found\.', detail \}\);/,
    replace: "return new PolicyError('NO_POLICY', 403, { message: detail, detail });",
  },
  {
    // The opposite mistake to the ones above: too strict rather than too loose.
    // It refuses an ordinary request for a reason nobody could guess.
    name: 'over-strict: the whole content-type header compared, parameters and all',
    file: TARGET,
    expect: 'the mime parameters test',
    find: /const declared = \(declaredMimeType \?\? ''\)\.split\(';'\)\[0\]\?\.trim\(\)\.toLowerCase\(\) \?\? '';/,
    replace: "const declared = (declaredMimeType ?? '').trim().toLowerCase();",
  },
];

await runMutations({
  files: [TARGET],
  suites: ['src/storage/policy.test.ts'],
  mutations: MUTATIONS,
});
