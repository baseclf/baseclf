/**
 * The tables that hold storage policy.
 *
 * Same shape and same reasoning as `src/policy/schema.ts`: STRICT with explicit
 * NOT NULL on every key column, because on an ordinary table `TEXT PRIMARY KEY`
 * accepts NULL and reports itself nullable (measured, rules/01 §G1). A NULL key
 * here would be a policy row no lookup can find.
 *
 * The `_` prefix is what keeps these off the REST API, and rule 00 invariant I8
 * asks for that to be enforced in two independent places. Both already exist and
 * neither needed changing for storage: the policy registry refuses to expose a
 * table with this prefix, and the REST router refuses to route to one. These
 * tables inherit that protection by being named this way, which is the point of
 * the convention.
 */

export const STORAGE_SCHEMA: readonly string[] = Object.freeze([
  `CREATE TABLE IF NOT EXISTS _storage_buckets (
     bucket  TEXT PRIMARY KEY NOT NULL,
     enabled INTEGER NOT NULL DEFAULT 0,
     version INTEGER NOT NULL DEFAULT 0
   ) STRICT`,

  // `max_size_bytes` and `mime_types` are nullable because absent means the
  // deployment set no limit, which is a different statement from a limit of zero.
  // `policy.ts` refuses a policy that carries either on an operation they cannot
  // apply to, so a NULL here is the only way to say "not applicable".
  `CREATE TABLE IF NOT EXISTS _storage_policies (
     bucket         TEXT NOT NULL,
     name           TEXT NOT NULL,
     operation      TEXT NOT NULL,
     roles          TEXT NOT NULL,
     prefix         TEXT NOT NULL,
     max_size_bytes INTEGER,
     mime_types     TEXT,
     PRIMARY KEY (bucket, name)
   ) STRICT`,
]);
