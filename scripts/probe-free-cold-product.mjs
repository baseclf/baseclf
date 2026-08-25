/**
 * The launch question, measured on the launch plan: does the REAL product's
 * cold start survive a free account's CPU ceiling?
 *
 * ## Why a synthetic worker was not enough
 *
 * Sections A0f and A0g tried to answer this on paid accounts and proved it
 * structurally impossible there: `limits.cpu_ms` is clamped to about a second,
 * and the start-up budget is also a second, so no configuration lets start-up
 * exceed the ceiling. Both accounts in reach were paid. This runs on a genuine
 * free account, so the 10ms request ceiling is the real one, enforced by the
 * plan rather than simulated.
 *
 * And it measures the product rather than a stand-in. The question that decides
 * launch is not "does a burn loop get killed" but "does BaseCLF work for the
 * customers most likely to install it", so the deployment under test is a real
 * `create-baseclf` deployment and the requests are its real paths:
 *
 *   /health          the cheap path, isolate start-up only
 *   /api/auth/jwks   builds Better Auth and reads D1 (~32ms cold on the dev
 *                    deployment, section A0d)
 *   /rest/v1/posts   the heaviest first-touch there is: engine schema
 *                    bootstrap, catalogue, registry, then the fail-closed 404
 *
 * ## How cold is guaranteed
 *
 * An isolate was measured not to survive a four minute idle gap (section A0d),
 * so rounds are spaced five minutes apart. Round one is colder still: the
 * deployment has never served a data request, so its first /rest call runs the
 * engine's one-time bootstrap on top of isolate start-up.
 *
 * ## Reading the answer
 *
 * `workersInvocationsAdaptive` samples (section A0h), so counts are estimates;
 * what it cannot invent is a status: `exceededResources` appearing at all means
 * the platform killed something. The definitive per-request record is
 * `wrangler tail`, which the runbook starts alongside this script.
 *
 *   killed on a cold path     -> start-up IS charged on free, the product
 *                                breaks for its main audience, and launch has
 *                                its highest-priority bug.
 *   all cold paths answer 2xx/404 with recorded cpuTime above 10ms
 *                             -> the free ceiling does not count start-up, and
 *                                the product is safe where it is aimed.
 *
 * Reads .env for FREE_PROBE_ACCOUNT_TOKEN and FREE_PROBE_ACCOUNT_ID. Prints no
 * token, no account id, no hostname.
 *
 *   node scripts/probe-free-cold-product.mjs [rounds]
 */

import { readFileSync } from 'node:fs';

const API = 'https://api.cloudflare.com/client/v4';
const GRAPHQL = `${API}/graphql`;
const SCRIPT = 'baseclf-free-probe';
const ROUNDS = Number(process.argv[2] ?? '3');
const GAP_MS = 5 * 60 * 1000;

function fromEnvFile(name) {
  const line = readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .find((entry) => entry.startsWith(`${name}=`));
  return line === undefined ? '' : line.slice(name.length + 1).trim();
}

const token = fromEnvFile('FREE_PROBE_ACCOUNT_TOKEN');
const accountId = fromEnvFile('FREE_PROBE_ACCOUNT_ID');

if (token === '' || accountId === '') {
  console.error('probe: .env needs FREE_PROBE_ACCOUNT_TOKEN and FREE_PROBE_ACCOUNT_ID.');
  process.exit(2);
}

const authorized = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const safe = (text) => String(text).split(accountId).join('<account>');

const subdomainAnswer = await fetch(`${API}/accounts/${accountId}/workers/subdomain`, {
  headers: authorized,
});
const subdomain = (await subdomainAnswer.json().catch(() => ({})))?.result?.subdomain;

if (typeof subdomain !== 'string' || subdomain === '') {
  console.error('probe: could not resolve the account subdomain.');
  process.exit(1);
}

const ORIGIN = `https://${SCRIPT}.${subdomain}.workers.dev`;
const hide = (text) => safe(String(text).split(subdomain).join('<subdomain>'));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The paths, cheapest first so the dear ones land on an already-started isolate
 * in the same round; the NEXT round's first request is the cold one. Round one
 * is the exception that matters most: everything in it is cold, and /rest runs
 * the engine bootstrap. */
const PATHS = ['/health', '/api/auth/jwks', '/rest/v1/posts'];

async function hit(path) {
  const at = Date.now();
  try {
    const response = await fetch(`${ORIGIN}${path}`);
    await response.text();
    return { path, status: response.status, wallMs: Date.now() - at };
  } catch (cause) {
    return { path, status: 0, wallMs: Date.now() - at, error: hide(cause) };
  }
}

const windows = [];

for (let round = 1; round <= ROUNDS; round += 1) {
  if (round > 1) {
    console.log(`\nholding ${GAP_MS / 60000} minutes so the isolate dies...`);
    await wait(GAP_MS);
  }

  console.log(
    `\n=== round ${round} of ${ROUNDS}${round === 1 ? ' (bootstrap round: first data request ever)' : ''} ===`,
  );
  const from = Date.now();

  for (const path of PATHS) {
    const result = await hit(path);
    console.log(
      `  ${result.path.padEnd(18)} HTTP ${String(result.status).padEnd(4)} wall ${String(result.wallMs).padStart(6)}ms${result.error === undefined ? '' : `  ${result.error}`}`,
    );
  }

  windows.push({ from, until: Date.now() });
}

console.log('\nwaiting 180s for the analytics dataset to catch up...');
await wait(180 * 1000);

console.log('\n=== what the platform recorded, per minute and per status ===\n');

const QUERY = `
  query FreeCold($accountTag: String!, $since: Time!, $until: Time!, $scriptName: String!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        workersInvocationsAdaptive(
          limit: 100
          filter: { datetime_geq: $since, datetime_leq: $until, scriptName: $scriptName }
          orderBy: [datetimeMinute_ASC]
        ) {
          sum { requests }
          quantiles { cpuTimeP50 cpuTimeP99 }
          dimensions { datetimeMinute status }
        }
      }
    }
  }`;

const response = await fetch(GRAPHQL, {
  method: 'POST',
  headers: authorized,
  body: JSON.stringify({
    query: QUERY,
    variables: {
      accountTag: accountId,
      since: new Date(windows[0].from - 60_000).toISOString(),
      until: new Date(Date.now()).toISOString(),
      scriptName: SCRIPT,
    },
  }),
});

const body = await response.json().catch(() => ({}));
const errors = Array.isArray(body.errors) ? body.errors : [];

if (errors.length > 0) {
  for (const error of errors) console.log(`  refused: ${hide(error.message)}`);
  console.log('  The wall-clock table above still stands; the CPU numbers do not.');
  process.exit(1);
}

const rows = body.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];

let sawKill = false;
let sawOverCeiling = false;

for (const row of rows) {
  const status = String(row.dimensions?.status ?? '?');
  const p99 = (row.quantiles?.cpuTimeP99 ?? 0) / 1000;
  if (/exceed|cpu|limit/i.test(status)) sawKill = true;
  if (p99 > 10) sawOverCeiling = true;
  console.log(
    `  ${String(row.dimensions?.datetimeMinute ?? '?').padEnd(22)} ${status.padEnd(22)} ` +
      `requests=${String(row.sum?.requests ?? 0).padStart(3)} ` +
      `cpuP50=${((row.quantiles?.cpuTimeP50 ?? 0) / 1000).toFixed(1).padStart(6)}ms ` +
      `cpuP99=${p99.toFixed(1).padStart(6)}ms`,
  );
}

console.log('');

if (rows.length === 0) {
  console.log('🔴 The dataset returned nothing for the window. It samples and it lags, so');
  console.log('   rerun the read in a few minutes; conclude nothing from an empty answer.');
} else if (sawKill) {
  console.log('🔴🔴 THE PLATFORM KILLED SOMETHING on a free account. Read which minute and');
  console.log('   compare with the rounds above; if it is a cold path, start-up IS charged');
  console.log('   on free and this is the highest-priority finding this project has.');
} else if (sawOverCeiling) {
  console.log('⭐⭐ Requests whose recorded cpuTime exceeds the 10ms free ceiling completed');
  console.log('   with status success, on a genuine free account, including the bootstrap');
  console.log('   round. The ceiling does not count start-up, and the product works where');
  console.log('   it is aimed. (The wrangler tail capture is the unsampled second witness.)');
} else {
  console.log('⚠️ Nothing was killed, but no recorded cpuTime exceeded 10ms either, so the');
  console.log('   ceiling was never tested. The sampled dataset may simply have missed the');
  console.log('   cold requests; read the tail capture before concluding anything.');
}

console.log('');
console.log('⚠️ Counts and quantiles here are sampled (section A0h). The per-request');
console.log('   truth is the wrangler tail JSON captured alongside this run.');
