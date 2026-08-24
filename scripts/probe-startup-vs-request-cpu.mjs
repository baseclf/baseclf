/**
 * Is start-up CPU charged against the per-request CPU ceiling?
 *
 * ## Why this is the question that matters
 *
 * A cold request on this engine costs 32.1ms of CPU (rules/02 section A0d).
 * BaseCLF is deployed into the CUSTOMER's account, and customers are mostly on
 * the free plan, where the ceiling is 10ms. So either start-up is charged
 * somewhere else, or every cold request on every free deployment is killed and
 * the product does not work for most of the people it is aimed at.
 *
 * Section A0 wrote this hypothesis down on 2026-08-11, marked it untested, and
 * it stayed untested for two weeks behind an assumption that turned out to be
 * wrong (section A0c).
 *
 * ## Why it needs no free account
 *
 * On a paid account `limits.cpu_ms` is configurable, so the ceiling stops being
 * a fact about billing and becomes a number set in a config file. The probe
 * worker is deployed with `cpu_ms: 10` and burns ~62ms in module scope, which
 * every cold isolate pays before any handler runs.
 *
 * ## The two calibrations, and why a result without them is worthless
 *
 * A clean sheet has two explanations: start-up is not charged, or the ceiling
 * is not enforced at all. `/burn` spends CPU inside the handler, where nobody
 * disputes it counts, and separates them:
 *
 *   /burn?loops=0        must SURVIVE   -> the ceiling is not killing everything
 *   /burn?loops=<big>    must be KILLED -> the ceiling is real and enforced
 *
 * Only if BOTH hold does a surviving cold `/light` mean anything. This is the
 * discipline section C6 and rules/01 section G9 were written about: an
 * instrument that is confident and wrong costs more than no instrument.
 *
 * ⚠️ Drives a throwaway worker deployed for this measurement and deleted after.
 * Touches nothing else. Prints no token, no account id, no hostname.
 *
 *   node scripts/probe-startup-vs-request-cpu.mjs
 */

import { readFileSync } from 'node:fs';

const API = 'https://api.cloudflare.com/client/v4';
const SCRIPT = 'baseclf-cpu-probe';

/** Longer than an isolate was measured to survive with no traffic (section A0d). */
const COLD_WAIT_MS = 5 * 60 * 1000;

/** Enough handler work to blow a 10ms ceiling several times over. */
const BIG_BURN = 20_000_000;

function fromEnvFile(name) {
  const line = readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .find((entry) => entry.startsWith(`${name}=`));
  return line === undefined ? '' : line.slice(name.length + 1).trim();
}

const token = fromEnvFile('CLOUDFLARE_API_TOKEN');
const accountId = fromEnvFile('CLOUDFLARE_ACCOUNT_ID');

if (token === '' || accountId === '') {
  console.error('probe: .env is missing CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID.');
  process.exit(2);
}

if (process.env.CLOUDFLARE_API_TOKEN !== undefined && process.env.CLOUDFLARE_API_TOKEN !== token) {
  console.error('probe: the process carries a different CLOUDFLARE_API_TOKEN than .env holds.');
  process.exit(2);
}

const authorized = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

const subdomainAnswer = await fetch(`${API}/accounts/${accountId}/workers/subdomain`, {
  headers: authorized,
});
const subdomain = (await subdomainAnswer.json().catch(() => ({})))?.result?.subdomain;

if (typeof subdomain !== 'string' || subdomain === '') {
  console.error('probe: could not resolve the account subdomain.');
  process.exit(1);
}

const ORIGIN = `https://${SCRIPT}.${subdomain}.workers.dev`;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Call the probe and classify what came back.
 *
 * A CPU kill is not merely a non-200. Cloudflare answers it with a 5xx carrying
 * its own prose, while a worker that has not finished propagating answers 404
 * with error 1042 (section C2), and those two must never be read as the same
 * thing: one is the finding, the other is a worker that does not exist yet.
 */
async function call(path) {
  const at = Date.now();
  let response;
  try {
    response = await fetch(`${ORIGIN}${path}`);
  } catch (cause) {
    return { kind: 'network', detail: cause instanceof Error ? cause.message : String(cause) };
  }

  const body = await response.text();
  const took = Date.now() - at;
  const lower = body.toLowerCase();

  const kind =
    response.status === 200
      ? 'ok'
      : lower.includes('exceeded') || lower.includes('resource limits') || lower.includes('1102')
        ? 'killed'
        : response.status === 404
          ? 'not-there-yet'
          : 'other';

  return { kind, status: response.status, took, body: body.slice(0, 140) };
}

function show(label, result) {
  const detail =
    result.kind === 'network'
      ? result.detail
      : `HTTP ${result.status} in ${result.took}ms  ${result.body.replace(/\s+/g, ' ')}`;
  console.log(`  ${label.padEnd(26)} ${String(result.kind).padEnd(14)} ${detail}`);
  return result;
}

console.log('=== 0. Wait for the throwaway worker to answer at all ===\n');

// Section C2: a freshly deployed worker answers 404 for a while, and that 404
// has nothing to do with CPU. Polled until it stops, so a propagation delay is
// never mistaken for the finding.
let ready = null;
for (let attempt = 1; attempt <= 20; attempt += 1) {
  const result = await call('/burn?loops=0');
  if (result.kind !== 'not-there-yet') {
    ready = show(`attempt ${attempt}`, result);
    break;
  }
  await wait(5000);
}

if (ready === null) {
  console.error('\nprobe: the worker never answered. Nothing below can be measured.');
  process.exit(1);
}

console.log('\n=== 1. Calibration: is the 10ms ceiling actually enforced? ===\n');

// Trivial work first. If this dies, the ceiling is killing everything and no
// conclusion about start-up is available from this run.
const trivial = show('/burn?loops=0', await call('/burn?loops=0'));

// Then work that cannot fit under 10ms. If this SURVIVES, the ceiling is not
// being applied, and a surviving cold request would prove nothing either.
const heavy = show(`/burn?loops=${BIG_BURN}`, await call(`/burn?loops=${BIG_BURN}`));

const ceilingWorks = trivial.kind === 'ok' && heavy.kind === 'killed';

console.log('');
if (ceilingWorks) {
  console.log('  ⭐ Both calibrations hold: trivial work survives, heavy work is killed.');
  console.log('     The ceiling is real, it is 10ms, and it is being enforced right now.');
} else {
  console.log('  🔴 CALIBRATION FAILED. Read the two lines above before anything else:');
  console.log('     trivial work must survive and heavy work must be killed. Until both');
  console.log('     hold, a surviving cold request says nothing about start-up.');
}

console.log('\n=== 2. The measurement: a COLD request that does no work of its own ===\n');
console.log(`  waiting ${COLD_WAIT_MS / 60000} minutes so the isolate is recycled...`);

const samples = [];

for (let round = 1; round <= 2; round += 1) {
  await wait(COLD_WAIT_MS);
  // `/light` runs no handler work at all, so whatever this request costs is
  // start-up plus the cost of answering.
  samples.push(show(`cold /light #${round}`, await call('/light')));
  // Immediately again: same path, warm isolate. If the cold one survives and
  // the warm one does too, that is consistent; if only the warm one survives,
  // the difference is start-up and the answer is the opposite one.
  samples.push(show(`warm /light #${round}`, await call('/light')));
}

console.log('');

const coldResults = samples.filter((_, index) => index % 2 === 0);
const coldSurvived = coldResults.every((result) => result.kind === 'ok');
const coldKilled = coldResults.some((result) => result.kind === 'killed');

if (!ceilingWorks) {
  console.log('🔴 No conclusion: the calibration above failed.');
} else if (coldKilled) {
  console.log('🔴🔴 START-UP IS CHARGED TO THE REQUEST.');
  console.log('   A cold request doing no work of its own was killed by a 10ms ceiling,');
  console.log('   because module scope had spent ~62ms before the handler ran.');
  console.log('');
  console.log('   For BaseCLF this is the serious case: a cold request on this engine');
  console.log('   costs 32.1ms, so every cold request on every free-plan deployment is');
  console.log('   killed, and the product does not work for the tier most users are on.');
} else if (coldSurvived) {
  console.log('⭐⭐ START-UP IS NOT CHARGED TO THE PER-REQUEST CEILING.');
  console.log('   Module scope burned ~62ms, the ceiling is 10ms and is enforced (proven');
  console.log('   by the calibration above), and a cold request still answered 200.');
  console.log('');
  console.log('   So the hypothesis section A0 wrote on 2026-08-11 is CORRECT, and the');
  console.log('   32.1ms cold start measured in section A0d does not threaten free-plan');
  console.log('   deployments. What a free deployment must fit in 10ms is the handler,');
  console.log('   measured at 0.2 to 3.0ms.');
} else {
  console.log('⚠️ Mixed or unclassified results. Read the lines above rather than this one.');
}

console.log('');
console.log('⚠️ What this does NOT establish: that the free plan enforces its 10ms the');
console.log('   same way a configured cpu_ms does. It is the same field name and the same');
console.log('   runtime, which is the argument, but this account is paid and no free');
console.log('   account was driven.');
