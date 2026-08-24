/**
 * Put a table and a few rows into the probe deployment, so the Studio has
 * something to be audited against.
 *
 * The deployment provisioned for checking the Studio starts empty, and an empty
 * deployment only exercises the empty states. Every live screen past that needs a
 * table, some rows, and a policy over them.
 *
 * ## The rules this obeys, and why they are in the code rather than in a comment
 *
 * `AGENTS.md` section 2e: this credential belongs to somebody else's account, and
 * Cloudflare's D1 permission is account-scoped rather than per-database, so the
 * token reaches every database there while exactly one may be touched.
 *
 *   - The database is resolved by asking Cloudflare for the project's name on the
 *     one pinned account, which is a server-side lookup rather than a guess.
 *   - **Anything other than exactly one match stops the run.** Zero is a wrong
 *     account or a wrong name; more than one is a question this script is not
 *     allowed to answer. `rules/01` section G12 already showed this endpoint's
 *     metadata lying, so "there is only one so it must be right" is a inference,
 *     not a measurement.
 *   - Every statement carries `IF NOT EXISTS` or is idempotent, so a second run
 *     changes nothing. A seed that is only safe once is a seed nobody dares rerun.
 *
 * Prints no token, no account id, and no database id.
 *
 *   node scripts/seed-alpha.mjs
 */

import { readFileSync } from 'node:fs';

const API = 'https://api.cloudflare.com/client/v4';

function fromEnvFile(name) {
  const line = readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .find((entry) => entry.startsWith(`${name}=`));
  return line === undefined ? '' : line.slice(name.length + 1).trim();
}

const token = fromEnvFile('STUDIO_PROBE_ACCOUNT_TOKEN');
const accountId = fromEnvFile('STUDIO_PROBE_ACCOUNT_ID');
const project = fromEnvFile('STUDIO_PROBE_PROJECT');
const mainToken = fromEnvFile('CLOUDFLARE_API_TOKEN');

for (const [name, value] of [
  ['STUDIO_PROBE_ACCOUNT_TOKEN', token],
  ['STUDIO_PROBE_ACCOUNT_ID', accountId],
  ['STUDIO_PROBE_PROJECT', project],
]) {
  if (value === '') {
    console.error(`seed: .env is missing ${name}.`);
    process.exit(2);
  }
}

// Section 2e rule 3. Two accounts, two credentials, and a run that mixed them
// would write this data somewhere nobody asked for.
if (token === mainToken) {
  console.error('seed: the probe token is the same value as CLOUDFLARE_API_TOKEN.');
  console.error('Those name different accounts. Refusing rather than guessing.');
  process.exit(2);
}

const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

console.log(`resolving "${project}" on the pinned account...`);

const found = await fetch(
  `${API}/accounts/${accountId}/d1/database?name=${encodeURIComponent(project)}`,
  { headers },
);
const foundBody = await found.json().catch(() => ({}));

if (foundBody.success !== true) {
  console.error(`seed: the lookup failed: ${foundBody.errors?.[0]?.message ?? found.status}`);
  process.exit(1);
}

const matches = foundBody.result ?? [];

// 🔴 The guard, and the reason it refuses rather than picks. One match is an answer;
// anything else is a question, and the one thing this script must never do is answer
// it on somebody else's account.
if (matches.length !== 1) {
  console.error(`seed: expected exactly one database named "${project}", found ${matches.length}.`);
  console.error('Refusing. Section 2e does not allow choosing one from a list.');
  process.exit(1);
}

const databaseId = matches[0].uuid;
console.log(`resolved to exactly one database. Seeding it.\n`);

/** One statement per request, which is the discipline every D1 path here follows. */
async function run(label, sql, params = []) {
  const response = await fetch(`${API}/accounts/${accountId}/d1/database/${databaseId}/query`, {
    method: 'POST',
    headers,
    body: JSON.stringify(params.length > 0 ? { sql, params } : { sql }),
  });
  const body = await response.json().catch(() => ({}));

  if (body.success !== true) {
    const message = body.errors?.[0]?.message ?? `HTTP ${response.status}`;
    console.error(`  ${label.padEnd(28)} FAILED: ${message}`);
    process.exit(1);
  }

  const result = body.result?.[0];
  const rows = result?.results ?? [];
  console.log(`  ${label.padEnd(28)} ok${rows.length > 0 ? `, ${rows.length} row(s)` : ''}`);
  return rows;
}

// The shape `examples/posts.policy.json` is written against, so the policy that
// ships with the project applies to this table without editing.
await run(
  'create posts',
  `CREATE TABLE IF NOT EXISTS posts (
     id TEXT PRIMARY KEY NOT NULL,
     title TEXT NOT NULL,
     body TEXT NOT NULL,
     status TEXT NOT NULL,
     author_id TEXT NOT NULL,
     created_at INTEGER NOT NULL
   ) STRICT`,
);

// Both columns the shipped policy filters on. rules/01 section D: D1 bills every row
// a query scans, so a policy column without an index is a recurring cost rather than
// a style note, and seeding without these would plant the warning the Health screen
// then reports.
await run('index on status', 'CREATE INDEX IF NOT EXISTS posts_status_idx ON posts (status)');
await run(
  'index on author_id',
  'CREATE INDEX IF NOT EXISTS posts_author_id_idx ON posts (author_id)',
);

const ROWS = [
  [
    'p_1',
    'What the policy engine does',
    'Every request carries a predicate.',
    'published',
    'u_ann',
  ],
  ['p_2', 'A draft nobody else sees', 'Still being written.', 'draft', 'u_ann'],
  [
    'p_3',
    'Reading rows costs money',
    'D1 bills rows scanned, not rows returned.',
    'published',
    'u_bo',
  ],
  ['p_4', "Bo's unfinished thought", 'Not ready.', 'draft', 'u_bo'],
];

for (const [id, title, body, status, author] of ROWS) {
  // Idempotent, so a second run leaves the data exactly as it was rather than
  // failing on the primary key and looking like something broke.
  await run(
    `row ${id}`,
    `INSERT INTO posts (id, title, body, status, author_id, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, unixepoch())
     ON CONFLICT(id) DO NOTHING`,
    [id, title, body, status, author],
  );
}

console.log('');
const counted = await run('read back', 'SELECT status, COUNT(*) AS n FROM posts GROUP BY status');
for (const row of counted) console.log(`    ${row.status}: ${row.n}`);

console.log('');
console.log('The table is there. Nothing is exposed until a policy is applied:');
console.log(`  npx baseclf policy apply examples/posts.policy.json --project ${project}`);
