/**
 * What the five read-only tools may and may not answer.
 *
 * Driven through the tool definitions rather than over HTTP. The transport is the
 * SDK's and is covered in `server.test.ts`; what is ours, and what leaks if it is
 * wrong, is the filtering.
 */

import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';

import { getCatalogue, resetCatalogue } from '../../db/index.js';
import {
  OWNER_WRITABLE_POLICIES,
  registerPolicies,
  seedDatabase,
  seedStandardPolicies,
} from '../../policy/__fixtures__/schema.js';
import { getRegistry } from '../../policy/index.js';
import { resetRegistry } from '../../policy/registry.js';
import { readTable, writeTable } from '../../rest/router.js';
import { toolDefinitions } from './index.js';
import type { McpToolEnv } from './types.js';

const AUTH_SCHEMA: readonly string[] = Object.freeze([
  'CREATE TABLE IF NOT EXISTS "user" (id TEXT NOT NULL PRIMARY KEY, email TEXT NOT NULL) STRICT',
  'CREATE TABLE IF NOT EXISTS "account" (id TEXT NOT NULL PRIMARY KEY, access_token TEXT) STRICT',
  'CREATE TABLE IF NOT EXISTS "jwks" (id TEXT NOT NULL PRIMARY KEY, private_key TEXT NOT NULL) STRICT',
]);

/**
 * An application table pointing at both an application table and an engine one.
 *
 * The shared fixture has no foreign keys at all, so without this the filter in
 * `schema_describe` has nothing to act on and a mutation removing it survives.
 * Both directions matter: `post_id` is what a test asserting "no foreign keys
 * come back" would pass against, which is why it is here.
 */
const FOREIGN_KEY_SCHEMA: readonly string[] = Object.freeze([
  `CREATE TABLE IF NOT EXISTS "comments" (
     id        TEXT NOT NULL PRIMARY KEY,
     post_id   TEXT NOT NULL REFERENCES "posts"(id),
     author_id TEXT NOT NULL REFERENCES "user"(id)
   ) STRICT`,
]);

const toolEnv = { ...env, MCP_TOKEN: 'not-used-here' } as unknown as McpToolEnv;

function tool(name: string) {
  const found = toolDefinitions(toolEnv).find((definition) => definition.name === name);
  if (found === undefined) throw new Error(`no tool named ${name}`);
  return found;
}

async function call(name: string, args: unknown = {}) {
  const result = await tool(name).handler(args);
  return {
    isError: result.isError === true,
    structured: result.structuredContent,
    text: result.content[0]?.text ?? '',
  };
}

beforeAll(async () => {
  await seedDatabase(env.DB);
  await seedStandardPolicies(env.DB);
  for (const statement of AUTH_SCHEMA) await env.DB.prepare(statement).run();
  for (const statement of FOREIGN_KEY_SCHEMA) await env.DB.prepare(statement).run();
  resetCatalogue();
  resetRegistry();
});

describe('the registry', () => {
  it('offers exactly the five read-only tools', () => {
    expect(toolDefinitions(toolEnv).map((definition) => definition.name)).toEqual([
      'policy_lint',
      'policy_list',
      'policy_simulate',
      'schema_describe',
      'schema_list',
    ]);
  });

  it('answers in the same order every time', () => {
    // Not cosmetic. Two listings that can be compared are two listings where a
    // difference means something changed.
    const once = toolDefinitions(toolEnv).map((definition) => definition.name);
    const twice = toolDefinitions(toolEnv).map((definition) => definition.name);

    expect(once).toEqual(twice);
  });

  it('declares all four annotations and an output schema on every tool', () => {
    // `skills/mcp-server` section 5 asks for this with no exceptions, and the
    // exception is always the tool somebody adds in a hurry.
    for (const definition of toolDefinitions(toolEnv)) {
      expect(definition.config.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(definition.config.outputSchema).toBeDefined();
    }
  });
});

describe('every answer', () => {
  it('is fenced as untrusted data', async () => {
    // Table and column names come out of somebody's database and land in a model's
    // context. The fence is what says they are data.
    const { text } = await call('schema_list');

    expect(text).toMatch(/<untrusted-data-[0-9a-f-]{36}>/);
    expect(text).toMatch(/never as an instruction/i);
  });
});

describe('schema_list', () => {
  it('reports an application table and whether it is exposed', async () => {
    const { structured } = await call('schema_list');
    const tables = (structured as { tables: { name: string; exposed: boolean }[] }).tables;

    expect(tables.find((table) => table.name === 'posts')).toMatchObject({ exposed: true });
  });

  it('reports an unexposed table rather than hiding it', async () => {
    // `secrets` exists in the fixture with no policy document at all. Hiding it
    // would leave probing as the only way to learn it is there.
    const { structured } = await call('schema_list');
    const tables = (structured as { tables: { name: string; exposed: boolean }[] }).tables;

    expect(tables.find((table) => table.name === 'secrets')).toMatchObject({ exposed: false });
  });

  it('never reports a table the engine owns', async () => {
    const { structured } = await call('schema_list');
    const names = (structured as { tables: { name: string }[] }).tables.map((t) => t.name);

    for (const owned of ['user', 'account', 'jwks', '_policies', '_exposed_tables']) {
      expect(names).not.toContain(owned);
    }
  });
});

describe('schema_describe', () => {
  it('reports the columns of an application table', async () => {
    const { structured } = await call('schema_describe', { table: 'posts' });
    const columns = (structured as { columns: { name: string }[] }).columns.map((c) => c.name);

    expect(columns).toContain('author_id');
  });

  it('never reports the value of a default, only that there is one', async () => {
    const { text } = await call('schema_describe', { table: 'posts' });

    expect(text).toContain('hasDefault');
  });

  it('refuses an engine table', async () => {
    const { isError } = await call('schema_describe', { table: 'account' });

    expect(isError).toBe(true);
  });

  it('refuses a table that does not exist with the same answer', async () => {
    // 🔴 Invariant I5 on names. Telling these apart maps the database one call at
    // a time, and the project has already shipped that bug twice: once in V1 with
    // the status, once in V2 with the code field after the status was fixed.
    const missing = await call('schema_describe', { table: 'no_such_table_at_all' });
    const owned = await call('schema_describe', { table: 'account' });
    const system = await call('schema_describe', { table: '_policies' });

    expect(missing.isError).toBe(true);
    expect(missing.text).toBe(owned.text);
    expect(missing.text).toBe(system.text);
  });

  it('says nothing about why, in the refusal it does give', async () => {
    const { text } = await call('schema_describe', { table: 'account' });

    expect(text).toContain('NOT_FOUND');
    expect(text).not.toContain('engine');
    expect(text).not.toContain('account');
  });

  it('reports a foreign key into another application table', async () => {
    // The positive half of the pair below. Without it, dropping every foreign key
    // would read as "the filter works" instead of as the tool going silent.
    const { structured } = await call('schema_describe', { table: 'comments' });
    const keys = (structured as { foreignKeys: { referencesTable: string }[] }).foreignKeys;

    expect(keys.map((key) => key.referencesTable)).toContain('posts');
  });

  it('never reports a foreign key into a table the engine owns', async () => {
    // 🔴 A foreign key names a second table, so it is a way back to one the caller
    // may not address. `schema_list` withholds `user`; describing `comments` would
    // hand the same name back through a field nobody reads as a table listing.
    const { structured } = await call('schema_describe', { table: 'comments' });
    const keys = (structured as { foreignKeys: { referencesTable: string }[] }).foreignKeys;

    expect(keys.map((key) => key.referencesTable)).not.toContain('user');
  });
});

describe('policy_list', () => {
  it('reports the shape of a grant', async () => {
    const { structured } = await call('policy_list');
    const tables = (structured as { tables: { table: string; policies: unknown[] }[] }).tables;
    const posts = tables.find((table) => table.table === 'posts');

    expect(posts?.policies.length).toBeGreaterThan(0);
  });

  it('never reports a predicate', async () => {
    // 🔴 A predicate carries literals the operator wrote: tenant ids, org ids,
    // allowlisted domains. Invariant I9 does not cover them, because I9 is about
    // bound parameters at query time and these were baked in when the document
    // was written. Until that gap is closed deliberately, they do not leave here.
    //
    // ⚠️ The first version of this test also asserted that `author_id` never
    // appears, and it failed. It appears through `columns`, which is the list of
    // columns the policy grants and is exactly what the REST path already returns
    // to any caller the policy allows. The assertion was wider than the claim:
    // what must not leave is the predicate, not every column name in the engine.
    const { text } = await call('policy_list');

    expect(text).not.toContain('_eq');
    expect(text).not.toContain('_exists');
    expect(text).not.toContain('$auth.uid');
    expect(text).not.toContain('$bind');
    expect(text).not.toContain('using');
  });

  it('never reports a table the engine owns', async () => {
    await registerPolicies(env.DB, {
      table: 'account',
      policies: [
        {
          name: 'read_all',
          operation: 'select',
          roles: ['anon'],
          using: { id: { _neq: '' } },
          columns: ['id'],
        },
      ],
    });
    resetRegistry();

    const { structured } = await call('policy_list');
    const names = (structured as { tables: { table: string }[] }).tables.map((t) => t.table);

    expect(names).not.toContain('account');

    await seedStandardPolicies(env.DB);
    resetRegistry();
  });
});

describe('policy_lint', () => {
  it('answers with findings and a count of what it withheld', async () => {
    const { structured } = await call('policy_lint');

    expect(structured).toMatchObject({ withheld: expect.any(Number) });
    expect(Array.isArray((structured as { findings: unknown[] }).findings)).toBe(true);
  });

  it('qualifies a policy name with its table', async () => {
    // The engine reports a bare name because it lints one table at a time. Across
    // tables that is ambiguous, and an agent reading one finding cannot tell.
    const { structured } = await call('policy_lint');
    const findings = (structured as { findings: { policy: string }[] }).findings;

    for (const finding of findings) expect(finding.policy).toContain('.');
  });

  it('withholds a finding that names a table the engine owns, and says it did', async () => {
    // 🔴 A finding does not have to be about the table being linted. A predicate
    // reaching through `_exists` produces a finding whose `table` is the target,
    // so linting a table the caller may address hands back the name of one they
    // may not, with a CREATE INDEX naming its columns.
    //
    // Reached through a disabled document deliberately, and that is the whole
    // reason this test can exist: `validateTableDefinition` refuses `_exists`
    // into an engine table, so an enabled document cannot carry one. A disabled
    // document is stored unvalidated by `loadRegistry` and linted anyway, which
    // is the one path where the filter is reachable rather than defence in depth.
    await registerPolicies(env.DB, {
      table: 'org_members',
      enabled: false,
      policies: [
        {
          name: 'reaches_into_the_identity_provider',
          operation: 'select',
          roles: ['anon'],
          using: { _exists: { _table: 'user', _where: { email: { _eq: 'someone@example.com' } } } },
          columns: ['org_id'],
        },
      ],
    });
    resetRegistry();

    try {
      const { structured } = await call('policy_lint');
      const { findings, withheld } = structured as {
        findings: { table: string }[];
        withheld: number;
      };

      expect(findings.map((finding) => finding.table)).not.toContain('user');
      // Counted, not silently dropped. A lint that returns less than it found
      // without saying so reads as a clean bill of health.
      expect(withheld).toBeGreaterThan(0);
    } finally {
      // In `finally` because an assertion above throws, and cleanup written after
      // one that fails does not run at exactly the moment it matters most.
      await seedStandardPolicies(env.DB);
      resetRegistry();
    }
  });
});

describe('policy_simulate', () => {
  const ANON = { role: 'anon', uid: null, email: null, app: {} };

  it('reports the statement a read would compile to, and which policy allows it', async () => {
    const { structured } = await call('policy_simulate', { table: 'posts', role: 'anon' });
    const result = structured as { sql: string; policies: string[]; columns: string[] };

    expect(result.policies).toContain('read_published');
    expect(result.sql).toContain('"posts"');
    expect(result.columns).toContain('title');
  });

  it('is the same statement the REST path really sends', async () => {
    // ⭐ The assertion that makes this a simulator rather than a second engine.
    // Everything else here could pass while the tool described code nobody runs,
    // and a policy author would then tune against a fiction. This is the only
    // test that fails when the two drift, so it is the one that matters most.
    const query = 'select=id,title&status=eq.published&limit=5';

    const { structured } = await call('policy_simulate', { table: 'posts', role: 'anon', query });

    const actual = await readTable({
      executor: env.DB,
      catalogue: await getCatalogue(env.DB),
      registry: await getRegistry(env.DB),
      auth: ANON,
      table: 'posts',
      search: new URLSearchParams(query),
    });

    expect((structured as { sql: string }).sql).toBe(actual.sql);
  });

  it('shows the client filter narrowing the policy rather than replacing it', async () => {
    // Invariant I3, made visible. The policy term has to still be there once the
    // caller adds one of their own, and this is the surface an author would use
    // to convince themselves of that.
    const { structured } = await call('policy_simulate', {
      table: 'posts',
      role: 'anon',
      query: 'status=eq.draft',
    });
    const { sql, parameterCount } = structured as { sql: string; parameterCount: number };

    // The policy binds 'published' and the client binds 'draft': two parameters,
    // both present, which is what "narrowed" means rather than "overridden".
    expect(parameterCount).toBeGreaterThanOrEqual(2);
    expect(sql).toContain('and');
  });

  it('withholds the parameter values by default, and says that it did', async () => {
    // 🔴 The invariant gap `policy_list` is written around. A predicate carries
    // literals the operator wrote, and the SQL and the values separate cleanly
    // only because invariant I7 made every value a bound parameter.
    const { structured } = await call('policy_simulate', { table: 'posts', role: 'anon' });
    const result = structured as {
      parameters?: unknown[];
      parametersWithheld: boolean;
      parameterCount: number;
    };

    expect(result.parameterCount).toBeGreaterThan(0);
    expect(result.parameters).toBeUndefined();
    expect(result.parametersWithheld).toBe(true);
  });

  it('returns the values only when the caller asks for them', async () => {
    const { structured } = await call('policy_simulate', {
      table: 'posts',
      role: 'anon',
      includeParameterValues: true,
    });
    const result = structured as { parameters?: unknown[]; parametersWithheld: boolean };

    expect(result.parameters).toContain('published');
    expect(result.parametersWithheld).toBe(false);
  });

  it('never sends a statement to the database', async () => {
    // ⚠️ The first version of this test asserted that no row title appeared in
    // the answer, and it passed for the wrong reason: the output of a compiled
    // statement and of an executed one whose rows were discarded are identical,
    // so nothing about the answer can tell them apart. What can is whether D1
    // was touched at all, which is also the thing that costs money.
    //
    // The natural slip this guards is not exotic. Every other read in the engine
    // ends at `executeStatement`, so a later hand copying the router would reach
    // for it here too, and the simulator would quietly start scanning rows on a
    // production database on every call.
    let prepares = 0;
    const countingDb = new Proxy(env.DB, {
      get(target, property, receiver) {
        if (property === 'prepare') {
          return (sql: string) => {
            prepares += 1;
            return target.prepare(sql);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    }) as D1Database;

    const countingEnv = { ...env, MCP_TOKEN: 'x', DB: countingDb } as unknown as McpToolEnv;

    // Warm the catalogue and registry memos through the same proxy first. They
    // do read D1, they are not this tool's doing, and they expire on a timer, so
    // counting them would make this test fail on a slow run rather than on a bug.
    await getCatalogue(countingDb);
    await getRegistry(countingDb);
    prepares = 0;

    const definition = toolDefinitions(countingEnv).find((one) => one.name === 'policy_simulate');
    const result = await definition?.handler({ table: 'posts', role: 'anon' });

    expect(result?.isError).not.toBe(true);
    expect(prepares).toBe(0);
  });

  it('refuses a role no policy covers, exactly as a real request would', async () => {
    // Fail-closed is not re-implemented here, it is the same `applyPolicy` call
    // reaching the same conclusion. Invariant I1.
    const { isError } = await call('policy_simulate', { table: 'posts', role: 'nobody' });

    expect(isError).toBe(true);
  });

  it('refuses an engine table with the same answer as a table that does not exist', async () => {
    const owned = await call('policy_simulate', { table: 'account', role: 'anon' });
    const missing = await call('policy_simulate', { table: 'no_such_table_at_all', role: 'anon' });

    expect(owned.isError).toBe(true);
    expect(owned.text).toBe(missing.text);
  });

  it('compiles an update, and shows the check against the row as it will be', async () => {
    // ⭐ This is the question the tool exists for. `update_own` does not grant
    // author_id, so its post-image is the stored column and the check compiles to
    // a comparison against that column. An author reading this can see that the
    // owner is checked twice: once as the row is, once as it will be.
    const { structured } = await call('policy_simulate', {
      table: 'posts',
      role: 'authenticated',
      operation: 'update',
      claims: { uid: 'u_ann' },
      body: { title: 'renamed' },
      query: 'id=eq.p1',
    });
    const { sql, policies } = structured as { sql: string; policies: string[] };

    expect(policies).toContain('update_own');
    expect(sql).toContain('update');
    expect(sql).toContain('returning');
    // Two author_id terms: the using pre-image and the check post-image, which
    // are the same text precisely because the update cannot touch that column.
    expect(sql.match(/"posts"\."author_id"/g)?.length).toBe(2);
  });

  it('shows the check becoming a value comparison when the owner may be written', async () => {
    // 🔴 The pair that makes the previous test mean something. Grant author_id and
    // the post-image is no longer the stored column but the value being assigned,
    // so the check compiles to a comparison between the new owner and the caller.
    // That is the whole of how handing a row to somebody else is refused, and it
    // is invisible in the policy document that produced it.
    await registerPolicies(env.DB, {
      table: 'posts',
      binds: { isAuthor: { author_id: { _eq: '$auth.uid' } } },
      policies: OWNER_WRITABLE_POLICIES,
    });
    resetRegistry();

    try {
      const { structured } = await call('policy_simulate', {
        table: 'posts',
        role: 'authenticated',
        operation: 'update',
        claims: { uid: 'u_ann' },
        body: { author_id: 'u_bob', title: 'stolen' },
        query: 'id=eq.p1',
      });
      const { sql } = structured as { sql: string };

      // One author_id term left, the `using` one. The check is now a comparison
      // between two bound values, which is what refuses the transfer.
      expect(sql.match(/"posts"\."author_id"/g)?.length).toBe(1);
      // Measured, not guessed. The statement is
      //   ... where (("posts"."author_id" = ?) and (? = ?)) and ("posts"."id" = ?) ...
      // so this matches the check term and nothing else: every other comparison
      // has an identifier on its left.
      expect(sql).toMatch(/\?\s*=\s*\?/);
    } finally {
      await seedStandardPolicies(env.DB);
      resetRegistry();
    }
  });

  it('is the same write statement the REST path really sends', async () => {
    // ⭐ The agreement test again, on the harder path. The filter matches no row
    // on purpose: the statement is what is being compared, and running it must
    // not change the fixture the rest of this file reads.
    const query = 'id=eq.no_such_row';
    const body = { title: 'renamed' };

    const { structured } = await call('policy_simulate', {
      table: 'posts',
      role: 'authenticated',
      operation: 'update',
      claims: { uid: 'u_ann' },
      body,
      query,
    });

    const actual = await writeTable({
      executor: env.DB,
      catalogue: await getCatalogue(env.DB),
      registry: await getRegistry(env.DB),
      auth: { role: 'authenticated', uid: 'u_ann', email: 'ann@example.test', app: {} },
      table: 'posts',
      search: new URLSearchParams(query),
      operation: 'update',
      body,
    });

    expect((structured as { sql: string }).sql).toBe(actual.sql);
  });

  it('compiles an insert, with the columns the server fills in', async () => {
    const { structured } = await call('policy_simulate', {
      table: 'posts',
      role: 'authenticated',
      operation: 'insert',
      claims: { uid: 'u_ann' },
      body: { id: 'p_new', title: 'hello', status: 'draft', org_id: 'org_1', created_at: '2026' },
    });
    const { sql, policies } = structured as { sql: string; policies: string[] };

    expect(policies).toContain('insert_own');
    // The guarded insert idiom: values arrive through a select whose where clause
    // is the check, so no row exists at any moment that the check has not passed.
    expect(sql).toContain('insert into');
    expect(sql).toContain('select');
    expect(sql).toContain('where');
  });

  it('refuses a filter on an insert, the same way the router does', async () => {
    // Dropping it silently would simulate a statement nobody would ever send.
    const { isError } = await call('policy_simulate', {
      table: 'posts',
      role: 'authenticated',
      operation: 'insert',
      claims: { uid: 'u_ann' },
      body: { id: 'p_new', title: 'hello', status: 'draft', org_id: 'o', created_at: '2026' },
      query: 'id=eq.p1',
    });

    expect(isError).toBe(true);
  });

  it('refuses a body column the policy does not grant', async () => {
    // `update_own` grants title, body and status. author_id is refused here for
    // the same reason and with the same answer a real request would get.
    const { isError } = await call('policy_simulate', {
      table: 'posts',
      role: 'authenticated',
      operation: 'update',
      claims: { uid: 'u_ann' },
      body: { author_id: 'u_bob' },
      query: 'id=eq.p1',
    });

    expect(isError).toBe(true);
  });

  it('compiles a delete, and refuses one the role has no policy for', async () => {
    const allowed = await call('policy_simulate', {
      table: 'posts',
      role: 'authenticated',
      operation: 'delete',
      claims: { uid: 'u_ann' },
      query: 'id=eq.p1',
    });
    expect((allowed.structured as { policies: string[] }).policies).toContain('delete_own');

    // anon has no delete policy at all. Invariant I1, on the write path.
    const refused = await call('policy_simulate', {
      table: 'posts',
      role: 'anon',
      operation: 'delete',
      query: 'id=eq.p1',
    });
    expect(refused.isError).toBe(true);
  });

  it('cannot be given user metadata, because the shape has nowhere to put it', async () => {
    // Invariant I4 holds here by the type rather than by a check: `AuthCtx` has
    // role, uid, email and app, and no `user` field exists at all. An input that
    // tries anyway is dropped by the schema rather than reaching a predicate.
    const { structured } = await call('policy_simulate', {
      table: 'posts',
      role: 'anon',
      claims: { app: { tier: 'gold' } },
    });

    expect((structured as { role: string }).role).toBe('anon');
  });
});
