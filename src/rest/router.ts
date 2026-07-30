/**
 * `/rest/v1/:table` for reads and writes.
 *
 * The route is thin because everything it could get wrong has been moved
 * somewhere that can be tested on its own: the parser has no schema, the
 * allowlist has no request, the policy layer has no HTTP. What is left here is
 * ordering, and the order matters.
 *
 *   deny engine tables -> parse -> resolve names -> attach policy -> check the
 *   finished SQL -> run -> decide what zero rows means
 *
 * On a read the star is expanded before the query is built rather than compiled
 * as `*`. A literal star means "whatever columns this table has at the moment it
 * runs", so a migration that adds a column would widen every existing response
 * without anyone touching a policy.
 *
 * On a write, zero rows back is a 404. Not a 403, and not an empty success:
 * rule 00 invariant I5 says a row that is not there and a row the policy
 * withheld have to look the same from outside, because a caller who can tell
 * them apart can enumerate ids and learn which ones exist.
 */

import type { D1Executor } from '../db/dialect.js';
import type { Catalogue } from '../db/introspect.js';
import { SYSTEM_TABLE_PREFIX } from '../db/introspect.js';
import { applyPolicy } from '../policy/plugin.js';
import type { Registry } from '../policy/registry.js';
import type { AuthCtx } from '../policy/types.js';
import { buildWrite, type WriteOperation } from '../policy/write.js';
import { BaseclfError } from '../utils/errors.js';
import { resolveTable } from './allowlist.js';
import { buildClientFilter, buildSelect } from './build.js';
import { type ExecuteResult, executeStatement } from './execute.js';
import { parseQueryString, type SelectItem } from './parse-query.js';

export const REST_PREFIX = '/rest/v1/';

export interface ReadRequest {
  readonly executor: D1Executor;
  readonly catalogue: Catalogue;
  readonly registry: Registry;
  readonly auth: AuthCtx;
  readonly table: string;
  readonly search: URLSearchParams;
}

export interface WriteRequestInput extends ReadRequest {
  readonly operation: WriteOperation;
  /** The parsed JSON body. Null for a delete. */
  readonly body: Readonly<Record<string, unknown>> | null;
}

/**
 * Refuse an engine table before anything else looks at it.
 *
 * Rule 00 invariant I8 asks for independent checks. This is one; the registry
 * loader drops such a table, and `registry.resolve` refuses it again. None of
 * the three relies on the other two being right.
 */
function assertRoutable(table: string): void {
  if (table.startsWith(SYSTEM_TABLE_PREFIX)) {
    throw new BaseclfError('TABLE_NOT_EXPOSED', 404, {
      message: 'Not found.',
      detail: `"${table}" is an engine table and is never routable.`,
    });
  }
}

/**
 * Read one table under the caller's policies.
 *
 * Exposed separately from the HTTP handler so that tests and the demo can act
 * as a role without an identity ever travelling over the wire. There is no
 * header that reaches this argument; see auth/claims.ts.
 */
export async function readTable<R>(request: ReadRequest): Promise<ExecuteResult<R>> {
  const { executor, catalogue, registry, auth, table, search } = request;

  assertRoutable(table);
  const resolved = resolveTable(catalogue, table);
  const parsed = parseQueryString(search);

  const columns: readonly SelectItem[] =
    parsed.select ??
    registry
      .resolve(resolved, 'select', auth.role, null)
      .columns.map((column) => ({ column, alias: null }));

  const node = buildSelect({ catalogue, table: resolved, parsed, columns });

  const policied = applyPolicy(node, { registry, catalogue, auth, operation: 'select' });

  const aliases = new Set<string>();
  for (const item of columns) {
    if (item.alias !== null) aliases.add(item.alias);
  }

  return executeStatement<R>({ executor, node: policied, catalogue, scope: { aliases } });
}

/**
 * The request body, as a map of column to value.
 *
 * A single object only. An array would be a bulk write, and a bulk write cannot
 * be made all or nothing here: each row carries its own guard, so some rows
 * would insert and others would not, and D1 has no transaction to undo the
 * difference. Half a write that reports success is worse than a refusal, so it
 * is refused until the shape can be built properly.
 */
function bodyToMap(body: Readonly<Record<string, unknown>> | null): Map<string, unknown> {
  if (body === null) return new Map();

  if (Array.isArray(body)) {
    throw new BaseclfError('UNSUPPORTED_QUERY', 400, {
      message:
        'Send one row at a time. A bulk write cannot be made all or nothing on this backend yet.',
    });
  }
  if (typeof body !== 'object') {
    throw new BaseclfError('UNSUPPORTED_QUERY', 400, {
      message: 'The request body must be a JSON object.',
    });
  }

  return new Map(Object.entries(body));
}

/**
 * Write one table under the caller's policies.
 *
 * The result carries the rows RETURNING produced. An empty one means the write
 * matched nothing, which the HTTP layer turns into a 404.
 */
export async function writeTable<R>(request: WriteRequestInput): Promise<ExecuteResult<R>> {
  const { executor, catalogue, registry, auth, table, search, operation, body } = request;

  assertRoutable(table);
  const resolved = resolveTable(catalogue, table);
  const parsed = parseQueryString(search);

  // An insert names no existing row, so a filter on it would have nothing to
  // apply to. Refused rather than dropped: a filter that is silently ignored
  // reads, to the caller, exactly like a filter that was applied.
  if (operation === 'insert' && parsed.filters.length > 0) {
    throw new BaseclfError('UNSUPPORTED_QUERY', 400, {
      message: 'An insert does not take a filter.',
    });
  }
  const filter = operation === 'insert' ? null : buildClientFilter(catalogue, resolved, parsed);

  const built = buildWrite({
    registry,
    catalogue,
    auth,
    table: resolved,
    operation,
    body: bodyToMap(body),
    filter,
  });

  return executeStatement<R>({
    executor,
    node: built.node,
    catalogue,
    scope: { aliases: new Set() },
  });
}

/** The table segment of a REST path, or null when the path is not one. */
export function tableFromPath(pathname: string): string | null {
  if (!pathname.startsWith(REST_PREFIX)) return null;

  const rest = pathname.slice(REST_PREFIX.length);
  if (rest === '' || rest.includes('/')) return null;

  try {
    return decodeURIComponent(rest);
  } catch {
    return null;
  }
}

/** The write operation an HTTP method asks for, or null when it is a read. */
export function operationForMethod(method: string): WriteOperation | null {
  if (method === 'POST') return 'insert';
  if (method === 'PATCH') return 'update';
  if (method === 'DELETE') return 'delete';
  return null;
}
