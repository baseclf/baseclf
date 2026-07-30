/**
 * The engine's own tables.
 *
 * All three are STRICT with explicit NOT NULL on every key column. That is not
 * decoration. Measured 2026-07-30 (rules/01 section G1): on an ordinary table
 * `id TEXT PRIMARY KEY` accepts NULL and PRAGMA table_info reports it nullable.
 * Only STRICT, or an explicit NOT NULL, closes that. A NULL key in a policy
 * table would mean a policy row that no lookup can find and no predicate can
 * compare against.
 *
 * The `_` prefix is what keeps these off the API. It is checked in two
 * independent places (rule 00, invariant I8): the registry refuses to expose
 * such a table, and the REST router refuses to route to one.
 */

export const POLICY_SCHEMA: readonly string[] = Object.freeze([
  `CREATE TABLE IF NOT EXISTS _exposed_tables (
     table_name TEXT PRIMARY KEY NOT NULL,
     enabled    INTEGER NOT NULL DEFAULT 0,
     version    INTEGER NOT NULL DEFAULT 0
   ) STRICT`,

  `CREATE TABLE IF NOT EXISTS _policy_binds (
     table_name TEXT NOT NULL,
     name       TEXT NOT NULL,
     expression TEXT NOT NULL,
     PRIMARY KEY (table_name, name)
   ) STRICT`,

  `CREATE TABLE IF NOT EXISTS _policies (
     table_name TEXT NOT NULL,
     name       TEXT NOT NULL,
     operation  TEXT NOT NULL,
     roles      TEXT NOT NULL,
     using_expr TEXT NOT NULL,
     check_expr TEXT,
     columns    TEXT NOT NULL,
     PRIMARY KEY (table_name, name)
   ) STRICT`,
]);
