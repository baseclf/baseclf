/**
 * BaseCLF worker entry point.
 *
 * V1 serves reads through the policy engine. Writes arrive in V2 and identity
 * in V3; until then every request runs as the anonymous role, which is a
 * limitation rather than a gap: there is no way to ask for a different one.
 * See auth/claims.ts.
 */

import { anonymousContext } from './auth/claims.js';
import { getCatalogue } from './db/index.js';
import { getRegistry } from './policy/index.js';
import { readTable, tableFromPath } from './rest/index.js';
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

  return Response.json(result.rows, {
    headers: {
      'x-d1-bookmark': session.getBookmark() ?? '',
      // What the query actually scanned. D1 bills for rows read rather than
      // rows returned, so a policy column without an index shows up here long
      // before it shows up on an invoice.
      ...(result.rowsRead === null ? {} : { 'x-baseclf-rows-read': String(result.rowsRead) }),
    },
  });
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
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          return Response.json(
            { error: 'Writes arrive in V2.', code: 'UNSUPPORTED_QUERY' },
            { status: 405, headers: { allow: 'GET, HEAD' } },
          );
        }
        return await handleRead(request, env, table);
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
