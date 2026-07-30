/**
 * `GET /rest/v1/:table`.
 *
 * The route is thin because everything it could get wrong has been moved
 * somewhere that can be tested on its own: the parser has no schema, the
 * allowlist has no request, the policy layer has no HTTP. What is left here is
 * ordering, and the order matters.
 *
 *   deny engine tables -> parse -> resolve names -> expand a star against what
 *   the policy grants -> build -> attach policy -> check the finished SQL ->
 *   run
 *
 * The star is expanded before the query is built rather than compiled as `*`.
 * A literal star means "whatever columns this table has at the moment it runs",
 * so a migration that adds a column would widen every existing response without
 * anyone touching a policy.
 */

import type { D1Executor } from '../db/dialect.js';
import type { Catalogue } from '../db/introspect.js';
import { SYSTEM_TABLE_PREFIX } from '../db/introspect.js';
import { applyPolicy } from '../policy/plugin.js';
import type { Registry } from '../policy/registry.js';
import type { AuthCtx } from '../policy/types.js';
import { BaseclfError } from '../utils/errors.js';
import { resolveTable } from './allowlist.js';
import { buildSelect } from './build.js';
import { type ExecuteResult, executeSelect } from './execute.js';
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

/**
 * Read one table under the caller's policies.
 *
 * Exposed separately from the HTTP handler so that tests and the demo can act
 * as a role without an identity ever travelling over the wire. There is no
 * header that reaches this argument; see auth/claims.ts.
 */
export async function readTable<R>(request: ReadRequest): Promise<ExecuteResult<R>> {
  const { executor, catalogue, registry, auth, table, search } = request;

  // Rule 00 invariant I8, checked here and again inside the registry. Two
  // independent places, so one of them being wrong is not enough.
  if (table.startsWith(SYSTEM_TABLE_PREFIX)) {
    throw new BaseclfError('TABLE_NOT_EXPOSED', 404, {
      message: 'Not found.',
      detail: `"${table}" is an engine table and is never routable.`,
    });
  }

  const resolved = resolveTable(catalogue, table);
  const parsed = parseQueryString(search);

  const columns: readonly SelectItem[] =
    parsed.select ??
    registry
      .resolve(resolved, 'select', auth.role, null)
      .columns.map((column) => ({ column, alias: null }));

  const node = buildSelect({ catalogue, table: resolved, parsed, columns });

  const policied = applyPolicy(node, {
    registry,
    catalogue,
    auth,
    operation: 'select',
  });

  const aliases = new Set<string>();
  for (const item of columns) {
    if (item.alias !== null) aliases.add(item.alias);
  }

  return executeSelect<R>({
    executor,
    node: policied,
    catalogue,
    scope: { aliases },
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
