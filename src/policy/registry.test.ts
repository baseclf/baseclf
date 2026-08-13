/**
 * Loading and looking up policies.
 *
 * The refusals themselves are exercised end to end in security.test.ts. What is
 * here is the behaviour around them: which policies a request is matched
 * against, what happens to a document that cannot be validated, and the cache.
 */

import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

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

  it('fails closed when an enabled document reaches into an engine table, at the cost of the whole registry', async () => {
    // 🔴 Measured on 2026-08-13, and it is the one path where this file's own rule
    // is not applied. The two cases above are handled precisely so that one bad
    // document cannot take the rest down: a reserved table is dropped and logged,
    // a disabled one is stored unvalidated. An *enabled* document that fails
    // validation is neither, so `validateTableDefinition` throws and nothing
    // catches it, and every other table goes with it.
    //
    // What this asserts is the part that is not in question: the direction. No row
    // comes back from anywhere, so it is an availability failure and not a leak,
    // and the refusal does not name the engine table that caused it. Whether the
    // document should instead be dropped and logged, the way its two neighbours
    // are, is a decision for the owner of this file rather than for a test.
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

    // The load itself, which is what "the whole registry" means here.
    await expect(getRegistry(env.DB)).rejects.toThrow();

    // The blast radius, asserted rather than described. `posts` has a document
    // that validates and is still unreachable, because there is no registry left
    // to ask. The two tests above assert the opposite for their own cases, so this
    // is the line that separates a dropped document from a fatal one.
    await expect(
      getRegistry(env.DB).then((registry) => registry.resolve('posts', 'select', 'anon', ['id'])),
    ).rejects.toThrow();

    const error = await getRegistry(env.DB).catch((caught: BaseclfError) => caught);

    // ⚠️ `parse` and `validate` raise the same message and the same code, so the
    // message cannot say which layer refused. `detail` can, and asserting it here
    // is what keeps the comment above from being a guess: this is the validation
    // pass reading the catalogue, not the parser reading the shape.
    expect((error as BaseclfError).detail).toContain('belongs to the engine');

    // The same split invariant I9 draws, on this path too: the operator reading
    // the log sees the table, the caller reading the response does not.
    expect((error as BaseclfError).message).not.toContain('_exposed_tables');
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
