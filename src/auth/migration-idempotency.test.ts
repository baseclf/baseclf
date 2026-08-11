/**
 * What happens when migrations run a second time, measured rather than assumed.
 *
 * Debt 19 has said "unknown" since V3, and it is the question the whole shape of
 * provisioning hangs on: the first run of a CLI is the run that gets interrupted,
 * so every step has to be safe to repeat. The engine's own DDL says
 * `CREATE TABLE IF NOT EXISTS` and answers this for itself. Better Auth's does
 * not: `compileAuthMigrations` emits a bare `CREATE TABLE "user"`, which would
 * fail on a database that already has one.
 *
 * So there are two possibilities and they lead to different designs. Either
 * `getMigrations` inspects the live database and emits only what is absent, in
 * which case a second run is free and provisioning can simply call it again; or
 * it emits the same SQL regardless, in which case something has to decide whether
 * to run it, and that decision is a new place to be wrong.
 *
 * The drift case matters more than the repeat case, and is the one a CLI is most
 * likely to meet in the wild: a database where the tables exist but do not match
 * what this version of Better Auth expects, because the dependency moved. What
 * happens there decides whether `baseclf migrate` can be safe to run blind.
 *
 * ⚠️ Measured against D1 local through miniflare. Same caveat as `rules/01` §F1.
 */

import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

import { POLICY_SCHEMA } from '../policy/index.js';
import { STORAGE_SCHEMA } from '../storage/schema.js';
import { compileAuthMigrations, runAuthMigrations } from './index.js';

interface Bindings {
  readonly DB: D1Database;
}

const db = (env as unknown as Bindings).DB;

const configured = {
  ...env,
  BETTER_AUTH_SECRET: 'test-secret-not-used-to-sign-anything-real',
  BETTER_AUTH_URL: 'https://baseclf.test',
};

/** Every table Better Auth owns here, core plus the jwt plugin's. */
const AUTH_TABLES = ['user', 'session', 'account', 'verification', 'jwks'];

async function tableNames(): Promise<string[]> {
  const listed = await db.prepare('PRAGMA table_list').all<{ name?: unknown }>();
  return (listed.results ?? []).map((row) => String(row.name));
}

async function dropAuthTables(): Promise<void> {
  for (const table of AUTH_TABLES) {
    // Quoted because `user` is a keyword in plenty of dialects, and the name comes
    // from the constant above rather than from anything a caller supplies.
    await db.prepare(`DROP TABLE IF EXISTS "${table}"`).run();
  }
}

beforeEach(async () => {
  await dropAuthTables();
});

describe('the engine DDL, which says IF NOT EXISTS and so answers for itself', () => {
  it('applies twice with no error and no second copy of anything', async () => {
    for (const statement of POLICY_SCHEMA) await db.prepare(statement).run();
    for (const statement of STORAGE_SCHEMA) await db.prepare(statement).run();

    const after = await tableNames();

    // Again, on a database that already has all of it.
    for (const statement of POLICY_SCHEMA) await db.prepare(statement).run();
    for (const statement of STORAGE_SCHEMA) await db.prepare(statement).run();

    expect(await tableNames()).toEqual(after);
  });

  it('can be sent as one batch, which rolls back as a unit if any part fails', async () => {
    // `rules/01` §A: batch() rolls back when a statement fails. That is the only
    // transaction primitive on D1, and it is what stops a half-applied schema.
    const all = [...POLICY_SCHEMA, ...STORAGE_SCHEMA];
    const results = await db.batch(all.map((statement) => db.prepare(statement)));

    expect(results).toHaveLength(all.length);
    expect(await tableNames()).toEqual(expect.arrayContaining(['_policies', '_storage_objects']));
  });
});

describe('Better Auth migrations on a blank database', () => {
  it('creates every table it owns, and reports which ones', async () => {
    const created = await runAuthMigrations(configured);

    expect([...created].sort()).toEqual([...AUTH_TABLES].sort());
    expect(await tableNames()).toEqual(expect.arrayContaining(AUTH_TABLES));
  });
});

describe('⭐ Better Auth migrations on a database that already has them', () => {
  it('reports nothing left to create, so it inspects rather than assumes', async () => {
    // The answer debt 19 was waiting for. If this is the whole list again, then
    // `compileMigrations` is a fixed string and something else has to decide
    // whether running it is safe.
    await runAuthMigrations(configured);
    const second = await runAuthMigrations(configured);

    expect(second).toEqual([]);
  });

  it('⭐ emits no CREATE TABLE the second time', async () => {
    await runAuthMigrations(configured);
    const sql = (await compileAuthMigrations(configured)).toLowerCase();

    for (const table of AUTH_TABLES) {
      expect(sql).not.toContain(`create table "${table}"`);
    }
  });

  it('running a second time is not an error', async () => {
    await runAuthMigrations(configured);

    await expect(runAuthMigrations(configured)).resolves.toBeDefined();
  });
});

describe('⭐ Better Auth migrations against a schema that has drifted', () => {
  /** A `user` table one version behind: the primary key and nothing else. */
  const driftedUser = 'CREATE TABLE "user" ("id" TEXT PRIMARY KEY NOT NULL)';

  it('tries to repair it with ALTER rather than skipping it', async () => {
    await db.prepare(driftedUser).run();

    const sql = (await compileAuthMigrations(configured)).toLowerCase();

    expect(sql).toContain('alter table');
  });

  it('🔴 fails doing it, because SQLite cannot add a UNIQUE column', async () => {
    // Not a Better Auth bug and not fixable by retrying: `ALTER TABLE ADD COLUMN`
    // in SQLite refuses a UNIQUE column outright. Every table with a unique field,
    // which is `user.email` here, is therefore beyond repair by this route.
    await db.prepare(driftedUser).run();

    await expect(runAuthMigrations(configured)).rejects.toThrow(/UNIQUE column/i);
  });

  it('🔴 and leaves the table partly altered, because nothing rolls it back', async () => {
    // The finding that decides the design. The failure is not atomic: the columns
    // before the unique one are already applied when it throws, so the database
    // ends up in a state that is neither the old schema nor the new one, and every
    // retry meets the same wall. A migration step that runs this blind can turn a
    // deployment that was merely out of date into one that cannot be migrated.
    await db.prepare(driftedUser).run();
    await runAuthMigrations(configured).catch(() => undefined);

    const columns = await db.prepare('PRAGMA table_info("user")').all<{ name?: unknown }>();
    const names = (columns.results ?? []).map((row) => String(row.name));

    // Changed from what it was, and still short of what it needs to be.
    expect(names).not.toEqual(['id']);
    expect(names).not.toContain('email');
  });
});
