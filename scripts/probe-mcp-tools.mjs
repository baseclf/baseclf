/**
 * Ask a deployed BaseCLF for its tool list, and report what came back.
 *
 * Written as a file rather than as a shell one-liner on purpose. A JSON-RPC body
 * quoted inside cmd.exe is exactly the shape `rules/01` section G10 records as
 * having produced a confident, wrong answer once already: the shell ate the
 * quoting and the failure looked like the product. Twice while bringing this up,
 * a placeholder reached the server instead of the token for the same reason.
 *
 * The token is read from the environment and never printed. The failure paths
 * below say what to do without quoting the value back, because a terminal ends
 * up in screenshots.
 *
 * Usage, from the project root:
 *
 *   node --env-file=.env scripts/probe-mcp-tools.mjs
 *   node --env-file=.env scripts/probe-mcp-tools.mjs https://other.workers.dev
 *
 * Requires MCP_TOKEN in .env matching the deployed secret. `sync-mcp-secret.mjs`
 * is what guarantees they are the same value.
 */

const DEFAULT_BASE = 'https://baseclf.raspy-firefly-4c0b.workers.dev';
const PROTOCOL_VERSION = '2026-07-28';

const EXPECTED = [
  'policy_lint',
  'policy_list',
  'policy_simulate',
  'schema_describe',
  'schema_list',
];

/**
 * A response may be JSON or an SSE stream: the spec lets the server choose and
 * both are correct, so reading only JSON would report a working server as broken.
 */
function parseBody(contentType, text) {
  if (contentType.includes('text/event-stream')) {
    const payload = text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('');
    return payload === '' ? null : JSON.parse(payload);
  }
  return JSON.parse(text);
}

/**
 * ⚠️ One function with returns, rather than top-level code with `process.exit`.
 *
 * Both details were bugs here first. `process.exit` while stdout still had work
 * pending crashed Node on Windows with a libuv assertion, and replacing it with
 * `process.exitCode` alone let every failure path fall through and report "0
 * tools", which reads as an empty server rather than as a failed request.
 */
function rpc(base, token, method, params) {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOL_VERSION,
      'Mcp-Method': method,
      // ⚠️ Required for tools/call, resources/read and prompts/get, and it must
      // agree with the body: a mismatch is -32020, not a warning. Omitting it
      // here produced a response with no `result` at all, which read as the tool
      // refusing rather than as the request never being accepted.
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
          // ⚠️ Required to be present, and allowed to be empty. Every field of
          // `ClientCapabilitiesSchema` in the installed core package is optional,
          // so `{}` validates, but omitting the key is -32602 rather than a
          // default. Capabilities are declared per request in this revision:
          // the initialize handshake is gone, so there is nowhere else for them.
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
}

async function main() {
  const base = (process.argv[2] ?? DEFAULT_BASE).replace(/\/+$/, '');
  const token = process.env.MCP_TOKEN;

  if (token === undefined || token === '') {
    console.error('MCP_TOKEN is not set. Add it to .env and run with --env-file=.env');
    return 1;
  }

  const response = await rpc(base, token, 'tools/list', {});

  const text = await response.text();
  console.log(`HTTP ${response.status} ${response.headers.get('content-type') ?? ''}`);

  if (response.status === 401) {
    console.error('\nRefused. The token in .env does not match the deployed secret.');
    console.error('Run: node scripts/sync-mcp-secret.mjs');
    return 1;
  }

  let parsed;
  try {
    parsed = parseBody(response.headers.get('content-type') ?? '', text);
  } catch {
    console.error('\nCould not parse the body as JSON or SSE:');
    console.error(text.slice(0, 500));
    return 1;
  }

  if (parsed?.error !== undefined) {
    // ⚠️ Kept distinct from the 401 above. -32602 and -32020 mean this probe is
    // malformed, not that the deployment is broken, and treating them alike
    // would send someone to debug a worker that is answering correctly.
    console.error(`\nJSON-RPC error ${parsed.error.code}: ${parsed.error.message}`);
    console.error('That is this probe being wrong about the protocol, not the deployment.');
    return 1;
  }

  const tools = parsed?.result?.tools ?? [];
  console.log(`\n${tools.length} tool(s):`);
  for (const tool of tools) console.log(`  ${tool.name}`);

  const names = tools.map((tool) => tool.name);
  const missing = EXPECTED.filter((name) => !names.includes(name));

  if (missing.length > 0) {
    console.error(`\nMissing: ${missing.join(', ')}`);
    return 1;
  }

  console.log(`\nAll ${EXPECTED.length} expected tools are live.`);

  // Listing a tool only proves it was registered. Calling one proves the engine
  // behind it can reach D1, load a registry and compile, which is the part that
  // has only ever run in a local test.
  const called = await rpc(base, token, 'tools/call', {
    name: 'policy_simulate',
    arguments: { table: 'posts', role: 'anon' },
  });
  const calledText = await called.text();
  const envelope = parseBody(called.headers.get('content-type') ?? '', calledText);

  if (envelope?.error !== undefined) {
    console.error(`\nJSON-RPC error ${envelope.error.code}: ${envelope.error.message}`);
    console.error('That is this probe being wrong about the protocol, not the deployment.');
    return 1;
  }

  const result = envelope?.result;
  if (result === undefined) {
    // Printed verbatim rather than summarised. A summary of a shape you did not
    // predict is a guess wearing a diagnosis.
    console.error(`\nNo result in the response. HTTP ${called.status}, body:`);
    console.error(calledText.slice(0, 500));
    return 1;
  }
  if (result.isError === true) {
    console.error('\npolicy_simulate refused:', JSON.stringify(result.content));
    return 1;
  }

  const structured = result.structuredContent ?? {};
  console.log('\npolicy_simulate on posts as anon:');
  console.log(`  policies       ${JSON.stringify(structured.policies)}`);
  console.log(`  columns        ${JSON.stringify(structured.columns)}`);
  console.log(`  parameterCount ${structured.parameterCount}`);
  console.log(`  withheld       ${structured.parametersWithheld}`);
  console.log(`  sql            ${structured.sql}`);

  // ⚠️ The values were not asked for, so they must not be here. Checked rather
  // than assumed: this is the one field whose default was a product decision.
  if (structured.parameters !== undefined) {
    console.error('\nParameter values came back without being asked for.');
    return 1;
  }

  return 0;
}

process.exitCode = await main();
