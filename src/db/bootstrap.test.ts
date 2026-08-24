/**
 * A deployment nobody provisioned, and whether it can answer a request.
 *
 * Until `applyEngineSchema` existed, nothing outside the tests applied
 * `POLICY_SCHEMA` or `STORAGE_SCHEMA`. Both were declared, both were imported by
 * fixtures, and neither reached a real database. So the honest description of
 * every deployment this project has ever made is that `/rest/v1` and
 * `/storage/v1` answered with a D1 error naming a table their owner had never
 * heard of, while `/health`, `/_schema` and `/api/auth/*` all looked fine.
 *
 * The test that matters here is the last one. The others check the properties it
 * depends on; that one checks the thing a user would notice.
 */

import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

import worker, { resetEngineSchemaMemo } from '../index.js';
import { applyEngineSchema, ENGINE_SCHEMA, unrepeatableStatements } from './bootstrap.js';
import type { D1Executor } from './dialect.js';

interface Bindings {
  readonly DB: D1Database;
}

const db = (env as unknown as Bindings).DB;

/**
 * An env with identity configured, because without it every data path answers
 * 500 UNAUTHENTICATED before it reaches a table at all.
 *
 * Worth saying rather than copying silently: the first version of this file left
 * it out and read the resulting 500 as the bootstrap not working. It was the
 * fixture. A test that asserts "not a database error" has to be certain the
 * request got as far as the database.
 */
const configured = {
  ...env,
  BETTER_AUTH_SECRET: 'test-secret-not-used-to-sign-anything-real',
  BETTER_AUTH_URL: 'https://baseclf.test',
} as never;

/** Every table the engine owns and this file is allowed to remove. */
const ENGINE_TABLES = [
  '_exposed_tables',
  '_policies',
  '_policy_binds',
  '_storage_buckets',
  '_storage_policies',
  '_storage_objects',
  '_storage_sweep',
];

async function tableNames(): Promise<string[]> {
  const listed = await db.prepare('PRAGMA table_list').all<{ name?: unknown }>();
  return (listed.results ?? []).map((row) => String(row.name));
}

async function blankSlate(): Promise<void> {
  for (const table of ENGINE_TABLES) {
    await db.prepare(`DROP TABLE IF EXISTS "${table}"`).run();
  }
  resetEngineSchemaMemo();
}

beforeEach(blankSlate);

describe('the schema this applies', () => {
  it('creates every table the engine owns', async () => {
    await applyEngineSchema(db);

    expect(await tableNames()).toEqual(expect.arrayContaining(ENGINE_TABLES));
  });

  it('is safe to apply to a database that already has all of it', async () => {
    // The first run of a CLI is the one that gets interrupted, so the second run
    // has to be able to finish it rather than fail on what the first one did.
    await applyEngineSchema(db);
    const after = await tableNames();

    await applyEngineSchema(db);

    expect(await tableNames()).toEqual(after);
  });

  it('carries IF NOT EXISTS on every statement, which is what makes that true', () => {
    // Over the constant rather than only through behaviour, so a statement added
    // later without the clause fails here rather than on somebody else's second
    // deployment, where it reads as a corrupt database.
    expect(unrepeatableStatements(ENGINE_SCHEMA)).toEqual([]);
  });

  it('spots a statement that lost the clause, which is the case that never occurs', () => {
    // The guard is handed a bad statement here because the real schema never
    // gives it one. A guard that only ever sees valid input proves nothing, and
    // a mutation that disables it would otherwise survive.
    const bad = 'CREATE TABLE _later (id TEXT PRIMARY KEY NOT NULL) STRICT';

    expect(unrepeatableStatements([...ENGINE_SCHEMA, bad])).toEqual([bad]);
  });

  it('goes as one batch, so a failure partway leaves no half-applied schema', async () => {
    // `batch()` is the only transaction primitive D1 has. Asserted by counting
    // round trips: a schema sent one statement at a time is as many chances to
    // stop in the middle, and the middle is the state hardest to recover from.
    // (Deliberately not a number: the count was written down as "nine" once,
    // the schema grew to thirteen, and the prose was stale for weeks.)
    let batches = 0;
    const counting: D1Executor = {
      prepare: (sql: string) => db.prepare(sql),
      batch: <T>(statements: D1PreparedStatement[]) => {
        batches += 1;
        return db.batch<T>(statements);
      },
    };

    await applyEngineSchema(counting);

    expect(batches).toBe(1);
  });
});

describe('⭐ a deployment whose database nobody provisioned', () => {
  it('answers a REST request instead of failing on a missing table', async () => {
    // The failure this whole file exists for. Without the bootstrap the response
    // is a 500 carrying a D1 error about `_exposed_tables`, which names an
    // internal table to a caller and tells its owner nothing they can act on.
    //
    // 404 is the right answer and it is the fail-closed one: the tables exist now
    // and no policy exposes `posts`, so the table is not there as far as this
    // caller is concerned. Invariant I1 and I5.
    const response = await worker.fetch(
      new Request('https://baseclf.test/rest/v1/posts'),
      configured,
    );

    expect(response.status).toBe(404);

    const body = (await response.json()) as { error?: string };
    expect(JSON.stringify(body)).not.toContain('_exposed_tables');
  });

  it('has created the tables by the time that request is answered', async () => {
    await worker.fetch(new Request('https://baseclf.test/rest/v1/posts'), configured);

    expect(await tableNames()).toEqual(expect.arrayContaining(ENGINE_TABLES));
  });

  it('answers a storage request the same way rather than with a D1 error', async () => {
    const response = await worker.fetch(
      new Request('https://baseclf.test/storage/v1/avatars/me.png'),
      configured,
    );

    expect(response.status).toBe(404);
    expect(JSON.stringify(await response.json())).not.toContain('_storage_');
  });
});
