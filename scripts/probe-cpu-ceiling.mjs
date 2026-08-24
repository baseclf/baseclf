/**
 * Which CPU ceiling is this account actually under, and does the measured CPU
 * split into a cold half and a warm half?
 *
 * ## The question debt 34 has been asking, and the assumption inside it
 *
 * Debt 34 reads: the engine's `cpuTimeP50` is 19.0ms, the free plan allows 10ms
 * a request, and not one request in 419 was killed. That is a paradox only while
 * the ceiling really is 10ms, and `rules/02` section A0b lists "is this account
 * still on the free plan" as **not measured**. If it is a paid account the
 * ceiling is 30s, every number is comfortably inside it, and there was never
 * anything to explain.
 *
 * So that is asked first, and asked of the API rather than inferred from a cron
 * refusal recorded ten days ago on an account this probe cannot confirm was the
 * same one. Section C3 is the precedent: a capability was deduced from a scope
 * list, the deduction was airtight, and it was wrong. Ask the thing itself.
 *
 * Several endpoints are tried because the right one is a guess, and a guess is
 * cheaper to settle by calling than by reading docs this platform has already
 * been wrong in. Whatever comes back, including a refusal, is the answer.
 *
 * ## The second half, only worth running if the plan is free
 *
 * Section A0's untested hypothesis: a cold request spends most of its CPU in
 * global scope, that part counts against the 1s startup budget rather than the
 * 10ms one, and analytics adds both into `cpuTime`. Section A0 proposed the
 * check and recorded it as never done: drive enough traffic to warm an isolate,
 * then read the quantiles back for that traffic alone.
 *
 * This does it with time windows. The burst is sent inside a known minute, and
 * the dataset is then asked about that minute only, which is the only way to
 * separate these requests from seven days of mixed cold and warm ones. Both
 * halves are sent: one lone request after a pause, and a run of back-to-back
 * ones, so "cold is dear" and "everything is dear" cannot produce the same
 * shape of answer.
 *
 * ⚠️ Read-only against Cloudflare, and it drives only GET /health, which touches
 * no database and writes nothing. It does add its own requests to the account's
 * analytics; that is the point, and it is why the windows are narrow.
 *
 * Prints no token, no account id, and no deployment address. The address is
 * resolved by asking Cloudflare for the account's subdomain rather than being
 * written down here, for two reasons: this file is public, and a hostname typed
 * into a terminal ends up in screenshots. It is used, never displayed.
 *
 *   node scripts/probe-cpu-ceiling.mjs
 */

import { readFileSync } from 'node:fs';

const API = 'https://api.cloudflare.com/client/v4';
const GRAPHQL = `${API}/graphql`;
const SCRIPT = 'baseclf';

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

// Section C1, the day this cost: the environment wins over the file silently, so
// a mismatch means measuring a credential nobody chose to test.
if (process.env.CLOUDFLARE_API_TOKEN !== undefined && process.env.CLOUDFLARE_API_TOKEN !== token) {
  console.error('probe: the process carries a different CLOUDFLARE_API_TOKEN than .env holds.');
  process.exit(2);
}

const authorized = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

/**
 * Strip the account id out of anything before it reaches the terminal.
 *
 * By the id being held rather than by its shape, which is the correction section
 * C2b records: recognising an id by format is betting on somebody else's format,
 * and the id is already in hand here so there is nothing to recognise.
 */
const safe = (text) => String(text).split(accountId).join('<account>');

async function readJson(path) {
  const response = await fetch(`${API}${path}`, { headers: authorized });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

// Resolved rather than written down, and never printed. `withoutOrigin` below
// keeps it out of anything this reports, the same way `safe` keeps the account
// id out: section C2b is the day an id reached a terminal through prose nobody
// was filtering.
const subdomainAnswer = await readJson(`/accounts/${accountId}/workers/subdomain`);
const subdomain = subdomainAnswer.body?.result?.subdomain;

if (typeof subdomain !== 'string' || subdomain === '') {
  console.error('probe: could not resolve the account subdomain, so there is nothing to drive.');
  process.exit(1);
}

const ORIGIN = `https://${SCRIPT}.${subdomain}.workers.dev`;
const withoutOrigin = (text) => String(text).split(subdomain).join('<subdomain>');

console.log('=== 1. Which plan is this account on? ===\n');

// The endpoint that answers this is a guess. Each one is named by what it would
// prove, so a refusal is recorded as a closed door rather than as a fact.
const PLAN_SOURCES = [
  {
    name: 'account subscriptions',
    path: `/accounts/${accountId}/subscriptions`,
    read: (body) =>
      (body.result ?? [])
        .map((entry) => `${entry.product?.name ?? '?'}: ${entry.rate_plan?.id ?? '?'}`)
        .join(' | '),
  },
  {
    // The token carries `Account Settings: Read` (section A0b listed the seven
    // permissions), so this is the one endpoint it is actually entitled to.
    // Field names only, never the object: an account record is somebody's
    // billing details and this prints to a terminal.
    name: 'account details',
    path: `/accounts/${accountId}`,
    read: (body) => Object.keys(body.result?.settings ?? {}).join(', ') || '(no settings field)',
  },
  {
    name: 'workers account settings',
    path: `/accounts/${accountId}/workers/account-settings`,
    read: (body) => JSON.stringify(body.result ?? {}),
  },
  {
    name: `script settings for ${SCRIPT}`,
    path: `/accounts/${accountId}/workers/scripts/${SCRIPT}/settings`,
    // `limits.cpu_ms` is the one that would settle it outright: it is
    // configurable only on paid, so a number here is a paid account describing
    // its own ceiling rather than anybody's reading of a pricing page.
    //
    // 🔴 Named fields, never the object. The first version of this fell back to
    // `JSON.stringify(body.result)` when `limits` was absent, and `limits` IS
    // absent here, so one run printed every binding on the deployment: the D1
    // database id and the deployment's own hostname, straight to a terminal.
    // rules/05 section B forbids exactly those two, and section C2b had already
    // recorded this shape of leak. A probe prints the field it came to read.
    read: (body) =>
      JSON.stringify({
        cpu_ms: body.result?.limits?.cpu_ms ?? null,
        usage_model: body.result?.usage_model ?? null,
      }),
  },
];

const planEvidence = [];

for (const source of PLAN_SOURCES) {
  const { status, body } = await readJson(source.path);
  if (status !== 200 || body.success !== true) {
    const message = body.errors?.[0]?.message ?? `HTTP ${status}`;
    console.log(`${source.name.padEnd(30)} refused: ${safe(message)}`);
    continue;
  }

  const detail = safe(source.read(body));
  console.log(`${source.name.padEnd(30)} ${detail === '' ? '(answered, but empty)' : detail}`);
  planEvidence.push({ name: source.name, detail });
}

// 🔴 What counts as evidence, and what looked like evidence and is not.
//
// The first version of this treated `usage_model: "standard"` as meaning paid,
// and said so in capitals. That is section C3 happening again: Cloudflare
// replaced "bundled" and "unbound" with "standard" for every account, free ones
// included, so the field describes a billing model and says nothing about which
// plan is under it. A named plan or a configured `cpu_ms` is an answer; a usage
// model is not.
const namesFree = planEvidence.some((entry) => /\bfree\b/i.test(entry.detail));
const namesPaid = planEvidence.some((entry) => /\bpaid\b/i.test(entry.detail));
const hasConfiguredCeiling = planEvidence.some((entry) => /"cpu_ms":\s*\d/.test(entry.detail));

console.log('');
if (namesFree !== namesPaid) {
  console.log(`A plan endpoint named the plan: ${namesPaid ? 'PAID' : 'FREE'}.`);
} else if (hasConfiguredCeiling) {
  console.log('⭐ A cpu_ms limit is configured, which is only possible on paid. The');
  console.log('   ceiling is that number rather than 10ms.');
} else {
  console.log('🔴 NOT ANSWERED. No endpoint this token can reach names the plan.');
  console.log('   `usage_model` is not the answer: "standard" replaced bundled/unbound');
  console.log('   for every account, free ones too, so it describes billing rather than');
  console.log('   plan. Reading it as "paid" is the section C3 mistake.');
  console.log('');
  console.log('   ⚠️ And this is a closed door for THIS credential, not proof nobody can');
  console.log('   see it. Section A0b is the precedent, in both halves: the API refused,');
  console.log('   the conclusion "cannot be measured" was written down, and then the');
  console.log('   account owner opened the dashboard and read the answer off the screen.');
  console.log('   Workers plan is on the dashboard under Workers & Pages > Plans.');
}

// Part 1 is the cheap question and the one that can close the debt outright, so
// it can be run on its own without waiting out the two minutes part 3 needs.
if (process.argv.includes('--plan-only')) {
  process.exit(0);
}

console.log('\n=== 2. Does the CPU split into a cold half and a warm half? ===\n');

const startedAt = Date.now();

/** One request, timed from here. Wall time only; the CPU number comes from the platform. */
async function hit(label) {
  const at = Date.now();
  const response = await fetch(`${ORIGIN}/health`, { headers: { 'cache-control': 'no-cache' } });
  await response.text();
  const took = Date.now() - at;
  console.log(`  ${label.padEnd(22)} HTTP ${response.status} in ${took}ms`);
  return { at, took, status: response.status };
}

// A lone request first. Section G14 measured that D1 charges a wake-up to
// whichever query goes first after an idle stretch, so this is the shape a cold
// request has; whether this particular one lands cold is not controllable from
// outside, which is why the wall time is printed rather than assumed.
console.log('one request, which may or may not land on a cold isolate:');
const lone = await hit('lone');

console.log('\nthirty back-to-back requests, which cannot all be cold:');
const burst = [];
for (let index = 0; index < 30; index += 1) {
  const response = await fetch(`${ORIGIN}/health`);
  await response.text();
  burst.push(Date.now());
}
const burstStart = burst[0];
const burstEnd = burst.at(-1);
console.log(`  30 requests in ${burstEnd - burstStart}ms`);

console.log(`\n  lone request wall time: ${lone.took}ms`);
console.log(`  burst mean wall time:   ${Math.round((burstEnd - burstStart) / 30)}ms`);
console.log('  ⚠️ Wall time is not CPU time. It is printed because it is the one thing');
console.log('     measurable from outside, and because a burst that was NOT faster would');
console.log('     mean the isolate never warmed and part 3 has nothing to separate.');

console.log('\n=== 3. What does the platform say those requests cost? ===\n');

const WINDOW = `
  query Window($accountTag: String!, $since: Time!, $until: Time!, $scriptName: String!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        workersInvocationsAdaptive(
          limit: 100
          filter: { datetime_geq: $since, datetime_leq: $until, scriptName: $scriptName }
        ) {
          sum { requests errors }
          quantiles { cpuTimeP50 cpuTimeP99 wallTimeP50 }
          dimensions { scriptName }
        }
      }
    }
  }`;

async function windowCost(label, since, until) {
  const response = await fetch(GRAPHQL, {
    method: 'POST',
    headers: authorized,
    body: JSON.stringify({
      query: WINDOW,
      variables: {
        accountTag: accountId,
        since: new Date(since).toISOString(),
        until: new Date(until).toISOString(),
        scriptName: SCRIPT,
      },
    }),
  });
  const body = await response.json().catch(() => ({}));
  const errors = Array.isArray(body.errors) ? body.errors : [];

  if (errors.length > 0) {
    console.log(`${label.padEnd(24)} refused:`);
    for (const error of errors) console.log(`    ${withoutOrigin(safe(error.message))}`);
    return null;
  }

  const rows = body.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
  if (rows.length === 0) {
    console.log(`${label.padEnd(24)} no rows yet`);
    return null;
  }

  const row = rows[0];
  const requests = row.sum?.requests ?? 0;
  const p50 = (row.quantiles?.cpuTimeP50 ?? 0) / 1000;
  const p99 = (row.quantiles?.cpuTimeP99 ?? 0) / 1000;
  console.log(
    `${label.padEnd(24)} requests=${requests} errors=${row.sum?.errors ?? 0} ` +
      `cpuP50=${p50.toFixed(1)}ms cpuP99=${p99.toFixed(1)}ms`,
  );
  return { requests, p50, p99 };
}

// ⚠️ Analytics lags. Asking immediately reports zero rows, which looks exactly
// like "the filter found nothing" and would be read as a result rather than as
// a wait. The window is widened by a minute on each side for the same reason:
// the datetime the platform stamps is not the one this process observed.
const minute = 60 * 1000;
console.log('waiting 120s for the dataset to catch up, because asking early reads as empty...\n');
await new Promise((resolve) => setTimeout(resolve, 120 * 1000));

await windowCost('this probe run', startedAt - minute, Date.now() + minute);
await windowCost('the burst alone', burstStart - 2000, burstEnd + 2000);

console.log('');
console.log('⚠️ What this cannot separate: the burst window still contains whatever else');
console.log('   reached this deployment in those seconds, and one lone request is one');
console.log('   sample, not a quantile. Read the numbers as a direction, not a bound.');
