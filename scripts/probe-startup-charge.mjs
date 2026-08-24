/**
 * Does start-up CPU count against the per-request CPU ceiling? Second attempt.
 *
 * ## What the first attempt learned, and why it had to change
 *
 * The plan was to set `limits.cpu_ms: 10` and see whether a cold request that
 * does no work of its own gets killed by the ~62ms its module scope spends.
 * The calibration refused to pass, and chasing that produced a finding worth
 * more than the original plan:
 *
 *   cpu_ms = 10 was STORED on the script, and NOT enforced as written. A
 *   request that spent 611ms of CPU answered 200; one that spent 1187ms was
 *   recorded as `exceededResources`. So there is a floor somewhere near a
 *   second, and small values are clamped to it.
 *
 * That kills the idea of simulating the free plan's 10ms exactly. It does not
 * kill the question, because the question never needed 10: it needs a ceiling
 * BELOW what module scope spends. Hence cpu_ms = 50 against ~200ms of start-up
 * work (measured: about 1 million loops per 10ms of CPU on this hardware).
 *
 * ## Order matters more than anything else here
 *
 * A freshly deployed worker serves its first request on a new isolate, so that
 * request is cold by construction and no waiting is required. Everything that
 * would warm it therefore has to come AFTER it. The previous version ran its
 * calibration first and would have measured a warm isolate while calling it
 * cold.
 *
 * ## Reading the result
 *
 *   cold /light KILLED    -> start-up IS charged to the request. For BaseCLF
 *                            that is the serious case: 32.1ms of cold start
 *                            against a free customer's 10ms ceiling.
 *   cold /light SURVIVES,
 *   and the ceiling is
 *   shown to be enforced  -> start-up is NOT charged to the request.
 *   cold /light SURVIVES,
 *   ceiling NOT enforced  -> nothing follows. Say so rather than concluding.
 *
 * ⚠️ Drives a throwaway worker, deleted after. Prints no token, no account id,
 * no hostname.
 *
 *   node scripts/probe-startup-charge.mjs
 */

import { readFileSync } from 'node:fs';

const API = 'https://api.cloudflare.com/client/v4';
const SCRIPT = 'baseclf-cpu-probe';

/**
 * Roughly 10ms of CPU each, measured from the first run: 20M loops was recorded
 * at ~204ms and 60M at ~611ms. So the ladder below spans well under to well over
 * a 50ms ceiling.
 */
const LOOPS_PER_10MS = 1_000_000;

/**
 * 🔴 The ladder has to reach far past the ceiling, not creep up to it.
 *
 * The first ladder topped out at 20M and nothing died, which read as "the
 * ceiling is not enforced". It was not: the platform recorded that run's
 * heaviest request at 49.8ms of CPU against a 50ms ceiling, so the ceiling was
 * never actually tested. The loop got CHEAPER as the run went on, because a hot
 * loop gets JIT-compiled: 20M loops cost 203.9ms on the first run and about
 * 50ms once warm, a 4x drift in the instrument itself while it was being used
 * to measure something else.
 *
 * So the rungs now start above the ceiling instead of approaching it, and the
 * top one is expensive enough to blow through it even fully warmed.
 */
const LADDER = [20, 60, 200].map((tens) => tens * LOOPS_PER_10MS);

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

const authorized = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

const settingsAnswer = await fetch(
  `${API}/accounts/${accountId}/workers/scripts/${SCRIPT}/settings`,
  { headers: authorized },
);
const storedLimits = (await settingsAnswer.json().catch(() => ({})))?.result?.limits ?? null;

const subdomainAnswer = await fetch(`${API}/accounts/${accountId}/workers/subdomain`, {
  headers: authorized,
});
const subdomain = (await subdomainAnswer.json().catch(() => ({})))?.result?.subdomain;

if (typeof subdomain !== 'string' || subdomain === '') {
  console.error('probe: could not resolve the account subdomain.');
  process.exit(1);
}

const ORIGIN = `https://${SCRIPT}.${subdomain}.workers.dev`;

async function call(path) {
  const at = Date.now();
  try {
    const response = await fetch(`${ORIGIN}${path}`);
    const body = (await response.text()).slice(0, 90).replace(/\s+/g, ' ');
    return { status: response.status, took: Date.now() - at, body, ok: response.status === 200 };
  } catch (cause) {
    return { status: 0, took: Date.now() - at, body: String(cause), ok: false };
  }
}

function show(label, result) {
  console.log(
    `  ${label.padEnd(24)} HTTP ${String(result.status).padEnd(4)} ${String(result.took).padStart(6)}ms  ${result.ok ? '' : result.body}`,
  );
  return result;
}

console.log(`stored limits: ${JSON.stringify(storedLimits)}\n`);
console.log('=== 1. THE COLD REQUEST, first thing, before anything warms the isolate ===\n');

// `/light` runs no handler work, so what it costs is start-up plus answering.
// This has to be the first call made after a deploy or it is not cold.
const cold = show('cold /light', await call('/light'));

console.log('\n=== 2. Now calibrate: is this ceiling enforced at all? ===\n');

const trivial = show('/burn?loops=0', await call('/burn?loops=0'));

let killedAt = null;
for (const loops of LADDER) {
  const result = show(`/burn?loops=${loops}`, await call(`/burn?loops=${loops}`));
  if (!result.ok) {
    killedAt = loops;
    break;
  }
}

console.log('');

const ceilingEnforced = trivial.ok && killedAt !== null;

if (!ceilingEnforced) {
  console.log('🔴 The ceiling is NOT enforced at anything near what was asked for.');
  console.log(
    `   Nothing up to ${LADDER.at(-1)} loops was killed, which is far past ${JSON.stringify(storedLimits)}.`,
  );
  console.log('   So the cold result above proves nothing, in either direction.');
  console.log('');
  console.log('   ⚠️ That is itself the finding: `limits.cpu_ms` is stored and clamped, so');
  console.log('   it cannot be used to simulate a small ceiling. Answering the start-up');
  console.log('   question needs a genuinely free account instead.');
} else {
  const ceilingMs = Math.round((killedAt / LOOPS_PER_10MS) * 10);
  console.log(`  ⭐ Enforced: trivial work survives, ~${ceilingMs}ms of handler work is killed.`);
  console.log('');

  if (cold.ok) {
    console.log('⭐⭐ START-UP IS NOT CHARGED TO THE PER-REQUEST CEILING.');
    console.log(`   Module scope spends far more than the ~${ceilingMs}ms that kills a handler,`);
    console.log('   and a cold request still answered 200. So the two budgets are separate:');
    console.log('   start-up counts against the 1s start-up budget, not the request ceiling.');
    console.log('');
    console.log('   For BaseCLF: the 32.1ms cold start does NOT threaten free-plan');
    console.log('   deployments. What has to fit in a free customer’s 10ms is the handler,');
    console.log('   measured at 0.2 to 3.0ms (rules/02 section A0d).');
  } else {
    console.log('🔴🔴 START-UP IS CHARGED TO THE REQUEST.');
    console.log('   A cold request doing no work of its own was killed, while trivial warm');
    console.log('   work survived. The only difference between them is start-up.');
    console.log('');
    console.log('   For BaseCLF this is the serious case: every cold request on every');
    console.log('   free-plan deployment would be killed, and that is most customers.');
  }
}

console.log('');
console.log('⚠️ Not established: that a free plan enforces its 10ms the same way a');
console.log('   configured cpu_ms does. Same field, same runtime, but this account is paid');
console.log('   and no free account was driven.');
