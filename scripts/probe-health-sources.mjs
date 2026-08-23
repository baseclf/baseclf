/**
 * Where would a live Health screen get its numbers, and can it name one deployment?
 *
 * The Health screen is the last one in the Studio still drawing fixtures. Before any
 * of it is written, three things have to be measured rather than assumed, and the
 * first one decides whether the screen is honest at all.
 *
 * ## 1. Does filtering by script actually work?
 *
 * rules/02 section A0b measured the analytics dataset **with no scriptName filter**,
 * so `requests=13061` was the whole account: `baseclf` and `baseclf-site` together.
 * A Health screen that printed that number beside one deployment's name would be
 * reporting somebody else's traffic, which is the thing decision Q4 exists to forbid.
 *
 * And it cannot be settled by reading: section A0 recorded that the `scriptName`
 * dimension came back `__unknown__` even when a filter was set, on an account that
 * had exactly one Worker at the time, so the filter was never really under test.
 *
 * Calibrated in both directions, because "filtering works" and "the filter is
 * ignored" produce the same shape of answer if you only ask once: query the account
 * unfiltered, then once per script. If the filter is ignored, every total matches the
 * unfiltered one. If it works, the parts are smaller than the whole.
 *
 * ## 2. Are rows read and written reachable at all?
 *
 * The fixture screen shows rows read and rows written. Those are D1 numbers, not
 * Worker numbers, so they are not in `workersInvocationsAdaptive`. The field names
 * here are a guess on purpose: the probe prints whatever the API says back, so a
 * wrong guess is answered by the schema instead of by me.
 *
 * ## 3. Is the database size the API reports worth printing?
 *
 * `d1 list` carries a `file_size`, which is the obvious source. It also carries
 * `num_tables`, which rules/01 section G12 measured as **0 for a database with seven
 * tables**. That discredits the field, not the endpoint, so this asks the database
 * itself with `PRAGMA page_count` and `page_size` and compares.
 *
 * Answered on the first run, and kept because the answer is a dead end worth being
 * able to reproduce: `page_count` is refused with `not authorized: SQLITE_AUTH`, so
 * `file_size` has no second opinion at all. rules/01 section G20.
 *
 * Reads only, and prints no token, no account id, and no database id.
 *
 *   node scripts/probe-health-sources.mjs
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

const token = fromEnvFile('CLOUDFLARE_API_TOKEN');
const accountId = fromEnvFile('CLOUDFLARE_ACCOUNT_ID');

if (token === '' || accountId === '') {
  console.error('probe: .env is missing CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID.');
  process.exit(2);
}

// The environment wins over the file, silently. rules/02 section C1 is the day this
// cost, so refuse rather than measure a credential nobody chose to test.
if (process.env.CLOUDFLARE_API_TOKEN !== undefined && process.env.CLOUDFLARE_API_TOKEN !== token) {
  console.error('probe: the process carries a different CLOUDFLARE_API_TOKEN than .env holds.');
  process.exit(2);
}

const authorized = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const day = 24 * 60 * 60 * 1000;
const asDate = (at) => new Date(at).toISOString().slice(0, 10);
const until = Date.now();
const since = until - 7 * day;

async function graphql(query, variables) {
  const response = await fetch(GRAPHQL, {
    method: 'POST',
    headers: authorized,
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json().catch(() => ({}));
  const errors = Array.isArray(body.errors) ? body.errors : [];
  return { status: response.status, body, errors };
}

function reportErrors(errors, indent = '  ') {
  for (const error of errors) {
    const path = Array.isArray(error.path) ? ` at ${error.path.join('.')}` : '';
    console.log(`${indent}${error.message}${path}`);
  }
}

console.log('=== 1. Can the analytics dataset be filtered down to one script? ===\n');

const INVOCATIONS = `
  query ScriptTotals($accountTag: String!, $since: Date!, $until: Date!, $filter: ZoneWorkersInvocationsAdaptiveFilter_InputObject) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        workersInvocationsAdaptive(limit: 100, filter: $filter) {
          sum { requests errors }
          quantiles { cpuTimeP50 cpuTimeP99 }
          dimensions { scriptName }
        }
      }
    }
  }`;

/** One total per query, so an ignored filter shows up as three identical numbers. */
async function totalFor(scriptName) {
  const filter = { date_geq: asDate(since), date_leq: asDate(until) };
  if (scriptName !== null) filter.scriptName = scriptName;

  const { errors, body } = await graphql(INVOCATIONS, {
    accountTag: accountId,
    since: asDate(since),
    until: asDate(until),
    filter,
  });

  if (errors.length > 0) return { failed: true, errors };

  const rows = body.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
  const requests = rows.reduce((total, row) => total + (row.sum?.requests ?? 0), 0);
  const errorCount = rows.reduce((total, row) => total + (row.sum?.errors ?? 0), 0);
  const names = [...new Set(rows.map((row) => row.dimensions?.scriptName ?? '(no dimension)'))];
  // Quantiles do not add up across rows, so this is only meaningful for one script.
  const cpu = rows.length === 1 ? (rows[0].quantiles ?? {}) : {};
  return { failed: false, requests, errors: errorCount, rows: rows.length, names, cpu };
}

const SCRIPTS = ['baseclf', 'baseclf-site', 'baseclf-demo'];
const whole = await totalFor(null);

if (whole.failed) {
  console.log('The unfiltered query was refused, so nothing below can be measured:');
  reportErrors(whole.errors);
  process.exit(1);
}

console.log(`unfiltered      requests=${whole.requests} rows=${whole.rows}`);
console.log(`                scriptName dimension came back as: ${whole.names.join(', ')}`);

const parts = [];
for (const name of SCRIPTS) {
  const part = await totalFor(name);
  if (part.failed) {
    console.log(`${name.padEnd(16)}refused:`);
    reportErrors(part.errors, '                ');
    continue;
  }
  const cpu =
    part.cpu.cpuTimeP50 === undefined
      ? ''
      : ` cpuP50=${(part.cpu.cpuTimeP50 / 1000).toFixed(1)}ms cpuP99=${(part.cpu.cpuTimeP99 / 1000).toFixed(1)}ms`;
  console.log(`${name.padEnd(16)}requests=${part.requests} errors=${part.errors}${cpu}`);
  parts.push({ name, ...part });
}

const filterWorks =
  parts.length > 1 &&
  parts.some((part) => part.requests !== whole.requests) &&
  new Set(parts.map((part) => part.requests)).size > 1;

console.log('');
if (filterWorks) {
  const sum = parts.reduce((total, part) => total + part.requests, 0);
  console.log('⭐ The filter WORKS: the parts differ from each other and from the whole.');
  console.log(`   parts sum to ${sum}, whole is ${whole.requests}.`);
  console.log('   A Health screen can name one deployment and mean it.');
} else {
  console.log('🔴 The filter appears to be IGNORED: every total came back the same.');
  console.log('   Any number shown beside one deployment would be the whole account.');
  console.log('   The screen has to say "this account" or not show the number at all.');
}

console.log('\n=== 2. Are rows read and written reachable? ===\n');

// The dataset name and its fields are the guess. Whatever comes back, including a
// schema complaint, is the answer; that is cheaper than reading docs that have been
// wrong about this platform before.
const D1_DATASETS = [
  {
    name: 'd1AnalyticsAdaptiveGroups',
    query: `
      query D1Rows($accountTag: String!, $since: Date!, $until: Date!) {
        viewer {
          accounts(filter: { accountTag: $accountTag }) {
            d1AnalyticsAdaptiveGroups(limit: 100, filter: { date_geq: $since, date_leq: $until }) {
              sum { readQueries writeQueries rowsRead rowsWritten }
              dimensions { databaseId }
            }
          }
        }
      }`,
  },
];

for (const dataset of D1_DATASETS) {
  const { errors, body } = await graphql(dataset.query, {
    accountTag: accountId,
    since: asDate(since),
    until: asDate(until),
  });

  if (errors.length > 0) {
    console.log(`${dataset.name}: refused or misnamed.`);
    reportErrors(errors);
    continue;
  }

  const rows = body.data?.viewer?.accounts?.[0]?.[dataset.name] ?? [];
  console.log(`${dataset.name}: readable, ${rows.length} row(s).`);
  for (const row of rows.slice(0, 4)) {
    const sum = row.sum ?? {};
    console.log(
      `  rowsRead=${sum.rowsRead ?? '?'} rowsWritten=${sum.rowsWritten ?? '?'} ` +
        `readQueries=${sum.readQueries ?? '?'} writeQueries=${sum.writeQueries ?? '?'}`,
    );
  }
  if (rows.length > 0) {
    console.log('  ⚠️ Grouped by databaseId, so a screen has to know which database is its own.');
  }
}

console.log('\n=== 3. Is the reported database size worth printing? ===\n');

const listed = await fetch(`${API}/accounts/${accountId}/d1/database`, { headers: authorized });
const listing = await listed.json().catch(() => ({}));

if (!listed.ok || listing.success !== true) {
  console.log(`The database list answered ${listed.status}; skipping the size check.`);
} else {
  for (const database of listing.result ?? []) {
    const claimed = database.file_size;
    const tablesClaimed = database.num_tables;

    // One statement per request. Batched, a single refusal takes the others down
    // with it and the log reads as though none of them worked; that happened on the
    // first run of this probe and hid the table count behind a blocked pragma.
    async function ask(sql) {
      const asked = await fetch(`${API}/accounts/${accountId}/d1/database/${database.uuid}/query`, {
        method: 'POST',
        headers: authorized,
        body: JSON.stringify({ sql }),
      });
      const answer = await asked.json().catch(() => ({}));
      if (!asked.ok || answer.success !== true) {
        return { refused: answer.errors?.[0]?.message ?? `HTTP ${asked.status}` };
      }
      return { rows: answer.result?.[0]?.results ?? [] };
    }

    const [pageCount, pageSize, tableList] = await Promise.all([
      ask('PRAGMA page_count'),
      ask('PRAGMA page_size'),
      ask('PRAGMA table_list'),
    ]);

    console.log(`${database.name}`);
    console.log(`  list says      file_size=${claimed} num_tables=${tablesClaimed}`);

    if (pageCount.refused !== undefined) {
      console.log(`  PRAGMA page_count refused: ${pageCount.refused}`);
      console.log(`  PRAGMA page_size  ${pageSize.refused ?? 'answered'}`);
      console.log('  ⚠️ So file_size has no second opinion. It is the only source there is.');
    } else {
      const pages = pageCount.rows?.[0]?.page_count;
      const bytes = pageSize.rows?.[0]?.page_size;
      const measured = pages * bytes;
      console.log(`  database says  page_count*page_size=${measured}`);
      if (claimed !== measured)
        console.log(`  ⚠️ disagree by ${Math.abs(claimed - measured)} bytes`);
    }

    if (tableList.refused !== undefined) {
      console.log(`  PRAGMA table_list refused: ${tableList.refused}`);
    } else {
      const realTables = tableList.rows.filter(
        (row) => !String(row.name).startsWith('sqlite_'),
      ).length;
      console.log(`  database says  tables=${realTables}`);
      if (tablesClaimed !== realTables) {
        console.log('  🔴 num_tables is wrong, as rules/01 section G12 recorded. Do not print it.');
      }
    }
  }
}
