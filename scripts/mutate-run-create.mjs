/**
 * Break the orchestrator, and check the tests notice.
 *
 * This is the file that touches somebody else's Cloudflare account, so the mutations
 * below are chosen for a particular property: **most of them leave a run that reports
 * success.** A deployment with no cron answers every request correctly. A regenerated
 * signing secret provisions perfectly and signs every existing user out. An account
 * picked rather than asked about lands on the wrong bill and says nothing.
 *
 * Only two of the ten produce anything a reader would see go wrong.
 *
 * Usage: node scripts/mutate-run-create.mjs
 */

import { runMutations } from './mutation-runner.mjs';

const FILE = 'cli/run-create.ts';

const MUTATIONS = [
  {
    // 🔴 The one that broke every first deployment once already, from the other side.
    name: 'inherit sent unconditionally, which strict mode turns into an error',
    file: FILE,
    expect: 'the does-not-inherit-on-a-first-run test',
    find: /varsFor\(url, answers\.frontendOrigin\), hasSigningSecret\)/,
    replace: 'varsFor(url, answers.frontendOrigin), true)',
  },
  {
    // The opposite, and it is worse: it succeeds. A redeploy that names no inherit may
    // drop the secret it was carrying, and nothing on any surface says so.
    name: 'inherit never sent, so a redeploy can drop the secret it had',
    file: FILE,
    expect: 'the inherits-when-the-script-already-has-it test',
    find: /varsFor\(url, answers\.frontendOrigin\), hasSigningSecret\)/,
    replace: 'varsFor(url, answers.frontendOrigin), false)',
  },
  {
    // 🔴 Reports success and signs out every existing user of that deployment.
    name: 'a fresh signing secret issued on every run',
    file: FILE,
    expect: 'the keeps-the-signing-secret test',
    find: / {4}if \(hasSigningSecret\) \{/,
    replace: '    if (false) {',
  },
  {
    // Reports success. The deployment answers every request and never sweeps, and the
    // symptom arrives months later as a table that grew without bound.
    name: 'the cron triggers never set',
    file: FILE,
    expect: 'the sets-the-cron-triggers test',
    find: / {4}await putSchedules\(host\.fetcher, credentials, names\.script, CREATE_CRONS\);/,
    replace: '    await Promise.resolve();',
  },
  {
    // Reports success, on somebody else's bill.
    name: 'the first account taken when there is more than one',
    file: FILE,
    expect: 'the refuses-to-choose-between-two-accounts test',
    find: / {2}if \(accounts\.length > 1\) \{/,
    replace: '  if (false) {',
  },
  {
    // Turns the ordinary case into a failure. A new address takes about thirty seconds
    // and everything is already provisioned by then.
    name: 'a propagating address treated as a failed deployment',
    file: FILE,
    expect: 'the calls-a-slow-address-a-success test',
    find: / {4}if \(outcome\.kind === 'wrong-server'\) \{/,
    replace: "    if (outcome.kind === 'wrong-server' || outcome.kind === 'still-waiting') {",
  },
  {
    // The reverse. Somebody else is serving that hostname and no amount of waiting
    // changes it, so calling it a success sends the reader to a deployment that is
    // not theirs.
    name: 'another server on the hostname reported as a working deployment',
    file: FILE,
    expect: 'the calls-a-403-a-failure test',
    find: / {4}if \(outcome\.kind === 'wrong-server'\) \{/,
    replace: '    if (false) {',
  },
  {
    // The secrets are read before the upload because the answer decides what the
    // upload contains. Reading them as an empty list is what happens if that call is
    // ever "simplified" away.
    name: 'existing secrets assumed to be none',
    file: FILE,
    expect: 'the second-run tests',
    find: / {4}const hasSigningSecret = \(existingSecrets \?\? \[\]\)\.includes\(SIGNING_SECRET_NAME\);/,
    replace: '    const hasSigningSecret = false;',
  },
  {
    // A refusal that does not say what it cost is a refusal a reader cannot act on,
    // and this is the step where they are deciding whether the product works.
    name: 'the consequence dropped from a failure message',
    file: FILE,
    expect: 'the says-what-breaks-without-it test',
    find: / {4}write\(note\(`Without this, \$\{entry\.consequence\}\.`\)\);/,
    replace: "    write(note('It did not work.'));",
  },
  {
    // The copyable value is the difference between an onboarding that finishes and one
    // that does not. Indented, it does not double-click cleanly, and the reader who
    // mis-pastes it gets redirect_uri_mismatch with nothing to explain it.
    name: 'the redirect URI indented like a note',
    file: FILE,
    expect: 'the prints-the-redirect-URI-unindented test',
    find: / {6}copy: `\$\{result\.url\}\/api\/auth\/callback\/google`,/,
    replace: '      steps2: undefined,',
  },
];

await runMutations({
  files: [FILE],
  suites: ['cli/run-create.test.ts'],
  mutations: MUTATIONS,
});
