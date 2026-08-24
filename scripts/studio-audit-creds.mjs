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

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const PORT = Number(process.argv.find((entry) => /^\d+$/.test(entry)) ?? 4555);
/**
 * Also start the bridge and hand its key over with the rest.
 *
 * The bridge prints a fresh key every run, so pasting it means the key travels
 * through a tool call the same way the deployment token would have. Starting the
 * bridge from in here keeps the whole session inside one process: the key is read
 * from the child's output and served, and nothing has to be quoted anywhere.
 */
const withBridge = process.argv.includes('--with-bridge');

/**
 * How long this stays up, and why the two cases differ.
 *
 * Without a bridge there is nothing to hold open: the handover is the whole job and
 * two minutes is a generous window for one fetch.
 *
 * 🔴 With a bridge, two minutes is wrong, and it looked exactly like a product bug
 * while it was. An audit ran the simulator, got real rows back, and a minute later
 * the same run answered with the "paste your key" placeholder. The key was still in
 * the box and the deployment was still up; the bridge had been killed by the timer
 * below. Time spent looking for a fault in the Studio, and the fault was in the tool
 * measuring it.
 */
const LIFETIME_MS = withBridge ? 45 * 60_000 : 120_000;
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
let bridgeKey = '';
let bridge = null;

/**
 * Start `baseclf studio` against the probe deployment and wait for its key.
 *
 * The probe credential goes into this child's environment and nowhere else, which
 * is `AGENTS.md` section 2e rule 3: the two accounts keep their own credentials,
 * and the CLI announces the substitution rather than taking it silently.
 */
async function startBridge() {
  const accountToken = fromEnvFile('STUDIO_PROBE_ACCOUNT_TOKEN');
  const accountId = fromEnvFile('STUDIO_PROBE_ACCOUNT_ID');

  if (accountToken === '' || accountId === '') {
    console.error('studio-audit-creds: --with-bridge needs the probe account credential in .env.');
    process.exit(2);
  }

  bridge = spawn(
    process.execPath,
    ['dist-cli/baseclf.mjs', 'studio', '--project', project, '--port', '4000'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CLOUDFLARE_API_TOKEN: accountToken, CLOUDFLARE_ACCOUNT_ID: accountId },
    },
  );

  return new Promise((resolve) => {
    let buffered = '';
    const settle = (key) => {
      bridgeKey = key;
      resolve(key !== '');
    };
    bridge.stdout.on('data', (chunk) => {
      buffered += String(chunk);
      const match = buffered.match(/Paste this key[^\n]*\n\s*\n([^\n]+)\n/);
      if (match !== null && bridgeKey === '') settle(match[1].trim());
    });
    bridge.stderr.on('data', (chunk) => {
      buffered += String(chunk);
    });
    bridge.on('exit', () => {
      if (bridgeKey === '') {
        console.error('the bridge exited before printing a key:');
        console.error(buffered.split('\n').slice(0, 8).join('\n'));
        settle('');
      }
    });
    setTimeout(() => {
      if (bridgeKey === '') settle('');
    }, 60_000);
  });
}

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

  // 🔴 One-shot without a bridge, repeatable with one, and the difference is not a
  // relaxation of the rule but a correction of what the rule was protecting.
  //
  // The point of stopping after one answer is that a server handing out a token
  // indefinitely is worse than the problem it solves. With `--with-bridge` the
  // process is already long-lived and already holding a bridge on a known port, so
  // the marginal exposure of a second answer inside the same bounded session is
  // nothing, while the cost was real: an audit that reloaded the page had to kill
  // and restart everything, and that happened twice before this was written.
  //
  // The gates that carry the weight are unchanged: loopback only, a local Origin,
  // and a lifetime.
  if (served && bridge === null) {
    console.log('refused a second ask');
    response.writeHead(410, headers).end(JSON.stringify({ error: 'Already handed over.' }));
    return;
  }

  const first = !served;
  served = true;
  response.writeHead(200, headers).end(JSON.stringify({ url, token, project, bridgeKey }));

  if (bridge === null) {
    console.log('handed the credentials to the page once.');
    // Nothing else to hold open. With a bridge running, the process stays up so the
    // audit has something to talk to, and the lifetime below is what ends it.
    setTimeout(() => server.close(() => process.exit(0)), 250);
  } else if (first) {
    // Said in minutes, because the number is the thing an audit has to plan around
    // and the last version left it to be discovered by the bridge disappearing.
    console.log(
      `handed the credentials over. The bridge stays up for ${LIFETIME_MS / 60_000} minutes,`,
    );
    console.log('and the page may ask again in that time.');
  } else {
    console.log('handed the credentials over again.');
  }
});

if (withBridge) {
  console.log(`starting the bridge against "${project}"...`);
  const ready = await startBridge();
  console.log(ready ? '  the bridge is up and its key will travel with the rest.' : '  no bridge.');
  if (!ready) process.exit(1);
}

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
  if (bridge !== null) bridge.kill();
  server.close(() => process.exit(served ? 0 : 1));
}, LIFETIME_MS);
