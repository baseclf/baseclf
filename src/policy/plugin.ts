/**
 * The one place a policy is attached to a query.
 *
 * Everything else in the engine builds ordinary queries. This plugin sits
 * between the builder and the compiler and refuses to let a select through
 * without a policy predicate on it. There is deliberately no second way to
 * reach the database with a request-scoped query: a chokepoint that can be
 * walked around is not a chokepoint.
 *
 * Recursing matters as much as injecting. `super.transformSelectQuery` walks
 * into subqueries, so a select nested inside a client's filter gets the same
 * treatment as the outer one. A version of this that only looked at the root
 * would be a hole shaped exactly like the feature people ask for first.
 *
 * What this file refuses is as important as what it does:
 *
 *   joins, derived tables, aliased tables, several tables in one FROM, `*` in
 *   the selection list, and anything that is not a select at all.
 *
 * Each of those is a case where "which table does this column belong to" has
 * more than one answer, and a policy engine that guesses is a policy engine
 * that leaks. V1 reads one table at a time. Relationship embeds arrive when
 * they can be given the same treatment rather than an approximation of it.
 */

import type {
  KyselyPlugin,
  PluginTransformQueryArgs,
  PluginTransformResultArgs,
  QueryResult,
  UnknownRow,
} from 'kysely';
import {
  AliasNode,
  ColumnNode,
  type OperationNode,
  OperationNodeTransformer,
  type QueryId,
  ReferenceNode,
  type RootOperationNode,
  SelectAllNode,
  type SelectQueryNode,
  TableNode,
  WhereNode,
} from 'kysely';

import { BaseclfError, PolicyError } from '../utils/errors.js';
import { type CompileContext, combinePermissive, compilePredicate, narrowWith } from './compile.js';
import type { Registry } from './registry.js';
import type { AuthCtx, Operation } from './types.js';

function unsupported(detail: string): BaseclfError {
  return new BaseclfError('UNSUPPORTED_QUERY', 400, {
    message: 'This query shape is not supported.',
    detail,
  });
}

/**
 * The single table a select reads, or a refusal.
 *
 * A FROM that is anything other than one plain table is rejected rather than
 * interpreted. The alternative is deciding, on the engine's own initiative,
 * which policy applies to a column whose table is ambiguous.
 */
function soleTable(node: SelectQueryNode): string {
  if (node.joins !== undefined && node.joins.length > 0) {
    throw unsupported('A policied query may not join. Each table is read under its own policy.');
  }

  const froms = node.from?.froms ?? [];
  if (froms.length !== 1) {
    throw unsupported(`A policied query reads exactly one table; this one reads ${froms.length}.`);
  }

  const from = froms[0] as OperationNode;
  if (AliasNode.is(from)) {
    throw unsupported('A policied query may not alias its table.');
  }
  if (!TableNode.is(from)) {
    throw unsupported('A policied query must read a table, not a derived expression.');
  }

  const identifier = from.table;
  if (identifier.schema !== undefined) {
    throw unsupported('D1 has no schemas; a qualified table name is not meaningful.');
  }
  return identifier.identifier.name;
}

/**
 * The columns this select reads.
 *
 * `SELECT *` never reaches here. The router expands it against what the policy
 * grants, because `*` compiled literally would return whatever the table holds
 * today, including a column added by a migration after the policy was written.
 */
function selectedColumns(node: SelectQueryNode): string[] {
  const selections = node.selections ?? [];
  if (selections.length === 0) {
    throw unsupported('A policied query must name the columns it reads.');
  }

  const columns: string[] = [];
  for (const selection of selections) {
    // An alias renames a column on the way out; the grant is still about the
    // column underneath it. Checking the alias instead would let `?select=
    // id:salary` be waved through by a policy that grants `id`.
    const target = AliasNode.is(selection.selection)
      ? selection.selection.node
      : selection.selection;

    if (SelectAllNode.is(target)) {
      throw unsupported(
        'A star reached the policy layer. It must be expanded against the granted columns ' +
          'before the query is built, or a migration would silently widen every response.',
      );
    }

    if (ColumnNode.is(target)) {
      columns.push(target.column.name);
      continue;
    }

    if (ReferenceNode.is(target)) {
      if (SelectAllNode.is(target.column)) {
        throw unsupported('A qualified star reached the policy layer.');
      }
      columns.push(target.column.column.name);
      continue;
    }

    throw unsupported('A policied query may only select plain columns.');
  }

  return columns;
}

class PolicyTransformer extends OperationNodeTransformer {
  readonly #registry: Registry;
  readonly #context: CompileContext;
  readonly #operation: Operation;

  constructor(registry: Registry, context: CompileContext, operation: Operation) {
    super();
    this.#registry = registry;
    this.#context = context;
    this.#operation = operation;
  }

  protected override transformSelectQuery(
    node: SelectQueryNode,
    queryId?: QueryId,
  ): SelectQueryNode {
    // Recurse first. Subqueries are transformed by this same method, so they
    // each acquire their own policy before the outer one is assembled.
    const transformed = super.transformSelectQuery(node, queryId);

    const table = soleTable(transformed);
    const match = this.#registry.resolve(
      table,
      this.#operation,
      this.#context.auth.role,
      selectedColumns(transformed),
    );

    const policy = combinePermissive(
      match.policies.map((definition) =>
        compilePredicate(
          definition.using,
          this.#context,
          [table],
          `Policy "${definition.name}" on "${table}"`,
        ),
      ),
    );

    // Built by hand rather than through QueryNode.cloneWithWhere, which joins
    // the two sides with a bare `and`. Kysely emits `and` and `or` without
    // grouping, so `policy and a or b` would parse as `(policy and a) or b` and
    // the client's `or` would have escaped the policy entirely. Rule 00
    // invariant I3 says the client may only narrow; the parentheses in
    // narrowWith are what make that true rather than merely intended.
    const client = transformed.where?.where ?? null;

    return { ...transformed, where: WhereNode.create(narrowWith(policy, client)) };
  }

  protected override transformInsertQuery(): never {
    throw unsupported('Writes arrive in V2, once WITH CHECK can be compiled with them.');
  }

  protected override transformUpdateQuery(): never {
    throw unsupported('Writes arrive in V2, once WITH CHECK can be compiled with them.');
  }

  protected override transformDeleteQuery(): never {
    throw unsupported('Writes arrive in V2, once WITH CHECK can be compiled with them.');
  }
}

export interface PolicyPluginOptions {
  readonly registry: Registry;
  readonly catalogue: CompileContext['catalogue'];
  readonly auth: AuthCtx;
  /** V1 reads. The other three are refused outright rather than passed through. */
  readonly operation?: Operation;
}

function transformerFor(options: PolicyPluginOptions): PolicyTransformer {
  return new PolicyTransformer(
    options.registry,
    { catalogue: options.catalogue, auth: options.auth },
    options.operation ?? 'select',
  );
}

/**
 * Attach policies to a select that was built by hand.
 *
 * This is the path the REST router takes. It is the same transformer the Kysely
 * plugin runs, called directly, so there is one implementation rather than two
 * that have to agree.
 *
 * Apply it once. Applying it twice would AND the policy onto itself, which is
 * harmless, and would then walk into the subqueries the first pass added, which
 * would demand a policy for a table the author never exposed and throw. Wrong,
 * but wrong in the safe direction.
 */
export function applyPolicy(node: SelectQueryNode, options: PolicyPluginOptions): SelectQueryNode {
  return transformerFor(options).transformNode(node);
}

/**
 * A plugin bound to one request's identity.
 *
 * Build it per request, never once per isolate: it closes over the caller's
 * claims, and a shared instance would apply one user's identity to another
 * user's query.
 */
export function createPolicyPlugin(options: PolicyPluginOptions): KyselyPlugin {
  const transformer = transformerFor(options);

  return {
    transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
      const node = args.node;

      if (node.kind !== 'SelectQueryNode') {
        // Anything else would leave the transformer's select path unused, which
        // is to say unpoliced. Refusing is the only safe default.
        throw new PolicyError('NO_POLICY', 404, {
          message: 'Not found.',
          detail: `A ${node.kind} reached the policy plugin, which only handles reads in V1.`,
        });
      }

      return transformer.transformNode(node, args.queryId) as RootOperationNode;
    },

    async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
      return args.result;
    },
  };
}
