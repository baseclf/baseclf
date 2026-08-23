/**
 * Hand the Studio page its probe credentials without them passing through a
 * transcript.
 *
 * ## The problem this exists for
 *
 * Auditing a connected Studio screen means filling the connect form, and the only
 * way an agent fills a form is by writing the value into a tool call. That value
 * then lives in the transcript, and `rules/02` section C1 is this project's note on
 * where terminals end up: in screenshots. The deployment token is not the account
 * token, but a probe deployment is still a deployment.
 *
 * So the page fetches instead of being told. This serves the credentials on
 * loopback; the page reads them with `fetch`, and the only thing that reaches a tool
 * call is the address of this server.
 *
 * ## What keeps it small
 *
 * - 127.0.0.1 only, so nothing off the machine can ask.
 * - One answer, then it stops. A server that keeps handing out a token is a worse
 *   thing than the problem it solves.
 * - A lifetime, so a forgotten process is not a standing offer.
 * - `Origin` has to be a local site. Not a real gate, since anything local can
 *   forge one, which is why the two rules above carry the weight.
 *
 * Reads `.env`, which both `.gitignore` and `guard-commit.mjs` already refuse to
 * commit. That is why the credentials go there rather than into a new file: a new
 * file has to be added to both lists, and forgetting one is the failure `rules/05`
 * section E is about.
 *
 *   node scripts/studio-audit-creds.mjs [port]
 */

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const PORT = Number(process.argv[2] ?? 4555);
const LIFETIME_MS = 120_000;
const ALLOWED_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000'];

function fromEnvFile(name) {
  const line = readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .find((entry) => entry.startsWith(`${name}=`));
  return line === undefined ? '' : line.slice(name.length + 1).trim();
}

const url = fromEnvFile('STUDIO_PROBE_URL');
const token = fromEnvFile('STUDIO_PROBE_TOKEN');
const project = fromEnvFile('STUDIO_PROBE_PROJECT');

const missing = [
  url === '' ? 'STUDIO_PROBE_URL' : null,
  token === '' ? 'STUDIO_PROBE_TOKEN' : null,
].filter(Boolean);

if (missing.length > 0) {
  console.error(`studio-audit-creds: .env is missing ${missing.join(' and ')}.`);
  console.error('');
  console.error('Add the probe deployment there:');
  console.error('  STUDIO_PROBE_URL=https://<project>.<subdomain>.workers.dev');
  console.error('  STUDIO_PROBE_TOKEN=<that deployment MCP_TOKEN>');
  console.error('  STUDIO_PROBE_PROJECT=<project>');
  process.exit(2);
}

let served = false;

const server = createServer((request, response) => {
  const origin = request.headers.origin ?? '';
  const allowed = ALLOWED_ORIGINS.includes(origin);
  const headers = {
    'access-control-allow-origin': allowed ? origin : ALLOWED_ORIGINS[0],
    'access-control-allow-headers': 'content-type',
    'cache-control': 'no-store',
    'content-type': 'application/json',
  };

  if (request.method === 'OPTIONS') {
    response.writeHead(204, headers).end();
    return;
  }

  if (!allowed) {
    console.log(`refused an ask from origin ${origin === '' ? '(none)' : origin}`);
    response.writeHead(403, headers).end(JSON.stringify({ error: 'Not a local site.' }));
    return;
  }

  if (served) {
    console.log('refused a second ask');
    response.writeHead(410, headers).end(JSON.stringify({ error: 'Already handed over.' }));
    return;
  }

  served = true;
  response.writeHead(200, headers).end(JSON.stringify({ url, token, project }));
  console.log('handed the credentials to the page once; stopping.');
  // Let the response finish before the process goes.
  setTimeout(() => server.close(() => process.exit(0)), 250);
});

server.listen(PORT, '127.0.0.1', () => {
  // The address, and nothing else. Printing any part of the token here would put
  // it back in the place this whole file exists to keep it out of.
  console.log(`credentials waiting on http://127.0.0.1:${PORT}/ for one fetch.`);
  console.log(
    `project ${project === '' ? '(not set)' : project}, stopping in ${LIFETIME_MS / 1000}s.`,
  );
});

setTimeout(() => {
  if (!served) console.log('nobody asked; stopping.');
  server.close(() => process.exit(served ? 0 : 1));
}, LIFETIME_MS);
