/**
 * The three things `ensureAuthSchema` can decide, and the one it must never do.
 *
 * The refusal is the test that matters. Every other path here is convenience; that
 * one is the difference between a deployment that is out of date and a deployment
 * that cannot be migrated at all, because the repair it declines to attempt fails
 * partway and does not roll back. `migration-idempotency.test.ts` is where that was
 * measured, and `rules/01` §G11 is where it is written down.
 */

import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

import worker, { resetAuthSchemaMemo } from '../index.js';
import { AUTH_TABLES, ensureAuthSchema } from './bootstrap.js';
import { runAuthMigrations } from './index.js';

interface Bindings {
  readonly DB: D1Database;
}

const db = (env as unknown as Bindings).DB;

const configured = {
  ...env,
  BETTER_AUTH_SECRET: 'test-secret-not-used-to-sign-anything-real',
  BETTER_AUTH_URL: 'https://baseclf.test',
};

async function tableNames(): Promise<string[]> {
  const listed = await db.prepare('PRAGMA table_list').all<{ name?: unknown }>();
  return (listed.results ?? []).map((row) => String(row.name));
}

/**
 * What this file cleans up, written out rather than taken from `AUTH_TABLES`.
 *
 * ⚠️ Deliberately independent of the constant under test, and a mutation is why.
 * Removing `jwks` from `AUTH_TABLES` used to survive: the cleanup stopped dropping
 * it, so it lingered from an earlier test, so the migration did not report creating
 * it, so the comparison matched. A fixture that shares a constant with the thing it
 * checks cannot tell the two apart when the constant is what is wrong.
 *
 * The decoys are not ours. They stand in for an application's own tables whose
 * names begin with ours, which is what makes a prefix match visibly wrong.
 */
const DECOY_TABLES = [
  'user_profiles',
  'session_log',
  'account_history',
  'verification_codes',
  'jwks_backup',
];

const TABLES_THIS_FILE_CLEANS_UP = [
  'user',
  'session',
  'account',
  'verification',
  'jwks',
  ...DECOY_TABLES,
];

async function dropAuthTables(): Promise<void> {
  for (const table of TABLES_THIS_FILE_CLEANS_UP) {
    await db.prepare(`DROP TABLE IF EXISTS "${table}"`).run();
  }
}

beforeEach(dropAuthTables);

describe('a deployment whose auth tables were never created', () => {
  it('creates them, which is the step that used to be manual', async () => {
    // Debt 37. Forgetting it fails in the quietest way this project has: health,
    // schema and diagnose all report a working deployment, jwks answers 500, and
    // every token silently fails to verify.
    const outcome = await ensureAuthSchema(db, configured);

    expect(outcome.kind).toBe('created');
    expect(await tableNames()).toEqual(expect.arrayContaining([...AUTH_TABLES]));
  });

  it('is not fooled by application tables whose names start with ours', async () => {
    // Invariant I6 in the small: whole names, never prefixes.
    //
    // ⚠️ All five decoys, and the reason is worth reading. With one decoy the
    // prefix bug changes nothing observable, because `missing` is still non-empty
    // and Better Auth then does its own inspection and creates the real tables
    // anyway. That second layer is genuine defence in depth, and it is also what
    // made a prefix mutation survive. It only matters when the bug makes `missing`
    // come back EMPTY, and that needs every name covered. So this is the case that
    // tells the two layers apart rather than letting one cover for the other.
    for (const decoy of DECOY_TABLES) {
      await db.prepare(`CREATE TABLE "${decoy}" ("id" TEXT PRIMARY KEY NOT NULL)`).run();
    }

    const outcome = await ensureAuthSchema(db, configured);

    expect(outcome.kind).toBe('created');
    expect(await tableNames()).toEqual(expect.arrayContaining([...AUTH_TABLES]));
  });
});

describe('a deployment that already has them', () => {
  it('reports them present and does no migration work', async () => {
    await runAuthMigrations(configured);

    const outcome = await ensureAuthSchema(db, configured);

    expect(outcome.kind).toBe('present');
  });

  it('takes the cheap path, asking one question rather than introspecting', async () => {
    // The common case runs on every cold isolate, so it costs one PRAGMA rather
    // than a full Better Auth introspection. Counted rather than asserted about,
    // because "cheap" is not something a comment can be trusted on.
    await runAuthMigrations(configured);

    let queries = 0;
    const counting = {
      prepare: (sql: string) => {
        queries += 1;
        return db.prepare(sql);
      },
    } as unknown as D1Database;

    await ensureAuthSchema(counting, configured);

    expect(queries).toBe(1);
  });
});

describe('⭐ a deployment whose auth schema has drifted', () => {
  it('refuses rather than attempting a repair that cannot finish', async () => {
    // A `user` table one version behind, with `jwks` and the rest absent. The
    // migration would ALTER it, and that throws on a UNIQUE column after having
    // already added an earlier one, leaving a schema no retry can get out of.
    await db.prepare('CREATE TABLE "user" ("id" TEXT PRIMARY KEY NOT NULL)').run();

    const outcome = await ensureAuthSchema(db, configured);

    expect(outcome.kind).toBe('refused');
  });

  it('leaves the drifted table exactly as it found it', async () => {
    // The property the refusal exists for. If this ever fails, something ran the
    // ALTER, and the database it ran against is now in the half-applied state.
    await db.prepare('CREATE TABLE "user" ("id" TEXT PRIMARY KEY NOT NULL)').run();

    await ensureAuthSchema(db, configured);

    const columns = await db.prepare('PRAGMA table_info("user")').all<{ name?: unknown }>();
    expect((columns.results ?? []).map((row) => String(row.name))).toEqual(['id']);
  });

  it('says what to do about it, since nothing here can', async () => {
    await db.prepare('CREATE TABLE "user" ("id" TEXT PRIMARY KEY NOT NULL)').run();

    const outcome = await ensureAuthSchema(db, configured);

    expect(outcome.kind === 'refused' && outcome.detail).toContain('by hand');
  });
});

describe('⭐ the worker, whose auth path is what actually needs the tables', () => {
  it('creates them while answering a request, rather than only when called directly', async () => {
    // The module having tests says nothing about the module being wired in. That
    // gap is exactly how 549 lines of unreferenced code reached a green suite in
    // this project once already, so the seam gets its own test rather than being
    // assumed from the two ends existing.
    resetAuthSchemaMemo();

    await worker.fetch(new Request('https://baseclf.test/api/auth/jwks'), configured as never);

    expect(await tableNames()).toEqual(expect.arrayContaining([...AUTH_TABLES]));
  });

  it('does the work once per isolate rather than on every request', async () => {
    resetAuthSchemaMemo();
    const jwks = () =>
      worker.fetch(new Request('https://baseclf.test/api/auth/jwks'), configured as never);

    await jwks();
    await db.prepare('DROP TABLE IF EXISTS "jwks"').run();
    await jwks();

    // Still gone: the memo means the second request did not look again. That is
    // the intended trade and it is asserted rather than left to a comment, because
    // a bootstrap running per request is a DDL statement on the hot path.
    expect(await tableNames()).not.toContain('jwks');
  });
});

describe('the hardcoded table list, which is what makes the cheap path cheap', () => {
  it('matches what a real migration creates on a blank database', async () => {
    // The list exists so the common case costs one query, and that makes it a
    // list that can go stale when a plugin brings a table with it. A plugin added
    // without updating it would mean this module reporting `present` for a
    // deployment missing a table, which is the failure the whole file prevents.
    // So the list is checked against the migration rather than against a comment.
    const created = await runAuthMigrations(configured);

    expect([...created].sort()).toEqual([...AUTH_TABLES].sort());
  });
});
