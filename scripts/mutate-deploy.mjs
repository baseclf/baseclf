/**
 * Break the wait, and check the tests notice.
 *
 * This is the last step of onboarding and the most expensive place in the flow to
 * look broken. A reader who has just spent five minutes provisioning and then lands
 * on a 404 concludes the product does not work, and they are not wrong to: nothing
 * on the screen distinguishes an address that has not propagated from one that
 * never will.
 *
 * Two mutations matter. Dropping the wait puts the reader on that 404. Waiting out
 * a status that means somebody else is serving the hostname leaves them watching a
 * spinner for something that is never going to happen.
 *
 * Usage: node scripts/mutate-deploy.mjs
 */

import { runMutations } from './mutation-runner.mjs';

const DEPLOY = 'cli/deploy.ts';
const DOCTOR = 'cli/doctor.ts';

const MUTATIONS = [
  {
    // 🔴 The reader lands on a 404 at the moment they decide whether this works.
    name: 'the first answer trusted, so a propagating address reads as broken',
    file: DEPLOY,
    expect: 'the comes-up-the-way-a-new-one-does tests',
    find: / {4}if \(attempt < attempts\) await sleep\(intervalMs\);/,
    replace: '    break;',
  },
  {
    // 🔴 A spinner for something that is never going to happen.
    name: 'every non-200 waited out, including ones that mean another server',
    file: DEPLOY,
    expect: 'the wrong-server tests',
    find: / {4}if \(status !== null && !isPropagating\(status\)\) \{/,
    replace: '    if (false) {',
  },
  {
    name: 'a failed request treated as another server rather than as a new hostname',
    file: DEPLOY,
    expect: 'the request-did-not-complete test',
    find: / {2}\} catch \{\n {4}return null;\n {2}\}/,
    replace: '  } catch {\n    return 403;\n  }',
  },
  // 🔴 NOT a mutation, and the reason is a note for whoever adds the next one.
  //
  // Replacing the attempt bound with something unbounded was written here, with a
  // `knownSurvivor` explaining that it would hang rather than fail. That note was
  // the warning, and shipping it anyway cost a ten minute run and left `deploy.ts`
  // on disk in its mutated state, because the runner restores in a `finally` that a
  // killed process never reaches (debt 55).
  //
  // **A mutation that makes the code loop forever is not a surviving mutant, it is a
  // broken mutation.** The runner cannot tell the two apart: both look like a test
  // that never returns. The bound is covered from the other side by the
  // gives-up-eventually test, which counts attempts against a known grace period.
  {
    name: 'the wait polling the root rather than the endpoint doctor asks',
    file: DEPLOY,
    expect: 'the asks-/health test',
    find: /const url = `\$\{baseUrl\.replace\(\/\\\/\$\/, ''\)\}\/health`;/,
    replace: "const url = baseUrl.replace(/\\/$/, '');",
  },
  {
    // The judgment both commands share. Widening it here widens it for `doctor`
    // too, which is the point of it being one function.
    name: 'the shared propagation judgment widened to accept anything',
    file: DOCTOR,
    expect: 'the propagation-judgment tests',
    find: / {2}return status === 404 \|\| status >= 500;/,
    replace: '  return status !== 200;',
  },
];

await runMutations({
  files: [DEPLOY, DOCTOR],
  suites: ['cli/deploy.test.ts', 'cli/doctor.test.ts'],
  mutations: MUTATIONS,
});
