import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';

import type { D1Executor } from './dialect.js';
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

  it('retries after a failed read instead of memoising the failure', async () => {
    // 🔴 This was `cached ??= introspect(executor)`, which keeps a rejected promise
    // and never replaces it. Of the three memos that had that shape this is the one
    // that matters most, and it is not the one an audit reported: introspection is
    // PRAGMA sweeps, so it fails for reasons that have nothing to do with the data.
    // A timeout, or the six connection limit in `rules/02` section A, and the isolate
    // could never read a schema again.
    //
    // Written here as well as in `utils/memo.test.ts` because sharing a helper is a
    // claim about this file, and a claim about this file needs a test in it.
    resetCatalogue();

    let failNext = true;
    const flaky: D1Executor = {
      prepare: (query: string) => {
        if (failNext) {
          failNext = false;
          return {
            bind: () => flaky.prepare(query),
            all: async () => {
              throw new Error('D1 was busy');
            },
          } as unknown as D1PreparedStatement;
        }
        return env.DB.prepare(query);
      },
      batch: (statements) => env.DB.batch(statements),
    };

    await expect(getCatalogue(flaky)).rejects.toThrow();

    const catalogue = await getCatalogue(flaky);
    expect(catalogue.hasTable('articles')).toBe(true);
  });
});

describe('reading the PRAGMAs in one batch', () => {
  /**
   * The same catalogue, built with `batch` taken away.
   *
   * Wrapping the real database rather than faking one: what is being compared is two
   * paths through the same D1, and a stand-in would be comparing the loader against a
   * model of D1 rather than against D1.
   */
  function withoutBatch(executor: D1Executor): D1Executor {
    return {
      prepare: (sql: string) => executor.prepare(sql),
      batch: () => {
        throw new Error('batch is not available here');
      },
    };
  }

  it('gives every table its own columns, indexes and foreign keys', async () => {
    // 🔴 The one that matters. Results come back matched to statements by position,
    // three statements per table, so an off-by-one hands one table another table's
    // columns. That is not a display bug: `rules/00` §I6 rests on the catalogue being
    // exact, and DQS means a column that does not exist is answered with a string
    // rather than an error.
    //
    // Asserted on the columns each table does NOT have as well as the ones it does,
    // because a swap produces a plausible catalogue and only the absences catch it.
    // ⚠️ `id` and `body` are in both fixtures, so neither can carry this. `title` and
    // `author_id` are articles only, `article_id` is comments only.
    const catalogue = await introspect(env.DB);

    const articles = catalogue.tables.get('articles');
    const comments = catalogue.tables.get('comments');

    const articleColumns = [...(articles?.columns.keys() ?? [])];
    const commentColumns = [...(comments?.columns.keys() ?? [])];

    expect(articleColumns).toEqual(expect.arrayContaining(['title', 'author_id', 'status']));
    expect(articleColumns).not.toContain('article_id');
    expect(commentColumns).toEqual(expect.arrayContaining(['article_id', 'body']));
    expect(commentColumns).not.toContain('title');
    expect(commentColumns).not.toContain('author_id');

    // Indexes and foreign keys are the other two statements of each table's three, so
    // they catch a shift the columns would not.
    //
    // ⚠️ Filtered to the ones with names of our own. A `TEXT PRIMARY KEY` makes SQLite
    // add `sqlite_autoindex_<table>_1`, so both fixtures carry one and an exact list
    // would be asserting SQLite's naming rather than this loader's mapping.
    const named = (table: typeof articles): string[] =>
      (table?.indexes ?? [])
        .map((each) => each.name)
        .filter((name) => !name.startsWith('sqlite_'))
        .sort();

    expect(named(articles)).toEqual(['articles_author_id', 'articles_title']);
    expect(named(comments)).toEqual([]);
    expect(comments?.foreignKeys.map((each) => each.referencesTable)).toEqual(['articles']);
    expect(articles?.foreignKeys).toEqual([]);
  });

  it('reads each index its own members rather than the previous one is', async () => {
    // The second batch is keyed off the first, one entry per index across every table,
    // so its positions drift independently of the table positions.
    const catalogue = await introspect(env.DB);
    const byName = new Map(
      (catalogue.tables.get('articles')?.indexes ?? []).map((each) => [each.name, each]),
    );

    expect(byName.get('articles_author_id')?.columns).toEqual(['author_id']);
    expect(byName.get('articles_title')?.columns).toEqual(['title']);
    expect(byName.get('articles_title')?.unique).toBe(true);
    expect(byName.get('articles_author_id')?.unique).toBe(false);
  });

  it('builds the identical catalogue when the batch is refused', async () => {
    // ⚠️ The fallback is not decoration. `batch` containing PRAGMA is measured in
    // workerd and through the REST transport on real D1, and neither of those is
    // `batch` through the binding on real D1, which nothing can measure without
    // deploying. If it is refused there this path runs, and a catalogue that came out
    // smaller would mean every identifier is unknown and the deployment refuses
    // everything.
    const batched = await introspect(env.DB);
    const oneAtATime = await introspect(withoutBatch(env.DB));

    const shape = (catalogue: Awaited<ReturnType<typeof introspect>>) =>
      [...catalogue.tables.entries()].map(([name, table]) => ({
        name,
        columns: [...table.columns.keys()],
        indexes: table.indexes.map((each) => ({ ...each, columns: [...each.columns] })),
        foreignKeys: table.foreignKeys.map((each) => ({ ...each })),
        isSystem: table.isSystem,
      }));

    expect(shape(oneAtATime)).toEqual(shape(batched));
    expect(oneAtATime.tables.size).toBeGreaterThan(0);
  });

  it('refuses a batch that answers with the wrong number of result sets', async () => {
    // Everything downstream indexes by position, so a short answer would shift every
    // table after the gap rather than lose one. It has to stop instead of be walked.
    // ⚠️ Drops the FIRST result rather than the last, and the difference is the whole
    // test. Dropping the last one loses a tail and shifts nothing, so a loader that
    // walked the short answer regardless still answered correctly about every table
    // before it, and this test passed while proving nothing. A mutation removing the
    // count check survived it. Dropping the first shifts every table.
    const short: D1Executor = {
      prepare: (sql: string) => env.DB.prepare(sql),
      batch: async <T>(statements: D1PreparedStatement[]) => {
        const all = await env.DB.batch<T>(statements);
        return all.slice(1);
      },
    };

    // It falls back rather than throwing, which is the deliberate part: a wrong count
    // is a reason to stop trusting the batch, not a reason to refuse every request.
    const catalogue = await introspect(short);

    expect(catalogue.tables.get('articles')?.columns.has('title')).toBe(true);
    expect(catalogue.tables.get('comments')?.columns.has('body')).toBe(true);
  });
});
