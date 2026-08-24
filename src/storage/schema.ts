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

/**
 * Where the reconciliation pass left off.
 *
 * One row, because there is one walk. It holds a KEY rather than R2's own list
 * cursor, and that is measured rather than stylistic: `startAfter` was probed to
 * be exclusive and to resume a listing exactly (`r2-list-behaviour.test.ts`),
 * while a cursor is an opaque token with no documented lifetime. This value has to
 * survive an hour between cron invocations, so it has to be something whose
 * meaning does not expire.
 *
 * `passes` counts completed walks, and it is the difference between "no drift was
 * found" and "nothing has been looked at yet". Without it a report of zero drift
 * on a bucket the sweep has never reached the end of reads as good news.
 *
 * Declared here so provisioning creates it with the rest. `reconcile.ts` also
 * issues it idempotently before it runs, for the same reason the rate limiter
 * does: that is the floor, not the plan.
 */
export const STORAGE_SWEEP_DDL = `CREATE TABLE IF NOT EXISTS _storage_sweep (
     id         TEXT    PRIMARY KEY NOT NULL,
     after_key  TEXT    NOT NULL,
     passes     INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   ) STRICT`;

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

  // What exists, in a place SQL can reach.
  //
  // This is the whole point of the table rather than a convenience. R2 is not in
  // D1, so without a row here there is no way for any statement to know an object
  // exists, and "join object metadata with application data" is not a thing that
  // can be written at all. An application stores the key in its own column and
  // joins on it.
  //
  // `owner` is nullable because a policy with a literal prefix needs no claim, and
  // an anonymous upload under such a policy has no uid to record. It holds the
  // identity that wrote LAST rather than the one that created: under a shared
  // prefix, whoever writes last owns the bytes, and recording the first writer
  // would be a record of something that is no longer true.
  //
  // Times come from `unixepoch()`, which D1 has and which returns INTEGER.
  //
  // ⚠️ Not because `strftime('%s','now')` would be refused here. That was the
  // reason this comment used to give, citing rules/01 §G7, and §G8 corrected it
  // after measuring: a STRICT column takes a TEXT value it can convert without
  // loss and stores it as an integer, so `strftime` lands in these columns
  // perfectly well. `src/storage/strict-affinity.test.ts` holds the probe.
  //
  // The reason is that `unixepoch()` returns the right type to begin with, so
  // nothing here rests on an implicit conversion a reader cannot see.
  `CREATE TABLE IF NOT EXISTS _storage_objects (
     key          TEXT PRIMARY KEY NOT NULL,
     bucket       TEXT NOT NULL,
     owner        TEXT,
     size_bytes   INTEGER NOT NULL,
     content_type TEXT,
     created_at   INTEGER NOT NULL,
     updated_at   INTEGER NOT NULL
   ) STRICT`,

  // Two indexes, and both are a bill rather than a nicety. D1 charges for rows
  // scanned, not rows returned (rules/01 §D), so a lookup by owner or by bucket
  // without one is a full scan charged on every request that makes it.
  'CREATE INDEX IF NOT EXISTS _storage_objects_owner ON _storage_objects (owner)',
  'CREATE INDEX IF NOT EXISTS _storage_objects_bucket ON _storage_objects (bucket)',

  STORAGE_SWEEP_DDL,
]);
