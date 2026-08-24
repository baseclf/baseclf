/**
 * Why did a minute report 60 requests when 40 were sent?
 *
 * `probe-cpu-by-path.mjs` drove exactly 40 requests at `/health` and the
 * dataset answered 60 for that minute. Undercounting was explained (a window
 * opening late, a burst split across two minute buckets), but 60 is MORE than
 * the truth, and neither explanation produces that.
 *
 * It matters beyond tidiness. Every CPU conclusion in rules/02 sections A0d to
 * A0g rests on this dataset, and an instrument that reports above the truth in
 * one place can report below it in another. An unexplained overcount is an
 * unmeasured error bar on all of it.
 *
 * ## What is being separated
 *
 *   A. other traffic     -> something else called this deployment that minute.
 *                           Then the count is right and the assumption that
 *                           this deployment is quiet is what is wrong.
 *   B. one call, several
 *      invocations       -> a request that fans out inside the platform, so the
 *                           dataset counts more than the caller sent.
 *   C. double counting   -> the same invocation appearing under two dimension
 *                           values, so summing rows inflates the total.
 *
 * C is the dangerous one, because it would mean every summed count in this
 * project is wrong by an unknown factor. It is also the easiest to test: ask
 * the same minute grouped several different ways and see whether the totals
 * agree with each other.
 *
 * Reads only. Prints no token, no account id, no hostname.
 *
 *   node scripts/probe-analytics-overcount.mjs 2026-08-24T17:22:00Z
 */

import { readFileSync } from 'node:fs';

const API = 'https://api.cloudflare.com/client/v4';
const GRAPHQL = `${API}/graphql`;
const SCRIPT = 'baseclf';

const minute = process.argv[2];
if (minute === undefined || Number.isNaN(Date.parse(minute))) {
  console.error('usage: node scripts/probe-analytics-overcount.mjs <ISO minute>');
  console.error('  e.g. 2026-08-24T17:22:00Z');
  process.exit(2);
}

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

const since = new Date(Date.parse(minute)).toISOString();
const until = new Date(Date.parse(minute) + 59_000).toISOString();

/**
 * Ask the same minute grouped by whatever dimensions are named.
 *
 * ⚠️ `confidence` is deliberately NOT selected, after two attempts: it takes an
 * argument AND a selection set (`confidence { level }` is refused with "level:
 * not a number"; `confidence(level: 99)` with "object field must have
 * selections"), and the exact shape was not worth a third guess.
 *
 * Its existence is the point rather than its value. A dataset named
 * `...Adaptive` that carries a confidence field is a dataset that SAMPLES, and
 * a sampled count scaled back up lands above the truth as readily as below it.
 * Which is what the counts here show: 31 requests driven were reported as 15,
 * and 40 driven were reported as 60.
 */
async function groupedBy(fields) {
  const query = `
    query Grouped($accountTag: String!, $since: Time!, $until: Time!, $scriptName: String!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          workersInvocationsAdaptive(
            limit: 100
            filter: { datetime_geq: $since, datetime_leq: $until, scriptName: $scriptName }
          ) {
            sum { requests }
            dimensions { ${fields.join(' ')} }
          }
        }
      }
    }`;

  const response = await fetch(GRAPHQL, {
    method: 'POST',
    headers: authorized,
    body: JSON.stringify({
      query,
      variables: { accountTag: accountId, since, until, scriptName: SCRIPT },
    }),
  });

  const body = await response.json().catch(() => ({}));
  const errors = Array.isArray(body.errors) ? body.errors : [];
  if (errors.length > 0) return { refused: errors.map((error) => safe(error.message)).join('; ') };

  const rows = body.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
  return {
    total: rows.reduce((sum, row) => sum + (row.sum?.requests ?? 0), 0),
    rows: rows.map((row) => ({
      requests: row.sum?.requests ?? 0,
      // ⭐ The dataset is named `...Adaptive`, and the schema carries a
      // `confidence` field. Both point at the same thing: these numbers may be
      // sampled and scaled back up rather than counted. That would explain an
      // answer above the truth as readily as one below it, which is what a
      // window reporting 60 for 40 sent requests looks like.
      confidence: row.confidence ?? null,
      dimensions: row.dimensions ?? {},
    })),
  };
}

console.log(`the minute ${minute}, grouped several ways:\n`);

// If these totals disagree, summing rows is unsafe and explanation C is live.
// If they all agree, the count is a real count and the question becomes what
// produced the extra requests.
const GROUPINGS = [
  ['datetimeMinute'],
  ['status'],
  ['scriptVersion'],
  ['coloCode'],
  ['cacheStatus'],
];

const totals = [];

for (const fields of GROUPINGS) {
  const answer = await groupedBy(fields);
  if (answer.refused !== undefined) {
    console.log(`  by ${fields.join('+').padEnd(16)} refused: ${answer.refused}`);
    continue;
  }

  totals.push({ by: fields.join('+'), total: answer.total });
  console.log(
    `  by ${fields.join('+').padEnd(16)} total=${String(answer.total).padStart(4)}  (${answer.rows.length} row(s))`,
  );

  for (const row of answer.rows) {
    const described = Object.entries(row.dimensions)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');
    console.log(
      `      ${String(row.requests).padStart(4)}  confidence=${String(row.confidence).padEnd(6)} ${described}`,
    );
  }
}

console.log('');

const distinct = new Set(totals.map((entry) => entry.total));

if (distinct.size > 1) {
  console.log('🔴🔴 THE TOTALS DISAGREE WITH EACH OTHER depending on how the same minute is');
  console.log('   grouped. So summing rows does NOT give a request count, and every summed');
  console.log('   figure in rules/02 sections A0d to A0g needs re-reading with that in mind.');
} else {
  console.log(`⭐ Every grouping agrees on ${[...distinct][0]}, so the count itself is stable`);
  console.log('   and rows can be summed safely. The overcount is then real traffic or real');
  console.log('   invocations, not an artefact of how the question was asked.');
  console.log('');
  console.log('   Read the per-row breakdown above: a second scriptVersion, a second colo,');
  console.log('   or a status nobody drove would each name a different source.');
}
