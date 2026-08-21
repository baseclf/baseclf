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
import type { D1Endpoint } from './d1-api.js';
import { findVoiceViolations, PLAIN } from './output.js';
import {
  applyDocument as applyPolicyDocument,
  type PolicyOutcome,
  readStoredDocument,
} from './policy.js';
import {
  type BridgeHandler,
  type BridgeRequest,
  createBridge,
  runStudio,
  STUDIO_FIXED_TEXT,
  type StudioHost,
} from './studio.js';

const KEY = 'bridge-key-under-test';

function post(body: Record<string, unknown>, key = KEY, path = '/run'): BridgeRequest {
  const headers: Record<string, string> = { 'x-bridge-key': key, origin: 'http://localhost:3000' };
  return {
    method: 'POST',
    path,
    search: '',
    header: (name) => headers[name.toLowerCase()] ?? null,
    bodyText: JSON.stringify(body),
  };
}

function get(path: string, search: string, key = KEY): BridgeRequest {
  const headers: Record<string, string> = { 'x-bridge-key': key, origin: 'http://localhost:3000' };
  return {
    method: 'GET',
    path,
    search,
    header: (name) => headers[name.toLowerCase()] ?? null,
    bodyText: '',
  };
}

/**
 * A REST endpoint whose transport is the test database. Every statement the
 * CLI's apply sends over "the network" lands on the same D1 the assertions
 * read, so the full path runs for real: schema floor, lock, close-first
 * ordering, expose-last guard.
 */
function endpointOn(db: D1Database, onStatement: () => void): D1Endpoint {
  return {
    databaseId: 'database-under-test',
    credentials: { accountId: 'account-id-under-test', token: 'token-under-test' },
    fetcher: async (_url, init) => {
      onStatement();
      const { sql, params } = JSON.parse(String(init?.body ?? '{}')) as {
        sql: string;
        params?: unknown[];
      };
      const result = await db
        .prepare(sql)
        .bind(...(params ?? []))
        .all();
      return new Response(
        JSON.stringify({
          success: true,
          result: [{ success: true, results: result.results, meta: result.meta }],
        }),
        { status: 200 },
      );
    },
  };
}

interface RunAnswer {
  rows?: { id?: string }[];
  rowsRead?: number | null;
  refusal?: string;
  error?: string;
  applied?: boolean;
  lines?: string[];
}

async function runOn(
  handler: BridgeHandler,
  body: Record<string, unknown>,
  key = KEY,
  path = '/run',
) {
  const response = await handler(post(body, key, path));
  return { status: response.status, body: JSON.parse(response.body) as RunAnswer };
}

let opened = 0;
let statementsSent = 0;
let applies = 0;
let handler: BridgeHandler;
let endpoint: D1Endpoint;

beforeAll(async () => {
  await seedDatabase(env.DB);
  await registerPolicies(env.DB, { table: 'posts', binds: POST_BINDS, policies: POST_POLICIES });

  endpoint = endpointOn(env.DB, () => {
    statementsSent += 1;
  });

  handler = createBridge({
    key: KEY,
    openExecutor: () => {
      opened += 1;
      return env.DB;
    },
    readDocument: (table) => readStoredDocument(endpoint, table),
    applyDocument: async (document) => {
      applies += 1;
      const lines: string[] = [];
      const outcome = await applyPolicyDocument(
        endpoint,
        document,
        { newId: () => `holder-${applies}` },
        (line) => lines.push(line),
        PLAIN,
      );
      return { outcome, lines };
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
      search: '',
      header: (name) => (name === 'origin' ? 'http://localhost:3000' : null),
      bodyText: '',
    });

    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-headers']).toContain('x-bridge-key');
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });

  it('anything that is not a bridge route is a 404', async () => {
    const response = await handler({
      method: 'GET',
      path: '/anything',
      search: '',
      header: () => null,
      bodyText: '',
    });
    expect(response.status).toBe(404);
  });
});

describe('the write lane, which is the CLI apply wearing a route', () => {
  const DOCUMENT = {
    table: 'posts',
    enabled: true,
    binds: {
      isPublished: { status: { _eq: 'published' } },
      isAuthor: { author_id: { _eq: '$auth.uid' } },
    },
    policies: [
      {
        name: 'read_published',
        for: 'select',
        to: ['anon', 'authenticated'],
        using: { $bind: 'isPublished' },
        columns: ['id', 'title', 'status', 'author_id'],
      },
      {
        name: 'read_own',
        for: 'select',
        to: ['authenticated'],
        using: { $bind: 'isAuthor' },
        columns: ['id', 'title', 'status', 'author_id'],
      },
    ],
  };

  it('refuses a document naming user_metadata before anything leaves the machine', async () => {
    // 🔴 Invariant I4 at the newest surface. The count proves the shape of the
    // refusal, not just its status: zero statements were sent, and the CLI's
    // apply was never entered.
    const appliesBefore = applies;
    const statementsBefore = statementsSent;

    const forbidden = {
      ...DOCUMENT,
      policies: [
        {
          name: 'escalate',
          for: 'select',
          to: ['authenticated'],
          using: { author_id: { _eq: '$auth.user.role' } },
          columns: ['id'],
        },
      ],
    };
    const answer = await runOn(handler, { text: JSON.stringify(forbidden) }, KEY, '/apply');

    expect(answer.status).toBe(400);
    expect(answer.body.refusal).toBeDefined();
    expect(applies).toBe(appliesBefore);
    expect(statementsSent).toBe(statementsBefore);
  });

  it('a wrong key is refused before the apply path is touched', async () => {
    const appliesBefore = applies;
    const answer = await runOn(
      handler,
      { text: JSON.stringify(DOCUMENT) },
      'not-the-key',
      '/apply',
    );

    expect(answer.status).toBe(401);
    expect(applies).toBe(appliesBefore);
  });

  it('applies a valid document through the same path the CLI runs, and reads it back', async () => {
    const answer = await runOn(handler, { text: JSON.stringify(DOCUMENT) }, KEY, '/apply');

    expect(answer.status).toBe(200);
    expect(answer.body.applied).toBe(true);
    expect((answer.body.lines ?? []).join('\n')).toContain('is exposed with 2 rules');

    // The read-back is the document that was submitted: stored as source,
    // reassembled as source. This is also the editor's seed lane.
    const readBack = await handler(get('/document', '?table=posts'));
    expect(readBack.status).toBe(200);
    const { document } = JSON.parse(readBack.body) as { document: Record<string, unknown> };
    expect(document).toEqual(DOCUMENT);
  });

  it('answers null for a table that is not exposed, and 401 without the key', async () => {
    const missing = await handler(get('/document', '?table=not_exposed_anywhere'));
    expect(JSON.parse(missing.body)).toEqual({ document: null });

    const refused = await handler(get('/document', '?table=posts', 'not-the-key'));
    expect(refused.status).toBe(401);
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
    expect(text()).toContain('Reads, plus the policy documents you apply');
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
