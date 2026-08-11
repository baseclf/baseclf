/**
 * Break the CLI on purpose, and check the tests notice.
 *
 * Two groups here, and the first is unusual for this project: the design system.
 * Its voice rules are prose, and a prose rule nobody runs is a rule that quietly
 * stops being true, so `findVoiceViolations` turns the binary half into something a
 * test checks. That checker is only worth having if removing a rule from it turns
 * something red, which is what these mutations establish.
 *
 * The second group is the doctor's judgement. Two of its decisions look like
 * politeness and are not: a fresh workers.dev URL answering 404 is not a broken
 * deployment (measured, rules/02 §C2), and a deployment nobody can sign in to is not
 * a working one, so `attention` has to count against the exit code.
 *
 * Usage: node scripts/mutate-cli.mjs
 */

import { runMutations } from './mutation-runner.mjs';

const OUTPUT = 'cli/output.ts';
const DOCTOR = 'cli/doctor.ts';
const MAIN = 'cli/main.ts';

const MUTATIONS = [
  {
    name: 'the em-dash rule removed from the voice checker',
    file: OUTPUT,
    expect: 'the em-dash test',
    find: / {4}pattern: \/\[—–\]\/u,/,
    replace: '    pattern: /\\u0000NEVER\\u0000/u,',
  },
  {
    name: 'the emoji rule removed',
    file: OUTPUT,
    expect: 'the emoji test',
    find: / {4}pattern: \/\\p\{Extended_Pictographic\}\/u,/,
    replace: '    pattern: /\\u0000NEVER\\u0000/u,',
  },
  {
    name: 'the safety-claim rule removed, which rule 00 forbids outright',
    file: OUTPUT,
    expect: 'the safety claim test',
    find: / {4}pattern:\n?\s*\/\\b\(\?:your data is safe\|100% secure\|completely secure\|cannot be hacked\|fully secure\)\\b\/iu,/,
    replace: '    pattern: /\\u0000NEVER\\u0000/u,',
  },
  {
    // The one that reads as formatting and is not. A redirect URI with two spaces in
    // front of it does not double-click cleanly, and the person who mis-pastes it
    // gets redirect_uri_mismatch with nothing in any log to explain it.
    name: 'a copyable value indented like everything else',
    file: OUTPUT,
    expect: 'the column zero tests',
    find: / {2}return `\\n\$\{value\}\\n`;/,
    replace: '  return `\\n  ${value}\\n`;',
  },
  {
    name: 'the whole line painted rather than just the mark',
    file: OUTPUT,
    expect: 'the escape-codes-around-the-mark test',
    find: / {2}return `\$\{paint\(MARK\[verdict\], verdict, style\)\} \$\{text\}`;/,
    replace: '  return paint(`${MARK[verdict]} ${text}`, verdict, style);',
  },
  {
    // The conflict this file's own checker found: '!' is the obvious attention mark
    // and the voice rule bans it. The rule is binary, so the mark changed.
    name: "the attention mark back to '!', which the voice checker refuses",
    file: OUTPUT,
    expect: 'the mark-its-own-checker-would-refuse test',
    find: / {2}attention: '▲',/,
    replace: "  attention: '!',",
  },
  {
    name: 'a fresh deployment answering 404 reported as broken',
    file: DOCTOR,
    expect: 'the propagation tests',
    find: / {2}if \(result\.status === 404 \|\| result\.status >= 500\) \{/,
    replace: '  if (false) {',
  },
  {
    name: 'a missing key set reported as something to look at rather than a fault',
    file: DOCTOR,
    expect: 'the migration-never-ran tests',
    find: / {6}name: 'keys',\n {6}verdict: 'deny',\n {6}detail:\n {8}`\/api\/auth\/jwks answered \$\{result\.status\}\. This is what a deployment whose auth `/,
    replace:
      "      name: 'keys',\n      verdict: 'attention',\n      detail:\n        `/api/auth/jwks answered ${result.status}. This is what a deployment whose auth `",
  },
  {
    name: 'a failed probe thrown rather than returned, so the first one stops the rest',
    file: DOCTOR,
    expect: 'the runs-every-check test',
    find: / {4}return \{ error: cause instanceof Error \? cause\.message : String\(cause\) \};/,
    replace: '    throw cause;',
  },
  {
    // A deployment nobody can sign in to is not a working deployment. An exit code
    // that says otherwise makes this command useless in a script, which is the one
    // place it earns its keep.
    name: 'attention counted as ok, so the exit code lies to a script',
    file: DOCTOR,
    expect: 'the attention-is-not-ok test',
    find: / {2}return \{ ok: checks\.every\(\(check\) => check\.verdict === 'allow'\), checks \};/,
    replace: "  return { ok: checks.every((check) => check.verdict !== 'deny'), checks };",
  },
  {
    name: 'a usage mistake given the same exit code as a broken deployment',
    file: MAIN,
    expect: 'the exit code tests',
    find: / {2}usage: 2,/,
    replace: '  usage: 1,',
  },
];

await runMutations({
  files: [OUTPUT, DOCTOR, MAIN],
  suites: ['cli/output.test.ts', 'cli/doctor.test.ts', 'cli/main.test.ts'],
  mutations: MUTATIONS,
});
