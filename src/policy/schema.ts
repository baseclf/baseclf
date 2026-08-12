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

/**
 * Held for the length of one `baseclf policy apply`, on one table.
 *
 * 🔴 Debt F3. There is no transaction to be had on D1 (`rules/01` section C), and the
 * REST endpoint refuses bound parameters when a request carries more than one
 * statement, so a policy write is a sequence of single statements. Interleave two of
 * them and the second writer's deletes land between the first writer's deletes and its
 * re-expose, leaving `_policies` holding both sets. Permissive policies OR together, so
 * the effective grant is the union of two documents nobody wrote, which is wider than
 * either author intended. Measured in `src/policy/registry-cache.test.ts`.
 *
 * ⚠️ **The lock alone does not close it, and a lock that looked sufficient was the
 * first design.** Whoever holds it can still be delayed past the point where its
 * expiry lets somebody else in. What closes it is the expose being guarded on still
 * holding the lock, so a writer that was overtaken exposes nothing rather than exposing
 * its half. See `writeStatements` in `cli/policy-document.ts`.
 *
 * ⚠️ **The other design, and why it is not this one.** Writing each apply under its own
 * generation and swapping a pointer needs no lock and no expiry, and it is what a
 * control plane with several people editing at once should have. It also means a column
 * on `_policies`, a migration for rows written before it, orphan cleanup, and a change
 * to `loadRegistry`, which is the most security-critical function in the product. That
 * is V7's problem, when editing through the Studio makes concurrent writers normal
 * rather than a race between two administrators on one table.
 */
export const POLICY_LOCK_TABLE_DDL = `CREATE TABLE IF NOT EXISTS _policy_lock (
     table_name  TEXT NOT NULL PRIMARY KEY,
     holder      TEXT NOT NULL,
     acquired_at INTEGER NOT NULL
   ) STRICT`;

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
     set_expr   TEXT,
     PRIMARY KEY (table_name, name)
   ) STRICT`,

  POLICY_LOCK_TABLE_DDL,
]);
