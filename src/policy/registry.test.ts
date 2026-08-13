/**
 * Loading and looking up policies.
 *
 * The refusals themselves are exercised end to end in security.test.ts. What is
 * here is the behaviour around them: which policies a request is matched
 * against, what happens to a document that cannot be validated, and the cache.
 */

import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetCatalogue } from '../db/introspect.js';
import type { BaseclfError } from '../utils/errors.js';
import { registerPolicies, seedDatabase, seedStandardPolicies } from './__fixtures__/schema.js';
import { getRegistry, loadRegistry, resetRegistry } from './registry.js';

beforeAll(async () => {
  await seedDatabase(env.DB);
});

beforeEach(async () => {
  await seedStandardPolicies(env.DB);
  resetCatalogue();
  resetRegistry();
});

describe('which policies a request is matched against', () => {
  it('takes every policy for the role and operation', async () => {
    const registry = await getRegistry(env.DB);
    const match = registry.resolve('posts', 'select', 'authenticated', ['id']);

    expect(match.policies.map((policy) => policy.name).sort()).toEqual([
      'read_as_org_admin',
      'read_own',
      'read_published',
    ]);
  });

  it('leaves out the ones that grant a different role', async () => {
    const registry = await getRegistry(env.DB);
    const match = registry.resolve('posts', 'select', 'anon', ['id']);

    expect(match.policies.map((policy) => policy.name)).toEqual(['read_published']);
  });

  it('leaves out the ones that do not grant a requested column', async () => {
    // This is what stops a row matched by a narrow policy from being returned
    // carrying a wide policy's column. read_published never grants org_id, so
    // it takes no part in a request that reads org_id.
    const registry = await getRegistry(env.DB);
    const match = registry.resolve('posts', 'select', 'authenticated', ['id', 'org_id']);

    expect(match.policies.map((policy) => policy.name).sort()).toEqual([
      'read_as_org_admin',
      'read_own',
    ]);
  });

  it('refuses when no policy grants everything asked for', async () => {
    const registry = await getRegistry(env.DB);

    let code = 'NO_THROW';
    try {
      registry.resolve('posts', 'select', 'anon', ['id', 'org_id']);
    } catch (error) {
      code = (error as BaseclfError).code;
    }
    expect(code).toBe('NO_POLICY');
  });
});

describe('asking for whatever is available', () => {
  it('answers with the columns every matching policy grants', async () => {
    const registry = await getRegistry(env.DB);
    const match = registry.resolve('posts', 'select', 'authenticated', null);

    // The six read_published grants, not the seven the other two do.
    expect([...match.columns].sort()).toEqual([
      'author_id',
      'body',
      'created_at',
      'id',
      'status',
      'title',
    ]);
  });

  it('refuses when the policies share no column at all', async () => {
    // Nothing could be returned for every row they match, so there is no honest
    // answer to give.
    await registerPolicies(env.DB, {
      table: 'posts',
      policies: [
        {
          name: 'a',
          operation: 'select',
          roles: ['anon'],
          using: { status: { _eq: 'published' } },
          columns: ['id'],
        },
        {
          name: 'b',
          operation: 'select',
          roles: ['anon'],
          using: { status: { _eq: 'draft' } },
          columns: ['title'],
        },
      ],
    });
    resetRegistry();

    const registry = await getRegistry(env.DB);
    let code = 'NO_THROW';
    try {
      registry.resolve('posts', 'select', 'anon', null);
    } catch (error) {
      code = (error as BaseclfError).code;
    }
    expect(code).toBe('NO_POLICY');
  });
});

describe('documents that cannot be used', () => {
  it('does not let a disabled table break the rest of the registry', async () => {
    // A switched-off table may well reference columns a later migration
    // removed. Validating it would turn that into an outage for every other
    // table, so it is stored unvalidated and refused at lookup.
    await registerPolicies(env.DB, {
      table: 'secrets',
      enabled: false,
      policies: [
        {
          name: 'stale',
          operation: 'select',
          roles: ['anon'],
          using: { column_that_no_longer_exists: { _eq: 'x' } },
          columns: ['id'],
        },
      ],
    });
    resetRegistry();

    const registry = await getRegistry(env.DB);
    expect(() => registry.resolve('posts', 'select', 'anon', ['id'])).not.toThrow();
    expect(() => registry.resolve('secrets', 'select', 'anon', ['id'])).toThrow();
  });

  it('drops an engine table rather than failing the whole load', async () => {
    await registerPolicies(env.DB, {
      table: '_exposed_tables',
      policies: [
        {
          name: 'oops',
          operation: 'select',
          roles: ['anon'],
          using: true,
          columns: ['table_name'],
        },
      ],
    });
    resetRegistry();

    const registry = await getRegistry(env.DB);
    expect(registry.definitions.has('_exposed_tables')).toBe(false);
    expect(() => registry.resolve('posts', 'select', 'anon', ['id'])).not.toThrow();
  });

  it('drops an enabled document that fails validation, and keeps the rest of the registry', async () => {
    // 🔴 This asserted the opposite until 2026-08-14, because until then the
    // behaviour was the opposite: one enabled document that failed validation
    // threw, nothing caught it, and `/rest/v1/*` failed for every table on the
    // deployment. Measured, then decided, then changed. The test was left
    // failing on purpose so that whoever made the change had to read the note.
    await registerPolicies(env.DB, {
      table: 'secrets',
      policies: [
        {
          name: 'reaches_into_the_engine',
          operation: 'select',
          roles: ['anon'],
          using: {
            _exists: { _table: '_exposed_tables', _where: { table_name: { _eq: 'posts' } } },
          },
          columns: ['id'],
        },
      ],
    });
    resetRegistry();

    const registry = await getRegistry(env.DB);

    // The bad table is gone, not repaired. Fail-closed: no definition means the
    // same refusal a table nobody ever exposed would get.
    expect(registry.definitions.has('secrets')).toBe(false);
    expect(() => registry.resolve('secrets', 'select', 'anon', ['id'])).toThrow();

    // ⭐ The point of the change, and the assertion that would have failed before
    // it: a table with a document that validates is unaffected by one that does not.
    expect(() => registry.resolve('posts', 'select', 'anon', ['id'])).not.toThrow();
  });

  it('says out loud which table it dropped and why', async () => {
    // Dropping quietly would turn a misconfiguration into a table that is simply
    // gone, with nothing anywhere saying so. The operator gets the full reason,
    // which is the same split invariant I9 draws: detail to the log, not to the
    // caller. Asserted rather than assumed, because a log nobody checks is a
    // comment that happens to compile.
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });

    try {
      await registerPolicies(env.DB, {
        table: 'secrets',
        policies: [
          {
            name: 'typo',
            operation: 'select',
            roles: ['anon'],
            using: { no_such_column: { _eq: 'x' } },
            columns: ['id'],
          },
        ],
      });
      resetRegistry();
      await getRegistry(env.DB);
    } finally {
      spy.mockRestore();
    }

    const dropped = lines.find((line) => line.includes('was dropped from the registry'));
    expect(dropped).toBeDefined();
    expect(dropped).toContain('secrets');
    expect(dropped).toContain('no_such_column');
  });

  it('drops a table whose stored JSON is malformed, and keeps the rest', async () => {
    // The third path to the same outage, and the one nobody had named. Decoding
    // used to happen while grouping the rows, which put it in front of the
    // per-table isolation rather than inside it, so a single corrupt column took
    // every table down with it.
    await registerPolicies(env.DB, {
      table: 'secrets',
      policies: [
        { name: 'fine', operation: 'select', roles: ['anon'], using: true, columns: ['id'] },
      ],
    });
    await env.DB.prepare('UPDATE _policies SET using_expr = ? WHERE table_name = ?')
      .bind('{not valid json', 'secrets')
      .run();
    resetRegistry();

    const registry = await getRegistry(env.DB);

    expect(registry.definitions.has('secrets')).toBe(false);
    expect(() => registry.resolve('posts', 'select', 'anon', ['id'])).not.toThrow();
  });
});

describe('the cache', () => {
  it('is memoised within an isolate', async () => {
    const first = await getRegistry(env.DB);
    const second = await getRegistry(env.DB);
    expect(first).toBe(second);
  });

  it('re-reads after a reset, which is what a policy change must trigger', async () => {
    const before = await getRegistry(env.DB);
    resetRegistry();
    const after = await getRegistry(env.DB);

    expect(after).not.toBe(before);
    expect(() => after.resolve('posts', 'select', 'anon', ['id'])).not.toThrow();
  });

  it('can be loaded without touching the cache at all', async () => {
    const direct = await loadRegistry(env.DB);
    expect(direct.definitions.has('posts')).toBe(true);
  });
});
