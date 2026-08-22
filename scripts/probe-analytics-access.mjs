/**
 * Can the credential this project already asks for read Workers analytics?
 *
 * The Health screen in the Studio is the last one still drawing fixtures, and
 * the numbers it wants (requests, errors, CPU time) exist in exactly one place:
 * the GraphQL Analytics API, dataset `workersInvocationsAdaptive`. `wrangler
 * tail` does not carry them (rules/02 section A2). So the screen is only
 * possible if the operator's own credential, held by the local bridge, can
 * query that dataset.
 *
 * ⚠️ This is a probe rather than a reading of the docs on purpose.
 * `REQUIRED_TOKEN_PERMISSIONS` does not list `Account · Account Analytics ·
 * Read`, while the OAuth scope `account:read` is described by Cloudflare as
 * "account details, analytics, memberships". Those two facts point opposite
 * ways, and rules/02 section C10 is the lesson from the last time this project
 * settled such a question by reading a scope list: the list said R2 was out of
 * reach and the API created the bucket anyway. Ask the API.
 *
 * Prints no token and no account id. The account id is a real identifier under
 * rules/05 section B, and a terminal ends up in screenshots.
 *
 *   node scripts/probe-analytics-access.mjs
 */

import { readFileSync } from 'node:fs';

const API = 'https://api.cloudflare.com/client/v4/graphql';

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

// Whether the process already carries a different token, which rules/02 section
// C1 records as the trap that cost this project a day: the environment wins over
// the file, silently, so a probe can measure a credential nobody meant to test.
if (process.env.CLOUDFLARE_API_TOKEN !== undefined && process.env.CLOUDFLARE_API_TOKEN !== token) {
  console.error('probe: the process carries a different CLOUDFLARE_API_TOKEN than .env holds.');
  console.error('Refusing, because the answer would be about a credential nobody chose to test.');
  process.exit(2);
}

const day = 24 * 60 * 60 * 1000;
const asDate = (at) => new Date(at).toISOString().slice(0, 10);
const until = Date.now();
const since = until - 7 * day;

const query = `
  query ProbeAnalytics($accountTag: String!, $since: Date!, $until: Date!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        workersInvocationsAdaptive(
          limit: 10
          filter: { date_geq: $since, date_leq: $until }
        ) {
          sum { requests errors }
          quantiles { cpuTimeP50 cpuTimeP99 wallTimeP50 }
        }
      }
    }
  }`;

const response = await fetch(API, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    query,
    variables: { accountTag: accountId, since: asDate(since), until: asDate(until) },
  }),
});

console.log(`HTTP ${response.status}`);

const body = await response.json();

// GraphQL answers 200 with an errors array, so the status alone says nothing.
// A probe that reported "200, works" here would be the same shape of wrong as
// the one in rules/02 section C2b.
if (Array.isArray(body.errors) && body.errors.length > 0) {
  console.log('REFUSED. The API answered with errors:');
  for (const error of body.errors) {
    const path = Array.isArray(error.path) ? ` at ${error.path.join('.')}` : '';
    console.log(`  ${error.message}${path}`);
    const code = error.extensions?.code;
    if (code !== undefined) console.log(`  code: ${code}`);
  }
  console.log('');
  console.log('So the Health screen needs a permission the deploy credential does not carry.');
  process.exit(1);
}

const accounts = body.data?.viewer?.accounts;
if (!Array.isArray(accounts)) {
  console.log('UNCLEAR. No errors, and no accounts array either. Raw shape:');
  console.log(JSON.stringify(body, null, 1).slice(0, 800));
  process.exit(2);
}

if (accounts.length === 0) {
  // Not the same as a refusal, and worth separating: a filter that matches
  // nothing looks identical to a permission failure if both are called "no data".
  console.log('ALLOWED, but the account filter matched nothing.');
  console.log('The query was accepted, so the permission is there; the filter or window is wrong.');
  process.exit(1);
}

const rows = accounts[0].workersInvocationsAdaptive ?? [];
console.log(`ALLOWED. ${rows.length} row(s) for the last 7 days.`);
for (const row of rows.slice(0, 5)) {
  const sum = row.sum ?? {};
  const q = row.quantiles ?? {};
  console.log(
    `  requests=${sum.requests ?? '?'} errors=${sum.errors ?? '?'} ` +
      `cpuP50=${q.cpuTimeP50 ?? '?'}us cpuP99=${q.cpuTimeP99 ?? '?'}us`,
  );
}
if (rows.length === 0) {
  console.log('  The dataset is readable and this window is empty, which is still a yes.');
}
