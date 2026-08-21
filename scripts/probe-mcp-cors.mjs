/**
 * Can a browser reach /mcp at all?
 *
 * The Studio front end is a browser client, and the MCP transport needs four
 * headers a browser must ask permission for in a preflight: authorization,
 * content-type, mcp-protocol-version and mcp-method (plus mcp-name on
 * tools/call). If any of them is missing from Access-Control-Allow-Headers, the
 * preflight fails and no request is ever sent, an outcome no server-side test
 * can see because no HTTP client enforces CORS.
 *
 * Three measurements, none needing the token:
 *
 *   1. Preflight from a trusted origin asking for every header the client sends.
 *      Passing means the browser lane is open.
 *   2. Preflight from a stranger origin. No allow-origin must come back.
 *   3. POST with a wrong bearer from the trusted origin. The 401 must still
 *      carry allow-origin, or the browser shows a network error instead of a
 *      refusal the UI can read.
 *
 * Usage: node scripts/probe-mcp-cors.mjs [deployment-url] [trusted-origin]
 */

const BASE = (process.argv[2] ?? 'https://baseclf.raspy-firefly-4c0b.workers.dev').replace(
  /\/+$/,
  '',
);
const TRUSTED = process.argv[3] ?? 'http://localhost:3000';
const STRANGER = 'https://stranger.example';

const NEEDED = ['authorization', 'content-type', 'mcp-protocol-version', 'mcp-method', 'mcp-name'];

function show(name, response) {
  const allowOrigin = response.headers.get('access-control-allow-origin');
  const allowHeaders = response.headers.get('access-control-allow-headers');
  console.log(`\n${name}`);
  console.log(`  status        ${response.status}`);
  console.log(`  allow-origin  ${allowOrigin ?? '(absent)'}`);
  console.log(`  allow-headers ${allowHeaders ?? '(absent)'}`);
  return { allowOrigin, allowHeaders };
}

let failed = false;

const trusted = await fetch(`${BASE}/mcp`, {
  method: 'OPTIONS',
  headers: {
    origin: TRUSTED,
    'access-control-request-method': 'POST',
    'access-control-request-headers': NEEDED.join(','),
  },
});
const opened = show(`preflight from the trusted origin (${TRUSTED})`, trusted);

if (opened.allowOrigin !== TRUSTED) {
  console.log('  -> the origin is not allowed. Is it in BETTER_AUTH_TRUSTED_ORIGINS?');
  failed = true;
} else {
  const allowed = (opened.allowHeaders ?? '').toLowerCase();
  const missing = NEEDED.filter((header) => !allowed.includes(header));
  if (missing.length > 0) {
    console.log(`  -> MISSING from allow-headers: ${missing.join(', ')}`);
    console.log('     A browser client cannot send these, so the preflight kills every call.');
    failed = true;
  } else {
    console.log('  -> every header the MCP client needs is allowed.');
  }
}

const stranger = await fetch(`${BASE}/mcp`, {
  method: 'OPTIONS',
  headers: {
    origin: STRANGER,
    'access-control-request-method': 'POST',
    'access-control-request-headers': NEEDED.join(','),
  },
});
const closed = show(`preflight from a stranger origin (${STRANGER})`, stranger);
if (closed.allowOrigin !== null) {
  console.log('  -> a stranger origin was allowed. That is wrong.');
  failed = true;
} else {
  console.log('  -> refused, as it must be.');
}

const refusal = await fetch(`${BASE}/mcp`, {
  method: 'POST',
  headers: {
    origin: TRUSTED,
    authorization: 'Bearer not-the-token',
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
});
const readable = show('a wrong bearer from the trusted origin', refusal);
if (refusal.status !== 401) {
  console.log(`  -> expected 401, got ${refusal.status}.`);
  failed = true;
}
if (readable.allowOrigin !== TRUSTED) {
  console.log('  -> the refusal carries no allow-origin, so a browser cannot read it.');
  failed = true;
} else {
  console.log('  -> the refusal is readable from the browser.');
}

console.log(failed ? '\nThe browser lane is NOT open.' : '\nThe browser lane is open.');
process.exitCode = failed ? 1 : 0;
