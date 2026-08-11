/**
 * Break `baseclf secret set`, and check the tests notice.
 *
 * This command handles the one kind of value the project has decided never to
 * print, never to accept on a command line, and never to echo back out of an error.
 * Each of those is one line of code, and each failure is silent: the command still
 * works, the secret still gets set, and the leak is somewhere nobody looks until
 * a screenshot or a CI log turns up with it in.
 *
 * The two that matter most are the argv refusal and the redaction. The first is the
 * difference between a secret that is private and one that is in `ps`, the shell
 * history, and the CI log. The second is what stops Cloudflare's own error text
 * handing the value back to a terminal.
 *
 * Usage: node scripts/mutate-secret.mjs
 */

import { runMutations } from './mutation-runner.mjs';

const SECRET = 'cli/secret.ts';

const MUTATIONS = [
  {
    // 🔴 The whole reason the value comes from stdin. A command line is readable by
    // every process on the machine, and the shell writes it to a history file.
    name: 'a value-bearing flag accepted rather than refused',
    file: SECRET,
    expect: 'the value-on-the-command-line tests',
    find: / {6}if \(VALUE_BEARING\.includes\(flag\)\) return \{ ok: false, lines: valueOnCommandLine\(\) \};/,
    replace: '      void VALUE_BEARING;',
  },
  {
    // The likely thing somebody types is `secret set KEY the-value`. Treating it as
    // a stray argument costs them a leaked secret they never hear about.
    name: 'a second bare argument ignored instead of read as a leaked value',
    file: SECRET,
    expect: 'the second-bare-argument test',
    find: / {4}return \{ ok: false, lines: valueOnCommandLine\(\) \};\n {2}\}\n\n {2}if \(key === undefined\) \{/,
    replace: '    continue;\n  }\n\n  if (key === undefined) {',
  },
  {
    // 🔴 Cloudflare may echo a rejected value back in its error text, and that text
    // goes to a terminal.
    name: 'the value left in the text of a failure',
    file: SECRET,
    expect: 'the canary tests on failure output',
    find: / {2}return text\.split\(value\)\.join\('\[value hidden\]'\);/,
    replace: '  return text;',
  },
  {
    // A marker whose width follows the value hands back the length, which is the
    // thing `cli/token.ts` refuses to print for exactly the same reason.
    name: 'the redaction marker made as wide as the value it replaced',
    file: SECRET,
    expect: 'a test that the marker does not encode the length',
    find: /join\('\[value hidden\]'\);/,
    replace: "join('*'.repeat(value.length));",
  },
  {
    // Some authentication failures arrive as 200 with `success: false`, so the
    // status alone decides nothing was wrong at the moment the advice is worth most.
    name: 'a credential refusal judged by HTTP status alone',
    file: SECRET,
    expect: 'the refusal-arrives-as-200 test for secrets',
    find: / {2}return cause\.codes\.some\(\(code\) => CREDENTIAL_CODES\.includes\(code\)\) \? 403 : cause\.status;/,
    replace: '  return cause.status;',
  },
];

await runMutations({
  files: [SECRET],
  suites: ['cli/secret.test.ts'],
  mutations: MUTATIONS,
});
