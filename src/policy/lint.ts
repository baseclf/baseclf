/**
 * What a policy will cost, and where it will surprise its author.
 *
 * ## Why this is not a nice-to-have
 *
 * 🔴 D1 bills for rows **scanned**, not rows returned. The docs are explicit: a table
 * of five thousand rows answering `SELECT *` is charged five thousand rows read. A
 * policy predicate runs on every request to that table, so a policy column with no
 * index is not a latency problem that shows up under load. It is a line on a bill,
 * every request, for as long as the policy exists, and the person who wrote the policy
 * has nowhere to see it. `rules/01` section D calls this a feature rather than a
 * nice-to-have for that reason.
 *
 * ## Warnings, not refusals
 *
 * ⚠️ Nothing here throws, and that is a deliberate exception to how the rest of this
 * directory behaves. Everywhere else a doubt is a refusal, because everywhere else the
 * doubt is about **who may read what**. These findings are about money and about
 * surprise. Refusing a policy that grants exactly what its author meant, because the
 * engine has an opinion about an index, would be the engine overruling the author on a
 * question the author is allowed to be wrong about.
 *
 * The one thing a warning must not do is be ignorable by being noisy, which is why
 * each check below is narrowed to the case where it changes an answer or a bill,
 * rather than fired wherever its subject appears.
 *
 * ## What it does not know
 *
 * It reads the catalogue and the parsed policy. It does not run `EXPLAIN QUERY PLAN`,
 * so it cannot tell that the planner would have chosen an index it does have, and it
 * cannot see the client filters that arrive with a request. A policy it is quiet about
 * can still be slow.
 */

import type { Catalogue } from '../db/introspect.js';
import type { Predicate, TableDefinition } from './types.js';

export type LintCode = 'unindexed_column' | 'nullable_neq' | 'wide_expression';

export interface LintFinding {
  readonly code: LintCode;
  readonly table: string;
  /** The policy it came from, so an author with several knows which to look at. */
  readonly policy: string;
  readonly detail: string;
  /** A statement to copy, when there is one to give. */
  readonly remedy?: string;
}

/**
 * How many terms in one policy predicate before it is worth mentioning.
 *
 * ⚠️ Not the ceiling, and deliberately far from it. Measured remotely on 2026-08-12
 * (`rules/01` section G9): an expression 100 deep compiles and 101 fails with
 * "Expression tree is too large (maximum depth 100)". That is a boundary in **tree
 * depth**, and the relationship between the number of terms somebody writes and the
 * depth the compiler produces has never been verified. So this warns at a third of the
 * measured boundary rather than pretending to know where the edge is.
 *
 * The failure is fail-closed when it comes: the query is refused, no data is returned.
 * That makes it an availability problem rather than a hole, which is the other reason
 * this warns rather than refuses.
 */
const WIDE_EXPRESSION_TERMS = 33;

/** A column reference found in a predicate, and the table it belongs to. */
interface ColumnUse {
  readonly table: string;
  readonly column: string;
  /** True when the comparison excludes NULL rows without saying so. */
  readonly negated: boolean;
}

interface WalkState {
  /** Columns named bare belong to this table. */
  readonly table: string;
  /** `$row.<column>` belongs to the table one level out. */
  readonly outer: string | null;
  uses: ColumnUse[];
  terms: number;
}

/**
 * Collect every column a predicate searches on, and count its terms.
 *
 * ⚠️ The table a column belongs to changes inside `_exists`. A bare column there names
 * the joined table, and that is the one that decides whether the subquery is a lookup
 * or a scan of somebody's whole membership table. Attributing it outwards would warn
 * about the wrong column and stay quiet about the expensive one.
 *
 * 🔴 `$row.<column>` is recorded as nothing at all, and the first version of this
 * recorded it as a use of the outer table. A test caught it. In
 * `EXISTS (SELECT 1 FROM memberships WHERE memberships.org_id = notes.org_id)` the
 * outer column is a value read out of the row the scan is already holding, not a key
 * anything is looked up by, so an index on it buys nothing. Reporting it is a warning
 * whose remedy is an index that costs writes and changes no reads, which is worse than
 * saying nothing: it spends the reader's trust on advice that is wrong.
 *
 * `$row` only ever appears inside `_exists` (see `ValueExpr`), so there is no case
 * where an outer column is the thing being searched on.
 */
function walk(predicate: Predicate, state: WalkState): void {
  state.terms += 1;

  switch (predicate.kind) {
    case 'all':
      return;

    case 'compare':
      state.uses.push({
        table: state.table,
        column: predicate.column,
        // `_neq` is the one comparison whose result for a NULL row is neither true
        // nor false. See `nullableFindings`.
        negated: predicate.operator === '_neq',
      });
      return;

    case 'in':
      state.uses.push({ table: state.table, column: predicate.column, negated: false });
      return;

    case 'like':
      // Deliberately recorded as a use even though a leading wildcard defeats an
      // index anyway. The index is still what decides whether the pattern is applied
      // to a page of rows or to all of them.
      state.uses.push({ table: state.table, column: predicate.column, negated: false });
      return;

    case 'isNull':
      // No index finding: `IS NULL` is total, and it is the documented way out of the
      // nullable problem the other check reports. Warning about it would push authors
      // away from the escape hatch.
      return;

    case 'and':
    case 'or':
      for (const operand of predicate.operands) walk(operand, state);
      return;

    case 'not':
      walk(predicate.operand, state);
      return;

    case 'exists':
      walk(predicate.where, {
        table: predicate.table,
        outer: state.table,
        uses: state.uses,
        terms: 0,
      });
      // Counted on the outer budget as well: the compiler emits one expression, and
      // the ceiling applies to that one expression rather than to each level of it.
      state.terms += 1;
      return;
  }
}

function indexName(table: string, column: string): string {
  return `${table}_${column}_idx`;
}

/** Double-quoted and escaped, the same way the compiler emits an identifier. */
function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * The columns this policy will make D1 scan.
 *
 * A primary key counts as indexed, and so does a column that leads a composite index,
 * because leading is what the planner can use. Both of those live in `isIndexed`
 * rather than here, so the catalogue stays the one place that answers it.
 */
function indexFindings(
  catalogue: Catalogue,
  policyName: string,
  uses: readonly ColumnUse[],
): LintFinding[] {
  const seen = new Set<string>();
  const findings: LintFinding[] = [];

  for (const use of uses) {
    const key = `${use.table}.${use.column}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // A column the catalogue has never heard of is not this check's business.
    // `validateTableDefinition` refuses those, and reporting one here would be a
    // second, weaker opinion on invariant I6.
    if (!catalogue.hasColumn(use.table, use.column)) continue;
    if (catalogue.isIndexed(use.table, use.column)) continue;

    findings.push({
      code: 'unindexed_column',
      table: use.table,
      policy: policyName,
      detail:
        `"${use.column}" has no index, so every request that runs this policy scans ` +
        `"${use.table}" in full. D1 bills for rows scanned.`,
      remedy: `CREATE INDEX ${quote(indexName(use.table, use.column))} ON ${quote(use.table)} (${quote(use.column)});`,
    });
  }

  return findings;
}

/**
 * Where NULL will quietly drop a row the author expected to keep.
 *
 * ⚠️ Narrowed to `_neq`, and `rules/01` section G1 is written more broadly than that:
 * it says to warn when a policy references a nullable column at all. Firing on every
 * such reference was tried on paper and rejected, because most columns are nullable
 * and a warning on most policies is a warning nobody reads.
 *
 * `_neq` is where it actually bites. `col <> 'x'` is NULL for a row whose `col` is
 * NULL, and a WHERE clause treats NULL as false, so a permissive policy meant to say
 * "anything but x" silently excludes every row that has nothing there. It fails
 * closed, so it is not a leak. It is an author being surprised by rows they cannot
 * see, and this is the only place that can tell them.
 *
 * `_not` over a nullable subtree is refused outright at validate time, so it never
 * reaches here.
 */
function nullableFindings(
  catalogue: Catalogue,
  policyName: string,
  uses: readonly ColumnUse[],
): LintFinding[] {
  const findings: LintFinding[] = [];
  const seen = new Set<string>();

  for (const use of uses) {
    if (!use.negated) continue;

    const key = `${use.table}.${use.column}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const info = catalogue.tables.get(use.table)?.columns.get(use.column);
    if (info === undefined || info.notNull) continue;

    findings.push({
      code: 'nullable_neq',
      table: use.table,
      policy: policyName,
      detail:
        `"${use.column}" is nullable, and _neq excludes rows where it is NULL rather ` +
        'than matching them. Write the two cases if that is not what you meant: ' +
        `{"_or":[{"${use.column}":{"_is_null":true}},{"${use.column}":{"_neq":...}}]}`,
    });
  }

  return findings;
}

/**
 * Every finding for one table's policies.
 *
 * Takes a parsed definition rather than a document, so it sees what the engine sees:
 * binds are already expanded, which is what makes a bind used four times count four
 * times, as it will when it runs.
 */
export function lintTable(
  catalogue: Catalogue,
  definition: TableDefinition,
): readonly LintFinding[] {
  const findings: LintFinding[] = [];

  for (const policy of definition.policies) {
    const state: WalkState = {
      table: definition.table,
      outer: null,
      uses: [],
      terms: 0,
    };

    walk(policy.using, state);
    if (policy.check !== null) walk(policy.check, state);

    findings.push(
      ...indexFindings(catalogue, policy.name, state.uses),
      ...nullableFindings(catalogue, policy.name, state.uses),
    );

    if (state.terms > WIDE_EXPRESSION_TERMS) {
      findings.push({
        code: 'wide_expression',
        table: definition.table,
        policy: policy.name,
        detail:
          `${state.terms} terms in one policy. D1 refuses an expression tree deeper ` +
          'than 100, and a long chain of _and or _or compiles to a deep one. The ' +
          'query is refused rather than answered wrongly, so this costs availability ' +
          'rather than safety.',
      });
    }
  }

  return findings;
}
