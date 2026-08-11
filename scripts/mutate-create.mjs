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
    name: 'the signing secret not inherited, so a redeploy drops it',
    file: CREATE,
    expect: 'the inherits-the-signing-secret test',
    find: / {4}\{ kind: 'inherit', name: 'BETTER_AUTH_SECRET' \},/,
    replace: '',
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
