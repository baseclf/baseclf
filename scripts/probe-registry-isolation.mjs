/**
 * Prove on a real deployment that one bad policy document costs one table.
 *
 * The behaviour is covered by tests in workerd, which is the same runtime, but
 * not the same data and not the same isolates. This runs the thing itself: it
 * writes a document that cannot validate, watches whether a healthy table keeps
 * answering, and removes it again.
 *
 * ## What it writes, and why that is the safe shape
 *
 * A document for `probe_drop_check`, a table that does not exist and that
 * nothing else refers to. No existing row is read, changed or deleted. The name
 * carries no underscore prefix on purpose: a reserved name would be dropped by
 * an earlier check and would exercise the wrong path entirely.
 *
 * If the cleanup at the end fails, what is left behind is one exposed row and
 * one policy row for a table nobody can name, and the very fix being measured
 * here is what makes that harmless. The failure mode is contained by the thing
 * under test.
 *
 * ## Why the HTTP API and not wrangler
 *
 * `wrangler d1 execute --command` cannot be trusted for this on Windows:
 * `rules/01` section G10 records a quoting failure that produced a confident
 * wrong answer. `--file` avoids the quoting but goes through D1's import path,
 * which returns an import summary rather than rows and warns that the database
 * is unavailable while it runs. The REST query endpoint has neither problem.
 *
 * ## Why it polls rather than checking once
 *
 * `rules/02` section C6: one request reaches one isolate, and isolates pick up a
 * registry change at different times. A single 200 proves nothing about the
 * deployment, so this samples for longer than the registry's own maximum age and
 * reports the worst answer it saw rather than the first.
 *
 * ## 🔴 What this script cannot tell you on its own
 *
 * Everything below is negative evidence: a healthy table never broke, and the
 * probe table answers 404. Neither distinguishes "the document was loaded and
 * dropped" from "the registry never saw the document at all", because a table
 * with no document answers 404 too. A run where the registry simply never
 * reloaded would print exactly the same thing and read as a pass.
 *
 * The positive evidence is in the worker log, and it has to be read separately:
 *
 *   npx wrangler tail --config wrangler.local.jsonc --format json
 *
 * while this runs, then look for `was dropped from the registry`. Measured on
 * 2026-08-14 against version dd488d2a, that line appeared exactly once:
 *
 *   {"event":"error","code":"UNKNOWN_IDENTIFIER","detail":"Table
 *    \"probe_drop_check\" was dropped from the registry and is now refused:
 *    Policy document names table \"probe_drop_check\", which does not exist."}
 *
 * ⚠️ Read the log before believing a pass here. This is the same shape as the
 * revocation probe in `rules/02` section C6, which was confidently wrong until
 * it was made to sample properly, and as the suite that stayed green through
 * both I8 holes.
 *
 * Usage, from the project root:
 *
 *   node --env-file=.env scripts/probe-registry-isolation.mjs
 */

import { readFileSync } from 'node:fs';

const BASE = 'https://baseclf.raspy-firefly-4c0b.workers.dev';
const PROBE_TABLE = 'probe_drop_check';
const WINDOW_MS = 55_000;
const INTERVAL_MS = 3_000;

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;

if (accountId === undefined || apiToken === undefined) {
  console.error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be in .env');
  process.exit(1);
}

/** Read the database id from the local config, which is not in the repository. */
function databaseId() {
  const config = readFileSync('wrangler.local.jsonc', 'utf8');
  const match = config.match(/"database_id"\s*:\s*"([0-9a-f-]{36})"/);
  if (match === null) throw new Error('No database_id in wrangler.local.jsonc');
  return match[1];
}

async function sql(statement, params = []) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId()}/query`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sql: statement, params }),
    },
  );

  const body = await response.json();
  if (body.success !== true) {
    throw new Error(`D1 refused: ${JSON.stringify(body.errors)}`);
  }
  return body.result[0]?.results ?? [];
}

async function counts() {
  const [row] = await sql(
    'SELECT (SELECT COUNT(*) FROM _exposed_tables) AS exposed,' +
      ' (SELECT COUNT(*) FROM _policies) AS policies',
  );
  return row;
}

async function get(path) {
  const response = await fetch(BASE + path);
  return { status: response.status, body: await response.text() };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const before = await counts();
console.log(`Before: ${before.exposed} exposed rows, ${before.policies} policy rows`);

const healthy = await get('/rest/v1/posts');
if (healthy.status !== 200) {
  console.error(`posts is already unhealthy (${healthy.status}). Nothing to measure.`);
  process.exit(1);
}
const expectedBody = healthy.body;
console.log('posts is healthy, so a change below is caused by this probe.\n');

let restored = false;
try {
  await sql('INSERT INTO _exposed_tables (table_name, enabled, version) VALUES (?, 1, 1)', [
    PROBE_TABLE,
  ]);
  await sql(
    'INSERT INTO _policies (table_name, name, operation, roles, using_expr, check_expr,' +
      ' columns, set_expr) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL)',
    [
      PROBE_TABLE,
      'cannot_validate',
      'select',
      JSON.stringify(['anon']),
      JSON.stringify({ no_such_column: { _eq: 'x' } }),
      JSON.stringify(['id']),
    ],
  );
  console.log(`Wrote a document for "${PROBE_TABLE}" that cannot validate.`);
  console.log(`Sampling /rest/v1/posts for ${WINDOW_MS / 1000}s.\n`);

  const started = Date.now();
  const statuses = new Map();
  let firstBadAt = null;
  let bodyChanged = false;

  while (Date.now() - started < WINDOW_MS) {
    const elapsed = Math.round((Date.now() - started) / 1000);
    const posts = await get('/rest/v1/posts');

    statuses.set(posts.status, (statuses.get(posts.status) ?? 0) + 1);
    if (posts.status !== 200 && firstBadAt === null) firstBadAt = elapsed;
    if (posts.status === 200 && posts.body !== expectedBody) bodyChanged = true;

    process.stdout.write(`  t+${String(elapsed).padStart(2)}s posts=${posts.status}\n`);
    await sleep(INTERVAL_MS);
  }

  const probe = await get(`/rest/v1/${PROBE_TABLE}`);

  console.log('\nResult');
  console.log(`  posts statuses seen : ${JSON.stringify(Object.fromEntries(statuses))}`);
  console.log(`  first non-200       : ${firstBadAt === null ? 'none' : `t+${firstBadAt}s`}`);
  console.log(`  posts body changed  : ${bodyChanged}`);
  console.log(`  /rest/v1/${PROBE_TABLE} : ${probe.status} (404 is the refusal it should get)`);

  const held = firstBadAt === null && !bodyChanged && probe.status === 404;
  console.log(
    held
      ? '\nHELD. One document that cannot validate cost exactly one table.'
      : '\nFAILED. A bad document reached past its own table.',
  );
  process.exitCode = held ? 0 : 1;
} finally {
  await sql('DELETE FROM _policies WHERE table_name = ?', [PROBE_TABLE]);
  await sql('DELETE FROM _exposed_tables WHERE table_name = ?', [PROBE_TABLE]);
  const after = await counts();
  restored = after.exposed === before.exposed && after.policies === before.policies;

  console.log(`\nAfter cleanup: ${after.exposed} exposed rows, ${after.policies} policy rows`);
  if (!restored) {
    console.error('🔴 Counts do not match the baseline. Inspect _exposed_tables and _policies.');
    process.exitCode = 1;
  }
}
