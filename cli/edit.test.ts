/**
 * The edit statement, held exactly.
 *
 * Same reasoning as `browse.test.ts`: DQS is on, so a wrong identifier inside
 * this SQL comes back as a string rather than an error, and a golden assertion
 * on the emitted statement is the cheap layer that catches a drift before a
 * database sees it. It matters more here than for browsing, because a wrong
 * identifier in a WHERE on a write does not return the wrong rows, it changes
 * the wrong ones.
 *
 * The refusals get both directions: what is refused, and that the accepted
 * shape still comes out whole afterwards.
 */

import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Catalogue, ColumnInfo, TableInfo } from '../src/db/introspect.js';
import { type EditRequest, editStatement } from './edit.js';

function column(
  name: string,
  overrides: Partial<Pick<ColumnInfo, 'type' | 'notNull' | 'primaryKey'>> = {},
): ColumnInfo {
  return { name, type: 'TEXT', notNull: false, primaryKey: false, hasDefault: false, ...overrides };
}

function catalogueOf(...tables: TableInfo[]): Catalogue {
  const map = new Map(tables.map((entry) => [entry.name, entry]));
  return {
    tables: map,
    hasTable: (name) => map.has(name),
    hasColumn: (table, name) => map.get(table)?.columns.has(name) ?? false,
    isIndexed: () => false,
  };
}

function table(
  name: string,
  columns: ColumnInfo[],
  overrides: Partial<Pick<TableInfo, 'isSystem' | 'withoutRowid'>> = {},
): TableInfo {
  return {
    name,
    columns: new Map(columns.map((entry) => [entry.name, entry])),
    indexes: [],
    foreignKeys: [],
    isSystem: false,
    withoutRowid: false,
    ...overrides,
  };
}

const POSTS = table('posts', [
  column('id', { primaryKey: true, notNull: true }),
  column('title'),
  column('views', { type: 'INTEGER' }),
]);

function edit(overrides: Partial<EditRequest> = {}, catalogue = catalogueOf(POSTS)) {
  return editStatement(catalogue, {
    table: 'posts',
    key: { id: 'p_1' },
    column: 'title',
    expected: 'before',
    next: 'after',
    ...overrides,
  });
}

describe('the statement, golden', () => {
  it('swaps one column of one row, comparing the old value in the WHERE', () => {
    expect(edit()).toEqual({
      ok: true,
      sql:
        'UPDATE "posts" SET "title" = ?1 WHERE "id" = ?2 AND "title" IS ?3 ' +
        'RETURNING "id", "title", "views"',
      parameters: ['after', 'p_1', 'before'],
    });
  });

  it('uses IS for the old value, so a null one can be compared at all', () => {
    // `col = NULL` is NULL rather than true, so an equality here would report a
    // concurrent change on every column that is currently null while nothing had
    // changed. Measured on D1 in src/db/row-edit-probe.test.ts.
    const plan = edit({ expected: null });
    expect(plan.ok && plan.sql).toContain('"title" IS ?3');
    expect(plan.ok && plan.sql).not.toContain('"title" = ?3');
    expect(plan.ok && plan.parameters).toEqual(['after', 'p_1', null]);
  });

  it('names every key column of a composite key, in the catalogue order', () => {
    const composite = table('memberships', [
      column('org_id', { primaryKey: true, notNull: true }),
      column('user_id', { primaryKey: true, notNull: true }),
      column('role'),
    ]);

    const plan = editStatement(catalogueOf(composite), {
      table: 'memberships',
      key: { org_id: 'o_1', user_id: 'u_1' },
      column: 'role',
      expected: 'member',
      next: 'admin',
    });

    expect(plan).toEqual({
      ok: true,
      sql:
        'UPDATE "memberships" SET "role" = ?1 WHERE "org_id" = ?2 AND "user_id" = ?3 ' +
        'AND "role" IS ?4 RETURNING "org_id", "user_id", "role"',
      parameters: ['admin', 'o_1', 'u_1', 'member'],
    });
  });

  it('escapes a quote in an identifier rather than ending the identifier', () => {
    const awkward = table('posts', [
      column('id', { primaryKey: true, notNull: true }),
      column('the"title'),
    ]);
    const plan = editStatement(catalogueOf(awkward), {
      table: 'posts',
      key: { id: 'p_1' },
      column: 'the"title',
      expected: 'a',
      next: 'b',
    });
    expect(plan.ok && plan.sql).toContain('SET "the""title" = ?1');
  });
});

describe('a row that cannot be named', () => {
  it('refuses a table with no declared primary key', () => {
    // rowid is not an answer: it moves when the database is vacuumed, so a key
    // built from it addresses a different row later.
    const keyless = table('notes', [column('a'), column('b')]);
    const plan = editStatement(catalogueOf(keyless), {
      table: 'notes',
      key: {},
      column: 'a',
      expected: '1',
      next: '2',
    });
    expect(plan).toEqual({ ok: false, refusal: expect.stringContaining('no primary key') });
  });

  it('refuses half of a composite key, which would address more than one row', () => {
    // The one way this lane could touch something the operator did not point at.
    const composite = table('memberships', [
      column('org_id', { primaryKey: true, notNull: true }),
      column('user_id', { primaryKey: true, notNull: true }),
      column('role'),
    ]);
    const plan = editStatement(catalogueOf(composite), {
      table: 'memberships',
      key: { org_id: 'o_1' },
      column: 'role',
      expected: 'member',
      next: 'admin',
    });
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.refusal).toContain('user_id');
  });

  it('refuses a key that carries something which is not a key column', () => {
    const plan = edit({ key: { id: 'p_1', title: 'smuggled' } });
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.refusal).toContain('Not a key column');
  });

  it('refuses a null in the key, which names no row', () => {
    const plan = edit({ key: { id: null } });
    expect(plan.ok).toBe(false);
  });
});

describe('what may not be changed', () => {
  it('refuses a key column, because moving a row is not editing it', () => {
    const plan = edit({ column: 'id', expected: 'p_1', next: 'p_2' });
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.refusal).toContain('primary key');
  });

  it('refuses engine tables by name and by the catalogue flag, independently', () => {
    // Invariant I8 wants two layers that do not fail together, so both are
    // exercised: `user` is refused on its name against a catalogue that does not
    // even list it, and a table flagged isSystem is refused under an ordinary
    // name that the name check would pass.
    const byName = editStatement(catalogueOf(POSTS), {
      table: 'user',
      key: { id: 'u_1' },
      column: 'email',
      expected: 'a@b.test',
      next: 'c@d.test',
    });
    expect(!byName.ok && byName.refusal).toContain('Engine tables');

    const flagged = table('looks_ordinary', [column('id', { primaryKey: true }), column('note')], {
      isSystem: true,
    });
    const byFlag = editStatement(catalogueOf(flagged), {
      table: 'looks_ordinary',
      key: { id: '1' },
      column: 'note',
      expected: 'a',
      next: 'b',
    });
    expect(!byFlag.ok && byFlag.refusal).toContain('Engine tables');
  });

  it('refuses a table or column the catalogue has never heard of, by exact match', () => {
    // DQS again: a name that is close but not identical must not reach the
    // statement, because there it would be a string rather than an error.
    expect(edit({ table: 'post' }).ok).toBe(false);
    expect(edit({ column: 'titel' }).ok).toBe(false);
    expect(edit({ column: 'TITLE' }).ok).toBe(false);
  });
});

describe('the value, checked before D1 is asked', () => {
  it('refuses text for a column declared to hold whole numbers', () => {
    // A table that is not STRICT would apply affinity and store something, so
    // this cannot be left to the database to notice.
    const plan = edit({ column: 'views', expected: 1, next: '12' });
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.refusal).toContain('whole numbers');
  });

  it('accepts a whole number there, and keeps it a number in the parameters', () => {
    const plan = edit({ column: 'views', expected: 1, next: 12 });
    expect(plan.ok && plan.parameters).toEqual([12, 'p_1', 1]);
  });

  it('refuses a fraction for an integer column', () => {
    expect(edit({ column: 'views', expected: 1, next: 12.5 }).ok).toBe(false);
  });

  it('refuses a number for a column declared to hold text', () => {
    expect(edit({ next: 42 }).ok).toBe(false);
  });

  it('refuses null on a NOT NULL column, and allows it otherwise', () => {
    const strict = table('posts', [
      column('id', { primaryKey: true, notNull: true }),
      column('title', { notNull: true }),
      column('note'),
    ]);
    expect(editStatement(catalogueOf(strict), { ...request(), next: null }).ok).toBe(false);
    expect(
      editStatement(catalogueOf(strict), { ...request(), column: 'note', next: null }).ok,
    ).toBe(true);
  });

  it('refuses a blob column outright, since a text field cannot carry bytes', () => {
    const withBlob = table('files', [
      column('id', { primaryKey: true, notNull: true }),
      column('body', { type: 'BLOB' }),
    ]);
    const plan = editStatement(catalogueOf(withBlob), {
      table: 'files',
      key: { id: 'f_1' },
      column: 'body',
      expected: null,
      next: 'not really bytes',
    });
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.refusal).toContain('binary');
  });

  it('takes anything for a column the schema declared no type for', () => {
    const untyped = table('loose', [
      column('id', { primaryKey: true, notNull: true }),
      column('anything', { type: '' }),
    ]);
    const base = { table: 'loose', key: { id: '1' }, column: 'anything', expected: null };
    expect(editStatement(catalogueOf(untyped), { ...base, next: 'text' }).ok).toBe(true);
    expect(editStatement(catalogueOf(untyped), { ...base, next: 7 }).ok).toBe(true);
  });
});

function request(): EditRequest {
  return { table: 'posts', key: { id: 'p_1' }, column: 'title', expected: 'before', next: 'after' };
}

/**
 * The statement run, not just spelled.
 *
 * Everything above compares strings, which catches a drift but proves nothing
 * about what D1 does with the result. These take the plan this file produces
 * and execute it, so the golden text and the behaviour cannot part company.
 * The compare-and-swap conflict is the one worth running: it is the whole
 * concurrency answer, and it is the branch that has to write nothing.
 */
describe('the statement, executed', () => {
  const LIVE = table('edit_probe', [
    column('id', { primaryKey: true, notNull: true }),
    column('title'),
    column('views', { type: 'INTEGER' }),
  ]);

  async function seed(): Promise<void> {
    await env.DB.prepare('DROP TABLE IF EXISTS edit_probe').run();
    await env.DB.prepare(
      'CREATE TABLE edit_probe (id TEXT PRIMARY KEY NOT NULL, title TEXT, views INTEGER) STRICT',
    ).run();
    await env.DB.prepare(
      "INSERT INTO edit_probe (id, title, views) VALUES ('p_1', 'before', 3), ('p_2', NULL, 0)",
    ).run();
  }

  beforeEach(seed);

  async function run(request: EditRequest) {
    const plan = editStatement(catalogueOf(LIVE), request);
    if (!plan.ok) throw new Error(`refused: ${plan.refusal}`);
    return env.DB.prepare(plan.sql)
      .bind(...plan.parameters)
      .all<Record<string, unknown>>();
  }

  const base: EditRequest = {
    table: 'edit_probe',
    key: { id: 'p_1' },
    column: 'title',
    expected: 'before',
    next: 'after',
  };

  it('writes the row and hands back its post-image', async () => {
    const answer = await run(base);
    expect(answer.results).toEqual([{ id: 'p_1', title: 'after', views: 3 }]);
  });

  it('writes nothing when somebody else changed the value first', async () => {
    await env.DB.prepare("UPDATE edit_probe SET title = 'theirs' WHERE id = 'p_1'").run();

    const answer = await run(base);
    expect(answer.results).toEqual([]);

    // The row keeps their value. A caller told "no rows" must be able to trust
    // that nothing was written, not just that nothing was returned.
    const after = await env.DB.prepare("SELECT title FROM edit_probe WHERE id = 'p_1'").first<{
      title: string;
    }>();
    expect(after?.title).toBe('theirs');
  });

  it('compares a null old value, which is the case = would silently never match', async () => {
    const answer = await run({ ...base, key: { id: 'p_2' }, expected: null, next: 'filled' });
    expect(answer.results).toEqual([{ id: 'p_2', title: 'filled', views: 0 }]);
  });

  it('leaves every other row alone', async () => {
    await run(base);
    const others = await env.DB.prepare("SELECT title FROM edit_probe WHERE id = 'p_2'").first<{
      title: string | null;
    }>();
    expect(others?.title).toBeNull();
  });

  it('sends a number as a number, so a STRICT integer column accepts it', async () => {
    // The value is typed before it is bound, so this never becomes the string
    // "9" landing in an INTEGER column and being converted on the way in.
    const answer = await run({ ...base, column: 'views', expected: 3, next: 9 });
    expect(answer.results).toEqual([{ id: 'p_1', title: 'before', views: 9 }]);
  });
});
