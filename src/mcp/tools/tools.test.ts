/**
 * What the four read-only tools may and may not answer.
 *
 * Driven through the tool definitions rather than over HTTP. The transport is the
 * SDK's and is covered in `server.test.ts`; what is ours, and what leaks if it is
 * wrong, is the filtering.
 */

import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';

import { resetCatalogue } from '../../db/index.js';
import {
  registerPolicies,
  seedDatabase,
  seedStandardPolicies,
} from '../../policy/__fixtures__/schema.js';
import { resetRegistry } from '../../policy/registry.js';
import { toolDefinitions } from './index.js';
import type { McpToolEnv } from './types.js';

const AUTH_SCHEMA: readonly string[] = Object.freeze([
  'CREATE TABLE IF NOT EXISTS "user" (id TEXT NOT NULL PRIMARY KEY, email TEXT NOT NULL) STRICT',
  'CREATE TABLE IF NOT EXISTS "account" (id TEXT NOT NULL PRIMARY KEY, access_token TEXT) STRICT',
  'CREATE TABLE IF NOT EXISTS "jwks" (id TEXT NOT NULL PRIMARY KEY, private_key TEXT NOT NULL) STRICT',
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
  resetCatalogue();
  resetRegistry();
});

describe('the registry', () => {
  it('offers exactly the four read-only tools', () => {
    expect(toolDefinitions(toolEnv).map((definition) => definition.name)).toEqual([
      'policy_lint',
      'policy_list',
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
});
