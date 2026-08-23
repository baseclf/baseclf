/**
 * What can actually be reached on the probe deployment, and with which credential.
 *
 * Two credentials are in play and they belong to **different Cloudflare accounts**.
 * That is not a detail: the deployment token opens the deployment over HTTP, while
 * the account token opens D1 and the analytics API, and if they name different
 * accounts then half of the Studio works and half cannot. Guessing which half is
 * how a session gets spent on the wrong problem, so this asks.
 *
 * Prints no token, and rewrites the deployment's address out of every answer: a
 * workers.dev subdomain names an account, and `rules/05` section B is about that.
 *
 *   node scripts/probe-studio-target.mjs
 */

import { readFileSync } from 'node:fs';

function fromEnvFile(name) {
  const line = readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .find((entry) => entry.startsWith(`${name}=`));
  return line === undefined ? '' : line.slice(name.length + 1).trim();
}

const url = fromEnvFile('STUDIO_PROBE_URL').replace(/\/$/, '');
const deploymentToken = fromEnvFile('STUDIO_PROBE_TOKEN');
const project = fromEnvFile('STUDIO_PROBE_PROJECT');
const databaseId = fromEnvFile('STUDIO_PROBE_BRIDGE_ID');
const accountId = fromEnvFile('CLOUDFLARE_ACCOUNT_ID');
const accountToken = fromEnvFile('CLOUDFLARE_API_TOKEN');

if (url === '' || deploymentToken === '') {
  console.error('probe: .env needs STUDIO_PROBE_URL and STUDIO_PROBE_TOKEN.');
  process.exit(2);
}

/**
 * Keep the address and the database id out of the output.
 *
 * Both name somebody's account, and `rules/05` section B is explicit that a
 * `database_id` counts. The id needs its own rule because it arrives inside
 * Cloudflare's own prose rather than in anything this file composed: the first run
 * of this probe printed it verbatim out of a "could not be found" message. Same
 * shape as the account id that leaked through a dashboard link in `rules/02`
 * section C2b, and the same fix: mask the value being held, not a pattern.
 */
const hide = (text) => {
  let out = text.split(url).join('<probe>').split(new URL(url).host).join('<probe-host>');
  if (databaseId !== '') out = out.split(databaseId).join('<probe-database>');
  if (accountId !== '') out = out.split(accountId).join('<account>');
  return out;
};

const brief = (text, n = 120) => text.replace(/\s+/g, ' ').slice(0, n);

async function ask(label, path, init = {}) {
  try {
    const response = await fetch(url + path, { ...init, signal: AbortSignal.timeout(20_000) });
    const body = await response.text();
    return { label, status: response.status, body };
  } catch (error) {
    return { label, status: 0, body: `(${error.name})` };
  }
}

console.log('=== 1. the deployment over plain HTTP, no account credential ===\n');

for (const [label, path] of [
  ['health', '/health'],
  ['diagnose', '/api/auth/_diagnose'],
  ['schema', '/_schema'],
]) {
  const answer = await ask(label, path);
  console.log(
    `  ${label.padEnd(10)} ${String(answer.status).padEnd(4)} ${brief(hide(answer.body), 110)}`,
  );
}

console.log('\n=== 2. the MCP endpoint, with the deployment token ===\n');

const mcp = await ask('mcp', '/mcp', {
  method: 'POST',
  headers: {
    authorization: `Bearer ${deploymentToken}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
});

const tools = [...mcp.body.matchAll(/"name"\s*:\s*"([a-z_]+)"/g)].map((match) => match[1]);
if (mcp.status === 200 && tools.length > 0) {
  console.log(`  tools/list  200  ${[...new Set(tools)].join(', ')}`);
  console.log('  So every Studio screen that reads over /mcp can be driven from here.');
} else {
  console.log(`  tools/list  ${mcp.status}  ${brief(hide(mcp.body), 140)}`);
  console.log('  Without this the live screens cannot connect at all.');
}

console.log('\n=== 3. does the account token reach the probe deployment resources? ===\n');

if (accountToken === '' || accountId === '') {
  console.log('  no account credential in .env, so nothing to compare.');
} else if (databaseId === '') {
  console.log('  no STUDIO_PROBE_BRIDGE_ID, so there is no database id to try.');
} else {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}`,
    { headers: { authorization: `Bearer ${accountToken}` }, signal: AbortSignal.timeout(20_000) },
  );
  const body = await response.json().catch(() => ({}));

  if (body.success === true) {
    console.log(`  found the database on this account: "${body.result?.name}"`);
    console.log('  So one credential covers both halves and the bridge will work as is.');
  } else {
    const message = body.errors?.[0]?.message ?? `HTTP ${response.status}`;
    console.log(`  refused: ${hide(message)}`);
    console.log('');
    console.log('  🔴 The two credentials name different accounts. The consequence is');
    console.log('     specific rather than general: everything over /mcp works, and the');
    console.log('     bridge does not, because the bridge spends the ACCOUNT token on');
    console.log('     D1 and on the analytics API. So the Health warnings can be');
    console.log('     audited from here and the Health numbers cannot.');
  }
}

console.log('\n=== 4. would the analytics filter even name this project? ===\n');
console.log(
  project === ''
    ? '  STUDIO_PROBE_PROJECT is empty, so a usage read would be about every Worker on the account.'
    : `  project "${project}" is set, which is what the usage read filters by.`,
);
