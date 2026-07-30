import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';

import { getCatalogue, introspect, resetCatalogue } from './introspect.js';

beforeAll(async () => {
  resetCatalogue();

  await env.DB.prepare('DROP TABLE IF EXISTS comments').run();
  await env.DB.prepare('DROP TABLE IF EXISTS articles').run();
  await env.DB.prepare('DROP TABLE IF EXISTS _policies').run();

  await env.DB.prepare(
    `CREATE TABLE articles (
       id TEXT PRIMARY KEY,
       title TEXT NOT NULL,
       body TEXT,
       status TEXT NOT NULL DEFAULT 'draft',
       author_id TEXT NOT NULL
     )`,
  ).run();
  await env.DB.prepare('CREATE INDEX articles_author_id ON articles(author_id)').run();
  await env.DB.prepare('CREATE UNIQUE INDEX articles_title ON articles(title)').run();

  await env.DB.prepare(
    `CREATE TABLE comments (
       id TEXT PRIMARY KEY,
       article_id TEXT NOT NULL REFERENCES articles(id),
       body TEXT NOT NULL
     )`,
  ).run();

  await env.DB.prepare(
    'CREATE TABLE _policies (id TEXT PRIMARY KEY, table_name TEXT NOT NULL)',
  ).run();
});

describe('introspect', () => {
  it('reads every user table', async () => {
    const catalogue = await introspect(env.DB);
    expect(catalogue.hasTable('articles')).toBe(true);
    expect(catalogue.hasTable('comments')).toBe(true);
  });

  it('skips D1 and SQLite internal tables', async () => {
    const catalogue = await introspect(env.DB);
    for (const name of catalogue.tables.keys()) {
      expect(name).not.toMatch(/^(sqlite_|_cf_|d1_)/);
    }
  });

  it('marks tables with an underscore prefix as system tables', async () => {
    // Rule 00 invariant I8. The REST router denies these independently, so a
    // failure in one place is still caught by the other.
    const catalogue = await introspect(env.DB);
    expect(catalogue.tables.get('_policies')?.isSystem).toBe(true);
    expect(catalogue.tables.get('articles')?.isSystem).toBe(false);
  });

  it('records column type, nullability, primary key and default', async () => {
    const catalogue = await introspect(env.DB);
    const articles = catalogue.tables.get('articles');

    expect(articles?.columns.get('id')).toMatchObject({ primaryKey: true });
    expect(articles?.columns.get('title')).toMatchObject({ type: 'TEXT', notNull: true });
    expect(articles?.columns.get('body')).toMatchObject({ notNull: false });
    expect(articles?.columns.get('status')).toMatchObject({ hasDefault: true });
  });

  it('reports a plain TEXT PRIMARY KEY as nullable, because SQLite means it', async () => {
    // Measured 2026-07-30. `id TEXT PRIMARY KEY` on a non-STRICT table accepts
    // NULL and PRAGMA table_info reports notnull=0. Only INTEGER PRIMARY KEY
    // (the rowid alias) is special, and only STRICT or an explicit NOT NULL
    // closes the hole.
    //
    // This is not cosmetic. A policy predicate that meets NULL evaluates to
    // NULL, which a WHERE clause treats as false, so a positive policy still
    // fails closed. A negated one does not: NOT (NULL = 'u_1') is NULL, not
    // true. See rules/01 section G.
    const catalogue = await introspect(env.DB);
    expect(catalogue.tables.get('articles')?.columns.get('id')?.notNull).toBe(false);

    await env.DB.prepare('DROP TABLE IF EXISTS null_pk_probe').run();
    await env.DB.prepare('CREATE TABLE null_pk_probe (id TEXT PRIMARY KEY, note TEXT)').run();
    await env.DB.prepare('INSERT INTO null_pk_probe (id, note) VALUES (?, ?)')
      .bind(null, 'accepted')
      .run();

    const stored = await env.DB.prepare(
      'SELECT count(*) AS c FROM null_pk_probe WHERE id IS NULL',
    ).first<{ c: number }>();
    expect(stored?.c).toBe(1);

    await env.DB.prepare('DROP TABLE null_pk_probe').run();
  });

  it('reports a STRICT table primary key as not null', async () => {
    await env.DB.prepare('DROP TABLE IF EXISTS strict_probe').run();
    await env.DB.prepare('CREATE TABLE strict_probe (id TEXT PRIMARY KEY, note TEXT) STRICT').run();

    const catalogue = await introspect(env.DB);
    expect(catalogue.tables.get('strict_probe')?.columns.get('id')?.notNull).toBe(true);

    await env.DB.prepare('DROP TABLE strict_probe').run();
  });

  it('matches identifiers exactly, never by case or prefix', async () => {
    // Double-quoted string literals are enabled on D1, so a misspelled column
    // returns the string instead of raising. Exact matching here is the only
    // thing standing between a typo and silently wrong data.
    const catalogue = await introspect(env.DB);

    expect(catalogue.hasColumn('articles', 'author_id')).toBe(true);
    expect(catalogue.hasColumn('articles', 'Author_Id')).toBe(false);
    expect(catalogue.hasColumn('articles', 'author')).toBe(false);
    expect(catalogue.hasColumn('articles', 'author_id_extra')).toBe(false);
    expect(catalogue.hasTable('Articles')).toBe(false);
    expect(catalogue.hasTable('article')).toBe(false);
  });

  it('reads indexes, including uniqueness', async () => {
    const catalogue = await introspect(env.DB);
    const indexes = catalogue.tables.get('articles')?.indexes ?? [];

    const byAuthor = indexes.find((i) => i.name === 'articles_author_id');
    expect(byAuthor?.columns).toEqual(['author_id']);
    expect(byAuthor?.unique).toBe(false);

    expect(indexes.find((i) => i.name === 'articles_title')?.unique).toBe(true);
  });

  it('answers isIndexed, which policy_lint uses to warn about scan cost', async () => {
    // On D1 rows_read counts every row scanned, not returned. An unindexed
    // policy column is a recurring bill, not just latency.
    const catalogue = await introspect(env.DB);

    expect(catalogue.isIndexed('articles', 'author_id')).toBe(true);
    expect(catalogue.isIndexed('articles', 'id')).toBe(true);
    expect(catalogue.isIndexed('articles', 'body')).toBe(false);
  });

  it('reads foreign keys, which relationship embeds resolve through', async () => {
    const catalogue = await introspect(env.DB);
    expect(catalogue.tables.get('comments')?.foreignKeys).toEqual([
      { column: 'article_id', referencesTable: 'articles', referencesColumn: 'id' },
    ]);
  });

  it('returns false for an unknown table rather than throwing', async () => {
    const catalogue = await introspect(env.DB);
    expect(catalogue.hasTable('no_such_table')).toBe(false);
    expect(catalogue.hasColumn('no_such_table', 'id')).toBe(false);
    expect(catalogue.isIndexed('no_such_table', 'id')).toBe(false);
  });
});

describe('getCatalogue', () => {
  it('memoises within an isolate', async () => {
    resetCatalogue();
    const first = await getCatalogue(env.DB);
    const second = await getCatalogue(env.DB);
    expect(first).toBe(second);
  });

  it('re-reads after a reset, which is what a migration must trigger', async () => {
    resetCatalogue();
    const before = await getCatalogue(env.DB);
    resetCatalogue();
    const after = await getCatalogue(env.DB);
    expect(after).not.toBe(before);
    expect(after.hasTable('articles')).toBe(true);
  });
});
