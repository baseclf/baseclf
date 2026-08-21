/**
 * The result bridge, and the sentence it exists to make true: two roles, one
 * request, two real row sets.
 *
 * These run against a real D1 binding through the engine's own read path,
 * because the bridge's whole claim is that what it returns is what the
 * deployment would return. The gate tests matter as much: the process behind
 * the handler holds a Cloudflare credential, so a request that fails the key
 * must never reach the executor, and a write must not be expressible at all.
 */

import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  POST_BINDS,
  POST_POLICIES,
  registerPolicies,
  seedDatabase,
} from '../src/policy/__fixtures__/schema.js';
import { findVoiceViolations, PLAIN } from './output.js';
import type { PolicyOutcome } from './policy.js';
import {
  type BridgeHandler,
  type BridgeRequest,
  createBridge,
  runStudio,
  STUDIO_FIXED_TEXT,
  type StudioHost,
} from './studio.js';

const KEY = 'bridge-key-under-test';

function post(body: Record<string, unknown>, key = KEY): BridgeRequest {
  const headers: Record<string, string> = { 'x-bridge-key': key, origin: 'http://localhost:3000' };
  return {
    method: 'POST',
    path: '/run',
    header: (name) => headers[name.toLowerCase()] ?? null,
    bodyText: JSON.stringify(body),
  };
}

interface RunAnswer {
  rows?: { id?: string }[];
  rowsRead?: number | null;
  refusal?: string;
  error?: string;
}

async function runOn(handler: BridgeHandler, body: Record<string, unknown>, key = KEY) {
  const response = await handler(post(body, key));
  return { status: response.status, body: JSON.parse(response.body) as RunAnswer };
}

let opened = 0;
let handler: BridgeHandler;

beforeAll(async () => {
  await seedDatabase(env.DB);
  await registerPolicies(env.DB, { table: 'posts', binds: POST_BINDS, policies: POST_POLICIES });

  handler = createBridge({
    key: KEY,
    openExecutor: () => {
      opened += 1;
      return env.DB;
    },
    log: () => {},
  });
});

describe('two roles, one request, two real row sets', () => {
  it('shows an authenticated caller strictly more than anon, from the same input', async () => {
    const anon = await runOn(handler, { table: 'posts', role: 'anon' });
    // `u_ann`, read from the fixture rather than remembered: a test in this
    // repository once ran against a row that did not exist because the fixture
    // wrote `p1` and the test wrote `p_1`.
    const owner = await runOn(handler, {
      table: 'posts',
      role: 'authenticated',
      claims: { uid: 'u_ann' },
    });

    expect(anon.status).toBe(200);
    expect(owner.status).toBe(200);

    const anonIds = (anon.body.rows ?? []).map((row) => row.id).sort();
    const ownerIds = (owner.body.rows ?? []).map((row) => row.id).sort();

    // Both halves, or the assertion proves nothing: anon sees something (the
    // published rows), the owner sees everything anon sees, and the owner sees
    // at least one row anon does not (their own drafts). That difference, from
    // an identical request, is the product.
    expect(anonIds.length).toBeGreaterThan(0);
    for (const id of anonIds) expect(ownerIds).toContain(id);
    expect(ownerIds.length).toBeGreaterThan(anonIds.length);

    // The scan cost is carried through, because rows read is what D1 bills.
    expect(anon.body.rowsRead).not.toBeUndefined();
  });

  it('refuses a table nobody exposed, as an answer rather than an error', async () => {
    const answer = await runOn(handler, { table: 'not_exposed_anywhere', role: 'anon' });
    expect(answer.status).toBe(200);
    expect(answer.body.refusal).toBeDefined();
    expect(answer.body.rows).toBeUndefined();
  });
});

describe('the gate in front of the credential', () => {
  it('a wrong key is refused before the executor is touched', async () => {
    const before = opened;
    const answer = await runOn(handler, { table: 'posts', role: 'anon' }, 'not-the-key');

    expect(answer.status).toBe(401);
    expect(opened).toBe(before);
  });

  it('a write is not expressible, whatever the key', async () => {
    const before = opened;
    const answer = await runOn(handler, {
      table: 'posts',
      role: 'authenticated',
      operation: 'update',
    });

    expect(answer.status).toBe(400);
    expect(answer.body.error).toContain('reads only');
    expect(opened).toBe(before);
  });

  it('answers a preflight with the two headers the page sends', async () => {
    const response = await handler({
      method: 'OPTIONS',
      path: '/run',
      header: (name) => (name === 'origin' ? 'http://localhost:3000' : null),
      bodyText: '',
    });

    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-headers']).toContain('x-bridge-key');
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });

  it('anything that is not POST /run is a 404', async () => {
    const response = await handler({
      method: 'GET',
      path: '/anything',
      header: () => null,
      bodyText: '',
    });
    expect(response.status).toBe(404);
  });
});

describe('the command around it', () => {
  function studioHost(overrides: Partial<StudioHost> = {}): {
    host: StudioHost;
    lines: string[];
    text: () => string;
  } {
    const lines: string[] = [];
    const ok = (results: unknown[]): Response =>
      new Response(
        JSON.stringify({
          success: true,
          result: [
            {
              results,
              meta: {
                duration: 0.5,
                size_after: 1,
                rows_read: 0,
                rows_written: 0,
                last_row_id: 0,
                changes: 0,
                changed_db: false,
              },
            },
          ],
        }),
        { status: 200 },
      );

    return {
      host: {
        fetcher: async (url: string) =>
          url.includes('/d1/database?name=')
            ? new Response(
                JSON.stringify({ success: true, result: [{ uuid: 'db-uuid', name: 'baseclf' }] }),
                { status: 200 },
              )
            : ok([]),
        readFile: () => undefined,
        newId: () => 'the-printed-key',
        credentials: async () => ({
          credentials: { accountId: 'account-id-under-test', token: 't' },
          warnings: [],
        }),
        serve: async () => ({ untilClosed: Promise.resolve() }),
        ...overrides,
      },
      lines,
      text: () => lines.join('\n'),
    };
  }

  const writerFor = (sink: string[]) => (line: string) => {
    sink.push(line);
  };

  it('prints the key once the bridge is listening, then holds until it closes', async () => {
    const { host, lines, text } = studioHost();
    const outcome: PolicyOutcome = await runStudio([], writerFor(lines), PLAIN, host);

    expect(outcome).toBe('ok');
    expect(text()).toContain('127.0.0.1:4000');
    expect(text()).toContain('the-printed-key');
    expect(text()).toContain('Reads only');
  });

  it('a busy port is a refusal, not a stack trace', async () => {
    const { host, lines, text } = studioHost({
      serve: async () => ({ error: 'address already in use' }),
    });
    const outcome = await runStudio(['--port', '4100'], writerFor(lines), PLAIN, host);

    expect(outcome).toBe('failed');
    expect(text()).toContain('4100');
  });

  it('refuses an option it does not have', async () => {
    const { host, lines } = studioHost();
    expect(await runStudio(['--confirm'], writerFor(lines), PLAIN, host)).toBe('usage');
  });

  it('every fixed sentence passes the voice rules', () => {
    expect(STUDIO_FIXED_TEXT.flatMap(findVoiceViolations)).toEqual([]);
  });
});
