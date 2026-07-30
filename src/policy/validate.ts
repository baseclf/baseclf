/**
 * Semantic rules that need to know what the database actually looks like.
 *
 * parse.ts decides whether a document is well formed. This file decides whether
 * it means anything: every table and column is resolved against the catalogue,
 * character for character, and a policy that names something that is not there
 * is rejected before it can ever be stored.
 *
 * That last part carries more weight on D1 than it would elsewhere. Double
 * quoted string literals are enabled, so `SELECT "no_such_column"` returns the
 * text "no_such_column" for every row rather than raising. A misspelling in a
 * policy would therefore not fail; it would quietly compare a column against a
 * constant string and hand back the wrong rows. Catching it here is the first
 * of the three layers rule 00 invariant I6 asks for.
 */

import type { Catalogue } from '../db/introspect.js';
import { PolicyError } from '../utils/errors.js';
import {
  MAX_LIKE_PATTERN_BYTES,
  MAX_TRAVERSAL_DEPTH,
  type PolicyDef,
  type Predicate,
  type TableDefinition,
  type ValueExpr,
} from './types.js';

function invalid(detail: string): PolicyError {
  return new PolicyError('INVALID_EXPR', 400, {
    message: 'Policy document is not valid.',
    detail,
  });
}

function unknownIdentifier(detail: string): PolicyError {
  return new PolicyError('UNKNOWN_IDENTIFIER', 400, {
    message: 'Policy document refers to something that does not exist.',
    detail,
  });
}

/**
 * The chain of tables in scope: the last entry is what a bare column name means,
 * and the one before it is what `$row.` means.
 */
type Scope = readonly string[];

function currentTable(scope: Scope): string {
  // Callers always push a table before walking a predicate.
  return scope[scope.length - 1] as string;
}

function assertColumn(catalogue: Catalogue, table: string, column: string, where: string): void {
  if (!catalogue.hasColumn(table, column)) {
    throw unknownIdentifier(
      `${where} names column "${column}" on table "${table}", which does not exist. ` +
        'Matching is exact and case sensitive.',
    );
  }
}

function assertUsableTable(catalogue: Catalogue, table: string, where: string): void {
  const info = catalogue.tables.get(table);
  if (info === undefined) {
    throw unknownIdentifier(`${where} names table "${table}", which does not exist.`);
  }
  if (info.isSystem) {
    // Rule 00 invariant I8. Internal tables are not reachable through the API,
    // and letting a policy read one would be a way around that.
    throw invalid(`${where} names "${table}", which belongs to the engine and is not readable.`);
  }
}

function assertValue(catalogue: Catalogue, value: ValueExpr, scope: Scope, where: string): void {
  if (value.kind !== 'outerColumn') return;

  if (scope.length < 2) {
    throw invalid(
      `${where} uses $row.${value.column}, but there is no enclosing table. ` +
        '$row refers to the table one level out and is only meaningful inside _exists.',
    );
  }
  const outer = scope[scope.length - 2] as string;
  assertColumn(catalogue, outer, value.column, `${where} ($row)`);
}

function assertLikePattern(value: ValueExpr, where: string): void {
  if (value.kind !== 'literal') return;
  if (typeof value.value !== 'string') {
    throw invalid(`${where} needs a string pattern.`);
  }
  const bytes = new TextEncoder().encode(value.value).byteLength;
  if (bytes > MAX_LIKE_PATTERN_BYTES) {
    // Verified on a remote database: 51 bytes raises
    // "LIKE or GLOB pattern too complex".
    throw invalid(
      `${where} has a ${bytes} byte pattern; D1 accepts at most ${MAX_LIKE_PATTERN_BYTES}.`,
    );
  }
}

/**
 * True when this predicate can evaluate to NULL because a column it touches is
 * nullable.
 *
 * `_is_null` and `_exists` are total: they answer true or false whatever the
 * data holds. Everything else inherits SQL's three valued comparison.
 */
function canBeNull(catalogue: Catalogue, predicate: Predicate, scope: Scope): boolean {
  const table = currentTable(scope);

  const columnIsNullable = (column: string): boolean =>
    catalogue.tables.get(table)?.columns.get(column)?.notNull !== true;

  const valueIsNullable = (value: ValueExpr): boolean => {
    if (value.kind !== 'outerColumn') return false;
    const outer = scope[scope.length - 2];
    if (outer === undefined) return false;
    return catalogue.tables.get(outer)?.columns.get(value.column)?.notNull !== true;
  };

  switch (predicate.kind) {
    case 'all':
    case 'isNull':
    case 'exists':
      return false;
    case 'compare':
      return columnIsNullable(predicate.column) || valueIsNullable(predicate.value);
    case 'like':
      return columnIsNullable(predicate.column) || valueIsNullable(predicate.pattern);
    case 'in':
      return columnIsNullable(predicate.column);
    case 'not':
      return canBeNull(catalogue, predicate.operand, scope);
    case 'and':
    case 'or':
      return predicate.operands.some((operand) => canBeNull(catalogue, operand, scope));
  }
}

function walk(
  catalogue: Catalogue,
  predicate: Predicate,
  scope: Scope,
  where: string,
  depth: number,
): void {
  const table = currentTable(scope);

  switch (predicate.kind) {
    case 'all':
      return;

    case 'compare':
      assertColumn(catalogue, table, predicate.column, where);
      assertValue(catalogue, predicate.value, scope, where);
      return;

    case 'in':
      assertColumn(catalogue, table, predicate.column, where);
      return;

    case 'isNull':
      assertColumn(catalogue, table, predicate.column, where);
      return;

    case 'like':
      assertColumn(catalogue, table, predicate.column, where);
      assertValue(catalogue, predicate.pattern, scope, where);
      assertLikePattern(predicate.pattern, `${where} _like on "${predicate.column}"`);
      return;

    case 'and':
    case 'or':
      for (const operand of predicate.operands) {
        walk(catalogue, operand, scope, where, depth);
      }
      return;

    case 'not': {
      // Measured 2026-07-30 (rules/01 section G1): a plain TEXT PRIMARY KEY on a
      // non-STRICT table accepts NULL, so "this column cannot be null" is not a
      // safe assumption even for keys.
      //
      // NOT (NULL = 'u_1') is NULL, not true, and WHERE reads NULL as false. So
      // a negated policy silently hides rows whose column is NULL instead of
      // matching them, which is the opposite of what the author wrote.
      //
      // Both available fixes are wrong in different ways. Wrapping the operand
      // in "column IS NULL OR ..." would widen a policy predicate on the
      // engine's own initiative, and a policy must never grow rows its author
      // did not write. Leaving it alone keeps a trap that reads as correct.
      // So it is refused, and the author writes the NULL case out.
      //
      // Note this is a clarity rule, not a hole being closed: NULL is falsy in
      // WHERE, so the surprising behaviour is always the restrictive one.
      // _neq is deliberately still allowed on a nullable column, because "x !=
      // y does not match NULL" is the one thing every SQL developer already
      // knows, and it is the escape hatch out of this rule.
      if (canBeNull(catalogue, predicate.operand, scope)) {
        throw invalid(
          `${where} negates a condition on a column that can be NULL. ` +
            'NOT over NULL is NULL, which WHERE treats as false, so such rows would be hidden ' +
            'rather than matched. Write the two cases out, for example ' +
            '{"_or": [{"col": {"_is_null": true}}, {"col": {"_neq": "x"}}]}, ' +
            'or declare the column NOT NULL.',
        );
      }
      walk(catalogue, predicate.operand, scope, where, depth);
      return;
    }

    case 'exists': {
      if (depth + 1 > MAX_TRAVERSAL_DEPTH) {
        // Each level multiplies the rows D1 scans, and D1 bills for rows
        // scanned rather than returned.
        throw invalid(`${where} traverses more than ${MAX_TRAVERSAL_DEPTH} levels of _exists.`);
      }
      assertUsableTable(catalogue, predicate.table, where);
      walk(catalogue, predicate.where, [...scope, predicate.table], where, depth + 1);
      return;
    }
  }
}

function validatePolicy(catalogue: Catalogue, table: string, policy: PolicyDef): void {
  const where = `Policy "${policy.name}" on "${table}"`;

  for (const column of policy.columns) {
    assertColumn(catalogue, table, column, `${where} column list`);
  }

  for (const entry of policy.set) {
    assertColumn(catalogue, table, entry.column, `${where} set`);
  }

  // An insert policy without a check writes whatever it is given, subject only
  // to the column grant. That is a coherent thing to want, but it is not
  // something to arrive at by leaving a key out, so it has to be written as an
  // explicit `"check": true`.
  // An insert has no existing row, so there is nothing for `using` to be about.
  // The write path ignores it, and something that is ignored must not be allowed
  // to look meaningful: a policy author who wrote a restrictive `using` here
  // would reasonably believe it applied.
  if (policy.operation === 'insert' && policy.using.kind !== 'all') {
    throw invalid(
      `${where} is an insert policy with a condition in "using". An insert has no existing row ` +
        'for that to describe, so it would be ignored. Write "using": true and put the ' +
        'condition in "check", which is about the row being created.',
    );
  }

  if (policy.operation === 'insert' && policy.check === null) {
    throw invalid(
      `${where} is an insert policy with no "check". The row does not exist yet, so "using" ` +
        'says nothing about it. State the condition the new row must meet, or write ' +
        '"check": true to accept any row the column grant allows.',
    );
  }

  walk(catalogue, policy.using, [table], `${where} using`, 0);
  if (policy.check !== null) {
    walk(catalogue, policy.check, [table], `${where} check`, 0);
  }
}

/**
 * Check a parsed document against the live schema.
 *
 * Called when a policy is stored and again when the registry loads it, so a
 * schema change that invalidates a stored policy surfaces as a refusal rather
 * than as a query that returns the wrong rows.
 */
export function validateTableDefinition(
  catalogue: Catalogue,
  definition: TableDefinition,
): TableDefinition {
  assertUsableTable(catalogue, definition.table, 'Policy document');

  for (const policy of definition.policies) {
    validatePolicy(catalogue, definition.table, policy);
  }

  return definition;
}
