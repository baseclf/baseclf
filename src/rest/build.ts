/**
 * The parsed query string, resolved against the schema and turned into nodes.
 *
 * This is where a client's words stop being words. Every name goes through the
 * catalogue, every operator through the allowlist, and every value becomes a
 * bound parameter. Nothing reaches SQL text except identifiers the database
 * confirmed it has and keywords chosen from a fixed list.
 *
 * The query is assembled as operation nodes rather than through Kysely's typed
 * builder on purpose. Column and table names arrive from PRAGMA output and are
 * used verbatim; the builder's dynamic path would have to parse them out of a
 * dotted string first, which quietly breaks on a table whose name contains a
 * dot and puts a second parser between the catalogue and the query. Kysely is
 * used here as what skills/d1-sql calls it, a compiler, and the policy plugin
 * still sees every node before any of it becomes text.
 */

import {
  AliasNode,
  AndNode,
  IdentifierNode,
  LimitNode,
  OffsetNode,
  type OperationNode,
  OperatorNode,
  OrderByItemNode,
  OrderByNode,
  OrNode,
  ParensNode,
  RawNode,
  SelectionNode,
  SelectQueryNode,
  TableNode,
  UnaryOperationNode,
  ValueNode,
  WhereNode,
} from 'kysely';

import type { Catalogue } from '../db/introspect.js';
import { jsonEachList } from '../policy/compile.js';
import { BaseclfError } from '../utils/errors.js';
import {
  columnReference,
  LIKE_ESCAPE_CHARACTER,
  resolveAlias,
  resolveColumn,
  resolveNullPlacement,
  resolveOperator,
  resolveSortDirection,
  SQL_COMPARISON,
  toLikePattern,
} from './allowlist.js';
import type { ConditionNode, FilterNode, ParsedQuery, SelectItem } from './parse-query.js';

function bad(message: string): never {
  throw new BaseclfError('UNSUPPORTED_OPERATOR', 400, { message });
}

/**
 * What a bare word in a filter binds as.
 *
 * SQLite stores booleans as integers, so `?active=eq.true` has to bind 1 or it
 * matches nothing. A quoted value is always the text: `?name=eq."true"` looks
 * for the word.
 *
 * Numbers stay text on purpose. A bound parameter carries no affinity, so
 * SQLite applies the column's own when comparing, which converts '5' to 5 for
 * an INTEGER column and leaves '5' alone for a TEXT one. Guessing the type here
 * would get that backwards for a TEXT column holding digits.
 */
function bindValue(value: string, quoted: boolean): string | number {
  if (quoted) return value;
  if (value === 'true') return 1;
  if (value === 'false') return 0;
  return value;
}

function compileIs(reference: OperationNode, condition: ConditionNode): OperationNode {
  if (typeof condition.value !== 'string') bad('"is" takes a single value.');
  if (condition.quoted) bad('"is" takes null, true or false, unquoted.');

  if (condition.value === 'null') {
    return RawNode.create(['', ' is null'], [reference]);
  }
  if (condition.value === 'true' || condition.value === 'false') {
    return RawNode.create(
      ['', ' is '],
      [reference, ValueNode.create(condition.value === 'true' ? 1 : 0)],
    );
  }
  bad('"is" takes null, true or false.');
}

/**
 * `column LIKE ? ESCAPE ?`.
 *
 * The escape character is bound rather than written into the SQL. It is a
 * constant, so this buys nothing against injection; it buys never having a
 * backslash inside a SQL string literal that some later layer has to reason
 * about.
 */
function compileLike(reference: OperationNode, pattern: string): OperationNode {
  return RawNode.create(
    ['', ' like ', ' escape ', ''],
    [reference, ValueNode.create(pattern), ValueNode.create(LIKE_ESCAPE_CHARACTER)],
  );
}

function compileCondition(
  catalogue: Catalogue,
  table: string,
  condition: ConditionNode,
): OperationNode {
  const column = resolveColumn(catalogue, table, condition.column);
  const operator = resolveOperator(condition.operator);
  const reference = columnReference(table, column);

  let node: OperationNode;

  switch (operator) {
    case 'in': {
      if (typeof condition.value === 'string') bad('"in" takes a parenthesised list.');
      // One bound parameter for the whole list, whatever its length. Expanding
      // it into IN (?,?,?) would work until the hundred and first entry, which
      // D1 answers with "too many SQL variables".
      node = RawNode.create(
        ['', ' in ', ''],
        [reference, jsonEachList(JSON.stringify(condition.value.map((entry) => entry)))],
      );
      break;
    }

    case 'is':
      node = compileIs(reference, condition);
      break;

    case 'like':
    case 'ilike': {
      if (typeof condition.value !== 'string') bad(`"${operator}" takes a single pattern.`);
      node = compileLike(reference, toLikePattern(condition.value));
      break;
    }

    default: {
      if (typeof condition.value !== 'string') bad(`"${operator}" takes a single value.`);
      node = RawNode.create(
        ['', ` ${SQL_COMPARISON[operator]} `, ''],
        [reference, ValueNode.create(bindValue(condition.value, condition.quoted))],
      );
      break;
    }
  }

  if (condition.negated) {
    // Safe in a way the policy DSL's _not is not: a client filter is only ever
    // AND'd onto the policy, and NULL reads as false in WHERE, so a negation
    // that meets NULL narrows the result. It can hide a row from the caller's
    // own view; it can never reveal one. See validate.ts for why the same
    // operator is refused inside a policy.
    return UnaryOperationNode.create(OperatorNode.create('not'), ParensNode.create(node));
  }
  return node;
}

function compileFilter(catalogue: Catalogue, table: string, filter: FilterNode): OperationNode {
  if (filter.kind === 'condition') {
    return compileCondition(catalogue, table, filter);
  }

  const operands = filter.operands.map((operand) => compileFilter(catalogue, table, operand));
  const [first, ...rest] = operands as [OperationNode, ...OperationNode[]];
  if (rest.length === 0) return ParensNode.create(first);

  const combine = filter.kind === 'and' ? AndNode.create : OrNode.create;
  // Grouped explicitly. Kysely emits `and` and `or` with no parentheses of its
  // own, so an un-grouped `or` here would rebind against whatever the policy
  // layer wraps around it.
  return ParensNode.create(rest.reduce((left, right) => combine(left, right), first));
}

function selectionsFor(
  catalogue: Catalogue,
  table: string,
  items: readonly SelectItem[],
): SelectionNode[] {
  const seen = new Set<string>();

  return items.map((item) => {
    const column = resolveColumn(catalogue, table, item.column);
    const reference = columnReference(table, column);

    if (item.alias === null) {
      if (seen.has(column)) bad(`Column "${column}" is selected twice.`);
      seen.add(column);
      return SelectionNode.create(reference);
    }

    const alias = resolveAlias(item.alias);
    if (seen.has(alias)) bad(`"${alias}" is used twice in the select list.`);
    seen.add(alias);
    return SelectionNode.create(AliasNode.create(reference, IdentifierNode.create(alias)));
  });
}

function orderByFor(
  catalogue: Catalogue,
  table: string,
  parsed: ParsedQuery,
): OrderByNode | undefined {
  if (parsed.order.length === 0) return undefined;

  const items = parsed.order.map((entry) => {
    const column = resolveColumn(catalogue, table, entry.column);
    const direction = resolveSortDirection(entry.direction);
    const reference = columnReference(table, column);

    // Both halves are keywords chosen from two-entry lookups, never text from
    // the request. ORDER BY with a bound parameter parses on D1 and then sorts
    // by nothing at all, verified 2026-07-29, so no part of this is ever bound.
    const item = OrderByItemNode.create(reference, RawNode.createWithSql(direction));
    if (entry.nulls === null) return item;

    return OrderByItemNode.cloneWith(item, { nulls: resolveNullPlacement(entry.nulls) });
  });

  return OrderByNode.create(items);
}

export interface BuildInput {
  readonly catalogue: Catalogue;
  readonly table: string;
  readonly parsed: ParsedQuery;
  /** The concrete columns to read. A star has already been expanded by the router. */
  readonly columns: readonly SelectItem[];
}

/**
 * Assemble the select the client asked for, with no policy on it yet.
 *
 * The result is deliberately not executable by itself: it goes to the policy
 * plugin next, which is the only thing that turns it into a query anything is
 * willing to run.
 */
export function buildSelect(input: BuildInput): SelectQueryNode {
  const { catalogue, table, parsed, columns } = input;

  const selections = selectionsFor(catalogue, table, columns);
  if (selections.length === 0) bad('A request must read at least one column.');

  const filters = parsed.filters.map((filter) => compileFilter(catalogue, table, filter));

  const base: SelectQueryNode = {
    ...SelectQueryNode.createFrom([TableNode.create(table)]),
    selections,
    limit: LimitNode.create(ValueNode.create(parsed.limit)),
    ...(parsed.offset > 0 ? { offset: OffsetNode.create(ValueNode.create(parsed.offset)) } : {}),
  };

  const orderBy = orderByFor(catalogue, table, parsed);

  const where =
    filters.length === 0
      ? undefined
      : WhereNode.create(
          filters.length === 1
            ? (filters[0] as OperationNode)
            : ParensNode.create(
                (filters.slice(1) as OperationNode[]).reduce(
                  (left, right) => AndNode.create(left, right),
                  filters[0] as OperationNode,
                ),
              ),
        );

  return {
    ...base,
    ...(orderBy === undefined ? {} : { orderBy }),
    ...(where === undefined ? {} : { where }),
  };
}
