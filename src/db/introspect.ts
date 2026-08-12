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
import { isolateMemo } from '../utils/memo.js';
import type { D1Executor } from './dialect.js';
import { assertExecutable } from './guards.js';

/** Tables starting with `_` are ours and are never reachable through the API. */
export const SYSTEM_TABLE_PREFIX = '_';

/**
 * Every table the identity provider owns.
 *
 * 🔴 These are engine tables that do not look like engine tables. Invariant I8
 * protects the rest by naming convention, and Better Auth does not follow it, so
 * for a while every one of them was reachable: measured on the live deployment
 * on 2026-08-12, `GET /_schema` with no token answered `user`, `session`,
 * `account`, `verification`, `jwks`. Nothing was hiding them because the only
 * filter anywhere asked whether the name started with an underscore.
 *
 * What they hold is the argument for treating them as ours: `account` carries
 * provider tokens and password hashes, `session` carries session tokens, and
 * `jwks` carries the signing keys. A deployment that exposes one through a
 * policy has handed out the credentials the rest of the engine is built on.
 *
 * ⚠️ Anyone who wants a public profile writes a `profiles` table of their own and
 * joins to it. That is the same answer Supabase gives, and it keeps the identity
 * provider's storage from being an API surface.
 *
 * This list lives here rather than beside the migration that creates it because
 * the catalogue is the one thing every path already goes through. `src/auth`
 * re-exports it, and `auth/bootstrap.test.ts` holds it against what a real
 * migration reports on a blank database, so a plugin that brings a new table
 * turns into a failing test rather than into a new hole of this shape.
 */
export const AUTH_TABLES: readonly string[] = Object.freeze([
  'user',
  'session',
  'account',
  'verification',
  'jwks',
]);

const AUTH_TABLE_SET: ReadonlySet<string> = new Set(AUTH_TABLES);

/**
 * Whether a name belongs to the engine, decided from the name alone.
 *
 * ⭐ The point of taking a string rather than a `TableInfo` is that this answers
 * without the catalogue. Invariant I8 asks for independent checks, and a second
 * check that reads `isSystem` off the same catalogue entry is not independent of
 * the first: one wrong flag and both fall together. Callers pair this with
 * `isSystem` so a table the catalogue has never heard of cannot slip past on the
 * strength of being unknown.
 */
export function isReservedTableName(name: string): boolean {
  return name.startsWith(SYSTEM_TABLE_PREFIX) || AUTH_TABLE_SET.has(name);
}

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
  /**
   * True for a table the engine owns, by `isReservedTableName`. Never
   * API-reachable.
   *
   * ⚠️ Wider than "starts with `_`", which is what it used to mean: the identity
   * provider's tables are ours too and are not named that way.
   */
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
      isSystem: isReservedTableName(entry.name),
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
 *
 * 🔴 This was `cached ??= introspect(executor)`, which keeps a **rejected** promise
 * and never replaces it. Of the places that had that bug this is the worst, and it
 * is not the one that got reported: introspection is PRAGMA sweeps, so it fails for
 * reasons that have nothing to do with the data, such as a timeout or the six
 * connection limit in `rules/02` section A. One transient error and the isolate can
 * never read a schema again. See `utils/memo.ts`.
 */
const memo = isolateMemo<Catalogue>();

export function getCatalogue(executor: D1Executor): Promise<Catalogue> {
  return memo.get(() => introspect(executor));
}

/** Drop the memo. Call after a migration, and in tests. */
export function resetCatalogue(): void {
  memo.reset();
}
