/**
 * Does the probe credential work, and how far does it actually reach?
 *
 * The second question matters more than the first. Cloudflare's D1 permission is
 * account-scoped rather than per-database (`rules/01` section E), and the account
 * this token lives on holds other things that are in use. So the token can reach
 * more than it is allowed to touch, and `AGENTS.md` section 2e is the rule that
 * closes that gap by discipline.
 *
 * This measures the gap rather than assuming it: it counts what the credential can
 * see, and it confirms that the one database the rule permits is reachable by **id**.
 * Knowing the number of neighbours is the point. A rule that says "only alpha" reads
 * differently when the answer is one and when it is nine.
 *
 * Reads only. Never lists then matches by name: under section 2e a name match is a
 * guess, and `rules/01` section G12 already showed this endpoint's metadata lying.
 * Prints no token, no account id, no database id, and no neighbour's name.
 *
 *   node scripts/probe-alpha-scope.mjs
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
const allowedDatabase = fromEnvFile('STUDIO_PROBE_BRIDGE_ID');
const project = fromEnvFile('STUDIO_PROBE_PROJECT');
const mainToken = fromEnvFile('CLOUDFLARE_API_TOKEN');

if (token === '' || accountId === '') {
  console.error('probe: .env needs STUDIO_PROBE_ACCOUNT_TOKEN and STUDIO_PROBE_ACCOUNT_ID.');
  process.exit(2);
}

if (allowedDatabase === '') {
  console.error('probe: .env needs STUDIO_PROBE_BRIDGE_ID, the one database this may touch.');
  process.exit(2);
}

// Two accounts, two credentials, never mixed. Section 2e rule 3, and the day lost
// to measuring a credential nobody chose to test is rules/02 section C1.
if (token === mainToken) {
  console.error('probe: the probe token is the same value as CLOUDFLARE_API_TOKEN.');
  console.error('Those are meant to be different accounts. Refusing rather than guessing.');
  process.exit(2);
}

const headers = { authorization: `Bearer ${token}` };

/**
 * Mask the identifiers before anything is printed.
 *
 * 🔴 Written after the fact, which is the note worth keeping: the sibling probe in
 * this directory already carries this exact rule and the reason for it, and this
 * file was written without it and leaked a database id out of Cloudflare's own
 * "could not be found" prose on its first run. A lesson recorded in one file is not
 * a lesson applied in the next one.
 */
const hide = (text) =>
  String(text).split(allowedDatabase).join('<probe-database>').split(accountId).join('<account>');

console.log('=== 1. is the token alive? ===\n');

const verify = await fetch(`${API}/user/tokens/verify`, { headers });
const verifyBody = await verify.json().catch(() => ({}));
console.log(`  ${verify.status} ${verifyBody.result?.status ?? '(no status)'}`);

if (!verify.ok) {
  console.log('\n  Nothing below would mean anything. Stopping.');
  process.exit(1);
}

console.log('\n=== 2. the one database the rule allows, fetched BY ID ===\n');

const one = await fetch(`${API}/accounts/${accountId}/d1/database/${allowedDatabase}`, { headers });
const oneBody = await one.json().catch(() => ({}));

if (oneBody.success === true) {
  console.log(`  reachable, named "${oneBody.result?.name}"`);
  console.log('  Fetched by id, never by listing and matching a name.');
} else {
  console.log(`  refused: ${hide(oneBody.errors?.[0]?.message ?? `HTTP ${one.status}`)}`);
  // Kept going on purpose. Three different causes produce this same refusal, and
  // the next two questions separate them: whether D1 answers at all says if the
  // permission is there, and how many databases are visible says whether this is
  // even the right account. Stopping here would have left all three open.
  console.log('  Three causes look identical here, so the questions below separate them.');
}

console.log('\n=== 3. how much else can this token see? ===\n');

const all = await fetch(`${API}/accounts/${accountId}/d1/database`, { headers });
const allBody = await all.json().catch(() => ({}));

if (allBody.success !== true) {
  console.log(
    `  the list was refused: ${hide(allBody.errors?.[0]?.message ?? `HTTP ${all.status}`)}`,
  );
  console.log('  So D1 itself is closed to this token: the permission is missing.');
} else {
  const databases = allBody.result ?? [];
  const holdsAllowed = databases.some((entry) => entry.uuid === allowedDatabase);
  // Neighbours are the ones that are neither the pinned database nor the project's
  // own. Counting "everything that is not the pinned id" called alpha a neighbour of
  // itself when the pin was stale, and then warned about reaching too far while the
  // only thing in reach was the intended database.
  const neighbours = databases.filter(
    (entry) => entry.uuid !== allowedDatabase && entry.name !== project,
  ).length;
  console.log(`  ${databases.length} database(s) visible, ${neighbours} of them neighbours.`);
  if (holdsAllowed) {
    console.log('  The allowed database IS among them, so the id and the account agree.');
  } else {
    // Two very different causes look the same from step 2, and this separates them
    // without naming anything: whether some visible database carries the project's
    // name says whether this is the right account with a wrong id, or the wrong
    // account entirely. Reported as a yes or no, because the name adds nothing.
    const named = databases.some((entry) => entry.name === project);
    console.log('  🔴 The allowed database is NOT among them.');
    console.log(
      named
        ? `  But one visible database is named "${project}", so this IS the right account\n  and STUDIO_PROBE_BRIDGE_ID is simply not that database's id.`
        : '  And nothing here carries the project name, so this is likely the wrong account.',
    );
    console.log('');
    console.log('  Deliberately NOT resolved by taking the id from this listing.');
    console.log('  AGENTS.md section 2e forbids picking a database by name match, and a');
    console.log('  pin that the code repairs for itself is not a pin. The right id has to');
    console.log('  come from the person who owns the account.');
  }
  console.log('');
  if (neighbours > 0) {
    console.log('  🔴 The credential reaches further than the rule allows, exactly as');
    console.log('     rules/01 section E says it would. Nothing technical stops a write to');
    console.log('     the wrong one; AGENTS.md section 2e and the id pin are what do.');
    console.log('     Neighbours are counted, not named: the count is what the rule needs.');
  } else {
    console.log('  No D1 neighbours on this account, so a slip has nowhere to land today.');
    console.log('  That is a fact about this moment, not a property: the token is still');
    console.log('  account-scoped, and the next database created here is in reach.');
  }
}

console.log('\n=== 4. analytics, which is the other half of Health ===\n');

const analytics = await fetch(`${API}/graphql`, {
  method: 'POST',
  headers: { ...headers, 'content-type': 'application/json' },
  body: JSON.stringify({
    query: `query Probe($accountTag: String!) {
      viewer { accounts(filter: { accountTag: $accountTag }) {
        workersInvocationsAdaptive(limit: 1, filter: { date_geq: "2026-08-16", date_leq: "2026-08-23" }) {
          sum { requests }
        } } } }`,
    variables: { accountTag: accountId },
  }),
});
const analyticsBody = await analytics.json().catch(() => ({}));
const errors = analyticsBody.errors ?? [];

if (errors.length > 0) {
  console.log(`  refused: ${errors.map((error) => error.message).join('; ')}`);
  console.log('  So the numbers half of Health cannot be audited with this token.');
} else {
  const rows = analyticsBody.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
  console.log(`  allowed, ${rows.length} row(s) in a one week window.`);
  console.log('  The numbers half of Health is reachable.');
}
