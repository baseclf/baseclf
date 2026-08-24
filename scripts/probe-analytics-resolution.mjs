/**
 * What does one row of `workersInvocationsAdaptive` actually cover?
 *
 * Two runs of `probe-cpu-by-path.mjs` asked for a window holding exactly 40
 * requests and were answered with 15, then 26, then 60. Sixty is the
 * interesting one: it is MORE than were sent, so the window is not merely
 * dropping requests, and neither "the dataset samples" nor "my window opened
 * late" explains a number above the truth.
 *
 * The suspicion is that the answer was never one row. Both probes read
 * `rows[0]` and reported it as though it were the whole window, so a dataset
 * that returns one row per time bucket would give a count for one bucket while
 * the burst straddled two. That is a bug in the instrument, and it is the third
 * time this project has had to calibrate a measuring tool before trusting it
 * (rules/01 section G9, section C6 here).
 *
 * So this asks nothing new of the deployment. It re-reads what is already
 * recorded, prints EVERY row with its datetime dimension, and lets the shape of
 * the answer say what a row covers.
 *
 * Reads only. Prints no token and no account id.
 *
 *   node scripts/probe-analytics-resolution.mjs
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

if (process.env.CLOUDFLARE_API_TOKEN !== undefined && process.env.CLOUDFLARE_API_TOKEN !== token) {
  console.error('probe: the process carries a different CLOUDFLARE_API_TOKEN than .env holds.');
  process.exit(2);
}

const authorized = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const safe = (text) => String(text).split(accountId).join('<account>');

// `datetimeMinute` is the guess at the bucket. If the dataset does not have it
// the schema says so, which is the answer just as much as a column of numbers.
const QUERY = `
  query Resolution($accountTag: String!, $since: Time!, $until: Time!, $scriptName: String!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        workersInvocationsAdaptive(
          limit: 100
          filter: { datetime_geq: $since, datetime_leq: $until, scriptName: $scriptName }
          orderBy: [datetimeMinute_ASC]
        ) {
          sum { requests }
          quantiles { cpuTimeP50 cpuTimeP99 }
          dimensions { datetimeMinute }
        }
      }
    }
  }`;

// Minutes to look back, so the same script can answer "what did my burst do"
// and "what happens here when nobody is driving it".
const LOOKBACK_MINUTES = Number(process.argv[2] ?? '45');
const until = Date.now();
const since = until - LOOKBACK_MINUTES * 60 * 1000;

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
  console.log('The query was refused, and the refusal is the finding:\n');
  for (const error of errors) console.log(`  ${safe(error.message)}`);
  console.log('\nIf it names datetimeMinute, that dimension does not exist and the bucket');
  console.log('is something else. Read the message rather than guessing again.');
  process.exit(1);
}

const rows = body.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];

console.log(`the last ${LOOKBACK_MINUTES} minutes for this script, one line per row returned:\n`);

if (rows.length === 0) {
  console.log('  no rows at all, so the window itself found nothing.');
} else {
  let total = 0;
  for (const row of rows) {
    const requests = row.sum?.requests ?? 0;
    total += requests;
    const p50 = ((row.quantiles?.cpuTimeP50 ?? 0) / 1000).toFixed(1);
    const p99 = ((row.quantiles?.cpuTimeP99 ?? 0) / 1000).toFixed(1);
    console.log(
      `  ${String(row.dimensions?.datetimeMinute ?? '?').padEnd(22)} ` +
        `requests=${String(requests).padStart(4)} cpuP50=${p50.padStart(6)}ms cpuP99=${p99.padStart(7)}ms`,
    );
  }
  console.log(`\n  ${rows.length} row(s), ${total} request(s) in total.`);
}

console.log('');
console.log('How to read this:');
console.log('  many rows, one per minute -> a row is a MINUTE, and reading rows[0] as the');
console.log('     whole window was the bug. A burst crossing a minute boundary is split,');
console.log('     which is exactly how 40 sent requests were reported as 15 and as 26.');
console.log('  one row for everything    -> the bucket is the whole window, and the counts');
console.log('     above and below 40 need a different explanation entirely.');
console.log('');
console.log('⚠️ Either way the quantiles are PER ROW. They cannot be averaged into one');
console.log('   number for a burst; a median of medians is not a median.');
