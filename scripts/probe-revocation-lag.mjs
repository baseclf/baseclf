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

console.log('3. poll');
let last = 200;
while (last === 200) {
  if (Date.now() - removedAt > GIVE_UP_MS) {
    console.log(`   still serving after ${Math.round(GIVE_UP_MS / 1000)}s, gave up`);
    process.exit(1);
  }
  await sleep(INTERVAL_MS);
  last = await status();
  const elapsed = Math.round((Date.now() - removedAt) / 1000);
  if (last === 200) console.log(`   t+${elapsed}s still serving the removed table`);
  else console.log(`   t+${elapsed}s refused with ${last}`);
}
