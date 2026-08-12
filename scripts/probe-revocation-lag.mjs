/**
 * How long a revocation takes to reach a deployment.
 *
 * Debt F2: `getRegistry` is a bare per-isolate memo and nothing reads
 * `_exposed_tables.version`, so a policy change lands when the isolate recycles and
 * nothing bounds when that is. That has only ever been measured in workerd locally.
 * This measures it against a running deployment, which is the number an operator
 * revoking access actually lives with.
 *
 * The experiment, in order, because a shortcut invalidates it:
 *
 *   1. Expose the table and wait until the deployment serves it. Without this the
 *      isolate may never have loaded a registry naming the table, and the whole
 *      question is how long a loaded one persists.
 *   2. Remove it, and start the clock at the moment the command reports success.
 *   3. Poll until the deployment refuses.
 *
 * Usage: node scripts/probe-revocation-lag.mjs <deployment-url>
 */
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const base = process.argv[2];
if (!base) {
  console.error('usage: node scripts/probe-revocation-lag.mjs <deployment-url>');
  process.exit(2);
}

const URL_UNDER_TEST = `${base.replace(/\/$/, '')}/rest/v1/posts`;
const INTERVAL_MS = 5_000;
const GIVE_UP_MS = 30 * 60_000;

const cli = (...args) =>
  execFileSync(process.execPath, ['dist-cli/baseclf.mjs', 'policy', ...args], {
    encoding: 'utf8',
  });

async function status() {
  const response = await fetch(URL_UNDER_TEST);
  return response.status;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

console.log('1. expose');
cli('apply', 'examples/posts.policy.json');

console.log('   waiting for the deployment to serve it');
const exposedAt = Date.now();
while ((await status()) !== 200) {
  if (Date.now() - exposedAt > GIVE_UP_MS) throw new Error('never started serving');
  await sleep(INTERVAL_MS);
}
console.log(`   serving after ${Math.round((Date.now() - exposedAt) / 1000)}s`);

console.log('2. remove');
cli('rm', 'posts', '--confirm');
const removedAt = Date.now();

/**
 * 🔴 Polls until the refusals have been *sustained*, not until the first one.
 *
 * The first version stopped at the first 404 and reported that time as the answer. It
 * is not the answer, and four runs in a row said 5 to 11 seconds before a longer poll
 * showed the truth: a deployment answers from several isolates, each holding its own
 * registry loaded at its own moment, and a request lands on whichever one takes it. So
 * one 404 means one isolate has expired. It says nothing about the others.
 *
 * Measured on 2026-08-12 against a live deployment, polling every two seconds:
 *
 *   t+0s 404 · t+3s 404 · t+5s 404 · **t+7s 200** · t+9s 404 · ... 404 to t+68s
 *
 * A run that stopped at the first refusal would have reported this as zero seconds,
 * while the removed table was still being served seven seconds later.
 *
 * So the answer is the time of the **last** 200, and it is only trustworthy once
 * nothing has served for longer than the window itself.
 */
const QUIET_MS = 45_000;

console.log('3. poll');
let lastServedAt = removedAt;
let lastServedElapsed = 0;
let everServed = false;

while (Date.now() - lastServedAt < QUIET_MS) {
  if (Date.now() - removedAt > GIVE_UP_MS) {
    console.log(`   still serving after ${Math.round(GIVE_UP_MS / 1000)}s, gave up`);
    process.exit(1);
  }

  await sleep(INTERVAL_MS);
  const code = await status();
  const elapsed = Math.round((Date.now() - removedAt) / 1000);

  if (code === 200) {
    lastServedAt = Date.now();
    lastServedElapsed = elapsed;
    everServed = true;
    console.log(`   t+${elapsed}s still serving the removed table`);
  } else {
    console.log(`   t+${elapsed}s refused with ${code}`);
  }
}

console.log(
  everServed
    ? `   last served at t+${lastServedElapsed}s, then quiet for ${QUIET_MS / 1000}s`
    : `   never served after the removal, and quiet for ${QUIET_MS / 1000}s`,
);
