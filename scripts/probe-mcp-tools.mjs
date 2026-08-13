/**
 * Ask a deployed BaseCLF for its tool list, then call every tool on it.
 *
 * The second half is the point. `tools/list` answers the same way whether the
 * engine behind a tool reaches D1 or was never wired to it, and four of these
 * five shipped in a release having proved only that they had been registered.
 * Two of the calls below are expected to be refused, and the refusal is what
 * passes: one writes a column the policy does not grant, and one asks for an
 * operation with no policy at all.
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

/**
 * ⚠️ This probe expects the demo fixture: a table `posts` with a select policy
 * for `anon` and an `update_own` for `authenticated` that grants `title` and does
 * not grant `author_id`. Pointed at a deployment carrying anything else it will
 * fail, and the failure will name which call disagreed. That is deliberate: a
 * probe that skipped whatever it did not find would report a deployment with no
 * policies at all as a clean run.
 */
const TABLE = 'posts';

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

/**
 * One call, with the envelope unwrapped and the two failure kinds kept apart.
 *
 * `error` means the request never reached the tool: a protocol mistake by this
 * probe, or a deployment that cannot answer. `refusal` means the tool ran and
 * said no, which for several calls below is the passing result rather than the
 * failing one. Collapsing them would report a working fail-closed engine as a
 * broken probe, and a broken probe as a working engine.
 */
async function callTool(base, token, name, args) {
  const response = await rpc(base, token, 'tools/call', { name, arguments: args });
  const text = await response.text();

  let envelope;
  try {
    envelope = parseBody(response.headers.get('content-type') ?? '', text);
  } catch {
    return { error: `body was neither JSON nor SSE: ${text.slice(0, 200)}` };
  }

  if (envelope?.error !== undefined) {
    return { error: `JSON-RPC ${envelope.error.code}: ${envelope.error.message}` };
  }
  if (envelope?.result === undefined) {
    return { error: `no result. HTTP ${response.status}, body: ${text.slice(0, 200)}` };
  }
  if (envelope.result.isError === true) {
    return { refusal: JSON.stringify(envelope.result.content) };
  }

  return { structured: envelope.result.structuredContent ?? {} };
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
  //
  // ⚠️ Every tool is called, not one. A listing looks the same whether the engine
  // behind a tool works or was never wired to D1 at all, and four of these went
  // out in a release having proved only that they had been registered.
  console.log('\nCalling each one, because being listed is not reaching D1:');

  for (const [name, args] of [
    ['schema_list', {}],
    ['schema_describe', { table: TABLE }],
    ['policy_list', {}],
    ['policy_lint', {}],
  ]) {
    const call = await callTool(base, token, name, args);
    if (call.error !== undefined) {
      console.error(`\n${name}: ${call.error}`);
      return 1;
    }
    if (call.refusal !== undefined) {
      console.error(`\n${name} refused: ${call.refusal}`);
      return 1;
    }
    console.log(`  ${name.padEnd(16)} answered`);
  }

  const read = await callTool(base, token, 'policy_simulate', { table: TABLE, role: 'anon' });
  if (read.error !== undefined || read.refusal !== undefined) {
    console.error(`\npolicy_simulate select: ${read.error ?? read.refusal}`);
    return 1;
  }

  const structured = read.structured;
  console.log(`\npolicy_simulate on ${TABLE} as anon:`);
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

  // The write path, which is the half that cannot be read off a policy by eye.
  // SQLite has no WITH CHECK, so the condition on the row as it will be is built
  // by rewriting every column reference in `check` into its post-image, and the
  // result is a statement whose safety is not visible from the policy that
  // produced it. Printed rather than asserted, because the shape is what a policy
  // author reads, and an assertion on its text would break on a reworded policy
  // while saying nothing about whether the engine still refuses the right things.
  const write = await callTool(base, token, 'policy_simulate', {
    table: TABLE,
    role: 'authenticated',
    operation: 'update',
    claims: { uid: 'u_1' },
    body: { title: 'edited' },
  });
  if (write.error !== undefined || write.refusal !== undefined) {
    console.error(`\npolicy_simulate update: ${write.error ?? write.refusal}`);
    return 1;
  }
  console.log(`\npolicy_simulate update on ${TABLE} as authenticated:`);
  console.log(`  policies       ${JSON.stringify(write.structured.policies)}`);
  console.log(`  sql            ${write.structured.sql}`);

  // Two refusals, and here the refusal is the passing result. These are asserted
  // rather than printed: a deployment that compiled either one would be fail-open,
  // and a printed line is something a reader skims past.
  //
  // ⚠️ The refusal is asserted, its wording is not. The code behind both is the
  // single not-found that I5 asks for on "does not exist" and "not allowed" alike,
  // so matching the message would tie this probe to prose rather than to the rule.
  for (const [what, args] of [
    // A column the policy does not grant, sent the way a caller would if they were
    // trying to hand the row to somebody else. `update_own` grants title, body and
    // status, so `author_id` has to be refused before anything is compiled.
    [
      'writing a column the policy does not grant',
      {
        table: TABLE,
        role: 'authenticated',
        operation: 'update',
        claims: { uid: 'u_1' },
        body: { title: 'edited', author_id: 'u_2' },
      },
    ],
    // No policy exists for this pair at all, and I1 says that is a refusal rather
    // than an empty result.
    ['an operation with no policy at all', { table: TABLE, role: 'anon', operation: 'delete' }],
  ]) {
    const call = await callTool(base, token, 'policy_simulate', args);
    if (call.error !== undefined) {
      console.error(`\n${what}: ${call.error}`);
      return 1;
    }
    if (call.refusal === undefined) {
      console.error(`\nCompiled rather than refused: ${what}. That is fail-open.`);
      return 1;
    }
    console.log(`\n  refused, as it must be: ${what}`);
  }

  return 0;
}

process.exitCode = await main();
