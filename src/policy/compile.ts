/**
 * Policy AST to Kysely operation nodes.
 *
 * Two things this file will not do, ever:
 *
 *   - Put a value into SQL text. Every literal and every claim becomes a bound
 *     parameter (rule 00, invariant I7). Lists go through
 *     `IN (SELECT value FROM json_each(?))`, which costs one parameter no
 *     matter how long the list is, instead of being expanded into `IN (?,?,?)`
 *     and running into D1's ceiling of a hundred.
 *   - Put an identifier into SQL text without asking the catalogue first. The
 *     column has already been checked at validation time; it is checked again
 *     here because this is the last point before the text exists.
 *
 * Parentheses are added by hand around every composite. Kysely's compiler emits
 * `and` and `or` with no grouping at all, so an AndNode holding an OrNode
 * compiles to `a and b or c`. In a policy engine that is not a formatting
 * detail: it is the difference between a client filter narrowing the policy and
 * a client filter escaping it (rule 00, invariant I3).
 */

import {
  AndNode,
  BinaryOperationNode,
  ColumnNode,
  type OperationNode,
  OperatorNode,
  OrNode,
  ParensNode,
  RawNode,
  ReferenceNode,
  SelectionNode,
  SelectQueryNode,
  TableNode,
  UnaryOperationNode,
  ValueNode,
  WhereNode,
} from 'kysely';

import type { Catalogue } from '../db/introspect.js';
import { PolicyError } from '../utils/errors.js';
import {
  type AuthCtx,
  type ClaimRef,
  type CompareOperator,
  type Literal,
  MAX_LIKE_PATTERN_BYTES,
  type Predicate,
  type ValueExpr,
} from './types.js';

/** Values D1 will accept through `.bind()`. Booleans are folded to integers. */
export type Bindable = string | number | null;

const COMPARISON_SQL: Readonly<Record<CompareOperator, '=' | '!=' | '>' | '>=' | '<' | '<='>> =
  Object.freeze({
    _eq: '=',
    _neq: '!=',
    _gt: '>',
    _gte: '>=',
    _lt: '<',
    _lte: '<=',
  });

/**
 * What a column of the row being written will hold once the write lands.
 *
 * SQLite has no WITH CHECK, and D1 has no interactive transaction, so there is
 * no read-modify-write available to compare against. The only way to enforce a
 * post-condition atomically is to state it as part of the same statement, which
 * means rewriting every column reference in the check into the value that
 * column will have afterwards. See check-rewrite.ts.
 *
 * `requireAll` separates the two write shapes. For an update, a column that is
 * not being written keeps its current value, so the reference stays a
 * reference. For an insert there is no current value to fall back on: the row
 * does not exist yet, and a column absent from the insert would take a default
 * this engine has no way to know. That case is refused rather than guessed.
 */
export interface PostImage {
  readonly values: ReadonlyMap<string, OperationNode>;
  readonly requireAll: boolean;
}

export interface CompileContext {
  readonly catalogue: Catalogue;
  readonly auth: AuthCtx;
  /**
   * Set only while compiling a check. Applies to the outermost scope frame,
   * which is the row being written, and to nothing else: a bare column inside
   * an `_exists` belongs to that subquery's table and keeps its own meaning.
   */
  readonly postImage?: PostImage | undefined;
}

/** The chain of tables in scope; the last is the one bare columns belong to. */
type Scope = readonly string[];

function invalid(detail: string): PolicyError {
  return new PolicyError('INVALID_EXPR', 400, {
    message: 'Policy could not be applied.',
    detail,
  });
}

/**
 * SQLite has no boolean type, so a boolean is stored as 1 or 0. Folding it here
 * rather than handing a JS boolean to `.bind()` keeps us off a behaviour we have
 * not measured on D1.
 */
function toBindable(value: Literal): Bindable {
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

function resolveClaim(auth: AuthCtx, ref: ClaimRef): unknown {
  switch (ref.source) {
    case 'uid':
      return auth.uid;
    case 'email':
      return auth.email;
    case 'role':
      return auth.role;
    case 'app':
      // Only own properties. A claim named "constructor" or "__proto__" must
      // not reach up the prototype chain.
      return Object.hasOwn(auth.app, ref.key) ? auth.app[ref.key] : null;
  }
}

function resolveScalarClaim(auth: AuthCtx, ref: ClaimRef, where: string): Bindable {
  const value = resolveClaim(auth, ref);

  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value ? 1 : 0;

  throw invalid(
    `${where} resolves to a ${Array.isArray(value) ? 'list' : typeof value}, ` +
      'which cannot be compared as a single value.',
  );
}

/**
 * A column of a table in scope, emitted as a quoted identifier.
 *
 * The catalogue lookup is exact. It has to be: with double quoted string
 * literals enabled on D1, a name that is not a column comes back as a string
 * rather than as an error, so a bad identifier here would silently produce
 * wrong rows instead of a failure.
 */
function reference(catalogue: Catalogue, table: string, column: string): OperationNode {
  if (!catalogue.hasColumn(table, column)) {
    throw new PolicyError('UNKNOWN_IDENTIFIER', 400, {
      message: 'Policy could not be applied.',
      detail: `Column "${column}" does not exist on table "${table}".`,
    });
  }
  return ReferenceNode.create(ColumnNode.create(column), TableNode.create(table));
}

/**
 * A column, resolved against a numbered frame of the scope.
 *
 * The frame index is what decides whether the post-image substitution applies.
 * Frame zero is the row being written; every other frame belongs to a subquery
 * and means what it says. Getting this wrong in the permissive direction would
 * compare a check against the wrong row, so it is expressed as an index rather
 * than as "is this the table we started with", which stops being true the
 * moment a policy traverses back to the same table.
 */
function referenceAt(
  context: CompileContext,
  scope: Scope,
  frameIndex: number,
  column: string,
  where: string,
): OperationNode {
  const table = scope[frameIndex];
  if (table === undefined) {
    throw invalid(`${where} refers to a table that is not in scope.`);
  }

  if (frameIndex === 0 && context.postImage !== undefined) {
    const written = context.postImage.values.get(column);
    if (written !== undefined) return written;

    if (context.postImage.requireAll) {
      // An insert. The column is not in the statement, so afterwards it holds
      // whatever the schema defaults to, which this engine does not read and
      // will not assume.
      throw invalid(
        `${where} checks column "${column}", which this insert does not set. ` +
          'The row does not exist yet, so there is no value to compare against and the ' +
          'column default is not something the engine reads. Add the column to the ' +
          'policy grant or to its server-set values.',
      );
    }
    // An update that leaves this column alone: afterwards it still holds what
    // it holds now, which is exactly the column reference.
  }

  return reference(context.catalogue, table, column);
}

function compileValue(
  value: ValueExpr,
  context: CompileContext,
  scope: Scope,
  where: string,
): OperationNode {
  switch (value.kind) {
    case 'literal':
      return ValueNode.create(toBindable(value.value));

    case 'claim':
      return ValueNode.create(resolveScalarClaim(context.auth, value.ref, where));

    case 'outerColumn': {
      // One frame out. When that frame is frame zero, the post-image applies
      // just as it does to a bare column there: a check that reaches back to
      // the row being written is still talking about the row being written.
      const outerIndex = scope.length - 2;
      if (outerIndex < 0) {
        throw invalid(`${where} uses $row outside of an _exists.`);
      }
      return referenceAt(context, scope, outerIndex, value.column, where);
    }
  }
}

/**
 * `column IN (SELECT value FROM json_each(?))`.
 *
 * The list arrives as one JSON string in one bound parameter. Expanding a list
 * into `IN (?,?,?)` would work until someone passes a hundred and first entry,
 * at which point D1 answers "too many SQL variables" (verified 2026-07-29).
 *
 * The SQL around the parameter is a fixed template with nothing interpolated
 * into it. `json_each` and `value` are written unquoted on purpose: the
 * post-compile identifier check reads quoted regions only, and these are a
 * function and its result column rather than anything from the schema.
 */
export function jsonEachList(json: string): OperationNode {
  return RawNode.create(['(select value from json_each(', '))'], [ValueNode.create(json)]);
}

function compileList(
  predicate: Extract<Predicate, { kind: 'in' }>,
  context: CompileContext,
  where: string,
): OperationNode {
  if (predicate.values.kind === 'literalList') {
    return jsonEachList(JSON.stringify(predicate.values.values.map(toBindable)));
  }

  const resolved = resolveClaim(context.auth, predicate.values.ref);
  if (resolved === null || resolved === undefined) {
    // No list means nothing matches. An empty JSON array says exactly that and
    // keeps the shape of the query identical either way.
    return jsonEachList('[]');
  }
  if (!Array.isArray(resolved)) {
    throw invalid(`${where} expects the claim to hold a list.`);
  }
  for (const entry of resolved) {
    if (
      entry !== null &&
      typeof entry !== 'string' &&
      typeof entry !== 'number' &&
      typeof entry !== 'boolean'
    ) {
      throw invalid(`${where} has a list entry that is not a scalar.`);
    }
  }
  return jsonEachList(JSON.stringify((resolved as Literal[]).map(toBindable)));
}

function compileLike(
  predicate: Extract<Predicate, { kind: 'like' }>,
  context: CompileContext,
  scope: Scope,
  where: string,
): OperationNode {
  const pattern = compileValue(predicate.pattern, context, scope, where);

  // A literal pattern was measured at validation time. A pattern that came from
  // a claim is only known now, and D1 refuses anything over fifty bytes with
  // "LIKE or GLOB pattern too complex".
  if (ValueNode.is(pattern) && typeof pattern.value === 'string') {
    const bytes = new TextEncoder().encode(pattern.value).byteLength;
    if (bytes > MAX_LIKE_PATTERN_BYTES) {
      throw invalid(
        `${where} produced a ${bytes} byte LIKE pattern; D1 accepts at most ` +
          `${MAX_LIKE_PATTERN_BYTES}.`,
      );
    }
  }

  return BinaryOperationNode.create(
    referenceAt(context, scope, scope.length - 1, predicate.column, where),
    OperatorNode.create('like'),
    pattern,
  );
}

/**
 * `EXISTS (SELECT 1 FROM other WHERE ...)`, correlated to the outer row.
 *
 * Deliberately not a list of ids fetched separately and passed back in: that
 * pattern grows with the data and walks into the hundred parameter ceiling,
 * and it costs a second round trip on a platform where the database is single
 * threaded per tenant.
 */
function compileExists(
  predicate: Extract<Predicate, { kind: 'exists' }>,
  context: CompileContext,
  scope: Scope,
  where: string,
): OperationNode {
  if (!context.catalogue.hasTable(predicate.table)) {
    throw new PolicyError('UNKNOWN_IDENTIFIER', 400, {
      message: 'Policy could not be applied.',
      detail: `Table "${predicate.table}" does not exist.`,
    });
  }

  const inner = compilePredicate(predicate.where, context, [...scope, predicate.table], where);

  // `select *` rather than `select 1`: EXISTS never reads the select list, and
  // a star costs nothing here while a literal would have to be given an alias
  // to satisfy the node types, which would put an identifier into the SQL that
  // no table has. The rule that a star must be expanded applies to what a
  // client can read, and nothing here is readable.
  const subquery: SelectQueryNode = {
    ...SelectQueryNode.createFrom([TableNode.create(predicate.table)]),
    selections: [SelectionNode.createSelectAll()],
    where: WhereNode.create(inner),
  };

  return UnaryOperationNode.create(OperatorNode.create('exists'), ParensNode.create(subquery));
}

/** Folds a list of nodes with `and` or `or`, parenthesising the result. */
function fold(
  operands: readonly OperationNode[],
  combine: (left: OperationNode, right: OperationNode) => OperationNode,
): OperationNode {
  // parse.ts refuses an empty operand list, so there is always a first element.
  const [first, ...rest] = operands as [OperationNode, ...OperationNode[]];
  if (rest.length === 0) return first;
  return ParensNode.create(rest.reduce((left, right) => combine(left, right), first));
}

export function compilePredicate(
  predicate: Predicate,
  context: CompileContext,
  scope: Scope,
  where: string,
): OperationNode {
  switch (predicate.kind) {
    case 'all':
      // Immediate values, so this costs no parameter budget.
      return BinaryOperationNode.create(
        ValueNode.createImmediate(1),
        OperatorNode.create('='),
        ValueNode.createImmediate(1),
      );

    case 'compare':
      return BinaryOperationNode.create(
        referenceAt(context, scope, scope.length - 1, predicate.column, where),
        OperatorNode.create(COMPARISON_SQL[predicate.operator]),
        compileValue(predicate.value, context, scope, where),
      );

    case 'in':
      return BinaryOperationNode.create(
        referenceAt(context, scope, scope.length - 1, predicate.column, where),
        OperatorNode.create('in'),
        compileList(predicate, context, where),
      );

    case 'isNull':
      return BinaryOperationNode.create(
        referenceAt(context, scope, scope.length - 1, predicate.column, where),
        OperatorNode.create(predicate.expected ? 'is' : 'is not'),
        ValueNode.createImmediate(null),
      );

    case 'like':
      return compileLike(predicate, context, scope, where);

    case 'and':
      return fold(
        predicate.operands.map((operand) => compilePredicate(operand, context, scope, where)),
        (left, right) => AndNode.create(left, right),
      );

    case 'or':
      return fold(
        predicate.operands.map((operand) => compilePredicate(operand, context, scope, where)),
        (left, right) => OrNode.create(left, right),
      );

    case 'not':
      return UnaryOperationNode.create(
        OperatorNode.create('not'),
        ParensNode.create(compilePredicate(predicate.operand, context, scope, where)),
      );

    case 'exists':
      return compileExists(predicate, context, scope, where);
  }
}

/**
 * Combine the policies that apply to one request into a single predicate.
 *
 * Permissive policies are OR'd, which is how Postgres treats them: any one of
 * them granting a row is enough. The result is parenthesised so that whatever
 * the client sends can only ever be AND'd onto the outside of it.
 *
 * An empty list is not a thing this function accepts. "No policy matched" is
 * decided by the registry, and it throws (rule 00, invariant I1); returning a
 * predicate that matches everything would be the exact failure this project
 * exists to prevent.
 */
export function combinePermissive(predicates: readonly OperationNode[]): OperationNode {
  if (predicates.length === 0) {
    throw new PolicyError('NO_POLICY', 404, {
      message: 'Not found.',
      detail:
        'combinePermissive was called with no predicates. A request with no matching policy ' +
        'must be refused by the registry, never compiled into an unfiltered query.',
    });
  }
  return fold(predicates, (left, right) => OrNode.create(left, right));
}

/** `policy AND client`, with both sides grouped so neither can bind loosely. */
export function narrowWith(policy: OperationNode, client: OperationNode | null): OperationNode {
  if (client === null) return policy;
  return AndNode.create(ParensNode.create(policy), ParensNode.create(client));
}
