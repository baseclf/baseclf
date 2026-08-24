/**
 * Count the cron triggers on this account, which is a one-way answer about plan.
 *
 * Section C2b measured the free ceiling by walking into it: `PUT .../schedules`
 * answered *"This account has reached the Workers Free limit of 5 cron triggers
 * per account."* That was 2026-08-15, and it was a write, so it is not a probe
 * to repeat.
 *
 * Counting is the read-only half of the same fact, and it answers in exactly one
 * direction:
 *
 *   more than 5  ->  the account cannot be on the free plan. Settled.
 *   5 or fewer   ->  nothing follows. A paid account with two crons looks
 *                    identical to a free one with two crons.
 *
 * That asymmetry is the whole point of writing it down rather than reporting a
 * number and letting a reader infer. Section C3 is the standing lesson: an
 * airtight deduction from a non-authoritative source is still wrong.
 *
 * Reads only. Prints no token, no account id, and no script hostnames.
 *
 *   node scripts/probe-cron-count.mjs
 */

import { readFileSync } from 'node:fs';

const API = 'https://api.cloudflare.com/client/v4';
const FREE_CRON_CEILING = 5;

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

async function readJson(path) {
  const response = await fetch(`${API}${path}`, { headers: authorized });
  const body = await response.json().catch(() => ({}));
  return { ok: response.status === 200 && body.success === true, status: response.status, body };
}

const listed = await readJson(`/accounts/${accountId}/workers/scripts`);

if (!listed.ok) {
  console.error(
    `probe: listing scripts failed: ${safe(listed.body.errors?.[0]?.message ?? listed.status)}`,
  );
  process.exit(1);
}

const scripts = (listed.body.result ?? []).map((script) => script.id).filter(Boolean);
console.log(`${scripts.length} script(s) on this account.\n`);

let total = 0;
let unreadable = 0;

for (const name of scripts) {
  const schedules = await readJson(`/accounts/${accountId}/workers/scripts/${name}/schedules`);

  if (!schedules.ok) {
    // Counted as unknown rather than as zero. A refusal that silently became a
    // zero would make the total an undercount, and the whole value of this probe
    // is that a number above the ceiling is trustworthy.
    console.log(
      `  ${name.padEnd(20)} unreadable: ${safe(schedules.body.errors?.[0]?.message ?? schedules.status)}`,
    );
    unreadable += 1;
    continue;
  }

  const crons = schedules.body.result?.schedules ?? [];
  total += crons.length;
  // The schedule itself, not just the count. A cron is traffic, and traffic
  // this project did not send has twice been mistaken for traffic it did:
  // rules/02 section A0d read an hourly cron invocation as a cold HTTP
  // request and recorded its cost as one.
  const when = crons.map((entry) => entry.cron).join(', ');
  console.log(
    `  ${name.padEnd(20)} ${crons.length} cron trigger(s)${when === '' ? '' : `  [${when}]`}`,
  );
}

console.log('');
console.log(
  `total counted: ${total}${unreadable > 0 ? ` (+${unreadable} script(s) unreadable)` : ''}`,
);
console.log('');

if (total > FREE_CRON_CEILING) {
  console.log(`⭐ More than ${FREE_CRON_CEILING} cron triggers exist, and the free plan does not`);
  console.log('   allow that (section C2b measured the refusal). This account is PAID, so the');
  console.log('   CPU ceiling is 30s and debt 34 was measuring against the wrong number.');
} else if (unreadable > 0) {
  console.log('⚠️ NOTHING FOLLOWS. The count is at or under the free ceiling, but some');
  console.log('   scripts could not be read, so the real total may be higher than this.');
} else {
  console.log(
    `⚠️ NOTHING FOLLOWS. ${total} is within the free ceiling of ${FREE_CRON_CEILING}, and a paid`,
  );
  console.log('   account with few crons looks exactly the same. This probe can only prove');
  console.log('   paid, never free. The plan is on the dashboard under Workers & Pages.');
}
