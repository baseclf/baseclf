/**
 * What did the platform actually record for the probe worker's requests?
 *
 * The ladder in `probe-cpu-limit-applied.mjs` produced a contradiction that no
 * amount of staring at HTTP codes will settle:
 *
 *   limits.cpu_ms = 10 is stored on the script
 *   60 million loops (~600ms of wall time) answered 200
 *   200 million loops answered 503 with a Cloudflare HTML error page
 *
 * If a 10ms ceiling were enforced, the 60M request would have died long before
 * the 200M one. So either the stored limit is not the enforced limit, or the
 * 503 is not a CPU kill at all and something else broke at that size.
 *
 * An HTTP status cannot tell those apart, and the HTML body is a generic error
 * page. `status` in `workersInvocationsAdaptive` can: it distinguishes a request
 * the platform killed from one that threw, and names which kind (measured in
 * rules/02 section A0e, where `outcome` turned out not to exist and `status`
 * did).
 *
 * This asks that, per minute, for the throwaway worker only.
 *
 * Reads only. Prints no token, no account id, no hostname.
 *
 *   node scripts/probe-cpu-kill-status.mjs
 */

import { readFileSync } from 'node:fs';

const API = 'https://api.cloudflare.com/client/v4';
const GRAPHQL = `${API}/graphql`;
const SCRIPT = 'baseclf-cpu-probe';

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
const safe = (text) => String(text).split(accountId).join('<account>');

const QUERY = `
  query Kills($accountTag: String!, $since: Time!, $until: Time!, $scriptName: String!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        workersInvocationsAdaptive(
          limit: 100
          filter: { datetime_geq: $since, datetime_leq: $until, scriptName: $scriptName }
          orderBy: [datetimeMinute_ASC]
        ) {
          sum { requests errors }
          quantiles { cpuTimeP50 cpuTimeP99 }
          dimensions { datetimeMinute status }
        }
      }
    }
  }`;

const until = Date.now();
const since = until - 40 * 60 * 1000;

const response = await fetch(GRAPHQL, {
  method: 'POST',
  headers: authorized,
  body: JSON.stringify({
    query: QUERY,
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
  for (const error of errors) console.log(`refused: ${safe(error.message)}`);
  process.exit(1);
}

const rows = body.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];

if (rows.length === 0) {
  console.log('no rows in the last 40 minutes, so the dataset has not caught up yet.');
  process.exit(0);
}

console.log('the throwaway worker, per minute and per status:\n');

const byStatus = new Map();

for (const row of rows) {
  const status = String(row.dimensions?.status ?? '?');
  const requests = row.sum?.requests ?? 0;
  byStatus.set(status, (byStatus.get(status) ?? 0) + requests);

  console.log(
    `  ${String(row.dimensions?.datetimeMinute ?? '?').padEnd(22)} ` +
      `${status.padEnd(24)} requests=${String(requests).padStart(3)} ` +
      `cpuP50=${((row.quantiles?.cpuTimeP50 ?? 0) / 1000).toFixed(1).padStart(7)}ms ` +
      `cpuP99=${((row.quantiles?.cpuTimeP99 ?? 0) / 1000).toFixed(1).padStart(8)}ms`,
  );
}

console.log('\ntotals by status:');
for (const [status, count] of [...byStatus].sort((left, right) => right[1] - left[1])) {
  console.log(`  ${status.padEnd(26)} ${count}`);
}

console.log('');

// The vocabulary of this field has not been measured, so the match is loose and
// the full listing is printed above: an unrecognised status is visible rather
// than silently counted as fine.
const cpuKills = [...byStatus].filter(([status]) => /cpu|exceed|limit/i.test(status));

if (cpuKills.length > 0) {
  console.log('⭐ The platform DID record CPU kills:');
  for (const [status, count] of cpuKills) console.log(`     ${status}: ${count}`);
  console.log('');
  console.log('   So the ceiling is enforced, and the loop count where it began is the');
  console.log('   real cost boundary. Compare the cpuP99 on those minutes against the');
  console.log('   stored cpu_ms to see how close the two are.');
} else {
  console.log('🔴 NO status here names a CPU kill, even for the request that answered 503.');
  console.log('   So the 503 was something else, and a stored cpu_ms of 10 did NOT kill a');
  console.log('   request that spent hundreds of milliseconds of CPU.');
  console.log('');
  console.log('   ⚠️ Which means `limits.cpu_ms` on this account is stored but not being');
  console.log('   enforced as written, and the start-up question cannot be answered by');
  console.log('   setting it. Record the finding; do not work around it silently.');
}

console.log('');
console.log('⚠️ cpuTime here is per MINUTE bucket, so a minute holding both a cheap and an');
console.log('   expensive request reports a quantile over both. Read the counts with it.');
