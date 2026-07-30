/**
 * WITH CHECK, compiled.
 *
 * SQLite does not have WITH CHECK and D1 does not have interactive
 * transactions, so the usual shape, read the row, decide, then write, is not
 * available: between the read and the write anything can happen, and there is
 * no transaction to hold the two together. The condition has to be part of the
 * same statement as the write or it is not enforced at all.
 *
 * The way to do that is to rewrite the check into a statement about the row as
 * it will be, not as it is. Every reference to a column of the row being
 * written becomes the value that column will hold afterwards: the value being
 * assigned if the statement assigns one, and otherwise the column itself.
 *
 * That is the whole trick, and it is what makes this work:
 *
 *   UPDATE "posts" SET "title" = ?
 *    WHERE "posts"."id" = ?              client filter
 *      AND "posts"."author_id" = ?       using, the row as it is
 *      AND "posts"."author_id" = ?       check, the row as it will be
 *   RETURNING "id", "title";
 *
 * The two author_id terms look identical because the update does not touch
 * author_id, so its post-image is itself. Add author_id to what the caller may
 * write and the second term compiles to `? = ?` instead, comparing the new
 * owner against the caller. Which is to say: a caller cannot hand a row to
 * somebody else, and the reason is structural rather than a special case
 * somebody remembered to write.
 *
 * This file also decides what a request body is allowed to touch, because the
 * two questions are the same question. A column the policy does not grant is
 * not written, so it cannot appear in the post-image, so a check that mentions
 * it still reads the stored value.
 */

import { type OperationNode, ValueNode } from 'kysely';

import { BaseclfError, PolicyError } from '../utils/errors.js';
import { logEvent } from '../utils/log.js';
import { type CompileContext, compilePredicate, type PostImage } from './compile.js';
import type { Operation, PolicyDef, ValueExpr } from './types.js';

/** One column of the row being written, and the value it will hold. */
export interface Assignment {
  readonly column: string;
  readonly value: OperationNode;
  /** True when the engine supplied it rather than the caller. */
  readonly server: boolean;
}

export interface ResolvedWrite {
  /** In a stable order: granted columns first, then server-set ones. */
  readonly assignments: readonly Assignment[];
  readonly postImage: PostImage;
}

function notFound(detail: string): BaseclfError {
  // Same answer as an unknown column on a read. "That column is not one you may
  // write" and "there is no such column" must not be distinguishable, or the
  // difference is a way to map the schema. Rule 00 invariant I5.
  return new BaseclfError('UNKNOWN_IDENTIFIER', 404, { message: 'Not found.', detail });
}

function bindableFrom(value: unknown, column: string): string | number | null {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // SQLite stores booleans as integers.
  if (typeof value === 'boolean') return value ? 1 : 0;

  throw new BaseclfError('UNSUPPORTED_QUERY', 400, {
    message: `The value for "${column}" must be a string, number, boolean or null.`,
  });
}

/**
 * Resolve a server-set value.
 *
 * Claims only, or constants. There is no path from the request body to here,
 * which is the point: `author_id` is the caller's own id because the engine put
 * it there, not because the caller said so.
 */
function serverValue(expr: ValueExpr, context: CompileContext, where: string): OperationNode {
  if (expr.kind === 'literal') {
    return ValueNode.create(typeof expr.value === 'boolean' ? (expr.value ? 1 : 0) : expr.value);
  }
  if (expr.kind === 'outerColumn') {
    throw new PolicyError('INVALID_EXPR', 500, {
      message: 'Policy could not be applied.',
      detail: `${where} uses $row in a server-set value, which parse.ts should have refused.`,
    });
  }

  const claim = expr.ref;
  const raw =
    claim.source === 'uid'
      ? context.auth.uid
      : claim.source === 'email'
        ? context.auth.email
        : claim.source === 'role'
          ? context.auth.role
          : Object.hasOwn(context.auth.app, claim.key)
            ? context.auth.app[claim.key]
            : null;

  if (raw === null || raw === undefined) return ValueNode.create(null);
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
    return ValueNode.create(typeof raw === 'boolean' ? (raw ? 1 : 0) : raw);
  }

  throw new PolicyError('INVALID_EXPR', 400, {
    message: 'Policy could not be applied.',
    detail: `${where} resolves to a ${typeof raw}, which cannot be stored in a column.`,
  });
}

/**
 * Turn a request body into the columns that will actually be written.
 *
 * Three outcomes for a key in the body:
 *
 *   granted by the policy   it is written
 *   named in the policy's `set`   it is ignored, and the server's value is used
 *   neither   the request is refused
 *
 * The middle one is deliberate rather than lax. Clients round-trip whole
 * objects, so a body that carries back the `author_id` it read a moment ago is
 * ordinary rather than suspicious, and refusing it would make the API tiresome
 * for no gain: the server's value wins either way, so there is no version of
 * this where the caller's number gets stored. It is logged so that a caller who
 * genuinely expected to set it can find out why they did not.
 */
export function resolveWrite(
  policy: PolicyDef,
  body: ReadonlyMap<string, unknown>,
  context: CompileContext,
  table: string,
  operation: Extract<Operation, 'insert' | 'update'>,
): ResolvedWrite {
  const serverColumns = new Set(policy.set.map((entry) => entry.column));
  const assignments: Assignment[] = [];

  for (const key of body.keys()) {
    if (serverColumns.has(key)) {
      logEvent({
        event: 'policy_refusal',
        code: 'SERVER_SET_COLUMN_IGNORED',
        table,
        operation,
        role: context.auth.role,
      });
      continue;
    }
    if (!policy.columns.includes(key)) {
      throw notFound(`Policy "${policy.name}" on "${table}" does not grant writing "${key}".`);
    }
    if (!context.catalogue.hasColumn(table, key)) {
      throw notFound(`Column "${key}" does not exist on "${table}".`);
    }
  }

  // Iterated in the policy's own order rather than the body's, so the same
  // request always compiles to the same statement whatever order the client
  // serialised its JSON in. Golden files depend on that; so does prompt cache
  // and so does anyone reading two logs side by side.
  for (const column of policy.columns) {
    if (!body.has(column)) continue;
    assignments.push({
      column,
      value: ValueNode.create(bindableFrom(body.get(column), column)),
      server: false,
    });
  }

  for (const entry of policy.set) {
    assignments.push({
      column: entry.column,
      value: serverValue(entry.value, context, `Policy "${policy.name}" set "${entry.column}"`),
      server: true,
    });
  }

  if (assignments.length === 0) {
    throw new BaseclfError('UNSUPPORTED_QUERY', 400, {
      message: 'The request body sets no column this policy grants.',
    });
  }

  const values = new Map<string, OperationNode>();
  for (const assignment of assignments) values.set(assignment.column, assignment.value);

  return {
    assignments,
    postImage: {
      values,
      // An insert has no row to fall back on. See compile.ts.
      requireAll: operation === 'insert',
    },
  };
}

/**
 * Compile a check against the row as it will be.
 *
 * The only difference from compiling any other predicate is the post-image on
 * the context, and the only thing that reads it is the resolution of a column
 * belonging to the outermost scope frame.
 */
export function compileCheck(
  check: PolicyDef['check'],
  context: CompileContext,
  table: string,
  postImage: PostImage,
  where: string,
): OperationNode | null {
  if (check === null) return null;
  return compilePredicate(check, { ...context, postImage }, [table], where);
}
