/**
 * Does the deployment's policy accept the exact insert the example app sends?
 *
 * The example's compose box only appears after a GitHub sign-in, so the write path had
 * never been exercised: the handoff carried it as "you have to click it to find out".
 * This asks the same question without a browser and without a session, by compiling the
 * statement rather than running it.
 *
 * ⚠️ What this proves and what it does not. `policy_simulate` calls `prepareStatement`,
 * not `executeStatement`, so a pass here means the policy grants every column the form
 * sends and the statement compiles under every guard. It does NOT prove the round trip:
 * no session is minted, no row is written, and nothing here exercises the SDK, CORS, or
 * the fragment handover. Those still need the click.
 *
 * The body below is copied from the submit handler in examples/blog/src/main.ts. If the
 * two drift this probe answers a question nobody is asking, so it prints the columns.
 *
 * ⚠️ The request shape is copied from `probe-mcp-tools.mjs`, which is where the
 * authority for it lives. This revision of MCP has **no initialize handshake**:
 * capabilities are declared per request in `_meta`, and `Mcp-Method` plus `Mcp-Name`
 * are required headers that must agree with the body. Writing it from memory produced a
 * 400 here first. `process.exit` with stdout still pending crashes Node on Windows with
 * a libuv assertion, which also happened here first, so this sets `exitCode` instead.
 *
 * Usage, from the project root:
 *
 *   node --env-file=.env scripts/probe-example-write.mjs
 *   node --env-file=.env scripts/probe-example-write.mjs https://other.workers.dev
 */

const DEFAULT_BASE = 'https://baseclf.raspy-firefly-4c0b.workers.dev';
const PROTOCOL_VERSION = '2026-07-28';

const base = (process.argv[2] ?? DEFAULT_BASE).replace(/\/$/, '');
const token = process.env.MCP_TOKEN;

/** The insert examples/blog/src/main.ts builds, same columns, and no author_id. */
const BODY = {
  id: '00000000-0000-4000-8000-00000000feed',
  title: 'A draft written by the probe',
  body: 'Never stored: the tool compiles the statement and stops.',
  status: 'draft',
  created_at: 1_755_500_000_000,
};

function rpc(method, params) {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOL_VERSION,
      'Mcp-Method': method,
      ...(params.name === undefined ? {} : { 'Mcp-Name': params.name }),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
}

function parseBody(contentType, text) {
  if (!contentType.includes('text/event-stream')) return JSON.parse(text);
  const line = text.split('\n').find((each) => each.startsWith('data:'));
  if (line === undefined) throw new Error('event stream carried no data line');
  return JSON.parse(line.slice(5));
}

/**
 * `error` means the request never reached the tool. `refusal` means the tool ran and
 * said no, which for the anonymous role below is the passing result. Collapsing the two
 * would report a working fail-closed engine as a broken probe.
 */
async function simulate(role) {
  const response = await rpc('tools/call', {
    name: 'policy_simulate',
    arguments: { table: 'posts', operation: 'insert', role, claims: { uid: 'u_1' }, body: BODY },
  });

  const text = await response.text();
  if (response.status === 401) {
    return { error: '401. The deployed secret and MCP_TOKEN disagree; see sync-mcp-secret.mjs.' };
  }

  let envelope;
  try {
    envelope = parseBody(response.headers.get('content-type') ?? '', text);
  } catch {
    return {
      error: `HTTP ${response.status}, body was neither JSON nor SSE: ${text.slice(0, 200)}`,
    };
  }

  if (envelope?.error !== undefined) return { error: JSON.stringify(envelope.error) };

  const result = envelope?.result;
  if (result?.isError === true) {
    const said = (result.content ?? []).map((part) => part.text).join(' ');
    return { refusal: said.replace(/\s+/g, ' ').slice(0, 200) };
  }
  if (result?.structuredContent === undefined) {
    return { error: `no structuredContent in ${JSON.stringify(result).slice(0, 200)}` };
  }
  return { compiled: result.structuredContent };
}

if (typeof token !== 'string' || token.length === 0) {
  console.error('MCP_TOKEN is not set. Run with --env-file=.env from the project root.');
  process.exitCode = 1;
} else {
  console.log(`base:    ${base}`);
  console.log(`columns: ${Object.keys(BODY).join(', ')}   (no author_id, on purpose)`);
  console.log('');

  for (const role of ['authenticated', 'anon']) {
    const outcome = await simulate(role);
    const label = `role ${role.padEnd(14)}`;

    if (outcome.error !== undefined) {
      console.log(`${label} PROBE FAILED  ${outcome.error}`);
      process.exitCode = 1;
    } else if (outcome.refusal !== undefined) {
      console.log(`${label} REFUSED       ${outcome.refusal}`);
    } else {
      const it = outcome.compiled;
      console.log(`${label} COMPILED`);
      console.log(`  policies   ${it.policies.join(', ') || '(none)'}`);
      console.log(`  columns    ${it.columns.join(', ')}`);
      console.log(`  parameters ${it.parameterCount}, withheld ${it.parametersWithheld}`);
      console.log(`  sql        ${it.sql}`);
    }
    console.log('');
  }
}
