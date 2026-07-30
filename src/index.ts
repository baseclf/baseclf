/**
 * BaseCLF worker entry point.
 *
 * V0 is the skeleton. The database layer exists, is tested against a real D1
 * binding, and is wired up here so the bundle reflects its true cost. The REST
 * router and the policy engine land in V1, the auth routes in V3.
 * See BUILD-PROGRESS.md.
 */

import { getCatalogue } from './db/index.js';
import { BaseclfError } from './utils/errors.js';

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

      return Response.json({ error: 'Not found.', code: 'NOT_FOUND' }, { status: 404 });
    } catch (error) {
      if (error instanceof BaseclfError) {
        // Log the code and server-side detail. The response carries neither.
        console.error(`${error.code}: ${error.detail ?? error.message}`);
        return Response.json(error.toResponseBody(), { status: error.status });
      }

      console.error(error);
      return Response.json({ error: 'Internal error.', code: 'INTERNAL' }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
