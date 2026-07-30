/**
 * Reads the real shape of the database through PRAGMA and freezes it into a
 * catalogue.
 *
 * This is the foundation of identifier safety. Double-quoted string literals
 * are enabled on D1: `SELECT "no_such_column"` returns the string
 * "no_such_column" for every row instead of raising. Verified on a remote
 * database, 2026-07-29.
 *
 * So SQLite will not catch a bad identifier for us. Every table and column name
 * that reaches a query must be matched against this catalogue exactly,
 * character for character. No prefix matching, no regex-only validation.
 *
 * All four PRAGMAs used here were confirmed working on the same date.
 */

import { BaseclfError } from '../utils/errors.js';
import type { D1Executor } from './dialect.js';
import { assertExecutable } from './guards.js';

/** Tables starting with `_` are ours and are never reachable through the API. */
export const SYSTEM_TABLE_PREFIX = '_';

/** Internal bookkeeping we never expose or introspect. */
const INTERNAL_TABLE_PATTERN = /^(sqlite_|_cf_|d1_)/;

export interface ColumnInfo {
  readonly name: string;
  /** Declared type as written in the schema. Empty for an untyped column. */
  readonly type: string;
  readonly notNull: boolean;
  readonly primaryKey: boolean;
  readonly hasDefault: boolean;
}

export interface IndexInfo {
  readonly name: string;
  readonly unique: boolean;
  /** Indexed columns in order. An expression index yields an empty entry. */
  readonly columns: readonly string[];
}

export interface ForeignKeyInfo {
  readonly column: string;
  readonly referencesTable: string;
  readonly referencesColumn: string;
}

export interface TableInfo {
  readonly name: string;
  readonly columns: ReadonlyMap<string, ColumnInfo>;
  readonly indexes: readonly IndexInfo[];
  readonly foreignKeys: readonly ForeignKeyInfo[];
  /** True when the name starts with `_`. Such a table is never API-reachable. */
  readonly isSystem: boolean;
}

export interface Catalogue {
  readonly tables: ReadonlyMap<string, TableInfo>;

  /** Exact match, case sensitive. The only sanctioned way to trust a table name. */
  hasTable(name: string): boolean;
  /** Exact match on both parts. The only sanctioned way to trust a column name. */
  hasColumn(table: string, column: string): boolean;
  /** True when any index leads with this column, which is what the planner can use. */
  isIndexed(table: string, column: string): boolean;
}

interface PragmaTableListRow {
  name: string;
  type: string;
}
interface PragmaTableInfoRow {
  name: string;
  type: string;
  notnull: number;
  pk: number;
  dflt_value: string | null;
}
interface PragmaIndexListRow {
  name: string;
  unique: number;
}
interface PragmaIndexInfoRow {
  name: string | null;
}
interface PragmaForeignKeyListRow {
  table: string;
  from: string;
  to: string | null;
}

async function pragma<R>(executor: D1Executor, statement: string): Promise<R[]> {
  // These statements are built from PRAGMA output, never from a request, so
  // the guard passes trivially. It runs anyway: "every path to D1 is guarded"
  // is a stronger invariant than "every path except this one", and the day
  // someone adds a parameter here it will already be checked.
  assertExecutable({ sql: statement, parameters: [] });

  const result = await executor.prepare(statement).all<R>();
  return result.results ?? [];
}

/**
 * PRAGMA takes an identifier, not a bound parameter, so the table name is
 * interpolated. It only ever comes from `PRAGMA table_list` on the line above,
 * never from a request. Quoting is belt and braces.
 */
function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export async function introspect(executor: D1Executor): Promise<Catalogue> {
  let tableList: PragmaTableListRow[];
  try {
    tableList = await pragma<PragmaTableListRow>(executor, 'PRAGMA table_list');
  } catch (cause) {
    throw new BaseclfError('D1_QUERY_FAILED', 500, {
      message: 'Could not read the database schema.',
      detail: 'PRAGMA table_list failed.',
      cause,
    });
  }

  const tables = new Map<string, TableInfo>();

  for (const entry of tableList) {
    if (entry.type !== 'table') continue;
    if (INTERNAL_TABLE_PATTERN.test(entry.name)) continue;

    const quoted = quoteIdentifier(entry.name);

    const [columnRows, indexRows, fkRows] = await Promise.all([
      pragma<PragmaTableInfoRow>(executor, `PRAGMA table_info(${quoted})`),
      pragma<PragmaIndexListRow>(executor, `PRAGMA index_list(${quoted})`),
      pragma<PragmaForeignKeyListRow>(executor, `PRAGMA foreign_key_list(${quoted})`),
    ]);

    const columns = new Map<string, ColumnInfo>();
    for (const row of columnRows) {
      columns.set(row.name, {
        name: row.name,
        type: row.type,
        notNull: row.notnull === 1,
        primaryKey: row.pk > 0,
        hasDefault: row.dflt_value !== null,
      });
    }

    const indexes: IndexInfo[] = [];
    for (const row of indexRows) {
      const members = await pragma<PragmaIndexInfoRow>(
        executor,
        `PRAGMA index_info(${quoteIdentifier(row.name)})`,
      );
      indexes.push({
        name: row.name,
        unique: row.unique === 1,
        columns: members.map((member) => member.name ?? ''),
      });
    }

    tables.set(entry.name, {
      name: entry.name,
      columns,
      indexes,
      foreignKeys: fkRows.map((row) => ({
        column: row.from,
        referencesTable: row.table,
        // A null `to` means the reference points at the target's primary key.
        referencesColumn: row.to ?? 'rowid',
      })),
      isSystem: entry.name.startsWith(SYSTEM_TABLE_PREFIX),
    });
  }

  return {
    tables,
    hasTable: (name) => tables.has(name),
    hasColumn: (table, column) => tables.get(table)?.columns.has(column) ?? false,
    isIndexed: (table, column) => {
      const info = tables.get(table);
      if (info === undefined) return false;
      if (info.columns.get(column)?.primaryKey === true) return true;
      // Only the leading column of an index is generally usable on its own.
      return info.indexes.some((index) => index.columns[0] === column);
    },
  };
}

/**
 * Per-isolate memo.
 *
 * Deliberately not a module-scope eager call: the Workers startup CPU budget is
 * one second, and schema reads belong inside `fetch`, not in global scope.
 */
let cached: Promise<Catalogue> | null = null;

export function getCatalogue(executor: D1Executor): Promise<Catalogue> {
  cached ??= introspect(executor);
  return cached;
}

/** Drop the memo. Call after a migration, and in tests. */
export function resetCatalogue(): void {
  cached = null;
}
