/**
 * What an operator changed through a tool, kept where they can query it.
 *
 * Written for the lanes where a person acts on their own deployment with their
 * own credential: `baseclf policy apply` and the bridge behind the Studio. Those
 * lanes are the ones with no other record. A request through the REST API leaves
 * a policy decision and a log line; an operator overwriting a row leaves nothing
 * at all, and the project has already had one of those go unnoticed. A probe
 * mangled by a shell overwrote four live policy documents through the bridge's
 * `/apply`, answered 200, and was found days later by accident.
 *
 * ## What it records, and the one thing it deliberately does not
 *
 * When, what kind of change, which table, which row, which column, and which
 * lane. 🔴 **Not the old value and not the new one.**
 *
 * That is a real trade and it costs something: this answers "who changed the
 * title of p_1 on Tuesday" and cannot answer "what did it say before". The
 * reasoning is that the alternative keeps a second copy of customer data in a
 * table nobody thinks about, outliving every deletion and every correction made
 * in the table it shadows. An audit trail that quietly becomes the last place a
 * deleted value survives is a liability handed to the operator without being
 * asked for. The row is named precisely enough to find in a Time Travel restore,
 * which is where a previous value actually lives.
 *
 * ⚠️ **The primary key is the exception, and it is not a small one.** Naming a
 * row means writing its key down, so a table keyed by something meaningful puts
 * that meaning here: a `users` table keyed by email logs the email. There is no
 * version of "which row changed" that avoids this. It is called out so that an
 * operator choosing a key knows this table is one of the places it lands.
 *
 * ⚠️ Invariant I9 says log the SQL and not the parameters, and it is about the
 * platform log rather than this table. The distinction is that this data is the
 * operator's own and stays in their own database. The column list above is
 * narrower than I9 would require anyway.
 *
 * ## Why it may grow without a sweep
 *
 * A paid D1 database stops at 10 GB and the docs say that cannot be raised
 * (`rules/01` section B), so an unbounded table deserves an argument rather than
 * a shrug.
 *
 * ⭐ The argument is that **every writer here is a person at a keyboard**, not a
 * request path. One operator making a hundred changes a day for ten years writes
 * about 365,000 rows, which at the size of these columns is tens of megabytes.
 * Nothing in the request path writes here, and that is the load-bearing part: if
 * this is ever called from a route that serves users, the argument is gone and
 * the table needs a retention pass before that lands.
 */

import type { CompiledStatement } from './guards.js';
import { assertExecutable } from './guards.js';

/**
 * STRICT with an explicit NOT NULL key, like every engine table.
 *
 * `id INTEGER PRIMARY KEY` is a rowid alias, so SQLite fills it in and an insert
 * never has to carry one. `NOT NULL` is still written out: measured in
 * `rules/01` section G1, an ordinary `TEXT PRIMARY KEY` accepts NULL, and
 * spelling the constraint on every key in this schema means nobody has to
 * remember which declaration is the exception.
 *
 * `at` comes from `unixepoch()`, which D1 has and which returns INTEGER.
 * `strftime('%s','now')` returns TEXT, and while a STRICT table converts that
 * without complaining (measured, section G8), relying on a conversion the reader
 * cannot see is how a column quietly starts holding something else.
 */
export const AUDIT_LOG_DDL = `CREATE TABLE IF NOT EXISTS _audit_log (
     id       INTEGER PRIMARY KEY NOT NULL,
     at       INTEGER NOT NULL,
     lane     TEXT    NOT NULL,
     action   TEXT    NOT NULL,
     subject  TEXT    NOT NULL,
     detail   TEXT
   ) STRICT`;

/**
 * Reading the log means reading it newest first, and that is a scan without this.
 *
 * D1 bills rows scanned rather than rows returned (`rules/01` section D), so the
 * index is a bill rather than a nicety, the same argument the storage tables
 * make for theirs.
 */
export const AUDIT_LOG_INDEX = 'CREATE INDEX IF NOT EXISTS _audit_log_at ON _audit_log (at DESC)';

export const AUDIT_SCHEMA: readonly string[] = Object.freeze([AUDIT_LOG_DDL, AUDIT_LOG_INDEX]);

/** Which tool made the change. All that is actually known: there is no user here. */
export type AuditLane = 'cli' | 'bridge';

/**
 * What happened, as a closed set.
 *
 * Closed so that reading the log is a matter of knowing six words rather than
 * grepping for whatever each caller happened to pass, and so that a new kind of
 * change has to be added here, where this comment is, rather than appearing in
 * the data one day.
 */
export type AuditAction = 'policy_apply' | 'policy_remove' | 'row_edit';

export interface AuditEntry {
  readonly lane: AuditLane;
  readonly action: AuditAction;
  /** What was acted on: a table name, or a table and the row within it. */
  readonly subject: string;
  /** Which column, or which rule. Never a value. */
  readonly detail?: string;
}

/**
 * The insert for one entry.
 *
 * A statement rather than a call, so the caller decides when it runs and a test
 * can hold the text. `unixepoch()` rather than a timestamp from the caller,
 * because the database's clock is the one that agrees with itself: a Worker's
 * clock is frozen between I/O and there is no reason for two lanes on two
 * machines to disagree about the order of their own entries.
 */
export function appendAuditStatement(entry: AuditEntry): CompiledStatement {
  const statement: CompiledStatement = {
    sql:
      'INSERT INTO _audit_log (at, lane, action, subject, detail) ' +
      'VALUES (unixepoch(), ?1, ?2, ?3, ?4)',
    parameters: [entry.lane, entry.action, entry.subject, entry.detail ?? null],
  };
  assertExecutable(statement);
  return statement;
}

/**
 * How a row is named in `subject`, so two lanes name the same row the same way.
 *
 * The key is rendered rather than stored structurally because this column is
 * read by a person looking for a change they remember making, not joined
 * against. Composite keys are joined in the catalogue's own order, which is the
 * order the edit statement binds them in.
 */
export function auditSubjectForRow(table: string, key: Readonly<Record<string, unknown>>): string {
  const parts = Object.entries(key).map(([name, value]) => `${name}=${String(value)}`);
  return parts.length === 0 ? table : `${table}[${parts.join(',')}]`;
}
