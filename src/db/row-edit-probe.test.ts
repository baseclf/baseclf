/**
 * Three questions the row-edit design rests on, asked of D1 rather than assumed.
 *
 * The design approved for the bridge's edit lane addresses one row by primary
 * key and swaps a value only if the old one is still there, in a single
 * statement, because D1 has no interactive transaction. Every part of that
 * sentence is a claim about the database, and `rules/01` covers only two of
 * them directly: RETURNING exists (section A), and a guarded INSERT works
 * (section G6). Compare-and-swap on UPDATE was inferred, and the two questions
 * about the catalogue were never asked at all.
 *
 * Kept as a test rather than deleted, because these are the assumptions the
 * lane is built on and a future change to any of them should fail here.
 */

import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

import { getCatalogue, resetCatalogue } from './introspect.js';

interface Row {
  readonly id: string;
  readonly title: string;
  readonly note: string | null;
}

async function reset(): Promise<void> {
  for (const statement of [
    'DROP TABLE IF EXISTS probe_rows',
    'DROP TABLE IF EXISTS probe_generated',
    'DROP TABLE IF EXISTS probe_no_key',
    `CREATE TABLE probe_rows (
       id    TEXT PRIMARY KEY NOT NULL,
       title TEXT NOT NULL,
       note  TEXT
     ) STRICT`,
    `INSERT INTO probe_rows (id, title, note) VALUES ('r1', 'first', 'kept'), ('r2', 'second', NULL)`,
  ]) {
    await env.DB.prepare(statement).run();
  }
  resetCatalogue();
}

beforeEach(reset);

describe('compare-and-swap in one statement', () => {
  const swap = (id: string, next: string, expected: string | null) =>
    env.DB.prepare(
      'UPDATE probe_rows SET title = ?1 WHERE id = ?2 AND title IS ?3 RETURNING id, title, note',
    )
      .bind(next, id, expected)
      .all<Row>();

  it('changes the row and hands back the post-image', async () => {
    const answer = await swap('r1', 'renamed', 'first');
    expect(answer.results).toEqual([{ id: 'r1', title: 'renamed', note: 'kept' }]);
  });

  it('changes nothing and returns nothing when the old value moved on', async () => {
    // The whole point: a second writer got there first, and this is how the
    // bridge finds out without a transaction to hold.
    const answer = await swap('r1', 'renamed', 'stale');
    expect(answer.results).toEqual([]);

    const after = await env.DB.prepare('SELECT title FROM probe_rows WHERE id = ?1')
      .bind('r1')
      .first<{ title: string }>();
    expect(after?.title).toBe('first');
  });

  it('matches a NULL through IS, which = would not', async () => {
    // `note` on r2 is NULL. `col = NULL` is NULL, so an equality comparison
    // would never match and every swap on a null column would report a
    // conflict that did not happen. Same three-valued trap as rules/01 G1.
    const withIs = await env.DB.prepare(
      'UPDATE probe_rows SET note = ?1 WHERE id = ?2 AND note IS ?3 RETURNING id, note',
    )
      .bind('filled', 'r2', null)
      .all<Row>();
    expect(withIs.results).toEqual([{ id: 'r2', note: 'filled' }]);

    const withEquals = await env.DB.prepare(
      'UPDATE probe_rows SET note = ?1 WHERE id = ?2 AND note = ?3 RETURNING id, note',
    )
      .bind('again', 'r2', null)
      .all<Row>();
    expect(withEquals.results).toEqual([]);
  });

  it('touches exactly one row, because the key is the whole WHERE', async () => {
    const answer = await env.DB.prepare(
      'UPDATE probe_rows SET title = ?1 WHERE id = ?2 RETURNING id',
    )
      .bind('only', 'r1')
      .all<{ id: string }>();
    expect(answer.results).toHaveLength(1);
    expect(answer.meta.changes).toBe(1);
  });
});

describe('what the catalogue can see about a table', () => {
  it('does not show a generated column at all, so one cannot be edited', async () => {
    // PRAGMA table_info omits generated columns; table_xinfo is the one that
    // lists them. The catalogue asks table_info, so a VIRTUAL column is absent
    // from the columns map rather than present and unwritable. That is the
    // outcome the edit lane wants, and it is worth pinning: switching to
    // table_xinfo for some other reason would quietly make them editable.
    await env.DB.prepare(
      `CREATE TABLE probe_generated (
         id    TEXT PRIMARY KEY NOT NULL,
         body  TEXT NOT NULL,
         size  INTEGER GENERATED ALWAYS AS (length(body)) VIRTUAL
       )`,
    ).run();
    resetCatalogue();

    const catalogue = await getCatalogue(env.DB);
    const table = catalogue.tables.get('probe_generated');
    expect(table).toBeDefined();
    expect([...(table?.columns.keys() ?? [])]).toEqual(['id', 'body']);
  });

  it('reports which columns are the primary key, and says so when there is none', async () => {
    // Addressing a row needs a declared key. A table without one cannot name a
    // row for an edit, and rowid is not a substitute: it moves on VACUUM.
    await env.DB.prepare('CREATE TABLE probe_no_key (a TEXT, b TEXT)').run();
    resetCatalogue();

    const catalogue = await getCatalogue(env.DB);
    const keyed = [...(catalogue.tables.get('probe_rows')?.columns.values() ?? [])]
      .filter((column) => column.primaryKey)
      .map((column) => column.name);
    expect(keyed).toEqual(['id']);

    const unkeyed = [...(catalogue.tables.get('probe_no_key')?.columns.values() ?? [])].filter(
      (column) => column.primaryKey,
    );
    expect(unkeyed).toEqual([]);
  });
});
