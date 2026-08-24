/**
 * Does a cold start get killed on a deployment that is NOT on Workers Paid?
 *
 * ## Why this replaced debt 34
 *
 * Debt 34 asked why a 19ms median was not being killed by a 10ms ceiling. It
 * dissolved on 2026-08-25: the account is on Workers Paid, the ceiling is 30s,
 * and nothing was ever close to it (rules/02 section A0c).
 *
 * But the measurement it produced outlived it, and pointed somewhere sharper.
 * A cold request costs **32.1ms of CPU** (section A0d). BaseCLF is deployed into
 * the CUSTOMER's Cloudflare account, and customers are mostly on Free, where the
 * ceiling is 10ms. So the question that actually decides whether the product
 * works is:
 *
 *   does that 32ms count against the 10ms per-request ceiling, or against the
 *   1s start-up budget?
 *
 * If the former, every cold request on every free deployment is killed, and the
 * product does not work for most of the people it is aimed at. Nobody has
 * measured it. Section A0 wrote the hypothesis down on 2026-08-11 and it has sat
 * unexamined ever since, protected by an assumption that turned out to be wrong.
 *
 * ## The cheap half first
 *
 * The probe account runs a real BaseCLF deployment with real, sparse traffic.
 * Sparse traffic means most of its requests are cold (section A0d measured that
 * an isolate does not survive a four minute gap). So if cold requests were being
 * killed there, weeks of history would already show it.
 *
 * That costs one query and no new traffic, which is why it runs before anything
 * is driven. A measurement that can be made from records already kept should not
 * be made by generating more records.
 *
 * ⚠️ Reads only, and touches no database: AGENTS.md section 2e pins this
 * credential to one database and this asks about none of them.
 *
 * Prints no token, no account id, and no hostname.
 *
 *   node scripts/probe-free-tier-cold.mjs
 */

import { readFileSync } from 'node:fs';

const API = 'https://api.cloudflare.com/client/v4';
const GRAPHQL = `${API}/graphql`;

function fromEnvFile(name) {
  const line = readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .find((entry) => entry.startsWith(`${name}=`));
  return line === undefined ? '' : line.slice(name.length + 1).trim();
}

const token = fromEnvFile('STUDIO_PROBE_ACCOUNT_TOKEN');
const accountId = fromEnvFile('STUDIO_PROBE_ACCOUNT_ID');
const mainToken = fromEnvFile('CLOUDFLARE_API_TOKEN');

if (token === '' || accountId === '') {
  console.error('probe: .env needs STUDIO_PROBE_ACCOUNT_TOKEN and STUDIO_PROBE_ACCOUNT_ID.');
  process.exit(2);
}

// Section 2e rule 3. Two accounts, two credentials, never mixed.
if (token === mainToken) {
  console.error('probe: the probe token is the same value as CLOUDFLARE_API_TOKEN.');
  console.error('Those name different accounts. Refusing rather than guessing.');
  process.exit(2);
}

const authorized = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const safe = (text) => String(text).split(accountId).join('<account>');

async function readJson(path) {
  const response = await fetch(`${API}${path}`, { headers: authorized });
  const body = await response.json().catch(() => ({}));
  return { ok: response.status === 200 && body.success === true, status: response.status, body };
}

console.log('=== 1. Which plan is the probe account on? ===\n');

// Same four doors as `probe-cpu-ceiling.mjs`, and the same discipline: named
// fields only. `usage_model` is NOT an answer, for the reason recorded in
// rules/02 section A0c: "standard" replaced bundled/unbound on every account.
const settings = await readJson(`/accounts/${accountId}/workers/account-settings`);
const subscriptions = await readJson(`/accounts/${accountId}/subscriptions`);

if (settings.ok) {
  console.log(`  workers account settings   ${JSON.stringify(settings.body.result ?? {})}`);
} else {
  console.log(
    `  workers account settings   refused: ${safe(settings.body.errors?.[0]?.message ?? settings.status)}`,
  );
}

let namedPlan = null;

if (subscriptions.ok) {
  const products = (subscriptions.body.result ?? []).map(
    (entry) => `${entry.product?.name ?? '?'} (${entry.rate_plan?.id ?? '?'})`,
  );
  console.log(
    `  subscriptions              ${products.length === 0 ? '(none)' : products.join(', ')}`,
  );

  // No Workers subscription at all is the informative case here: a paid plan is
  // something you buy, so its absence from a readable list means free.
  const workers = products.filter((name) => /worker/i.test(name));
  namedPlan = workers.length > 0 ? 'paid' : 'free';
  console.log(
    workers.length > 0
      ? `  ⭐ A Workers subscription exists, so this account is PAID too.`
      : '  ⭐ NO Workers subscription in a readable list, so this account is on FREE.',
  );
} else {
  console.log(
    `  subscriptions              refused: ${safe(subscriptions.body.errors?.[0]?.message ?? subscriptions.status)}`,
  );
  console.log('  ⚠️ So the plan is NOT established for this account either. Everything');
  console.log('     below is still worth reading, but only in one direction: errors would');
  console.log('     prove a problem, while no errors could just mean this account is paid.');
}

console.log('\n=== 2. What does the history already say? ===\n');

const HISTORY = `
  query History($accountTag: String!, $since: Date!, $until: Date!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        workersInvocationsAdaptive(limit: 100, filter: { date_geq: $since, date_leq: $until }) {
          sum { requests errors }
          quantiles { cpuTimeP50 cpuTimeP99 }
          dimensions { scriptName }
        }
      }
    }
  }`;

const day = 24 * 60 * 60 * 1000;
const asDate = (at) => new Date(at).toISOString().slice(0, 10);

const response = await fetch(GRAPHQL, {
  method: 'POST',
  headers: authorized,
  body: JSON.stringify({
    query: HISTORY,
    variables: {
      accountTag: accountId,
      since: asDate(Date.now() - 28 * day),
      until: asDate(Date.now()),
    },
  }),
});

const body = await response.json().catch(() => ({}));
const errors = Array.isArray(body.errors) ? body.errors : [];

if (errors.length > 0) {
  console.log('  refused:');
  for (const error of errors) console.log(`    ${safe(error.message)}`);
  process.exit(1);
}

const rows = body.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];

if (rows.length === 0) {
  console.log('  no rows in 28 days, so this account has served nothing and proves nothing.');
  process.exit(0);
}

let totalRequests = 0;
let totalErrors = 0;

for (const row of rows) {
  const requests = row.sum?.requests ?? 0;
  const failed = row.sum?.errors ?? 0;
  totalRequests += requests;
  totalErrors += failed;
  const p50 = ((row.quantiles?.cpuTimeP50 ?? 0) / 1000).toFixed(1);
  const p99 = ((row.quantiles?.cpuTimeP99 ?? 0) / 1000).toFixed(1);
  console.log(
    `  ${String(row.dimensions?.scriptName ?? '?').padEnd(24)} ` +
      `requests=${String(requests).padStart(6)} errors=${String(failed).padStart(4)} ` +
      `cpuP50=${p50.padStart(6)}ms cpuP99=${p99.padStart(7)}ms`,
  );
}

console.log(`\n  28 days: ${totalRequests} request(s), ${totalErrors} error(s).`);
console.log('');

if (totalRequests === 0) {
  console.log('  Nothing was served, so nothing follows.');
} else if (namedPlan === 'free' && totalErrors === 0) {
  console.log('⭐⭐ A FREE account served every one of those requests without a single');
  console.log('   error, on a deployment quiet enough that most starts are cold, and a');
  console.log('   cold start costs 32.1ms against a 10ms per-request ceiling.');
  console.log('');
  console.log('   So start-up CPU does NOT count against the per-request ceiling. That is');
  console.log('   the hypothesis section A0 wrote on 2026-08-11 and never tested, and it');
  console.log('   is the answer to whether this product works for free-tier customers.');
} else if (totalErrors === 0) {
  console.log('  No errors, but the plan was not established above, so this is consistent');
  console.log('  with a paid account and proves nothing on its own.');
} else {
  const rate = ((totalErrors / totalRequests) * 100).toFixed(2);
  console.log(`🔴 ${totalErrors} error(s), ${rate}% of requests. That is a rate worth explaining`);
  console.log('   before anything is concluded: an error here is not necessarily a CPU kill,');
  console.log('   and this dataset does not say which kind it was. `wrangler tail` does.');
}

console.log('');
console.log('⚠️ What this cannot show either way: WHICH requests were cold. The argument');
console.log('   rests on traffic being sparse enough that most of them must be, which is');
console.log('   an inference from the request count, not a measurement of any one request.');

console.log('\n=== 3. What KIND of failure were they? ===\n');

// The question the counts above cannot answer, and the one that decides it.
// `outcome` separates a request the platform killed for CPU from one the code
// threw inside. Two errors in 150 is a low enough rate that "cold starts are
// being killed" would be a strange explanation, but a rate is an argument and
// an outcome is a measurement.
const OUTCOMES = `
  query Outcomes($accountTag: String!, $since: Date!, $until: Date!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        workersInvocationsAdaptive(limit: 100, filter: { date_geq: $since, date_leq: $until }) {
          sum { requests }
          dimensions { status usageModel scriptName }
        }
      }
    }
  }`;

const outcomeAnswer = await fetch(GRAPHQL, {
  method: 'POST',
  headers: authorized,
  body: JSON.stringify({
    query: OUTCOMES,
    variables: {
      accountTag: accountId,
      since: asDate(Date.now() - 28 * day),
      until: asDate(Date.now()),
    },
  }),
});

const outcomeBody = await outcomeAnswer.json().catch(() => ({}));
const outcomeErrors = Array.isArray(outcomeBody.errors) ? outcomeBody.errors : [];

if (outcomeErrors.length > 0) {
  console.log('  the guess was refused:');
  for (const error of outcomeErrors) console.log(`    ${safe(error.message)}`);

  // Ask the schema rather than guessing a second name. This project has a
  // standing rule about settling a question by calling instead of reading, and
  // introspection is that call: it returns the real list, so a wrong guess is
  // answered once instead of iterated on.
  console.log('\n  asking the schema which dimensions this dataset actually has:\n');

  const introspection = await fetch(GRAPHQL, {
    method: 'POST',
    headers: authorized,
    body: JSON.stringify({
      // The Dimensions type, not the wrapper. The first attempt asked the
      // wrapper and got back `sum`, `quantiles`, `dimensions`, which is the
      // shape of the query rather than the list of things it can group by.
      query: `{
        __type(name: "AccountWorkersInvocationsAdaptiveDimensions") {
          fields { name type { name kind ofType { name } } }
        }
      }`,
    }),
  });

  const schema = await introspection.json().catch(() => ({}));
  const fields = schema.data?.__type?.fields ?? [];

  if (fields.length === 0) {
    console.log('    the type name was wrong too, so this door needs a different key.');
  } else {
    for (const field of fields) {
      const typeName = field.type?.name ?? field.type?.ofType?.name ?? field.type?.kind ?? '?';
      console.log(`    ${String(field.name).padEnd(24)} ${typeName}`);
    }
  }

  console.log('');
  console.log('  ⚠️ So the kind of failure stays unknown from here unless one of the names');
  console.log('     above carries it. Live, `wrangler tail` reports an outcome per');
  console.log('     invocation, which is the other way in.');
} else {
  const outcomeRows = outcomeBody.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];

  for (const row of outcomeRows) {
    console.log(
      `  ${String(row.dimensions?.scriptName ?? '?').padEnd(16)} ` +
        `status=${String(row.dimensions?.status ?? '?').padEnd(22)} ` +
        `usageModel=${String(row.dimensions?.usageModel ?? '?').padEnd(12)} ` +
        `${row.sum?.requests ?? 0}`,
    );
  }

  // A CPU kill is the one that would mean the product is broken for free-tier
  // customers. Matched on "cpu" rather than on an exact string because the
  // vocabulary of this field has not been measured; a status this does not
  // recognise shows up in the listing above rather than being counted as fine.
  const killed = outcomeRows
    .filter((row) => /cpu/i.test(String(row.dimensions?.status ?? '')))
    .reduce((total, row) => total + (row.sum?.requests ?? 0), 0);

  // ⭐ `usageModel` may settle the plan question this probe could not open from
  // the billing side. Reported as what it is, a dimension of the traffic, not
  // read as a plan name: rules/02 section A0c is the record of exactly that
  // confusion costing an afternoon.
  const models = [...new Set(outcomeRows.map((row) => row.dimensions?.usageModel).filter(Boolean))];
  if (models.length > 0) {
    console.log(`\n  usageModel seen in traffic: ${models.join(', ')}`);
  }

  console.log('');
  if (killed > 0) {
    console.log(`🔴🔴 ${killed} request(s) were killed for CPU. If this account is on Free,`);
    console.log('   that is a cold start hitting the 10ms ceiling, and it means the product');
    console.log('   fails on the tier most of its users will be on.');
  } else {
    console.log('⭐ NOT ONE request was killed for CPU in 28 days, on a deployment whose');
    console.log('   traffic is sparse enough that most starts are cold, and whose measured');
    console.log('   cpuP99 is well above the 10ms free ceiling.');
    console.log('');
    console.log('   ⚠️ Read the direction carefully: this is strong evidence that start-up');
    console.log('   CPU is not charged against the per-request ceiling, and it is NOT proof,');
    console.log('   because the plan of this account could not be established above. A paid');
    console.log('   account would produce the same clean sheet for a different reason.');
  }
}
