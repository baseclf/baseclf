/**
 * Break the login, and check the tests notice.
 *
 * Every mutation below leaves a command that finishes and prints something reassuring.
 * That is the property this file is guarding: `wrangler login` already succeeds while
 * changing nothing, and the whole reason `baseclf login` exists is to make that state
 * impossible to walk out of.
 *
 * Usage: node scripts/mutate-login.mjs
 */

import { runMutations } from './mutation-runner.mjs';

const FILE = 'cli/login.ts';

const MUTATIONS = [
  {
    // 🔴 The one the command was written for. The browser flow runs, succeeds, and the
    // token in the environment goes on being the credential everything uses.
    name: 'the browser flow started even while a token would override it',
    file: FILE,
    expect: 'the does-not-start-the-browser-flow tests',
    find: / {2}if \(shadow\.length > 0\) \{/,
    replace: '  if (false) {',
  },
  {
    // Half of the check. A `.env` wins whenever the environment is empty, which is the
    // ordinary case in a project directory.
    name: 'only the environment checked, not the .env beside it',
    file: FILE,
    expect: 'the token-in-a-.env test',
    find: / {2}const inFile = envFileHasToken\(envFile\);/,
    replace: '  const inFile = false;',
  },
  {
    // The opposite failure: an emptied or commented-out line reads as a token, so
    // somebody who has already done what they were told is told to do it again.
    name: 'an empty token line counted as a token',
    file: FILE,
    expect: 'the ignores-an-empty-token-line test',
    find: / {2}return line\.slice\(line\.indexOf\('='\) \+ 1\)\.trim\(\) !== '';/,
    replace: '  return true;',
  },
  {
    // 🔴 The half `wrangler login` already does not do. Without it the command adds
    // nothing: a reader still cannot tell which of their accounts they just got.
    name: 'the accounts never reported, so the login says nothing about where it went',
    file: FILE,
    expect: 'the reports-which-account test',
    find: / {2}for \(const account of accounts\) \{\n {4}write\(note\(`\$\{account\.name\} {2}\$\{previewId\(account\.id\)\}`\)\);/,
    replace: '  for (const account of []) {\n    write(note(`${account}`));',
  },
  {
    // Terminals end up in screenshots, and the whole id is what somebody needs to act
    // on an account.
    name: 'the whole account id printed rather than enough to recognise it',
    file: FILE,
    expect: 'the prints-only-enough-of-the-id test',
    find: / {2}return `\$\{id\.slice\(0, ID_PREVIEW_LENGTH\)\}\.\.\.`;/,
    replace: '  return id;',
  },
  {
    // An expired credential after a login means something else wrote the file, and
    // carrying on hands the next command a token that will be refused.
    name: 'a credential that cannot be read treated as a successful login',
    file: FILE,
    expect: 'the flow-finished-but-left-nothing-usable tests',
    find: / {2}if \(!credential\.ok\) \{/,
    replace: '  if (false) {',
  },
  {
    // A browser flow that was cancelled is not a login. Reporting it as one sends the
    // reader to `create`, which then fails for a reason that names something else.
    name: 'a cancelled browser flow reported as a login',
    file: FILE,
    expect: 'the did-not-finish test',
    find: / {2}if \(!\(await host\.runWranglerLogin\(\)\)\) \{/,
    replace: '  if (false) {',
  },
  {
    // The instruction that carries the half-day: removing it at user scope is not
    // enough, because a parent process keeps its own copy.
    name: 'the parent process half of the fix dropped',
    file: FILE,
    expect: 'the says-clearing-at-user-scope-is-not-enough test',
    find: /'Removing it at user scope is not enough on its own\. A parent process that started',/,
    replace: "'Clear it and try again.',",
  },
];

await runMutations({
  files: [FILE],
  suites: ['cli/login.test.ts'],
  mutations: MUTATIONS,
});
