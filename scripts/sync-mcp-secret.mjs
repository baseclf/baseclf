/**
 * Upload the MCP_TOKEN that is in .env, so the two cannot disagree.
 *
 * Setting the secret by hand and writing .env by hand are two chances to enter
 * two different values, and the failure is silent in the worst way: the gate
 * answers 401, which is also what it answers for a token that is merely wrong,
 * and for a secret that was never set. Nothing distinguishes them from outside.
 * That happened here on 2026-08-13.
 *
 * So the value is read once and piped straight to wrangler. It is never printed,
 * never placed on a command line, and never put in shell history, which matters
 * because `rules/02` section C1 records that a terminal ends up in screenshots.
 *
 * Usage, from the project root:
 *
 *   node scripts/sync-mcp-secret.mjs
 *
 * Then confirm with:
 *
 *   node --env-file=.env scripts/probe-mcp-tools.mjs
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const CONFIG = 'wrangler.local.jsonc';

function tokenFromEnvFile() {
  const line = readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .find((entry) => entry.trim().startsWith('MCP_TOKEN='));

  if (line === undefined) {
    console.error('No MCP_TOKEN line in .env. Add one, then run this again.');
    process.exit(1);
  }

  // Trimmed, and surrounding quotes removed. A value written as MCP_TOKEN="abc"
  // would otherwise upload with the quotes attached and fail to match forever,
  // for a reason nothing in the 401 would ever reveal.
  const value = line
    .slice(line.indexOf('=') + 1)
    .trim()
    .replace(/^["']|["']$/g, '');

  if (value === '') {
    console.error('MCP_TOKEN in .env is empty.');
    process.exit(1);
  }

  return value;
}

const token = tokenFromEnvFile();

console.log(`Uploading the MCP_TOKEN from .env to the worker in ${CONFIG}.`);
console.log('The value is not shown, here or anywhere.\n');

const child = spawn('npx', ['wrangler', 'secret', 'put', 'MCP_TOKEN', '--config', CONFIG], {
  stdio: ['pipe', 'inherit', 'inherit'],
  shell: true,
});

// ⚠️ `write` rather than `end(value + '\n')`. A trailing newline can become part
// of the secret, which produces a token that looks right in every dump and never
// matches. Same class of bug as the quotes above.
child.stdin.write(token);
child.stdin.end();

child.on('exit', (code) => {
  if (code === 0) {
    console.log('\nUploaded. Now confirm the tools are reachable:');
    console.log('  node --env-file=.env scripts/probe-mcp-tools.mjs');
  }
  process.exit(code ?? 1);
});
