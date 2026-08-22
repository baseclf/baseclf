/**
 * The management surface on a deployment shaped like a first run: application
 * tables exist, engine tables do not, because nothing has touched /rest/v1.
 *
 * Every other suite seeds the engine schema before asking questions, so this
 * exact state (the state every fresh deployment starts in) had no test. The
 * first real walkthrough hit it: /_schema listed the new table while the
 * Studio, which reads schema_list through /mcp, drew an empty database over
 * an INTERNAL error. The /mcp route lays the same engine-schema floor as the
 * data paths now, and this exercises the whole route the way the Studio does.
 */

import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';

import { resetCatalogue } from '../../db/introspect.js';
import worker, { type Env } from '../../index.js';
import { resetRegistry } from '../../policy/registry.js';

const BASE = 'https://baseclf.test';
const TOKEN = 'a-shared-secret-of-ordinary-length';

const configured = {
  ...env,
  BETTER_AUTH_SECRET: 'test-secret-not-used-to-sign-anything-real',
  BETTER_AUTH_URL: BASE,
  MCP_TOKEN: TOKEN,
} as unknown as Env;

/** A tools/call the way a real client sends one, envelope and all. */
function callTool(name: string): Promise<Response> {
  return worker.fetch(
    new Request(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'CF-Connecting-IP': '203.0.113.230',
        // Real HTTP always carries Host; worker.fetch in a test does not fill
        // it in, and the SDK's DNS-rebinding check refuses its absence.
        Host: 'baseclf.test',
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/call',
        'Mcp-Name': name,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name,
          arguments: {},
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    }),
    configured,
  );
}

/** The server may answer JSON or SSE; both are within the spec. */
async function unwrap(response: Response): Promise<{
  isError?: boolean;
  structuredContent?: { tables?: { name: string; exposed: boolean }[] };
}> {
  const text = await response.text();
  const payload = (response.headers.get('content-type') ?? '').includes('text/event-stream')
    ? text
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('')
    : text;
  const envelope = JSON.parse(payload) as { result?: Record<string, unknown> };
  return (envelope.result ?? {}) as Awaited<ReturnType<typeof unwrap>>;
}

describe('a fresh deployment: application table present, engine tables absent', () => {
  beforeAll(async () => {
    await env.DB.prepare('DELETE FROM _rate_limit')
      .run()
      .catch(() => undefined);
    await env.DB.prepare('DROP TABLE IF EXISTS _policies').run();
    await env.DB.prepare('DROP TABLE IF EXISTS _policy_binds').run();
    await env.DB.prepare('DROP TABLE IF EXISTS _exposed_tables').run();
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, title TEXT, status TEXT)',
    ).run();
    resetCatalogue();
    resetRegistry();
  });

  it('schema_list answers the table, unexposed, instead of an INTERNAL error', async () => {
    const response = await callTool('schema_list');
    expect(response.status).toBe(200);

    const result = await unwrap(response);
    // The route lays the engine-schema floor before the handler, so the
    // registry loads (empty) rather than throwing on a missing table. Without
    // the floor this was {isError: true, INTERNAL}, which the Studio drew as
    // an empty database.
    expect(result.isError).not.toBe(true);
    const tables = result.structuredContent?.tables ?? [];
    expect(tables.map((table) => table.name)).toContain('notes');
    expect(tables.find((table) => table.name === 'notes')?.exposed).toBe(false);
  });

  it('policy_list answers empty rather than erroring, for the same reason', async () => {
    const response = await callTool('policy_list');
    expect(response.status).toBe(200);
    expect((await unwrap(response)).isError).not.toBe(true);
  });
});
