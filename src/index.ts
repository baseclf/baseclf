/**
 * BaseCLF worker entry point.
 *
 * Reads and writes both go through the policy engine. Identity arrives in V3;
 * until then every request runs as the anonymous role, which is a limitation
 * rather than a gap: there is no way to ask for a different one. See
 * auth/claims.ts.
 */

import { anonymousContext } from './auth/claims.js';
import { getCatalogue } from './db/index.js';
import { getRegistry } from './policy/index.js';
import type { WriteOperation } from './policy/write.js';
import { operationForMethod, readTable, tableFromPath, writeTable } from './rest/index.js';
import { BaseclfError } from './utils/errors.js';
import { logError } from './utils/log.js';

export interface Env {
  readonly DB: D1Database;
}

/**
 * A read-only view of what the engine can see.
 *
 * The catalogue is memoised per isolate, so this costs one round of PRAGMA
 * reads per cold start rather than one per request. Building it lazily inside
 * `fetch` is deliberate: the Workers startup CPU budget is one second and
 * module scope work counts against it.
 */
async function describeSchema(env: Env): Promise<Response> {
  const catalogue = await getCatalogue(env.DB);

  const tables = [...catalogue.tables.values()]
    .filter((table) => !table.isSystem)
    .map((table) => ({
      name: table.name,
      columns: table.columns.size,
      indexes: table.indexes.length,
      foreignKeys: table.foreignKeys.length,
    }));

  return Response.json({ tables });
}

/**
 * The bookmark, and what the statement cost.
 *
 * Without the bookmark round trip a read can be served by a replica that has
 * not caught up, so a client that writes and immediately reads does not see its
 * own write. It is the kind of bug that only appears under load and is
 * miserable to track down.
 */
function resultHeaders(
  session: D1DatabaseSession,
  result: { readonly rowsRead: number | null },
): Record<string, string> {
  return {
    'x-d1-bookmark': session.getBookmark() ?? '',
    // What the statement actually scanned. D1 bills for rows read rather than
    // rows returned, so a policy column without an index shows up here long
    // before it shows up on an invoice.
    ...(result.rowsRead === null ? {} : { 'x-baseclf-rows-read': String(result.rowsRead) }),
  };
}

/**
 * Read a table.
 *
 * The session is opened from the bookmark the client sent back and its new
 * bookmark is returned. Without that round trip a read can be served by a
 * replica that has not caught up, so a client that writes and immediately reads
 * does not see its own write. It is the kind of bug that only appears under
 * load and is miserable to track down.
 */
async function handleRead(request: Request, env: Env, table: string): Promise<Response> {
  const session = env.DB.withSession(request.headers.get('x-d1-bookmark') ?? 'first-unconstrained');

  const [catalogue, registry] = await Promise.all([getCatalogue(session), getRegistry(session)]);

  const result = await readTable({
    executor: session,
    catalogue,
    registry,
    auth: anonymousContext(),
    table,
    search: new URL(request.url).searchParams,
  });

  return Response.json(result.rows, { headers: resultHeaders(session, result) });
}

/**
 * Whether the caller wants the rows back.
 *
 * PostgREST spells this `Prefer: return=representation`, and its default is
 * `minimal`. Following the default matters here beyond compatibility: a write
 * that says nothing back is the cheaper answer, and the rows are only ever
 * useful to a caller that asked for them.
 */
function wantsRepresentation(request: Request): boolean {
  const prefer = request.headers.get('prefer') ?? '';
  return /(^|[,\s])return=representation([,;\s]|$)/.test(prefer);
}

/**
 * Insert, update or delete one row.
 *
 * Zero rows in RETURNING is a 404, whether the row was not there or the policy
 * would not have it. Rule 00 invariant I5: a caller who can tell those apart
 * can walk a range of ids and learn which of them exist.
 */
async function handleWrite(
  request: Request,
  env: Env,
  table: string,
  operation: WriteOperation,
): Promise<Response> {
  let body: Record<string, unknown> | null = null;
  if (operation !== 'delete') {
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return Response.json(
        { error: 'The request body must be JSON.', code: 'UNSUPPORTED_QUERY' },
        { status: 400 },
      );
    }
  }

  const session = env.DB.withSession(request.headers.get('x-d1-bookmark') ?? 'first-unconstrained');
  const [catalogue, registry] = await Promise.all([getCatalogue(session), getRegistry(session)]);

  const result = await writeTable({
    executor: session,
    catalogue,
    registry,
    auth: anonymousContext(),
    table,
    search: new URL(request.url).searchParams,
    operation,
    body,
  });

  const headers = resultHeaders(session, result);

  if (result.rows.length === 0) {
    return Response.json({ error: 'Not found.', code: 'NOT_FOUND' }, { status: 404, headers });
  }

  if (!wantsRepresentation(request)) {
    return new Response(null, { status: operation === 'insert' ? 201 : 204, headers });
  }

  return Response.json(result.rows, { status: operation === 'insert' ? 201 : 200, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname === '/health') {
        return Response.json({ status: 'ok', version: '0.0.0' });
      }

      if (url.pathname === '/_schema') {
        return await describeSchema(env);
      }

      const table = tableFromPath(url.pathname);
      if (table !== null) {
        if (request.method === 'GET' || request.method === 'HEAD') {
          return await handleRead(request, env, table);
        }

        const operation = operationForMethod(request.method);
        if (operation === null) {
          return Response.json(
            { error: 'Method not allowed.', code: 'UNSUPPORTED_QUERY' },
            { status: 405, headers: { allow: 'GET, HEAD, POST, PATCH, DELETE' } },
          );
        }
        return await handleWrite(request, env, table, operation);
      }

      return Response.json({ error: 'Not found.', code: 'NOT_FOUND' }, { status: 404 });
    } catch (error) {
      if (error instanceof BaseclfError) {
        // The detail goes to the log, never to the response. It is where the
        // useful diagnosis lives, and also where the table names live.
        logError({ event: 'error', code: error.code, detail: error.detail ?? error.message });
        return Response.json(error.toResponseBody(), { status: error.status });
      }

      logError({
        event: 'error',
        code: 'INTERNAL',
        detail: error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
      return Response.json({ error: 'Internal error.', code: 'INTERNAL' }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
