/**
 * A policy document on disk, turned into rows in the database.
 *
 * ## One parser, one validator, one catalogue
 *
 * 🔴 This file imports `parseTableDefinition` and `validateTableDefinition` from the
 * engine rather than checking anything itself, and that is the point of it existing.
 * `rules/00` invariant I4 requires a policy touching `$auth.user.*` to be refused
 * **when it is stored**, not when it is read, because a policy that reached the
 * database is a policy some future reader will trust. A second implementation of that
 * check in the CLI would be a second thing to keep correct, and the two would drift in
 * the direction nobody notices: the writer being more permissive than the reader.
 *
 * The same holds for the catalogue. `rules/00` section I6 exists because double-quoted
 * strings are enabled on D1, so a column name that does not exist comes back as a
 * string rather than an error. A slightly different catalogue builder here would not
 * fail loudly. It would silently disagree about which columns are real.
 *
 * ## Why the write is not a transaction, and why that is fine
 *
 * Measured on 2026-08-12: the D1 REST API accepts several statements in one request
 * and rolls them back as a unit, **but refuses bound parameters when there is more
 * than one statement**: `params with multiple statements is not supported`. So the
 * choice was atomicity or bound parameters, and `rules/00` invariant I7 does not
 * allow a value to be concatenated into SQL under any circumstances.
 *
 * So there is no transaction. Instead the order makes every half-finished state a
 * **closed** one:
 *
 *   1. Remove the table from `_exposed_tables`. From here until the last step the
 *      table is not exposed at all, which invariant I1 defines as the safe state.
 *   2. Remove the old binds and policies.
 *   3. Write the new binds and policies.
 *   4. Put the table back in `_exposed_tables`, with the version bumped.
 *
 * A failure at any point leaves the table unexposed rather than exposed with half a
 * policy set. The reader loses access to their own table and is told to run the
 * command again, which is the failure worth having.
 */

import type { Catalogue } from '../src/db/introspect.js';
import { parseTableDefinition } from '../src/policy/parse.js';
import type { PolicyDef, TableDefinition } from '../src/policy/types.js';
import { validateTableDefinition } from '../src/policy/validate.js';

/** One statement and its parameters. Never assembled into a string with values in it. */
export interface Statement {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/**
 * Read a document, and refuse it if the engine would.
 *
 * Two failures are possible here and they are different things. A document that is not
 * JSON is a typo. A document the engine rejects is a policy that would have been
 * wrong, and the message from `PolicyError` says which rule it broke.
 */
export interface PolicyDocument {
  readonly definition: TableDefinition;
  /**
   * The binds exactly as written.
   *
   * ⚠️ Kept from the raw document rather than taken from the parse result, because
   * the parser **expands** binds into the policies that use them and does not carry
   * them through. The registry stores them unexpanded and expands them again on every
   * load, so what goes into `_policy_binds` has to be the original body.
   */
  readonly binds: Readonly<Record<string, unknown>>;
}

export function readPolicyDocument(text: string): PolicyDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new Error(
      `That file is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  const definition = parseTableDefinition(raw);
  const binds = extractBinds(raw);

  // 🔴 Every bind is parsed, including the ones nothing refers to.
  //
  // Parsing the document only exercises the binds some policy actually uses. A bind
  // that is defined and never referenced would be written to the database unchecked,
  // and it could hold `$auth.user.*`. Nothing breaks that day. It breaks the day
  // somebody adds a policy that uses it, and then the registry refuses the whole
  // table at load time, in a deployment, for a reason that points at a file the
  // author edited weeks earlier.
  //
  // Checking one costs a synthetic parse rather than a second implementation of the
  // rules, which is the whole discipline of this file.
  for (const name of Object.keys(binds)) {
    assertBindParses(definition.table, binds, name);
  }

  return { definition, binds };
}

function extractBinds(raw: unknown): Readonly<Record<string, unknown>> {
  if (typeof raw !== 'object' || raw === null) return {};
  const value = (raw as { binds?: unknown }).binds;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Readonly<Record<string, unknown>>;
}

/**
 * Parse one bind on its own, by giving it a policy to belong to.
 *
 * The engine has no entry point that parses a bind in isolation, and adding one to
 * `src/policy/` for the sake of the CLI would widen a security boundary for a
 * convenience. Handing it a document it already knows how to read costs nothing and
 * keeps the rules in one place.
 */
function assertBindParses(
  table: string,
  binds: Readonly<Record<string, unknown>>,
  name: string,
): void {
  parseTableDefinition({
    table,
    enabled: false,
    binds,
    policies: [
      {
        name: `__bind_check_${name}`,
        for: 'select',
        to: ['anon'],
        using: { $bind: name },
        // Required by the parser. Any real column would do; this document is never
        // stored and never reaches a catalogue, so it only has to be well formed.
        columns: ['rowid'],
      },
    ],
  });
}

/**
 * Check the document against the live schema.
 *
 * Separate call from parsing because it needs the database and parsing does not, so a
 * document with a forbidden claim in it is refused before anything is asked of the
 * network.
 */
export function checkAgainstSchema(
  catalogue: Catalogue,
  definition: TableDefinition,
): TableDefinition {
  return validateTableDefinition(catalogue, definition);
}

/** The columns of `_policies`, in the order the insert writes them. */
const POLICY_COLUMNS =
  '"table_name", "name", "operation", "roles", "using_expr", "check_expr", "columns", "set_expr"';

/**
 * A JSON value for a column, or null when the policy does not have that part.
 *
 * `undefined` and the JSON string `"null"` are different things in a column the
 * registry reads back, and getting them confused would turn an absent `check` into a
 * check that is present and empty.
 */
function json(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function policyRow(table: string, policy: PolicyDef): Statement {
  return {
    sql: `INSERT INTO "_policies" (${POLICY_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      table,
      policy.name,
      policy.operation,
      JSON.stringify(policy.roles),
      json(policy.using),
      json(policy.check),
      json(policy.columns),
      json(policy.set),
    ],
  };
}

/**
 * Everything it takes to store the document, in the order it has to happen.
 *
 * The order is the safety mechanism here, so it is built in one place rather than
 * being the order somebody happened to write the calls in. See the note at the top.
 */
export function writeStatements(document: PolicyDocument, nextVersion: number): Statement[] {
  const { definition, binds } = document;
  const table = definition.table;

  const statements: Statement[] = [
    // Closed from here on. Invariant I1: a table absent from `_exposed_tables` is a
    // table nobody can reach, whatever else is or is not in the other two.
    { sql: 'DELETE FROM "_exposed_tables" WHERE "table_name" = ?', params: [table] },
    { sql: 'DELETE FROM "_policy_binds" WHERE "table_name" = ?', params: [table] },
    { sql: 'DELETE FROM "_policies" WHERE "table_name" = ?', params: [table] },
  ];

  for (const [name, expression] of Object.entries(binds)) {
    statements.push({
      sql: 'INSERT INTO "_policy_binds" ("table_name", "name", "expression") VALUES (?, ?, ?)',
      params: [table, name, JSON.stringify(expression)],
    });
  }

  for (const policy of definition.policies) {
    statements.push(policyRow(table, policy));
  }

  // The switch. Nothing before this makes the table reachable, and this is one
  // statement, so there is no state where it is half reachable.
  statements.push({
    sql: 'INSERT INTO "_exposed_tables" ("table_name", "enabled", "version") VALUES (?, ?, ?)',
    params: [table, definition.enabled ? 1 : 0, nextVersion],
  });

  return statements;
}

/**
 * The version to write, given what is already stored.
 *
 * It has to go up on every write and never repeat. The registry caches compiled SQL
 * against `(table, operation, role, version)`, so a version that stayed the same
 * would leave a deployment serving the policy it had before this command ran, with
 * nothing anywhere saying so.
 */
export function nextVersion(current: number | null): number {
  return (current ?? 0) + 1;
}
