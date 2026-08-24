/**
 * Two questions the failed calibration in `probe-startup-vs-request-cpu.mjs`
 * cannot tell apart, asked separately.
 *
 * That run set `cpu_ms: 10` on a throwaway worker and then burned 20 million
 * loops inside a handler, expecting the platform to kill it. It answered 200.
 * Exactly two things produce that:
 *
 *   A. the limit was never applied, so nothing was ever going to be killed;
 *   B. the limit is applied and 20M loops simply costs less than 10ms.
 *
 * Reading the 200 as either one without checking is the mistake this project
 * has recorded three times (rules/02 section C3, section C6, rules/01 section
 * G9): an airtight reading of a signal that had two causes.
 *
 * So: ask the API what limit is stored, and walk the loop count up until
 * something dies. The first answers A directly. The second finds the real cost
 * of a loop on this hardware, which is a number worth having anyway.
 *
 * Reads the settings, drives the throwaway worker. Prints no token, no account
 * id, no hostname.
 *
 *   node scripts/probe-cpu-limit-applied.mjs
 */

import { readFileSync } from 'node:fs';

const API = 'https://api.cloudflare.com/client/v4';
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

console.log('=== 1. Did the limit actually get stored? ===\n');

const settings = await fetch(`${API}/accounts/${accountId}/workers/scripts/${SCRIPT}/settings`, {
  headers: authorized,
});
const settingsBody = await settings.json().catch(() => ({}));

// Named fields only. The first version of a sibling probe printed the whole
// result object and put a database id and a hostname on the terminal.
const limits = settingsBody.result?.limits ?? null;
console.log(`  limits: ${JSON.stringify(limits)}`);
console.log(`  usage_model: ${JSON.stringify(settingsBody.result?.usage_model ?? null)}`);

const storedCeiling = limits?.cpu_ms ?? null;

console.log('');
if (storedCeiling === null) {
  console.log('  🔴 NO cpu_ms is stored. The config asked for 10 and the platform kept');
  console.log('     nothing, so the calibration failed because there was no ceiling to');
  console.log('     hit. Explanation A. Nothing about start-up was ever under test.');
} else {
  console.log(`  ⭐ cpu_ms = ${storedCeiling} is stored, so a ceiling exists and is that low.`);
  console.log('     Then the burn simply was not expensive enough. Explanation B.');
}

const subdomainAnswer = await fetch(`${API}/accounts/${accountId}/workers/subdomain`, {
  headers: authorized,
});
const subdomain = (await subdomainAnswer.json().catch(() => ({})))?.result?.subdomain;

if (typeof subdomain !== 'string' || subdomain === '') {
  console.error('\nprobe: could not resolve the subdomain, so the second half cannot run.');
  process.exit(1);
}

const ORIGIN = `https://${SCRIPT}.${subdomain}.workers.dev`;

console.log('\n=== 2. How much work does it take to get killed? ===\n');

/**
 * Walk the loop count up until something stops answering 200.
 *
 * Multiplying rather than adding, because the cost of a loop on this hardware is
 * unknown to within orders of magnitude: wrangler reported 62ms of start-up for
 * 20M loops, while the same 20M inside a handler survived a claimed 10ms
 * ceiling, and those two cannot both be right about what a loop costs.
 */
const LADDER = [20_000_000, 60_000_000, 200_000_000, 600_000_000, 2_000_000_000];

for (const loops of LADDER) {
  const at = Date.now();
  let status = 0;
  let body = '';

  try {
    const response = await fetch(`${ORIGIN}/burn?loops=${loops}`);
    status = response.status;
    body = (await response.text()).slice(0, 120).replace(/\s+/g, ' ');
  } catch (cause) {
    body = cause instanceof Error ? cause.message : String(cause);
  }

  const took = Date.now() - at;
  const killed = status !== 200;
  console.log(
    `  loops=${String(loops).padStart(13)}  HTTP ${String(status).padEnd(4)} ${String(took).padStart(6)}ms  ${killed ? '<- STOPPED ANSWERING 200' : ''}`,
  );
  if (body !== '' && killed) console.log(`      ${body}`);

  if (killed) {
    console.log('');
    console.log('  ⭐ There is the ceiling. Everything below this survived, so the limit is');
    console.log('     enforced and the earlier burn was simply too cheap to reach it.');
    process.exit(0);
  }
}

console.log('');
console.log('🔴 Nothing was killed, all the way up. Two billion loops of floating point');
console.log('   work cannot cost under 10ms, so the ceiling is NOT being enforced on this');
console.log('   deployment, whatever the settings endpoint says.');
console.log('   The start-up question cannot be answered this way, and the reason is worth');
console.log('   recording: `limits.cpu_ms` did not do what the config asked for.');
