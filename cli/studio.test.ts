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
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { D1Executor } from '../src/db/dialect.js';
import {
  POST_BINDS,
  POST_POLICIES,
  registerPolicies,
  SEED_ROWS,
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
  BRIDGE_METHODS,
  type BridgeHandler,
  type BridgeRequest,
  createBridge,
  runStudio,
  STUDIO_FIXED_TEXT,
  type StudioHost,
} from './studio.js';
import { ANALYTICS_PERMISSION, type UsageAnswer } from './usage.js';

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

/**
 * The D1 binding, cut down to what the bridge's real transport actually offers.
 *
 * 🔴 The harness was handing the bridge a full `D1Database`, which has `run()`
 * and `first()`. `restExecutor` in `d1-api.ts` implements `all()` and nothing
 * else, on purpose: a transport that answered `first()` with something
 * plausible would be worse than one with no answer. So the bridge could call
 * `run()`, pass every test here, and throw against a real deployment.
 *
 * It did. The audit write used `run()` and every real edit came back
 * `recorded: false`, which was only visible by running the bridge against a
 * database. A harness more capable than production answers a question nobody
 * asked; this one is now exactly as capable.
 */
function allOnly(db: D1Database): D1Executor {
  return {
    prepare: (sql: string) => {
      const statement = db.prepare(sql);
      const wrap = (bound: D1PreparedStatement) => ({
        bind: (...values: unknown[]) => wrap(bound.bind(...values)),
        all: <T>() => bound.all<T>(),
        first: () => {
          throw new Error('This transport implements all() only.');
        },
        run: () => {
          throw new Error('This transport implements all() only.');
        },
        raw: () => {
          throw new Error('This transport implements all() only.');
        },
      });
      return wrap(statement);
    },
    batch: () => {
      throw new Error('The D1 REST API has no batch.');
    },
  } as unknown as D1Executor;
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

/**
 * What the account would say about usage, swapped per test.
 *
 * A refusal is the interesting one and is not an error case: the permission list the
 * CLI prints does not include `Account · Account Analytics · Read`, so a token built
 * from it is expected to land here.
 */
const SOME_NUMBERS = {
  requests: 420,
  errors: 0,
  cpuP50: 18_995,
  cpuP99: 45_577,
  rowsRead: 22,
  rowsWritten: 18,
  since: '2026-08-16',
  until: '2026-08-23',
  scriptName: 'baseclf',
} as const;

let usageAnswer: UsageAnswer = { kind: 'numbers', numbers: SOME_NUMBERS };

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
      return allOnly(env.DB);
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
    // Whatever the last `usageAnswer` was set to. The bridge asks per request, so a
    // test can move it between the two outcomes without rebuilding the handler.
    readUsage: () => Promise.resolve(usageAnswer),
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

describe('a fresh deployment, which has no engine tables yet', () => {
  /**
   * An endpoint scripted per statement, shaped like the real refusal: D1 puts
   * the SQLite error into the envelope's `errors[].message` (the same shape
   * `cli/policy.test.ts` uses for a refused statement).
   */
  function scriptedEndpoint(
    answers: (sql: string) => { rows: readonly unknown[] } | { refusedWith: string },
  ): D1Endpoint {
    return {
      databaseId: 'database-under-test',
      credentials: { accountId: 'account-id-under-test', token: 'token-under-test' },
      fetcher: async (_url, init) => {
        const { sql } = JSON.parse(String(init?.body ?? '{}')) as { sql: string };
        const answer = answers(sql);
        if ('refusedWith' in answer) {
          return new Response(
            JSON.stringify({
              success: false,
              errors: [{ code: 7500, message: answer.refusedWith }],
            }),
            { status: 400 },
          );
        }
        return new Response(
          JSON.stringify({
            success: true,
            result: [{ success: true, results: answer.rows, meta: {} }],
          }),
          { status: 200 },
        );
      },
    };
  }

  function bridgeOver(endpoint: D1Endpoint, lines: string[]): BridgeHandler {
    return createBridge({
      key: KEY,
      openExecutor: () => env.DB,
      readDocument: (table) => readStoredDocument(endpoint, table),
      applyDocument: () => Promise.resolve({ outcome: 'ok' as const, lines: [] }),
      readUsage: () => Promise.resolve(usageAnswer),
      log: (line) => lines.push(line),
    });
  }

  it('answers /document with null, not an error, and does not log a failure', async () => {
    // The wizard's bridge check reads a document from a deployment that may
    // have never served a data request, and the Worker only creates the engine
    // tables on the first one. That state is normal, not broken: no
    // `_exposed_tables` means nothing was ever exposed. This used to answer 500
    // and log "a document read failed before it finished" at the exact moment a
    // person was following the setup wizard.
    const lines: string[] = [];
    const fresh = bridgeOver(
      scriptedEndpoint(() => ({ refusedWith: 'no such table: _exposed_tables at offset 29' })),
      lines,
    );

    const answer = await fresh(get('/document', '?table=__wizard_ping__'));

    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toEqual({ document: null });
    expect(lines.join('\n')).not.toContain('failed');
  });

  it('still fails loud when a later engine table is the one missing', async () => {
    // The narrowness of the match is the point: `_policies` or `_policy_binds`
    // missing while `_exposed_tables` answered is not the fresh state, it is a
    // deployment somebody half-dismantled, and calling that "nothing stored"
    // would seed the editor with a template over policies that still exist.
    const lines: string[] = [];
    const broken = bridgeOver(
      scriptedEndpoint((sql) =>
        sql.includes('_exposed_tables')
          ? { rows: [{ enabled: 1 }] }
          : { refusedWith: 'no such table: _policy_binds at offset 41' },
      ),
      lines,
    );

    const answer = await broken(get('/document', '?table=posts'));

    expect(answer.status).toBe(500);
    expect(lines.join('\n')).toContain('a document read failed before it finished');
  });

  it('still fails loud when the refusal is not about a missing table at all', async () => {
    // The other direction a widened catch would break: an expired credential is
    // not "nothing stored", and answering null for it would hide a real outage.
    const lines: string[] = [];
    const unauthorised = bridgeOver(
      scriptedEndpoint(() => ({ refusedWith: 'Authentication error' })),
      lines,
    );

    const answer = await unauthorised(get('/document', '?table=posts'));

    expect(answer.status).toBe(500);
    expect(lines.join('\n')).toContain('a document read failed before it finished');
  });
});

describe('the operator row browse', () => {
  interface BrowseAnswer {
    rows?: { id?: string; status?: string }[];
    rowsRead?: number | null;
    limit?: number;
    offset?: number;
    error?: string;
  }

  async function browse(
    search: string,
    key = KEY,
  ): Promise<{ status: number; body: BrowseAnswer }> {
    const response = await handler(get('/rows', search, key));
    return { status: response.status, body: JSON.parse(response.body) as BrowseAnswer };
  }

  it('shows every row newest first, drafts included, and says what the scan cost', async () => {
    const answer = await browse('?table=posts');

    expect(answer.status).toBe(200);
    // Both product claims in one line: insertion order reversed (the page an
    // operator who just seeded wants), and the drafts are present, because
    // this is the operator's view and no policy applies. What a caller would
    // see is the simulator's question, and the panel says so.
    expect((answer.body.rows ?? []).map((row) => row.id)).toEqual(['p4', 'p3', 'p2', 'p1']);
    expect((answer.body.rows ?? []).some((row) => row.status === 'draft')).toBe(true);
    expect(typeof answer.body.rowsRead).toBe('number');
    expect(answer.body.limit).toBeGreaterThan(0);
  });

  it('remembers the catalogue between pages instead of re-reading the schema', async () => {
    await browse('?table=posts');
    const warm = opened;
    await browse('?table=posts&offset=50');

    // One executor open for the query itself, none for introspection: a page
    // turner must not pay the whole PRAGMA sweep per click on a transport
    // with no batch.
    expect(opened - warm).toBe(1);
  });

  it('refuses engine tables, which stay CLI-only', async () => {
    for (const name of ['_policies', 'user', 'jwks']) {
      const answer = await browse(`?table=${name}`);
      expect(answer.status).toBe(400);
      expect(answer.body.error).toContain('CLI');
      expect(answer.body.rows).toBeUndefined();
    }
  });

  it('refuses a page past the scan ceiling, naming the reason', async () => {
    const answer = await browse('?table=posts&offset=5000');
    expect(answer.status).toBe(400);
    expect(answer.body.error).toContain('rows read is what D1 bills');
  });

  it('is behind the same key as every other verb', async () => {
    const before = opened;
    const answer = await browse('?table=posts', 'not-the-key');
    expect(answer.status).toBe(401);
    expect(opened).toBe(before);
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

/**
 * The edit lane: the bridge's second write verb, and the first one that touches
 * application data.
 *
 * `/apply` writes configuration an operator submitted and can resubmit. This
 * writes a customer's row, on a database with no interactive transaction and a
 * restore that works a database at a time. So the tests that carry weight are
 * the ones about what it will not do, and the one about what happens when
 * somebody else got there first.
 */
describe('the operator row edit', () => {
  interface EditAnswer {
    row?: Record<string, unknown>;
    recorded?: boolean;
    warning?: string;
    conflict?: string;
    error?: string;
  }

  function patch(body: Record<string, unknown>, key = KEY): BridgeRequest {
    const headers: Record<string, string> = {
      'x-bridge-key': key,
      origin: 'http://localhost:3000',
    };
    return {
      method: 'PATCH',
      path: '/rows',
      search: '',
      header: (name) => headers[name.toLowerCase()] ?? null,
      bodyText: JSON.stringify(body),
    };
  }

  async function edit(
    body: Record<string, unknown>,
    key = KEY,
  ): Promise<{ status: number; body: EditAnswer }> {
    const response = await handler(patch(body, key));
    return { status: response.status, body: JSON.parse(response.body) as EditAnswer };
  }

  // Read from the fixture rather than written out, which is the advice the
  // comment two hundred lines up already gives, and which this block ignored on
  // its first draft: the ids are `p1` and `p2`, the tests said `p_1`, and every
  // assertion ran against a row that was not there. The fixture is the source.
  const FIRST = SEED_ROWS[0]?.[0] ?? '';
  const SECOND = SEED_ROWS[1]?.[0] ?? '';

  async function titleOf(id: string): Promise<string | null> {
    const row = await env.DB.prepare('SELECT title FROM posts WHERE id = ?1')
      .bind(id)
      .first<{ title: string | null }>();
    return row?.title ?? null;
  }

  async function auditRows(): Promise<{ subject: string; detail: string | null }[]> {
    // A missing table counts as no entries, and is the stronger version of it:
    // the bridge lays this floor on its first successful edit, so a run that
    // recorded nothing has not created it either. Reading through a throw would
    // make every refusal test fail for a reason that is not its subject.
    try {
      const rows = await env.DB.prepare('SELECT subject, detail FROM _audit_log ORDER BY id').all<{
        subject: string;
        detail: string | null;
      }>();
      return rows.results ?? [];
    } catch {
      return [];
    }
  }

  beforeEach(async () => {
    // Dropped, not created. The bridge talks to databases that have never
    // served a request, so laying this floor is its job, and a harness that
    // seeded the table would be testing a world where the floor is unnecessary.
    // Measured against a fresh D1: without it, every edit reported that the
    // change was written and not recorded.
    await env.DB.prepare('DROP TABLE IF EXISTS _audit_log').run();
  });

  it('writes the row, hands back its post-image, and records the change', async () => {
    const before = await titleOf(FIRST);

    const answer = await edit({
      table: 'posts',
      key: { id: FIRST },
      column: 'title',
      expected: before,
      next: 'an edited title',
    });

    expect(answer.status).toBe(200);
    expect(answer.body.row?.title).toBe('an edited title');
    expect(answer.body.recorded).toBe(true);
    expect(await titleOf(FIRST)).toBe('an edited title');

    // Which row and which column, and no value anywhere in the entry.
    expect(await auditRows()).toEqual([{ subject: `posts[id=${FIRST}]`, detail: 'title' }]);
  });

  it('writes nothing when the value moved on, and says both possible reasons', async () => {
    // Bound, because the replacement that put the fixture id here turned a
    // quoted literal into an identifier inside a SQL string, which under DQS
    // would have compared the column against the text "FIRST" and matched
    // nothing, quietly.
    await env.DB.prepare('UPDATE posts SET title = ?1 WHERE id = ?2')
      .bind('somebody else', FIRST)
      .run();

    const answer = await edit({
      table: 'posts',
      key: { id: FIRST },
      column: 'title',
      expected: 'what the page had',
      next: 'mine',
    });

    expect(answer.status).toBe(409);
    // Two causes produce one empty result and this cannot tell them apart
    // without a second read that would race the first, so it says both.
    expect(answer.body.conflict).toMatch(/no longer there/);
    expect(answer.body.conflict).toMatch(/changed/);
    expect(await titleOf(FIRST)).toBe('somebody else');
    expect(await auditRows()).toEqual([]);
  });

  it('refuses without the key, before anything holding a credential is touched', async () => {
    const openedBefore = opened;
    const answer = await edit(
      { table: 'posts', key: { id: FIRST }, column: 'title', expected: 'a', next: 'b' },
      'not-the-key',
    );

    expect(answer.status).toBe(401);
    expect(opened).toBe(openedBefore);
  });

  it('refuses an engine table, so the bridge cannot be used to rewrite policy', async () => {
    const answer = await edit({
      table: '_policies',
      key: { id: '1' },
      column: 'using_expr',
      expected: 'a',
      next: 'b',
    });
    expect(answer.status).toBe(400);
    expect(answer.body.error).toContain('Engine tables');
  });

  it('refuses a body that is not one edit', async () => {
    // The shape is checked before the catalogue is consulted, so the refusals
    // from the statement builder are about the database rather than about JSON.
    for (const body of [
      { key: { id: FIRST }, column: 'title', expected: 'a', next: 'b' },
      { table: 'posts', column: 'title', expected: 'a', next: 'b' },
      { table: 'posts', key: { id: FIRST }, expected: 'a', next: 'b' },
      {
        table: 'posts',
        key: { id: FIRST },
        column: 'title',
        expected: 'a',
        next: { of: 'course' },
      },
      { table: 'posts', key: { id: { nested: true } }, column: 'title', expected: 'a', next: 'b' },
    ]) {
      const answer = await edit(body);
      expect(answer.status).toBe(400);
    }
    expect(await auditRows()).toEqual([]);
  });

  it('leaves the other rows alone', async () => {
    const otherBefore = await titleOf(SECOND);
    await edit({
      table: 'posts',
      key: { id: FIRST },
      column: 'title',
      expected: await titleOf(FIRST),
      next: 'changed',
    });
    expect(await titleOf(SECOND)).toBe(otherBefore);
  });
});

/**
 * What the preflight advertises has to cover what the bridge routes.
 *
 * The handler is handed requests directly in every other test here, so a method
 * the routes accept and the preflight does not would pass all of them and fail
 * in the only place it matters. That is how the private network header came to
 * be needed too, and the comment above it says the same thing.
 */
describe('the preflight and the routes agree', () => {
  it('advertises every method the bridge answers on, and OPTIONS', async () => {
    // The first version of this read the source file to find the routed
    // methods, which cannot be done inside workerd. The fix was better than the
    // test: the header is now built from the route table, so this asserts that
    // the two are one thing rather than watching two things stay equal.
    const response = await handler({
      method: 'OPTIONS',
      path: '/rows',
      search: '',
      header: (name) => (name.toLowerCase() === 'origin' ? 'http://localhost:3000' : null),
      bodyText: '',
    });

    const advertised = response.headers['access-control-allow-methods'] ?? '';
    for (const method of ['GET', 'POST', 'PATCH', 'OPTIONS']) {
      expect(advertised).toContain(method);
    }
    expect(BRIDGE_METHODS).toContain('PATCH');
  });
});

describe('the usage numbers, which come from the account rather than the deployment', () => {
  interface UsageBody {
    numbers?: { requests?: number; rowsRead?: number; scriptName?: string };
    refused?: string;
    permission?: string;
    error?: string;
  }

  async function usage(key = KEY): Promise<{ status: number; body: UsageBody }> {
    const response = await handler(get('/usage', '', key));
    return { status: response.status, body: JSON.parse(response.body) as UsageBody };
  }

  beforeEach(() => {
    usageAnswer = { kind: 'numbers', numbers: SOME_NUMBERS };
  });

  it('hands back what the account reported, named for the one deployment it is about', async () => {
    const answer = await usage();

    expect(answer.status).toBe(200);
    expect(answer.body.numbers?.requests).toBe(SOME_NUMBERS.requests);
    expect(answer.body.numbers?.rowsRead).toBe(SOME_NUMBERS.rowsRead);
    // The script name travels with the numbers so a page cannot show them beside
    // some other deployment's name. An unfiltered read would be the whole account.
    expect(answer.body.numbers?.scriptName).toBe('baseclf');
    expect(answer.body.refused).toBeUndefined();
  });

  it('answers a refusal as an answer, and names the permission it needs', async () => {
    usageAnswer = {
      kind: 'refused',
      message: 'not entitled to query this dataset',
      permission: ANALYTICS_PERMISSION,
    };

    const answer = await usage();

    // 200 on purpose. The caller did nothing wrong, and a 403 here would read as
    // the bridge rejecting the request rather than the account declining to say,
    // which sends the reader after a different problem entirely.
    expect(answer.status).toBe(200);
    expect(answer.body.refused).toBe('not entitled to query this dataset');
    // The whole point of the branch: the reader is told what to grant. The
    // permission list this CLI prints does not include it, so this is the
    // expected outcome for somebody who followed those instructions exactly.
    expect(answer.body.permission).toBe('Account · Account Analytics · Read');
    expect(answer.body.numbers).toBeUndefined();
  });

  it('never reaches the account without a key that matches', async () => {
    let asked = 0;
    const counted = createBridge({
      key: KEY,
      openExecutor: () => allOnly(env.DB),
      readDocument: () => Promise.resolve(null),
      applyDocument: () => Promise.resolve({ outcome: 'ok' as const, lines: [] }),
      readUsage: () => {
        asked += 1;
        return Promise.resolve(usageAnswer);
      },
      log: () => {},
    });

    const refused = await counted(get('/usage', '', 'not-the-key'));

    expect(refused.status).toBe(401);
    // The credential is what this route spends, so the gate has to come first.
    expect(asked).toBe(0);
  });
});
