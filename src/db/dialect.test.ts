import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';

import { batch, createDb, execute } from './dialect.js';

interface Schema {
  posts: {
    id: string;
    title: string;
    status: string;
    author_id: string;
  };
}

const db = createDb<Schema>(env.DB);

beforeAll(async () => {
  await env.DB.prepare('DROP TABLE IF EXISTS posts').run();
  await env.DB.prepare(
    `CREATE TABLE posts (
       id TEXT PRIMARY KEY,
       title TEXT NOT NULL,
       status TEXT NOT NULL,
       author_id TEXT NOT NULL
     )`,
  ).run();
  await env.DB.prepare(
    `INSERT INTO posts (id, title, status, author_id) VALUES
       ('p_1', 'Published one', 'published', 'u_1'),
       ('p_2', 'A draft',       'draft',     'u_1'),
       ('p_3', 'Someone else',  'published', 'u_2')`,
  ).run();
});

describe('compilation', () => {
  it('compiles to parameterised SQL, never interpolated values', () => {
    const compiled = db
      .selectFrom('posts')
      .select(['id', 'title'])
      .where('status', '=', 'published')
      .where('author_id', '=', 'u_1')
      .compile();

    expect(compiled.sql).toBe(
      'select "id", "title" from "posts" where "status" = ? and "author_id" = ?',
    );
    expect(compiled.parameters).toEqual(['published', 'u_1']);
    // The value must not appear in the SQL text. This is the whole point.
    expect(compiled.sql).not.toContain('published');
  });

  it('quotes identifiers on emit', () => {
    const compiled = db.selectFrom('posts').select('author_id').compile();
    expect(compiled.sql).toContain('"author_id"');
  });
});

describe('execution', () => {
  it('runs a select and returns rows', async () => {
    const rows = await db
      .selectFrom('posts')
      .select(['id', 'title'])
      .where('status', '=', 'published')
      .orderBy('id')
      .execute();

    expect(rows.map((r) => r.id)).toEqual(['p_1', 'p_3']);
  });

  it('reports affected rows on a write', async () => {
    const result = await db
      .updateTable('posts')
      .set({ title: 'Renamed' })
      .where('id', '=', 'p_2')
      .executeTakeFirst();

    expect(result.numUpdatedRows).toBe(1n);
  });

  it('supports RETURNING, which the whole WITH CHECK design depends on', async () => {
    const returned = await db
      .updateTable('posts')
      .set({ status: 'published' })
      .where('id', '=', 'p_2')
      .where('author_id', '=', 'u_1')
      .returning(['id', 'status'])
      .execute();

    expect(returned).toEqual([{ id: 'p_2', status: 'published' }]);
  });

  it('returns zero rows when a predicate blocks the update', async () => {
    // This is how a policy denial surfaces. Zero rows means "missing or
    // forbidden", and both map to 404 so row existence never leaks.
    const returned = await db
      .updateTable('posts')
      .set({ title: 'hijacked' })
      .where('id', '=', 'p_1')
      .where('author_id', '=', 'someone_else')
      .returning('id')
      .execute();

    expect(returned).toEqual([]);
  });

  it('refuses a query whose parameters exceed the D1 ceiling', async () => {
    const tooMany = Array.from({ length: 101 }, (_, i) => `id_${i}`);
    await expect(
      db.selectFrom('posts').select('id').where('id', 'in', tooMany).execute(),
    ).rejects.toThrow(/at most 100/);
  });
});

describe('transactions', () => {
  it('refuses interactive transactions and points at batch', async () => {
    await expect(db.transaction().execute(async () => undefined)).rejects.toThrow(
      /Interactive transactions are not available/,
    );
  });
});

describe('batch', () => {
  it('applies every statement when all succeed', async () => {
    const before = await env.DB.prepare('SELECT count(*) AS c FROM posts').first<{ c: number }>();

    await batch(env.DB, [
      db
        .insertInto('posts')
        .values({ id: 'p_b1', title: 'Batch one', status: 'draft', author_id: 'u_1' })
        .compile(),
      db
        .insertInto('posts')
        .values({ id: 'p_b2', title: 'Batch two', status: 'draft', author_id: 'u_1' })
        .compile(),
    ]);

    const after = await env.DB.prepare('SELECT count(*) AS c FROM posts').first<{ c: number }>();
    expect(after?.c).toBe((before?.c ?? 0) + 2);
  });

  it('rolls the whole sequence back when one statement fails', async () => {
    // Verified against a remote database on 2026-07-29. The outbox pattern
    // planned for realtime in V2 is only safe because this holds.
    const before = await env.DB.prepare('SELECT count(*) AS c FROM posts').first<{ c: number }>();

    await expect(
      batch(env.DB, [
        db
          .insertInto('posts')
          .values({ id: 'p_r1', title: 'Will roll back', status: 'draft', author_id: 'u_1' })
          .compile(),
        db
          .insertInto('posts')
          // Duplicate primary key: this statement fails.
          .values({ id: 'p_r1', title: 'Duplicate key', status: 'draft', author_id: 'u_1' })
          .compile(),
      ]),
    ).rejects.toThrow();

    const after = await env.DB.prepare('SELECT count(*) AS c FROM posts').first<{ c: number }>();
    expect(after?.c).toBe(before?.c);
  });

  it('treats an empty batch as a no-op', async () => {
    await expect(batch(env.DB, [])).resolves.toEqual([]);
  });
});

describe('sessions', () => {
  it('accepts a session in place of a database and yields a bookmark', async () => {
    const session = env.DB.withSession('first-unconstrained');
    const sessionDb = createDb<Schema>(session);

    const rows = await sessionDb.selectFrom('posts').select('id').limit(1).execute();
    expect(rows).toHaveLength(1);

    // Miniflare may return null locally; on a real database this is the
    // bookmark that gets threaded back through x-d1-bookmark.
    expect(() => session.getBookmark()).not.toThrow();
  });
});

describe('execute', () => {
  it('runs a compiled query outside the Kysely driver', async () => {
    const compiled = db.selectFrom('posts').select('id').where('id', '=', 'p_1').compile();
    const result = await execute<{ id: string }>(env.DB, compiled);
    expect(result.rows).toEqual([{ id: 'p_1' }]);
  });
});
