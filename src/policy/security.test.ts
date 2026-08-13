/**
 * The seven tests rule 00 requires, plus the reasons they exist.
 *
 * None of these may be skipped, marked `.only`, or deleted. A failure here
 * means the engine is wrong, not that the test is stale (rules/03 section G).
 *
 * They run end to end, through the same `readTable` the HTTP handler calls,
 * against a real D1 binding inside workerd. Testing the pieces in isolation is
 * useful and happens elsewhere; a policy engine that is correct in pieces and
 * wrong when assembled still leaks.
 */

import { env } from 'cloudflare:workers';
import { DeleteQueryNode, InsertQueryNode, TableNode, UpdateQueryNode } from 'kysely';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getCatalogue, resetCatalogue } from '../db/introspect.js';
import worker from '../index.js';
import { readTable } from '../rest/router.js';
import { BaseclfError } from '../utils/errors.js';
import {
  POST_BINDS,
  POST_POLICIES,
  registerPolicies,
  seedDatabase,
  seedStandardPolicies,
} from './__fixtures__/schema.js';
import { parseTableDefinition } from './parse.js';
import { createPolicyPlugin } from './plugin.js';
import { getRegistry, resetRegistry } from './registry.js';
import type { AuthCtx } from './types.js';
import { validateTableDefinition } from './validate.js';

const ANON: AuthCtx = Object.freeze({ role: 'anon', uid: null, email: null, app: {} });

function asUser(uid: string): AuthCtx {
  return Object.freeze({ role: 'authenticated', uid, email: `${uid}@example.test`, app: {} });
}

interface PostRow {
  id: string;
  title?: string;
  status?: string;
}

async function read(auth: AuthCtx, table: string, query = '') {
  const [catalogue, registry] = await Promise.all([getCatalogue(env.DB), getRegistry(env.DB)]);
  return readTable<PostRow>({
    executor: env.DB,
    catalogue,
    registry,
    auth,
    table,
    search: new URLSearchParams(query),
  });
}

async function refresh(): Promise<void> {
  resetCatalogue();
  resetRegistry();
}

/**
 * The outermost select list only.
 *
 * A policy's EXISTS carries its own `select *`, which is invisible to the
 * caller and reads nothing. Assertions about what a client can see have to look
 * at the columns the outer query returns, not at every star in the statement.
 */
function outerSelectList(sql: string): string {
  const start = 'select '.length;
  const end = sql.indexOf(' from "');
  return sql.slice(start, end);
}

/**
 * Run a stored document through the two passes `loadRegistry` runs on it, and
 * return whatever they raise.
 *
 * ⚠️ Asserted directly rather than through a read, and the reason is the whole
 * shape of tests 4 and 5. Rule 00 requires these documents to be refused at
 * validation time. Since 2026-08-14 `loadRegistry` catches that refusal and
 * drops the one table rather than failing every table on the deployment, so the
 * code a reader sees is now the generic not-found rather than the diagnostic one.
 * The guarantee did not move; its blast radius did. Reading only through the
 * request path would leave the requirement Rule 00 actually names unasserted,
 * which is how a test ends up passing for a reason unrelated to its name.
 */
async function refusalFor(document: {
  table: string;
  enabled: boolean;
  version: number;
  binds: Record<string, unknown>;
  policies: unknown[];
}): Promise<BaseclfError> {
  const catalogue = await getCatalogue(env.DB);
  try {
    validateTableDefinition(catalogue, parseTableDefinition(document));
  } catch (caught) {
    return caught as BaseclfError;
  }
  throw new Error('The document was accepted, and this test exists because it must not be.');
}

beforeAll(async () => {
  await seedDatabase(env.DB);
});

// Every test starts from the same policy state, whatever the one before it did
// or how far through it got.
beforeEach(async () => {
  await seedStandardPolicies(env.DB);
  await refresh();
});

describe('1. a table with no policy', () => {
  it('throws rather than returning rows', async () => {
    // The failure this project exists to prevent. An empty array here, or a
    // query built without a predicate, turns "nobody configured this table"
    // into "everybody can read it".
    await expect(read(ANON, 'secrets')).rejects.toThrow(BaseclfError);

    const error = await read(ANON, 'secrets').catch((caught: BaseclfError) => caught);
    expect(error).toBeInstanceOf(BaseclfError);
    expect((error as BaseclfError).code).toBe('TABLE_NOT_EXPOSED');
    expect((error as BaseclfError).status).toBe(404);
  });

  it('says nothing about whether the table exists', async () => {
    const real = await read(ANON, 'secrets').catch((caught: BaseclfError) => caught);
    const imaginary = await read(ANON, 'no_such_table').catch((caught: BaseclfError) => caught);

    // Rule 00 invariant I5. If these differed, an attacker could enumerate the
    // schema by watching which name produces which answer. `secrets` exists and
    // is unexposed; `no_such_table` does not exist at all.
    expect((real as BaseclfError).status).toBe(404);
    expect((imaginary as BaseclfError).status).toBe(404);
    expect((real as BaseclfError).message).toBe('Not found.');
    expect((imaginary as BaseclfError).message).toBe('Not found.');

    // The distinction survives where it belongs: in the server-side detail.
    expect((real as BaseclfError).detail).not.toBe((imaginary as BaseclfError).detail);
  });

  it('says nothing about whether a column exists either', async () => {
    // org_id is a real column that read_published does not grant. `nope` is not
    // a column at all. Both are refused the same way.
    const ungranted = await read(ANON, 'posts', 'select=id,org_id').catch(
      (caught: BaseclfError) => caught,
    );
    const imaginary = await read(ANON, 'posts', 'select=id,nope').catch(
      (caught: BaseclfError) => caught,
    );

    expect((ungranted as BaseclfError).status).toBe(404);
    expect((imaginary as BaseclfError).status).toBe(404);
    expect((ungranted as BaseclfError).message).toBe('Not found.');
    expect((imaginary as BaseclfError).message).toBe('Not found.');
  });

  it('throws for a role no policy names', async () => {
    const error = await read(
      { role: 'service_role', uid: null, email: null, app: {} },
      'posts',
    ).catch((caught: BaseclfError) => caught);

    expect((error as BaseclfError).code).toBe('NO_POLICY');
    expect((error as BaseclfError).status).toBe(404);
  });

  it('throws for a table registered but not enabled', async () => {
    await registerPolicies(env.DB, {
      table: 'posts',
      enabled: false,
      binds: POST_BINDS,
      policies: POST_POLICIES,
    });
    await refresh();

    const error = await read(ANON, 'posts').catch((caught: BaseclfError) => caught);
    expect((error as BaseclfError).code).toBe('TABLE_NOT_EXPOSED');
  });
});

describe('2. a client filter can only narrow', () => {
  it('cannot widen the policy with or', async () => {
    // The obvious attack: an anonymous caller asks for drafts as well, hoping
    // the two conditions end up beside each other rather than nested.
    const result = await read(ANON, 'posts', 'or=(status.eq.draft,status.eq.published)');

    expect(result.rows.map((row) => row.id)).toEqual(['p1']);
    expect(result.rows.every((row) => row.status === 'published')).toBe(true);
  });

  it('groups the policy and the filter so precedence cannot be exploited', async () => {
    const result = await read(ANON, 'posts', 'or=(status.eq.draft,status.eq.published)');

    // Kysely emits `and` and `or` with no parentheses of its own, so this is
    // the assertion that stops `policy and a or b` from ever being generated.
    expect(result.sql).toContain('where (');
    expect(result.sql).toMatch(/where \(.*\) and \(/);
  });

  it('narrows further when the filter asks for less', async () => {
    const result = await read(ANON, 'posts', 'status=eq.draft');
    expect(result.rows).toEqual([]);
  });

  it('still narrows when several permissive policies are combined', async () => {
    // Ann matches read_published on p1 and read_own on p1 and p2. The two are
    // OR'd, and her own filter is AND'd on top of the pair.
    const all = await read(asUser('u_ann'), 'posts');
    expect(all.rows.map((row) => row.id).sort()).toEqual(['p1', 'p2']);

    const narrowed = await read(asUser('u_ann'), 'posts', 'id=eq.p2');
    expect(narrowed.rows.map((row) => row.id)).toEqual(['p2']);
  });

  it('never lets one user see another user unpublished row', async () => {
    const ann = await read(asUser('u_ann'), 'posts');
    expect(ann.rows.map((row) => row.id)).not.toContain('p3');

    const bob = await read(asUser('u_bob'), 'posts');
    expect(bob.rows.map((row) => row.id).sort()).toEqual(['p1', 'p3']);
  });
});

describe('3. every read shape carries the policy', () => {
  it('covers select=*', async () => {
    const result = await read(ANON, 'posts', 'select=*');

    expect(result.rows.map((row) => row.id)).toEqual(['p1']);
    // Expanded, not compiled as a star. A literal star would return whatever
    // the table holds at run time, so a migration would widen the response.
    expect(outerSelectList(result.sql)).not.toContain('*');
    expect(outerSelectList(result.sql)).toContain('"posts"."status"');
  });

  it('expands a star to what every matching policy grants, and no more', async () => {
    // read_published grants six columns; read_own and read_as_org_admin grant
    // those plus org_id. A row matched only by read_published must not come
    // back carrying org_id, so the star resolves to the shared six.
    const result = await read(asUser('u_ann'), 'posts', 'select=*');

    // org_id still appears further down, correlating the EXISTS. What matters
    // is that it is not among the columns the caller gets back.
    expect(outerSelectList(result.sql)).not.toContain('org_id');
    expect(Object.keys(result.rows[0] ?? {})).not.toContain('org_id');
    expect(Object.keys(result.rows[0] ?? {}).sort()).toEqual([
      'author_id',
      'body',
      'created_at',
      'id',
      'status',
      'title',
    ]);
  });

  it('drops the policies that do not grant a column the caller asked for', async () => {
    // Asking for org_id removes read_published from the running, because it
    // never granted that column. Ann then sees only what read_own gives her.
    const result = await read(asUser('u_ann'), 'posts', 'select=id,org_id');

    expect(result.rows.map((row) => row.id).sort()).toEqual(['p1', 'p2']);
    expect(result.sql).not.toContain("'published'");
  });

  it('covers a correlated subquery inside a policy', async () => {
    // u_mod authors nothing and nothing of theirs is published, so every row
    // they see arrives through the EXISTS in read_as_org_admin.
    const result = await read(asUser('u_mod'), 'posts', 'select=id,org_id');

    expect(result.sql).toContain('exists');
    expect(result.sql).toContain('"org_members"');
    expect(result.rows.map((row) => row.id).sort()).toEqual(['p1', 'p2', 'p3']);
    // org_2 belongs to another organisation and u_mod is not an admin there.
    expect(result.rows.map((row) => row.id)).not.toContain('p4');
  });

  it('refuses a query the policy layer cannot reason about', async () => {
    const error = await read(ANON, 'posts', 'select=author:users(name)').catch(
      (caught: BaseclfError) => caught,
    );
    expect(error).toBeInstanceOf(BaseclfError);
  });
});

describe('4. a policy that reads user metadata', () => {
  it('is refused when it is stored, not when it runs', async () => {
    // user_metadata is writable by the end user. A policy that trusted it would
    // let anyone set their own role. Rule 00 invariant I4 puts the refusal at
    // validation time so such a policy cannot exist in the database at all.
    await registerPolicies(env.DB, {
      table: 'posts',
      policies: [
        {
          name: 'escalation',
          operation: 'select',
          roles: ['anon'],
          using: { author_id: { _eq: '$auth.user.id' } },
          columns: ['id'],
        },
      ],
    });
    await refresh();

    // The guarantee Rule 00 names, asserted where Rule 00 names it.
    const refusal = await refusalFor({
      table: 'posts',
      enabled: true,
      version: 1,
      binds: {},
      policies: [
        {
          name: 'escalation',
          for: 'select',
          to: ['anon'],
          using: { author_id: { _eq: '$auth.user.id' } },
          columns: ['id'],
        },
      ],
    });
    expect(refusal.code).toBe('FORBIDDEN_CLAIM');

    // And nothing reaches a reader through it. The code here is the generic
    // not-found, which is what invariant I5 wants a caller to see: the reason is
    // in the log, where the operator is.
    await expect(read(ANON, 'posts')).rejects.toBeInstanceOf(BaseclfError);
  });

  it('is refused wherever it appears, including inside a bind', async () => {
    await registerPolicies(env.DB, {
      table: 'posts',
      binds: { sneaky: { author_id: { _eq: '$auth.user.role' } } },
      policies: [
        {
          name: 'escalation_via_bind',
          operation: 'select',
          roles: ['anon'],
          using: { $bind: 'sneaky' },
          columns: ['id'],
        },
      ],
    });
    await refresh();

    const refusal = await refusalFor({
      table: 'posts',
      enabled: true,
      version: 1,
      binds: { sneaky: { author_id: { _eq: '$auth.user.role' } } },
      policies: [
        {
          name: 'escalation_via_bind',
          for: 'select',
          to: ['anon'],
          using: { $bind: 'sneaky' },
          columns: ['id'],
        },
      ],
    });
    expect(refusal.code).toBe('FORBIDDEN_CLAIM');

    await expect(read(ANON, 'posts')).rejects.toBeInstanceOf(BaseclfError);
  });

  it('allows app_metadata, which only the server can write', async () => {
    await registerPolicies(env.DB, {
      table: 'posts',
      policies: [
        {
          name: 'by_plan',
          operation: 'select',
          roles: ['authenticated'],
          using: { status: { _eq: '$auth.app.visible_status' } },
          columns: ['id', 'status'],
        },
      ],
    });
    await refresh();

    const result = await readTable<PostRow>({
      executor: env.DB,
      catalogue: await getCatalogue(env.DB),
      registry: await getRegistry(env.DB),
      auth: {
        role: 'authenticated',
        uid: 'u_ann',
        email: null,
        app: { visible_status: 'draft' },
      },
      table: 'posts',
      search: new URLSearchParams('select=id,status'),
    });

    expect(result.rows.map((row) => row.id).sort()).toEqual(['p2', 'p3', 'p4']);
    // The claim is bound, never written into the statement.
    expect(result.sql).not.toContain('draft');
    expect(result.parameterCount).toBeGreaterThan(0);
  });
});

describe('5. a column name that does not exist', () => {
  it('is what D1 silently accepts, which is why the rest of this matters', async () => {
    // The measurement the whole identifier discipline rests on. Double quoted
    // string literals are enabled, so this returns the text rather than raising.
    const row = await env.DB.prepare(
      'SELECT "definitely_not_a_column" AS x FROM posts LIMIT 1',
    ).first<{ x: string }>();

    expect(row?.x).toBe('definitely_not_a_column');
  });

  it('is refused in a client select, with no rows returned', async () => {
    const error = await read(ANON, 'posts', 'select=id,titel').catch(
      (caught: BaseclfError) => caught,
    );

    expect(error).toBeInstanceOf(BaseclfError);
    expect((error as BaseclfError).code).toBe('UNKNOWN_IDENTIFIER');
  });

  it('is refused in a client filter', async () => {
    const error = await read(ANON, 'posts', 'titel=eq.x').catch((caught: BaseclfError) => caught);
    expect((error as BaseclfError).code).toBe('UNKNOWN_IDENTIFIER');
  });

  it('is refused in an order clause', async () => {
    const error = await read(ANON, 'posts', 'order=titel.asc').catch(
      (caught: BaseclfError) => caught,
    );
    expect((error as BaseclfError).code).toBe('UNKNOWN_IDENTIFIER');
  });

  it('is refused in a stored policy', async () => {
    await registerPolicies(env.DB, {
      table: 'posts',
      policies: [
        {
          name: 'typo',
          operation: 'select',
          roles: ['anon'],
          using: { autor_id: { _eq: '$auth.uid' } },
          columns: ['id'],
        },
      ],
    });
    await refresh();

    // 🔴 The DQS defence, asserted at the layer that provides it. D1 has double
    // quoted string literals enabled, so a mistyped column does not raise: it
    // comes back as its own name in string form and the predicate quietly stops
    // filtering. Validation against the catalogue is what turns that into a
    // refusal, and it is still what does it.
    const refusal = await refusalFor({
      table: 'posts',
      enabled: true,
      version: 1,
      binds: {},
      policies: [
        {
          name: 'typo',
          for: 'select',
          to: ['anon'],
          using: { autor_id: { _eq: '$auth.uid' } },
          columns: ['id'],
        },
      ],
    });
    expect(refusal.code).toBe('UNKNOWN_IDENTIFIER');

    // And no row is served through the typo, which is the part that matters.
    await expect(read(ANON, 'posts')).rejects.toBeInstanceOf(BaseclfError);
  });
});

describe('7. the engine tables are not reachable', () => {
  for (const table of ['_policies', '_policy_binds', '_exposed_tables']) {
    it(`refuses ${table}`, async () => {
      const error = await read(ANON, table).catch((caught: BaseclfError) => caught);
      expect(error).toBeInstanceOf(BaseclfError);
      expect((error as BaseclfError).status).toBe(404);
    });
  }

  it('refuses them even if someone registers one', async () => {
    // The second of the two independent checks rule 00 invariant I8 asks for.
    // This registers a policy document for an engine table, which the loader
    // accepts as a row, and then proves both the router and the registry still
    // refuse to serve it.
    await registerPolicies(env.DB, {
      table: '_policies',
      policies: [
        {
          name: 'oops',
          operation: 'select',
          roles: ['anon'],
          using: true,
          columns: ['name'],
        },
      ],
    });
    await refresh();

    const error = await read(ANON, '_policies').catch((caught: BaseclfError) => caught);
    expect((error as BaseclfError).status).toBe(404);

    const registry = await getRegistry(env.DB);
    expect(() => registry.resolve('_policies', 'select', 'anon', ['name'])).toThrow(BaseclfError);

    // Dropped at load time, so it is not even present as a definition.
    expect(registry.definitions.has('_policies')).toBe(false);

    // And the rest of the registry still works. One bad row must not be able to
    // take every other table down with it.
    const posts = await read(ANON, 'posts');
    expect(posts.rows.map((row) => row.id)).toEqual(['p1']);
  });

  it('does not list them in the schema view', async () => {
    const catalogue = await getCatalogue(env.DB);
    const exposed = [...catalogue.tables.values()].filter((table) => !table.isSystem);
    expect(exposed.map((table) => table.name)).not.toContain('_policies');
  });
});

describe('the read chokepoint does not serve writes', () => {
  it('refuses a write node rather than passing it through unpoliced', async () => {
    // Writes have their own builder, in policy/write.ts, because a write needs
    // a post-image check rather than a where clause. What must never happen is a
    // write slipping through the read path, which would attach a USING
    // predicate and no CHECK, and so would let a caller move a row out of their
    // own reach and keep it there.
    const [catalogue, registry] = await Promise.all([getCatalogue(env.DB), getRegistry(env.DB)]);
    const plugin = createPolicyPlugin({ registry, catalogue, auth: ANON });

    for (const node of [
      InsertQueryNode.create(TableNode.create('posts')),
      UpdateQueryNode.create([TableNode.create('posts')]),
      DeleteQueryNode.create([TableNode.create('posts')]),
    ]) {
      expect(() => plugin.transformQuery({ queryId: { queryId: 't' }, node })).toThrow(
        BaseclfError,
      );
    }
  });

  it('answers a method it does not implement with 405', async () => {
    const response = await worker.fetch(
      new Request('https://baseclf.test/rest/v1/posts', { method: 'PUT' }),
      env,
    );
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD, POST, PATCH, DELETE');
  });
});
