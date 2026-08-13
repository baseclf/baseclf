/**
 * Invariant I8 for the engine tables that do not look like engine tables.
 *
 * 🔴 Why this file exists. Measured against the live deployment on 2026-08-12,
 * with no token and no headers:
 *
 *     GET /_schema  ->  user, session, account, verification, jwks, posts
 *
 * Every check protecting invariant I8 asked whether a name started with an
 * underscore, and Better Auth does not name its tables that way. So the identity
 * provider's storage was listed on a public endpoint, and nothing prevented a
 * row in `_exposed_tables` from turning `account`, which holds provider tokens,
 * into a REST route.
 *
 * The suite was green through all of it. `index.test.ts` even had a test called
 * "never lists a system table", and it passed, because it asserted the prefix
 * rather than the invariant. That is the failure this file is written against:
 * the assertions below name the property that matters, so a future filter that
 * happens to be right about underscores and wrong about everything else fails
 * here.
 *
 * ⚠️ These tests must not be skipped, marked `.only`, or deleted. A failure is
 * the engine being wrong, not the test being stale (rules/03 section G).
 */

import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';

import worker from '../index.js';
import {
  registerPolicies,
  seedDatabase,
  seedStandardPolicies,
} from '../policy/__fixtures__/schema.js';
import { getRegistry, resetRegistry } from '../policy/registry.js';
import type { AuthCtx } from '../policy/types.js';
import { resolveTable } from '../rest/allowlist.js';
import { readTable } from '../rest/router.js';
import { BaseclfError } from '../utils/errors.js';
import { AUTH_TABLES, getCatalogue, isReservedTableName, resetCatalogue } from './introspect.js';

const ANON: AuthCtx = Object.freeze({ role: 'anon', uid: null, email: null, app: {} });

/**
 * Stand-ins for what Better Auth migrates.
 *
 * Built here rather than by running the real migration because the invariant is
 * about the names, and a test that needed the identity provider configured would
 * be measuring two things at once. `auth/bootstrap.test.ts` is what holds the
 * list against a real migration.
 */
const AUTH_SCHEMA: readonly string[] = Object.freeze([
  'CREATE TABLE IF NOT EXISTS "user" (id TEXT NOT NULL PRIMARY KEY, email TEXT NOT NULL) STRICT',
  'CREATE TABLE IF NOT EXISTS "session" (id TEXT NOT NULL PRIMARY KEY, token TEXT NOT NULL) STRICT',
  'CREATE TABLE IF NOT EXISTS "account" (id TEXT NOT NULL PRIMARY KEY, access_token TEXT) STRICT',
  'CREATE TABLE IF NOT EXISTS "verification" (id TEXT NOT NULL PRIMARY KEY, value TEXT NOT NULL) STRICT',
  'CREATE TABLE IF NOT EXISTS "jwks" (id TEXT NOT NULL PRIMARY KEY, private_key TEXT NOT NULL) STRICT',
]);

/**
 * ⚠️ Auth has to be configured even though every request here is anonymous.
 *
 * `identify` refuses outright on a deployment with no signing secret, so without
 * this the REST path answers 500 and an assertion about 404 would be measuring a
 * misconfiguration instead of a refusal. Found by probing the 500 rather than by
 * assuming which layer produced it, which is the same way `index.test.ts` found
 * it before this file existed.
 */
const configured = {
  ...env,
  BETTER_AUTH_SECRET: 'test-secret-not-used-to-sign-anything-real',
  BETTER_AUTH_URL: 'https://baseclf.test',
};

const call = (path: string) => worker.fetch(new Request(`https://baseclf.test${path}`), configured);

beforeAll(async () => {
  await seedDatabase(env.DB);
  await seedStandardPolicies(env.DB);
  for (const statement of AUTH_SCHEMA) await env.DB.prepare(statement).run();
  resetCatalogue();
  resetRegistry();
});

describe('a name the engine owns', () => {
  it.each([...AUTH_TABLES])('is reserved: %s', (table) => {
    expect(isReservedTableName(table)).toBe(true);
  });

  it('is reserved when it carries the underscore prefix', () => {
    expect(isReservedTableName('_policies')).toBe(true);
  });

  it('leaves an application table alone', () => {
    expect(isReservedTableName('posts')).toBe(false);
  });

  it('matches character for character, so a longer name is not caught', () => {
    // The check is exact rather than a prefix match on purpose. `users` is a
    // perfectly ordinary application table and reserving it would refuse a
    // caller for a reason nobody could find.
    expect(isReservedTableName('users')).toBe(false);
    expect(isReservedTableName('user_profiles')).toBe(false);
    expect(isReservedTableName('accounts')).toBe(false);
  });
});

describe('the catalogue', () => {
  it('flags the identity provider tables as the engine own', async () => {
    const catalogue = await getCatalogue(env.DB);

    for (const table of AUTH_TABLES) {
      expect(catalogue.tables.get(table)?.isSystem).toBe(true);
    }
  });
});

describe('the public schema endpoint', () => {
  it('lists an application table', async () => {
    // The control. Without it a filter that returned nothing at all would pass
    // every assertion below while breaking the endpoint entirely.
    const response = await call('/_schema');
    const body = (await response.json()) as { tables: { name: string }[] };

    expect(body.tables.map((table) => table.name)).toContain('posts');
  });

  it('never lists a table the engine owns, whatever it is named', async () => {
    const response = await call('/_schema');
    const body = (await response.json()) as { tables: { name: string }[] };
    const listed = body.tables.map((table) => table.name);

    for (const table of AUTH_TABLES) expect(listed).not.toContain(table);
    expect(listed.some((name) => name.startsWith('_'))).toBe(false);
  });
});

describe('exposing an engine table through a policy', () => {
  /**
   * ⭐ The strongest test here, because it is the hole rather than the symptom.
   *
   * Listing a name is a disclosure. Serving `account` over REST hands out the
   * provider tokens the rest of the engine is built on, and until the fix
   * nothing stood between the two: the deny list was the underscore prefix, and
   * a single row in `_exposed_tables` was enough.
   *
   * Both tables are registered in the same load, so a refusal cannot be the
   * registry failing to work at all.
   */
  beforeAll(async () => {
    await registerPolicies(env.DB, {
      table: 'account',
      policies: [
        {
          name: 'read_all',
          operation: 'select',
          roles: ['anon'],
          using: { id: { _neq: '' } },
          columns: ['id', 'access_token'],
        },
      ],
    });
    resetRegistry();
  });

  const read = async (table: string) => {
    const [catalogue, registry] = await Promise.all([getCatalogue(env.DB), getRegistry(env.DB)]);
    return readTable({
      executor: env.DB,
      catalogue,
      registry,
      auth: ANON,
      table,
      search: new URLSearchParams(),
    });
  };

  it('still serves the application table, so the registry is working', async () => {
    await expect(read('posts')).resolves.toBeDefined();
  });

  it('refuses the engine table anyway', async () => {
    await expect(read('account')).rejects.toBeInstanceOf(BaseclfError);
  });

  it('refuses it with 404, telling the caller nothing about why', async () => {
    // Invariant I5. "That table is not exposed" and "that table does not exist"
    // have to be one answer, or the difference maps the database.
    await expect(read('account')).rejects.toMatchObject({ status: 404 });
  });

  it('refuses it over HTTP too', async () => {
    const response = await call('/rest/v1/account');
    expect(response.status).toBe(404);
  });
});

describe('each layer on its own', () => {
  /**
   * ⚠️ Invariant I8 asks for independent checks, and independence is exactly what
   * a behavioural test cannot see: with the router, the allow list and the
   * registry all refusing, removing any one of them leaves the answer unchanged.
   * That is ledger D3, where a gate nobody can distinguish from its neighbour
   * reads as defence in depth and is really an untested line.
   *
   * So this asserts the contract of the layer directly. It is the difference
   * between knowing the engine refuses and knowing why it refuses.
   */
  it('the allow list refuses an engine table by name', async () => {
    const catalogue = await getCatalogue(env.DB);

    expect(() => resolveTable(catalogue, 'account')).toThrow(BaseclfError);
    expect(() => resolveTable(catalogue, '_policies')).toThrow(BaseclfError);
    expect(resolveTable(catalogue, 'posts')).toBe('posts');
  });

  it('the allow list refuses with the same 404 either way', async () => {
    const catalogue = await getCatalogue(env.DB);

    for (const name of ['account', '_policies', 'no_such_table']) {
      expect(() => resolveTable(catalogue, name)).toThrow(expect.objectContaining({ status: 404 }));
    }
  });
});

describe('a policy that reaches an engine table through EXISTS', () => {
  it('is refused when the registry loads, not when a row is read', async () => {
    // `_exists` names its own table, so it is a second way in and it bypasses
    // the router entirely. Refusing at load time means a document like this can
    // never be the thing deciding who sees a row.
    await registerPolicies(env.DB, {
      table: 'posts',
      binds: {
        hasAccount: {
          _exists: {
            _table: 'user',
            _where: { id: { _eq: '$auth.uid' } },
          },
        },
      },
      policies: [
        {
          name: 'read_if_user_row_exists',
          operation: 'select',
          roles: ['anon'],
          using: { $bind: 'hasAccount' },
          columns: ['id', 'title'],
        },
      ],
    });
    resetRegistry();

    // Dropped rather than fatal since 2026-08-14. The claim in the comment above
    // is unchanged and is what is asserted: a document like this never gets to
    // be the thing deciding who sees a row, because the table it belongs to is
    // refused outright.
    const registry = await getRegistry(env.DB);

    expect(registry.definitions.has('posts')).toBe(false);
    expect(() => registry.resolve('posts', 'select', 'anon', ['id'])).toThrow(BaseclfError);
  });
});
