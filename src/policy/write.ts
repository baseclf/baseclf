/**
 * INSERT, UPDATE and DELETE, assembled with their policy already in them.
 *
 * Reads go through an OperationNodeTransformer because a select can contain
 * another select and every one of them needs its own predicate. A write cannot:
 * the client sends values, not queries, so there is no tree to walk and nothing
 * a transformer would buy. What matters instead is that the policy is part of
 * how the statement is built rather than something added to a finished one, so
 * there is no intermediate value in this file that is a runnable write without
 * a policy on it.
 *
 * Three shapes, one idea. Each is a single statement, because D1 has no
 * interactive transaction and therefore no way to hold a decision and a write
 * together across two round trips.
 *
 *   UPDATE t SET ... WHERE (using AND check) AND (client) RETURNING ...
 *   DELETE FROM t     WHERE (using)          AND (client) RETURNING ...
 *   INSERT INTO t (...) SELECT ?, ? WHERE (check)         RETURNING ...
 *
 * RETURNING is on all three and is not optional. It is the only way to find out
 * whether anything happened, and rule 00 invariant I5 turns zero rows into a
 * 404 whether the row was missing or merely forbidden.
 */

import type { RootOperationNode } from 'kysely';
import {
  AndNode,
  ColumnNode,
  ColumnUpdateNode,
  DeleteQueryNode,
  InsertQueryNode,
  type OperationNode,
  OrNode,
  ParensNode,
  RawNode,
  ReturningNode,
  SelectionNode,
  TableNode,
  UpdateQueryNode,
  WhereNode,
} from 'kysely';

import type { Catalogue } from '../db/introspect.js';
import { BaseclfError } from '../utils/errors.js';
import { compileCheck, resolveWrite } from './check-rewrite.js';
import { type CompileContext, compilePredicate, narrowWith } from './compile.js';
import type { Registry } from './registry.js';
import type { AuthCtx, Operation, PolicyDef } from './types.js';

export type WriteOperation = Extract<Operation, 'insert' | 'update' | 'delete'>;

export interface WriteRequest {
  readonly registry: Registry;
  readonly catalogue: Catalogue;
  readonly auth: AuthCtx;
  readonly table: string;
  readonly operation: WriteOperation;
  /** Values from the request body. Empty for a delete. */
  readonly body: ReadonlyMap<string, unknown>;
  /** The client's filter, already resolved against the catalogue. Null for an insert. */
  readonly filter: OperationNode | null;
}

export interface BuiltWrite {
  readonly node: RootOperationNode;
  /** The columns RETURNING will hand back, in order. */
  readonly columns: readonly string[];
  readonly policies: readonly PolicyDef[];
}

function unsupported(message: string, detail?: string): BaseclfError {
  return new BaseclfError('UNSUPPORTED_QUERY', 400, {
    message,
    ...(detail === undefined ? {} : { detail }),
  });
}

/**
 * The policies that apply, checked for being able to agree on one statement.
 *
 * Several permissive policies can grant the same write, and their conditions
 * are OR'd. Their server-set columns cannot be: a statement has one SET clause,
 * and if two policies disagree about what the engine should put in `author_id`
 * there is no answer that is not a guess. That is refused rather than resolved
 * by order of definition.
 */
function policiesFor(request: WriteRequest): readonly PolicyDef[] {
  const candidates = request.registry.candidates(
    request.table,
    request.operation,
    request.auth.role,
  );

  // A column the server sets is not a column the caller is asking to write,
  // even when the body happens to carry one. It is subtracted before
  // eligibility is decided, and then ignored when the values are resolved.
  const serverColumns = new Set(
    candidates.flatMap((policy) => policy.set.map((entry) => entry.column)),
  );
  const requested = [...request.body.keys()].filter((column) => !serverColumns.has(column));

  const eligible = candidates.filter((policy) =>
    requested.every((column) => policy.columns.includes(column)),
  );
  if (eligible.length === 0) {
    // Indistinguishable from "there is no such column", on purpose. Rule 00
    // invariant I5.
    throw new BaseclfError('NO_POLICY', 404, {
      message: 'Not found.',
      detail:
        `No policy on "${request.table}" for (${request.auth.role}, ${request.operation}) ` +
        `grants writing every column in the body: ${requested.join(', ')}.`,
    });
  }

  const signature = (policy: PolicyDef): string =>
    JSON.stringify(policy.set.map((entry) => [entry.column, entry.value]));

  const first = eligible[0] as PolicyDef;
  for (const policy of eligible) {
    if (signature(policy) !== signature(first)) {
      throw unsupported(
        'More than one policy grants this write and they disagree on what the server sets.',
        `Policies "${first.name}" and "${policy.name}" on "${request.table}" have different ` +
          '"set" values. A statement has one SET clause, so this cannot be resolved.',
      );
    }
  }

  return eligible;
}

/**
 * The columns handed back.
 *
 * What the caller wrote, what the server set on their behalf, and the primary
 * key. Every one of those is either a value the caller supplied, a value
 * derived from their own claims, or the key of a row the policy just confirmed
 * they may write, so none of it is somebody else's data.
 *
 * Deliberately not "the columns a select policy grants". Applying a read policy
 * to RETURNING is what Postgres does, and it cannot be reproduced here: SQLite's
 * RETURNING takes no WHERE. Rather than approximate it, the returned set is
 * narrowed to what the write itself touched.
 */
function returningColumns(
  catalogue: Catalogue,
  table: string,
  written: readonly string[],
): readonly string[] {
  const info = catalogue.tables.get(table);
  if (info === undefined) {
    throw unsupported('Not found.', `Table "${table}" is not in the catalogue.`);
  }

  const columns: string[] = [];
  for (const [name, column] of info.columns) {
    if (column.primaryKey || written.includes(name)) columns.push(name);
  }

  // A table with no declared primary key and a delete, which writes nothing.
  // One column is enough to tell "a row" from "no row".
  if (columns.length === 0) {
    const first = [...info.columns.keys()][0];
    if (first === undefined) {
      throw unsupported('Not found.', `Table "${table}" has no columns.`);
    }
    columns.push(first);
  }

  return columns;
}

function returningNode(columns: readonly string[]): ReturningNode {
  // Bare column names rather than qualified ones. RETURNING is evaluated
  // against the row the statement touched, and there is no FROM for a
  // qualifier to refer to.
  return ReturningNode.create(
    columns.map((column) => SelectionNode.create(ColumnNode.create(column))),
  );
}

/**
 * `OR` over the policies, pairing each one's `using` with its own `check`.
 *
 * Postgres OR's the USING clauses and separately OR's the WITH CHECK clauses,
 * which allows a row selected by one policy to be validated by another. This
 * pairs them instead, so a write has to be permitted end to end by a single
 * policy. It is the stricter reading, it is the one that can be explained to
 * somebody looking at a refusal, and where the two differ the stricter one is
 * the one to be wrong in.
 */
function permitted(
  policies: readonly PolicyDef[],
  context: CompileContext,
  request: WriteRequest,
  postImage: Parameters<typeof compileCheck>[3] | null,
): OperationNode {
  const terms = policies.map((policy) => {
    const where = `Policy "${policy.name}" on "${request.table}"`;

    // An insert has no existing row, so `using` says nothing about it and
    // validate.ts requires it to be `true`. Only the check applies.
    const usingNode =
      request.operation === 'insert'
        ? null
        : compilePredicate(policy.using, context, [request.table], `${where} using`);

    const checkNode =
      postImage === null
        ? null
        : compileCheck(policy.check, context, request.table, postImage, `${where} check`);

    if (usingNode !== null && checkNode !== null) {
      const paired = AndNode.create(ParensNode.create(usingNode), ParensNode.create(checkNode));
      // Grouped only when it has a sibling to be OR'd against. On its own it is
      // handed straight to narrowWith, which parenthesises it anyway, and a
      // second layer would just be noise in a statement people have to read.
      return policies.length > 1 ? ParensNode.create(paired) : paired;
    }
    if (usingNode !== null) return usingNode;
    if (checkNode !== null) return checkNode;

    throw unsupported(
      'Not found.',
      `${where} produced no condition at all, which must never happen for a write.`,
    );
  });

  const [first, ...rest] = terms as [OperationNode, ...OperationNode[]];
  if (rest.length === 0) return first;
  return ParensNode.create(rest.reduce((left, right) => OrNode.create(left, right), first));
}

function buildUpdate(request: WriteRequest, context: CompileContext): BuiltWrite {
  const policies = policiesFor(request);
  const resolved = resolveWrite(
    policies[0] as PolicyDef,
    request.body,
    context,
    request.table,
    'update',
  );

  const columns = returningColumns(
    request.catalogue,
    request.table,
    resolved.assignments.map((assignment) => assignment.column),
  );

  const node: RootOperationNode = {
    ...UpdateQueryNode.create([TableNode.create(request.table)]),
    updates: resolved.assignments.map((assignment) =>
      ColumnUpdateNode.create(ColumnNode.create(assignment.column), assignment.value),
    ),
    where: WhereNode.create(
      narrowWith(permitted(policies, context, request, resolved.postImage), request.filter),
    ),
    returning: returningNode(columns),
  } as RootOperationNode;

  return { node, columns, policies };
}

function buildDelete(request: WriteRequest, context: CompileContext): BuiltWrite {
  if (request.body.size > 0) {
    throw unsupported('A delete does not take a body.');
  }

  const policies = policiesFor(request);
  const columns = returningColumns(request.catalogue, request.table, []);

  const node: RootOperationNode = {
    ...DeleteQueryNode.create([TableNode.create(request.table)]),
    where: WhereNode.create(
      narrowWith(permitted(policies, context, request, null), request.filter),
    ),
    returning: returningNode(columns),
  } as RootOperationNode;

  return { node, columns, policies };
}

/**
 * `INSERT INTO t (cols) SELECT ?, ? WHERE (check) RETURNING ...`
 *
 * The guard is a WHERE on a select with no FROM, which either yields one row or
 * none, so the insert either happens entirely or does not happen at all. That
 * is the whole reason for the shape: there is no way to write the row and then
 * decide about it.
 *
 * The select is emitted as a raw fragment because Kysely's SelectionNode only
 * accepts things that are references, and every item here is a bound value. The
 * fragment is a fixed template: the only text in it is `select`, `,` and
 * `where`, and nothing is interpolated into it.
 */
function buildInsert(request: WriteRequest, context: CompileContext): BuiltWrite {
  if (request.filter !== null) {
    throw unsupported('An insert does not take a filter.');
  }

  const policies = policiesFor(request);
  const resolved = resolveWrite(
    policies[0] as PolicyDef,
    request.body,
    context,
    request.table,
    'insert',
  );

  const guard = permitted(policies, context, request, resolved.postImage);
  const values = resolved.assignments.map((assignment) => assignment.value);

  const fragments = ['select '];
  for (let i = 1; i < values.length; i += 1) fragments.push(', ');
  fragments.push(' where ', '');

  const columns = returningColumns(
    request.catalogue,
    request.table,
    resolved.assignments.map((assignment) => assignment.column),
  );

  const node: RootOperationNode = {
    ...InsertQueryNode.create(TableNode.create(request.table)),
    columns: resolved.assignments.map((assignment) => ColumnNode.create(assignment.column)),
    values: RawNode.create(fragments, [...values, guard]),
    returning: returningNode(columns),
  } as RootOperationNode;

  return { node, columns, policies };
}

/**
 * Build a write with its policy attached, or throw.
 *
 * There is no argument that turns the policy off and no shape of request that
 * skips `policiesFor`, which is the call that refuses when nothing grants the
 * write (rule 00, invariant I1).
 */
export function buildWrite(request: WriteRequest): BuiltWrite {
  const context: CompileContext = { catalogue: request.catalogue, auth: request.auth };

  switch (request.operation) {
    case 'insert':
      return buildInsert(request, context);
    case 'update':
      return buildUpdate(request, context);
    case 'delete':
      return buildDelete(request, context);
  }
}
