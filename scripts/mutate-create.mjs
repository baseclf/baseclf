/**
 * Break the onboarding decisions, and check the tests notice.
 *
 * Everything mutated here happens before a network call, and almost all of it fails
 * quietly if it is wrong. A binding named after the project deploys, reports
 * success, and answers every request with `undefined`. An origin with a path is
 * trimmed by `URL` without a word. A generated secret that is not random is a
 * signing key an attacker can guess, and nothing about the deployment looks
 * different.
 *
 * Usage: node scripts/mutate-create.mjs
 */

import { runMutations } from './mutation-runner.mjs';

const CREATE = 'cli/create.ts';

const MUTATIONS = [
  {
    // 🔴 Deploys, reports success, undefined binding at runtime, nothing to search
    // for. The same trap `cloudflare.ts` is built around, reached from this side.
    name: 'the bindings named after the project rather than what src/ reads',
    file: CREATE,
    expect: 'the binding-name tests',
    edits: [
      {
        find: /\{ kind: 'resource', type: 'd1', name: 'DB', id: databaseId \},/,
        replace: "{ kind: 'resource', type: 'd1', name: names.database, id: databaseId },",
      },
      {
        find: /\{ kind: 'resource', type: 'r2_bucket', name: 'BUCKET', id: names\.bucket \},/,
        replace: "{ kind: 'resource', type: 'r2_bucket', name: names.bucket, id: names.bucket },",
      },
    ],
  },
  {
    // Without the inherit, a redeploy drops a secret that was already set, and the
    // deployment refuses every request afterwards for a reason nothing states.
    name: 'the signing secret never inherited, so a redeploy drops it',
    file: CREATE,
    expect: 'the inherits-it-on-a-redeploy test',
    find: / {4}\.\.\.\(inheritSecret/,
    replace: '    ...(false',
  },
  {
    // 🔴 The bug that shipped in f99013a and would have broken every first
    // deployment. `bindings_inherit=strict` turns an inherit that resolves to
    // nothing into an error, and a first run has nothing to resolve it to.
    name: 'the secret inherited unconditionally, which fails every first deploy',
    file: CREATE,
    expect: 'the does-NOT-inherit-on-a-first-deploy test',
    find: / {4}\.\.\.\(inheritSecret/,
    replace: '    ...(true',
  },
  {
    // 🔴 Also from f99013a. A secret belongs to a script, so there is nothing to
    // set one on until the script exists (`rules/02` section C, steps 5 then 7).
    name: 'the secret step moved back ahead of the upload',
    file: CREATE,
    expect: 'the sets-the-secret-AFTER-uploading test',
    edits: [
      {
        find: / {2}\{ title: 'Set the signing secret', consequence: 'the engine refuses every request' \},\n/,
        replace: '',
      },
      {
        find: / {2}\{ title: 'Upload the Worker', consequence: 'nothing is deployed' \},/,
        replace:
          "  { title: 'Set the signing secret', consequence: 'the engine refuses every request' },\n" +
          "  { title: 'Upload the Worker', consequence: 'nothing is deployed' },",
      },
    ],
  },
  {
    // `URL.origin` drops the path silently, so the reader configures something they
    // did not type and finds out through a CORS error that names nothing.
    name: 'an origin with a path accepted and quietly trimmed',
    file: CREATE,
    expect: 'the refuses-an-origin-with-a-path test',
    find: / {2}if \(parsed\.origin !== value\.trim\(\)\.replace\(\/\\\/\$\/, ''\)\) \{/,
    replace: '  if (false) {',
  },
  {
    name: 'any scheme accepted, including ones a browser sends no origin for',
    file: CREATE,
    expect: 'the scheme test',
    find: / {2}if \(parsed\.protocol !== 'http:' && parsed\.protocol !== 'https:'\) \{/,
    replace: '  if (false) {',
  },
  {
    // 🔴 A signing key an attacker can guess, on a deployment that looks identical.
    name: 'the secret made constant rather than random',
    file: CREATE,
    expect: 'the differs-every-time test',
    find: / {2}const bytes = crypto\.getRandomValues\(new Uint8Array\(SECRET_BYTES\)\);/,
    replace: '  const bytes = new Uint8Array(SECRET_BYTES);',
  },
  {
    name: 'the secret left with characters that are unsafe in a URL',
    file: CREATE,
    expect: 'the safe-in-a-URL test',
    find: / {4}\.replace\(\/\\\+\/g, '-'\)\n {4}\.replace\(\/\\\/\/g, '_'\)\n {4}\.replace\(\/=\+\$\/, ''\);/,
    replace: '    ;',
  },
  {
    name: 'the project name pattern widened to whatever Cloudflare might take',
    file: CREATE,
    expect: 'the refuses-uppercase-and-underscore tests',
    find: /export const PROJECT_NAME_PATTERN = \/\^\[a-z\]\[a-z0-9-\]\{1,38\}\[a-z0-9\]\$\/;/,
    replace: 'export const PROJECT_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;',
  },
  {
    // Email and password on a free plan costs 58 ms of CPU against a 10 ms budget,
    // so the first sign-in fails on the plan almost every new reader is on.
    name: 'email and password turned on by default',
    file: CREATE,
    expect: 'the email-and-password test',
    find: /BETTER_AUTH_EMAIL_PASSWORD: 'false',/,
    replace: "BETTER_AUTH_EMAIL_PASSWORD: 'true',",
  },
  {
    // The URL is not knowable until the subdomain exists, and the engine refuses to
    // infer one, so an upload before the subdomain ships a Worker that cannot start.
    name: 'the upload moved ahead of claiming the subdomain',
    file: CREATE,
    expect: 'the plan-order tests',
    edits: [
      {
        find: / {2}\{ title: 'Claim the workers\.dev subdomain', consequence: 'the deployment has no address' \},\n/,
        replace: '',
      },
      {
        find: / {2}\{ title: 'Upload the Worker', consequence: 'nothing is deployed' \},/,
        replace:
          "  { title: 'Upload the Worker', consequence: 'nothing is deployed' },\n" +
          "  { title: 'Claim the workers.dev subdomain', consequence: 'the deployment has no address' },",
      },
    ],
  },
  {
    // 🔴 The bound exists because `ask` can be attached to something that is not a
    // person. A pipe already at end of file returns empty forever, and without a
    // cap that is a command that never returns and never says why.
    //
    // ⚠️ Written as "one attempt" rather than "no bound". A mutation that removes a
    // loop bound HANGS the runner rather than failing a test, and the restore is in
    // a `finally` a killed process never reaches. See the third trap in
    // `mutation-runner.mjs`, learned the expensive way on 2026-08-11.
    name: 'the retry budget cut to one, so a typo ends the command',
    file: CREATE,
    expect: 'the asks-again test',
    find: /export const MAX_ANSWER_ATTEMPTS = 3;/,
    replace: 'export const MAX_ANSWER_ATTEMPTS = 1;',
  },
  {
    // Silently taking the default after three bad answers deploys something the
    // reader did not ask for, under a name they did not choose.
    name: 'a run out of attempts falling back to the default rather than stopping',
    file: CREATE,
    expect: 'the gives-up test',
    find: / {2}return null;\n\}/,
    replace: '  return fallback;\n}',
  },
  {
    // An empty line is how every prompt in every CLI says "use the default".
    name: 'an empty answer taken literally rather than as the default',
    file: CREATE,
    expect: 'the presses-enter test',
    find: / {4}const value = raw === '' \? fallback : raw;/,
    replace: '    const value = raw;',
  },
  {
    // The reason is what turns a rejected answer into a fixed one. Without it the
    // reader sees the same prompt again and has to guess what changed.
    name: 'the reason for a rejection swallowed, so the prompt just repeats',
    file: CREATE,
    expect: 'the says-what-was-wrong test',
    find: / {4}write\(` {2}\$\{verdict\.reason\}`\);/,
    replace: "    write('  Try again.');",
  },
  {
    // The reason a question is asked is what tells a reader whether to keep going.
    name: 'the reason dropped from the prompt, leaving a bare question',
    file: CREATE,
    expect: 'the says-why-it-is-asking test',
    find: /return `\$\{question\}\\n {2}\$\{why\}\\n {2}\[\$\{fallback\}\] `;/,
    replace: 'return `${question}\\n  \\n  [${fallback}] `;',
  },
  {
    // Provisioning used to create a KV namespace because the original plan listed
    // one. Nothing reads `env.CACHE`, so it was a resource on somebody's account
    // and a step in their onboarding for something that does not exist.
    name: 'the KV namespace put back, which nothing reads',
    file: CREATE,
    expect: 'the no-KV-namespace test',
    find: / {4}bucket: `\$\{project\}-objects`,/,
    replace: '    namespace: `${project}-cache`,\n    bucket: `${project}-objects`,',
  },
  {
    // Printing the URL and stopping sends the reader to a 404 at the exact moment
    // they are deciding whether this product works. `rules/02` section C2.
    name: 'the wait for the address dropped from the plan',
    file: CREATE,
    expect: 'the waits-last test',
    find: / {2}\{ title: 'Wait for the address to answer', consequence: 'the first visit lands on a 404' \},\n/,
    replace: '',
  },
];

await runMutations({
  files: [CREATE],
  suites: ['cli/create.test.ts'],
  mutations: MUTATIONS,
});
