/**
 * The browse statement, held exactly.
 *
 * DQS is on, so a wrong identifier inside this SQL would come back as a
 * string rather than an error; golden assertions on the emitted statement are
 * the cheap layer that catches a drift before a database ever sees it. The
 * refusals get both directions: what is refused, and that the accepted shape
 * still comes out whole.
 */

import { describe, expect, it } from 'vitest';

import type { Catalogue, ColumnInfo, TableInfo } from '../src/db/introspect.js';
import { BROWSE_PAGE_SIZE, browseStatement, MAX_BROWSE_OFFSET, MAX_BROWSE_SCAN } from './browse.js';

function column(name: string, primaryKey = false): ColumnInfo {
  return { name, type: 'TEXT', notNull: false, primaryKey, hasDefault: false };
}

function catalogueOf(...tables: TableInfo[]): Catalogue {
  const map = new Map(tables.map((table) => [table.name, table]));
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

describe('the statement, golden', () => {
  it('reads a plain table newest first, by rowid, with both numbers bound', () => {
    const plan = browseStatement(
      catalogueOf(table('posts', [column('id', true), column('title')])),
      'posts',
      100,
    );

    // Bare rowid on purpose: double-quoted it would be a string literal under
    // DQS on a WITHOUT ROWID table, and ORDER BY a constant sorts nothing.
    expect(plan).toEqual({
      ok: true,
      sql: 'SELECT "id", "title" FROM "posts" ORDER BY rowid DESC LIMIT ? OFFSET ?',
      parameters: [BROWSE_PAGE_SIZE, 100],
    });
  });

  it('orders a WITHOUT ROWID table by its whole primary key, descending', () => {
    const plan = browseStatement(
      catalogueOf(
        table('events', [column('tenant', true), column('id', true), column('note')], {
          withoutRowid: true,
        }),
      ),
      'events',
      0,
    );

    expect(plan).toEqual({
      ok: true,
      sql: 'SELECT "tenant", "id", "note" FROM "events" ORDER BY "tenant" DESC, "id" DESC LIMIT ? OFFSET ?',
      parameters: [BROWSE_PAGE_SIZE, 0],
    });
  });

  it('escapes a double quote inside an identifier', () => {
    const plan = browseStatement(catalogueOf(table('odd', [column('we"ird', true)])), 'odd', 0);

    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.sql).toContain('"we""ird"');
  });
});

describe('the refusals', () => {
  const application = catalogueOf(table('posts', [column('id', true)]));

  it('refuses every engine table by name, before the catalogue is consulted', () => {
    for (const name of ['_policies', '_exposed_tables', 'user', 'session', 'account', 'jwks']) {
      const plan = browseStatement(catalogueOf(), name, 0);
      expect(plan.ok).toBe(false);
      if (!plan.ok) expect(plan.refusal).toContain('CLI');
    }
  });

  it('refuses a catalogue entry flagged as the engine even under an ordinary name', () => {
    // The second, independent I8 layer: if the name list ever drifts, the
    // catalogue flag still refuses, and this test tells that layer apart from
    // dead code.
    const flagged = catalogueOf(table('looks_normal', [column('id', true)], { isSystem: true }));
    const plan = browseStatement(flagged, 'looks_normal', 0);

    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.refusal).toContain('CLI');
  });

  it('refuses a table the catalogue does not have, by exact match', () => {
    for (const name of ['post', 'Posts', 'posts_extra']) {
      expect(browseStatement(application, name, 0).ok).toBe(false);
    }
    expect(browseStatement(application, 'posts', 0).ok).toBe(true);
  });

  it('refuses an offset that is not a whole non-negative number', () => {
    for (const offset of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const plan = browseStatement(application, 'posts', offset);
      expect(plan.ok).toBe(false);
      if (!plan.ok) expect(plan.refusal).toContain('whole number');
    }
  });

  it('refuses a page past the scan ceiling, and names the bill', () => {
    const past = browseStatement(application, 'posts', MAX_BROWSE_OFFSET + 1);
    expect(past.ok).toBe(false);
    if (!past.ok) expect(past.refusal).toContain(String(MAX_BROWSE_SCAN));

    // The boundary itself is allowed: the ceiling is on rows scanned, and the
    // last page inside it still costs exactly MAX_BROWSE_SCAN.
    expect(browseStatement(application, 'posts', MAX_BROWSE_OFFSET).ok).toBe(true);
  });
});
