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
  /**
   * The parsed form. Used to decide whether the document is allowed, never stored.
   */
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
  /**
   * The policies exactly as written.
   *
   * 🔴 The same reason as `binds`, and it was learned the hard way. An earlier version
   * stored `definition.policies`, which is the **compiled AST**: a `using` written as
   * `{"author_id":{"_eq":"$auth.uid"}}` was stored as
   * `{"kind":"compare","column":"author_id",…}`. `loadRegistry` feeds the stored
   * column straight back into `parseTableDefinition`, which reads the source grammar,
   * so nothing written that way could ever be read back.
   *
   * It fails loudly, which is the one mercy, but it fails for the **whole registry**:
   * one bad row and `/rest/v1/*` answers 500 for every table on the deployment,
   * including tables configured before this command existed.
   *
   * ⚠️ The rule this file now follows without exception: **parse to decide, store the
   * source.** The parse result is an answer to "may this be stored", not a value to
   * store.
   */
  readonly policies: readonly Readonly<Record<string, unknown>>[];
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

  return { definition, binds, policies: extractPolicies(raw) };
}

/**
 * The policy objects as written.
 *
 * Taken by position, and the parse above is what makes that safe: it has already
 * confirmed `policies` is an array of well formed objects with unique names, so
 * `definition.policies[i]` and this array describe the same policy.
 */
function extractPolicies(raw: unknown): readonly Readonly<Record<string, unknown>>[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const value = (raw as { policies?: unknown }).policies;
  if (!Array.isArray(value)) return [];
  return value as readonly Readonly<Record<string, unknown>>[];
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

/**
 * One row, built from the SOURCE policy rather than the parsed one.
 *
 * `parsed` is passed only for the fields the parser normalises and the registry
 * re-derives identically: the name, the operation and the roles are plain strings and
 * arrays either way. Everything that is an expression comes from `source`, because an
 * expression is where the two grammars differ.
 */
function policyRow(
  table: string,
  parsed: PolicyDef,
  source: Readonly<Record<string, unknown>>,
): Statement {
  return {
    sql: `INSERT INTO "_policies" (${POLICY_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      table,
      parsed.name,
      parsed.operation,
      JSON.stringify(parsed.roles),
      json(source['using']),
      json(source['check']),
      json(source['columns']),
      json(source['set']),
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

  for (const [index, policy] of definition.policies.entries()) {
    const source = document.policies[index];
    if (source === undefined) {
      // Cannot happen: the parse produced one entry per source entry. Checked rather
      // than assumed, because the alternative is writing `undefined` into a column
      // the registry reads as a policy.
      throw new Error(`No source policy for "${policy.name}". The document changed under us.`);
    }
    statements.push(policyRow(table, policy, source));
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
 * ⚠️ **This does not invalidate anything today, and an earlier version of this comment
 * said it did.** Measured in `src/policy/registry-cache.test.ts`: `getRegistry` is a
 * bare per-isolate memo, nothing anywhere reads `_exposed_tables.version`, and a
 * fleet-wide invalidation keyed on it is a V7 concern that the registry's own comment
 * is honest about.
 *
 * So what a bump buys right now is a record that the row changed, for a mechanism that
 * does not exist yet and for a person reading `policy list`. What it does not buy is
 * the change taking effect. That happens when a deployment re-reads, which the engine
 * now bounds with `MAX_REGISTRY_AGE_MS` rather than leaving to whenever an isolate
 * recycles. The bound does not read the version either; it just expires.
 *
 * It still goes up on every write, so that a person reading `policy list` can see that
 * something changed.
 *
 * 🔴 **What it is not is a version that never repeats, and an earlier draft of this
 * comment claimed it was.** Measured on 2026-08-12 against a live database: a table at
 * version 2, removed with `policy rm` and applied again, comes back at version **1**.
 * `rm` deletes the row `storedVersion` reads, so the count starts over.
 *
 * That is free today, because nothing reads the number. It is a trap for whoever adds
 * the V7 invalidation, and the trap fails **open**: an isolate holding `posts` at
 * version 3 that compares against a stored version of 1 concludes it is ahead and
 * keeps serving the policy that was deleted. Anything keyed on this needs a counter
 * that outlives the row, or a value that is not a counter at all.
 */
export function nextVersion(current: number | null): number {
  return (current ?? 0) + 1;
}
